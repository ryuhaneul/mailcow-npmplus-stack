import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createDockerApi } from '../../server/admin/dockerapi.js';
import { createSharesService, groupMailboxAddresses } from '../../server/admin/services/shares.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock, etag } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';
import { logOptions } from '../../server/log.js';

const owner = 'team@example.com', grantee = 'user@example.com', other = 'other@example.com';
const secret = 'synthetic-container-env-secret';
let cert, key, tlsDir;
before(async () => {
  tlsDir = await fs.mkdtemp(join(tmpdir(), 'webmail-a05-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem'), '-days', '1', '-subj', '/CN=dockerapi', '-addext', 'subjectAltName=DNS:dockerapi,IP:127.0.0.1'], { stdio: 'ignore' });
  cert = await fs.readFile(join(tlsDir, 'cert.pem')); key = await fs.readFile(join(tlsDir, 'key.pem'));
});
after(() => fs.rm(tlsDir, { recursive: true, force: true }));

async function fakeApi(t, options = {}) {
  const calls = [], acl = new Map();
  const inspect = { abc123: { Id: 'abc123', Name: '/synthetic-dovecot', Config: { Labels: { 'com.docker.compose.service': 'dovecot-mailcow' }, Env: [`PASSWORD=${secret}`] }, Env: [secret] },
    def456: { Id: 'def456', Name: '/synthetic-db', Config: { Labels: { 'com.docker.compose.service': 'mysql-mailcow' }, Env: [secret] } } };
  const server = https.createServer({ key, cert }, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null; calls.push({ path: req.url, method: req.method, body, headers: req.headers });
    if (options.hang) return;
    if (options.status) res.statusCode = options.status;
    if (options.raw !== undefined) return res.end(options.raw);
    if (options.large) return res.end('x'.repeat(2 * 1024 * 1024 + 1));
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/containers/json') return json(options.inspect ?? inspect);
    if (req.url !== '/containers/abc123/exec') { res.statusCode = 404; return res.end(); }
    if (options.execData !== undefined) return json(options.execData);
    if (body.task === 'get_acl') return json([...acl.entries()].filter(([name]) => name.startsWith(body.id + '|')).map(([name, rights]) => ({ user: body.id, id: name.split('|')[1], mailbox: 'INBOX', rights, Env: [secret] })));
    const name = `${body.user}|${body.id}`;
    if (!options.ignoreWrites) {
      if (body.task === 'set_acl') acl.set(name, body.rights);
      if (body.task === 'delete_acl') acl.delete(name);
    }
    return json({ type: 'success', msg: 'Task completed', Env: [secret] });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const config = { dockerapiUrl: `https://127.0.0.1:${server.address().port}` };
  return { calls, acl, options, config, server, client: createDockerApi({ config, ca: cert }) };
}

async function fixture(t, options = {}) {
  const fake = await fakeApi(t, options);
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a05-audit-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const audit = createAudit({ dir }); const lock = createResourceLock(); const history = createHistoryService({ audit, lock });
  const mailCalls = [];
  const boxes = [owner, grantee, other].map(username => ({ username, name: username === owner ? '팀' : '개인', active: 1, password: secret }));
  const filters = [{ username: owner, filter_type: 'prefilter', active: 1, script_data: 'redirect :copy "user@example.com";' }];
  const mailcow = { async call(_session, method, path) {
    mailCalls.push({ method, path });
    if (path === '/api/v1/get/mailbox/all') return boxes;
    if (path === '/api/v1/get/filters/all') return filters;
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    throw new Error('Unexpected mailcow path');
  } };
  const service = createSharesService({ mailcow, dockerapi: fake.client, audit, lock, history });
  return { ...fake, dir, audit, lock, history, mailcow, mailCalls, boxes, filters, service };
}
async function ownerItem(f) { return (await f.service.list({})).items.find(row => row.owner === owner); }
function change(f, expected, grant = true, changes = {}) { return f.service.change({ session: {}, actor: 'admin', ip: '198.51.100.9', owner, grantee, etag: expected, grant, ...changes }); }

test('dockerapi: three ACL task bodies match Toolkit and response projection drops inspect Env', async t => {
  const f = await fakeApi(t);
  assert.deepEqual(await f.client.getAcl(owner), []);
  assert.deepEqual(await f.client.setAcl(owner, grantee), { type: 'success' });
  assert.deepEqual(await f.client.getAcl(owner), [{ user: owner, id: grantee, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
  assert.deepEqual(await f.client.deleteAcl(owner, grantee), { type: 'success' });
  const commands = f.calls.filter(call => call.method === 'POST');
  assert.deepEqual(commands.map(call => call.body), [
    { cmd: 'doveadm', task: 'get_acl', id: owner },
    { cmd: 'doveadm', task: 'set_acl', user: owner, mailbox: 'INBOX', id: grantee, rights: ['lookup', 'read'] },
    { cmd: 'doveadm', task: 'get_acl', id: owner },
    { cmd: 'doveadm', task: 'delete_acl', user: owner, mailbox: 'INBOX', id: grantee },
  ]);
  assert.ok(f.calls.every(call => ['/containers/json', '/containers/abc123/exec'].includes(call.path)));
  assert.ok(f.calls.every(call => !call.headers.authorization));
});

for (const task of ['restart', 'sieve', 'exec', 'postcat', 'constructor', '__proto__']) test(`dockerapi: task ${task} denied before any network request`, async t => {
  const f = await fakeApi(t);
  await assert.rejects(f.client.call(task, owner, grantee), { statusCode: 422, code: 'DOCKERAPI_TASK_NOT_ALLOWED' }); assert.equal(f.calls.length, 0);
});

for (const mode of ['array', 'key-id', 'top-labels']) test(`dockerapi: container lookup accepts Toolkit ${mode} inspect shape`, async t => {
  const f = await fakeApi(t);
  const row = { Id: 'abc123', Config: { Labels: { 'com.docker.compose.service': 'dovecot-mailcow' } } };
  if (mode === 'array') f.options.inspect = [row];
  if (mode === 'key-id') { delete row.Id; f.options.inspect = { abc123: row }; }
  if (mode === 'top-labels') { row.Labels = row.Config.Labels; delete row.Config; f.options.inspect = { abc123: row }; }
  assert.deepEqual(await f.client.getAcl(owner), []);
});

for (const [name, options] of [
  ['missing dovecot', { inspect: {} }], ['invalid id', { inspect: { bad: { Id: '../bad', Labels: { 'com.docker.compose.service': 'dovecot-mailcow' } } } }],
  ['forbidden', { status: 403 }], ['redirect', { status: 302 }], ['invalid JSON', { raw: '<html>error</html>' }],
  ['oversized', { large: true }], ['bad ACL', { execData: { type: 'error', msg: secret } }],
]) test(`dockerapi: ${name} returns sanitized rejection`, async t => {
  const f = await fakeApi(t, options);
  await assert.rejects(f.client.getAcl(owner), error => error.statusCode === 502 && error.code === 'DOCKERAPI_REJECTED' && !error.message.includes(secret));
});

test('dockerapi: non-dockerapi hostname requires TLS verification, injected CA enables fake server', async t => {
  const f = await fakeApi(t);
  await assert.rejects(createDockerApi({ config: f.config }).getAcl(owner), { statusCode: 503, code: 'DOCKERAPI_UNAVAILABLE' });
  assert.equal(f.calls.length, 0); assert.deepEqual(await f.client.getAcl(owner), []);
});

test('dockerapi: write failure and malformed rights never pass through backend detail', async t => {
  const f = await fakeApi(t); f.options.execData = { type: 'danger', msg: secret };
  await assert.rejects(f.client.setAcl(owner, grantee), { statusCode: 502, code: 'DOCKERAPI_REJECTED' });
  f.options.execData = [{ user: owner, id: grantee, mailbox: 'INBOX', rights: 'lookup read' }];
  await assert.rejects(f.client.getAcl(owner), { code: 'DOCKERAPI_REJECTED' });
});

test('dockerapi: malformed mailbox inputs do not contact backend', async t => {
  const f = await fakeApi(t);
  for (const [who, user] of [['*', grantee], [owner, owner], [owner, 'bad\n@example.com']]) await assert.rejects(f.client.setAcl(who, user), { statusCode: 422 });
  assert.equal(f.calls.length, 0);
});

test('shares: group detection matches Toolkit and excludes inactive/postfilter/nonredirect rows', () => {
  const rows = [
    { username: owner, filter_type: 'prefilter', active: '1', script_data: 'redirect :copy "user@example.com";' },
    { username: grantee, filter_type: 'prefilter', active: 0, script_data: 'redirect' },
    { username: other, filter_type: 'postfilter', active: 1, script_data: 'redirect' },
  ];
  assert.deepEqual([...groupMailboxAddresses(rows)], [owner]);
});

test('shares: active mailbox listing, group flags, pagination and search project no secrets', async t => {
  const f = await fixture(t); f.boxes.push({ username: 'disabled@example.com', active: 0 });
  f.acl.set(`${owner}|${grantee}`, ['lookup', 'read']);
  const list = await f.service.list({}); assert.equal(list.total, 3); assert.equal(list.pageSize, 50);
  const item = list.items.find(row => row.owner === owner); assert.equal(item.group, true); assert.deepEqual(item.grantees, [grantee]); assert.match(item.etag, /^[a-f0-9]{64}$/);
  assert.equal((await f.service.list({}, { q: '팀' })).total, 1); assert.equal((await f.service.list({}, { page: '2' })).items.length, 0);
  assert.ok(!JSON.stringify(list).includes(secret)); assert.ok(!JSON.stringify(list).includes('Env'));
});

test('shares: grant and revoke create config records, preserve other ACLs and support reverts', async t => {
  const f = await fixture(t); f.acl.set(`${owner}|${other}`, ['admin', 'lookup', 'read']);
  let item = await ownerItem(f);
  const added = await change(f, item.etag); assert.equal(added.applied, true); assert.deepEqual(added.grantees, [other, grantee]);
  let records = (await f.history.list()).items; assert.equal(records.length, 1); assert.equal(records[0].action, 'share.grant'); assert.equal(records[0].kind, 'config'); assert.equal(records[0].canRevert, true);
  assert.deepEqual(records[0].before.grants, [{ grantee: other, rights: ['admin', 'lookup', 'read'] }]);
  await f.history.revert(records[0].id, { confirm: true, session: {}, actor: 'admin', ip: '198.51.100.9' });
  assert.equal(f.acl.has(`${owner}|${grantee}`), false); assert.deepEqual(f.acl.get(`${owner}|${other}`), ['admin', 'lookup', 'read']);
  item = await ownerItem(f); await change(f, item.etag);
  item = await ownerItem(f); await change(f, item.etag, false);
  records = (await f.history.list()).items; const removed = records.find(row => row.action === 'share.revoke');
  await f.history.revert(removed.id, { confirm: true, session: {}, actor: 'admin', ip: '198.51.100.9' });
  assert.deepEqual(f.acl.get(`${owner}|${grantee}`), ['lookup', 'read']);
  const audit = await fs.readFile(join(f.dir, (await fs.readdir(f.dir))[0]), 'utf8'); assert.ok(!audit.includes(secret)); assert.ok(!audit.includes('Env'));
});

for (const grant of [true, false]) test(`shares: different existing rights block grant=${grant} before changes or records`, async t => {
  const f = await fixture(t); f.acl.set(`${owner}|${grantee}`, ['lookup', 'read', 'write']);
  const item = await ownerItem(f);
  await assert.rejects(change(f, item.etag, grant), { statusCode: 409, code: 'ACL_UNSUPPORTED' });
  assert.equal(f.calls.filter(call => call.body?.task === 'set_acl' || call.body?.task === 'delete_acl').length, 0);
  assert.equal((await f.audit.read()).rows.length, 0);
});

test('shares: etag checked before idempotent success, which performs no write or audit', async t => {
  const f = await fixture(t); let item = await ownerItem(f);
  await assert.rejects(change(f, undefined, false), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  const absent = await change(f, item.etag, false); assert.equal(absent.unchanged, true);
  await change(f, item.etag); item = await ownerItem(f);
  await assert.rejects(change(f, 'outdated'), { code: 'CHANGED_ELSEWHERE' });
  const present = await change(f, item.etag); assert.equal(present.unchanged, true);
  assert.equal((await f.history.list()).total, 1);
});

test('shares: rejects same, unknown or inactive mailboxes without invoking ACL changes', async t => {
  const f = await fixture(t); const item = await ownerItem(f);
  for (const changes of [{ grantee: owner }, { grantee: 'missing@example.com' }, { owner: 'missing@example.com' }]) await assert.rejects(change(f, item.etag, true, changes), { statusCode: 422 });
  f.boxes.find(row => row.username === grantee).active = 2;
  await assert.rejects(change(f, item.etag), { statusCode: 422 });
  assert.equal((await f.audit.read()).rows.length, 0);
});

test('shares: ignores received shares and non-INBOX grants when building owner snapshot', async t => {
  const audit = { run: async () => assert.fail('not a write') }; const history = { register() {} };
  const dockerapi = { async getAcl() { return [
    { user: owner, id: grantee, mailbox: 'INBOX', rights: ['read', 'lookup'] },
    { user: other, id: owner, mailbox: 'INBOX', rights: ['read', 'lookup'] },
    { user: owner, id: other, mailbox: 'Sent', rights: ['lookup', 'read'] },
  ]; } };
  const service = createSharesService({ mailcow: { async call(_session, _method, path) { return path.endsWith('mailbox/all') ? [{ username: owner, active: 1 }] : []; } }, dockerapi, audit, lock: createResourceLock(), history });
  const item = (await service.list({})).items[0]; assert.deepEqual(item.grantees, [grantee]);
});

test('shares: failed post-write verification is recorded as failure', async t => {
  const f = await fixture(t); f.options.ignoreWrites = true; const item = await ownerItem(f);
  await assert.rejects(change(f, item.etag), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
  const record = (await f.history.list()).items[0]; assert.equal(record.result, 'failed'); assert.equal(record.code, 'WRITE_VERIFY_FAILED');
});

test('shares: concurrent requests with the same snapshot serialize; stale request performs no write', async t => {
  const f = await fixture(t); const item = await ownerItem(f);
  const results = await Promise.allSettled([change(f, item.etag), change(f, item.etag, true, { grantee: other })]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'CHANGED_ELSEWHERE');
  assert.equal(f.calls.filter(call => call.body?.task === 'set_acl').length, 1);
});

test('shares: revert adapter rechecks expected snapshot and only changes the recorded grantee', async t => {
  const f = await fixture(t); const item = await ownerItem(f); await change(f, item.etag);
  const record = (await f.history.list()).items[0];
  f.acl.set(`${owner}|${other}`, ['lookup', 'read']);
  await assert.rejects(f.history.revert(record.id, { confirm: true, session: {}, actor: 'admin', ip: '198.51.100.9' }), { code: 'CHANGED_ELSEWHERE' });
  assert.deepEqual(f.acl.get(`${owner}|${other}`), ['lookup', 'read']);
});

test('shares HTTP: common guard, CSRF, add/revoke and history operate without leaking Env', async t => {
  const f = await fixture(t); let logs = '';
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', sessionIdleMin: 60, sessionMaxHours: 8, trustProxy: ['192.0.2.0/24'], auditDir: f.dir },
    logger: { ...logOptions('info'), stream }, dockerapi: f.client, auth: { client: { ...f.mailcow, async login({ username }) { return { state: 'ready', username }; }, async logout() {} } } });
  t.after(() => app.close());
  assert.equal((await app.inject('/api/admin/shares')).statusCode, 403);
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic-login' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  let response = await app.inject({ url: '/api/admin/shares', headers }); assert.equal(response.statusCode, 200);
  const item = response.json().items.find(row => row.owner === owner);
  const url = `/api/admin/shares/${owner}`;
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-mailadmin-csrf': 'bad' }, payload: { grantee, etag: item.etag } })).statusCode, 403);
  response = await app.inject({ method: 'POST', url, headers, payload: { grantee, etag: item.etag } }); assert.equal(response.statusCode, 200, response.body);
  response = await app.inject({ method: 'DELETE', url, headers, payload: { grantee, etag: response.json().etag } }); assert.equal(response.statusCode, 200, response.body);
  const history = await app.inject({ url: '/api/admin/history', headers }); assert.equal(history.json().total, 2);
  for (const value of [response.body, history.body, logs]) { assert.ok(!value.includes(secret)); assert.ok(!value.includes('Env')); }
  assert.equal(response.headers['www-authenticate'], undefined); assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(f.mailCalls.some(call => call.path === '/api/v1/get/status/version'));
});

test('dockerapi: hanging request stops at the ten-second deadline', async t => {
  const f = await fakeApi(t, { hang: true }); const started = Date.now();
  await assert.rejects(f.client.getAcl(owner), { statusCode: 503, code: 'DOCKERAPI_UNAVAILABLE' });
  assert.ok(Date.now() - started >= 9500 && Date.now() - started < 12_000);
});
