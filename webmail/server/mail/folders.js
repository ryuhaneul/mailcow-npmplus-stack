import { encodePath } from 'imapflow/lib/tools.js';
import { AppError } from '../errors.js';
import { mailboxStatus } from './imap-raw.js';
import { assertUidValidity } from './ref.js';

const virtual = path => path === 'WebmailVirtual' || path.startsWith('WebmailVirtual/');
const shared = path => path === 'Shared' || path.startsWith('Shared/');
const specialNames = { INBOX: '\\Inbox', Sent: '\\Sent', Drafts: '\\Drafts', Trash: '\\Trash', Junk: '\\Junk', Archive: '\\Archive' };
const unavailable = () => new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
const readonly = () => new AppError(403, 'FOLDER_READONLY', '이 폴더는 변경할 수 없어요.');
const locked = () => new AppError(409, 'RULES_LOCKED', '필터 기능 준비 중이라 지금은 폴더 이름을 바꾸거나 지울 수 없어요');
const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
const nameOf = path => path.slice(path.lastIndexOf('/') + 1);

export function validateFolderName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || Array.from(name).length > 100 || /[\/\x00-\x1f\x7f]/.test(name) || name.includes('${') || name.startsWith('.') || /^(WebmailVirtual|Shared)/.test(name)) {
    throw new AppError(422, 'INVALID_NAME', '폴더 이름을 확인해 주세요.');
  }
  return name;
}
function validPath(path) {
  if (typeof path !== 'string' || !path || /[\0\r\n]/.test(path)) throw new AppError(422, 'INVALID_NAME', '폴더 경로를 확인해 주세요.');
}
async function mailCall(operation) {
  try { return await operation(); } catch (error) {
    if (error instanceof AppError) throw error;
    if (error.code === 'NotFound' || error.serverResponseCode === 'NONEXISTENT') throw new AppError(404, 'FOLDER_NOT_FOUND', '폴더를 찾을 수 없어요.');
    if (error.serverResponseCode === 'ALREADYEXISTS') throw new AppError(409, 'EXISTS', '같은 이름의 폴더가 있어요.');
    throw unavailable();
  }
}
async function list(client) {
  const result = await mailCall(() => client.list({ statusQuery: { messages: true, unseen: true } }));
  if (!Array.isArray(result)) throw unavailable();
  const seen = new Set();
  return result.filter(folder => {
    if (seen.has(folder.path)) return false;
    seen.add(folder.path);
    return !virtual(folder.path) && !/^Shared\/[^/]+$/.test(folder.path) && !folder.flags?.has('\\Noselect');
  });
}
async function rights(client, path) {
  let value;
  const response = await mailCall(() => client.exec('MYRIGHTS', [{ type: 'STRING', value: encodePath(client, path) }], {
    untagged: { MYRIGHTS: row => {
      const token = row.attributes?.[1]?.value;
      value = Buffer.isBuffer(token) ? token.toString() : token;
    } },
  }));
  response.next();
  if (typeof value !== 'string') throw unavailable();
  return { write: value.includes('w'), delete: value.includes('t') && value.includes('e'), insert: value.includes('i'), seen: value.includes('s') };
}
function find(rows, path) {
  const folder = rows.find(row => row.path === path);
  if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', '폴더를 찾을 수 없어요.');
  return folder;
}
function mutable(path) {
  validPath(path);
  if (shared(path) || virtual(path)) throw readonly();
}
function safeError(error) {
  return { name: typeof error?.name === 'string' ? error.name : 'Error', code: typeof error?.code === 'string' ? error.code : 'UNKNOWN', statusCode: error?.statusCode };
}

export function createFolderService({ imap, rulesService, logger, now = Date.now }) {
  const storageCache = new WeakMap();
  const invalidate = session => storageCache.delete(session);
  async function describe(client, session, folder) {
    const access = await rights(client, folder.path);
    if (shared(folder.path)) Object.assign(access, { write: false, delete: false, insert: false });
    const color = session.prefs?.folderColors?.[folder.path];
    const result = {
      path: folder.path, name: folder.name || nameOf(folder.path), parent: folder.parentPath || parentOf(folder.path),
      specialUse: specialNames[folder.path] || (Object.values(specialNames).includes(folder.specialUse) ? folder.specialUse : null),
      shared: shared(folder.path), rights: access, unseen: folder.status?.unseen ?? 0, total: folder.status?.messages ?? 0,
      color: Number.isInteger(color) && color >= 0 && color <= 7 ? color : null,
    };
    const owner = folder.path.split('/')[1];
    if (result.shared && owner?.includes('@')) result.owner = owner;
    return result;
  }
  async function folders(session) {
    return imap.withMailbox(session, 'INBOX', async client => {
      const rows = await list(client);
      const folders = [];
      for (const row of rows) folders.push(await describe(client, session, row));
      return { folders, virtualAllMail: 'WebmailVirtual/AllMail' };
    });
  }
  async function create(session, body) {
    const name = validateFolderName(body?.name);
    const parent = body?.parent ?? null;
    if (parent !== null) mutable(parent);
    return imap.withMailbox(session, 'INBOX', async client => {
      const rows = await list(client);
      if (parent && !(await rights(client, find(rows, parent).path)).write) throw readonly();
      const path = parent ? `${parent}/${name}` : name;
      if (rows.some(row => row.path === path)) throw new AppError(409, 'EXISTS', '같은 이름의 폴더가 있어요.');
      if (!await mailCall(() => client.mailboxCreate(path))) throw unavailable();
      invalidate(session);
      return { folder: await describe(client, session, find(await list(client), path)) };
    });
  }
  async function rename(session, path, body) {
    mutable(path);
    const name = validateFolderName(body?.name);
    if (!rulesService?.getState || !rulesService?.renameFolderRefs) throw locked();
    return imap.withMailbox(session, 'INBOX', async client => {
      const rows = await list(client);
      const folder = find(rows, path);
      if (!(await rights(client, path)).write) throw readonly();
      if (!['ok', 'none'].includes(await rulesService.getState(session, client))) throw locked();
      const parent = parentOf(path);
      const newPath = parent ? `${parent}/${name}` : name;
      if (rows.some(row => row.path === newPath)) throw new AppError(409, 'EXISTS', '같은 이름의 폴더가 있어요.');
      if (!await mailCall(() => client.mailboxRename(path, newPath))) throw unavailable();
      invalidate(session);
      try { await rulesService.renameFolderRefs(session, path, newPath, client); } catch (error) {
        try {
          if (!await mailCall(() => client.mailboxRename(newPath, path))) throw unavailable();
        } catch (rollbackError) {
          logger.error({ code: 'FOLDER_RULES_MISMATCH', oldPath: path, newPath, rulesError: safeError(error), rollbackError: safeError(rollbackError) }, '폴더와 필터 경로가 일치하지 않습니다.');
          throw new AppError(500, 'FOLDER_RULES_MISMATCH', '폴더 이름은 바뀌었지만 필터에 반영하지 못했어요. 필터 화면에서 확인해 주세요.');
        }
        throw error;
      }
      return { folder: await describe(client, session, { ...folder, path: newPath, name, parentPath: parent }) };
    });
  }
  async function remove(session, path) {
    mutable(path);
    if (!rulesService?.folderInUse) throw locked();
    return imap.withMailbox(session, 'INBOX', async client => {
      const rows = await list(client);
      const folder = find(rows, path);
      if (!(await rights(client, path)).delete) throw readonly();
      if (folder.specialUse || specialNames[path]) throw new AppError(422, 'SPECIAL_FOLDER', '기본 폴더는 지울 수 없어요.');
      if (await rulesService.folderInUse(session, path, client)) throw new AppError(409, 'FOLDER_IN_USE', '필터에서 쓰는 폴더예요. 필터를 먼저 바꿔 주세요.');
      const status = await mailboxStatus(client, path);
      if (status.messages || rows.some(row => row.path.startsWith(`${path}/`))) throw new AppError(409, 'FOLDER_NOT_EMPTY', '빈 폴더만 지울 수 있어요.');
      if (!await mailCall(() => client.mailboxDelete(path))) throw unavailable();
      invalidate(session);
    });
  }
  async function empty(session, path, body) {
    mutable(path);
    const initial = await imap.withMailbox(session, path, async client => {
      if (!(await rights(client, path)).delete) throw readonly();
      const folder = find(await list(client), path);
      if (body?.confirmName !== (folder.name || nameOf(path))) throw new AppError(422, 'CONFIRM_MISMATCH', '폴더 이름을 정확히 입력해 주세요.');
      if (!client.capabilities.has('UIDPLUS') && !client.capabilities.has('IMAP4rev2')) throw unavailable();
      const before = await mailboxStatus(client, path);
      const uids = await mailCall(() => client.search({ all: true }, { uid: true }));
      if (!Array.isArray(uids)) throw unavailable();
      return { before, uids, uidValidity: Number(client.mailbox.uidValidity) };
    });
    let deleted = 0;
    try {
      for (let index = 0; index < initial.uids.length; index += 1000) {
        const batch = initial.uids.slice(index, index + 1000);
        await imap.withMailbox(session, path, async client => {
          assertUidValidity(client, { path, uidValidity: initial.uidValidity });
          if (!(await rights(client, path)).delete) throw readonly();
          const range = batch.join(',');
          if (!await mailCall(() => client.messageFlagsAdd(range, ['\\Deleted'], { uid: true }))) throw unavailable();
          const response = await mailCall(() => client.exec('UID EXPUNGE', [{ type: 'SEQUENCE', value: range }]));
          response.next();
        });
        deleted += batch.length;
      }
      const after = await imap.withMailbox(session, path, client => mailboxStatus(client, path));
      logger.info({ code: 'FOLDER_EMPTIED', folder: path, count: deleted }, '폴더를 비웠습니다.');
      return { deleted, freedBytes: Math.max(0, initial.before.size - after.size) };
    } finally { invalidate(session); }
  }
  async function storage(session, quotaOnly = false) {
    return imap.withMailbox(session, 'INBOX', async client => {
      // imapflow의 getQuota는 STORAGE KB를 이미 byte로 변환한다.
      const result = await mailCall(() => client.getQuota('INBOX'));
      // A successful GETQUOTAROOT without QUOTA returns { path }; false/undefined signal failure or unmet preconditions.
      if (!result || result.path !== 'INBOX' && !result.storage) throw unavailable();
      const unlimited = !Object.hasOwn(result, 'storage');
      if (!unlimited && (!result.storage || !Number.isFinite(result.storage.usage) || !Number.isFinite(result.storage.limit))) throw unavailable();
      const quota = unlimited ? { usedBytes: 0, limitBytes: 0 } : { usedBytes: result.storage.usage, limitBytes: result.storage.limit };
      let folders = [];
      if (!quotaOnly || unlimited) {
        let cached = storageCache.get(session);
        if (!cached || now() - cached.at >= 60000) {
          const rows = (await list(client)).filter(row => !shared(row.path));
          const stats = [];
          for (const row of rows) {
            const status = await mailboxStatus(client, row.path).catch(() => { throw unavailable(); });
            stats.push({ path: row.path, name: row.name || nameOf(row.path), messages: status.messages, sizeBytes: status.size });
          }
          stats.sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path));
          cached = { at: now(), folders: stats };
          storageCache.set(session, cached);
        }
        if (unlimited) quota.usedBytes = cached.folders.reduce((sum, folder) => sum + folder.sizeBytes, 0);
        if (!quotaOnly) folders = cached.folders;
      }
      const percent = quota.limitBytes > 0 ? quota.usedBytes / quota.limitBytes : 0;
      return { quota, level: percent >= 0.95 ? 'crit' : percent >= 0.8 ? 'warn' : 'ok', folders };
    });
  }
  return { folders, create, rename, remove, empty, storage };
}

export { rights as mailboxRights };
