import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createFiltersService, inspectRedirects } from '../../server/admin/services/filters.js';
import { createDockerApi } from '../../server/admin/dockerapi.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { SCRIPT_NAME } from '../../server/sieve/model.js';
import { AppError } from '../../server/errors.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';

const owner = 'owner@example.com', ctx = { session: {}, actor: 'admin', ip: '198.51.100.42', addr: owner };
const original = '# original-synthetic-sieve-marker\r\nrequire ["copy"];\r\nredirect :copy "keep@example.com";\r\n';
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a13-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const boxes = [{ username: owner, active: '1' }], filters = [{ id: '1', username: owner, filter_type: 'prefilter', active: '1', script_desc: '기존 설명', script_data: original }];
  const domains = [{ domain_name: 'example.com', active: '1' }, { domain_name: 'off.example.com', active: '0' }];
  const aliasDomains = [{ alias_domain: 'alias.example.com', target_domain: 'example.com', active: '1' }, { alias_domain: 'bad.example.com', target_domain: 'off.example.com', active: '1' }];
  const scripts = new Map([[owner, 'keep;\n']]), names = new Map([[owner, [{ name: SCRIPT_NAME, active: true }]]]), global = { prefilter: '# global before\nkeep;\n', postfilter: '# global after\nkeep;\n' };
  const calls = [], options = {}; let sequence = 10;
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); await options.onCall?.({ method, path, body });
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/mailbox/all') return structuredClone(boxes);
    if (path.startsWith('/api/v1/get/mailbox/')) return structuredClone(boxes.find(row => row.username === decodeURIComponent(path.split('/').at(-1))) ?? {});
    if (path.startsWith('/api/v1/get/filters/')) return structuredClone(filters.filter(row => row.username === decodeURIComponent(path.split('/').at(-1))));
    if (path === '/api/v1/get/domain/all') return structuredClone(domains);
    if (path === '/api/v1/get/alias-domain/all') return structuredClone(aliasDomains);
    if (path === '/api/v1/get/global_filters/all') return structuredClone(global);
    if (path.startsWith('/api/v1/get/active-user-sieve/')) { const value = scripts.get(decodeURIComponent(path.split('/').at(-1))); return value === undefined || value === null ? [] : [value]; }
    if (options.ignoreWrites) return [{ type: 'success' }];
    if (path === '/api/v1/edit/filter') Object.assign(filters.find(row => row.id === body.items[0]), body.attr);
    else if (path === '/api/v1/add/filter') filters.push({ id: String(sequence++), ...body });
    else assert.fail(path);
    return [{ type: 'success' }];
  } };
  const dockerapi = { async listSieve(address) { await options.onList?.(address); return structuredClone(names.get(address) ?? []); } };
  const audit = createAudit({ dir }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const service = createFiltersService({ mailcow, dockerapi, audit, lock, history, auditDir: dir });
  return { dir, boxes, filters, domains, aliasDomains, scripts, names, global, calls, options, mailcow, dockerapi, audit, history, service };
}
const item = async f => (await f.service.list({}, owner)).items[0];
const edit = (f, etag, script = 'discard;\n', extra = {}) => f.service.edit({ ...ctx, id: '1', data: { etag, script, ...extra } });
const create = (f, data = {}) => f.service.create({ ...ctx, data: { type: 'postfilter', preset: 'discard', ...data } });
const writes = f => f.calls.filter(row => row.method === 'POST');
const revert = (f, id) => f.history.revert(id, { ...ctx, confirm: true });

test('admin filters: JSON list, metadata-preserving edit and exact-byte reversal with 0600 backups', async t => {
  const f = await fixture(t), initial = await item(f); assert.equal(initial.script, original);
  const result = await edit(f, initial.etag, '# new-synthetic-sieve-marker\ndiscard;\n');
  assert.deepEqual(writes(f)[0].body.attr, { script_data: '# new-synthetic-sieve-marker\ndiscard;\n', script_desc: '기존 설명', active: '1', filter_type: 'prefilter' });
  const record = await f.history.detail(result.auditId); assert.equal(record.canRevert, true); assert.equal(record.before.bytes, Buffer.byteLength(original));
  for (const phase of ['before', 'after']) assert.equal((await fs.stat(join(f.dir, 'filter-backups', `${result.auditId}.${phase}.sieve`))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${result.auditId}.before.sieve`), 'utf8'), original);
  await revert(f, result.auditId); assert.equal(f.filters[0].script_data, original); assert.equal(writes(f).at(-1).body.attr.script_data, original);
  const jsonl = (await Promise.all((await fs.readdir(f.dir)).filter(file => file.endsWith('.jsonl')).map(file => fs.readFile(join(f.dir, file), 'utf8')))).join('');
  assert.ok(!jsonl.includes('original-synthetic-sieve-marker')); assert.ok(!jsonl.includes('new-synthetic-sieve-marker')); assert.ok(!jsonl.includes('redirect :copy')); assert.equal(record.after.script, undefined);
});
for (const source of ['redirect "keep@example.com";\n', 'if header :contains "Subject" "x" { redirect "keep@example.com"; }']) test(`admin filters: moving redirect needs confirmation ${source}`, async t => {
  const f = await fixture(t); await assert.rejects(edit(f, (await item(f)).etag, source), { statusCode: 422, code: 'MOVE_CONFIRM' }); assert.equal(writes(f).length, 0);
  assert.equal((await edit(f, (await item(f)).etag, source, { confirmMove: true })).script, source);
});
for (const target of ['outside@example.net', 'person@off.example.com', 'person@bad.example.com']) test(`admin filters: rejects external/inactive redirect ${target}`, async t => {
  const f = await fixture(t); await assert.rejects(edit(f, (await item(f)).etag, `redirect :copy "${target}";`), { statusCode: 422, code: 'EXTERNAL_REDIRECT' }); assert.equal(writes(f).length, 0);
});
test('admin filters: active alias domain is internal and apparent redirect in comments/strings is ignored', async t => {
  const f = await fixture(t), source = '# redirect "outside@example.net";\n/* redirect "outside@example.net"; */\nif header :contains "Subject" "redirect outside@example.net" { redirect :copy "person@alias.example.com"; }';
  assert.equal((await edit(f, (await item(f)).etag, source)).script, source);
});
for (const source of ['redirect "${target}";', 'set "value" "${unknown}"; keep;', 'redirect :list "office";', 'redirect text:\nkeep@example.com\n.\n;', 'redirect :unknown "keep@example.com";', 'redirect "unterminated']) test(`admin filters: unsafe inspection rejected ${source}`, async t => {
  const f = await fixture(t); await assert.rejects(edit(f, (await item(f)).etag, source, { confirmMove: true }), { statusCode: 422, code: 'FILTER_UNINSPECTABLE' }); assert.equal(writes(f).length, 0);
});
test('admin filters: missing/stale filter and unchanged edits', async t => {
  const f = await fixture(t), initial = await item(f); await assert.rejects(edit(f, 'stale'), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  assert.equal((await edit(f, initial.etag, original)).unchanged, true); assert.equal(writes(f).length, 0);
  await assert.rejects(f.service.edit({ ...ctx, id: '99', data: { etag: initial.etag, script: 'keep;' } }), { statusCode: 404 });
});
for (const failure of ['changed', 'missing-backup']) test(`admin filters: undo ${failure} is 409`, async t => {
  const f = await fixture(t), result = await edit(f, (await item(f)).etag);
  if (failure === 'changed') f.filters[0].script_data += '# external change\n'; else await fs.rm(join(f.dir, 'filter-backups', `${result.auditId}.before.sieve`));
  await assert.rejects(revert(f, result.auditId), { statusCode: 409, code: failure === 'changed' ? 'CHANGED_ELSEWHERE' : 'NOT_REVERTIBLE' }); assert.equal(writes(f).length, 1);
});
for (const source of ['redirect :copy "outside@example.net";', 'redirect "${unknown}";']) test(`admin filters: cleaning unsafe Before disables reversal ${source}`, async t => {
  const f = await fixture(t); f.filters[0].script_data = source; const result = await edit(f, (await item(f)).etag), record = await f.history.detail(result.auditId);
  assert.equal(record.revertible, false); assert.ok(record.detail.reason.includes('이전 원문')); await assert.rejects(revert(f, result.auditId), { statusCode: 409, code: 'NOT_REVERTIBLE' });
});
test('admin filters: undo rechecks current domain policy and move rollback uses confirmation', async t => {
  const f = await fixture(t); f.filters[0].script_data = 'redirect "keep@example.com";\r\n'; const moving = f.filters[0].script_data;
  const result = await edit(f, (await item(f)).etag); await revert(f, result.auditId); assert.equal(f.filters[0].script_data, moving);
  const next = await edit(f, (await item(f)).etag); f.domains[0].active = '0'; await assert.rejects(revert(f, next.auditId), { statusCode: 422, code: 'EXTERNAL_REDIRECT' });
});
test('admin filters: discard/custom create, active duplicate guard and non-revertible creation', async t => {
  const f = await fixture(t), result = await create(f); assert.equal(result.script, 'discard;\n'); assert.equal(result.type, 'postfilter'); assert.equal((await f.history.detail(result.auditId)).revertible, false);
  await assert.rejects(create(f), { statusCode: 409, code: 'FILTER_EXISTS' });
  f.filters.find(row => row.id === result.id).active = '0'; const custom = await create(f, { preset: 'custom', script: 'keep;\n' }); assert.equal(custom.script, 'keep;\n');
  assert.equal(writes(f).at(-1).body.active, '1'); assert.equal(writes(f).at(-1).body.script_desc, '관리자 필터');
});
test('admin filters: custom creation applies the same copy/move and external policy', async t => {
  const f = await fixture(t); await assert.rejects(create(f, { preset: 'custom', script: 'redirect "keep@example.com";' }), { code: 'MOVE_CONFIRM' });
  await assert.rejects(create(f, { preset: 'custom', script: 'redirect :copy "outside@example.net";' }), { code: 'EXTERNAL_REDIRECT' });
  assert.equal((await create(f, { preset: 'custom', script: 'redirect "keep@example.com";', confirmMove: true })).type, 'postfilter');
});
test('admin filters: post-write mismatch is 502; backup/intent failure prevents mutation', async t => {
  const f = await fixture(t); f.options.ignoreWrites = true; await assert.rejects(edit(f, (await item(f)).etag), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
  f.options.ignoreWrites = false; await fs.rm(f.dir, { recursive: true }); await fs.writeFile(f.dir, 'synthetic-blocker'); const count = writes(f).length;
  await assert.rejects(edit(f, (await item(f)).etag), { statusCode: 500, code: 'AUDIT_UNAVAILABLE' }); assert.equal(writes(f).length, count);
});
for (const [index, source] of [
  'redirect "outside@example.net";',
  'require ["copy"]; redirect :copy "outside@example.net";',
  'if header :contains "Subject" "x" { redirect :copy "outside@example.net"; }',
  'redirect :copy ["keep@example.com", "outside@example.net"];',
].entries()) test(`filter checks: finds external user redirect case ${index + 1}`, async t => {
  const f = await fixture(t); f.scripts.set(owner, source); const result = await f.service.checks({});
  assert.deepEqual(result.external, [{ address: owner, targets: ['outside@example.net'] }]); assert.equal(result.checked, 1); assert.equal(result.uninspectable.length, 0); assert.equal(result.failed.length, 0);
});
test('filter checks: non-webmail name, uninspectable script, and exact Dovecot order are separate read-only results', async t => {
  const f = await fixture(t); f.names.set(owner, [{ name: 'rainloop.user', active: true }, { name: SCRIPT_NAME, active: false }]); f.scripts.set(owner, 'redirect "${unknown}";');
  const result = await f.service.checks({}); assert.deepEqual(result.nonWebmail, [{ address: owner, activeName: 'rainloop.user' }]); assert.deepEqual(result.uninspectable, [{ address: owner, code: 'FILTER_UNINSPECTABLE' }]);
  assert.deepEqual(result.globalOrder.map(row => row.type), ['global-prefilter', 'admin-prefilter', 'active-user', 'admin-postfilter', 'global-postfilter']); assert.equal(result.globalOrder[0].script, f.global.prefilter); assert.equal(result.globalOrder[4].script, f.global.postfilter);
  assert.equal(writes(f).length, 0); assert.equal((await f.audit.read()).rows.length, 0);
});
test('filter checks: four workers cap calls and retain successful partial results with failed mailboxes', async t => {
  const f = await fixture(t); for (let i = 0; i < 10; i++) f.boxes.push({ username: i === 9 ? "o'brien@example.com" : `person${i}@example.com`, active: '1' });
  let active = 0, maximum = 0;
  const delay = async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 6)); active--; };
  f.options.onCall = async ({ path }) => { if (path.includes('/get/active-user-sieve/')) { await delay(); if (path.endsWith(encodeURIComponent('person3@example.com'))) throw new AppError(503, 'MAILCOW_UNAVAILABLE', '합성 실패'); } };
  f.options.onList = delay;
  const result = await f.service.checks({}); assert.equal(result.total, 11); assert.equal(result.checked, 10); assert.deepEqual(result.failed, [{ address: 'person3@example.com', code: 'MAILCOW_UNAVAILABLE' }]); assert.ok(maximum > 1); assert.ok(maximum <= 4, `concurrent calls=${maximum}`);
});
test('filter checks: authentication loss is propagated as 403, not a mailbox failure', async t => {
  const f = await fixture(t); f.options.onCall = ({ path }) => { if (path.includes('/get/active-user-sieve/')) throw new MailcowAuthLost(); };
  await assert.rejects(f.service.checks({}), { statusCode: 403, code: 'MAILCOW_SESSION_LOST' });
});
test('user filters: script/name only, empty script state supported, no download/write route or attachment header', async t => {
  const f = await fixture(t), marker = '# synthetic-user-script-marker\nkeep;\n', logLines = []; f.scripts.set(owner, marker);
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, dockerapi: f.dockerapi,
    logger: { level: 'info', stream: { write: line => logLines.push(line) } }, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  assert.equal((await app.inject(`/api/admin/user-filters/${owner}`)).statusCode, 403);
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  const response = await app.inject({ url: `/api/admin/user-filters/${owner}`, headers }); assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { address: owner, script: marker, activeName: SCRIPT_NAME });
  assert.equal(response.headers['content-disposition'], undefined); assert.match(response.headers['content-type'], /application\/json/); assert.equal(response.json().filename, undefined); assert.ok(!app.printRoutes().includes('download'));
  assert.equal((await app.inject({ url: `/api/admin/user-filters/${owner}/download`, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/admin/user-filters/${owner}`, headers, payload: { script: 'discard;' } })).statusCode, 404);
  const listed = await app.inject({ url: `/api/admin/filters/${owner}`, headers }); assert.equal(listed.statusCode, 200, listed.body);
  const updated = await app.inject({ method: 'PUT', url: `/api/admin/filters/${owner}/1`, headers, payload: { etag: listed.json().items[0].etag, script: 'discard;\n' } }); assert.equal(updated.statusCode, 200, updated.body);
  const checked = await app.inject({ url: '/api/admin/checks/filters', headers }); assert.equal(checked.statusCode, 200, checked.body); assert.equal(checked.headers['cache-control'], 'no-store');
  assert.ok(!logLines.join('').includes('synthetic-user-script-marker')); assert.ok(!logLines.join('').includes('original-synthetic-sieve-marker'));
  f.scripts.delete(owner); f.names.delete(owner); assert.deepEqual(await f.service.user({}, owner), { address: owner, script: null, activeName: null });
  assert.equal((await app.inject('/healthz')).json().ok, true);
});

let tlsDir, cert, key;
before(async () => {
  tlsDir = await fs.mkdtemp(join(tmpdir(), 'webmail-a13-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem'), '-days', '1', '-subj', '/CN=dockerapi', '-addext', 'subjectAltName=DNS:dockerapi,IP:127.0.0.1'], { stdio: 'ignore' });
  cert = await fs.readFile(join(tlsDir, 'cert.pem')); key = await fs.readFile(join(tlsDir, 'key.pem'));
});
after(() => fs.rm(tlsDir, { recursive: true, force: true }));
test('dockerapi sieve list: actual plaintext protocol, exact allowlisted body and projected names only', async t => {
  const calls = [], options = { text: `${SCRIPT_NAME} ACTIVE\nrainloop.user\n` };
  const server = https.createServer({ cert, key }, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; calls.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
    if (req.url === '/containers/json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ abc123: { Id: 'abc123', Config: { Labels: { 'com.docker.compose.service': 'dovecot-mailcow' }, Env: ['SECRET=synthetic-env-marker'] } } })); }
    res.setHeader('content-type', options.type ?? 'text/plain'); res.end(options.text);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = createDockerApi({ config: { dockerapiUrl: `https://127.0.0.1:${server.address().port}` }, ca: cert });
  const result = await client.listSieve(owner); assert.deepEqual(result, [{ name: SCRIPT_NAME, active: true }, { name: 'rainloop.user', active: false }]); assert.deepEqual(calls[1].body, { cmd: 'sieve', task: 'list', username: owner });
  assert.ok(!JSON.stringify(result).includes('synthetic-env-marker'));
  const count = calls.length; for (const task of ['sieve_print', 'sieve', 'restart', '__proto__']) await assert.rejects(client.call(task, owner), { statusCode: 422, code: 'DOCKERAPI_TASK_NOT_ALLOWED' }); assert.equal(calls.length, count);
  options.text = 'require ["copy"]; # synthetic-raw-script-marker'; await assert.rejects(client.listSieve(owner), error => error.code === 'DOCKERAPI_REJECTED' && !error.message.includes('synthetic-raw-script-marker'));
  options.type = 'application/json'; options.text = JSON.stringify({ name: SCRIPT_NAME, script: 'synthetic-raw-script-marker' }); await assert.rejects(client.listSieve(owner), { code: 'DOCKERAPI_REJECTED' });
});
