import { randomBytes, createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../errors.js';

export const cookieName = 'webmail_sid';
export const sessionHash = token => createHash('sha256').update(token).digest('hex');

export function cookieOptions(config) {
  return { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: config.sessionMaxHours * 3600 };
}

export async function createSessionStore({ config, logger, now = Date.now, tempRoot = '/tmp/webmail' }) {
  const sessions = new Map();
  const idleMs = config.sessionIdleMin * 60_000;
  const maxMs = config.sessionMaxHours * 3_600_000;
  await rm(tempRoot, { recursive: true, force: true });

  function expired(session) {
    return (session.pendingUntil !== null && session.pendingUntil !== undefined && now() >= session.pendingUntil) || now() - session.lastSeen >= idleMs || now() - session.createdAt >= maxMs;
  }
  function expiresAt(session) {
    return new Date(Math.min(session.lastSeen + idleMs, session.createdAt + maxMs, session.pendingUntil ?? Infinity)).toISOString();
  }
  function create({ email, name, password, connection, ip }) {
    const token = randomBytes(32).toString('base64url');
    const session = {
      id: sessionHash(token), cookieHash: sessionHash(token), state: 'ready', pendingUntil: null, enrollmentDraft: null, email, name, password, connection, ip,
      scanAbort: new AbortController(),
      csrf: randomBytes(32).toString('base64url'), createdAt: now(), lastSeen: now(),
    };
    sessions.set(session.cookieHash, session);
    return { token, session };
  }
  async function destroy(session, code = 'LOGOUT') {
    if (sessions.get(session.cookieHash) !== session) return;
    sessions.delete(session.cookieHash);
    clearDraft(session);
    session.scanAbort.abort();
    // 연결 종료나 첨부 정리가 실패해도 암호는 즉시 폐기한다.
    session.password.fill(0);
    const connection = session.connection;
    session.connection = null;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => connection?.logout()),
      rm(join(tempRoot, session.id), { recursive: true, force: true }),
    ]);
    if (results.some(result => result.status === 'rejected')) logger.error({ code: 'SESSION_CLEANUP_FAILED', email: session.email, ip: session.ip }, '세션 자원 정리에 실패했습니다.');
    logger.info({ code, email: session.email, ip: session.ip }, '로그인 세션을 종료했습니다.');
  }
  async function get(token, binding) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(403, 'NO_SESSION', '로그인이 필요해요.');
    const session = sessions.get(sessionHash(token));
    if (!session) throw new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
    if (expired(session)) {
      const code = session.pendingUntil !== null && now() >= session.pendingUntil ? 'OTP_PENDING_EXPIRED' : 'SESSION_EXPIRED';
      await destroy(session, code);
      throw new AppError(403, code, '로그인이 만료됐어요. 다시 로그인해 주세요.');
    }
    if (binding) Object.assign(binding, { cookieHash: sessionHash(token), state: session.state });
    session.lastSeen = now();
    return session;
  }
  function clearDraft(session) {
    session.enrollmentDraft?.seed.fill(0);
    session.enrollmentDraft = null;
  }
  async function assertAlive(session, binding) {
    if (binding && binding.cookieHash !== session.cookieHash) throw new AppError(403, 'SESSION_EXPIRED', '다시 로그인해 주세요.');
    if (sessions.get(session.cookieHash) !== session) throw new AppError(403, 'SESSION_EXPIRED', '다시 로그인해 주세요.');
    if (expired(session)) {
      const code = session.pendingUntil !== null && now() >= session.pendingUntil ? 'OTP_PENDING_EXPIRED' : 'SESSION_EXPIRED';
      await destroy(session, code); throw new AppError(403, code, '다시 로그인해 주세요.');
    }
  }
  async function rotate(session) {
    await assertAlive(session);
    // assertAlive may yield; verify the identity again before mutating the Map.
    if (sessions.get(session.cookieHash) !== session || expired(session)) throw new AppError(403, 'SESSION_EXPIRED', '다시 로그인해 주세요.');
    const token = randomBytes(32).toString('base64url');
    sessions.delete(session.cookieHash);
    session.cookieHash = sessionHash(token);
    session.csrf = randomBytes(32).toString('base64url');
    sessions.set(session.cookieHash, session);
    return token;
  }
  let accessChecker;
  function setAccessChecker(fn) { accessChecker = fn; }
  async function checkAccess(session, binding) { await assertAlive(session, binding); return accessChecker?.(session, binding); }
  async function destroyOthersFor(session) {
    await Promise.all([...sessions.values()].filter(other => other !== session && other.email === session.email).map(other => destroy(other, 'SESSIONS_REVOKED')));
  }
  async function sweep() {
    await Promise.all([...sessions.values()].map(session => expired(session)
      ? destroy(session, 'SESSION_EXPIRED') : (session.enrollmentDraft && now() >= session.enrollmentDraft.expiresAt ? clearDraft(session) : session.sweepAttachments?.())));
  }
  async function destroyAllFor(email) {
    await Promise.all([...sessions.values()].filter(session => session.email === email).map(session => destroy(session, 'SESSIONS_REVOKED')));
  }
  async function close() {
    await Promise.all([...sessions.values()].map(session => destroy(session, 'SERVER_SHUTDOWN')));
  }
  return { assertAlive, rotate, clearDraft, destroyOthersFor, setAccessChecker, checkAccess, create, get, destroy, destroyAllFor, sweep, close, expiresAt };
}
