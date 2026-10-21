import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';
import { logOptions } from '../../server/log.js';
import { sessionHash } from '../../server/security/session.js';
import { createRateLimiter } from '../../server/security/ratelimit.js';

const secret = 'synthetic-login-password-123!';
const env = {
  PUBLIC_HOSTNAMES: 'newmail.example.com,newmail.example.org', BRAND_NAME: '메일', ORG_NAME: '', BRAND_MARK: '', DEFAULT_THEME: 'ink', DEFAULT_MODE: 'system',
  INTERNAL_DOMAINS: '', ATTACH_MAX_MB: '25', SESSION_IDLE_MIN: '480', SESSION_MAX_HOURS: '24', AUTOEXPUNGE_DAYS: '30',
  IMAP_HOST: 'dovecot-mailcow', SIEVE_HOST: 'dovecot-mailcow', SMTP_HOST: 'postfix-mailcow', MAIL_TLS_SERVERNAME: 'mail.example.com', MAIL_TLS_MODE: 'verify', MAIL_TLS_PIN_FILE: '',
  DB_HOST: 'mysql-mailcow', DB_NAME: 'mailcow', DB_USER: 'webmail_ro', DB_PASSWORD: 'synthetic-db-secret', MAILCOW_UI_URL: 'https://nginx-mailcow:8443', MAILCOW_UI_SERVERNAME: 'mailcow.example.com', MAILCOW_PUBLIC_URL: 'https://mailcow.example.com',
  TRUST_PROXY: '172.22.1.0/24,192.0.2.0/24,2001:db8:1::/48', LOG_LEVEL: 'info',
};
const allLogs = [];

async function fixture(t, { verifyLogin, overrides = {}, auth = {} } = {}) {
  const calls = [];
  let closes = 0;
  let logs = '';
  let time = Date.UTC(2026, 0, 1);
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-w02-test-'));
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); allLogs.push(chunk.toString()); done(); } });
  const app = await createApp({
    config: loadConfig({ ...env, ...overrides }), logger: { ...logOptions('info'), stream },
    staticDir: '/nonexistent-webmail-auth-fixture',
    auth: {
      now: () => time, tempRoot,
      verifyLogin: async args => {
        calls.push(args);
        if (verifyLogin) return verifyLogin(args);
        return { name: '예제 사용자', connection: { async logout() { closes++; } } };
      }, ...auth,
    },
  });
  app.directory.mailboxName = async () => '예제 사용자';
  t.after(async () => {
    await app.close();
    if (process.env.WEBMAIL_TEST_LOG) await appendFile(process.env.WEBMAIL_TEST_LOG, logs);
    await rm(tempRoot, { recursive: true, force: true });
  });
  return { app, calls, tempRoot, get closes() { return closes; }, get logs() { return logs; }, advance(ms) { time += ms; } };
}
function login(app, { email = 'user@example.com', password = secret, origin = 'https://newmail.example.com', remoteAddress = '198.51.100.9', headers = {} } = {}) {
  const actualHeaders = { ...headers };
  if (origin !== null) actualHeaders.origin = origin;
  return app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, headers: actualHeaders, payload: { email, password } });
}
function credentials(response) {
  return { cookie: response.headers['set-cookie'].split(';')[0], 'x-webmail-csrf': response.json().csrf, origin: 'https://newmail.example.com' };
}
function assertFailure(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code);
  assert.equal(response.headers['www-authenticate'], undefined);
}

const ipCases = [
  ['untrusted ignores XFF', '198.51.100.9', '203.0.113.9', '198.51.100.9'],
  ['one proxy', '172.22.1.2', '198.51.100.9', '198.51.100.9'],
  ['two proxies', '172.22.1.2', '198.51.100.9,192.0.2.10', '198.51.100.9'],
  ['skip trusted hops', '172.22.1.2', '198.51.100.9,192.0.2.10,172.22.1.3', '198.51.100.9'],
  ['ignore forged left item', '172.22.1.2', '203.0.113.66,198.51.100.9,192.0.2.10', '198.51.100.9'],
  ['malformed boundary uses preceding address', '172.22.1.2', '198.51.100.9,broken,192.0.2.10', '192.0.2.10'],
  ['empty XFF', '172.22.1.2', '', '172.22.1.2'],
  ['IPv6', '2001:db8:1::2', '2001:db8:2::9', '2001:db8:2::9'],
];
for (const [label, remoteAddress, forwarded, expected] of ipCases) {
  test(`client IP: ${label}`, async t => {
    const f = await fixture(t);
    f.app.get('/test-ip', async request => ({ ip: request.ip }));
    const headers = { 'x-forwarded-for': forwarded, 'x-real-ip': '203.0.113.77' };
    const ip = await f.app.inject({ url: '/test-ip', remoteAddress, headers });
    assert.deepEqual(ip.json(), { ip: expected });
    const response = await login(f.app, { remoteAddress, headers });
    assert.equal(response.statusCode, 200);
    assert.equal(f.calls[0].ip, expected);
    const record = f.logs.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(record => record.code === 'LOGIN_OK');
    assert.equal(record.ip, expected);
  });
}

test('login: normalized email, password Buffer, random cookie attributes and public session', async t => {
  const f = await fixture(t);
  const response = await login(f.app, { email: '  USER@EXAMPLE.COM  ' });
  assert.equal(response.statusCode, 200);
  const cookie = response.headers['set-cookie'];
  for (const value of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=86400']) assert.ok(cookie.includes(value), value);
  const token = credentials(response).cookie.split('=')[1];
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.ok(!cookie.includes(secret));
  assert.deepEqual(f.calls[0].email, 'user@example.com');
  assert.ok(Buffer.isBuffer(f.calls[0].password));
  assert.equal(f.calls[0].password.toString(), secret);
  assert.deepEqual(response.json().user, { email: 'user@example.com', name: '예제 사용자' });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(response.json()).sort(), ['csrf', 'expiresAt', 'user']);
  const session = await f.app.sessions.get(token);
  assert.equal(session.id, sessionHash(token));
  assert.notEqual(session.id, token);
  assert.equal(session.password, f.calls[0].password);
  const current = await f.app.inject({ url: '/api/auth/session', headers: credentials(response) });
  assert.equal(current.statusCode, 200);
  assert.deepEqual(current.json(), response.json());
  assert.ok(!current.body.includes(secret));
  const second = await login(f.app);
  assert.notEqual(credentials(second).cookie, credentials(response).cookie);
  assert.notEqual(second.json().csrf, response.json().csrf);
});

for (const [label, mailboxName, expected] of [
  ['directory name', async () => '데모 1', '데모 1'],
  ['empty directory name', async email => email, 'user@example.com'],
  ['directory unavailable', async () => { throw Object.assign(new Error('synthetic-private-db-password'), { statusCode: 503 }); }, 'user@example.com'],
]) test(`login: ${label} preserves a successful session`, async t => {
  const f = await fixture(t);
  f.app.directory.mailboxName = mailboxName;
  const response = await login(f.app);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().user, { email: 'user@example.com', name: expected });
  const current = await f.app.inject({ url: '/api/auth/session', headers: credentials(response) });
  assert.equal(current.statusCode, 200);
  assert.deepEqual(current.json().user, response.json().user);
  assert.ok(!f.logs.includes('synthetic-private-db-password'));
});

test('login: address without @ rejected before verifier', async t => {
  const f = await fixture(t);
  assertFailure(await login(f.app, { email: 'invalid' }), 400, 'EMAIL_FORMAT');
  assert.equal(f.calls.length, 0);
});

test('login: authentication rejection gives 403 and wipes password, even exception contains secret', async t => {
  const f = await fixture(t, { verifyLogin: async ({ password }) => {
    throw Object.assign(new Error(password.toString()), { authenticationFailed: true });
  } });
  const response = await login(f.app);
  assertFailure(response, 403, 'AUTH_FAILED');
  assert.equal(response.json().error.message, '메일 주소나 암호가 맞지 않아요.');
  assert.ok(f.calls[0].password.every(byte => byte === 0));
  assert.ok(!f.logs.includes(secret));
  assert.ok(!response.body.includes(secret));
});

test('login: unavailable verifier gives 503 MAIL_UNAVAILABLE and wipes password', async t => {
  const f = await fixture(t, { verifyLogin: async () => { throw new Error(secret); } });
  assertFailure(await login(f.app), 503, 'MAIL_UNAVAILABLE');
  assert.ok(f.calls[0].password.every(byte => byte === 0));
  assert.ok(!f.logs.includes(secret));
});

test('login: default verifier maps connection failure to unavailable', async t => {
  const f = await fixture(t, { auth: { verifyLogin: undefined, clientFactory: options => ({ options, on() {}, close() {}, async connect() { throw new Error('synthetic connection unavailable'); } }) } });
  assertFailure(await login(f.app), 503, 'MAIL_UNAVAILABLE');
});

test('Origin: missing, HTTP, suffix attack and unknown origin rejected; second configured hostname accepted', async t => {
  const f = await fixture(t);
  for (const origin of [null, 'http://newmail.example.com', 'https://newmail.example.com.attacker.example.org', 'https://unknown.example.com']) {
    assertFailure(await login(f.app, { origin }), 403, 'BAD_ORIGIN');
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await login(f.app, { origin: 'https://newmail.example.org' })).statusCode, 200);
});

test('session: no cookie, invented cookie and inbound bearer never authenticate', async t => {
  const f = await fixture(t);
  assertFailure(await f.app.inject('/api/auth/session'), 403, 'NO_SESSION');
  assertFailure(await f.app.inject({ url: '/api/auth/session', headers: { authorization: 'Bearer synthetic' } }), 403, 'NO_SESSION');
  assertFailure(await f.app.inject({ url: '/api/auth/session', headers: { cookie: 'webmail_sid=invalid' } }), 403, 'NO_SESSION');
  const valid = await login(f.app);
  const token = credentials(valid).cookie.split('=')[1];
  assertFailure(await f.app.inject({ url: '/api/auth/session', headers: { authorization: `Bearer ${token}` } }), 403, 'NO_SESSION');
});

test('session: invalid, missing-store and expired cookies are cleared with logout cookie options', async t => {
  const f = await fixture(t, { overrides: { SESSION_IDLE_MIN: '1' } });
  const noCookie = await f.app.inject('/api/auth/session');
  assertFailure(noCookie, 403, 'NO_SESSION');
  assert.equal(noCookie.headers['set-cookie'], undefined);
  const logged = await login(f.app);
  const headers = credentials(logged);
  f.advance(60_000);
  for (const [cookie, code] of [
    ['webmail_sid=invalid', 'NO_SESSION'],
    ['webmail_sid=', 'NO_SESSION'],
    [`webmail_sid=${'a'.repeat(43)}`, 'SESSION_EXPIRED'],
    [headers.cookie, 'SESSION_EXPIRED'],
  ]) {
    const response = await f.app.inject({ url: '/api/auth/session', headers: { cookie } });
    assertFailure(response, 403, code);
    assert.match(response.headers['set-cookie'], /^webmail_sid=;/);
    for (const attr of ['Max-Age=0', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(response.headers['set-cookie'].includes(attr));
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const renewed = await login(f.app);
  const active = await f.app.inject({ url: '/api/auth/session', headers: credentials(renewed) });
  assert.equal(active.statusCode, 200);
  assert.equal(active.headers['set-cookie'], undefined);
  const csrfFailure = await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: credentials(renewed).cookie, origin: 'https://newmail.example.com' } });
  assertFailure(csrfFailure, 403, 'CSRF');
  assert.equal(csrfFailure.headers['set-cookie'], undefined);
});

test('CSRF: missing, wrong and body-only token fail; logout requires allowed Origin', async t => {
  const f = await fixture(t);
  const response = await login(f.app);
  const headers = credentials(response);
  assertFailure(await f.app.inject({ method: 'POST', url: '/api/auth/logout' }), 403, 'NO_SESSION');
  const missing = { ...headers }; delete missing['x-webmail-csrf'];
  assertFailure(await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: missing }), 403, 'CSRF');
  assertFailure(await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, 'x-webmail-csrf': 'wrong' } }), 403, 'CSRF');
  assertFailure(await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: missing, payload: { csrf: response.json().csrf } }), 403, 'CSRF');
  assertFailure(await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, origin: 'https://other.example.com' } }), 403, 'BAD_ORIGIN');
  const noOrigin = { ...headers }; delete noOrigin.origin;
  assertFailure(await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: noOrigin }), 403, 'BAD_ORIGIN');
  const ok = await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, origin: 'https://newmail.example.org' } });
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.body, '');
});

test('registered API routes: session required and CSRF protects all four changing methods', async t => {
  const f = await fixture(t);
  f.app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], url: '/api/test-protected', handler: async () => ({ ok: true }) });
  assertFailure(await f.app.inject('/api/test-protected'), 403, 'NO_SESSION');
  const logged = await login(f.app);
  const headers = credentials(logged);
  assert.equal((await f.app.inject({ url: '/api/test-protected', headers })).statusCode, 200);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const missing = { ...headers }; delete missing['x-webmail-csrf'];
    assertFailure(await f.app.inject({ method, url: '/api/test-protected', headers: missing }), 403, 'CSRF');
    assert.equal((await f.app.inject({ method, url: '/api/test-protected', headers })).statusCode, 200);
  }
});

test('logout: closes verified connection, erases password, deletes hashed temporary attachments and expires cookie', async t => {
  const f = await fixture(t);
  const logged = await login(f.app);
  const headers = credentials(logged);
  const session = await f.app.sessions.get(headers.cookie.split('=')[1]);
  const directory = join(f.tempRoot, session.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'synthetic.txt'), 'example.com synthetic attachment');
  const response = await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers });
  assert.equal(response.statusCode, 204);
  assert.ok(response.headers['set-cookie'].includes('Max-Age=0'));
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(response.headers['set-cookie'].includes(attr));
  assert.equal(f.closes, 1);
  assert.ok(session.password.every(byte => byte === 0));
  await assert.rejects(access(directory), { code: 'ENOENT' });
  assertFailure(await f.app.inject({ url: '/api/auth/session', headers }), 403, 'SESSION_EXPIRED');
});

test('logout: cleanup failure still erases password and attachment directory', async t => {
  let password;
  const f = await fixture(t, { verifyLogin: async args => {
    password = args.password;
    return { name: '예제', connection: { async logout() { throw new Error(secret); } } };
  } });
  const logged = await login(f.app);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: credentials(logged) })).statusCode, 204);
  assert.ok(password.every(byte => byte === 0));
  assert.ok(f.logs.includes('SESSION_CLEANUP_FAILED'));
  assert.ok(!f.logs.includes(secret));
});

test('session: idle time renews on requests and expires at the configured boundary', async t => {
  const f = await fixture(t, { overrides: { SESSION_IDLE_MIN: '1' } });
  const logged = await login(f.app);
  const headers = credentials(logged);
  const originalExpiry = logged.json().expiresAt;
  f.advance(59_000);
  const renewed = await f.app.inject({ url: '/api/auth/session', headers });
  assert.equal(renewed.statusCode, 200);
  assert.ok(renewed.json().expiresAt > originalExpiry);
  f.advance(60_000);
  assertFailure(await f.app.inject({ url: '/api/auth/session', headers }), 403, 'SESSION_EXPIRED');
  assert.equal(f.closes, 1);
  assert.ok(f.calls[0].password.every(byte => byte === 0));
});

test('session: absolute lifetime expires despite recent activity', async t => {
  const f = await fixture(t, { overrides: { SESSION_MAX_HOURS: '1' } });
  const logged = await login(f.app);
  const headers = credentials(logged);
  f.advance(50 * 60_000);
  const current = await f.app.inject({ url: '/api/auth/session', headers });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().expiresAt, logged.json().expiresAt);
  f.advance(10 * 60_000);
  assertFailure(await f.app.inject({ url: '/api/auth/session', headers }), 403, 'SESSION_EXPIRED');
});

test('session: minute sweep destroys expired sessions without a new request', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t, { overrides: { SESSION_IDLE_MIN: '1' } });
  const logged = await login(f.app);
  f.advance(60_000);
  t.mock.timers.tick(60_000);
  await immediate();
  assert.ok(f.calls[0].password.every(byte => byte === 0));
  assert.equal(f.closes, 1);
  assertFailure(await f.app.inject({ url: '/api/auth/session', headers: credentials(logged) }), 403, 'SESSION_EXPIRED');
});

test('session: destroyAllFor revokes all devices of one user and preserves another', async t => {
  const f = await fixture(t);
  const first = await login(f.app);
  const second = await login(f.app);
  const other = await login(f.app, { email: 'other@example.org' });
  await f.app.sessions.destroyAllFor('user@example.com');
  for (const logged of [first, second]) assertFailure(await f.app.inject({ url: '/api/auth/session', headers: credentials(logged) }), 403, 'SESSION_EXPIRED');
  assert.equal((await f.app.inject({ url: '/api/auth/session', headers: credentials(other) })).statusCode, 200);
  assert.equal(f.closes, 2);
  assert.ok(f.calls[0].password.every(byte => byte === 0));
  assert.ok(f.calls[1].password.every(byte => byte === 0));
  assert.equal(f.calls[2].password.toString(), secret);
});

test('session: relogin rotates cookie and destroys old connection', async t => {
  const f = await fixture(t);
  const first = await login(f.app);
  const second = await login(f.app, { headers: credentials(first) });
  assert.equal(second.statusCode, 200);
  assert.equal(f.closes, 1);
  assert.ok(f.calls[0].password.every(byte => byte === 0));
  assertFailure(await f.app.inject({ url: '/api/auth/session', headers: credentials(first) }), 403, 'SESSION_EXPIRED');
});

test('session: shutdown clears secrets and a new process store rejects old cookies', async t => {
  const f = await fixture(t);
  const first = await login(f.app);
  await f.app.close();
  assert.ok(f.calls[0].password.every(byte => byte === 0));
  assert.equal(f.closes, 1);
  const fresh = await fixture(t);
  assertFailure(await fresh.app.inject({ url: '/api/auth/session', headers: credentials(first) }), 403, 'SESSION_EXPIRED');
});

test('rate limit: sixth IP failure blocked across different email addresses; another IP can log in', async t => {
  const f = await fixture(t, { verifyLogin: async ({ email }) => {
    if (email !== 'good@example.com') throw Object.assign(new Error(secret), { code: 'AUTH_FAILED' });
    return { name: '예제', connection: { async logout() {} } };
  } });
  for (let i = 0; i < 5; i++) assertFailure(await login(f.app, { email: `user${i}@example.com` }), 403, 'AUTH_FAILED');
  const blocked = await login(f.app, { email: 'good@example.com' });
  assertFailure(blocked, 429, 'RATE_LIMITED');
  assert.equal(blocked.headers['retry-after'], '900');
  assert.equal(f.calls.length, 5);
  assert.equal((await login(f.app, { email: 'good@example.com', remoteAddress: '198.51.100.10' })).statusCode, 200);
  f.advance(15 * 60_000);
  assert.equal((await login(f.app, { email: 'good@example.com' })).statusCode, 200);
});

test('rate limit: sixth email failure blocked across different IPs', async t => {
  const f = await fixture(t, { verifyLogin: async () => { throw Object.assign(new Error(secret), { code: 'AUTH_FAILED' }); } });
  for (let i = 1; i <= 5; i++) assertFailure(await login(f.app, { remoteAddress: `198.51.100.${i}` }), 403, 'AUTH_FAILED');
  const response = await login(f.app, { remoteAddress: '198.51.100.6' });
  assertFailure(response, 429, 'RATE_LIMITED');
  assert.equal(response.headers['retry-after'], '900');
  assert.equal(f.calls.length, 5);
});

test('rate limit: corrected XFF IP isolates clients and forged left entries cannot bypass block', async t => {
  const f = await fixture(t, { verifyLogin: async () => { throw Object.assign(new Error(secret), { code: 'AUTH_FAILED' }); } });
  for (let i = 0; i < 5; i++) assertFailure(await login(f.app, { email: `user${i}@example.com`, remoteAddress: '172.22.1.2', headers: { 'x-forwarded-for': `203.0.113.${i},198.51.100.9,192.0.2.10` } }), 403, 'AUTH_FAILED');
  assertFailure(await login(f.app, { email: 'fresh@example.com', remoteAddress: '172.22.1.2', headers: { 'x-forwarded-for': '203.0.113.99,198.51.100.9,192.0.2.10' } }), 429, 'RATE_LIMITED');
  assertFailure(await login(f.app, { email: 'fresh@example.com', remoteAddress: '172.22.1.2', headers: { 'x-forwarded-for': '198.51.100.10,192.0.2.10' } }), 403, 'AUTH_FAILED');
  assert.equal(f.calls.length, 6);
});

test('rate limit: IP 10-minute and email 15-minute sliding windows and password 5/hour policy', () => {
  let time = 0;
  const limiter = createRateLimiter({ now: () => time });
  for (let i = 0; i < 4; i++) limiter.recordFailure('198.51.100.9', `user${i}@example.com`);
  time = 10 * 60_000;
  limiter.recordFailure('198.51.100.9', 'new@example.com');
  assert.doesNotThrow(() => limiter.checkLogin('198.51.100.9', 'new@example.com'));
  time = 0;
  for (let i = 0; i < 4; i++) limiter.recordFailure(`192.0.2.${i}`, 'mailbox@example.com');
  time = 14 * 60_000;
  limiter.recordFailure('192.0.2.99', 'mailbox@example.com');
  assert.throws(() => limiter.checkLogin('203.0.113.1', 'mailbox@example.com'), { statusCode: 429 });
  for (let i = 0; i < 5; i++) limiter.checkPassword('password@example.com');
  assert.throws(() => limiter.checkPassword('password@example.com'), error => error.statusCode === 429 && error.retryAfter === 3600);
  assert.doesNotThrow(() => limiter.checkPassword('other@example.com'));
  time += 60 * 60_000;
  limiter.sweep();
  assert.doesNotThrow(() => limiter.checkPassword('password@example.com'));
});

test('password change limiter: sixth attempt returns common 429 Retry-After contract', async t => {
  const f = await fixture(t);
  f.app.post('/api/test-password-limit', async request => {
    f.app.rateLimiter.checkPassword(request.session.email);
    return { ok: true };
  });
  const logged = await login(f.app);
  const headers = credentials(logged);
  for (let i = 0; i < 5; i++) assert.equal((await f.app.inject({ method: 'POST', url: '/api/test-password-limit', headers })).statusCode, 200);
  const limited = await f.app.inject({ method: 'POST', url: '/api/test-password-limit', headers });
  assertFailure(limited, 429, 'RATE_LIMITED');
  assert.equal(limited.headers['retry-after'], '3600');
});

test('logs: all collected auth logs contain zero test-password occurrences', () => {
  assert.ok(allLogs.length > 0);
  assert.equal(allLogs.join('').split(secret).length - 1, 0);
});
