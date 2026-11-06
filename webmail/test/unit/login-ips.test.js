import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLoginIp, loginIpInput, createLoginIpStore } from '../../server/security/login-ip-store.js';
import { createRateLimiter } from '../../server/security/ratelimit.js';
import { createAdminApp } from '../../server/admin/app.js';

function database() {
  const rows = new Map(), sql = [];
  let snapshot, broken = false, rolledBack = 0, released = 0;
  const connection = {
    async query(text) { sql.push(text); },
    async beginTransaction() { snapshot = structuredClone(rows); },
    async commit() { snapshot = undefined; },
    async rollback() { rolledBack++; if (snapshot) { rows.clear(); for (const [k, v] of snapshot) rows.set(k, v); } },
    release() { released++; },
    async execute(text, args = []) {
      sql.push(text);
      if (broken) throw Object.assign(new Error('synthetic database failure'), { code: 'ECONNREFUSED' });
      if (text.startsWith('SELECT')) return [[...rows.values()].map(row => ({ ...row }))];
      if (text.startsWith('INSERT')) { rows.set(args[0], { ip: args[0], note: args[1], actor: args[2], date: '2026-11-06 00:00:00.000000' }); return [{}]; }
      if (text.startsWith('DELETE')) { rows.delete(args[0]); return [{}]; }
      throw new Error('Unexpected synthetic SQL');
    },
  };
  return { rows, sql, db: { execute: connection.execute, async getConnection() { return connection; } },
    fail(value) { broken = value; }, get rolledBack() { return rolledBack; }, get released() { return released; } };
}

test('login IP input normalizes addresses, network bits and equivalent spellings', () => {
  for (const [raw, expected] of [
    [' 192.0.2.10/32 ', '192.0.2.10'], ['192.0.2.129/24', '192.0.2.0/24'],
    ['2001:0DB8:0:0:0:0:0:1', '2001:db8::1'], ['2001:db8:1:ffff::1/48', '2001:db8:1::/48'],
    ['::ffff:192.0.2.10', '192.0.2.10'], ['::ffff:192.0.2.129/120', '192.0.2.0/24'],
  ]) assert.equal(normalizeLoginIp(raw), expected);
  for (const value of ['', null, 42, '*', 'example.test', '192.0.2.256', '192.0.2.1/33', '192.0.2.1/-1',
    '192.0.2.1/1.5', '192.0.2.1/', '192.0.2.1/24/1', '192.0.2.1,192.0.2.2', '2001:db8::/129', 'fe80::1%eth0']) {
    assert.throws(() => normalizeLoginIp(value), { statusCode: 422 });
  }
  assert.deepEqual(loginIpInput({ ip: '192.0.2.1' }), { ip: '192.0.2.1', note: '' });
  for (const data of [null, [], { ip: '192.0.2.1', extra: true }, { ip: '192.0.2.1', note: 'x'.repeat(201) },
    { ip: '192.0.2.1', note: 'line\nbreak' }, { ip: '192.0.2.1', note: 42 }]) assert.throws(() => loginIpInput(data), { statusCode: 422 });
});

test('login IP ranges enforce IPv4 /16 and IPv6 /48 minimum prefixes after normalization', () => {
  for (const value of ['192.0.2.1/15', '2001:db8::/47', '0.0.0.0/0', '::ffff:192.0.2.1/111']) {
    assert.throws(() => normalizeLoginIp(value), error => error.statusCode === 422 && error.code === 'INVALID_INPUT' && /너무 넓은.*IPv4.*\/16.*IPv6.*\/48/.test(error.message));
  }
  for (const value of ['192.0.2.1/16', '192.0.2.1/17', '192.0.2.1', '2001:db8::/48', '2001:db8::/49', '2001:db8::1', '::ffff:192.0.2.1/112']) {
    assert.doesNotThrow(() => normalizeLoginIp(value));
  }
  assert.equal(normalizeLoginIp('0.0.0.0/0', { allowWide: true }), '0.0.0.0/0');
  assert.equal(normalizeLoginIp('::/0', { allowWide: true }), '::/0');
});

test('mapped overlap regression matrix validates registration and enforces family-specific 30-failure boundaries', async t => {
  const clients = ['192.0.2.1', '198.51.100.1', '2001:db8::1', '::ffff:192.0.2.1'];
  const cases = [
    ['::ffff:0:0/95', 422, null, []],
    ['::/48', 422, null, []],
    ['::/0', 422, null, []],
    ['::ffff:0:0/96', 422, null, []],
    ['::ffff:c000:200/120', 200, '192.0.2.0/24', [clients[0], clients[3]]],
    ['2001:db8::/48', 200, '2001:db8::/48', [clients[2]]],
  ];
  for (const [rule, status, normalized, exempt] of cases) await t.test(rule, async () => {
    const f = database(), admin = createLoginIpStore({ db: f.db, mode: 'admin' });
    if (status === 422) {
      await assert.rejects(admin.change({ data: { ip: rule }, actor: 'synthetic-admin' }), error =>
        error.statusCode === 422 && error.code === 'INVALID_INPUT' &&
        (rule === '::ffff:0:0/96' ? /너무 넓은/.test(error.message) : /IPv4 대역은 IPv4 표기로/.test(error.message)));
    } else {
      await admin.change({ data: { ip: rule }, actor: 'synthetic-admin' });
      assert.equal([...f.rows.keys()][0], normalized);
    }
    // Reproduce legacy DB rows even when current registration rejects the rule.
    f.rows.clear(); f.rows.set(rule, { ip: rule, date: '2026-11-06 00:00:00.000000' });
    const reader = createLoginIpStore({ db: f.db }), results = {};
    for (const client of clients) {
      const warnings = [], limiter = createRateLimiter({ readLoginIps: () => reader.list(), logger: { warn(...args) { warnings.push(args); } } });
      await limiter.refreshLoginIps();
      for (let i = 0; i < 30; i++) {
        assert.doesNotThrow(() => limiter.checkLogin(client, `user${i}@example.test`));
        limiter.recordFailure(client, `user${i}@example.test`);
      }
      if (exempt.includes(client)) {
        for (let i = 30; i < 35; i++) {
          assert.doesNotThrow(() => limiter.checkLogin(client, `user${i}@example.test`));
          limiter.recordFailure(client, `user${i}@example.test`);
        }
        assert.doesNotThrow(() => limiter.checkLogin(client, 'fresh@example.test'));
        results[client] = 'exempt after 35 failures';
      } else {
        assert.throws(() => limiter.checkLogin(client, 'fresh@example.test'), { statusCode: 429 });
        results[client] = 'blocked on attempt 31';
      }
      assert.equal(warnings.length, status === 422 ? 1 : 0);
      if (warnings.length) {
        assert.deepEqual(warnings[0][0], { code: 'LOGIN_IP_RULES_IGNORED', count: 1 });
        assert.ok(!JSON.stringify(warnings).includes(rule));
      }
    }
    // Deletion remains possible for the normalized form of rejected legacy rows.
    const key = normalizeLoginIp(rule, { allowWide: true });
    f.rows.clear(); f.rows.set(key, { ip: key });
    await admin.change({ address: key, actor: 'synthetic-admin' });
    assert.equal(f.rows.size, 0);
    t.diagnostic(JSON.stringify({ rule, registration: status, normalized, clients: results }));
  });
});

test('webmail ignores broad rows already in the database, retains valid rows and logs only their count', async () => {
  const f = database(), warnings = [];
  for (const ip of ['192.0.2.0/15', '2001:db8::/47', '0.0.0.0/0', '::/0', '192.0.2.10', '2001:db8:1::/48']) {
    f.rows.set(ip, { ip, date: '2026-11-06 00:00:00.000000' });
  }
  const store = createLoginIpStore({ db: f.db });
  const limiter = createRateLimiter({ readLoginIps: () => store.list(), logger: { warn(...args) { warnings.push(args); } } });
  await limiter.refreshLoginIps();
  for (const ip of ['198.51.100.1', '2001:db8:2::1']) {
    for (let i = 0; i < 30; i++) limiter.recordFailure(ip, `blocked${i}@example.test`);
    assert.throws(() => limiter.checkLogin(ip, 'fresh@example.test'), { statusCode: 429 });
  }
  for (const ip of ['192.0.2.10', '2001:db8:1::1']) {
    for (let i = 0; i < 35; i++) {
      limiter.checkLogin(ip, `allowed${i}@example.test`);
      limiter.recordFailure(ip, `allowed${i}@example.test`);
    }
  }
  await limiter.refreshLoginIps();
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0][0], { code: 'LOGIN_IP_RULES_IGNORED', count: 4 });
  for (const ip of f.rows.keys()) assert.ok(!JSON.stringify(warnings).includes(ip));
  const admin = createLoginIpStore({ db: f.db, mode: 'admin' });
  await admin.change({ address: '0.0.0.0/0', actor: 'synthetic-admin' });
  assert.equal(f.rows.has('0.0.0.0/0'), false);
});

test('login IP store permits admin writes only, rejects duplicates and enforces 100 within its own transaction', async () => {
  const f = database(), admin = createLoginIpStore({ db: f.db, mode: 'admin' }), reader = createLoginIpStore({ db: f.db });
  const add = ip => admin.change({ data: { ip }, actor: 'synthetic-admin' });
  await assert.rejects(reader.change({ data: { ip: '192.0.2.1' }, actor: 'synthetic-admin' }), { statusCode: 403 });
  await add('192.0.2.129/24');
  await assert.rejects(add('192.0.2.0/24'), { statusCode: 409, code: 'DUPLICATE_IP' });
  await add('192.0.2.10'); // Overlap is allowed; identical normalized rules are duplicates.
  await add('2001:0db8::1');
  await assert.rejects(add('2001:db8:0:0:0:0:0:1'), { statusCode: 409 });
  for (let i = 0; i < 97; i++) await add(`198.51.100.${i}`);
  assert.equal((await reader.list()).items.length, 100);
  await assert.rejects(add('203.0.113.1'), { statusCode: 422, code: 'LOGIN_IP_LIMIT' });
  assert.equal(f.rows.size, 100);
  await admin.change({ address: '192.0.2.10', actor: 'synthetic-admin' });
  await assert.rejects(admin.change({ address: '192.0.2.10', actor: 'synthetic-admin' }), { statusCode: 404 });
  await add('203.0.113.1');
  assert.ok(f.sql.some(sql => /SELECT ip .*login_ip_allowlist.*FOR UPDATE/.test(sql)));
  assert.ok(f.sql.every(sql => !sql.includes('notice_counter')));
  f.fail(true);
  await assert.rejects(reader.list(), { statusCode: 503, code: 'LOGIN_IPS_UNAVAILABLE' });
  await assert.rejects(add('203.0.113.2'), { statusCode: 503 });
  assert.ok(f.rolledBack >= 5); assert.ok(f.released > 100);
});

test('login IP cache coalesces refresh, keeps last list on failure and removes exceptions after 60 seconds', async () => {
  let now = 0, reads = 0, failed = true, items = [], finish;
  const limiter = createRateLimiter({ now: () => now, readLoginIps: async () => {
    reads++; if (failed) throw new Error('synthetic failure');
    if (finish === null) await new Promise(resolve => { finish = resolve; });
    return { items };
  } });
  await limiter.refreshLoginIps();
  for (let i = 0; i < 30; i++) limiter.recordFailure('192.0.2.1', `user${i}@example.test`);
  assert.throws(() => limiter.checkLogin('192.0.2.1', 'fresh@example.test'), { statusCode: 429 });
  await limiter.refreshLoginIps(); assert.equal(reads, 1);
  now = 60_000; failed = false; items = [{ ip: '192.0.2.0/24' }, { ip: '2001:db8::/48' }]; finish = null;
  const first = limiter.refreshLoginIps(), second = limiter.refreshLoginIps(); finish(); await Promise.all([first, second]); assert.equal(reads, 2);
  for (const ip of ['192.0.2.1', '2001:db8::1']) {
    for (let i = 0; i < 35; i++) { limiter.checkLogin(ip, `allow${i}@example.test`); limiter.recordFailure(ip, `allow${i}@example.test`); }
    assert.doesNotThrow(() => limiter.checkLogin(ip, 'fresh@example.test'));
  }
  for (let i = 0; i < 5; i++) limiter.recordFailure('192.0.2.1', 'same@example.test');
  assert.throws(() => limiter.checkLogin('192.0.2.1', 'same@example.test'), { statusCode: 429 });
  now += 60_000; failed = true; await limiter.refreshLoginIps();
  assert.doesNotThrow(() => limiter.checkLogin('192.0.2.1', 'fresh@example.test'));
  now += 59_999; await limiter.refreshLoginIps(); assert.equal(reads, 3);
  now++; failed = false; items = []; await limiter.refreshLoginIps(); assert.equal(reads, 4);
  assert.throws(() => limiter.checkLogin('192.0.2.1', 'fresh@example.test'), { statusCode: 429 });
  for (let i = 0; i < 5; i++) limiter.checkPassword('same@example.test');
  assert.throws(() => limiter.checkPassword('same@example.test'), { statusCode: 429 });
});

async function httpFixture(t) {
  const f = database(), dir = await mkdtemp(join(tmpdir(), 'login-ips-admin-'));
  const client = { async login({ username }) { return { state: 'ready', username }; }, async logout() {},
    createApiContext() { return {}; }, async call(_session, _method, path) {
      if (path === '/api/v1/get/status/version') return { version: 'synthetic' };
      return [];
    } };
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.test', publicHostnames: ['newmail.example.test'],
    sessionIdleMin: 60, sessionMaxHours: 8, trustProxy: ['127.0.0.0/8'], logLevel: 'silent', auditDir: join(dir, 'audit'),
    apiKeyDir: join(dir, 'keys'), mailcowApiKey: 'synthetic-upstream-key' }, logger: false, staticDir: '/nonexistent-login-ips',
    auth: { client }, loginIps: { store: createLoginIpStore({ db: f.db, mode: 'admin' }) } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = 'https://mailadmin.example.test';
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin }, payload: { username: 'admin', password: 'synthetic' } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { origin, cookie: login.headers['set-cookie'].split(';')[0], 'x-mailadmin-csrf': login.json().csrf };
  const request = (method, path = '', payload, extra = {}) => app.inject({ method, url: `/api/admin/login-ips${path}`, headers: { ...headers, ...extra }, ...(payload === undefined ? {} : { payload }) });
  return { ...f, app, request, origin };
}

test('login IP admin API requires session/CSRF, validates input, records audit and enforces read/full API keys', async t => {
  const f = await httpFixture(t);
  const noSession = await f.app.inject('/api/admin/login-ips'); assert.equal(noSession.statusCode, 403);
  assert.equal(noSession.headers['www-authenticate'], undefined);
  assert.equal((await f.request('POST', '', { ip: '192.0.2.10' }, { 'x-mailadmin-csrf': '' })).statusCode, 403);
  assert.equal((await f.request('POST', '', { ip: '192.0.2.10' }, { origin: 'https://foreign.example.test' })).statusCode, 403);
  assert.equal((await f.request('POST', '', { ip: '*' })).statusCode, 422);
  for (const ip of ['192.0.2.1/15', '2001:db8::/47', '0.0.0.0/0', '::/0']) {
    const response = await f.request('POST', '', { ip });
    assert.equal(response.statusCode, 422); assert.match(response.json().error.message, ip === '::/0' ? /IPv4 대역은 IPv4 표기로/ : /너무 넓은/);
  }
  f.rows.set('::/0', { ip: '::/0', date: '2026-11-06 00:00:00.000000' });
  assert.equal((await f.request('DELETE', `/${encodeURIComponent('::/0')}`, {})).statusCode, 200);
  assert.equal(f.rows.has('::/0'), false);

  assert.equal((await f.request('POST', '', { ip: '192.0.2.10', note: '합성 예외' })).statusCode, 200);
  assert.equal((await f.request('POST', '', { ip: '192.0.2.10/32' })).statusCode, 409);
  assert.equal((await f.request('GET')).json().items[0].actor, 'admin');
  assert.equal((await f.request('DELETE', '/192.0.2.10', {})).statusCode, 200);
  assert.equal((await f.request('GET')).json().items.length, 0);
  const history = await f.app.audit.read();
  for (const action of ['login-ip.create', 'login-ip.delete']) assert.ok(history.rows.some(row => row.action === action && row.target === '192.0.2.10'));
  assert.ok(history.rows.some(row => row.phase === 'result' && row.result === 'ok'));
  for (const permission of ['read', 'full']) {
    const issued = await f.app.apiKeys.create({ name: `synthetic-${permission}`, permission, allowedIps: [], expiresAt: null }, 'admin', { id: f.app.apiKeys.allocateId() });
    const keyHeaders = { 'x-mailadmin-api-key': issued.token };
    const get = await f.app.inject({ url: '/api/admin/login-ips', headers: keyHeaders }); assert.equal(get.statusCode, 200, get.body);
    const post = await f.app.inject({ method: 'POST', url: '/api/admin/login-ips', headers: keyHeaders, payload: { ip: '2001:db8::1' } });
    assert.equal(post.statusCode, permission === 'read' ? 403 : 200, post.body);
    const remove = await f.app.inject({ method: 'DELETE', url: `/api/admin/login-ips/${encodeURIComponent('2001:db8::1')}`, headers: keyHeaders, payload: {} });
    assert.equal(remove.statusCode, permission === 'read' ? 403 : 200, remove.body);
  }
  for (let i = 0; i < 100; i++) f.rows.set(`198.51.100.${i}`, { ip: `198.51.100.${i}` });
  const full = await f.request('POST', '', { ip: '203.0.113.1' }); assert.equal(full.statusCode, 422); assert.equal(full.json().error.code, 'LOGIN_IP_LIMIT');
});
