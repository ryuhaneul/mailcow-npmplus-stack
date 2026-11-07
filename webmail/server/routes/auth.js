import { createLoginIpStore } from '../security/login-ip-store.js';
import cookie from '@fastify/cookie';
import { createImapPool } from '../mail/imap-pool.js';
import { AppError } from '../errors.js';
import { createSessionStore, cookieOptions, cookieName } from '../security/session.js';
import { createOtpService } from '../security/otp-service.js';
import { createOtpRateLimiter, createRateLimiter } from '../security/ratelimit.js';
import { checkOrigin, checkCsrf } from '../security/csrf.js';

const changing = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function installAuth(app, { config, verifyLogin, clientFactory, now = Date.now, tempRoot, loginIps, otpStore }) {
  await app.register(cookie);
  const sessions = await createSessionStore({ config, logger: app.log, now, tempRoot });
  const loginIpStore = loginIps ?? createLoginIpStore({ config });
  app.addHook('onClose', async () => { await loginIpStore.close?.(); });
  const rateLimiter = createRateLimiter({ now, logger: app.log, readLoginIps: () => loginIpStore.list() });
  const imap = createImapPool({ config, clientFactory, logger: app.log, destroySession: (session, code) => sessions.destroy(session, code) });
  const otpLimiter = createOtpRateLimiter({ now });
  const otp = createOtpService({ store: otpStore, sessions, limiter: otpLimiter, config, now, logger: app.log });
  app.decorate('otp', otp);
  sessions.setAccessChecker(otp.checkAccess);
  app.decorate('imap', imap);
  verifyLogin ??= imap.verifyLogin;
  app.decorate('sessions', sessions);
  app.decorate('rateLimiter', rateLimiter);
  app.decorateRequest('session', null);
  app.decorateRequest('otpSnapshot', null);
  const timer = setInterval(() => {
    rateLimiter.sweep(); otpLimiter.sweep();
    sessions.sweep().catch(() => app.log.error({ code: 'SESSION_SWEEP_FAILED' }, '만료 세션 정리에 실패했습니다.'));
  }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await sessions.close();
  });
  app.addHook('preHandler', async (request, reply) => {
    const path = request.routeOptions.url;
    if (!path?.startsWith('/api/')) return;
    const isPublicConfig = request.method === 'GET' && path === '/api/config';
    const isLogin = request.method === 'POST' && path === '/api/auth/login';
    if (isPublicConfig) return;
    if (isLogin) {
      checkOrigin(request, config.publicHostnames);
      return;
    }
    reply.header('cache-control', 'no-store');
    try {
      request.session = await sessions.get(request.cookies[cookieName]);
      request.otpSnapshot = await otp.checkAccess(request.session);
    } catch (error) {
      if (error.code === 'OTP_PENDING_EXPIRED') reply.clearCookie(cookieName, { ...cookieOptions(config), maxAge: 0 });
      throw error;
    }
    if (changing.has(request.method)) {
      checkOrigin(request, config.publicHostnames);
      checkCsrf(request);
    }
    otp.authorize(request.session, request.method, path);
  });
  await app.register(authRoutes, { config, verifyLogin, sessions, rateLimiter });
}

async function authRoutes(app, { config, verifyLogin, sessions, rateLimiter }) {
  const publicSession = (session, snapshot) => app.otp.response(session, snapshot);
  app.post('/api/auth/login', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = request.body;
    if (body && typeof body === 'object' && Object.keys(body).some(key => !['email', 'password'].includes(key))) throw new AppError(422, 'INVALID_INPUT', '입력값을 확인해 주세요.');
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email.includes('@')) throw new AppError(400, 'EMAIL_FORMAT', '메일 주소를 확인해 주세요.');
    if (typeof body?.password !== 'string' || !body.password) throw new AppError(403, 'AUTH_FAILED', '메일 주소나 암호가 맞지 않아요.');
    try {
      await rateLimiter.refreshLoginIps();
      rateLimiter.checkLogin(request.ip, email);
    } catch (error) {
      request.log.warn({ code: 'RATE_LIMITED', email, ip: request.ip }, '로그인 시도 횟수가 제한됐습니다.');
      throw error;
    }
    const password = Buffer.from(body.password);
    delete body.password;
    let verified;
    try {
      verified = await verifyLogin({ email, password, ip: request.ip });
    } catch (error) {
      password.fill(0);
      const rejected = error.code === 'AUTH_FAILED' || error.authenticationFailed === true;
      if (rejected) rateLimiter.recordFailure(request.ip, email);
      const code = rejected ? 'AUTH_FAILED' : 'MAIL_UNAVAILABLE';
      request.log.warn({ code, email, ip: request.ip }, '로그인에 실패했습니다.');
      throw new AppError(rejected ? 403 : 503, code, rejected ? '메일 주소나 암호가 맞지 않아요.' : '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
    }
    let name = email;
    try { name = await app.directory.mailboxName(email); } catch {
      request.log.warn({ code: 'DIRECTORY_UNAVAILABLE' }, '로그인 이름을 조회할 수 없어 메일 주소를 표시합니다.');
    }
    let created;
    try {
      const previous = request.cookies[cookieName];
      if (previous) {
        try { await sessions.destroy(await sessions.get(previous)); } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      }
      const { token, session } = sessions.create({ email, name, password, connection: verified.connection, ip: request.ip });
      created = session;
      const snapshot = await app.otp.initialize(session);
      reply.setCookie(cookieName, token, cookieOptions(config));
      request.log.info({ code: 'LOGIN_OK', email, ip: request.ip }, '로그인했습니다.');
      return publicSession(session, snapshot);
    } catch (error) {
      if (created) await sessions.destroy(created);
      else { password.fill(0); try { await verified?.connection?.logout(); } catch {} }
      throw error;
    }
  });
  app.get('/api/auth/session', async request => { app.otp.validateBody(request.query ?? {}, []); return publicSession(request.session, request.otpSnapshot); });
  app.post('/api/auth/otp', async (request, reply) => {
    app.otp.validateBody(request.query ?? {}, []);
    const { token, value } = await app.otp.verify(request.session, request.ip, request.body);
    reply.setCookie(cookieName, token, cookieOptions(config));
    return value;
  });
  app.post('/api/auth/logout', async (request, reply) => {
    await sessions.destroy(request.session);
    reply.clearCookie(cookieName, { ...cookieOptions(config), maxAge: 0 });
    return reply.code(204).send();
  });
}
