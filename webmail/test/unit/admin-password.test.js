import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';
import { logOptions } from '../../server/log.js';

const origin = 'https://mailadmin.example.test', ip = '198.51.100.9';
const input = { currentPassword: 'synthetic-current-private', password: 'synthetic-new-private', password2: 'synthetic-new-private' };
async function fixture(t, { auditFs } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'admin-password-'));
  let now = Date.UTC(2026, 10, 8), logs = '';
  const calls = [], options = { detail: { active: 1, attributes: { force_tfa: 0, force_pw_update: 0 } }, state: 'ready' };
  const client = {
    async login(args) {
      calls.push({ kind: 'login', ...args });
      if (options.waitLogin) await options.waitLogin;
      if (options.loginError) throw options.loginError();
      return { username: args.username, state: options.state, temporary: true };
    },
    async call(session, method, path, body) {
      calls.push({ kind: 'call', session, method, path, body });
      if (path === '/api/v1/get/status/version') return { version: 'synthetic' };
      if (path.startsWith('/api/v1/get/admin/')) return options.detail;
      if (path === '/api/v1/edit/admin') {
        if (options.editError) throw options.editError();
        return [{ type: 'success', msg: 'admin_modified' }];
      }
      return {};
    },
    async logout(session) { calls.push({ kind: 'logout', session }); if (options.logoutError && !session.temporary) throw new Error('synthetic-logout-failure'); },
    async totp() { calls.push({ kind: 'totp' }); },
  };
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.test', sessionIdleMin: 60, sessionMaxHours: 8,
    trustProxy: ['192.0.2.0/24'], mailcowApiKey: 'synthetic-upstream', apiKeyDir: join(dir, 'keys'), auditDir: join(dir, 'audit') },
    logger: { ...logOptions('info'), stream: new Writable({ write(chunk, _encoding, done) { logs += chunk; done(); } }) },
    staticDir: join(dir, 'static'), auth: { client, now: () => now }, audit: auditFs ? { fs: auditFs } : {} });
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const add = (username = 'admin', state = 'ready') => {
    const mailcow = { username, state }, { token, session } = app.adminSessions.create(mailcow);
    return { token, session, headers: { origin, cookie: `mailadmin_sid=${token}`, 'x-mailadmin-csrf': session.csrf } };
  };
  const current = add();
  const write = (payload = input, headers = current.headers, address = ip) => app.inject({ method: 'POST', url: '/api/admin/auth/password', remoteAddress: address, headers, payload: { ...payload } });
  const alive = item => app.inject({ url: '/api/admin/auth/session', headers: item.headers });
  return { app, calls, options, current, add, write, alive, advance(ms) { now += ms; }, get logs() { return logs; } };
}
const edits = f => f.calls.filter(row => row.path === '/api/v1/edit/admin');
const logins = f => f.calls.filter(row => row.kind === 'login');
function failure(response, status, code) { assert.equal(response.statusCode, status, response.body); assert.equal(response.json().error.code, code); assert.equal(response.headers['www-authenticate'], undefined); }

test('password: isolated recheck, original editing context, preserved flags and credential audit', async t => {
  const f = await fixture(t); const response = await f.write({ ...input, username: 'other', force_tfa: 1 });
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { ok: true });
  assert.equal(logins(f).length, 1); assert.equal(logins(f)[0].ip, ip); assert.equal(logins(f)[0].username, 'admin');
  assert.ok(logins(f)[0].password.every(byte => byte === 0));
  assert.equal(f.calls.filter(row => row.path === '/api/v1/get/admin/admin').length, 1);
  assert.equal(edits(f).length, 1); assert.equal(edits(f)[0].session, f.current.session.mailcow);
  assert.deepEqual(edits(f)[0].body, { items: ['admin'], attr: { password: input.password, password2: input.password2, active: f.options.detail.active, ...f.options.detail.attributes } });
  assert.equal(Object.hasOwn(f.options.detail, 'force_tfa'), false); assert.equal(Object.hasOwn(f.options.detail, 'force_pw_update'), false);
  assert.equal(f.calls.filter(row => row.kind === 'logout' && row.session.temporary).length, 1);
  const { rows } = await f.app.audit.read(); assert.equal(rows.length, 2); assert.equal(rows[0].kind, 'credential'); assert.equal(rows[0].revertible, false);
  assert.equal(rows[0].actor, 'admin'); assert.equal(rows[0].target, 'admin'); assert.deepEqual(rows[0].after, { password: 'changed' });
  assert.equal(rows[0].id, rows[1].id); assert.equal(rows[1].result, 'ok'); assert.equal((await f.alive(f.current)).statusCode, 200);
  const all = await f.app.adminHistory.list(); assert.equal(all.total, 1); assert.equal(all.items[0].canRevert, false);
  assert.equal((await f.app.adminHistory.list({ filter: 'irreversible' })).total, 0);
  const recorded = f.logs + JSON.stringify(rows) + response.body;
  for (const secret of [...Object.values(input), f.current.token, f.current.session.csrf]) assert.ok(!recorded.includes(secret));
});

test('password: wrong current password keeps session, consumes budget and writes no credential audit', async t => {
  const f = await fixture(t); const other = f.add(); f.options.loginError = () => new AppError(403, 'AUTH_FAILED', 'synthetic');
  const result = await f.write(); failure(result, 403, 'AUTH_FAILED'); assert.equal(result.json().error.remainingAttempts, 4);
  assert.equal(edits(f).length, 0); assert.equal((await f.app.audit.read()).rows.length, 0);
  assert.equal((await f.alive(f.current)).statusCode, 200); assert.equal((await f.alive(other)).statusCode, 200);
  assert.ok(f.logs.includes('AUTH_FAILED')); assert.ok(!f.logs.includes(input.currentPassword));
});

test('password: TOTP challenge proves current password without verifying another OTP', async t => {
  const f = await fixture(t); f.options.state = 'totp'; assert.equal((await f.write()).statusCode, 200);
  assert.equal(f.calls.filter(row => row.kind === 'totp').length, 0);
  assert.equal(f.calls.filter(row => row.kind === 'logout' && row.session.state === 'totp').length, 1);
});

for (const a of [0, 1]) for (const b of [0, 1]) for (const strings of [false, true]) test(`password: preserves force flags ${a}/${b}, strings=${strings}`, async t => {
  const f = await fixture(t); f.options.detail = { active: strings ? '0' : 0, attributes: { force_tfa: strings ? String(a) : a, force_pw_update: strings ? String(b) : b } };
  assert.equal((await f.write()).statusCode, 200); assert.deepEqual(edits(f)[0].body.attr, { password: input.password, password2: input.password2, active: f.options.detail.active, ...f.options.detail.attributes });
});
for (const key of ['active', 'force_tfa', 'force_pw_update']) test(`password: missing ${key} prevents edit`, async t => {
  const f = await fixture(t); delete (key === 'active' ? f.options.detail : f.options.detail.attributes)[key]; failure(await f.write(), 502, 'MAILCOW_REJECTED'); assert.equal(edits(f).length, 0);
});
test('password: malformed flag detail prevents edit', async t => {
  const f = await fixture(t); for (const value of [null, [], { active: 1, attributes: { force_tfa: true, force_pw_update: 0 } }]) { f.options.detail = value; failure(await f.write(), 502, 'MAILCOW_REJECTED'); } assert.equal(edits(f).length, 0);
});

test('password: missing or malformed attributes never falls back to top-level flags', async t => {
  const f = await fixture(t);
  for (const attributes of [undefined, null, [], 'invalid', 1, {}]) {
    f.options.detail = { active: 1, force_tfa: 0, force_pw_update: 0, ...(attributes === undefined ? {} : { attributes }) };
    failure(await f.write(), 502, 'MAILCOW_REJECTED');
    assert.equal(edits(f).length, 0);
  }
});

test('password: policy rejection writes failed audit and preserves other sessions', async t => {
  const f = await fixture(t); const other = f.add();
  f.options.editError = () => Object.assign(new AppError(422, 'MAILCOW_REJECTED', 'mailcow가 요청을 거절했어요(password_complexity).'), { mailcowMessageKey: 'password_complexity' });
  const response = await f.write(); failure(response, 422, 'MAILCOW_REJECTED');
  const { rows } = await f.app.audit.read(); assert.equal(rows.length, 2); assert.equal(rows[1].result, 'failed'); assert.equal(rows[1].code, 'MAILCOW_REJECTED');
  assert.equal((await f.alive(other)).statusCode, 200); for (const value of Object.values(input)) assert.ok(!(f.logs + JSON.stringify(rows) + response.body).includes(value));
});

test('password: removes all other own sessions including TOTP, keeps current and another user', async t => {
  const f = await fixture(t), others = [f.add(), f.add(), f.add('admin', 'totp')], different = f.add('other');
  f.options.logoutError = true; assert.equal((await f.write()).statusCode, 200);
  for (const other of others) { failure(await f.alive(other), 403, 'SESSION_EXPIRED'); assert.equal(f.calls.filter(row => row.kind === 'logout' && row.session === other.session.mailcow).length, 1); }
  assert.equal((await f.alive(f.current)).statusCode, 200); assert.equal((await f.alive(different)).statusCode, 200); assert.ok(f.logs.includes('MAILCOW_LOGOUT_FAILED'));
});

test('password: queued request from a session removed by the first change cannot edit', async t => {
  const f = await fixture(t), other = f.add(); let unblock, started;
  const entered = new Promise(resolve => { started = resolve; }); f.options.waitLogin = new Promise(resolve => { unblock = resolve; });
  const originalLogin = f.app.mailcow.login; f.app.mailcow.login = async args => { started(); return originalLogin(args); };
  let queued; const waiting = new Promise(resolve => { queued = resolve; });
  const run = f.app.adminLock.run; let runs = 0; f.app.adminLock.run = (key, operation) => { if (++runs === 2) queued(); return run(key, operation); };
  const first = f.write(); await entered; const second = f.write(input, other.headers); await waiting; unblock();
  assert.equal((await first).statusCode, 200); failure(await second, 403, 'SESSION_EXPIRED'); assert.equal(edits(f).length, 1); assert.equal(logins(f).length, 1);
});

test('password: same-session concurrent requests execute one at a time', async t => {
  const f = await fixture(t); let active = 0, maximum = 0;
  const login = f.app.mailcow.login; f.app.mailcow.login = async args => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); try { return await login(args); } finally { active--; } };
  const results = await Promise.all([f.write(), f.write()]); assert.deepEqual(results.map(row => row.statusCode), [200, 200]); assert.equal(maximum, 1);
});

test('password: shares login failure limit, five attempts then five-minute block and ten-minute window', async t => {
  const f = await fixture(t); f.options.loginError = () => new AppError(403, 'AUTH_FAILED', 'synthetic');
  for (let i = 0; i < 2; i++) failure(await f.app.inject({ method: 'POST', url: '/api/admin/auth/login', remoteAddress: ip, headers: { origin }, payload: { username: 'admin', password: input.currentPassword } }), 403, 'AUTH_FAILED');
  for (let i = 0; i < 3; i++) failure(await f.write(), 403, 'AUTH_FAILED');
  const before = logins(f).length; const blocked = await f.write(); failure(blocked, 429, 'RATE_LIMITED'); assert.equal(blocked.json().error.retryAfter, 300); assert.equal(logins(f).length, before);
  f.advance(300_001); failure(await f.write(), 403, 'AUTH_FAILED');
  f.advance(600_001); const next = await f.write(); failure(next, 403, 'AUTH_FAILED'); assert.equal(next.json().error.remainingAttempts, 4);
});
for (const same of ['ip', 'username']) test(`password: ${same} alone shares failure budget`, async t => {
  const f = await fixture(t), other = f.add('other'); f.options.loginError = () => new AppError(403, 'AUTH_FAILED', 'synthetic');
  failure(await f.write(), 403, 'AUTH_FAILED'); const response = same === 'ip' ? await f.write(input, other.headers) : await f.write(input, f.current.headers, '198.51.100.10');
  assert.equal(response.json().error.remainingAttempts, 3);
});
test('password: successful rechecks and infrastructure errors release failure reservations', async t => {
  const f = await fixture(t); for (let i = 0; i < 6; i++) assert.equal((await f.write()).statusCode, 200);
  f.options.loginError = () => new AppError(503, 'MAILCOW_UNAVAILABLE', '연결 실패'); for (let i = 0; i < 6; i++) failure(await f.write(), 503, 'MAILCOW_UNAVAILABLE');
  assert.equal(f.app.adminRateLimiter.remaining(ip, 'admin'), 5);
});

for (const permission of ['full', 'read', 'full-with-cookie']) test(`password: human-only denies ${permission} API credentials before authentication`, async t => {
  const f = await fixture(t), key = `mak_v1_${'A'.repeat(43)}`;
  const created = await f.app.apiKeys.create({ name: 'synthetic', permission: permission === 'read' ? 'read' : 'full', allowedIps: [] }, 'admin', { id: f.app.apiKeys.allocateId() });
  assert.equal((await f.app.apiKeys.authenticate(created.token, ip)).ok, true);
  const headers = { ...(permission.endsWith('cookie') ? f.current.headers : {}), 'x-mailadmin-api-key': created.token ?? key };
  const response = await f.write(input, headers); failure(response, 403, 'API_KEY_FORBIDDEN'); assert.equal(logins(f).length, 0); assert.equal(edits(f).length, 0); assert.ok(f.logs.includes('HUMAN_ONLY')); assert.ok(!f.logs.includes(headers['x-mailadmin-api-key']));
});

test('password: existing authentication, origin, CSRF and JSON guards remain mandatory', async t => {
  const f = await fixture(t); const pending = f.add('pending', 'totp');
  for (const [headers, code] of [[{ origin }, 'NO_SESSION'], [pending.headers, 'NO_SESSION'], [{ ...f.current.headers, origin: 'https://other.example.test' }, 'BAD_ORIGIN'], [{ ...f.current.headers, 'x-mailadmin-csrf': '' }, 'CSRF'], [{ ...f.current.headers, 'x-mailadmin-csrf': 'wrong' }, 'CSRF']]) failure(await f.write(input, headers), 403, code);
  failure(await f.app.inject({ method: 'POST', url: '/api/admin/auth/password', headers: { ...f.current.headers, 'content-type': 'text/plain' }, payload: 'synthetic' }), 415, 'JSON_REQUIRED');
  assert.equal(edits(f).length, 0); assert.equal(logins(f).length, 0);
});
for (const change of [{ currentPassword: '' }, { currentPassword: 7 }, { password: '' }, { password: 7 }, { password2: '' }, { password2: 7 }, { password2: 'different' }]) test(`password: invalid fields ${JSON.stringify(change)} have no remote effects`, async t => {
  const f = await fixture(t); failure(await f.write({ ...input, ...change }), 422, 'INVALID_INPUT'); assert.equal(logins(f).length, 0); assert.equal(edits(f).length, 0);
});

for (const failAt of [1, 2]) test(`password: audit write ${failAt} failure respects mutation boundary`, async t => {
  let writes = 0;
  const auditFs = { ...fs, async open(...args) { const handle = await fs.open(...args); return { chmod: (...values) => handle.chmod(...values), stat: () => handle.stat(), read: (...values) => handle.read(...values), close: () => handle.close(), async writeFile(...values) { if (++writes === failAt) throw new Error('synthetic-audit-failure'); return handle.writeFile(...values); }, sync: () => handle.sync() }; } };
  const f = await fixture(t, { auditFs }); failure(await f.write(), 500, failAt === 1 ? 'AUDIT_UNAVAILABLE' : 'AUDIT_RESULT_UNAVAILABLE'); assert.equal(edits(f).length, failAt === 1 ? 0 : 1);
});
