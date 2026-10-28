import { randomUUID } from 'node:crypto';
import libmime from 'libmime';
import { AppError } from '../errors.js';
import { decodeRef, encodeRef, assertUidValidity } from '../mail/ref.js';
import { bodyParts, createReadService, decodeWords } from '../mail/read.js';
import { templateIdPattern, templateMime, templateName } from './mime.js';

export const templatesFolder = 'Templates';
export const sharedTemplatesFolder = 'Templates/공유';
export const maxTemplates = 200;
export const isTemplateFolder = path => typeof path === 'string' && (path === templatesFolder || path.startsWith(`${templatesFolder}/`));
const inShared = path => path === sharedTemplatesFolder || path.startsWith(`${sharedTemplatesFolder}/`);
const invalid = () => new AppError(422, 'TEMPLATE_INVALID', '템플릿 이름과 내용을 확인해 주세요.');
const changed = () => new AppError(409, 'TEMPLATE_CHANGED', '다른 곳에서 바뀌었어요. 다시 열어 주세요.');
const missing = () => new AppError(404, 'TEMPLATE_NOT_FOUND', '템플릿을 찾을 수 없어요.');
const unavailable = () => new AppError(503, 'TEMPLATE_UNAVAILABLE', '템플릿을 저장하지 못했어요. 다시 시도해 주세요.');
const uint = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;

export function decodeTemplateRef(token) {
  const ref = decodeRef(token);
  if (!isTemplateFolder(ref.path) || /[\x00-\x1f\x7f]/.test(ref.path) || ref.path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new AppError(403, 'TEMPLATE_PATH_FORBIDDEN', '내 템플릿 폴더에서만 변경할 수 있어요.');
  }
  return ref;
}

// Shared by store instances and login sessions, so equal baseUid saves cannot
// both win in this webmail process. IMAP mailbox locks alone are session-local.
const pending = new Map();
async function serialized(session, operation) {
  if (!session?.connection || typeof session.email !== 'string' || !session.email.includes('@')) throw new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
  const key = session.email.toLowerCase();
  const previous = pending.get(key) ?? Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  pending.set(key, next);
  await previous;
  try { return await operation(); }
  catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
  finally { release(); if (pending.get(key) === next) pending.delete(key); }
}

function validate(data, updating = false) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['name', 'subject', 'html', 'attachments', 'shared', ...(updating ? ['baseUid'] : [])].includes(key))) throw invalid();
  templateName(data.name);
  if (typeof data.subject !== 'string' || /[\x00-\x1f\x7f]/.test(data.subject) || typeof data.html !== 'string' || (data.shared !== undefined && typeof data.shared !== 'boolean')) throw invalid();
  if (updating && !uint(data.baseUid)) throw invalid();
  if (data.attachments !== undefined && (!Array.isArray(data.attachments) || data.attachments.some(part => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return true;
    if (Object.keys(part).length === 1 && typeof part.uploadId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(part.uploadId)) return false;
    if (Object.keys(part).length !== 2 || typeof part.templateRef !== 'string' || typeof part.part !== 'string' || !/^\d+(?:\.\d+)*$/.test(part.part)) return true;
    const ref = decodeRef(part.templateRef);
    if (!/^Shared\/[^/]+\/Templates\/공유$/.test(ref.path)) decodeTemplateRef(part.templateRef);
    return false;
  }))) throw invalid();
  return structuredClone(data);
}

export function entry(path, uidValidity, row, owner) {
  const headers = libmime.decodeHeaders(row.headers?.toString('latin1') || '');
  const id = headers['x-webmail-template-id']?.[0]?.trim();
  if (!templateIdPattern.test(id ?? '') || !uint(row.uid)) return null;
  const name = decodeWords(headers['x-webmail-template-name']?.[0] ?? '');
  const time = Date.parse(headers.date?.[0] ?? '');
  return { owner, id: id.toLowerCase(), ref: encodeRef(path, uidValidity, row.uid), name,
    subject: decodeWords(headers.subject?.[0] ?? ''), updatedAt: Number.isFinite(time) ? new Date(time).toISOString() : null,
    hasAttachments: bodyParts(row.bodyStructure).some(part => part.attachment || Boolean(part.id)), size: row.size ?? 0, inShared: inShared(path),
    path, uid: row.uid, uidValidity, time: Number.isFinite(time) ? time : 0 };
}
// Date is authoritative; equal dates use UID, then deterministic path order.
export function compareTemplateEntries(a, b) {
  return b.time - a.time || b.uid - a.uid || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function latest(rows) {
  const result = new Map();
  for (const row of [...rows].sort(compareTemplateEntries)) if (!result.has(row.id)) result.set(row.id, row);
  return [...result.values()];
}
export function publicEntry({ path, uid, uidValidity, time, ...value }) { return value; }

export function createTemplateStore({ imap, config, buildMime, onFolderCreated, logger }) {
  const maxBytes = config.attachMaxMb * 1024 * 1024;
  const reader = createReadService({ imap, config });
  async function scan(session) {
    const folders = await imap.withMailbox(session, 'INBOX', client => client.list({ listOnly: true }));
    const rows = [];
    for (const { path, flags } of folders) {
      if (!isTemplateFolder(path) || flags?.has('\\Noselect')) continue;
      // Apply the same path guard to server-listed folders as decoded refs.
      decodeTemplateRef(encodeRef(path, 1, 1));
      await imap.withMailbox(session, path, async client => {
        if (client.mailbox.exists === 0) return;
        const uidValidity = Number(client.mailbox.uidValidity);
        for await (const row of client.fetch('1:*', { uid: true, size: true, bodyStructure: true, headers: ['X-WEBMAIL-TEMPLATE-ID', 'X-WEBMAIL-TEMPLATE-NAME', 'SUBJECT', 'DATE'] }, { uid: true })) {
          const value = entry(path, uidValidity, row, session.email.toLowerCase());
          if (value) rows.push(value);
        }
      });
    }
    return rows;
  }
  async function ensureFolder(session, path) {
    await imap.withMailbox(session, 'INBOX', async client => {
      const folders = await client.list({ listOnly: true });
      if (folders.some(folder => folder.path === path)) return;
      if (typeof onFolderCreated !== 'function') throw new AppError(503, 'TEMPLATE_FOLDER_SETUP_REQUIRED', '템플릿 폴더의 공유 설정을 준비하지 못했어요.');
      if (!await client.mailboxCreate(path)) throw unavailable();
      try { await onFolderCreated(client, path, session); }
      catch {
        // Remove only the just-created empty folder. Never remove user mail.
        try {
          const status = await client.status(path, { messages: true });
          if (status?.messages !== 0 || !await client.mailboxDelete(path)) throw unavailable();
        } catch {
          logger?.warn({ code: 'TEMPLATE_FOLDER_RECOVERY_REQUIRED' }, '템플릿 폴더 ACL 수동 복구가 필요합니다.');
          throw unavailable();
        }
        throw unavailable();
      }
    });
  }
  async function destination(session, shared) {
    await ensureFolder(session, templatesFolder);
    if (shared) await ensureFolder(session, sharedTemplatesFolder);
    return shared ? sharedTemplatesFolder : templatesFolder;
  }
  function current(rows, ref, baseUid) {
    if (baseUid !== ref.uid) throw changed();
    const row = rows.find(item => item.path === ref.path && item.uid === ref.uid && item.uidValidity === ref.uidValidity);
    if (!row || latest(rows).find(item => item.id === row.id)?.ref !== row.ref) throw changed();
    return row;
  }
  async function append(session, path, raw) {
    if (raw.length > maxBytes) throw new AppError(413, 'TEMPLATE_TOO_LARGE', '템플릿 크기가 허용 크기를 넘었어요.');
    return imap.withMailbox(session, path, async client => {
      const result = await client.append(path, raw, ['\\Seen']);
      if (!uint(Number(result?.uid)) || !uint(Number(result?.uidValidity))) throw unavailable();
      if (Number(result.uidValidity) !== Number(client.mailbox.uidValidity)) throw changed();
      const uid = Number(result.uid);
      const saved = await client.fetchOne(uid, { uid: true, source: true, size: true, bodyStructure: true, headers: ['X-WEBMAIL-TEMPLATE-ID', 'X-WEBMAIL-TEMPLATE-NAME', 'SUBJECT', 'DATE'] }, { uid: true });
      if (saved?.uid !== uid || !Buffer.isBuffer(saved.source) || !saved.source.equals(raw)) throw unavailable();
      const value = entry(path, Number(result.uidValidity), saved, session.email.toLowerCase());
      if (!value) throw unavailable();
      return value;
    });
  }
  async function expunge(session, rows) {
    for (const path of new Set(rows.map(row => row.path))) {
      const selected = rows.filter(row => row.path === path);
      await imap.withMailbox(session, path, async client => {
        assertUidValidity(client, { path, uidValidity: selected[0].uidValidity });
        if (!client.capabilities?.has('UIDPLUS')) throw unavailable();
        const set = selected.map(row => row.uid).join(',');
        if (!await client.messageFlagsAdd(set, ['\\Deleted'], { uid: true })) throw unavailable();
        const result = await client.exec('UID EXPUNGE', [{ type: 'SEQUENCE', value: set }]);
        result.next();
      });
    }
  }
  async function build(session, data, id) {
    if (typeof buildMime !== 'function') throw unavailable();
    return templateMime(await buildMime(session, data), { id, name: data.name });
  }
  async function list(session) {
    return serialized(session, async () => latest(await scan(session)).map(publicEntry));
  }
  async function get(session, token) {
    decodeTemplateRef(token);
    return serialized(session, async () => {
      const rows = await scan(session);
      const value = rows.find(item => item.ref === token);
      if (!value || latest(rows).find(item => item.id === value.id)?.ref !== token) throw missing();
      const result = await reader.read(session, token);
      return { ...publicEntry(value), html: result.html ?? '', text: result.text ?? '', attachments: result.attachments.map(part => ({ part: part.partId, name: part.filename, size: part.size, type: part.contentType })) };
    });
  }
  async function createWith(session, prepare, shared = false) {
    return serialized(session, async () => {
      const rows = await scan(session);
      if (latest(rows).length >= maxTemplates) throw new AppError(422, 'TEMPLATE_LIMIT', '내 템플릿은 200개까지 저장할 수 있어요.');
      const raw = await prepare();
      const path = await destination(session, shared);
      return publicEntry(await append(session, path, raw));
    });
  }
  async function create(session, input) {
    const data = validate(input);
    return createWith(session, () => build(session, data, randomUUID()), data.shared === true);
  }
  // Internal only: callers fetch an authorized template before importing bytes.
  async function importRaw(session, source) {
    if (!Buffer.isBuffer(source)) throw invalid();
    if (source.length > maxBytes) throw new AppError(413, 'TEMPLATE_TOO_LARGE', '템플릿 크기가 허용 크기를 넘었어요.');
    const raw = Buffer.from(source), end = raw.indexOf('\r\n\r\n');
    if (end < 0) throw invalid();
    const headers = libmime.decodeHeaders(raw.subarray(0, end).toString('latin1'));
    const name = templateName(decodeWords(headers['x-webmail-template-name']?.[0] ?? ''));
    return createWith(session, () => templateMime(raw, { id: randomUUID(), name }));
  }
  async function ensureSharedFolder(session) {
    return serialized(session, () => destination(session, true));
  }
  async function update(session, token, input) {
    const ref = decodeTemplateRef(token), data = validate(input, true);
    return serialized(session, async () => {
      const rows = await scan(session), original = current(rows, ref, data.baseUid);
      if (data.shared !== undefined && data.shared !== original.inShared) throw invalid();
      const raw = await build(session, data, original.id);
      const saved = await append(session, original.path, raw);
      try { await expunge(session, rows.filter(row => row.id === original.id)); }
      catch { logger?.warn({ code: 'TEMPLATE_CLEANUP_PENDING' }, '템플릿 중복 정리를 다음 저장으로 미뤘습니다.'); }
      return publicEntry(saved);
    });
  }
  async function remove(session, token, input) {
    const ref = decodeTemplateRef(token);
    if (!input || Object.keys(input).length !== 1 || !uint(input.baseUid)) throw invalid();
    const baseUid = input.baseUid;
    return serialized(session, async () => {
      const rows = await scan(session), original = current(rows, ref, baseUid);
      await expunge(session, rows.filter(row => row.id === original.id));
      return { ok: true };
    });
  }
  async function move(session, token, input) {
    const ref = decodeTemplateRef(token);
    if (!input || Object.keys(input).length !== 1 || typeof input.shared !== 'boolean') throw invalid();
    const shared = input.shared;
    return serialized(session, async () => {
      const rows = await scan(session), original = current(rows, ref, ref.uid);
      // A MOVE changes UID space. Remove older duplicates first so a larger
      // old UID in another folder cannot become the apparent newest version.
      try { await expunge(session, rows.filter(row => row.id === original.id && row.ref !== original.ref)); }
      catch { throw unavailable(); }
      const path = await destination(session, shared);
      if (path === original.path) return publicEntry(original);
      return imap.withRef(session, token, async (client, source) => {
        if (!client.capabilities?.has('MOVE')) throw unavailable();
        const result = await client.messageMove(source.uid, path, { uid: true });
        const uid = Number(result?.uidMap?.get(source.uid)), uidValidity = Number(result?.uidValidity);
        if (!uint(uid) || !uint(uidValidity)) throw unavailable();
        return publicEntry({ ...original, path, uid, uidValidity, ref: encodeRef(path, uidValidity, uid), inShared: inShared(path) });
      });
    });
  }
  return { list, get, create, update, remove, move, importRaw, ensureSharedFolder };
}
