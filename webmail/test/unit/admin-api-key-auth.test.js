import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import { installAdminGuard } from '../../server/admin/guard.js';
import { createApiKeyRateLimiter } from '../../server/admin/api-key-ratelimit.js';
import { createApiKeyStore } from '../../server/admin/api-keys.js';
import { AppError, installErrors } from '../../server/errors.js';
import { installClientIp, installHeaders } from '../../server/security/headers.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';

const token = `mak_v1_${'A'.repeat(43)}`;
const header = { 'x-mailadmin-api-key': token };
const ip = '198.51.100.8';
async function fixture(t, { permission = 'full', configured = true, store, state = 'ready' } = {}) {
  let clock = Date.UTC(2026, 9, 21), logs = '';
  const calls = [], options = {};
  const item = { id: 'synthetic-id', name: 'synthetic-name', permission };
  const apiKeys = store ?? {
    async authenticate(raw, address) { calls.push(['authenticate', address]); if (options.authenticate) return options.authenticate(raw, address); return raw === token ? { ok: true, item } : { ok: false, reason: 'UNKNOWN_KEY' }; },
    async recordUse(id, address) { calls.push(['recordUse', id, address]); if (options.useError) throw options.useError; },
  };
  const sessions = {
    async get() { calls.push(['session']); return { state, csrf: 'synthetic-csrf', username: 'human', mailcow: {} }; },
    async destroy() { calls.push(['destroy']); },
  };
  const client = {
    createApiContext(value) { calls.push(['context', value]); return Object.freeze({ context: true }); },
    async call(context, method, path) { calls.push(['call', context, method, path]); if (options.callError) throw options.callError; return options.version ?? { version: 'synthetic' }; },
  };
  const app = Fastify({ trustProxy: ['192.0.2.0/24'], logger: { level: 'warn', stream: new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } }) }, logController: new LogController({ disableRequestLogging: true }) });
  installErrors(app); installHeaders(app); installClientIp(app);
  await app.register(cookie);
  const limiter = createApiKeyRateLimiter({ now: () => clock });
  installAdminGuard(app, { config: { adminHostname: 'mailadmin.example.test', mailcowApiKey: configured ? 'synthetic-upstream-key' : '' }, sessions, client, apiKeys, apiKeyRateLimiter: limiter });
  const handled = request => { calls.push(['handled']); return { principal: request.adminPrincipal, session: request.session }; };
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) app.route({ method, url: '/api/admin/resource/:id', config: { adminMailcowApi: true }, handler: handled });
  app.get('/api/admin/local', handled);
  for (const path of ['/api/admin/auth/login', '/api/admin/auth/totp', '/api/admin/auth/logout', '/api/admin/api-keys', '/api/admin/api-keys/:id']) {
    app.post(path, handled); app.get(path, handled); app.delete(path, handled);
  }
  app.get('/api/admin/auth/session', handled);
  app.get('/healthz', async () => ({ ok: true }));
  t.after(() => app.close());
  const inject = ({ headers = header, url = '/api/admin/resource/item', method = 'GET', ...rest } = {}) => app.inject({ method, url, headers, remoteAddress: ip, ...rest });
  return { app, inject, calls, options, limiter, advance: ms => { clock += ms; }, get logs() { return logs; } };
}
function failure(response, status = 403, code = 'API_KEY_FORBIDDEN') {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.headers['www-authenticate'], undefined);
  if (response.body) { assert.equal(response.json().error.code, code); assert.equal(response.json().error.reason, undefined); }
}
const count = (f, name) => f.calls.filter(call => call[0] === name).length;

test('API guard: substitutes a stable key actor without reading or destroying cookies', async t => {
  const f = await fixture(t);
  const response = await f.inject({ headers: { ...header, cookie: 'mailadmin_sid=synthetic-cookie', origin: 'https://outside.example.test' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().principal, { type: 'apiKey', id: 'synthetic-id', name: 'synthetic-name', permission: 'full' });
  assert.deepEqual(response.json().session, { id: 'apikey:synthetic-id', username: 'API 키: synthetic-name', state: 'ready', mailcow: { context: true } });
  assert.equal((await f.inject()).json().session.id, response.json().session.id);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(count(f, 'session'), 0); assert.equal(count(f, 'destroy'), 0); assert.equal(count(f, 'call'), 0);
  assert.deepEqual(f.calls[0], ['authenticate', ip]); assert.deepEqual(f.calls[1], ['recordUse', 'synthetic-id', ip]);
});
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) test(`API guard: full ${method} accepts JSON without Origin or CSRF and probes before execution`, async t => {
  const f = await fixture(t); const response = await f.inject({ method, payload: {} });
  assert.equal(response.statusCode, 200, response.body); assert.equal(count(f, 'session'), 0);
  assert.equal(f.calls.at(-2)[3], '/api/v1/get/status/version'); assert.equal(f.calls.at(-1)[0], 'handled');
});
for (const permission of ['read', 'full']) for (const method of ['HEAD', 'OPTIONS', ...(permission === 'read' ? ['POST', 'PUT', 'PATCH', 'DELETE'] : [])]) test(`API guard: ${permission} rejects ${method}`, async t => {
  const f = await fixture(t, { permission });
  failure(await f.inject({ method, ...(method === 'HEAD' || method === 'OPTIONS' ? {} : { payload: {} }) }));
  assert.equal(count(f, 'recordUse'), 0); assert.equal(count(f, 'handled'), 0); assert.equal(count(f, 'call'), 0);
});
for (const reason of ['UNKNOWN_KEY', 'REVOKED', 'EXPIRED', 'IP_DENIED']) test(`API guard: ${reason} returns the same 403 with no human fallback or secret logs`, async t => {
  const f = await fixture(t);
  f.options.authenticate = async () => ({ ok: false, reason });
  const response = await f.inject({ method: 'POST', headers: { ...header, cookie: 'mailadmin_sid=synthetic-cookie' }, payload: { username: 'synthetic-private-name', token } });
  failure(response); assert.deepEqual(response.json(), { error: { code: 'API_KEY_FORBIDDEN', message: 'API 키로 접근할 수 없어요.' } });
  assert.equal(count(f, 'session'), 0); assert.equal(count(f, 'handled'), 0); assert.equal(count(f, 'recordUse'), 0);
  assert.match(f.logs, new RegExp(reason)); assert.match(f.logs, /requestId/); assert.match(f.logs, /\/api\/admin\/resource\/:id/);
  for (const value of [token, 'synthetic-private-name', 'synthetic-cookie']) assert.ok(!f.logs.includes(value));
});
for (const raw of ['', 'bad', `mak_v1_${'A'.repeat(44)}`, 'A'.repeat(1000), [token, token]]) test(`API guard: malformed or repeated header ${JSON.stringify(raw).slice(0, 25)} is forbidden`, async t => {
  const f = await fixture(t);
  failure(await f.inject({ headers: { 'x-mailadmin-api-key': raw, cookie: 'mailadmin_sid=synthetic-cookie' } }));
  assert.equal(count(f, 'authenticate'), 0); assert.equal(count(f, 'session'), 0);
});
for (const path of ['/api/admin/auth/login', '/api/admin/auth/session', '/api/admin/auth/totp', '/api/admin/auth/logout', '/api/admin/api-keys', '/api/admin/api-keys/synthetic', '/api/admin/%61uth/session']) test(`API guard: human-only ${path} rejects keys even with a cookie`, async t => {
  const f = await fixture(t);
  failure(await f.inject({ url: path, headers: { ...header, cookie: 'mailadmin_sid=synthetic-cookie' } }));
  assert.equal(count(f, 'authenticate'), 0); assert.equal(count(f, 'session'), 0); assert.equal(count(f, 'handled'), 0);
});
test('API guard: human-only POST cannot use valid Origin and CSRF to fall back', async t => {
  const f = await fixture(t);
  failure(await f.inject({ url: '/api/admin/api-keys', method: 'POST', headers: { ...header, origin: 'https://mailadmin.example.test', 'x-mailadmin-csrf': 'synthetic-csrf', cookie: 'mailadmin_sid=synthetic-cookie' }, payload: {} }));
  assert.equal(count(f, 'session'), 0);
});
test('API guard: key candidates still require JSON before parsing', async t => {
  const f = await fixture(t);
  failure(await f.inject({ method: 'POST', headers: { ...header, 'content-type': 'text/plain' }, payload: 'synthetic' }), 415, 'JSON_REQUIRED');
  assert.equal(count(f, 'handled'), 0);
});
test('API guard: local GET probes upstream, store and upstream failures never clear human session', async t => {
  const f = await fixture(t);
  assert.equal((await f.inject({ url: '/api/admin/local' })).statusCode, 200); assert.equal(count(f, 'call'), 1);
  for (const error of [new AppError(503, 'MAILCOW_API_UNAVAILABLE', '연결 실패'), new MailcowAuthLost()]) {
    f.options.callError = error;
    const response = await f.inject({ url: '/api/admin/local', headers: { ...header, cookie: 'mailadmin_sid=synthetic-cookie' } });
    failure(response, error.statusCode, error.code); assert.equal(response.headers['set-cookie'], undefined);
  }
  f.options.callError = undefined;
  f.options.useError = new AppError(503, 'API_KEY_STORE_UNAVAILABLE', '저장 실패');
  failure(await f.inject(), 503, 'API_KEY_STORE_UNAVAILABLE');
  f.options.useError = Object.assign(new AppError(403, 'API_KEY_FORBIDDEN', 'API 키로 접근할 수 없어요.'), { reason: 'REVOKED' });
  failure(await f.inject());
  f.options.useError = Object.assign(new AppError(503, 'API_KEY_STORE_UNAVAILABLE', '저장 실패'), { reason: 'synthetic-private-reason' });
  failure(await f.inject(), 503, 'API_KEY_STORE_UNAVAILABLE');
  assert.ok(!f.logs.includes('synthetic-private-reason'));
  assert.equal(count(f, 'destroy'), 0); assert.equal(count(f, 'session'), 0); assert.equal(count(f, 'handled'), 1);
});
test('API guard: disabled API configuration leaves human access available', async t => {
  const f = await fixture(t, { configured: false });
  failure(await f.inject(), 503, 'MAILCOW_API_UNAVAILABLE');
  assert.equal((await f.inject({ headers: { cookie: 'mailadmin_sid=synthetic-cookie' } })).statusCode, 200);
  assert.equal(count(f, 'session'), 1);
});
test('API guard: header outside registered admin routes has no authentication effect', async t => {
  const f = await fixture(t);
  assert.equal((await f.inject({ url: '/healthz' })).statusCode, 200);
  failure(await f.inject({ url: '/api/admin/api-keys/' }));
  for (const url of ['/api/admin/missing', '/api/admin/auth/session/', '/api/admin/resource/item/']) assert.equal((await f.inject({ url })).statusCode, 404, url);
  assert.equal(count(f, 'authenticate'), 0); assert.equal(count(f, 'recordUse'), 0);
});
test('API guard: key is accepted only in the custom header', async t => {
  const f = await fixture(t, { state: 'totp' });
  failure(await f.inject({ url: `/api/admin/resource/item?key=${token}`, headers: { cookie: `key=${token}` } }), 403, 'NO_SESSION');
  assert.equal(count(f, 'authenticate'), 0); assert.equal(count(f, 'handled'), 0);
});
test('API guard: untrusted XFF cannot bypass stored allowed IP, expiry or revocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'admin-api-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 9, 21);
  const store = createApiKeyStore({ directory, now: () => clock });
  const { item, token: stored } = await store.create({ name: 'synthetic-ip-key', permission: 'read', allowedIps: ['203.0.113.0/24'], expiresAt: new Date(clock + 1000).toISOString() }, 'synthetic-admin', { id: store.allocateId() });
  const f = await fixture(t, { store }); const headers = { 'x-mailadmin-api-key': stored, 'x-forwarded-for': '203.0.113.9' };
  failure(await f.inject({ headers }));
  assert.equal((await f.inject({ headers, remoteAddress: '192.0.2.8' })).statusCode, 200);
  assert.equal((await store.get(item.id)).lastUsedIp, '203.0.113.9');
  clock += 1000;
  failure(await f.inject({ headers, remoteAddress: '192.0.2.8' }));
  clock -= 1000; await store.revoke(item.id);
  failure(await f.inject({ headers, remoteAddress: '192.0.2.8' }));
  assert.equal(count(f, 'handled'), 1);
});
test('API guard: failure reservations block concurrent authentication and return Retry-After', async t => {
  const f = await fixture(t);
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  f.options.authenticate = async () => { await wait; return { ok: false, reason: 'UNKNOWN_KEY' }; };
  const requests = Array.from({ length: 5 }, () => f.inject());
  while (count(f, 'authenticate') < 5) await new Promise(resolve => setImmediate(resolve));
  const response = await f.inject(); failure(response, 429, 'RATE_LIMITED');
  assert.equal(response.headers['retry-after'], '300'); assert.equal(response.json().error.retryAfter, 300);
  finish(); for (const response of await Promise.all(requests)) failure(response);
});
test('API guard: valid key limit returns Retry-After, expires and does not use the human limiter', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 120; i++) assert.equal((await f.inject()).statusCode, 200);
  const response = await f.inject(); failure(response, 429, 'RATE_LIMITED');
  assert.equal(response.headers['retry-after'], '60'); assert.equal(response.json().error.retryAfter, 60);
  assert.equal(count(f, 'handled'), 120);
  f.advance(60_000); assert.equal((await f.inject()).statusCode, 200);
});

test('API limiter: IP total and key budgets reserve synchronously with independent windows', () => {
  let clock = 0;
  const limiter = createApiKeyRateLimiter({ now: () => clock });
  for (let i = 0; i < 300; i++) limiter.reserveIp(ip)();
  assert.throws(() => limiter.reserveIp(ip), { statusCode: 429, retryAfter: 60 });
  for (let i = 0; i < 120; i++) limiter.reserveKey('synthetic-id');
  assert.throws(() => limiter.reserveKey('synthetic-id'), { statusCode: 429, retryAfter: 60 });
  limiter.reserveKey('synthetic-other'); limiter.reserveIp('203.0.113.1')();
  clock = 59_999; assert.throws(() => limiter.reserveKey('synthetic-id'), { retryAfter: 1 });
  clock = 60_000; limiter.reserveKey('synthetic-id'); limiter.reserveIp(ip)();
});
test('API limiter: failure namespace, release, exact unblock and ten-minute expiry', () => {
  let clock = 0;
  const limiter = createApiKeyRateLimiter({ now: () => clock });
  const reservations = Array.from({ length: 5 }, () => limiter.reserveIp(ip));
  assert.throws(() => limiter.reserveIp(ip), { statusCode: 429, retryAfter: 300 });
  reservations[0](); reservations[0](); limiter.reserveIp(ip)();
  limiter.reserveIp(ip);
  clock = 299_999; assert.throws(() => limiter.reserveIp(ip), { retryAfter: 1 });
  clock = 300_000; limiter.reserveIp(ip);
  clock = 900_000; limiter.sweep(); limiter.reserveIp(ip)();
});
test('API limiter: IP and authenticated-id maps reject new entries at capacity and sweep expired entries', () => {
  let clock = 0;
  const limiter = createApiKeyRateLimiter({ now: () => clock, maxEntries: 2 });
  limiter.reserveIp('192.0.2.1')(); limiter.reserveIp('192.0.2.2')();
  assert.throws(() => limiter.reserveIp('192.0.2.3'), { statusCode: 429 });
  limiter.reserveKey('one'); limiter.reserveKey('two');
  assert.throws(() => limiter.reserveKey('three'), { statusCode: 429 });
  limiter.reserveIp('192.0.2.1')(); limiter.reserveKey('one');
  clock = 60_000; limiter.sweep(); limiter.reserveIp('192.0.2.3')(); limiter.reserveKey('three');
});
