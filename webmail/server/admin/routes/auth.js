import cookie from '@fastify/cookie';
import { AppError } from '../../errors.js';
import { createMailcowClient } from '../mailcow-client.js';
import { createAdminSessionStore, cookieName, cookieOptions } from '../session.js';
import { createAdminRateLimiter } from '../ratelimit.js';
import { installAdminGuard } from '../guard.js';

export async function installAdminAuth(app, { config, client = createMailcowClient({ config, logger: app.log }), now = Date.now } = {}) {
  await app.register(cookie);
  const sessions = createAdminSessionStore({ config, client, logger: app.log, now });
  const rateLimiter = createAdminRateLimiter({ now });
  app.decorate('mailcow', client);
  app.decorate('adminSessions', sessions);
  app.decorate('adminRateLimiter', rateLimiter);
  installAdminGuard(app, { config, sessions, client });
  const timer = setInterval(() => {
    rateLimiter.sweep();
    sessions.sweep().catch(() => app.log.error({ code: 'SESSION_SWEEP_FAILED' }, '관리 만료 세션 정리에 실패했습니다.'));
  }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); await sessions.close(); });
  await app.register(authRoutes, { config, client, sessions, rateLimiter });
}

async function authRoutes(app, { config, client, sessions, rateLimiter }) {
  const publicSession = session => ({ step: session.state === 'totp' ? 'totp' : 'done', user: { username: session.username }, csrf: session.csrf, expiresAt: sessions.expiresAt(session) });
  const clear = reply => reply.clearCookie(cookieName, { ...cookieOptions(config), maxAge: 0 });
  app.post('/api/admin/auth/login', async (request, reply) => {
    const body = request.body;
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? Buffer.from(body.password) : Buffer.alloc(0);
    if (body && typeof body === 'object') delete body.password;
    try {
      if (!username || !password.length) throw new AppError(422, 'INVALID_INPUT', '아이디와 암호를 입력해 주세요.');
      rateLimiter.check(request.ip, username);
      let mailcow;
      try { mailcow = await client.login({ username, password, ip: request.ip }); }
      catch (error) {
        if (error.code === 'AUTH_FAILED') error.remainingAttempts = rateLimiter.recordFailure(request.ip, username);
        throw error;
      }
      if (!['ready', 'totp'].includes(mailcow.state)) {
        await client.logout(mailcow);
        throw new AppError(403, 'ADMIN_PENDING_ACTION', 'mailcow 관리 화면에서 필요한 작업을 먼저 끝내 주세요.');
      }
      const previous = request.cookies[cookieName];
      if (previous) {
        try { await sessions.destroy(await sessions.get(previous)); }
        catch (error) { if (!(error instanceof AppError)) throw error; }
      }
      const { token, session } = sessions.create(mailcow);
      reply.setCookie(cookieName, token, cookieOptions(config));
      return publicSession(session);
    } finally { password.fill(0); }
  });
  app.get('/api/admin/auth/session', async request => publicSession(request.session));
  app.post('/api/admin/auth/totp', async (request, reply) => {
    const session = request.session;
    if (session.state !== 'totp') throw new AppError(403, 'NO_SESSION', '2단계 인증 대기 상태가 아니에요.');
    rateLimiter.check(request.ip, session.username);
    const code = request.body?.code;
    if (request.body && typeof request.body === 'object') delete request.body.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      const error = new AppError(422, 'INVALID_INPUT', '인증 앱의 숫자 6자리를 입력해 주세요.');
      error.remainingAttempts = rateLimiter.recordFailure(request.ip, session.username);
      session.totpFailures++;
      if (session.totpFailures >= 5) { error.restart = true; clear(reply); await sessions.destroy(session); }
      throw error;
    }
    try { await client.totp(session.mailcow, code); }
    catch (error) {
      if (error.code === 'TOTP_FAILED') {
        error.remainingAttempts = rateLimiter.recordFailure(request.ip, session.username);
        error.restart = true;
      }
      clear(reply);
      await sessions.destroy(session);
      throw error;
    }
    session.state = 'ready';
    return publicSession(session);
  });
  app.post('/api/admin/auth/logout', async (request, reply) => {
    clear(reply);
    await sessions.destroy(request.session);
    return reply.code(204).send();
  });
}
