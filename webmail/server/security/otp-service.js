import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { createResourceLock } from '../admin/lock.js';
import { createOtpSeed, decryptOtpSeed, otpEnrollmentQr, otpUnavailable } from './otp.js';

const pendingMs = 300_000;
const denied = () => new AppError(403, 'OTP_REQUIRED', '2단계 인증을 마쳐 주세요.');
const conflict = () => new AppError(409, 'OTP_STATE_CHANGED', '인증 설정이 바뀌었어요. 다시 로그인해 주세요.');
const invalid = () => new AppError(422, 'INVALID_INPUT', '입력값을 확인해 주세요.');
const pendingPaths = {
  otp: new Set(['GET /api/auth/session', 'POST /api/auth/otp', 'POST /api/auth/logout']),
  enroll: new Set(['GET /api/auth/session', 'POST /api/otp/enrollment', 'POST /api/otp/enrollment/confirm', 'POST /api/auth/logout']),
};
export function createOtpService({ store, sessions, limiter, config, now = Date.now }) {
  const lock = createResourceLock();
  const keyArgs = { key: config.otpKey, keyVersion: config.otpKeyVersion };
  function validateEnvelope(snapshot) {
    if (snapshot.enabled) {
      const seed = decryptOtpSeed({ envelope: snapshot.envelope, email: snapshot.email, version: snapshot.version, ...keyArgs });
      seed.fill(0);
    }
  }
  function metadata(snapshot) {
    return { enabled: snapshot.enabled, registeredAt: snapshot.registeredAt, forced: snapshot.forceAll, version: snapshot.version, policyRevision: snapshot.policyRevision };
  }
  function response(session, snapshot) {
    return { step: session.state === 'ready' ? 'done' : session.state, user: { email: session.email, name: session.name }, csrf: session.csrf, expiresAt: sessions.expiresAt(session), otp: metadata(snapshot) };
  }
  async function expire(session, code = 'SESSION_EXPIRED') {
    await sessions.destroy(session, code);
    throw new AppError(403, code, '인증 설정이 바뀌었어요. 다시 로그인해 주세요.');
  }
  function requireStep(session) {
    return Object.assign(denied(), { step: session.state, expiresAt: sessions.expiresAt(session) });
  }
  async function initialize(session) {
    const snapshot = await store.ensureAccount(session);
    if (!snapshot) return expire(session);
    validateEnvelope(snapshot);
    session.otpVersion = snapshot.version; session.policyRevision = snapshot.policyRevision;
    session.state = snapshot.enabled ? 'otp' : snapshot.forceAll ? 'enroll' : 'ready';
    session.pendingUntil = session.state === 'ready' ? null : now() + pendingMs;
    return snapshot;
  }
  async function checkAccess(session) {
    await sessions.assertAlive(session);
    const snapshot = await store.readAccess(session);
    // A queued state check may finish after logout/reset has destroyed this session.
    await sessions.assertAlive(session);
    if (!snapshot || snapshot.version !== session.otpVersion) return expire(session);
    validateEnvelope(snapshot);
    if ((session.state === 'enroll' || session.enrollmentDraft) && session.policyRevision !== snapshot.policyRevision) return expire(session);
    if (session.state === 'ready' && !snapshot.enabled && snapshot.forceAll) {
      session.state = 'enroll'; session.pendingUntil = now() + pendingMs;
    }
    session.policyRevision = snapshot.policyRevision;
    return snapshot;
  }
  function authorize(session, method, path) {
    if (session.state !== 'ready' && !pendingPaths[session.state]?.has(`${method} ${path}`)) throw requireStep(session);
  }
  function validateBody(body, fields) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) throw invalid();
    if (fields.includes('draftId') && !/^[a-f0-9]{32}$/.test(body.draftId ?? '')) throw invalid();
  }
  async function begin(session) {
    return lock.run(session.id, async () => {
      const snapshot = await checkAccess(session);
      if (!['ready', 'enroll'].includes(session.state) || snapshot.enabled) throw denied();
      let draft = session.enrollmentDraft;
      if (draft && now() >= draft.expiresAt) {
        sessions.clearDraft(session);
        throw new AppError(403, 'OTP_SETUP_EXPIRED', '등록 시간이 지났어요. 새 QR 코드로 다시 시작해 주세요.');
      }
      if (!draft) {
        draft = { id: randomBytes(16).toString('hex'), seed: createOtpSeed(), baseVersion: session.otpVersion,
          policyRevision: snapshot.policyRevision, expiresAt: Math.min(now() + pendingMs, session.pendingUntil ?? Infinity) };
        session.enrollmentDraft = draft;
      }
      const qr = await otpEnrollmentQr({ seed: draft.seed, email: session.email, issuer: config.brandName });
      await sessions.assertAlive(session);
      if (session.enrollmentDraft !== draft || now() >= draft.expiresAt) { sessions.clearDraft(session); throw new AppError(403, 'OTP_SETUP_EXPIRED', '등록 시간이 지났어요. 새 QR 코드로 다시 시작해 주세요.'); }
      return { draftId: draft.id, ...qr, expiresAt: new Date(draft.expiresAt).toISOString() };
    });
  }
  async function cancel(session) {
    return lock.run(session.id, async () => {
      await checkAccess(session);
      if (session.state !== 'ready') throw denied();
      sessions.clearDraft(session);
    });
  }
  // Reserve synchronously before queueing/SQL so parallel callers cannot exceed limits.
  async function change(session, ip, operation, body) {
    const release = limiter.reserve(ip, session.email);
    try {
      return await lock.run(session.id, async () => {
        await sessions.assertAlive(session);
        validateBody(body, operation === 'confirm' ? ['draftId', 'code'] : ['code']);
        if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw invalid();
        await checkAccess(session);
        if (operation === 'verify' && session.state !== 'otp' || operation === 'confirm' && !['ready', 'enroll'].includes(session.state) || operation === 'disable' && session.state !== 'ready') throw denied();
        let saved;
        if (operation === 'confirm') {
          const draft = session.enrollmentDraft;
          if (!draft || now() >= draft.expiresAt) {
            sessions.clearDraft(session); throw new AppError(403, 'OTP_SETUP_EXPIRED', '등록 시간이 지났어요. 새 QR 코드로 다시 시작해 주세요.');
          }
          if (body.draftId !== draft.id) throw conflict();
          saved = await store.confirmEnrollment(session, { draft, code: body.code, ...keyArgs });
        } else saved = await store[operation](session, { code: body.code, ...keyArgs });
        // Keep pending TTL in force until rotation succeeds; never resurrect expired sessions.
        const token = await sessions.rotate(session);
        sessions.clearDraft(session);
        session.state = 'ready'; session.pendingUntil = null;
        session.otpVersion = saved.version; session.policyRevision = saved.policyRevision;
        if (operation !== 'verify') await sessions.destroyOthersFor(session);
        release();
        return { token, value: response(session, saved) };
      });
    } catch (error) {
      if (![422, 429].includes(error.statusCode) && error.code !== 'OTP_INVALID') release();
      if (error.code === 'OTP_STATE_CHANGED') await sessions.destroy(session, 'SESSION_EXPIRED');
      if (!(error instanceof AppError)) throw otpUnavailable();
      throw error;
    }
  }
  return { initialize, checkAccess, authorize, response, metadata, validateBody, begin, cancel,
    verify: (session, ip, body) => change(session, ip, 'verify', body),
    confirm: (session, ip, body) => change(session, ip, 'confirm', body),
    disable: (session, ip, body) => change(session, ip, 'disable', body) };
}
