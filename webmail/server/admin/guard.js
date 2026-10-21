import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';
import { MailcowAuthLost } from './mailcow-client.js';
import { cookieName, cookieOptions } from './session.js';
import { createApiKeyRateLimiter } from './api-key-ratelimit.js';

const changing = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const authRoot = '/api/admin/auth/';
const keyHeader = 'x-mailadmin-api-key';
const tokenPattern = /^mak_v1_[A-Za-z0-9_-]{43}$/;
const keyMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const authenticationFailures = new Set(['INVALID_TOKEN', 'UNKNOWN_KEY', 'REVOKED', 'EXPIRED', 'IP_DENIED']);
const keyReasons = new Set([...authenticationFailures, 'HUMAN_ONLY', 'PERMISSION_DENIED']);
const forbidden = reason => Object.assign(new AppError(403, 'API_KEY_FORBIDDEN', 'API 키로 접근할 수 없어요.'), { reason });
const humanOnly = path => path === '/api/admin/auth' || path.startsWith(authRoot) || path === '/api/admin/api-keys' || path.startsWith('/api/admin/api-keys/');
export function installAdminGuard(app, { config, sessions, client, apiKeys, apiKeyRateLimiter = createApiKeyRateLimiter() }) {
  app.decorateRequest('session', null);
  app.decorateRequest('adminError', null);
  app.decorateRequest('adminPrincipal', null);
  app.decorateRequest('adminKeyMode', false);
  const clear = reply => reply.clearCookie(cookieName, { ...cookieOptions(config), maxAge: 0 });
  const managed = request => request.routeOptions.url?.startsWith('/api/admin/');
  app.addHook('onRequest', async request => {
    if (!managed(request)) return;
    request.adminKeyMode = Object.hasOwn(request.headers, keyHeader);
    if (request.adminKeyMode && humanOnly(request.routeOptions.url)) throw forbidden('HUMAN_ONLY');
    if (!changing.has(request.method)) return;
    if (!request.adminKeyMode && request.headers.origin !== `https://${config.adminHostname}`) throw new AppError(403, 'BAD_ORIGIN', '허용된 관리 주소에서 다시 시도해 주세요.');
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError(415, 'JSON_REQUIRED', 'JSON 형식으로 요청해 주세요.');
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!managed(request)) return;
    const path = request.routeOptions.url;
    if (request.adminKeyMode) {
      const release = apiKeyRateLimiter.reserveIp(request.ip);
      let authenticated = false;
      try {
        const token = request.headers[keyHeader];
        const duplicates = request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === keyHeader).length;
        if (duplicates > 1 || typeof token !== 'string' || !tokenPattern.test(token)) throw forbidden('INVALID_TOKEN');
        if (!config.mailcowApiKey || !apiKeys) throw new AppError(503, 'MAILCOW_API_UNAVAILABLE', 'mailcow API 연결 설정을 확인해 주세요.');
        const result = await apiKeys.authenticate(token, request.ip);
        if (!result.ok) throw forbidden(result.reason);
        authenticated = true;
        release();
        const item = result.item;
        request.adminPrincipal = { type: 'apiKey', id: item.id, name: item.name, permission: item.permission };
        apiKeyRateLimiter.reserveKey(item.id);
        if (!keyMethods.has(request.method) || (item.permission === 'read' && request.method !== 'GET')) throw forbidden('PERMISSION_DENIED');
        await apiKeys.recordUse(item.id, request.ip);
        const context = client.createApiContext({ permission: item.permission });
        request.session = { id: `apikey:${item.id}`, username: `API 키: ${item.name}`, state: 'ready', mailcow: context };
        if (!changing.has(request.method) && request.routeOptions.config.adminMailcowApi === true) return;
        const status = await client.call(context, 'GET', '/api/v1/get/status/version');
        if (!status || typeof status.version !== 'string' || !status.version) throw new AppError(503, 'MAILCOW_API_UNAVAILABLE', 'mailcow API 연결 설정을 확인해 주세요.');
        return;
      } catch (error) {
        if (!authenticated && !(error.code === 'API_KEY_FORBIDDEN' && authenticationFailures.has(error.reason))) release();
        throw error;
      }
    }
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
      request.log.warn({ code: 'MAILCOW_SESSION_LOST', username: session.username, ip: request.ip }, 'mailcow 관리 세션을 잃었습니다.');
      clear(reply);
      await sessions.destroy(session);
      if (!isLogout) throw new MailcowAuthLost();
    }
  });
  app.addHook('onError', async (request, reply, error) => {
    request.adminError = error;
    if (managed(request) && request.adminKeyMode) request.log.warn({ code: error instanceof AppError ? error.code : 'ADMIN_REQUEST_FAILED', reason: keyReasons.has(error.reason) ? error.reason : undefined, requestId: request.id, method: request.method, route: request.routeOptions.url, ip: request.ip, keyId: request.adminPrincipal?.id }, 'API 키 요청을 처리하지 못했습니다.');
    else if (managed(request)) request.log.warn({ code: error instanceof AppError ? error.code : 'ADMIN_REQUEST_FAILED', username: request.session?.username ?? (typeof request.body?.username === 'string' ? request.body.username.trim().toLowerCase() : undefined), ip: request.ip }, '관리 요청을 처리하지 못했습니다.');
    if (error instanceof MailcowAuthLost && request.session && !request.adminKeyMode) {
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
