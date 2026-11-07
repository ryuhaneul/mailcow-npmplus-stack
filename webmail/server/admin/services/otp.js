import { AppError } from '../../errors.js';
import { addressPattern } from '../sieve-team.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', '2단계 인증 입력값을 확인해 주세요.');
function address(raw) {
  if (typeof raw !== 'string') throw invalid();
  const value = raw.trim().toLowerCase();
  if (value.length > 254 || !addressPattern.test(value)) throw invalid();
  return value;
}
function input(data, keys) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key)) || data.confirm !== true) throw invalid();
}
const metadata = row => ({ enabled: row.enabled, registeredAt: row.registeredAt, version: row.version });
export function createOtpAdminService({ store, mailcow, audit, lock }) {
  async function mailboxAddresses(session) {
    const rows = await mailcow.call(session, 'GET', '/api/v1/get/mailbox/all');
    if (!Array.isArray(rows) && !(rows && typeof rows === 'object' && Object.keys(rows).length === 0)) throw new AppError(502, 'MAILCOW_REJECTED', '메일함 목록을 확인할 수 없어요.');
    return new Set((Array.isArray(rows) ? rows : []).map(row => address(row.username)));
  }
  async function policy({ session }) {
    const [rule, addresses, registered] = await Promise.all([store.getPolicy(), mailboxAddresses(session), store.listRegistrations()]);
    const count = new Set(registered.filter(row => row.enabled && addresses.has(row.email)).map(row => row.email)).size;
    return { ...rule, counts: { total: addresses.size, registered: count, unregistered: addresses.size - count } };
  }
  async function setPolicy({ session, actor, ip, data }) {
    input(data, ['forceAll', 'revision', 'confirm']);
    if (typeof data.forceAll !== 'boolean' || typeof data.revision !== 'string' || !/^\d+$/.test(data.revision)) throw invalid();
    return lock.run('webmail-otp:policy', async () => {
      const before = await policy({ session });
      if (before.revision !== data.revision) throw new AppError(409, 'CONFLICT', '다른 곳에서 정책이 바뀌었어요. 다시 확인해 주세요.');
      const committed = await audit.run({ actor, ip, action: 'webmail-otp.policy', target: 'policy', kind: 'config', revertible: false,
        before: { forced: before.forceAll }, after: { forced: data.forceAll } }, async intent => {
        const saved = await store.setPolicy({ forceAll: data.forceAll, revision: data.revision, actor });
        return { ...saved, unchanged: saved.unchanged === true, auditId: intent.id };
      });
      try { return { ...await policy({ session }), unchanged: committed.unchanged, auditId: committed.auditId }; }
      catch { return { ...committed, result: 'partial', warnings: [{ code: 'OTP_STATUS_UNAVAILABLE', message: '정책은 적용됐지만 현황을 조회하지 못했어요. 현재 상태를 다시 확인해 주세요.' }] }; }
    });
  }
  async function status({ addr }) { return store.readAccountStatus(address(addr)); }
  async function cleanup({ email, actor, ip, version }) {
    const addr = address(email);
    return lock.run(`webmail-otp:${addr}`, async () => {
      const before = await store.readAccountStatus(addr);
      const expected = version === undefined ? before.version : version;
      return audit.run({ actor, ip, action: 'webmail-otp.cleanup', target: addr, kind: 'irreversible', revertible: false,
        before: metadata(before), after: { enabled: false, registeredAt: null, version: null } }, async intent => {
        const saved = await store.cleanup({ email: addr, version: expected });
        return { email: addr, enabled: false, registeredAt: null, version: null, unchanged: saved.unchanged === true, auditId: intent.id };
      });
    });
  }
  async function reset({ session, actor, ip, addr: raw, data }) {
    const addr = address(raw);
    input(data, ['version', 'confirm']);
    if (data.version !== null && (typeof data.version !== 'string' || !/^[a-f0-9]{32}$/.test(data.version))) throw invalid();
    // A failed mailbox lookup must never be interpreted as a deleted account.
    if (!(await mailboxAddresses(session)).has(addr)) return cleanup({ email: addr, actor, ip, version: data.version });
    return lock.run(`webmail-otp:${addr}`, async () => {
      const before = await store.readAccountStatus(addr);
      const result = await audit.run({ actor, ip, action: 'webmail-otp.reset', target: addr, kind: 'irreversible', revertible: false,
        before: metadata(before), after: { enabled: false, registeredAt: null } }, async intent => {
        const saved = await store.reset({ email: addr, version: data.version });
        return { ...saved, auditId: intent.id, detail: { after: metadata(saved) } };
      });
      const { detail, ...response } = result; return response;
    });
  }
  return { policy, setPolicy, status, reset, cleanup };
}
