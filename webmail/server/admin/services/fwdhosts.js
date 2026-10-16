import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', '전달 호스트와 실행 확인을 살펴봐 주세요.');
const missing = () => new AppError(404, 'NOT_FOUND', '전달 호스트를 찾을 수 없어요.');
const duplicate = () => new AppError(409, 'FWDHOST_EXISTS', '이미 등록한 전달 호스트예요.');
const failed = () => new AppError(502, 'WRITE_VERIFY_FAILED', '전달 호스트 저장 결과가 예상과 달라요. 다시 확인해 주세요.');
const normalize = value => String(value ?? '').trim().toLowerCase();
function host(value) {
  if (typeof value !== 'string') throw invalid();
  const result = normalize(value), [address, prefix, ...extra] = result.split('/'), family = isIP(address);
  if (family && !extra.length && (prefix === undefined || /^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128))) return result;
  if (!result.includes('/') && result.length <= 253 && result.includes('.') && !/^[\d.]+$/.test(result) && result.split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(part))) return result;
  throw invalid();
}
const notice = '이름으로 등록하면 등록할 때 한 번만 IP로 바뀌어요. 릴레이 허용과는 다른 설정이에요.';
export function createFwdhostsService({ mailcow, audit, lock, history }) {
  async function read(session) {
    const value = await mailcow.call(session, 'GET', '/api/v1/get/fwdhost/all');
    if (value && typeof value === 'object' && !Object.keys(value).length) return [];
    if (!Array.isArray(value)) throw new AppError(502, 'MAILCOW_REJECTED', '전달 호스트 목록을 읽을 수 없어요.');
    return value.map(row => ({ host: String(row.host), source: String(row.source ?? row.host), keepSpam: row.keep_spam === 'yes' })).sort((a, b) => a.host.localeCompare(b.host));
  }
  const selected = (rows, name) => rows.filter(row => normalize(row.host) === name || normalize(row.source) === name);
  const snapshot = (rows, hosts) => ({ hosts: [...new Set(hosts)].sort(), entries: rows.filter(row => hosts.includes(row.host)).map(({ host, keepSpam }) => ({ host, keepSpam })) });
  async function apply(session, before, after) {
    const current = await read(session); assertUnchanged(etag(before), snapshot(current, before.hosts));
    const removed = before.entries.filter(row => !after.entries.some(next => next.host === row.host));
    if (removed.length) await mailcow.call(session, 'POST', '/api/v1/delete/fwdhost', removed.map(row => row.host));
    for (const row of after.entries) if (!before.entries.some(old => old.host === row.host && old.keepSpam === row.keepSpam)) await mailcow.call(session, 'POST', '/api/v1/add/fwdhost', { hostname: row.host, filter_spam: row.keepSpam ? '0' : '1' });
    if (!isDeepStrictEqual(snapshot(await read(session), after.hosts), after)) throw failed();
  }
  async function list(session) { return { items: await read(session), notice }; }
  async function create({ session, actor, ip, data }) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['host', 'keepSpam'].includes(key)) || data.keepSpam !== undefined && typeof data.keepSpam !== 'boolean') throw invalid();
    const name = host(data.host), keepSpam = data.keepSpam ?? true;
    return lock.run('fwdhosts', async () => {
      const beforeRows = await read(session); if (selected(beforeRows, name).length) throw duplicate();
      return audit.run({ actor, ip, action: 'fwdhost.add.flow', target: 'fwdhosts', kind: 'config', revertible: false, before: {}, after: { host: name, keepSpam } }, async flow => {
        if (selected(await read(session), name).length) throw duplicate();
        await mailcow.call(session, 'POST', '/api/v1/add/fwdhost', { hostname: name, filter_spam: keepSpam ? '0' : '1' });
        const rows = await read(session), created = selected(rows, name);
        if (!created.length || created.some(row => row.keepSpam !== keepSpam)) throw failed();
        const hosts = created.map(row => row.host), before = snapshot(beforeRows, hosts), after = snapshot(rows, hosts);
        const result = await audit.run({ actor, ip, action: 'fwdhost.change', target: 'fwdhosts', kind: 'config', revertible: true, before, after }, async intent => {
          assertUnchanged(etag(after), snapshot(await read(session), hosts));
          return { hosts: after.entries, auditId: intent.id, detail: {} };
        });
        return { ...result, flowId: flow.id, notice, detail: { changeId: result.auditId } };
      });
    });
  }
  async function remove({ session, actor, ip, data }) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['host', 'confirm'].includes(key)) || data.confirm !== true) throw invalid();
    const name = host(data.host);
    return lock.run('fwdhosts', async () => {
      const rows = await read(session), chosen = selected(rows, name); if (!chosen.length) throw missing();
      const before = snapshot(rows, chosen.map(row => row.host)), after = { hosts: before.hosts, entries: [] };
      return audit.run({ actor, ip, action: 'fwdhost.change', target: 'fwdhosts', kind: 'config', revertible: true, before, after }, async intent => {
        await apply(session, before, after); return { deleted: true, hosts: before.hosts, auditId: intent.id };
      });
    });
  }
  history.register('fwdhost.change', { label: '전달 호스트를 바꿨어요', read: async ({ session, record }) => snapshot(await read(session), record.after.hosts), write: ({ session, expected, value }) => apply(session, expected, value) });
  return { list, create, remove };
}
