import { encodePath, decodePath } from 'imapflow/lib/tools.js';
import { AppError } from '../errors.js';
import { decodeRef, encodeRef } from '../mail/ref.js';
import { createReadService } from '../mail/read.js';
import { entry, latest, publicEntry, templatesFolder, sharedTemplatesFolder } from './store.js';

const invalid = () => new AppError(422, 'TEMPLATE_SHARE_INVALID', '공유할 활성 메일 계정을 확인해 주세요.');
const unavailable = () => new AppError(503, 'TEMPLATE_SHARE_UNAVAILABLE', '템플릿 공유를 확인하지 못했어요. 다시 시도해 주세요.');
const missing = () => new AppError(404, 'TEMPLATE_NOT_FOUND', '더 이상 볼 수 없는 템플릿이에요.');
const address = value => typeof value === 'string' && /^[^\s<>@,;:"()[\]\\/*?\x00-\x1f\x7f]+@[^\s<>@,;:"()[\]\\/*?\x00-\x1f\x7f]+$/.test(value) ? value.toLowerCase() : null;
const text = token => Buffer.isBuffer(token?.value) ? token.value.toString('utf8') : token?.value;
const exactRead = rights => [...new Set(rights)].sort().join('') === 'lr';
function account(session) {
  const email = address(session?.email);
  if (!session?.connection || !email) throw new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
  return email;
}
function sessionClient(client, session) {
  const email = account(session);
  if (address(client.options?.auth?.user) !== email) throw unavailable();
  return email;
}
function ownerPrincipal(id, email) { return ['owner', email].includes(id.toLowerCase()); }
function userPrincipal(id) {
  if (/^[-$]/.test(id)) return null;
  return address(id);
}
function managed(id, rights, email) {
  if (!exactRead(rights) || ownerPrincipal(id, email)) return null;
  const user = userPrincipal(id);
  if (user) return user;
  return id === `$${email.split('@')[1]}` ? id : null;
}
async function command(client, name, args, untagged = {}) {
  if (typeof client.preCheck === 'function') await client.preCheck();
  const result = await client.exec(name, args, { untagged });
  result.next();
}
async function getAcl(client, path) {
  const responses = [];
  await command(client, 'GETACL', [{ type: 'STRING', value: encodePath(client, path) }], { ACL: row => responses.push(row) });
  if (responses.length !== 1) throw unavailable();
  const values = responses[0].attributes;
  if (!Array.isArray(values) || values.length % 2 !== 1 || decodePath(client, text(values[0])) !== path) throw unavailable();
  const rows = new Map();
  for (let i = 1; i < values.length; i += 2) {
    const id = text(values[i]), rights = text(values[i + 1]);
    if (typeof id !== 'string' || !id || /[\x00-\x1f\x7f]/.test(id) || typeof rights !== 'string' || /[\x00-\x20\x7f]/.test(rights) || rows.has(id)) throw unavailable();
    rows.set(id, rights);
  }
  return rows;
}
async function deleteAcl(client, path, id) {
  await command(client, 'DELETEACL', [{ type: 'STRING', value: encodePath(client, path) }, { type: 'STRING', value: id }]);
}
async function setAcl(client, path, id) {
  await command(client, 'SETACL', [{ type: 'STRING', value: encodePath(client, path) }, { type: 'STRING', value: id }, { type: 'STRING', value: 'lr' }]);
}

// Pass directly as store.onFolderCreated; it runs only immediately after CREATE.
export async function clearInheritedTemplateAcl(client, path, session) {
  const email = sessionClient(client, session);
  if (![templatesFolder, sharedTemplatesFolder].includes(path)) throw invalid();
  for (const [id] of await getAcl(client, path)) if (!ownerPrincipal(id, email)) await deleteAcl(client, path, id);
  if ([...(await getAcl(client, path)).keys()].some(id => !ownerPrincipal(id, email))) throw unavailable();
}

export function decodeSharedTemplateRef(token, session) {
  const email = account(session), ref = decodeRef(token);
  const match = /^Shared\/([^/]+)\/Templates\/공유$/.exec(ref.path);
  const owner = match && address(match[1]);
  if (!owner || owner === email) throw new AppError(403, 'TEMPLATE_PATH_FORBIDDEN', '공유받은 템플릿 폴더만 열 수 있어요.');
  return { ...ref, owner };
}
const queues = new Map();
async function serial(session, operation) {
  const email = account(session), previous = queues.get(email) ?? Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  queues.set(email, next);
  await previous;
  try { return await operation(); }
  catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
  finally { release(); if (queues.get(email) === next) queues.delete(email); }
}

export function createTemplateShareService({ imap, config, store, activeAccounts }) {
  const reader = createReadService({ imap, config, markSeen: false });
  const maxBytes = config.attachMaxMb * 1024 * 1024;
  function describe(email, acl, inbox) {
    const domain = email.split('@')[1], users = new Set(), inboxReaders = new Set();
    let domainAll = false;
    for (const [id, rights] of acl) {
      const principal = managed(id, rights, email);
      if (principal && userPrincipal(principal)) users.add(principal);
      if (principal === `$${domain}`) domainAll = true;
    }
    for (const [id, rights] of inbox) {
      const user = userPrincipal(id);
      if (user && user !== email && rights.includes('l') && rights.includes('r')) inboxReaders.add(user);
    }
    return { domainAll, domain, users: [...users].sort(), inboxReaders: [...inboxReaders].sort() };
  }
  async function state(client, email) {
    const folders = await client.list({ listOnly: true });
    const acl = folders.some(folder => folder.path === sharedTemplatesFolder) ? await getAcl(client, sharedTemplatesFolder) : new Map();
    return { acl, inbox: await getAcl(client, 'INBOX'), email };
  }
  async function get(session) {
    return serial(session, () => imap.withMailbox(session, 'INBOX', async client => {
      const email = sessionClient(client, session), { acl, inbox } = await state(client, email);
      return describe(email, acl, inbox);
    }));
  }
  async function put(session, input) {
    const email = account(session);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || typeof input.domainAll !== 'boolean' || !Array.isArray(input.users) || input.users.length > 50) throw invalid();
    if (!Object.hasOwn(input, 'domainAll') || !Object.hasOwn(input, 'users')) throw invalid();
    const users = input.users.map(address), domainAll = input.domainAll;
    if (users.some(user => !user || user === email) || new Set(users).size !== users.length) throw invalid();
    return serial(session, async () => {
      const rows = await activeAccounts(session);
      if (!Array.isArray(rows)) throw unavailable();
      const active = new Set(rows.filter(row => String(row.active) === '1').map(row => address(row.username)).filter(Boolean));
      if (users.some(user => !active.has(user))) throw invalid();
      // Existing manual ACL conflicts must reject before creating or writing anything.
      const desired = new Set(users);
      if (domainAll) desired.add(`$${email.split('@')[1]}`);
      const check = acl => {
        const conflicts = [...acl].filter(([id, rights]) => !managed(id, rights, email) && desired.has(userPrincipal(id) || id)).map(([id]) => id);
        if (conflicts.length) throw new AppError(422, 'TEMPLATE_SHARE_CONFLICT', `기존 수동 공유 권한과 겹쳐요: ${conflicts.join(', ')}`);
      };
      await imap.withMailbox(session, 'INBOX', async client => { sessionClient(client, session); check((await state(client, email)).acl); });
      await store.ensureSharedFolder(session);
      return imap.withMailbox(session, 'INBOX', async client => {
        sessionClient(client, session);
        const before = await getAcl(client, sharedTemplatesFolder);
        check(before);
        const preserved = [...before].filter(([id, rights]) => !managed(id, rights, email));
        const present = new Set();
        for (const [id, rights] of before) {
          const principal = managed(id, rights, email);
          if (!principal) continue;
          if (desired.has(principal)) present.add(principal);
          else await deleteAcl(client, sharedTemplatesFolder, id);
        }
        for (const id of desired) if (!present.has(id)) await setAcl(client, sharedTemplatesFolder, id);
        const after = await getAcl(client, sharedTemplatesFolder);
        const actual = new Set([...after].map(([id, rights]) => managed(id, rights, email)).filter(Boolean));
        if (actual.size !== desired.size || [...desired].some(id => !actual.has(id)) || preserved.some(([id, rights]) => after.get(id) !== rights)) throw unavailable();
        return describe(email, after, await getAcl(client, 'INBOX'));
      });
    });
  }
  async function discover(session) {
    account(session);
    const folders = await imap.withFreshConnection(session, async client => {
      sessionClient(client, session);
      return client.list({ listOnly: true });
    });
    imap.refreshShared(session, folders.map(folder => folder.path));
    return folders.filter(folder => {
      if (folder.flags?.has('\\Noselect')) return false;
      try { decodeSharedTemplateRef(encodeRef(folder.path, 1, 1), session); return true; } catch { return false; }
    }).map(folder => ({ path: folder.path, owner: decodeSharedTemplateRef(encodeRef(folder.path, 1, 1), session).owner }));
  }
  async function list(session) {
    try {
      const owners = new Map();
      for (const { path, owner } of await discover(session)) {
        const rows = await imap.withMailbox(session, path, async client => {
          sessionClient(client, session);
          const result = [];
          if (client.mailbox.exists === 0) return result;
          for await (const row of client.fetch('1:*', { uid: true, size: true, bodyStructure: true, headers: ['X-WEBMAIL-TEMPLATE-ID', 'X-WEBMAIL-TEMPLATE-NAME', 'SUBJECT', 'DATE'] }, { uid: true })) {
            const value = entry(path, Number(client.mailbox.uidValidity), row, owner);
            if (value) result.push({ ...value, inShared: true });
          }
          return result;
        });
        if (!owners.has(owner)) owners.set(owner, []);
        owners.get(owner).push(...rows);
      }
      return [...owners.values()].flatMap(rows => latest(rows).map(publicEntry));
    } catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
  }
  async function selected(session, token) {
    decodeSharedTemplateRef(token, session);
    const value = (await list(session)).find(row => row.ref === token);
    if (!value) throw missing();
    return value;
  }
  async function read(session, token) {
    const value = await selected(session, token);
    const body = await reader.read(session, token);
    return { ...value, html: body.html ?? '', text: body.text ?? '', attachments: body.attachments.map(part => ({ part: part.partId, name: part.filename, size: part.size, type: part.contentType })) };
  }
  async function copy(session, token) {
    await selected(session, token);
    const raw = await imap.withRef(session, token, async (client, ref) => {
      sessionClient(client, session);
      const info = await client.fetchOne(ref.uid, { uid: true, size: true }, { uid: true });
      if (!info || info.uid !== ref.uid) throw missing();
      if (info.size > maxBytes) throw new AppError(413, 'TEMPLATE_TOO_LARGE', '템플릿 크기가 허용 크기를 넘었어요.');
      const row = await client.fetchOne(ref.uid, { uid: true, source: true }, { uid: true });
      if (row?.uid !== ref.uid || !Buffer.isBuffer(row.source)) throw missing();
      if (row.source.length > maxBytes) throw new AppError(413, 'TEMPLATE_TOO_LARGE', '템플릿 크기가 허용 크기를 넘었어요.');
      return Buffer.from(row.source);
    });
    // Release the source mailbox lock before store takes the destination lock.
    return store.importRaw(session, raw);
  }
  return { get, put, list, read, copy };
}
