import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { MailcowAuthLost } from '../mailcow-client.js';
import { etag, assertUnchanged } from '../lock.js';
import { createFilterBackups } from './teams.js';
import { addressPattern } from '../sieve-team.js';
import { tokens } from '../../sieve/import-syntax.js';
import { externalRedirectPreview, externalSpamGuardMessage, internalDomainSet } from '../filter-script.js';
import { SCRIPT_NAME } from '../../sieve/model.js';

const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const invalid = () => new AppError(422, 'INVALID_INPUT', '메일함과 필터 입력값을 확인해 주세요.');
const uninspectable = () => new AppError(422, 'FILTER_UNINSPECTABLE', '전달 대상을 안전하게 해석할 수 없는 필터예요.');
const rejected = () => new AppError(502, 'MAILCOW_REJECTED', '필터 정보를 읽을 수 없어요.');
const verifyFailed = () => new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 필터가 예상과 달라요. 다시 확인해 주세요.');
const missing = () => new AppError(404, 'NOT_FOUND', '필터나 메일함을 찾을 수 없어요.');
function address(value) { const result = normalize(value); if (!addressPattern.test(result) || result.length > 254) throw invalid(); return result; }
function input(data, fields) { if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !fields.includes(key))) throw invalid(); }
const state = row => row ? { id: String(row.id), type: row.filter_type, active: String(row.active), label: row.script_desc, sha256: sha256(row.script_data), bytes: Buffer.byteLength(row.script_data) } : null;
const hashes = (before, after) => ({ scriptSha256Before: sha256(before), scriptSha256After: sha256(after), bytesBefore: Buffer.byteLength(before), bytesAfter: Buffer.byteLength(after) });

export function inspectRedirects(source) {
  if (typeof source !== 'string') throw uninspectable();
  let values; try { values = tokens(source); } catch { throw uninspectable(); }
  const redirects = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== 'redirect') continue;
    let index = i + 1, copy = false;
    while (typeof values[index] === 'string' && values[index].startsWith(':')) {
      if (values[index] !== ':copy' || copy) throw uninspectable(); copy = true; index++;
    }
    const targets = [];
    if (values[index] === '[') {
      index++;
      for (;;) {
        if (!values[index] || typeof values[index] !== 'object') throw uninspectable(); targets.push(values[index++].string);
        if (values[index] === ']') { index++; break; }
        if (values[index++] !== ',') throw uninspectable();
      }
    } else {
      if (!values[index] || typeof values[index] !== 'object') throw uninspectable(); targets.push(values[index++].string);
    }
    if (values[index] !== ';' || targets.some(target => typeof target !== 'string' || target.includes('${') || !addressPattern.test(target))) throw uninspectable();
    for (const target of targets) redirects.push({ target: normalize(target), copy });
    i = index;
  }
  return redirects;
}

export function createFiltersService({ mailcow, dockerapi, audit, lock, history, auditDir }) {
  const backups = createFilterBackups({ dir: auditDir });
  const get = (session, path) => mailcow.call(session, 'GET', `/api/v1/get/${path}`);
  async function rows(session, path) {
    const value = await get(session, path); if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && !Object.keys(value).length) return []; throw rejected();
  }
  async function owner(session, addr) { const row = await get(session, `mailbox/${encodeURIComponent(addr)}`); if (!row || normalize(row.username) !== addr) throw missing(); }
  async function filterRows(session, addr) {
    const data = await rows(session, `filters/${encodeURIComponent(addr)}`);
    if (data.some(row => !row || normalize(row.username) !== addr || !/^\d+$/.test(String(row.id)) || !['prefilter', 'postfilter'].includes(row.filter_type) || typeof row.script_data !== 'string' || typeof row.script_desc !== 'string')) throw rejected();
    return data;
  }
  async function internalDomains(session) {
    const [domains, aliases] = await Promise.all([rows(session, 'domain/all'), rows(session, 'alias-domain/all')]);
    return internalDomainSet(domains, aliases);
  }
  async function validate(session, source, confirmMove) {
    const redirects = inspectRedirects(source);
    if (externalRedirectPreview(source, [...await internalDomains(session)]).needsSpamGuard) throw new AppError(422, 'EXTERNAL_SPAM_GUARD', externalSpamGuardMessage);
    if (redirects.some(row => !row.copy) && confirmMove !== true) throw new AppError(422, 'MOVE_CONFIRM', '원본을 옮기는 전달이 있어요. 원본 보존 여부를 확인해 주세요.');
  }
  const dto = row => ({ id: String(row.id), type: row.filter_type, active: String(row.active) === '1', description: row.script_desc, script: row.script_data, etag: etag(state(row)) });
  async function list(session, rawAddress) { const addr = address(rawAddress); await owner(session, addr); return { address: addr, items: (await filterRows(session, addr)).map(dto) }; }
  async function apply(session, addr, id, expected, value, source) {
    const row = (await filterRows(session, addr)).find(row => String(row.id) === id); assertUnchanged(etag(expected), state(row));
    await mailcow.call(session, 'POST', '/api/v1/edit/filter', { items: [id], attr: { script_data: source, script_desc: value.label, active: value.active, filter_type: value.type } });
    const saved = (await filterRows(session, addr)).find(row => String(row.id) === id);
    if (!isDeepStrictEqual(state(saved), value)) throw verifyFailed(); return saved;
  }
  async function edit({ session, actor, ip, addr: rawAddress, id: rawId, data }) {
    input(data, ['etag', 'script', 'confirmMove']); const addr = address(rawAddress), id = String(rawId);
    if (!/^\d+$/.test(id) || typeof data.script !== 'string' || data.confirmMove !== undefined && typeof data.confirmMove !== 'boolean') throw invalid();
    return lock.run(addr, async () => {
      await owner(session, addr); const row = (await filterRows(session, addr)).find(row => String(row.id) === id); if (!row) throw missing();
      const before = state(row); assertUnchanged(data.etag, before); await validate(session, data.script, data.confirmMove);
      const after = state({ ...row, script_data: data.script }); if (isDeepStrictEqual(before, after)) return { ...dto(row), unchanged: true };
      let revertible = true, reason;
      try { await validate(session, row.script_data, true); } catch (error) {
        if (!(error instanceof AppError) || !['FILTER_UNINSPECTABLE', 'EXTERNAL_SPAM_GUARD'].includes(error.code)) throw error;
        revertible = false;
        reason = error.code === 'EXTERNAL_SPAM_GUARD' ? '이전 원문에 스팸 제외 없는 외부 전달이 있어 이 도구로 되돌릴 수 없음' : '이전 원문에 해석 불가 문법이 있어 이 도구로 되돌릴 수 없음';
      }
      const detail = revertible ? {} : { reason };
      return audit.run({ actor, ip, action: 'filter.edit', target: addr, kind: 'config', revertible, before, after, ...hashes(row.script_data, data.script) }, async intent => {
        const saved = await apply(session, addr, id, before, after, data.script); return { ...dto(saved), auditId: intent.id, detail };
      }, { prepare: ({ id }) => backups.write(id, row.script_data, data.script) });
    });
  }
  async function create({ session, actor, ip, addr: rawAddress, data }) {
    input(data, ['type', 'preset', 'script', 'confirmMove']); const addr = address(rawAddress);
    if (!['prefilter', 'postfilter'].includes(data.type) || !['discard', 'custom'].includes(data.preset) || data.confirmMove !== undefined && typeof data.confirmMove !== 'boolean' || data.preset === 'discard' && data.script !== undefined) throw invalid();
    const source = data.preset === 'discard' ? 'discard;\n' : data.script; if (typeof source !== 'string') throw invalid();
    return lock.run(addr, async () => {
      await owner(session, addr); await validate(session, source, data.confirmMove);
      const absent = async () => { const current = await filterRows(session, addr); if (current.some(row => row.filter_type === data.type && String(row.active) === '1')) throw new AppError(409, 'FILTER_EXISTS', '이미 같은 종류의 활성 관리자 필터가 있어요.'); return current; };
      const beforeRows = await absent(), wanted = { username: addr, filter_type: data.type, active: '1', script_desc: '관리자 필터', script_data: source };
      return audit.run({ actor, ip, action: 'filter.create', target: addr, kind: 'config', revertible: false, before: { type: data.type, sha256: sha256(''), bytes: 0 }, after: state({ ...wanted, id: '' }), ...hashes('', source) }, async intent => {
        await absent(); await mailcow.call(session, 'POST', '/api/v1/add/filter', wanted);
        const beforeIds = new Set(beforeRows.map(row => String(row.id))), saved = (await filterRows(session, addr)).filter(row => row.filter_type === data.type && String(row.active) === '1' && !beforeIds.has(String(row.id)));
        if (saved.length !== 1 || !isDeepStrictEqual(state(saved[0]), state({ ...wanted, id: saved[0].id }))) throw verifyFailed();
        return { ...dto(saved[0]), auditId: intent.id };
      }, { prepare: ({ id }) => backups.write(id, '', source) });
    });
  }
  async function activeScript(session, addr) {
    const value = await get(session, `active-user-sieve/${encodeURIComponent(addr)}`);
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0];
    if (value && typeof value === 'object' && !Object.keys(value).length) return null;
    throw rejected();
  }
  async function userState(session, addr) {
    const script = await activeScript(session, addr), names = await dockerapi.listSieve(addr);
    const active = names.filter(row => row.active); if (active.length > 1) throw new AppError(502, 'DOCKERAPI_REJECTED', '활성 스크립트를 확인할 수 없어요.');
    return { address: addr, script, activeName: active[0]?.name ?? null };
  }
  async function user(session, rawAddress) { const addr = address(rawAddress); await owner(session, addr); return userState(session, addr); }
  async function checks(session) {
    const [boxes, internal, global] = await Promise.all([rows(session, 'mailbox/all'), internalDomains(session), get(session, 'global_filters/all')]);
    if (!global || typeof global !== 'object' || Array.isArray(global) || ['prefilter', 'postfilter'].some(key => global[key] !== undefined && typeof global[key] !== 'string')) throw rejected();
    if (boxes.some(row => typeof row?.username !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(normalize(row.username)))) throw rejected();
    const addresses = [...new Set(boxes.map(row => normalize(row.username)))].sort();
    const result = { checked: 0, total: addresses.length, failed: [], external: [], nonWebmail: [], uninspectable: [], spamGuardMissing: [],
      globalOrder: [
        { order: 1, type: 'global-prefilter', script: global.prefilter ?? '' },
        { order: 2, type: 'admin-prefilter' },
        { order: 3, type: 'active-user' },
        { order: 4, type: 'admin-postfilter' },
        { order: 5, type: 'global-postfilter', script: global.postfilter ?? '' },
      ] };
    let next = 0, fatal;
    function inspect(source, address, metadata) {
      try {
        const external = inspectRedirects(source).filter(row => !internal.has(row.target.split('@')[1]));
        if (!external.length) return;
        const targets = [...new Set(external.map(row => row.target))].sort();
        const needsSpamGuard = externalRedirectPreview(source, [...internal]).needsSpamGuard;
        const filter = { ...metadata, targets, needsSpamGuard };
        let entry = result.external.find(row => row.address === address);
        if (!entry) { entry = { address, targets: [], filters: [] }; result.external.push(entry); }
        entry.targets = [...new Set([...entry.targets, ...targets])].sort(); entry.filters.push(filter);
        if (needsSpamGuard) result.spamGuardMissing.push({ address, ...metadata, targets });
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'FILTER_UNINSPECTABLE') throw error;
        result.uninspectable.push({ address, code: 'FILTER_UNINSPECTABLE', ...metadata });
      }
    }
    function failed(address, error, metadata = {}) {
      if (error instanceof MailcowAuthLost) fatal = error;
      else result.failed.push({ address, code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', ...metadata });
    }
    async function worker() {
      while (!fatal && next < addresses.length) {
        const addr = addresses[next++];
        try {
          for (const row of await filterRows(session, addr)) if (String(row.active) === '1') inspect(row.script_data, addr, { source: 'admin', type: row.filter_type, id: String(row.id) });
        } catch (error) { failed(addr, error, { source: 'admin' }); }
        if (fatal) continue;
        try {
          const current = await userState(session, addr); result.checked++;
          if (current.activeName && current.activeName !== SCRIPT_NAME) result.nonWebmail.push({ address: addr, activeName: current.activeName });
          if (current.script !== null) inspect(current.script, addr, { source: 'user', type: 'active-user' });
        } catch (error) { failed(addr, error); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, addresses.length) }, worker));
    if (fatal) throw fatal;
    for (const key of ['failed', 'external', 'nonWebmail', 'uninspectable', 'spamGuardMissing']) result[key].sort((a, b) => a.address.localeCompare(b.address));
    return result;
  }
  history.register('filter.create', { label: '관리자 필터를 만들었어요' });
  history.register('filter.edit', {
    label: '관리자 필터를 바꿨어요',
    read: async ({ session, target, record }) => state((await filterRows(session, target)).find(row => String(row.id) === String(record.before.id))),
    prepare: async ({ record, intent }) => { const before = await backups.read(record, 'before'), after = await backups.read(record, 'after'); await backups.write(intent.id, after, before); },
    write: async ({ session, target, expected, value, record }) => {
      const source = await backups.read(record, 'before');
      if (sha256(source) !== value.sha256) throw new AppError(409, 'NOT_REVERTIBLE', '백업 내용이 기록과 달라 되돌릴 수 없어요.');
      await validate(session, source, true);
      await apply(session, target, String(value.id), expected, value, source);
    },
  });
  return { list, edit, create, user, checks };
}
