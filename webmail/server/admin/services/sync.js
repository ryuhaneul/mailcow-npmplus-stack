import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', '동기화 설정과 삭제 옵션 확인을 살펴봐 주세요.');
const missing = () => new AppError(404, 'NOT_FOUND', '동기화 작업을 찾을 수 없어요.');
const failed = () => new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 동기화 설정이 예상과 달라요. 다시 확인해 주세요.');
const fields = ['maxage', 'delete1', 'delete2', 'delete2duplicates', 'custom_params', 'mins_interval'];
// functions.mailbox.inc.php 2336–2367, vars.inc.php 288–414: upstream option names.
const allowedParams = new Set('abort authmd51 authmd52 authmech1 authmech2 authuser1 authuser2 debug debugcontent debugcrossduplicates debugflags debugfolders debugimap debugimap1 debugimap2 debugmemory debugssl delete1emptyfolders delete2folders disarmreadreceipts domain1 domain2 domino1 domino2 dry errorsmax exchange1 exchange2 exitwhenover expunge1 f1f2 filterbuggyflags folder folderfirst folderlast folderrec gmail1 gmail2 idatefromheader include inet4 inet6 justconnect justfolders justfoldersizes justlogin keepalive1 keepalive2 log logdir logfile maxbytesafter maxlinelength maxmessagespersecond maxsize maxsleep minage minsize noabletosearch noabletosearch1 noabletosearch2 noexpunge1 noexpunge2 nofoldersizesatend noid nolog nomixfolders noresyncflags nossl1 nossl2 nosyncacls notls1 notls2 nouidexpunge2 nousecache oauthaccesstoken1 oauthaccesstoken2 oauthdirect1 oauthdirect2 office1 office2 pidfile pidfilelocking prefix1 prefix2 proxyauth1 proxyauth2 resyncflags resynclabels search search1 search2 sep1 sep2 showpasswords skipemptyfolders ssl2 sslargs1 sslargs2 subfolder1 subscribe subscribed syncacls syncduplicates syncinternaldates synclabels tests testslive testslive6 tls2 truncmess usecache useheader useuid'.split(' '));
const destructive = ['delete', 'delete1', 'delete2', 'delete2duplicates', 'delete1emptyfolders', 'delete2folders', 'delete2foldersonly', 'delete2foldersbutnot', 'expunge', 'expunge1', 'expunge2', 'expungeaftereach', 'uidexpunge2'];
const hiddenReason = '추가 인자에 showpasswords 가 있어 로그에 원본 암호가 찍힐 수 있음 — 인자에서 빼면 로그를 볼 수 있음';
const paramNames = value => String(value ?? '').split('-').filter(Boolean).map(part => part.split('=')[0].trimEnd().toLowerCase());
const exposesPassword = value => paramNames(value).some(name => name === 'showpasswords' || 'showpasswords'.startsWith(name));
function customParams(value) {
  if (typeof value !== 'string') throw invalid();
  for (const name of paramNames(value)) {
    // Exact allowlist also rejects abbreviated option names accepted by Getopt::Long.
    if (!allowedParams.has(name) || /\s/.test(name) || destructive.some(option => option.startsWith(name)) || name === 'showpasswords') throw invalid();
  }
  return value;
}
const secretKey = key => key.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'password1';
// A09 can pass the submitted source password(s); also discover passwords in nested API log objects.
export function sanitizeSyncResponse(value, secrets = []) {
  const hidden = new Set(secrets.filter(item => typeof item === 'string' && item));
  const credential = /(?:--?password1|--?passfile1|["']?password1["']?)\s*(?:[=:]\s*|\s+)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;\]}]+)/gi;
  function collect(item) {
    if (typeof item === 'string') {
      for (const match of item.matchAll(credential)) {
        const raw = match[1], plain = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
        if (plain) hidden.add(plain);
      }
    } else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (secretKey(key) && typeof child === 'string' && child) hidden.add(child);
      else collect(child);
    }
  }
  collect(value);
  function clean(item) {
    if (typeof item === 'string') {
      let result = item.replace(credential, match => match.replace(/([=:]\s*|\s+)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;\]}]+)$/, '$1***'));
      for (const secret of [...hidden].sort((a, b) => b.length - a.length)) result = result.split(secret).join('***');
      return result.replace(/\*[^\s*<>"'@]+@mailcow\.local/gi, '****@mailcow.local');
    }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !secretKey(key)).map(([key, child]) => [key, clean(child)]));
    return item;
  }
  return clean(value);
}
function id(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw invalid();
  return String(value);
}
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
}
function boolean(value) { if (typeof value !== 'boolean') throw invalid(); return value; }
function snapshot(row) {
  return { id: String(row.id), user2: row.user2, active: String(row.active) === '1', options: {
    maxage: Number(row.maxage), delete1: String(row.delete1) === '1', delete2: String(row.delete2) === '1', delete2duplicates: String(row.delete2duplicates) === '1',
    custom_params: String(row.custom_params ?? ''), mins_interval: Number(row.mins_interval),
  } };
}
function dto(row) { return { ...row, etag: etag(snapshot(row)) }; }
export function createSyncService({ mailcow, audit, lock, history }) {
  async function call(session, method, path, body) {
    try { return sanitizeSyncResponse(await mailcow.call(session, method, path, body)); }
    catch (error) { error.message = sanitizeSyncResponse(error.message); throw error; }
  }
  async function rows(session, path) {
    const result = await call(session, 'GET', `/api/v1/get/syncjobs/${path}`);
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object' && !Object.keys(result).length) return [];
    throw new AppError(502, 'MAILCOW_REJECTED', '동기화 목록을 읽을 수 없어요.');
  }
  const listRows = session => rows(session, 'all/no_log');
  async function find(session, jobId) { return (await listRows(session)).find(row => String(row.id) === jobId) ?? null; }
  async function requireRow(session, jobId) { const row = await find(session, jobId); if (!row) throw missing(); return row; }
  async function list(session) { return { items: (await listRows(session)).map(row => { const { log, returned_text, ...safe } = row; return dto(safe); }) }; }
  async function get(session, rawId) {
    const jobId = id(rawId), row = await requireRow(session, jobId);
    const detail = (await rows(session, encodeURIComponent(row.user2))).find(item => String(item.id) === jobId);
    if (!detail) throw missing();
    if (exposesPassword(detail.custom_params)) {
      const { log, returned_text, ...safe } = detail;
      return { ...dto(safe), logHidden: true, logHiddenReason: hiddenReason };
    }
    return dto(detail);
  }
  function desired(before, data) {
    object(data, ['etag', 'active', 'options', 'confirmDelete1', 'confirmDelete2']);
    const after = structuredClone(before);
    if ('active' in data) after.active = boolean(data.active);
    for (const flag of ['confirmDelete1', 'confirmDelete2']) if (flag in data) boolean(data[flag]);
    if ('options' in data) {
      object(data.options, fields);
      for (const [key, value] of Object.entries(data.options)) {
        if (['delete1', 'delete2', 'delete2duplicates'].includes(key)) after.options[key] = boolean(value);
        else if (key === 'custom_params') after.options[key] = customParams(value);
        else {
          if (!Number.isInteger(value) || value < (key === 'maxage' ? 0 : 1) || value > (key === 'maxage' ? 32000 : 43800)) throw invalid();
          after.options[key] = value;
        }
      }
    }
    if (exposesPassword(after.options.custom_params)) throw invalid();
    for (const key of ['delete1', 'delete2']) if (!before.options[key] && after.options[key] && data[key === 'delete1' ? 'confirmDelete1' : 'confirmDelete2'] !== true) throw invalid();
    return after;
  }
  function attrs(before, after) {
    const attr = {};
    if (before.active !== after.active) attr.active = Number(after.active);
    for (const key of fields) if (before.options[key] !== after.options[key]) attr[key] = typeof after.options[key] === 'boolean' ? Number(after.options[key]) : after.options[key];
    return attr;
  }
  async function apply(session, before, after) {
    // History confirms the operation, but may never restore password-printing options.
    if (exposesPassword(after.options.custom_params)) throw invalid();
    const current = snapshot(await requireRow(session, before.id)); assertUnchanged(etag(before), current);
    await call(session, 'POST', '/api/v1/edit/syncjob', { items: [before.id], attr: attrs(before, after) });
    const row = await requireRow(session, before.id);
    if (!isDeepStrictEqual(snapshot(row), after)) throw failed();
    return row;
  }
  async function patch({ session, actor, ip, id: rawId, data }) {
    const jobId = id(rawId);
    return lock.run(`sync:${jobId}`, async () => {
      const row = await requireRow(session, jobId), before = snapshot(row);
      object(data, ['etag', 'active', 'options', 'confirmDelete1', 'confirmDelete2']); assertUnchanged(data.etag, before);
      const after = desired(before, data);
      if (isDeepStrictEqual(before, after)) return { ...dto(row), unchanged: true };
      const removedUnsafe = exposesPassword(before.options.custom_params);
      const detail = removedUnsafe ? { reason: '추가 인자 showpasswords 는 로그에 원본 암호를 남길 수 있어 다시 넣지 않음', notice: '함께 바꾼 옵션을 포함해 이 기록 전체는 되돌릴 수 없어요. 다른 옵션은 새 수정으로 바꿔 주세요.' } : {};
      return audit.run({ actor, ip, action: 'sync.edit', target: `sync:${jobId}`, kind: 'config', revertible: !removedUnsafe, before, after }, async intent => ({ ...dto(await apply(session, before, after)), auditId: intent.id, detail }));
    });
  }
  async function runNow({ session, actor, ip, id: rawId }) {
    const jobId = id(rawId);
    return lock.run(`sync:${jobId}`, async () => {
      const row = await requireRow(session, jobId), before = snapshot(row);
      if (!before.active) throw new AppError(409, 'SYNC_INACTIVE', '꺼진 동기화 작업은 실행할 수 없어요.');
      return audit.run({ actor, ip, action: 'sync.run', target: `sync:${jobId}`, kind: 'config', revertible: false, before, after: before }, async intent => {
        const current = snapshot(await requireRow(session, jobId));
        if (!current.active) throw new AppError(409, 'SYNC_INACTIVE', '꺼진 동기화 작업은 실행할 수 없어요.');
        assertUnchanged(etag(before), current);
        await call(session, 'POST', '/api/v1/edit/syncjob', { items: [jobId], attr: { last_run: '' } });
        const actual = await requireRow(session, jobId);
        if (!isDeepStrictEqual(snapshot(actual), before) || actual.last_run != null && actual.last_run !== '') throw failed();
        return { ...dto(actual), auditId: intent.id, notice: '다음 동기화 확인 때 실행돼요. 잠시 뒤 로그를 확인해 주세요.' };
      });
    });
  }
  async function remove({ session, actor, ip, id: rawId, data }) {
    const jobId = id(rawId); object(data, ['etag']);
    return lock.run(`sync:${jobId}`, async () => {
      const before = snapshot(await requireRow(session, jobId)); assertUnchanged(data.etag, before);
      return audit.run({ actor, ip, action: 'sync.delete', target: `sync:${jobId}`, kind: 'irreversible', revertible: false, before, after: null }, async intent => {
        const current = snapshot(await requireRow(session, jobId)); assertUnchanged(data.etag, current);
        await call(session, 'POST', '/api/v1/delete/syncjob', [jobId]);
        if (await find(session, jobId)) throw failed();
        return { deleted: true, auditId: intent.id };
      });
    });
  }
  history.register('sync.edit', { label: '동기화 설정을 바꿨어요', read: async ({ session, record }) => {
    const row = await find(session, record.before.id); return row ? snapshot(row) : null;
  }, write: ({ session, expected, value }) => apply(session, expected, value) });
  return { list, get, patch, runNow, remove };
}
