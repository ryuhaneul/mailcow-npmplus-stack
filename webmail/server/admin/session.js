import { randomBytes, createHash } from 'node:crypto';
import { AppError } from '../errors.js';

export const cookieName = 'mailadmin_sid';
export const sessionHash = token => createHash('sha256').update(token).digest('hex');
export const cookieOptions = config => ({ httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: config.sessionMaxHours * 3600 });

export function createAdminSessionStore({ config, client, logger, now = Date.now }) {
  const sessions = new Map();
  const cleanup = new Map();
  const idleMs = config.sessionIdleMin * 60_000;
  const maxMs = config.sessionMaxHours * 3_600_000;
  function expiresAt(session) {
    return new Date(Math.min(session.lastSeen + idleMs, session.createdAt + maxMs,
      session.state === 'totp' ? session.createdAt + 5 * 60_000 : Infinity)).toISOString();
  }
  const expired = session => now() >= Date.parse(expiresAt(session));
  function create(mailcow) {
    const token = randomBytes(32).toString('base64url');
    const session = { id: sessionHash(token), username: mailcow.username, state: mailcow.state, mailcow,
      csrf: randomBytes(32).toString('base64url'), createdAt: now(), lastSeen: now(), totpFailures: 0 };
    sessions.set(session.id, session);
    return { token, session };
  }
  async function destroy(session) {
    if (!sessions.delete(session.id)) return cleanup.get(session.id);
    const job = (async () => {
      try { await client.logout(session.mailcow); }
      catch { logger?.warn({ code: 'MAILCOW_LOGOUT_FAILED' }, 'mailcow 대행 세션을 로그아웃하지 못했습니다.'); }
      finally { session.state = 'closed'; session.csrf = ''; }
    })();
    cleanup.set(session.id, job);
    try { await job; } finally { cleanup.delete(session.id); }
  }
  async function get(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(403, 'NO_SESSION', '로그인이 필요해요.');
    const session = sessions.get(sessionHash(token));
    if (!session) throw new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
    if (expired(session)) {
      await destroy(session);
      throw new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
    }
    session.lastSeen = now();
    return session;
  }
  async function sweep() { await Promise.all([...sessions.values()].filter(expired).map(destroy)); }
  async function close() {
    await Promise.all([...sessions.values()].map(destroy));
    await Promise.all(cleanup.values());
  }
  return { create, get, destroy, sweep, close, expiresAt };
}
