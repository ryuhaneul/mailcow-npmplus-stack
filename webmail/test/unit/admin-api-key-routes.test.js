import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createAdminApp } from '../../server/admin/app.js';

const origin = 'https://mailadmin.example.test';
const owner = 'owner@example.test';
const keyInput = (name = 'synthetic automation', permission = 'full') => ({ name, permission, allowedIps: [], expiresAt: null });
const keyHeaders = token => ({ 'x-mailadmin-api-key': token });
const failure = (response, status, code) => {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code);
  assert.equal(response.headers['www-authenticate'], undefined);
};
async function fixture(t, { configured = true, state = 'ready', audit, logger = false, logo = false } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'admin-api-key-routes-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const aliases = [], boxes = [{ username: owner, active: '1', sender_acl: [] }];
  const calls = [], filters = [{ id: '1', username: owner, filter_type: 'prefilter', active: '1', script_desc: 'synthetic filter', script_data: 'keep;\n' }];
  let clock = Date.UTC(2026, 9, 21);
  const client = {
    async login({ username }) { return { username, state }; },
    async logout() {},
    createApiContext({ permission }) { return Object.freeze({ permission }); },
    async call(context, method, path, body) {
      calls.push({ context, method, path, body });
      if (path === '/api/v1/get/status/version') return { version: 'synthetic' };
      if (path === `/api/v1/get/mailbox/${encodeURIComponent(owner)}`) return structuredClone(boxes[0]);
      if (path === '/api/v1/get/mailbox/all') return structuredClone(boxes);
      if (path === '/api/v1/get/alias/all') return structuredClone(aliases);
      if (path === '/api/v1/add/alias') { aliases.push({ id: String(aliases.length + 1), ...body }); return [{ type: 'success' }]; }
      if (path === '/api/v1/edit/alias') { Object.assign(aliases.find(row => row.id === body.items[0]), body.attr); return [{ type: 'success' }]; }
      if (path === '/api/v1/delete/alias') { aliases.splice(aliases.findIndex(row => row.id === body[0]), 1); return [{ type: 'success' }]; }
      if (path === '/api/v1/get/domain/all') return [{ domain_name: 'example.test', active: '1' }];
      if (path === '/api/v1/get/alias-domain/all') return [];
      if (path.startsWith('/api/v1/get/filters/')) return structuredClone(filters);
      if (path === '/api/v1/edit/filter') { Object.assign(filters.find(row => row.id === body.items[0]), body.attr); return [{ type: 'success' }]; }
      if (path === '/api/v1/add/filter') { filters.push({ id: '2', ...body }); return [{ type: 'success' }]; }
      assert.fail(`unexpected synthetic upstream call ${method} ${path}`);
    },
  };
  const config = {
    adminHostname: 'mailadmin.example.test', sessionIdleMin: 60, sessionMaxHours: 8, trustProxy: ['192.0.2.0/24'],
    mailcowApiKey: configured ? 'synthetic-upstream-credential' : '', apiKeyDir: join(directory, 'credentials'),
    auditDir: join(directory, 'audit'), logoDir: logo ? join(directory, 'brand') : '', relayFiles: [], logLevel: 'info',
    ftsNightly: { enabled: false, start: '03:00', end: '06:00', stateDir: join(directory, 'fts') },
  };
  const app = await createAdminApp({ config, logger, staticDir: '/nonexistent-synthetic-admin', auth: { client, now: () => clock }, audit });
  t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin }, payload: { username: 'human-admin', password: 'synthetic-password' } });
  assert.equal(login.statusCode, 200, login.body);
  const human = { cookie: login.headers['set-cookie'].split(';')[0], 'x-mailadmin-csrf': login.json().csrf, origin };
  const inject = ({ headers = human, ...options } = {}) => app.inject({ url: '/api/admin/api-keys', headers, remoteAddress: '198.51.100.8', ...options });
  const issue = async (input = keyInput()) => {
    const response = await inject({ method: 'POST', payload: input });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  return { app, inject, issue, human, login, calls, filters, config, directory, advance: ms => { clock += ms; } };
}

test('API key routes: human issue/list/revoke contract, one-time plaintext and irreversible safe audit', async t => {
  const f = await fixture(t);
  assert.equal(f.login.json().features.apiKeys, true);
  const originalRun = f.app.audit.run;
  f.app.audit.run = (entry, operation, options) => originalRun(entry, async intent => {
    const value = await operation(intent);
    assert.equal(value.token, undefined);
    assert.equal(value.item?.digest, undefined);
    return value;
  }, options);
  const created = await f.issue();
  assert.match(created.token, /^mak_v1_[A-Za-z0-9_-]{43}$/);
  assert.match(created.auditId, /^[a-f0-9]{32}$/);
  assert.equal(created.item.createdBy, 'human-admin');
  assert.equal(created.item.digest, undefined);
  assert.equal(created.item.token, undefined);
  const listing = await f.inject();
  assert.equal(listing.statusCode, 200);
  assert.equal(listing.headers['cache-control'], 'no-store');
  assert.deepEqual(listing.json(), { items: [created.item], total: 1, page: 1, pageSize: 50, enabled: true });
  assert.equal((await f.inject({ url: '/api/admin/api-keys?q=absent&page=2' })).json().items.length, 0);
  failure(await f.inject({ url: '/api/admin/api-keys?page=0' }), 422, 'INVALID_INPUT');
  const url = `/api/admin/api-keys/${created.item.id}`;
  failure(await f.inject({ method: 'DELETE', url, payload: { confirm: 'wrong' } }), 422, 'INVALID_INPUT');
  const removed = await f.inject({ method: 'DELETE', url, payload: { confirm: created.item.name } });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().item.status, 'revoked');
  const repeated = await f.inject({ method: 'DELETE', url, payload: { confirm: created.item.name } });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().unchanged, true);
  failure(await f.inject({ method: 'POST', payload: keyInput() }), 409, 'CONFLICT');
  const rows = (await f.app.audit.read()).rows;
  const intents = rows.filter(row => row.phase === 'intent');
  assert.ok(intents.length >= 3);
  assert.ok(intents.every(row => row.revertible === false && row.kind === 'config' && row.actor === 'human-admin' && /^api-credential:[a-f0-9]{32}$/.test(row.target)));
  const hash = createHash('sha256').update(created.token).digest('hex');
  for (const source of [JSON.stringify(rows), listing.body, removed.body, repeated.body]) {
    assert.ok(!source.includes(created.token)); assert.ok(!source.includes(hash));
    assert.ok(!source.includes('"digest"')); assert.ok(!source.includes('"token"'));
  }
  const persisted = await fs.readFile(join(f.config.apiKeyDir, 'keys.json'), 'utf8');
  assert.ok(!persisted.includes(created.token));
  failure(await f.inject({ url: `/api/admin/history/${created.auditId}/revert`, method: 'POST', payload: { confirm: true } }), 409, 'NOT_REVERTIBLE');
});

for (const mode of ['missing', 'totp', 'key', 'key+cookie']) test(`API key routes: management is human ready-session only (${mode})`, async t => {
  const f = await fixture(t, { state: mode === 'totp' ? 'totp' : 'ready' });
  const token = `mak_v1_${'A'.repeat(43)}`;
  const headers = mode === 'missing' ? { origin } : mode === 'totp' ? f.human : { ...(mode === 'key+cookie' ? f.human : {}), ...keyHeaders(token) };
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await f.inject({ method, headers, ...(method === 'DELETE' ? { url: `/api/admin/api-keys/${'a'.repeat(32)}` } : {}), ...(method === 'GET' ? {} : { payload: keyInput() }) });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.headers['www-authenticate'], undefined);
  }
  assert.deepEqual(await f.app.apiKeys.list(), []);
});

for (const problem of ['origin', 'csrf', 'json']) test(`API key routes: human changes retain ${problem} protection`, async t => {
  const f = await fixture(t);
  const headers = { ...f.human };
  if (problem === 'origin') delete headers.origin;
  if (problem === 'csrf') delete headers['x-mailadmin-csrf'];
  if (problem === 'json') headers['content-type'] = 'text/plain';
  failure(await f.inject({ method: 'POST', headers, payload: problem === 'json' ? '{}' : keyInput() }), problem === 'json' ? 415 : 403, problem === 'origin' ? 'BAD_ORIGIN' : problem === 'csrf' ? 'CSRF' : 'JSON_REQUIRED');
  assert.deepEqual(await f.app.apiKeys.list(), []);
});

test('API key routes: absent upstream credential disables only API access and issuance', async t => {
  const f = await fixture(t, { configured: false });
  assert.equal(f.login.json().features.apiKeys, false);
  assert.equal((await f.inject()).json().enabled, false);
  failure(await f.inject({ method: 'POST', payload: keyInput() }), 503, 'MAILCOW_API_UNAVAILABLE');
  failure(await f.inject({ url: `/api/admin/filters/${owner}`, headers: keyHeaders(`mak_v1_${'A'.repeat(43)}`) }), 503, 'MAILCOW_API_UNAVAILABLE');
  const session = await f.inject({ url: '/api/admin/auth/session' });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().features.apiKeys, false);
  assert.ok(!session.body.includes('mailcowApiKey'));
});

test('API key routes: issue validation, store failure and revoke failure stay explicit', async t => {
  const f = await fixture(t);
  for (const input of [{ ...keyInput(), permission: 'root' }, { ...keyInput(), allowedIps: ['bad'] }, { ...keyInput(), expiresAt: 'invalid' }, { ...keyInput(), token: 'synthetic' }]) {
    failure(await f.inject({ method: 'POST', payload: input }), 422, 'INVALID_INPUT');
  }
  assert.deepEqual(await f.app.apiKeys.list(), []);
  failure(await f.inject({ method: 'DELETE', url: `/api/admin/api-keys/${'a'.repeat(32)}`, payload: { confirm: 'absent' } }), 404, 'NOT_FOUND');
  await fs.writeFile(join(f.config.apiKeyDir, 'keys.json'), 'corrupt', { mode: 0o600 });
  failure(await f.inject(), 503, 'API_KEY_STORE_UNAVAILABLE');
});

for (const phase of ['intent', 'result']) test(`API key routes: audit ${phase} failure preserves issuance boundary without leaking plaintext`, async t => {
  let writes = 0;
  const f = await fixture(t, { audit: { fs: { ...fs, async open(...args) { if (++writes === (phase === 'intent' ? 1 : 2)) throw new Error('synthetic-write-failure'); return fs.open(...args); } } } });
  const response = await f.inject({ method: 'POST', payload: keyInput() });
  failure(response, 500, phase === 'intent' ? 'AUDIT_UNAVAILABLE' : 'AUDIT_RESULT_UNAVAILABLE');
  const items = await f.app.apiKeys.list();
  assert.equal(items.length, phase === 'intent' ? 0 : 1);
  assert.ok(!response.body.includes('mak_v1_'));
  if (phase === 'result') {
    assert.equal((await f.inject()).json().total, 1);
    assert.equal((await f.inject({ method: 'DELETE', url: `/api/admin/api-keys/${items[0].id}`, payload: { confirm: items[0].name } })).statusCode, 200);
  }
});

for (const mode of ['human', 'full']) test(`Gate C: external forwarding without spam guard rejects create and edit with no upstream mutation (${mode})`, async t => {
  const f = await fixture(t);
  const headers = mode === 'human' ? f.human : keyHeaders((await f.issue()).token);
  const listed = await f.inject({ url: `/api/admin/filters/${owner}`, headers });
  assert.equal(listed.statusCode, 200, listed.body);
  for (const method of ['POST', 'PUT']) {
    const response = await f.inject({ method, url: `/api/admin/filters/${owner}${method === 'PUT' ? '/1' : ''}`, headers, payload: method === 'POST' ? { type: 'postfilter', preset: 'custom', script: 'redirect :copy "outside@example.net";' } : { etag: listed.json().items[0].etag, script: 'redirect :copy "outside@example.net";' } });
    failure(response, 422, 'EXTERNAL_SPAM_GUARD');
  }
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
});

test('API key routes: full change shares validation, etag and audit actor; read change is forbidden; revoke blocks next request', async t => {
  const f = await fixture(t);
  const full = await f.issue(), read = await f.issue(keyInput('synthetic reader', 'read'));
  const url = `/api/admin/filters/${owner}`;
  const fullHeaders = keyHeaders(full.token);
  const listed = await f.inject({ url, headers: fullHeaders });
  const payload = { etag: listed.json().items[0].etag, script: '# synthetic changed\nkeep;\n' };
  failure(await f.inject({ url: `${url}/1`, method: 'PUT', headers: keyHeaders(read.token), payload }), 403, 'API_KEY_FORBIDDEN');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  failure(await f.inject({ url: `${url}/1`, method: 'PUT', headers: fullHeaders, payload: { ...payload, etag: 'stale' } }), 409, 'CHANGED_ELSEWHERE');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  const saved = await f.inject({ url: `${url}/1`, method: 'PUT', headers: fullHeaders, payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().script, payload.script);
  const record = (await f.app.audit.read()).rows.find(row => row.id === saved.json().auditId && row.phase === 'intent');
  assert.equal(record.actor, `API 키: ${full.item.name}`);
  assert.equal(record.ip, '198.51.100.8');
  assert.equal((await f.inject({ url, headers: keyHeaders(read.token) })).statusCode, 200);
  const revoked = await f.inject({ url: `/api/admin/api-keys/${full.item.id}`, method: 'DELETE', payload: { confirm: full.item.name } });
  assert.equal(revoked.statusCode, 200);
  failure(await f.inject({ url, headers: fullHeaders }), 403, 'API_KEY_FORBIDDEN');
});

test('API key routes: app logger redacts inbound key, server credential and issued token fields', async t => {
  let logs = '';
  const logger = { serializers: { req: request => ({ headers: request.headers }) }, stream: new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } }) };
  const f = await fixture(t, { logger });
  const created = await f.issue();
  f.app.log.info({ req: { headers: keyHeaders(created.token) }, config: { mailcowApiKey: f.config.mailcowApiKey }, mailcowApiKey: f.config.mailcowApiKey, result: { token: created.token, digest: 'synthetic-digest-value' } }, 'synthetic-redact-check');
  const denied = await f.inject({ url: `/api/admin/filters/${owner}/1`, method: 'PUT', headers: keyHeaders(created.token), payload: { etag: 'synthetic', script: 'synthetic-secret-script' } });
  assert.equal(denied.statusCode, 409);
  assert.match(logs, /synthetic-redact-check/);
  for (const secret of [created.token, f.config.mailcowApiKey, 'synthetic-digest-value', 'synthetic-secret-script']) assert.ok(!logs.includes(secret), secret);
});

for (const phase of ['intent', 'result']) test(`API key routes: audit ${phase} failure preserves revocation boundary`, async t => {
  let failAt = Infinity, writes = 0;
  const f = await fixture(t, { audit: { fs: { ...fs, async open(...args) { if (++writes === failAt) throw new Error('synthetic-write-failure'); return fs.open(...args); } } } });
  const created = await f.issue();
  failAt = writes + (phase === 'intent' ? 1 : 2);
  failure(await f.inject({ method: 'DELETE', url: `/api/admin/api-keys/${created.item.id}`, payload: { confirm: created.item.name } }), 500, phase === 'intent' ? 'AUDIT_UNAVAILABLE' : 'AUDIT_RESULT_UNAVAILABLE');
  assert.equal((await f.app.apiKeys.get(created.item.id)).status, phase === 'intent' ? 'active' : 'revoked');
});

test('API key routes: list is newest first, paginated and searchable without secret fields', async t => {
  const f = await fixture(t);
  const items = Array.from({ length: 51 }, (_, index) => ({ id: String(index), name: `synthetic ${index}`, createdAt: new Date(Date.UTC(2026, 9, 21, 0, index)).toISOString() }));
  t.mock.method(f.app.apiKeys, 'list', async () => items);
  const first = (await f.inject()).json(), second = (await f.inject({ url: '/api/admin/api-keys?page=2' })).json();
  assert.equal(first.total, 51); assert.equal(first.items.length, 50);
  assert.equal(first.items[0].id, '50'); assert.equal(second.items.length, 1); assert.equal(second.items[0].id, '0');
  assert.equal((await f.inject({ url: '/api/admin/api-keys?q=synthetic%2050' })).json().total, 1);
});

test('API key routes: human and full alias changes share validation, etag, readback and history auditing', async t => {
  const f = await fixture(t);
  const full = await f.issue();
  const headers = keyHeaders(full.token);
  for (const credentials of [f.human, headers]) {
    const count = f.calls.filter(call => call.method === 'POST').length;
    failure(await f.inject({ url: '/api/admin/aliases', method: 'POST', headers: credentials, payload: { address: 'invalid', targets: [owner] } }), 422, 'INVALID_INPUT');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, count);
  }
  const addr = 'alias@example.test';
  const created = await f.inject({ url: '/api/admin/aliases', method: 'POST', payload: { address: addr, targets: [owner] } });
  assert.equal(created.statusCode, 200, created.body);
  const first = created.json();
  const edited = await f.inject({ url: `/api/admin/aliases/${addr}`, method: 'PATCH', headers, payload: { etag: first.etag, active: false } });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().active, false);
  const writes = f.calls.filter(call => call.method === 'POST').length;
  failure(await f.inject({ url: `/api/admin/aliases/${addr}`, method: 'PATCH', headers, payload: { etag: first.etag, active: true } }), 409, 'CHANGED_ELSEWHERE');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, writes);
  const listed = await f.inject({ url: '/api/admin/aliases', headers });
  assert.equal(listed.json().items[0].active, false);
  const undone = await f.inject({ url: `/api/admin/history/${edited.json().auditId}/revert`, method: 'POST', headers, payload: { confirm: true } });
  assert.equal(undone.statusCode, 200, undone.body);
  assert.equal((await f.inject({ url: '/api/admin/aliases' })).json().items[0].active, true);
  const intents = (await f.app.audit.read()).rows.filter(row => row.phase === 'intent');
  assert.equal(intents.find(row => row.id === first.auditId).actor, 'human-admin');
  assert.equal(intents.find(row => row.id === edited.json().auditId).actor, `API 키: ${full.item.name}`);
  assert.equal(intents.find(row => row.revertOf === edited.json().auditId).actor, `API 키: ${full.item.name}`);
});

test('API key routes: stable key identity owns logo preview across requests and isolates other keys', async t => {
  const f = await fixture(t, { logo: true });
  const first = await f.issue(), second = await f.issue(keyInput('synthetic other automation'));
  const headers = keyHeaders(first.token);
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
  const preview = await f.inject({ url: '/api/admin/logo/preview', method: 'POST', headers, payload: { variant: 'light', mime: 'image/png', dataBase64: image } });
  assert.equal(preview.statusCode, 200, preview.body);
  const result = preview.json();
  assert.equal((await f.inject({ url: result.url, headers })).statusCode, 200);
  failure(await f.inject({ url: result.url, headers: keyHeaders(second.token) }), 404, 'NOT_FOUND');
  const current = await f.inject({ url: '/api/admin/logo', headers });
  const payload = { etag: current.json().etag, lightPreviewId: result.id };
  failure(await f.inject({ url: '/api/admin/logo', method: 'PUT', headers: keyHeaders(second.token), payload }), 404, 'NOT_FOUND');
  const saved = await f.inject({ url: '/api/admin/logo', method: 'PUT', headers, payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().current.light.mime, 'image/png');
});

test('API key routes: existing minute sweep also cleans API limiter and stops on close', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t);
  const sweep = t.mock.method(f.app.adminApiKeyRateLimiter, 'sweep');
  t.mock.timers.tick(60_000);
  assert.equal(sweep.mock.callCount(), 1);
  await f.app.close();
  t.mock.timers.tick(60_000);
  assert.equal(sweep.mock.callCount(), 1);
});
