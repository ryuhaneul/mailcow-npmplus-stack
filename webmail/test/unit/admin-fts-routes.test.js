import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import ftsRoutes from '../../server/admin/routes/fts.js';
import { installErrors } from '../../server/errors.js';
import { installAdminAuth } from '../../server/admin/routes/auth.js';
import { createAdminApp } from '../../server/admin/app.js';
import { createFtsState } from '../../server/admin/fts-state.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';

const instant = '2026-10-20T18:00:00.000Z';
const row = (unindexed = 4) => ({ user: 'person@example.test', mailbox: '한글 폴더', guid: 'a'.repeat(32), messages: 10, indexed: 10 - unindexed, unindexed, shards: 3, measuredAt: instant, status: 'ok', reason: null });
const config = {
  adminHostname: 'mailadmin.example.test', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8,
  ftsNightly: { enabled: true, start: '03:15', end: '05:45', stateDir: '/synthetic/private-state-path' },
};
function storedState() {
  return { runId: 'synthetic-run', day: '2026-10-21', status: 'cutoff', startedAt: instant, finishedAt: instant,
    indexBlocked: true, remoteUnknown: { user: 'person@example.test', mailbox: '한글 폴더', at: instant },
    snapshot: { measuredAt: instant, totals: { messages: 10, indexed: 6, unindexed: 4, unmeasured: 1, excluded: 2 }, top: [row()] },
    folders: [{ ...row(), before: row(), after: row(0), result: 'done', error: null, startedAt: instant, finishedAt: instant },
      { ...row(), mailbox: '대기', before: row(), after: null, result: 'pending', error: null }],
  };
}
async function fixture(t, result = { state: storedState(), damaged: false }, settings = config) {
  const calls = { read: 0, verify: 0, write: 0, logout: 0 }, logs = [], options = {};
  const client = {
    async login({ username }) { return { username, state: 'ready' }; },
    async logout() { calls.logout++; },
    async call(_session, method, path) {
      calls.verify++;
      assert.equal(method, 'GET'); assert.equal(path, '/api/v1/get/status/version');
      if (options.authLost) throw new MailcowAuthLost();
      return { version: 'synthetic' };
    },
  };
  const app = Fastify({ logger: { level: 'info', stream: { write: line => logs.push(line) } } });
  installErrors(app);
  await installAdminAuth(app, { config: settings, client });
  const state = new Proxy({ async read() { calls.read++; if (options.readError) throw options.readError; return result; } }, {
    get(target, key) { if (key in target) return target[key]; calls.write++; throw new Error('State mutation is forbidden'); },
  });
  await app.register(ftsRoutes, { state, config: settings });
  t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.test' }, payload: { username: 'admin', password: 'synthetic-login-secret' } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { cookie: login.headers['set-cookie'].split(';')[0] };
  return { app, calls, options, headers, logs };
}

test('FTS cache GET100 verifies admin each time and reads only stored state', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 100; i++) {
    const response = await f.app.inject({ url: '/api/admin/fts-status', headers: f.headers });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(body.window, { start: '03:15', end: '05:45', timeZone: 'Asia/Seoul' });
    assert.equal(body.enabled, true); assert.equal(body.lastRun.cutoff, true);
    assert.equal(body.lastRun.day, '2026-10-21'); assert.equal(body.indexBlocked, true);
    assert.equal(body.remoteUnknown.at, instant); assert.equal(body.snapshot.measuredAt, instant);
    assert.deepEqual(body.snapshot.totals, { messages: 10, indexed: 6, unindexed: 4, unmeasured: 1, excluded: 2 });
    assert.equal(body.snapshot.top20[0].unindexed, 4);
    assert.equal(body.snapshot.top20[0].shards, 3); assert.equal(body.snapshot.top20[0].measuredAt, instant);
    assert.equal(body.folders[0].shards, 3); assert.equal(body.folders[0].measuredAt, instant);
    assert.equal(body.folders[0].unindexed, 0); assert.equal(body.folders[1].unindexed, 4);
    assert.equal(body.folders[1].mailbox, '대기');
    assert.equal(body.snapshot.folders, undefined); assert.equal(body.damaged, false);
  }
  assert.equal(f.calls.read, 100); assert.equal(f.calls.verify, 100); assert.equal(f.calls.write, 0);
});

test('FTS unauthenticated and revoked admins get403 before reading cache', async t => {
  const f = await fixture(t);
  const missing = await f.app.inject('/api/admin/fts-status');
  assert.equal(missing.statusCode, 403); assert.equal(missing.json().error.code, 'NO_SESSION');
  assert.equal(missing.headers['www-authenticate'], undefined);
  f.options.authLost = true;
  const revoked = await f.app.inject({ url: '/api/admin/fts-status', headers: f.headers });
  assert.equal(revoked.statusCode, 403); assert.equal(revoked.json().error.code, 'MAILCOW_SESSION_LOST');
  assert.equal(revoked.headers['www-authenticate'], undefined);
  assert.equal(f.calls.read, 0); assert.equal(f.calls.logout, 1);
  assert.equal((await f.app.inject({ url: '/api/admin/fts-status', headers: f.headers })).statusCode, 403);
});

for (const damaged of [false, true]) test(`FTS missing/corrupt cache stays200 damaged=${damaged} and uses disabled defaults`, async t => {
  const f = await fixture(t, { state: null, damaged }, { ...config, ftsNightly: undefined });
  const response = await f.app.inject({ url: '/api/admin/fts-status', headers: f.headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { enabled: false, window: { start: '03:00', end: '06:00', timeZone: 'Asia/Seoul' },
    lastRun: null, indexBlocked: false, remoteUnknown: null, snapshot: null, folders: [], damaged });
});

test('FTS explicit projections drop private fields at every stored nesting level and cap top20', async t => {
  const state = storedState(), privateFields = { key: 'synthetic-api-secret', path: '/synthetic/private-state-path', token: 'synthetic-lock-token', raw: 'synthetic-server-response' };
  for (const value of [state, state.remoteUnknown, state.snapshot, state.snapshot.totals, ...state.snapshot.top,
    ...state.folders, ...state.folders.map(folder => folder.before), state.folders[0].after]) Object.assign(value, privateFields);
  state.unlockHistory = [{ ...privateFields, lockToken: 'synthetic-lock-token' }];
  state.snapshot.top = Array.from({ length: 25 }, () => ({ ...row(), ...privateFields }));
  const f = await fixture(t, { state, damaged: false });
  const response = await f.app.inject({ url: '/api/admin/fts-status', headers: f.headers });
  assert.equal(response.statusCode, 200); assert.equal(response.json().snapshot.top20.length, 20);
  for (const secret of Object.values(privateFields)) assert.ok(!response.body.includes(secret), secret);
  assert.ok(!response.body.includes('unlockHistory'));
  assert.ok(!f.logs.join('').includes('synthetic-login-secret'));
});

test('FTS unexpected state read errors keep the existing sanitized error envelope', async t => {
  const f = await fixture(t); f.options.readError = new Error('/synthetic/private-path synthetic-secret');
  const response = await f.app.inject({ url: '/api/admin/fts-status', headers: f.headers });
  assert.equal(response.statusCode, 500); assert.equal(response.json().error.code, 'INTERNAL_ERROR');
  assert.ok(!response.body.includes('synthetic')); assert.ok(!f.logs.join('').includes('synthetic-secret'));
});

test('FTS mounted admin route reads real state; GET100 starts no Dovecot/measurement/index calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'webmail-fts-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = createFtsState({ dir, now: () => Date.parse(instant) });
  await state.acquire(); const started = await state.startRun();
  await state.save({ ...started, ...storedState(), runId: started.runId, day: started.day });
  let doveadmCalls = 0, verifyCalls = 0;
  const doveadm = new Proxy({}, { get() { return async () => { doveadmCalls++; throw new Error('Dovecot must not be called'); }; } });
  const app = await createAdminApp({ config: { ...config, ftsNightly: { ...config.ftsNightly, stateDir: dir }, auditDir: dir }, logger: false, doveadm,
    auth: { client: { async login({ username }) { return { username, state: 'ready' }; }, async logout() {}, async call() { verifyCalls++; return { version: 'synthetic' }; } } } });
  t.after(() => app.close());
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.test' }, payload: { username: 'admin', password: 'synthetic-secret' } });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0] };
  const before = await readdir(dir);
  for (let i = 0; i < 100; i++) {
    const response = await app.inject({ url: '/api/admin/fts-status', headers });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().lastRun.runId, started.runId);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(doveadmCalls, 0); assert.equal(verifyCalls, 100); assert.deepEqual(await readdir(dir), before);
  await writeFile(join(dir, 'state.json'), '{synthetic-corrupt');
  const damaged = await app.inject({ url: '/api/admin/fts-status', headers });
  assert.equal(damaged.statusCode, 200); assert.equal(damaged.json().damaged, true);
});


test('FTS API projects incomplete measurements and restart unknown without inventing a folder', async t => {
  const stored = storedState();
  stored.status = 'unknown'; stored.remoteUnknown = { user: null, mailbox: null, at: instant, reason: 'restart' };
  stored.snapshot.incomplete = true;
  stored.folders.push({ user: 'bad@example.test', mailbox: null, before: {
    user: 'bad@example.test', mailbox: null, guid: null, status: 'unmeasured', reason: 'measurement-failed',
  }, after: null, result: 'unmeasured', error: null });
  const f = await fixture(t, { state: stored, damaged: false });
  const body = (await f.app.inject({ url: '/api/admin/fts-status', headers: f.headers })).json();
  assert.equal(body.snapshot.incomplete, true); assert.equal(body.lastRun.status, 'unknown');
  assert.deepEqual(body.remoteUnknown, stored.remoteUnknown);
  assert.equal(body.folders[2].mailbox, null); assert.equal(body.folders[2].status, 'unmeasured');
  assert.equal(body.folders[2].reason, 'measurement-failed');
});


test('FTS app onReady persists restart warning before API reads even with scheduling disabled', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fts-onready-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const owner = createFtsState({ dir }); await owner.acquire(); const run = await owner.startRun();
  const lockFiles = await readdir(join(dir, 'lock'));
  let remoteCalls = 0;
  const doveadm = new Proxy({}, { get() { return async () => { remoteCalls++; throw new Error('synthetic'); }; } });
  const app = await createAdminApp({ config: { ...config, ftsNightly: { ...config.ftsNightly, enabled: false, stateDir: dir }, auditDir: dir }, logger: false, doveadm,
    auth: { client: { async login({ username }) { return { username, state: 'ready' }; }, async logout() {}, async call() { return { version: 'synthetic' }; } } } });
  t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.test' }, payload: { username: 'admin', password: 'synthetic' } });
  const response = await app.inject({ url: '/api/admin/fts-status', headers: { cookie: login.headers['set-cookie'].split(';')[0] } });
  assert.equal(response.statusCode, 200);
  const body = response.json(); assert.equal(body.lastRun.runId, run.runId); assert.equal(body.lastRun.status, 'unknown');
  assert.equal(body.indexBlocked, true); assert.equal(body.remoteUnknown.reason, 'restart');
  assert.equal(body.remoteUnknown.user, null); assert.equal(body.remoteUnknown.mailbox, null);
  assert.deepEqual(await readdir(join(dir, 'lock')), lockFiles); assert.equal(remoteCalls, 0);
});
