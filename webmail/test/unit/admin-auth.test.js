import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';
import { sessionHash } from '../../server/admin/session.js';
import { logOptions } from '../../server/log.js';

const origin = 'https://mailadmin.example.com';
const password = 'synthetic-a03-password!';
const config = { adminHostname: 'mailadmin.example.com', sessionIdleMin: 60, sessionMaxHours: 8,
  trustProxy: ['192.0.2.0/24'], mailcowUiUrl: 'https://nginx-mailcow:8443', mailcowUiServername: 'mailcow.example.com', logLevel: 'silent' };
async function fixture(t, { state = 'ready', overrides = {} } = {}) {
  let clock = Date.UTC(2026, 9, 16);
  let logs = '';
  const calls = [], remoteSessions = [];
  const options = { state };
  const client = {
    async login(args) {
      calls.push({ kind: 'login', ...args });
      if (options.loginError) throw options.loginError();
      const session = { state: options.state, username: args.username, jar: 'synthetic-private-cookie', closed: false };
      remoteSessions.push(session); return session;
    },
    async totp(session, code) {
      calls.push({ kind: 'totp', code, session });
      if (options.totpError) throw options.totpError();
      session.state = 'ready'; return session;
    },
    async call(session, method, path, body) {
      calls.push({ kind: 'call', session, method, path, body });
      if (options.probeError && path === '/api/v1/get/status/version') throw options.probeError();
      if (options.apiError && path !== '/api/v1/get/status/version') throw options.apiError();
      return path === '/api/v1/get/status/version' ? options.version ?? { version: '2026-09a' } : { items: [] };
    },
    async logout(session) {
      if (session.closed) return;
      session.closed = true; calls.push({ kind: 'logout', session });
      if (options.logoutError) throw new Error('synthetic-cleanup-failure');
    },
  };
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
  const app = await createAdminApp({ config: { ...config, ...overrides }, logger: { ...logOptions('info'), stream },
    staticDir: '/nonexistent-admin-auth-fixture', auth: { client, now: () => clock } });
  let handled = 0;
  app.get('/api/admin/test-local', async () => { handled++; return { ok: true }; });
  app.post('/api/admin/test-write', { config: { adminMailcowApi: true } }, async () => { handled++; return { ok: true }; });
  app.get('/api/admin/test-mailcow', { config: { adminMailcowApi: true } }, async request => {
    handled++; return app.mailcow.call(request.session.mailcow, 'GET', '/api/v1/get/mailbox/all');
  });
  t.after(() => app.close());
  return { app, calls, client, options, remoteSessions, advance: ms => { clock += ms; },
    get logs() { return logs; }, get handled() { return handled; }, get now() { return clock; } };
}
function login(f, { username = '  ADMIN  ', ip = '198.51.100.9', headers = {}, ...extra } = {}) {
  return f.app.inject({ method: 'POST', url: '/api/admin/auth/login', remoteAddress: ip,
    headers: { origin, ...headers }, payload: { username, password }, ...extra });
}
function credentials(response) {
  return { cookie: response.headers['set-cookie'].split(';')[0], 'x-mailadmin-csrf': response.json().csrf, origin };
}
function write(f, path, headers, payload = {}) {
  return f.app.inject({ method: 'POST', url: path, remoteAddress: '198.51.100.9', headers, payload });
}
function failure(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code);
  assert.equal(response.headers['www-authenticate'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
}
const count = (f, kind) => f.calls.filter(call => call.kind === kind).length;

test('admin auth: random host-only strict cookie, hashed storage and sanitized ready session', async t => {
  const f = await fixture(t); const response = await login(f);
  assert.equal(response.statusCode, 200, response.body);
  const cookie = response.headers['set-cookie'];
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) assert.ok(cookie.includes(attr), attr);
  assert.ok(!/domain=/i.test(cookie)); assert.ok(cookie.startsWith('mailadmin_sid='));
  const token = credentials(response).cookie.split('=')[1];
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  const session = await f.app.adminSessions.get(token);
  assert.equal(session.id, sessionHash(token)); assert.notEqual(session.id, token);
  assert.equal(session.mailcow, f.remoteSessions[0]);
  assert.equal(f.calls[0].username, 'admin'); assert.equal(f.calls[0].ip, '198.51.100.9');
  assert.ok(f.calls[0].password.every(byte => byte === 0));
  assert.deepEqual(Object.keys(response.json()).sort(), ['csrf', 'expiresAt', 'features', 'step', 'user']);
  assert.deepEqual(response.json().user, { username: 'admin' }); assert.equal(response.json().step, 'done');
  const current = await f.app.inject({ url: '/api/admin/auth/session', headers: credentials(response) });
  assert.deepEqual(current.json(), response.json()); assert.equal(count(f, 'call'), 0);
  for (const secret of [password, token, 'synthetic-private-cookie', session.csrf]) assert.ok(!f.logs.includes(secret));
});

test('admin auth: health, missing paths and public app paths stay public', async t => {
  const f = await fixture(t);
  assert.equal((await f.app.inject('/healthz')).statusCode, 200);
  for (const path of ['/api/admin/missing', '/api/auth/session', '/unknown']) {
    const response = await f.app.inject(path); assert.equal(response.statusCode, 404); assert.equal(response.json().error.code, 'NOT_FOUND');
  }
  failure(await f.app.inject('/api/admin/auth/session'), 403, 'NO_SESSION');
  assert.equal(count(f, 'login'), 0);
});

for (const value of ['https://outside.example.com', 'https://mailadmin.example.com:443', 'null', '']) test(`admin auth: login Origin ${value || 'empty'} denied`, async t => {
  const f = await fixture(t);
  failure(await login(f, { headers: { origin: value } }), 403, 'BAD_ORIGIN');
  assert.equal(count(f, 'login'), 0);
});

for (const value of ['text/plain', 'application/x-www-form-urlencoded', 'application/octet-stream']) test(`admin auth: ${value} is JSON_REQUIRED before body parser`, async t => {
  const f = await fixture(t);
  failure(await login(f, { headers: { 'content-type': value }, payload: 'synthetic' }), 415, 'JSON_REQUIRED');
  assert.equal(count(f, 'login'), 0);
});

test('admin auth: write requires Origin, session and constant-time CSRF comparison', async t => {
  const f = await fixture(t); const headers = credentials(await login(f));
  failure(await write(f, '/api/admin/test-write', { ...headers, origin: 'https://outside.example.com' }), 403, 'BAD_ORIGIN');
  const noCsrf = { ...headers }; delete noCsrf['x-mailadmin-csrf'];
  for (const bad of [noCsrf, { ...headers, 'x-mailadmin-csrf': 'incorrect' }]) failure(await write(f, '/api/admin/test-write', bad), 403, 'CSRF');
  failure(await write(f, '/api/admin/test-write', { origin }), 403, 'NO_SESSION');
  assert.equal(f.handled, 0); assert.equal(count(f, 'call'), 0);
});

test('admin auth: all writes probe mailcow even when marked API-backed; local reads probe too', async t => {
  const f = await fixture(t); const headers = credentials(await login(f));
  assert.equal((await write(f, '/api/admin/test-write', headers)).statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/admin/test-local', headers })).statusCode, 200);
  assert.deepEqual(f.calls.filter(call => call.kind === 'call').map(call => call.path), ['/api/v1/get/status/version', '/api/v1/get/status/version']);
  assert.equal((await f.app.inject({ url: '/api/admin/test-mailcow', headers })).statusCode, 200);
  assert.equal(f.calls.at(-1).path, '/api/v1/get/mailbox/all'); assert.equal(count(f, 'call'), 3);
});

for (const path of ['/api/admin/test-write', '/api/admin/test-local']) test(`admin auth: failed probe prevents ${path} and revokes local session`, async t => {
  const f = await fixture(t); const headers = credentials(await login(f));
  f.options.probeError = () => new AppError(503, 'MAILCOW_UNAVAILABLE', '연결 실패');
  const response = path.endsWith('write') ? await write(f, path, headers) : await f.app.inject({ url: path, headers });
  failure(response, 403, 'MAILCOW_SESSION_LOST'); assert.equal(f.handled, 0); assert.equal(count(f, 'logout'), 1);
  assert.match(response.headers['set-cookie'], /Max-Age=0/);
  failure(await f.app.inject({ url: '/api/admin/auth/session', headers }), 403, 'SESSION_EXPIRED');
});

test('admin auth: successful HTTP probe without version is session loss', async t => {
  const f = await fixture(t); const headers = credentials(await login(f)); f.options.version = {};
  failure(await write(f, '/api/admin/test-write', headers), 403, 'MAILCOW_SESSION_LOST');
  assert.equal(count(f, 'logout'), 1);
});

test('admin auth: API read auth loss revokes local session through shared error hook', async t => {
  const f = await fixture(t); const headers = credentials(await login(f));
  f.options.apiError = () => new MailcowAuthLost();
  failure(await f.app.inject({ url: '/api/admin/test-mailcow', headers }), 403, 'MAILCOW_SESSION_LOST');
  assert.equal(count(f, 'logout'), 1);
});

test('admin auth: totp cookie returns CSRF and fixed five-minute expiry, blocks other paths', async t => {
  const f = await fixture(t, { state: 'totp' }); const response = await login(f); const headers = credentials(response);
  assert.equal(response.json().step, 'totp'); assert.equal(Date.parse(response.json().expiresAt), f.now + 5 * 60_000);
  assert.ok(response.json().csrf);
  assert.deepEqual((await f.app.inject({ url: '/api/admin/auth/session', headers })).json(), response.json());
  failure(await f.app.inject({ url: '/api/admin/test-local', headers }), 403, 'NO_SESSION');
  failure(await write(f, '/api/admin/test-write', headers), 403, 'NO_SESSION');
  const noCsrf = { ...headers }; delete noCsrf['x-mailadmin-csrf'];
  failure(await write(f, '/api/admin/auth/totp', noCsrf, { code: '123456' }), 403, 'CSRF');
  assert.equal(count(f, 'totp'), 0); assert.equal(count(f, 'call'), 0);
  const done = await write(f, '/api/admin/auth/totp', headers, { code: '123456' });
  assert.equal(done.statusCode, 200, done.body); assert.deepEqual(done.json().features, { cleanup: false, relay: false }); assert.equal(done.json().step, 'done'); assert.equal(count(f, 'totp'), 1);
  assert.equal((await f.app.inject({ url: '/api/admin/test-local', headers })).statusCode, 200);
});

test('admin auth: TOTP failure immediately revokes session, returns restart and retains IP counter', async t => {
  const f = await fixture(t, { state: 'totp' }); const headers = credentials(await login(f));
  f.options.totpError = () => new AppError(403, 'TOTP_FAILED', '인증 실패');
  const response = await write(f, '/api/admin/auth/totp', headers, { code: '654321' });
  failure(response, 403, 'TOTP_FAILED'); assert.equal(response.json().error.restart, true); assert.equal(response.json().error.remainingAttempts, 4);
  assert.equal(count(f, 'logout'), 1); assert.match(response.headers['set-cookie'], /Max-Age=0/);
  assert.ok(f.logs.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(record => record.code === 'TOTP_FAILED' && record.username === 'admin' && record.ip === '198.51.100.9'));
  failure(await write(f, '/api/admin/auth/totp', headers, { code: '123456' }), 403, 'SESSION_EXPIRED');
  f.options.loginError = () => new AppError(403, 'AUTH_FAILED', '로그인 실패');
  const next = await login(f, { username: 'other' }); failure(next, 403, 'AUTH_FAILED'); assert.equal(next.json().error.remainingAttempts, 3);
});

test('admin auth: five malformed TOTP attempts revoke pending session without submitting to mailcow', async t => {
  const f = await fixture(t, { state: 'totp' }); const headers = credentials(await login(f));
  for (let i = 0; i < 5; i++) {
    const response = await write(f, '/api/admin/auth/totp', headers, { code: 'bad' });
    failure(response, 422, 'INVALID_INPUT'); assert.equal(response.json().error.remainingAttempts, 4 - i);
    assert.equal(response.json().error.restart, i === 4 ? true : undefined);
  }
  assert.equal(count(f, 'totp'), 0); assert.equal(count(f, 'logout'), 1);
  const blocked = await login(f); failure(blocked, 429, 'RATE_LIMITED');
  assert.equal(blocked.headers['retry-after'], '300'); assert.equal(blocked.json().error.retryAfter, 300);
});

test('admin auth: five actual TOTP failures across fresh password logins are limited by IP and username', async t => {
  const f = await fixture(t, { state: 'totp' });
  f.options.totpError = () => new AppError(403, 'TOTP_FAILED', '인증 실패');
  for (let i = 0; i < 5; i++) {
    const response = await login(f); assert.equal(response.statusCode, 200);
    failure(await write(f, '/api/admin/auth/totp', credentials(response), { code: '654321' }), 403, 'TOTP_FAILED');
  }
  failure(await login(f), 429, 'RATE_LIMITED');
  failure(await login(f, { username: 'other' }), 429, 'RATE_LIMITED');
  failure(await login(f, { ip: '203.0.113.8' }), 429, 'RATE_LIMITED');
  assert.equal(count(f, 'totp'), 5); assert.equal(count(f, 'logout'), 5);
});

for (const dimension of ['IP', 'username']) test(`admin auth: ${dimension} five failures block for exactly five minutes`, async t => {
  const f = await fixture(t); f.options.loginError = () => new AppError(403, 'AUTH_FAILED', '로그인 실패');
  for (let i = 0; i < 5; i++) {
    const response = await login(f, { username: dimension === 'IP' ? `admin${i}` : 'ADMIN', ip: dimension === 'IP' ? '198.51.100.9' : `203.0.113.${i + 1}` });
    failure(response, 403, 'AUTH_FAILED');
  }
  const attempt = { username: dimension === 'IP' ? 'other' : 'admin', ip: '198.51.100.9' };
  const blocked = await login(f, attempt); failure(blocked, 429, 'RATE_LIMITED');
  assert.equal(blocked.json().error.retryAfter, 300); assert.equal(blocked.headers['retry-after'], '300');
  assert.equal(count(f, 'login'), 5);
  f.advance(299_000); const finalSecond = await login(f, attempt); failure(finalSecond, 429, 'RATE_LIMITED'); assert.equal(finalSecond.headers['retry-after'], '1');
  f.advance(1000); f.options.loginError = null; assert.equal((await login(f, attempt)).statusCode, 200);
});

test('admin auth: failures older than ten minutes expire and success does not reset recent failures', async t => {
  const f = await fixture(t); f.options.loginError = () => new AppError(403, 'AUTH_FAILED', '로그인 실패');
  failure(await login(f), 403, 'AUTH_FAILED');
  f.options.loginError = null; assert.equal((await login(f)).statusCode, 200);
  f.options.loginError = () => new AppError(403, 'AUTH_FAILED', '로그인 실패');
  assert.equal((await login(f)).json().error.remainingAttempts, 3);
  f.advance(10 * 60_000); f.app.adminRateLimiter.sweep();
  assert.equal((await login(f)).json().error.remainingAttempts, 4);
});

for (const code of ['ADMIN_PENDING_ACTION', 'ADMIN_2FA_UNSUPPORTED', 'NOT_ADMIN', 'MAILCOW_UNAVAILABLE']) test(`admin auth: ${code} logged but not counted, never issues a session`, async t => {
  const f = await fixture(t); const status = code === 'MAILCOW_UNAVAILABLE' ? 503 : 403;
  f.options.loginError = () => new AppError(status, code, '처리 실패');
  for (let i = 0; i < 6; i++) {
    const response = await login(f); failure(response, status, code); assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal(count(f, 'login'), 6); assert.match(f.logs, new RegExp(code)); assert.match(f.logs, /198\.51\.100\.9/);
  assert.ok(!f.logs.includes(password));
});

for (const kind of ['idle', 'maximum', 'totp']) test(`admin auth: ${kind} expiry destroys remote session once`, async t => {
  const f = await fixture(t, { state: kind === 'totp' ? 'totp' : 'ready', overrides: kind === 'maximum' ? { sessionIdleMin: 60, sessionMaxHours: 2 } : {} });
  const headers = credentials(await login(f));
  if (kind === 'maximum') {
    for (let i = 0; i < 2; i++) {
      f.advance(59 * 60_000);
      assert.equal((await f.app.inject({ url: '/api/admin/auth/session', headers })).statusCode, 200);
    }
    f.advance(2 * 60_000);
  } else f.advance(kind === 'totp' ? 5 * 60_000 : 60 * 60_000);
  failure(await f.app.inject({ url: '/api/admin/auth/session', headers }), 403, 'SESSION_EXPIRED');
  assert.equal(count(f, 'logout'), 1); await f.app.adminSessions.sweep(); assert.equal(count(f, 'logout'), 1);
});

test('admin auth: one-minute sweeper path removes inactive TOTP sessions at fixed five-minute deadline', async t => {
  const f = await fixture(t, { state: 'totp' }); const response = await login(f); const headers = credentials(response);
  f.advance(4 * 60_000); assert.equal((await f.app.inject({ url: '/api/admin/auth/session', headers })).statusCode, 200);
  f.advance(60_000); await f.app.adminSessions.sweep(); assert.equal(count(f, 'logout'), 1);
  assert.ok(f.logs.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(record => record.code === 'SESSION_EXPIRED' && record.username === 'admin'));
  failure(await f.app.inject({ url: '/api/admin/auth/session', headers }), 403, 'SESSION_EXPIRED');
});

for (const lost of [false, true]) test(`admin auth: logout clears cookie and remote session when probe lost=${lost}`, async t => {
  const f = await fixture(t); const headers = credentials(await login(f));
  if (lost) f.options.probeError = () => new MailcowAuthLost();
  const response = await write(f, '/api/admin/auth/logout', headers);
  assert.equal(response.statusCode, 204, response.body); assert.equal(response.body, '');
  if (lost) assert.ok(f.logs.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(record => record.code === 'MAILCOW_SESSION_LOST' && record.username === 'admin'));
  assert.match(response.headers['set-cookie'], /Max-Age=0/); assert.ok(!/domain=/i.test(response.headers['set-cookie']));
  assert.equal(count(f, 'logout'), 1); failure(await f.app.inject({ url: '/api/admin/auth/session', headers }), 403, 'SESSION_EXPIRED');
});

test('admin auth: failed remote logout still removes local state and emits sanitized warning', async t => {
  const f = await fixture(t); const headers = credentials(await login(f)); f.options.logoutError = true;
  assert.equal((await write(f, '/api/admin/auth/logout', headers)).statusCode, 204);
  failure(await f.app.inject({ url: '/api/admin/auth/session', headers }), 403, 'SESSION_EXPIRED');
  assert.match(f.logs, /MAILCOW_LOGOUT_FAILED/); assert.ok(!f.logs.includes('synthetic-cleanup-failure'));
});

test('admin auth: replacing a login closes the old session, and shutdown closes the new session', async t => {
  const f = await fixture(t); const first = credentials(await login(f));
  const second = await login(f, { headers: { cookie: first.cookie } });
  assert.equal(second.statusCode, 200); assert.notEqual(credentials(second).cookie, first.cookie);
  assert.equal(count(f, 'logout'), 1); failure(await f.app.inject({ url: '/api/admin/auth/session', headers: first }), 403, 'SESSION_EXPIRED');
  await f.app.close(); assert.equal(count(f, 'logout'), 2);
});

test('admin auth: oversized JSON is rejected without sending credentials upstream', async t => {
  const f = await fixture(t);
  const response = await login(f, { payload: { username: 'admin', password: 'x'.repeat(64 * 1024) } });
  assert.equal(response.statusCode, 413); assert.equal(count(f, 'login'), 0);
});

for (const [doveadmUrl, doveadmKey, relayFiles, expected] of [
  ['', '', [], { cleanup: false, relay: false }],
  ['http://dovecot:12346', 'synthetic-feature-key', [], { cleanup: true, relay: false }],
  ['http://dovecot:12346', '', ['/run/relay/postfix/extra.cf', '/run/relay/rspamd/options.inc'], { cleanup: false, relay: true }],
  ['http://dovecot:12346', 'synthetic-feature-key', ['/run/relay/postfix/extra.cf', '/run/relay/rspamd/options.inc'], { cleanup: true, relay: true }],
]) test(`admin feature flags cleanup=${expected.cleanup} relay=${expected.relay} expose booleans only`, async t => {
  const f = await fixture(t, { overrides: { doveadmUrl, doveadmKey, relayFiles } });
  const response = await login(f); assert.deepEqual(response.json().features, expected);
  const current = await f.app.inject({ url: '/api/admin/auth/session', headers: credentials(response) });
  assert.deepEqual(current.json().features, expected);
  assert.ok(!JSON.stringify(current.json()).includes('synthetic-feature-key'));
});


test('admin auth: pending action links to the public mailcow administration URL', async t => {
  const f = await fixture(t, { overrides: { mailcowPublicUrl: 'https://mailcow.example.com/' } });
  f.options.loginError = () => new AppError(403, 'ADMIN_PENDING_ACTION', 'mailcow에서 먼저 완료해 주세요.');
  const response = await login(f);
  failure(response, 403, 'ADMIN_PENDING_ACTION');
  assert.equal(response.json().error.fallbackUrl, 'https://mailcow.example.com/');
  assert.equal(response.headers['set-cookie'], undefined);
});

for (const stage of ['login', 'totp']) test(`admin auth: eight concurrent ${stage} attempts reserve the shared budget before mailcow`, async t => {
  const f = await fixture(t, { state: stage === 'totp' ? 'totp' : 'ready' });
  const headers = [];
  if (stage === 'totp') for (let i = 0; i < 8; i++) headers.push(credentials(await login(f)));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered = 0, admitted;
  const fiveEntered = new Promise(resolve => { admitted = resolve; });
  const original = f.client[stage];
  f.client[stage] = async (...args) => {
    entered++;
    if (entered === 5) admitted();
    await gate;
    // The final submitted request would succeed if it reached mailcow.
    if (stage === 'totp' ? args[1] === '999999' : args[0].password.toString() === 'synthetic-success') return original(...args);
    throw new AppError(403, stage === 'totp' ? 'TOTP_FAILED' : 'AUTH_FAILED', '인증 실패');
  };
  const pending = Array.from({ length: 8 }, (_, i) => stage === 'totp'
    ? write(f, '/api/admin/auth/totp', headers[i], { code: i === 7 ? '999999' : '000000' })
    : login(f, { payload: { username: 'admin', password: i === 7 ? 'synthetic-success' : password } }));
  // Start every injection while the fake upstream holds all admitted requests.
  const results = pending.map(response => Promise.resolve(response));
  await fiveEntered;
  await new Promise(resolve => setImmediate(resolve));
  const beforeResult = entered;
  release();
  const responses = await Promise.all(results);
  assert.equal(beforeResult, 5);
  assert.equal(entered, 5);
  assert.equal(responses.filter(response => response.statusCode === 200).length, 0);
  for (let i = 0; i < 8; i++) failure(responses[i], i < 5 ? 403 : 429, i < 5 ? (stage === 'totp' ? 'TOTP_FAILED' : 'AUTH_FAILED') : 'RATE_LIMITED');
  failure(await login(f), 429, 'RATE_LIMITED');
  assert.equal(entered, 5);
  assert.ok(f.logs.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(record => record.code === 'RATE_LIMITED' && record.username === 'admin' && record.ip === '198.51.100.9'));
});

test('admin auth: successful TOTP releases only its reservation, retaining other recent failures', async t => {
  const f = await fixture(t, { state: 'totp' });
  const first = credentials(await login(f));
  const second = credentials(await login(f));
  f.options.totpError = () => new AppError(403, 'TOTP_FAILED', '인증 실패');
  failure(await write(f, '/api/admin/auth/totp', first, { code: '000000' }), 403, 'TOTP_FAILED');
  f.options.totpError = null;
  assert.equal((await write(f, '/api/admin/auth/totp', second, { code: '123456' })).statusCode, 200);
  assert.equal(f.app.adminRateLimiter.remaining('198.51.100.9', 'admin'), 4);
  assert.equal(f.app.adminRateLimiter.remaining('203.0.113.8', 'other'), 5);
});

test('admin auth: management redact removes every planned secret field from emitted JSON', async t => {
  const f = await fixture(t);
  const secrets = ['synthetic-cookie-secret', 'synthetic-csrf-secret', 'synthetic-body-secret',
    'synthetic-password-secret', 'synthetic-code-secret', 'synthetic-data-secret', 'synthetic-script-secret'];
  // Override the request serializer to exercise redaction independently of its normal filtering.
  const logger = f.app.log.child({}, { serializers: { req: value => value } });
  logger.info({ req: { headers: { cookie: secrets[0], 'x-mailadmin-csrf': secrets[1] }, body: { value: secrets[2] } },
    payload: { password: secrets[3], code: secrets[4], dataBase64: secrets[5], script: secrets[6], safe: 'visible' } }, 'redact probe');
  assert.match(f.logs, /redact probe/);
  assert.match(f.logs, /visible/);
  for (const secret of secrets) assert.ok(!f.logs.includes(secret), secret);
  const record = f.logs.trim().split('\n').map(line => JSON.parse(line)).find(line => line.msg === 'redact probe');
  assert.deepEqual(record.req, { headers: {} });
  assert.deepEqual(record.payload, { safe: 'visible' });
});

test('admin auth: authentication lifecycle emits identity, IP and safe event codes', async t => {
  const f = await fixture(t);
  f.options.loginError = () => new AppError(403, 'AUTH_FAILED', '인증 실패');
  failure(await login(f), 403, 'AUTH_FAILED');
  f.options.loginError = null;
  const headers = credentials(await login(f));
  assert.equal((await write(f, '/api/admin/auth/logout', headers)).statusCode, 204);
  const records = f.logs.trim().split('\n').map(line => JSON.parse(line));
  for (const code of ['AUTH_FAILED', 'LOGIN_SUCCESS', 'LOGOUT']) {
    const record = records.find(record => record.code === code);
    assert.equal(record?.username, 'admin');
    assert.equal(record.ip, '198.51.100.9');
  }
});

test('admin auth: fifth successful reservation releases the block without erasing four failures', async t => {
  const f = await fixture(t);
  f.options.loginError = () => new AppError(403, 'AUTH_FAILED', '인증 실패');
  for (let i = 0; i < 4; i++) failure(await login(f), 403, 'AUTH_FAILED');
  f.options.loginError = null;
  assert.equal((await login(f)).statusCode, 200);
  assert.equal(f.app.adminRateLimiter.remaining('198.51.100.9', 'admin'), 1);
  f.options.loginError = () => new AppError(403, 'AUTH_FAILED', '인증 실패');
  failure(await login(f), 403, 'AUTH_FAILED');
  failure(await login(f), 429, 'RATE_LIMITED');
  f.advance(5 * 60_000);
  f.options.loginError = null;
  assert.equal((await login(f)).statusCode, 200);
  assert.equal((await login(f)).statusCode, 200);
});
