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
    return now() - session.lastSeen >= idleMs || now() - session.createdAt >= maxMs;
  }
  function expiresAt(session) {
    return new Date(Math.min(session.lastSeen + idleMs, session.createdAt + maxMs)).toISOString();
  }
  function create({ email, name, password, connection, ip }) {
    const token = randomBytes(32).toString('base64url');
    const session = {
      id: sessionHash(token), email, name, password, connection, ip,
      csrf: randomBytes(32).toString('base64url'), createdAt: now(), lastSeen: now(),
    };
    sessions.set(session.id, session);
    return { token, session };
  }
  async function destroy(session, code = 'LOGOUT') {
    if (!sessions.delete(session.id)) return;
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
  async function get(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(403, 'NO_SESSION', '로그인이 필요해요.');
    const session = sessions.get(sessionHash(token));
    if (!session) throw new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
    if (expired(session)) {
      await destroy(session, 'SESSION_EXPIRED');
      throw new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
    }
    session.lastSeen = now();
    return session;
  }
  async function sweep() {
    await Promise.all([...sessions.values()].filter(expired).map(session => destroy(session, 'SESSION_EXPIRED')));
  }
  async function destroyAllFor(email) {
    await Promise.all([...sessions.values()].filter(session => session.email === email).map(session => destroy(session, 'SESSIONS_REVOKED')));
  }
  async function close() {
    await Promise.all([...sessions.values()].map(session => destroy(session, 'SERVER_SHUTDOWN')));
  }
  return { create, get, destroy, destroyAllFor, sweep, close, expiresAt };
}
