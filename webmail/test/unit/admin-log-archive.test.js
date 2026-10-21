import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdminConfig } from '../../server/admin/config.js';
import { createAdminApp } from '../../server/admin/app.js';
import { createLogsService } from '../../server/admin/services/logs.js';
import { createLogArchiveClient, LOG_ARCHIVE_MAX_BYTES, LOG_ARCHIVE_TIMEOUT_MS } from '../../server/admin/log-archive-client.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';
import { projectLine } from '../../../log-archiver/search.js';

const key = 'synthetic-archive-private-key';
const env = {
  ADMIN_MODE: 'true', ADMIN_HOSTNAME: 'mailadmin.example.com', ADMIN_SESSION_IDLE_MIN: '60', ADMIN_SESSION_MAX_HOURS: '8',
  MAILCOW_UI_URL: 'https://nginx-mailcow:8443', MAILCOW_UI_SERVERNAME: 'mailcow.example.com',
  IMAP_HOST: 'dovecot-mailcow', SMTP_HOST: 'postfix-mailcow', MAIL_TLS_SERVERNAME: 'mail.example.com',
  MAIL_TLS_MODE: 'verify', MAIL_TLS_PIN_FILE: '', DOMAIN: 'example.com', TRUST_PROXY: '192.0.2.0/24',
  TRUSTED_SENDER_FILE: '', DOCKERAPI_URL: 'https://dockerapi:443', DOVEADM_URL: '', DOVEADM_KEY: '', RELAY_FILES: '',
  MAILCOW_IPV4_NETWORK: '192.0.2', MAILCOW_IPV6_NETWORK: '2001:db8::/64', AUTOEXPUNGE_DAYS: '30',
  LOGO_DIR: '', AUDIT_DIR: '/data/audit', LOG_LEVEL: 'silent',
};
const query = { source: 'postfix', from: '2026-10-21T00:00:00+09:00', to: '2026-10-21T01:00:00+09:00' };
const coverage = source => ({ source, oldest: '2026-10-20T15:00:00.000Z', newest: '2026-10-20T16:00:00.000Z', gaps: [] });
const searchResult = () => ({ source: 'postfix', lines: [{ id: 'private-id', time: '2026-10-20T15:30:00.000Z', program: 'postfix/smtpd', priority: '', message: 'sender@example.com 2001:db8::7 [a+b].*', private: 'synthetic-excluded' }], nextCursor: null, partialReason: null, incomplete: false, coverage: coverage('postfix') });
const statusResult = () => ({ generations: [{ source: 'postfix', pendingBytes: 0, path: '/synthetic-private-source', generation: 'private-generation' }], issues: [], collectionLagSeconds: 3, backfillComplete: true });
function fixture(overrides = {}) {
  const calls = [], data = { search: searchResult(), status: statusResult(), coverage: { sources: [coverage('postfix')] } };
  const logArchive = { enabled: true, ...Object.fromEntries(['search', 'status', 'coverage'].map(name => [name, async args => { calls.push([name, args]); return structuredClone(data[name]); }])), ...overrides };
  return { calls, data, service: createLogsService({ config: {}, logArchive }), logArchive };
}
async function upstream(t, handler) {
  const calls = [], options = { status: 200, body: searchResult(), contentType: 'application/json' };
  const server = createServer((request, response) => {
    calls.push({ url: request.url, headers: request.headers });
    if (handler) return handler(request, response);
    response.writeHead(options.status, { 'content-type': options.contentType });
    response.end(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = { logArchiveUrl: `http://127.0.0.1:${server.address().port}`, logArchiveKey: key };
  return { server, config, calls, options, client: createLogArchiveClient({ config }) };
}

test('archive config: both absent or empty disables only archive; pair is normalized', () => {
  for (const extra of [{}, { LOG_ARCHIVE_URL: '', LOG_ARCHIVE_KEY: '' }]) {
    const config = loadAdminConfig({ ...env, ...extra });
    assert.equal(config.logArchiveUrl, ''); assert.equal(config.logArchiveKey, '');
    assert.equal(createLogArchiveClient({ config }).enabled, false);
  }
  const config = loadAdminConfig({ ...env, LOG_ARCHIVE_URL: 'http://log-archiver:8080/', LOG_ARCHIVE_KEY: key });
  assert.equal(config.logArchiveUrl, 'http://log-archiver:8080'); assert.equal(config.logArchiveKey, key);
  assert.equal(createLogArchiveClient({ config }).enabled, true);
});
for (const [extra, missing] of [[{ LOG_ARCHIVE_URL: 'http://log-archiver:8080' }, 'LOG_ARCHIVE_KEY'], [{ LOG_ARCHIVE_KEY: key }, 'LOG_ARCHIVE_URL']]) test(`archive config: incomplete pair fails safely for ${missing}`, () => {
  assert.throws(() => loadAdminConfig({ ...env, ...extra }), error => error.message.includes(missing) && !error.message.includes(key) && !error.message.includes('http://'));
});
for (const value of ['ftp://archive', 'http://user:secret@archive', 'http://archive/path', 'http://archive?key=secret', 'http://archive/#secret', ' http://archive ', 'nonsense', 3]) test(`archive config: rejects invalid URL ${value}`, () => {
  assert.throws(() => loadAdminConfig({ ...env, LOG_ARCHIVE_URL: value, LOG_ARCHIVE_KEY: key }), /LOG_ARCHIVE_URL/);
});
for (const value of [' secret', 'secret\n', 'secret\u0000', 3]) test(`archive config: rejects unsafe key ${JSON.stringify(value)}`, () => {
  assert.throws(() => loadAdminConfig({ ...env, LOG_ARCHIVE_URL: 'http://archive', LOG_ARCHIVE_KEY: value }), /LOG_ARCHIVE_KEY/);
});

test('archive client: fixed internal endpoints and custom header, 12s/2MiB limits', async t => {
  const f = await upstream(t);
  assert.equal(LOG_ARCHIVE_TIMEOUT_MS, 12_000); assert.equal(LOG_ARCHIVE_MAX_BYTES, 2 * 1024 * 1024);
  await f.client.search({ source: 'postfix', start: query.from, end: query.to, q: '[a+b].*', cursor: 'a+/=' });
  await f.client.status(); await f.client.coverage();
  const url = new URL(f.calls[0].url, 'http://synthetic');
  assert.equal(url.pathname, '/v1/search'); assert.equal(url.searchParams.get('start'), query.from);
  assert.equal(url.searchParams.get('cursor'), 'a+/='); assert.equal(url.searchParams.get('q'), '[a+b].*');
  assert.deepEqual(f.calls.slice(1).map(item => item.url), ['/v1/status', '/v1/coverage']);
  for (const call of f.calls) { assert.equal(call.headers['x-log-archive-key'], key); assert.equal(call.headers.authorization, undefined); assert.ok(!call.url.includes(key)); }
});
for (const [status, expected, code] of [[403, 503, 'LOG_ARCHIVE_UNAVAILABLE'], [401, 503, 'LOG_ARCHIVE_UNAVAILABLE'], [404, 503, 'LOG_ARCHIVE_UNAVAILABLE'], [500, 503, 'LOG_ARCHIVE_UNAVAILABLE'], [410, 410, 'ARCHIVE_SEARCH_RESTART'], [422, 422, 'INVALID_INPUT'], [429, 429, 'LOG_QUERY_BUSY']]) test(`archive client: upstream ${status} maps to ${expected} with safe errors`, async t => {
  const f = await upstream(t); f.options.status = status; f.options.body = `private upstream ${key} http://private-source/path`;
  const warnings = [], client = createLogArchiveClient({ config: f.config, logger: { warn: value => warnings.push(value) } });
  await assert.rejects(client.status(), error => error.statusCode === expected && error.code === code && !error.message.includes(key) && !error.message.includes('private-source'));
  assert.deepEqual(warnings, status === 403 ? ['보관기 인증 실패'] : []);
});
for (const body of ['{invalid', 'null', '[]']) test(`archive client: malformed success ${body} is unavailable`, async t => {
  const f = await upstream(t); f.options.body = body;
  await assert.rejects(f.client.status(), { statusCode: 503, code: 'LOG_ARCHIVE_UNAVAILABLE' });
});
test('archive client: unexpected content type is unavailable', async t => {
  const f = await upstream(t); f.options.contentType = 'text/html';
  await assert.rejects(f.client.status(), { statusCode: 503 });
});
test('archive client: oversized streamed response fails at 2MiB', async t => {
  const f = await upstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"value":"'); response.write('x'.repeat(LOG_ARCHIVE_MAX_BYTES)); response.end('"}');
  });
  await assert.rejects(f.client.status(), { statusCode: 503, code: 'LOG_ARCHIVE_UNAVAILABLE' });
});
test('archive client: wall timeout aborts stalled headers and stalled body', async t => {
  for (const headers of [false, true]) {
    const f = await upstream(t, (_request, response) => { if (headers) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); } });
    const client = createLogArchiveClient({ config: f.config, timeoutMs: 40 });
    const started = Date.now(); await assert.rejects(client.status(), { statusCode: 503 });
    assert.ok(Date.now() - started < 2000);
  }
});
test('archive client: connection failure is unavailable', async t => {
  const f = await upstream(t); await new Promise(resolve => f.server.close(resolve));
  await assert.rejects(f.client.status(), { statusCode: 503, code: 'LOG_ARCHIVE_UNAVAILABLE' });
});

test('archive service: absent configuration has explicit disabled responses', async () => {
  const service = createLogsService({ config: {} });
  assert.deepEqual(await service.archive(), { enabled: false, lines: [], cursor: null, partialReason: null, incomplete: false, coverage: null });
  assert.deepEqual(await service.archiveStatus(), { enabled: false, sources: [] });
});
test('archive service: from/to to start/end, safe projection and literal search', async () => {
  const f = fixture();
  const result = await f.service.archive({ ...query, q: '[a+b].*', limit: '1000', cursor: 'synthetic-cursor' });
  assert.deepEqual(f.calls, [['search', { source: 'postfix', start: query.from, end: query.to, q: '[a+b].*', limit: '1000', cursor: 'synthetic-cursor' }]]);
  assert.deepEqual(result, { enabled: true, lines: [{ time: '2026-10-20T15:30:00.000Z', source: 'postfix', program: 'postfix/smtpd', priority: '', message: 'sender@example.com 2001:db8::7 [a+b].*' }], cursor: null, partialReason: null, incomplete: false, coverage: coverage('postfix') });
  assert.equal((await f.service.archive({ ...query, q: 'SENDER@EXAMPLE.COM' })).lines.length, 1);
  assert.equal((await f.service.archive({ ...query, q: 'a+bZZ' })).lines.length, 0);
  assert.equal((await f.service.archive({ ...query, q: '2001:db8::7' })).lines.length, 1);
});
test('archive service: RFC3339 nanoseconds and KST month boundary retain upstream semantics', async () => {
  const f = fixture();
  for (const range of [
    { from: '2026-10-21T00:00:00.000000001+09:00', to: '2026-10-21T00:00:00.000000002+09:00' },
    { from: '2026-11-01T00:00:00+09:00', to: '2026-11-01T00:01:00+09:00' },
  ]) {
    await f.service.archive({ ...query, ...range });
    assert.equal(f.calls.at(-1)[1].start, range.from); assert.equal(f.calls.at(-1)[1].end, range.to);
  }
});
for (const extra of [{ source: '../postfix' }, { source: 'rspamd-history' }, { from: '2026-02-30T00:00:00+09:00' }, { from: '2026-10-21T00:00:00' }, { from: '2026-10-21T25:00:00+09:00' }, { from: '2026-10-21T00:00:00+25:00' }, { to: query.from }, { limit: '1001' }, { limit: '0' }, { limit: '1.5' }, { limit: '01' }, { q: '가'.repeat(201) }, { q: [] }, { cursor: '' }, { cursor: 'x'.repeat(4097) }, { extra: 'unknown' }, { source: 'nginx', to: '2026-10-23T00:00:00+09:00' }]) test(`archive service: rejects bad query ${JSON.stringify(extra).slice(0, 80)}`, async () => {
  const f = fixture(); await assert.rejects(f.service.archive({ ...query, ...extra }), { statusCode: 422 }); assert.equal(f.calls.length, 0);
});
test('archive service: preserves empty partial-page cursor, gap and incomplete distinctions', async () => {
  const f = fixture(); f.data.search.lines = []; f.data.search.nextCursor = 'next-snapshot-position'; f.data.search.incomplete = true;
  f.data.search.coverage.gaps = [{ from: query.from, to: query.to, reason: 'source-disappeared', private: 'synthetic-excluded' }];
  for (const partialReason of ['limit', 'response_bytes', 'scan_bytes', 'timeout']) {
    f.data.search.partialReason = partialReason; const result = await f.service.archive(query);
    assert.equal(result.cursor, 'next-snapshot-position'); assert.equal(result.partialReason, partialReason); assert.equal(result.incomplete, true); assert.deepEqual(result.lines, []);
    assert.deepEqual(result.coverage.gaps, [{ from: query.from, to: query.to, reason: 'source-disappeared' }]);
  }
});
test('archive service: reapplies sanitizer before search and only exposes approved fields', async () => {
  const f = fixture(), secret = 'SyntheticArchiveSecret987';
  f.data.search.lines[0] = { ...f.data.search.lines[0], message: `echo ${secret} --password1=${secret} *masked@mailcow.local`, password: secret, fields: { path: '/safe/path', ip: '192.0.2.7', nested: { password: secret }, subject: 'synthetic-private-subject', token: secret } };
  const result = await f.service.archive(query);
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('synthetic-private-subject')); assert.match(result.lines[0].message, /\*\*\*\*@mailcow.local/);
  assert.deepEqual(result.lines[0].fields, { path: '/safe/path', ip: '192.0.2.7' });
  assert.equal((await f.service.archive({ ...query, q: secret })).lines.length, 0);
});
test('archive service: A3 docker/access projection keeps canaries out of responses and searches', async () => {
  const f = fixture(), secret = 'SyntheticPrivateCanary987';
  const raw = [
    JSON.stringify({ time: '2026-10-20T15:30:00Z', log: JSON.stringify({ message: `echo ${secret}`, password: secret, nested: { token: secret }, headers: { cookie: secret }, subject: secret, body: secret, path: `/safe?token=${secret}`, ip: '2001:db8::7' }) }),
    JSON.stringify({ time: '2026-10-20T15:30:00Z', log: `Authorization: Bearer ${secret}` }),
    JSON.stringify({ time: '2026-10-20T15:30:00Z', log: `--password1=${secret} *masked@mailcow.local` }),
    `192.0.2.7 - - [21/Oct/2026:00:30:00 +0900] "GET /safe?secret=${secret} HTTP/1.1" 200 12`,
  ];
  f.data.search.lines = raw.map((line, i) => projectLine(line, { source: 'postfix' }, String(i)));
  const result = await f.service.archive(query);
  assert.equal(result.lines.length, 4); assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('*masked@mailcow.local'));
  assert.equal((await f.service.archive({ ...query, q: secret })).lines.length, 0);
  assert.equal((await f.service.archive({ ...query, q: '192.0.2.7' })).lines.length, 1);
});
test('archive status: source coverage and source-local backfill, safe reasons without paths', async () => {
  const f = fixture(); f.data.coverage.sources = ['postfix', 'dovecot', 'webmail', 'nginx'].map(coverage);
  f.data.status.generations.push({ source: 'dovecot', pendingBytes: 5 }, { source: 'nginx', pendingBytes: 0 });
  f.data.status.issues.push({ source: 'nginx', reason: 'source-read-error', path: '/synthetic-private-path', instance: 'synthetic-private-id' });
  const result = await f.service.archiveStatus();
  assert.deepEqual(result.sources.map(row => [row.source, row.backfillComplete, row.issues, row.lagSeconds]), [['postfix', true, [], 3], ['dovecot', false, [], 3], ['webmail', false, [], 3], ['nginx', false, ['source-read-error'], 3]]);
  assert.equal(result.enabled, true); assert.ok(!JSON.stringify(result).includes('private')); assert.equal(result.sources[0].oldest, coverage('postfix').oldest);
});
test('archive status: fetches status and coverage in parallel', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const calls = [];
  const f = fixture({ async status() { calls.push('status'); await gate; return statusResult(); }, async coverage() { calls.push('coverage'); release(); return { sources: [coverage('postfix')] }; } });
  await f.service.archiveStatus(); assert.deepEqual(calls, ['status', 'coverage']);
});
for (const mutate of [data => { data.search.lines = 'bad'; }, data => { data.search.lines[0].time = {}; }, data => { data.search.coverage.source = 'dovecot'; }, data => { data.search.nextCursor = 4; }, data => { data.search.partialReason = 'unknown'; }, data => { data.search.incomplete = 'false'; }, data => { data.search.coverage.gaps = null; }]) test('archive service: malformed upstream search is unavailable, never empty success', async () => {
  const f = fixture(); mutate(f.data); await assert.rejects(f.service.archive(query), { statusCode: 503 });
});
for (const mutate of [data => { data.status.generations = null; }, data => { data.status.generations[0].pendingBytes = -1; }, data => { data.status.collectionLagSeconds = -1; }, data => { data.status.issues = [{ source: 'postfix' }]; }, data => { data.coverage.sources = null; }]) test('archive service: malformed upstream status is unavailable', async () => {
  const f = fixture(); mutate(f.data); await assert.rejects(f.service.archiveStatus(), { statusCode: 503 });
});

async function appFixture(t, { state = 'ready', enabled = true, upstreamHandler } = {}) {
  const remote = await upstream(t, upstreamHandler ?? ((request, response) => {
    const url = new URL(request.url, 'http://synthetic');
    response.writeHead(remote.options.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(remote.options.status !== 200 ? { error: { message: key } } : url.pathname === '/v1/status' ? statusResult() : url.pathname === '/v1/coverage' ? { sources: [coverage('postfix')] } : remote.options.body));
  }));
  const directory = await mkdtemp(join(tmpdir(), 'admin-log-archive-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 9, 21), logs = '';
  const calls = [], options = {};
  const client = {
    async login({ username }) { return { state, username }; }, async logout() {},
    createApiContext({ permission }) { return { permission }; },
    async call(_session, _method, path) { calls.push(path); if (options.authLost) throw new MailcowAuthLost(); return path === '/api/v1/get/status/version' ? { version: 'synthetic' } : [{ time: '1', message: 'recent line' }]; },
  };
  const config = { ...loadAdminConfig(env), ...(enabled ? remote.config : {}), apiKeyDir: join(directory, 'keys'), auditDir: join(directory, 'audit'), mailcowApiKey: 'synthetic-mailcow-key', ftsNightly: { enabled: false, start: '03:00', end: '06:00', stateDir: join(directory, 'fts') } };
  const app = await createAdminApp({ config, logger: { level: 'info', stream: { write: chunk => { logs += chunk; } } }, staticDir: '/nonexistent-archive-fixture', auth: { client, now: () => clock } });
  t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic-password' } });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0] };
  const urls = ['/api/admin/logs/archive?' + new URLSearchParams(query), '/api/admin/logs/archive/status'];
  return { app, remote, options, calls, urls, headers, config, advance: ms => { clock += ms; }, get logs() { return logs; } };
}
for (const state of ['ready', 'totp']) test(`archive HTTP: no login and ${state} session guard both endpoints`, async t => {
  const f = await appFixture(t, { state });
  for (const url of f.urls) {
    const missing = await f.app.inject(url); assert.equal(missing.statusCode, 403); assert.equal(missing.headers['www-authenticate'], undefined);
    const response = await f.app.inject({ url, headers: f.headers }); assert.equal(response.statusCode, state === 'ready' ? 200 : 403, response.body);
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['www-authenticate'], undefined);
    assert.ok(!response.body.includes(key)); assert.ok(!response.body.includes(f.config.logArchiveUrl));
  }
  if (state === 'totp') assert.equal(f.remote.calls.length, 0);
  else assert.equal(f.calls.filter(path => path === '/api/v1/get/status/version').length, 2);
  assert.equal((await f.app.inject('/healthz')).statusCode, 200);
  assert.ok(!f.logs.includes(key)); assert.ok(!f.logs.includes(f.config.logArchiveUrl));
});
for (const mode of ['mailcow-lost', 'expired']) test(`archive HTTP: ${mode} session denied before archive access`, async t => {
  const f = await appFixture(t);
  if (mode === 'mailcow-lost') f.options.authLost = true; else f.advance(61 * 60 * 1000);
  for (const url of f.urls) assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 403);
  assert.equal(f.remote.calls.length, 0);
});
test('archive HTTP: read-only API keys use existing guard and probe, invalid keys denied', async t => {
  const f = await appFixture(t);
  const issued = await f.app.apiKeys.create({ name: 'synthetic reader', permission: 'read', allowedIps: [], expiresAt: null }, 'synthetic-admin', { id: f.app.apiKeys.allocateId() });
  const headers = { 'x-mailadmin-api-key': issued.token };
  for (const url of f.urls) {
    assert.equal((await f.app.inject({ url, headers })).statusCode, 200);
    assert.equal((await f.app.inject({ url, headers: { 'x-mailadmin-api-key': 'bad' } })).statusCode, 403);
  }
  assert.equal(f.calls.filter(path => path === '/api/v1/get/status/version').length, 2);
  f.options.authLost = true;
  assert.equal((await f.app.inject({ url: f.urls[0], headers })).statusCode, 403);
  assert.ok(!f.logs.includes(issued.token));
});
test('archive HTTP: upstream authentication/down failure is 503, recent logs unaffected', async t => {
  const f = await appFixture(t);
  for (const status of [403, 500]) {
    f.remote.options.status = status;
    for (const url of f.urls) {
      const response = await f.app.inject({ url, headers: f.headers });
      assert.equal(response.statusCode, 503, response.body); assert.equal(response.json().error.code, 'LOG_ARCHIVE_UNAVAILABLE');
      assert.ok(!response.body.includes(key));
    }
    assert.equal((await f.app.inject({ url: '/api/admin/logs?kind=postfix&n=1000', headers: f.headers })).statusCode, 200);
  }
  assert.match(f.logs, /보관기 인증 실패/); assert.ok(!f.logs.includes(key));
});
test('archive HTTP: disabled feature preserves recent logs; 410 restart and 429 retry contracts', async t => {
  const disabled = await appFixture(t, { enabled: false });
  for (const url of disabled.urls) { const response = await disabled.app.inject({ url, headers: disabled.headers }); assert.equal(response.statusCode, 200); assert.equal(response.json().enabled, false); }
  assert.equal(disabled.remote.calls.length, 0);
  assert.equal((await disabled.app.inject({ url: '/api/admin/logs?kind=postfix', headers: disabled.headers })).statusCode, 200);
  const f = await appFixture(t);
  f.remote.options.status = 410;
  const restart = await f.app.inject({ url: f.urls[0], headers: f.headers });
  assert.equal(restart.statusCode, 410); assert.equal(restart.json().error.code, 'ARCHIVE_SEARCH_RESTART');
  f.remote.options.status = 429;
  const busy = await f.app.inject({ url: f.urls[0], headers: f.headers });
  assert.equal(busy.statusCode, 429); assert.equal(busy.headers['retry-after'], '1');
});

for (const endpoint of ['search', 'status']) for (const bodyStarted of [false, true]) test(`archive HTTP: browser disconnect cancels ${endpoint} upstream within 250ms (body=${bodyStarted})`, { timeout: 5000 }, async t => {
  const expected = endpoint === 'search' ? 1 : 2, arrived = Promise.withResolvers(), closed = Promise.withResolvers();
  let requests = 0, closures = 0;
  const f = await appFixture(t, { upstreamHandler: (_request, response) => {
    response.once('close', () => { if (++closures === expected) closed.resolve(); });
    if (bodyStarted) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); }
    if (++requests === expected) arrived.resolve();
  } });
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
  const browser = httpRequest(address + f.urls[endpoint === 'search' ? 0 : 1], { headers: f.headers });
  browser.on('error', () => {});
  t.after(() => browser.destroy());
  browser.end();
  await arrived.promise;
  const started = performance.now();
  const timer = setTimeout(() => closed.reject(new Error('upstream remained open for 250ms after browser disconnect')), 250);
  browser.destroy();
  try { await closed.promise; }
  finally { clearTimeout(timer); }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `upstream closed after ${elapsed}ms`);
  assert.equal(requests, expected);
  t.diagnostic(`upstream ${endpoint}: ${closures} connection(s) closed in ${elapsed.toFixed(1)}ms`);
});

test('archive HTTP: completed incoming GET keeps upstream alive until its normal response', async t => {
  const f = await appFixture(t);
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
  for (const url of f.urls) {
    const result = await new Promise((resolve, reject) => {
      const browser = httpRequest(address + url, { headers: f.headers }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      });
      browser.once('error', reject); browser.end();
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.enabled, true);
  }
});
