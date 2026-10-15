import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { CookieJar, JSDOM, VirtualConsole } from 'jsdom';
import { mailTlsOptions } from '../mail/imap-pool.js';
import { AppError } from '../errors.js';

const same = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
function failure(config, status, code, message) {
  const error = new AppError(status, code, message);
  error.fallbackUrl = config.mailcowPublicUrl;
  return error;
}
const unavailable = config => failure(config, 503, 'MAILCOW_UNAVAILABLE', '지금은 암호를 바꿀 수 없어요. 잠시 뒤 다시 하거나 mailcow 사용자 화면에서 바꿔 주세요.');
const unexpected = config => failure(config, 503, 'MAILCOW_UNEXPECTED', 'mailcow 화면 형식이 달라 암호를 바꾸지 못했어요. mailcow 사용자 화면에서 바꿔 주세요.');
const twoFactor = config => failure(config, 403, 'MAILCOW_2FA', 'mailcow 화면에서 2단계 인증을 쓰고 있어 여기서는 바꿀 수 없어요. mailcow 사용자 화면에서 바꿔 주세요.');

function inspect(html) {
  const dom = new JSDOM(html, { virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    const tokens = new Set(Array.from(doc.querySelectorAll('input[name="csrf_token"]'), input => input.value));
    for (const script of doc.querySelectorAll('script:not([src])')) {
      for (const match of script.textContent.matchAll(/\bcsrf_token\s*:\s*['"]([a-f0-9]{64})['"]/gi)) tokens.add(match[1]);
      // base.twig adds the hidden input with jQuery; parse its literal without executing JS.
      for (const match of script.textContent.matchAll(/<input\s+type="hidden"\s+value="([a-f0-9]{64})">'\)\.attr\('name',\s*'csrf_token'\)/gi)) tokens.add(match[1]);
    }
    const values = [...tokens].filter(value => /^[a-f0-9]{64}$/i.test(value));
    return {
      loginForm: Boolean(doc.querySelector('input[name="login_user"]') && doc.querySelector('input[name="pass_user"]')),
      twoFactor: Boolean(doc.querySelector('#ConfirmTFAModal, input[name="verify_tfa_login"], #webauthn_auth_form')),
      user: doc.querySelector('.logged-in-as .username-lia')?.textContent.trim().toLowerCase(),
      csrf: values.length === 1 ? values[0] : null,
    };
  } finally { dom.window.close(); }
}

// One HTTPS agent and cookie jar per transaction. No redirect is followed.
export function createMailcowPasswordProxy({ config, logger }) {
  async function change(email, { current, next, next2 }) {
    const base = new URL(config.mailcowUiUrl);
    if (base.protocol !== 'https:') throw unavailable(config);
    const tls = mailTlsOptions({ ...config, mailTlsServername: config.mailcowUiServername });
    const agent = new https.Agent({ ...tls, keepAlive: false });
    const jar = new CookieJar();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref?.();
    async function request(path, form) {
      const url = new URL(path, base);
      const payload = form ? Buffer.from(new URLSearchParams(form).toString()) : null;
      try {
        return await new Promise((resolve, reject) => {
          const req = https.request(url, {
            agent, signal: controller.signal, method: form ? 'POST' : 'GET',
            headers: {
              host: config.mailcowUiServername, 'user-agent': 'mailstack-webmail',
              cookie: jar.getCookieStringSync(url.href),
              ...(payload ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': payload.length } : {}),
            },
          }, response => {
            const chunks = []; let size = 0;
            try { for (const cookie of response.headers['set-cookie'] || []) jar.setCookieSync(cookie, url.href); }
            catch { response.destroy(); reject(unexpected(config)); return; }
            response.on('data', chunk => {
              size += chunk.length;
              if (size > 2 * 1024 * 1024) { response.destroy(); reject(unexpected(config)); }
              else chunks.push(chunk);
            });
            response.once('error', reject);
            response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          });
          req.once('error', reject);
          req.end(payload || undefined);
        });
      } finally { payload?.fill(0); }
    }
    try {
      const initial = await request('/');
      if (initial.status !== 200 || !inspect(initial.body).loginForm) throw unavailable(config);
      const login = await request('/', { login_user: email, pass_user: current.toString('utf8') });
      if (inspect(login.body).twoFactor) throw twoFactor(config);
      if (![200, 302, 303].includes(login.status)) throw unavailable(config);
      const userPage = await request('/user');
      const page = inspect(userPage.body);
      if (page.twoFactor) throw twoFactor(config);
      if (userPage.status !== 200 || page.user !== email) throw unexpected(config);
      if (!page.csrf) throw unavailable(config);
      const response = await request('/api/v1/edit/self', {
        items: 'null', csrf_token: page.csrf,
        attr: JSON.stringify({ user_old_pass: current.toString('utf8'), user_new_pass: next.toString('utf8'), user_new_pass2: next2.toString('utf8') }),
      });
      if (response.status !== 200) throw unavailable(config);
      let rows; try { rows = JSON.parse(response.body); } catch { throw unavailable(config); }
      if (!Array.isArray(rows) || rows.length !== 1) throw unavailable(config);
      const row = rows[0];
      if (row?.type === 'success' && Array.isArray(row.msg) && row.msg.length === 2 && row.msg[0] === 'mailbox_modified' && typeof row.msg[1] === 'string' && JSDOM.fragment(row.msg[1]).textContent.toLowerCase() === email) return;
      if (row?.type === 'danger' && (typeof row.msg === 'string' || Array.isArray(row.msg))) {
        const code = Array.isArray(row.msg) ? row.msg[0] : row.msg;
        const message = code === 'password_mismatch' ? '새 암호가 서로 같지 않아요.' : code === 'access_denied' ? '현재 암호를 확인하거나 mailcow 사용자 화면에서 바꿔 주세요.' : '새 암호가 메일 서버의 암호 정책에 맞지 않아요.';
        throw new AppError(422, 'PW_POLICY', message);
      }
      throw unavailable(config);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable(config);
    } finally {
      try { await request('/', { logout: '1' }); }
      catch { logger?.warn({ code: 'MAILCOW_LOGOUT_FAILED' }, 'mailcow 대행 세션을 로그아웃하지 못했습니다.'); }
      finally { clearTimeout(timer); controller.abort(); agent.destroy(); jar.removeAllCookiesSync(); }
    }
  }
  return { change };
}

export function createPasswordService({ config, sessions, rateLimiter, logger, proxy = createMailcowPasswordProxy({ config, logger }) }) {
  async function change(session, body) {
    const credentials = {};
    try {
      for (const key of ['current', 'next', 'next2']) {
        if (typeof body?.[key] === 'string') credentials[key] = Buffer.from(body[key]);
        if (body && typeof body === 'object') delete body[key];
      }
      rateLimiter.checkPassword(session.email);
      if (Object.keys(credentials).length !== 3 || !credentials.current.length || !credentials.next.length || !credentials.next2.length) throw new AppError(422, 'PW_FORMAT', '암호를 입력해 주세요.');
      if (!same(credentials.next, credentials.next2)) throw new AppError(422, 'PW_MISMATCH', '새 암호가 서로 같지 않아요.');
      if (same(credentials.current, credentials.next)) throw new AppError(422, 'PW_SAME', '현재 암호와 다른 새 암호를 입력해 주세요.');
      if (!same(credentials.current, session.password)) throw failure(config, 403, 'CURRENT_WRONG', '현재 암호가 맞지 않아요.');
      await proxy.change(session.email, credentials);
      await sessions.destroyAllFor(session.email);
      logger.info({ code: 'PASSWORD_CHANGED', email: session.email, ip: session.ip }, '암호를 바꾸고 모든 웹메일 로그인을 종료했습니다.');
      return { relogin: true };
    } catch (error) {
      logger.warn({ code: error instanceof AppError ? error.code : 'PASSWORD_FAILED', email: session.email, ip: session.ip }, '암호 변경 요청을 처리하지 못했습니다.');
      throw error;
    } finally { for (const buffer of Object.values(credentials)) buffer.fill(0); }
  }
  return { change };
}
