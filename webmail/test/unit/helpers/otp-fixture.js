// Synthetic, test-injected store only. There is no production fallback store.
import { newOtpVersion, encryptOtpSeed, decryptOtpSeed, matchTotp } from '../../../server/security/otp.js';
import { AppError } from '../../../server/errors.js';
export const otpConfig = { otpKey: Buffer.alloc(32, 7), otpKeyVersion: 1 };
export const otpEnv = { OTP_KEY: otpConfig.otpKey.toString('hex'), OTP_KEY_VERSION: '1' };
export function createOtpFixture({ now = Date.now } = {}) {
  const rows = new Map();
  const policy = { forceAll: false, policyRevision: '0' };
  let reads = 0, failure = false;
  const assertAvailable = () => { if (failure) throw new AppError(503, 'OTP_UNAVAILABLE', '인증 상태를 확인할 수 없어요.'); };
  const state = row => row ? { ...row, ...policy } : null;
  const off = email => ({ email, version: newOtpVersion(), enabled: false, registeredAt: null, envelope: null, lastStep: '-1' });
  const ensure = session => { if (!rows.has(session.email)) rows.set(session.email, off(session.email)); return state(rows.get(session.email)); };
  const changed = () => new AppError(409, 'OTP_STATE_CHANGED', '인증 설정이 바뀌었어요.');
  function owned(session) {
    const row = rows.get(session.email);
    if (!row || row.version !== session.otpVersion) throw changed();
    return row;
  }
  function consume(seed, code, lastStep) {
    const step = matchTotp(seed, code, { now: now(), lastStep });
    if (step === null) throw new AppError(403, 'OTP_INVALID', '인증 코드를 확인해 주세요. 이미 사용한 코드는 다음 코드로 다시 시도해 주세요.');
    return String(step);
  }
  const store = {
    async ensureAccount(session) { assertAvailable(); return ensure(session); },
    async readAccess(session) {
      assertAvailable(); reads++;
      // Legacy regression fixtures create memory sessions directly, without login.
      // Only this injected fixture assigns a generation to those synthetic sessions.
      if (session.otpVersion === undefined) {
        const snapshot = ensure(session); session.otpVersion = snapshot.version; session.policyRevision = snapshot.policyRevision;
      }
      return state(rows.get(session.email));
    },
    async confirmEnrollment(session, { draft, code, key, keyVersion }) {
      assertAvailable(); const row = owned(session);
      if (row.enabled || row.version !== draft.baseVersion || policy.policyRevision !== draft.policyRevision) throw changed();
      if (now() >= draft.expiresAt) throw new AppError(403, 'OTP_SETUP_EXPIRED', '등록 시간이 지났어요.');
      const lastStep = consume(draft.seed, code, -1), version = newOtpVersion();
      Object.assign(row, { version, enabled: true, registeredAt: new Date(now()).toISOString(), lastStep,
        envelope: encryptOtpSeed({ seed: draft.seed, email: session.email, version, key, keyVersion }) });
      return state(row);
    },
    async verify(session, { code, key, keyVersion }) {
      assertAvailable(); const row = owned(session); if (!row.enabled) throw changed();
      const seed = decryptOtpSeed({ envelope: row.envelope, email: session.email, version: row.version, key, keyVersion });
      try { row.lastStep = consume(seed, code, row.lastStep); } finally { seed.fill(0); }
      return state(row);
    },
    async disable(session, args) {
      assertAvailable(); if (policy.forceAll) throw new AppError(403, 'OTP_FORCED', '필수 적용 중에는 끌 수 없습니다.');
      await store.verify(session, args);
      const row = rows.get(session.email); Object.assign(row, off(session.email)); return state(row);
    },
    async close() {},
  };
  return { store, rows, policy, get reads() { return reads; }, set unavailable(value) { failure = value; },
    force(value) { if (policy.forceAll !== value) { policy.forceAll = value; policy.policyRevision = String(BigInt(policy.policyRevision) + 1n); } },
    reset(email) { if (rows.has(email)) rows.set(email, off(email)); },
    register(email, seed) {
      const row = off(email); Object.assign(row, { enabled: true, registeredAt: new Date(now()).toISOString(), envelope: encryptOtpSeed({ seed, email, version: row.version, key: otpConfig.otpKey, keyVersion: 1 }) }); rows.set(email, row); return row;
    } };
}
