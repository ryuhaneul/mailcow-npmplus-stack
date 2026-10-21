import https from 'node:https';
import { constants } from 'node:http2';
import { isDeepStrictEqual } from 'node:util';
import { CookieJar, JSDOM, VirtualConsole } from 'jsdom';
import { mailTlsOptions } from '../mail/imap-pool.js';
import { AppError } from '../errors.js';

const apiUnavailable = () => new AppError(503, 'MAILCOW_API_UNAVAILABLE', 'mailcow API 연결 설정을 확인해 주세요.');
const unavailable = () => new AppError(503, 'MAILCOW_UNAVAILABLE', 'mailcow에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
export class MailcowAuthLost extends AppError {
  constructor() {
    super(403, 'MAILCOW_SESSION_LOST', '다시 로그인해 주세요.');
    this.name = 'MailcowAuthLost';
  }
}
function inspect(html) {
  const dom = new JSDOM(html, { virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    return {
      login: Boolean(doc.querySelector('input[name="login_user"]') && doc.querySelector('input[name="pass_user"]')),
      twoFactor: Boolean(doc.querySelector('#ConfirmTFAModal')),
      totpId: doc.querySelector('#ConfirmTFAModal .totp-authenticator-selection input[type="hidden"]:not([name])')?.value.trim(),
    };
  } finally { dom.window.close(); }
}
function authFailure(data) {
  const rows = Array.isArray(data) ? data : [data];
  return rows.some(row => row?.type === 'error' && /authentication[ _]+failed|access[ _]+denied/i.test(JSON.stringify(row.msg)));
}

export function createMailcowClient({ config, logger }) {
  const base = new URL(config.mailcowUiUrl);
  const resources = new WeakMap();
  let apiAgent;
  function createApiContext({ permission }) {
    if (!['read', 'full'].includes(permission)) throw new AppError(403, 'API_KEY_FORBIDDEN', 'API 키로 접근할 수 없어요.');
    if (!config.mailcowApiKey || base.protocol !== 'https:') throw apiUnavailable();
    apiAgent ??= new https.Agent({ ...mailTlsOptions({ ...config, mailTlsServername: config.mailcowUiServername }), keepAlive: false });
    const context = Object.freeze({});
    resources.set(context, { apiKey: true, permission, agent: apiAgent, closed: false });
    return context;
  }
  async function request(session, method, path, { form, body, signal } = {}) {
    const resource = resources.get(session);
    if (!resource || resource.closed) throw new MailcowAuthLost();
    const url = new URL(path, base);
    const failed = resource.apiKey ? apiUnavailable : unavailable;
    const payload = form ? Buffer.from(new URLSearchParams(form).toString()) : body === undefined ? null : Buffer.from(JSON.stringify(body));
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15_000);
    timer.unref?.();
    try {
      return await new Promise((resolve, reject) => {
        const req = https.request(url, {
          agent: resource.agent, method, signal: controller.signal,
          headers: {
            host: config.mailcowUiServername, 'user-agent': 'mailstack-webmail-admin',
            ...(resource.apiKey ? { 'x-api-key': config.mailcowApiKey } : { 'x-forwarded-for': resource.ip, cookie: session.jar.getCookieStringSync(url.href) }),
            ...(form || body !== undefined ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
            ...(payload ? { 'content-length': payload.length } : {}),
          },
        }, response => {
          const chunks = []; let size = 0;
          try { if (!resource.apiKey) for (const cookie of response.headers['set-cookie'] || []) session.jar.setCookieSync(cookie, url.href); }
          catch { response.destroy(); reject(failed()); return; }
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) { response.destroy(); reject(failed()); }
            else chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => resolve({ status: response.statusCode, location: response.headers.location, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.once('error', reject);
        req.end(payload || undefined);
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw failed();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      payload?.fill(0);
    }
  }

  async function logout(session) {
    const resource = resources.get(session);
    if (!resource || resource.closed || resource.apiKey) return;
    if (resource.logout) return resource.logout;
    resource.logout = (async () => {
      try {
        const response = await request(session, 'POST', '/', { form: { logout: '1' } });
        if (response.status >= 400) throw unavailable();
      }
      catch { logger?.warn({ code: 'MAILCOW_LOGOUT_FAILED' }, 'mailcow 대행 세션을 로그아웃하지 못했습니다.'); }
      finally {
        resource.closed = true;
        resource.agent.destroy();
        session.jar.removeAllCookiesSync();
        session.state = 'closed';
        session.totpId = null;
        session.lastReturn = [];
      }
    })();
    return resource.logout;
  }

  async function call(session, method, path, body, signal) {
    if (!((method === 'GET' && /^\/api\/v1\/get\/[^?#]+$/.test(path)) ||
      (method === 'POST' && /^\/api\/v1\/(?:add|edit|delete)\/[^?#]+$/.test(path)))) throw new AppError(422, 'INVALID_INPUT', 'API 요청을 확인해 주세요.');
    const url = new URL(path, base);
    if (url.origin !== base.origin || url.pathname !== path || url.search || url.hash) throw new AppError(422, 'INVALID_INPUT', 'API 요청을 확인해 주세요.');
    const resource = resources.get(session);
    const apiKey = resource?.apiKey === true;
    if (apiKey && resource.permission === 'read' && method !== 'GET') throw new AppError(403, 'API_KEY_FORBIDDEN', 'API 키로 접근할 수 없어요.');
    const lost = apiKey ? apiUnavailable : () => new MailcowAuthLost();
    const response = await request(session, method, path, { body, signal });
    if ([constants.HTTP_STATUS_UNAUTHORIZED, constants.HTTP_STATUS_FORBIDDEN].includes(response.status)) throw lost();
    let data;
    try { data = JSON.parse(response.body); } catch { throw lost(); }
    if (authFailure(data)) throw lost();
    if (response.status !== 200) throw new AppError(502, 'MAILCOW_REJECTED', 'mailcow가 요청을 거절했어요.');
    if (!apiKey) session.mailcowSeenAt = Date.now();
    if (method === 'POST') {
      let current;
      if (apiKey && Array.isArray(data)) {
        current = data;
      } else if (Array.isArray(data)) {
        const previous = session.lastReturn;
        const startsWithPrevious = data.length >= previous.length && previous.every((row, index) => isDeepStrictEqual(row, data[index]));
        current = startsWithPrevious ? data.slice(previous.length) : data;
        session.lastReturn = structuredClone(data);
      } else if (data && ['success', 'error', 'danger'].includes(data.type)) {
        current = [data];
      } else {
        throw new AppError(502, 'MAILCOW_REJECTED', 'mailcow가 요청을 거절했어요.');
      }
      const rejected = current.find(row => row?.type === 'error' || row?.type === 'danger');
      if (rejected) {
        const raw = Array.isArray(rejected.msg) ? rejected.msg[0] : rejected.msg;
        const key = typeof raw === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(raw) && !(apiKey && raw.includes(config.mailcowApiKey)) ? raw : null;
        const error = new AppError(422, 'MAILCOW_REJECTED', key ? `mailcow가 요청을 거절했어요(${key}).` : 'mailcow가 요청을 거절했어요.');
        error.mailcowMessageKey = key;
        throw error;
      }
    }
    return data;
  }

  async function finish(session, response, signal) {
    if (response.status !== 302) return false;
    if (response.location === '/admin' || response.location === '/admin/') {
      const error = new AppError(403, 'ADMIN_PENDING_ACTION', 'mailcow 관리 화면에서 암호 변경이나 2단계 인증 등록을 먼저 끝내 주세요.');
      error.fallbackUrl = `https://${config.mailcowUiServername}/admin/`;
      throw error;
    }
    if (response.location !== '/admin/dashboard') throw unavailable();
    let data;
    try { data = await call(session, 'GET', '/api/v1/get/status/version', undefined, signal); }
    catch (error) {
      if (error instanceof MailcowAuthLost) throw new AppError(403, 'NOT_ADMIN', '관리자 계정으로 로그인해 주세요.');
      throw error;
    }
    if (!data || typeof data.version !== 'string' || !data.version) throw new AppError(403, 'NOT_ADMIN', '관리자 계정으로 로그인해 주세요.');
    session.state = 'ready';
    session.totpId = null;
    return true;
  }

  async function login({ username, password, ip }) {
    let session;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    timer.unref?.();
    try {
      if (typeof username !== 'string' || !username.trim() || !Buffer.isBuffer(password) || !password.length) throw new AppError(422, 'INVALID_INPUT', '아이디와 암호를 입력해 주세요.');
      if (base.protocol !== 'https:') throw unavailable();
      session = { state: 'login', username: username.trim().toLowerCase(), jar: new CookieJar(), totpId: null, mailcowSeenAt: null, lastReturn: [] };
      resources.set(session, { ip, agent: new https.Agent({ ...mailTlsOptions({ ...config, mailTlsServername: config.mailcowUiServername }), keepAlive: false }), closed: false });
      const initial = await request(session, 'GET', '/admin/', { signal: controller.signal });
      if (initial.status !== 200 || !inspect(initial.body).login) throw unavailable();
      const response = await request(session, 'POST', '/admin/', { form: { login_user: session.username, pass_user: password.toString('utf8') }, signal: controller.signal });
      if (await finish(session, response, controller.signal)) return session;
      if (response.status !== 200) throw unavailable();
      const page = inspect(response.body);
      if (page.twoFactor) {
        if (!page.totpId) throw new AppError(403, 'ADMIN_2FA_UNSUPPORTED', '이 계정은 인증 앱(TOTP)으로 로그인할 수 없어요. mailcow에서 인증 앱을 추가해 주세요.');
        session.state = 'totp';
        session.totpId = page.totpId;
        return session;
      }
      if (page.login) throw new AppError(403, 'AUTH_FAILED', '아이디 또는 암호를 확인해 주세요.');
      throw unavailable();
    } catch (error) {
      if (session) await logout(session);
      if (error instanceof AppError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
      if (Buffer.isBuffer(password)) password.fill(0);
    }
  }

  async function totp(session, code) {
    if (!/^\d{6}$/.test(code) || typeof code !== 'string') throw new AppError(422, 'INVALID_INPUT', '인증 앱의 숫자 6자리를 입력해 주세요.');
    if (session.state !== 'totp') throw new MailcowAuthLost();
    try {
      const response = await request(session, 'POST', '/admin/', { form: { verify_tfa_login: '1', tfa_method: 'totp', token: code, id: session.totpId } });
      if (await finish(session, response)) return session;
      const error = new AppError(403, 'TOTP_FAILED', '인증 코드를 확인하고 처음부터 다시 로그인해 주세요.');
      error.restart = true;
      throw error;
    } catch (error) {
      await logout(session);
      throw error;
    }
  }
  return { login, totp, call, logout, createApiContext };
}
