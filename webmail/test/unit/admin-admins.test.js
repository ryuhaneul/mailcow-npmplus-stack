import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdminsService } from '../../server/admin/services/admins.js';
import { createAdminSessionStore } from '../../server/admin/session.js';
import { createResourceLock, ADMIN_ACCOUNTS_LOCK } from '../../server/admin/lock.js';
import { createAudit } from '../../server/admin/audit.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';

const config = { adminHostname: 'mailadmin.example.test', sessionIdleMin: 60, sessionMaxHours: 8, trustProxy: ['192.0.2.0/24'] };
const origin = 'https://mailadmin.example.test';
const secret = 'SyntheticAdminPassword732!';
const row = (username, active = 1, a = 0, b = 0) => ({ username, active, tfa_active: 0, created: '2026-11-01', attributes: { force_tfa: a, force_pw_update: b } });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'admin-accounts-'));
  const rows = new Map([['admin', row('admin')], ['other', row('other')], ['off', row('off', 0)]]), calls = [], options = {};
  const client = {
    async login({ username }) { return { username, state: 'ready' }; },
    async logout(session) { calls.push({ kind: 'logout', session }); if (options.logout) await options.logout(); },
    async totp(session) { session.state = 'ready'; },
    createApiContext() { return {}; },
    async call(context, method, path, body, signal, callOptions) {
      calls.push({ context, method, path, body: body === undefined ? undefined : structuredClone(body), callOptions });
      if (path === '/api/v1/get/status/version') return { version: 'synthetic' };
      if (method === 'GET') {
        if (options.readError || (options.readbackError && calls.some(c => c.method === 'POST'))) throw new AppError(503, 'MAILCOW_UNAVAILABLE', 'synthetic');
        return options.raw !== undefined ? options.raw : structuredClone([...rows.values()]);
      }
      assert.deepEqual(callOptions, { rejectWarnings: true });
      if (options.dispatch) await options.dispatch();
      if (options.error) throw options.error;
      const target = path.includes('/add/') ? body.username : path.includes('/delete/') ? body[0] : body.items[0];
      if (!options.ignoreWrite) {
        if (path.includes('/add/')) rows.set(target, row(target, body.active));
        else if (path.includes('/delete/')) rows.delete(target);
        else { const item = rows.get(target); item.active = body.attr.active; item.attributes = { force_tfa: body.attr.force_tfa, force_pw_update: body.attr.force_pw_update }; }
        if (options.corruptFlag && rows.has(target)) rows.get(target).attributes.force_tfa = 1;
      }
      return options.result ?? [{ type: 'success', msg: [path.includes('/add/') ? 'admin_added' : path.includes('/delete/') ? 'admin_removed' : 'admin_modified', target] }];
    },
  };
  const sessions = createAdminSessionStore({ config, client }), lock = createResourceLock(), audit = createAudit({ dir: join(dir, 'audit') });
  const service = createAdminsService({ mailcow: client, sessions, lock, audit });
  const add = (username = 'admin', state = 'ready') => sessions.create({ username, state });
  const current = add(), history = createHistoryService({ audit, lock });
  t.after(async () => { await sessions.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const item = async name => (await service.list(current.session.mailcow)).items.find(r => r.username === name);
  const input = async (name = 'other', data = {}) => ({ token: current.token, ip: '192.0.2.20', username: name, data: { etag: (await item(name))?.etag, ...data } });
  return { dir, rows, calls, options, client, sessions, lock, audit, history, service, current, add, item, input };
}
const posts = f => f.calls.filter(c => c.method === 'POST');

test('admins: list preserves projection, adds opaque etag, never projects credentials, and supports empty mailcow object', async t => {
  const f = await fixture(t); f.rows.set('admin', { ...row('admin'), active: 'localized', active_int: 1, tfa_active: 'localized', tfa_active_int: 1, attributes: { force_tfa: '1', force_pw_update: '0' }, password: secret });
  const item = await f.item('admin'); assert.match(item.etag, /^[a-f0-9]{64}$/);
  const { etag, ...old } = item; assert.deepEqual(old, { username: 'admin', active: true, tfaActive: true, created: '2026-11-01', forceTfa: true, forcePwUpdate: false });
  assert.ok(!JSON.stringify(item).includes(secret)); f.options.raw = {}; assert.deepEqual(await f.service.list({}), { items: [] });
  f.options.raw = false; await assert.rejects(f.service.list({}), { statusCode: 502 });
  f.options.raw = undefined; f.options.readError = true; await assert.rejects(f.service.list({}), { statusCode: 503 });
});

test('admins: create/disable/enable/reset/delete dispatch once each, audit without secrets, and never register history undo', async t => {
  const f = await fixture(t), data = { username: ' New.Admin ', password: secret, password2: secret, active: true };
  const created = await f.service.create({ token: f.current.token, ip: '192.0.2.20', data }); assert.equal(created.item.username, 'new.admin'); assert.equal(created.item.active, true);
  assert.equal(data.password, undefined); assert.equal(data.password2, undefined);
  assert.equal((await f.service.active(await f.input('new.admin', { active: false }))).item.active, false);
  assert.equal((await f.service.active(await f.input('new.admin', { active: true }))).item.active, true);
  assert.deepEqual(await f.service.password(await f.input('new.admin', { password: secret, password2: secret })), { ok: true });
  assert.deepEqual(await f.service.remove(await f.input('new.admin', { confirm: 'new.admin' })), { ok: true });
  assert.equal(posts(f).length, 5); assert.deepEqual(posts(f).map(c => c.path), ['/api/v1/add/admin', '/api/v1/edit/admin', '/api/v1/edit/admin', '/api/v1/edit/admin', '/api/v1/delete/admin']);
  const records = await f.history.list(); assert.equal(records.total, 5); assert.ok(records.items.every(r => r.canRevert === false && r.revertible === false));
  for (const record of records.items) await assert.rejects(f.history.revert(record.id, { confirm: true }), { statusCode: 409, code: 'NOT_REVERTIBLE' });
  assert.equal(posts(f).length, 5); const raw = JSON.stringify((await f.audit.read()).rows); assert.ok(!raw.includes(secret));
  assert.equal((await f.audit.read()).rows.length, 10); assert.equal(f.sessions.generation('new.admin'), 10);
});

for (const a of [0, 1]) for (const b of [0, 1]) for (const mode of ['active', 'password']) test(`admins: ${mode} preserves latest force flags ${a}/${b}`, async t => {
  const f = await fixture(t); f.rows.set('other', row('other', '1', String(a), String(b)));
  await f.service[mode](await f.input('other', mode === 'active' ? { active: false } : { password: secret, password2: secret }));
  assert.equal(posts(f)[0].body.attr.force_tfa, a); assert.equal(posts(f)[0].body.attr.force_pw_update, b);
  assert.ok(!Object.hasOwn(posts(f)[0].body.attr, 'disable_tfa')); assert.ok(!Object.hasOwn(posts(f)[0].body.attr, 'username_new'));
});

const bodies = { create: () => ({ username: 'new', active: true, password: secret, password2: secret }), active: () => ({ active: false }), password: () => ({ password: secret, password2: secret }), remove: () => ({ confirm: 'other' }) };
for (const method of Object.keys(bodies)) for (const field of ['force_tfa', 'force_pw_update', 'disable_tfa', 'username_new', 'items', 'attr']) test(`admins: ${method} rejects injected ${field}`, async t => {
  const f = await fixture(t); const args = method === 'create' ? { token: f.current.token, data: bodies.create() } : await f.input('other', bodies[method]()); args.data[field] = 1;
  await assert.rejects(f.service[method](args), { statusCode: 422, code: 'INVALID_INPUT' }); assert.equal(posts(f).length, 0); assert.equal((await f.audit.read()).rows.length, 0);
});

for (const method of ['active', 'password', 'remove']) test(`admins: ${method} rejects stale etag, unknown target, and invalid confirmation/types before dispatch`, async t => {
  const f = await fixture(t), data = bodies[method]();
  await assert.rejects(f.service[method](await f.input('other', { ...data, etag: 'old' })), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  await assert.rejects(f.service[method]({ token: f.current.token, username: 'missing', data: { ...data, etag: 'old', ...(method === 'remove' ? { confirm: 'missing' } : {}) } }), { statusCode: 404 });
  const bad = method === 'active' ? { active: '0' } : method === 'password' ? { password: secret, password2: 'different' } : { confirm: true };
  await assert.rejects(f.service[method](await f.input('other', { ...data, ...bad })), { statusCode: 422 }); assert.equal(posts(f).length, 0);
});
for (const name of ['', 'API', ' api ', 'bad/name', '---']) test(`admins: invalid or reserved create name ${JSON.stringify(name)}`, async t => {
  const f = await fixture(t); await assert.rejects(f.service.create({ token: f.current.token, data: { ...bodies.create(), username: name } }), { statusCode: 422 }); assert.equal(posts(f).length, 0);
});

test('admins: no-op does not write/audit/revoke; own disable/delete/reset always rejects; inactive target can be deleted', async t => {
  const f = await fixture(t); const other = f.add('other');
  const result = await f.service.active(await f.input('other', { active: true })); assert.equal(result.unchanged, true);
  assert.equal(posts(f).length, 0); assert.equal((await f.audit.read()).rows.length, 0); assert.equal(await f.sessions.get(other.token), other.session);
  for (const method of ['active', 'password', 'remove']) await assert.rejects(f.service[method](await f.input('admin', { ...bodies[method](), ...(method === 'remove' ? { confirm: 'admin' } : {}) })), { statusCode: 403, code: 'ADMIN_SELF_ACTION' });
  await f.service.remove(await f.input('off', { confirm: 'off' })); assert.equal(posts(f).length, 1);
});

test('admins: last active self and inactive actor cannot remove or disable the last usable administrator', async t => {
  const f = await fixture(t); f.rows.get('other').active = 0;
  for (const method of ['active', 'remove']) await assert.rejects(f.service[method](await f.input('admin', method === 'active' ? { active: false } : { confirm: 'admin' })), { statusCode: 403, code: 'ADMIN_SELF_ACTION' });
  f.rows.get('admin').active = 0; f.rows.get('other').active = 1;
  for (const method of ['active', 'remove']) await assert.rejects(f.service[method](await f.input('other', bodies[method]())), { statusCode: 403, code: 'NO_SESSION' });
  assert.equal(posts(f).length, 0);
});

test('admins: two active administrators disabling each other concurrently preserve one active administrator', async t => {
  const f = await fixture(t), other = f.add('other');
  const first = await f.input('other', { active: false }), second = { ...(await f.input('admin', { active: false })), token: other.token };
  const results = await Promise.allSettled([f.service.active(first), f.service.active(second)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.statusCode, 403);
  assert.equal(posts(f).length, 1); assert.equal([...f.rows.values()].filter(r => r.active === 1).length, 1);
});

for (const field of ['active', 'force_tfa', 'force_pw_update']) test(`admins: malformed latest ${field} blocks writes`, async t => {
  const f = await fixture(t), args = await f.input('other', { active: false });
  if (field === 'active') f.rows.get('other').active = true; else delete f.rows.get('other').attributes[field];
  await assert.rejects(f.service.active(args), { statusCode: 502 }); assert.equal(posts(f).length, 0);
});

test('admins: recheck session after lock wait and after audit intent, before touching target sessions', async t => {
  const f = await fixture(t), args = await f.input('other', { active: false }), entered = gate(), release = gate(), queued = gate();
  const held = f.lock.run(ADMIN_ACCOUNTS_LOCK, async () => { entered.resolve(); await release.promise; await f.sessions.invalidateUser('admin'); }); await entered.promise;
  const run = f.lock.run; f.lock.run = (key, op) => { queued.resolve(); return run(key, op); };
  const pending = f.service.active(args); await queued.promise; release.resolve(); await held;
  await assert.rejects(pending, { statusCode: 403 }); assert.equal(posts(f).length, 0);
});

for (const kind of ['success', 'error', 'readback']) test(`admins: ${kind} dispatch revokes ready/TOTP before waiting for logout and fences the target twice`, async t => {
  const f = await fixture(t), removed = ['ready', 'ready', 'totp', 'totp'].map(state => f.add('other', state)), release = gate(), entered = gate();
  f.options.logout = () => release.promise;
  f.options.dispatch = () => { for (const item of removed) { assert.equal(item.session.state, 'closed'); assert.equal(item.session.csrf, ''); } entered.resolve(); };
  if (kind === 'error') f.options.error = new AppError(503, 'MAILCOW_UNAVAILABLE', 'synthetic');
  if (kind === 'readback') f.options.readbackError = true;
  const result = f.service.password(await f.input('other', bodies.password()));
  const checked = kind === 'success' ? result : assert.rejects(result, { statusCode: 503 });
  await entered.promise; for (const item of removed) await assert.rejects(f.sessions.get(item.token), { statusCode: 403 });
  release.resolve(); await checked; assert.equal(f.sessions.generation('other'), 2); assert.equal(await f.sessions.get(f.current.token), f.current.session);
});

for (const kind of ['ignored', 'wrong-key', 'missing', 'flag']) test(`admins: ${kind} result cannot be reported as applied`, async t => {
  const f = await fixture(t);
  if (kind === 'ignored') f.options.ignoreWrite = true;
  if (kind === 'wrong-key') f.options.result = [{ type: 'success', msg: 'mailbox_modified' }];
  if (kind === 'missing') f.options.result = [];
  if (kind === 'flag') f.options.corruptFlag = true;
  await assert.rejects(f.service.active(await f.input('other', { active: false })), { statusCode: 502 });
  assert.equal(f.sessions.generation('other'), 2); assert.equal((await f.audit.read()).rows.at(-1).result, 'failed');
});

test('admins: audit intent failure preserves target access; result failure leaves applied change and revoked sessions', async t => {
  const f = await fixture(t), other = f.add('other'), run = f.audit.run;
  f.audit.run = async () => { throw new AppError(500, 'AUDIT_UNAVAILABLE', 'synthetic'); };
  await assert.rejects(f.service.active(await f.input('other', { active: false })), { code: 'AUDIT_UNAVAILABLE' }); assert.equal(posts(f).length, 0); assert.equal(await f.sessions.get(other.token), other.session);
  f.audit.run = async (...args) => { await run(...args); throw new AppError(500, 'AUDIT_RESULT_UNAVAILABLE', 'synthetic'); };
  await assert.rejects(f.service.active(await f.input('other', { active: false })), { code: 'AUDIT_RESULT_UNAVAILABLE' });
  await assert.rejects(f.sessions.get(other.token), { statusCode: 403 }); assert.equal(f.rows.get('other').active, 0); assert.equal(f.sessions.generation('other'), 2);
});

test('admins HTTP: mounted CRUD contracts, guarded writes and no-store responses', async t => {
  const f = await fixture(t); let logs = '';
  const app = await createAdminApp({ config: { ...config, auditDir: join(f.dir, 'http-audit'), apiKeyDir: join(f.dir, 'http-keys'), mailcowApiKey: 'synthetic-upstream-key' }, logger: { level: 'info', stream: new Writable({ write(chunk, _encoding, done) { logs += chunk; done(); } }) }, auth: { client: f.client } }); t.after(() => app.close());
  const { token, session } = app.adminSessions.create({ username: 'admin', state: 'ready' });
  const headers = { cookie: `mailadmin_sid=${token}`, origin, 'x-mailadmin-csrf': session.csrf };
  const get = () => app.inject({ url: '/api/admin/admins', headers });
  const response = await get(); assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  const etag = response.json().items.find(r => r.username === 'other').etag;
  for (const bad of [{}, { ...headers, origin: 'https://outside.example.test' }, { ...headers, 'x-mailadmin-csrf': '' }]) {
    const denied = await app.inject({ method: 'PATCH', url: '/api/admin/admins/other/active', headers: bad, payload: { active: false, etag } }); assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
  }
  const changed = await app.inject({ method: 'PATCH', url: '/api/admin/admins/other/active', headers, payload: { active: false, etag } }); assert.equal(changed.statusCode, 200, changed.body); assert.equal(changed.json().item.active, false);
  const create = await app.inject({ method: 'POST', url: '/api/admin/admins', headers, payload: { username: 'new', active: true, password: secret, password2: secret } }); assert.equal(create.statusCode, 200, create.body);
  const reset = await app.inject({ method: 'POST', url: '/api/admin/admins/new/password', headers, payload: { etag: create.json().item.etag, password: secret, password2: secret } }); assert.equal(reset.statusCode, 200, reset.body);
  const remove = await app.inject({ method: 'DELETE', url: '/api/admin/admins/new', headers, payload: { confirm: 'new', etag: create.json().item.etag } }); assert.equal(remove.statusCode, 200, remove.body);
  const beforeKeys = posts(f).length;
  for (const permission of ['read', 'full']) {
    const key = await app.apiKeys.create({ name: `synthetic-${permission}`, permission, allowedIps: [] }, 'admin', { id: app.apiKeys.allocateId() });
    const keyHeaders = { ...headers, 'x-mailadmin-api-key': key.token };
    assert.equal((await app.inject({ url: '/api/admin/admins', headers: keyHeaders })).statusCode, 200);
    for (const [method, url] of [['POST', '/api/admin/admins'], ['PATCH', '/api/admin/admins/other/active'], ['POST', '/api/admin/admins/other/password'], ['DELETE', '/api/admin/admins/other']]) {
      const denied = await app.inject({ method, url, headers: keyHeaders, payload: {} }); assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
    }
    const record = (await app.adminHistory.list()).items.find(item => item.action === 'admin.active.change');
    const undo = await app.inject({ method: 'POST', url: `/api/admin/history/${record.id}/revert`, headers: keyHeaders, payload: { confirm: true } });
    assert.equal(undo.statusCode, permission === 'read' ? 403 : 409);
    assert.ok(!logs.includes(key.token));
  }
  const record = (await app.adminHistory.list()).items.find(item => item.action === 'admin.active.change');
  const undo = await app.inject({ method: 'POST', url: `/api/admin/history/${record.id}/revert`, headers, payload: { confirm: true } });
  assert.equal(undo.statusCode, 409); assert.equal(undo.json().error.code, 'NOT_REVERTIBLE');
  assert.equal(posts(f).length, beforeKeys);
  const all = logs + JSON.stringify([create.json(), reset.json(), remove.json(), (await app.audit.read()).rows]); assert.ok(!all.includes(secret));
});


test('admins: session revoked after audit intent cannot dispatch or revoke the target', async t => {
  const f = await fixture(t), target = f.add('other'), run = f.audit.run;
  f.audit.run = (entry, operation) => run(entry, async () => { await f.sessions.destroy(f.current.session); return operation(); });
  await assert.rejects(f.service.active(await f.input('other', { active: false })), { statusCode: 403 });
  assert.equal(posts(f).length, 0); assert.equal(f.sessions.generation('other'), 0); assert.equal(await f.sessions.get(target.token), target.session);
});

for (const method of ['create', 'remove']) test(`admins: ${method} readback requires actual presence or absence`, async t => {
  const f = await fixture(t); f.options.ignoreWrite = true;
  const args = method === 'create' ? { token: f.current.token, data: bodies.create() } : await f.input('other', bodies.remove());
  await assert.rejects(f.service[method](args), { statusCode: 502 }); assert.equal(posts(f).length, 1);
});

test('admins: fresh flag changes invalidate stale request and duplicate create leaves existing sessions alone', async t => {
  const f = await fixture(t), args = await f.input('other', { active: false }), target = f.add('other');
  f.rows.get('other').attributes.force_tfa = 1;
  await assert.rejects(f.service.active(args), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  await assert.rejects(f.service.create({ token: f.current.token, data: { ...bodies.create(), username: 'other' } }), { statusCode: 422 });
  assert.equal(posts(f).length, 0); assert.equal(f.sessions.generation('other'), 0); assert.equal(await f.sessions.get(target.token), target.session);
});

test('admins: inactive create is accepted; active must be boolean; empty/mismatched passwords and malformed bodies never dispatch', async t => {
  const f = await fixture(t); await f.service.create({ token: f.current.token, data: { ...bodies.create(), username: 'disabled', active: false } }); assert.equal(f.rows.get('disabled').active, 0);
  const before = posts(f).length;
  for (const data of [null, [], {}, { ...bodies.create(), active: 1 }, { ...bodies.create(), password: '' }, { ...bodies.create(), password2: 'different' }]) {
    await assert.rejects(f.service.create({ token: f.current.token, data }), { statusCode: 422 });
  }
  assert.equal(posts(f).length, before);
});

test('admins: upstream warning rejection is a failed audit and never a successful operation', async t => {
  const f = await fixture(t); f.options.error = Object.assign(new AppError(422, 'MAILCOW_REJECTED', 'mailcow가 요청을 거절했어요(no_active_admin).'), { mailcowMessageKey: 'no_active_admin' });
  await assert.rejects(f.service.active(await f.input('other', { active: false })), { statusCode: 422, mailcowMessageKey: 'no_active_admin' });
  const records = (await f.audit.read()).rows; assert.equal(records.length, 2); assert.equal(records[1].result, 'failed'); assert.equal(f.sessions.generation('other'), 2);
});
