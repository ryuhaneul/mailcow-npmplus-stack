import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';
import { MailcowAuthLost } from './mailcow-client.js';
import { cookieName, cookieOptions } from './session.js';

const changing = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const authRoot = '/api/admin/auth/';
export function installAdminGuard(app, { config, sessions, client }) {
  app.decorateRequest('session', null);
  app.decorateRequest('adminError', null);
  const clear = reply => reply.clearCookie(cookieName, { ...cookieOptions(config), maxAge: 0 });
  const managed = request => request.routeOptions.url?.startsWith('/api/admin/');
  app.addHook('onRequest', async request => {
    if (!managed(request) || !changing.has(request.method)) return;
    if (request.headers.origin !== `https://${config.adminHostname}`) throw new AppError(403, 'BAD_ORIGIN', '허용된 관리 주소에서 다시 시도해 주세요.');
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError(415, 'JSON_REQUIRED', 'JSON 형식으로 요청해 주세요.');
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!managed(request)) return;
    const path = request.routeOptions.url;
    if (request.method === 'POST' && path === `${authRoot}login`) return;
    try { request.session = await sessions.get(request.cookies[cookieName]); }
    catch (error) { clear(reply); throw error; }
    const session = request.session;
    const isSession = request.method === 'GET' && path === `${authRoot}session`;
    const isTotp = request.method === 'POST' && path === `${authRoot}totp`;
    const isLogout = request.method === 'POST' && path === `${authRoot}logout`;
    if (session.state !== 'ready' && !(session.state === 'totp' && (isTotp || isSession))) throw new AppError(403, 'NO_SESSION', '로그인을 먼저 완료해 주세요.');
    if (changing.has(request.method)) {
      const raw = request.headers['x-mailadmin-csrf'];
      const actual = typeof raw === 'string' ? Buffer.from(raw) : Buffer.alloc(0);
      const expected = Buffer.from(session.csrf);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AppError(403, 'CSRF', '요청을 확인할 수 없어요. 화면을 새로 고친 뒤 다시 시도해 주세요.');
    }
    if (isSession || isTotp || (!changing.has(request.method) && request.routeOptions.config.adminMailcowApi === true)) return;
    try {
      const status = await client.call(session.mailcow, 'GET', '/api/v1/get/status/version');
      if (!status || typeof status.version !== 'string' || !status.version) throw new MailcowAuthLost();
    } catch {
      clear(reply);
      await sessions.destroy(session);
      if (!isLogout) throw new MailcowAuthLost();
    }
  });
  app.addHook('onError', async (request, reply, error) => {
    request.adminError = error;
    if (managed(request)) request.log.warn({ code: error instanceof AppError ? error.code : 'ADMIN_REQUEST_FAILED', ip: request.ip }, '관리 요청을 처리하지 못했습니다.');
    if (error instanceof MailcowAuthLost && request.session) {
      clear(reply);
      await sessions.destroy(request.session);
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const error = request.adminError;
    if (!(error instanceof AppError) || reply.statusCode < 400 || typeof payload !== 'string') return payload;
    const extra = {};
    if (error.restart === true) extra.restart = true;
    if (Number.isInteger(error.retryAfter) && error.retryAfter > 0) extra.retryAfter = error.retryAfter;
    if (Number.isInteger(error.remainingAttempts) && error.remainingAttempts >= 0) extra.remainingAttempts = error.remainingAttempts;
    if (error.code === 'ADMIN_PENDING_ACTION') extra.fallbackUrl = config.mailcowPublicUrl;
    else if (typeof error.fallbackUrl === 'string') extra.fallbackUrl = error.fallbackUrl;
    if (!Object.keys(extra).length) return payload;
    const body = JSON.parse(payload);
    Object.assign(body.error, extra);
    reply.removeHeader('content-length');
    return JSON.stringify(body);
  });
}
