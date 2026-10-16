import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { createQuarantineService } from '../../server/admin/services/quarantine.js';
import { createFwdhostsService } from '../../server/admin/services/fwdhosts.js';
import { createRspamdMapsService } from '../../server/admin/services/rspamd-maps.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';

const ctx = { session: {}, actor: 'admin', ip: '198.51.100.73' }, name = 'Envelope Sender Allowlist';
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a15-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const mapDir = join(dir, 'maps'), file = join(mapDir, 'global_smtp_from_whitelist.map'); await fs.mkdir(mapDir); await fs.writeFile(file, '# existing\n/^old@example\\.com$/\n\nold@example.com\n');
  const messages = [{ id: 1, qid: 'qid-synthetic', subject: '합성 제목', sender: 'sender@example.net', rcpt: 'recipient@example.com', score: '8.2', created: 1792152000, action: 'add header', msg: 'synthetic-raw-mail-marker', html: 'synthetic-body-marker', attachments: ['synthetic-file-marker'] }];
  const hosts = [], calls = [], options = {}, logs = [];
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); await options.onCall?.({ method, path, body });
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/quarantine/all') return structuredClone(messages);
    if (path === '/api/v1/get/fwdhost/all') return structuredClone(hosts);
    if (path === '/api/v1/edit/qitem' || path === '/api/v1/delete/qitem') {
      if (!options.ignoreWrites) { const id = body.items?.[0] ?? body[0]; messages.splice(messages.findIndex(row => String(row.id) === id), 1); }
    } else if (path === '/api/v1/add/fwdhost') {
      if (!options.ignoreWrites) {
        const source = body.hostname, resolved = isIP(source.split('/')[0]) ? [source] : options.resolved ?? ['192.0.2.10', '2001:db8::10'];
        for (const host of resolved) { const row = { host, source, keep_spam: body.filter_spam === '0' ? 'yes' : 'no' }, old = hosts.find(item => item.host === host); if (old) Object.assign(old, row); else hosts.push(row); }
      }
    } else if (path === '/api/v1/delete/fwdhost') { if (!options.ignoreWrites) for (const host of body) { const i = hosts.findIndex(row => row.host === host); if (i >= 0) hosts.splice(i, 1); } }
    else if (path === '/api/v1/edit/rspamd-map') { if (!options.ignoreWrites) await fs.writeFile(file, body.attr.rspamd_map_data.trim() + '\n'); }
    else assert.fail(path);
    return [{ type: 'success' }];
  } };
  const audit = createAudit({ dir: join(dir, 'audit'), logger: { info(data) { logs.push(data); } } }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const quarantine = createQuarantineService({ mailcow, audit, lock }), fwdhosts = createFwdhostsService({ mailcow, audit, lock, history }), maps = createRspamdMapsService({ mailcow, audit, lock, history, mapDir });
  return { dir, mapDir, file, messages, hosts, calls, options, logs, mailcow, audit, lock, history, quarantine, fwdhosts, maps };
}
const writes = f => f.calls.filter(row => row.method === 'POST');
const revert = (f, id) => f.history.revert(id, { ...ctx, confirm: true });
const getMap = f => f.maps.get({}, name);
const putMap = async (f, lines, tag) => f.maps.put({ ...ctx, name, data: { lines, etag: tag ?? (await getMap(f)).etag } });

test('quarantine: exact safe projection and original contents/attachment names absent everywhere', async t => {
  const f = await fixture(t), result = await f.quarantine.list({}); assert.deepEqual(Object.keys(result.items[0]).sort(), ['created', 'id', 'qid', 'recipient', 'score', 'sender', 'subject', 'type']); assert.equal(result.items[0].score, 8.2);
  for (const marker of ['synthetic-raw-mail-marker', 'synthetic-body-marker', 'synthetic-file-marker']) assert.ok(!JSON.stringify(result).includes(marker));
  assert.deepEqual(f.calls.map(row => row.path), ['/api/v1/get/quarantine/all']); assert.equal(writes(f).length, 0);
});
for (const action of ['release', 'learnham', 'learnspam', 'delete']) test(`quarantine: ${action} confirmed, irreversible, exact API body and no mail subject or addresses in audit`, async t => {
  const f = await fixture(t); f.messages[0].subject = 'SyntheticConfidentialSubject984'; const remove = action === 'delete';
  await assert.rejects(f.quarantine.change({ ...ctx, id: '1', remove, data: { ...(remove ? {} : { action }) } }), { statusCode: 422 }); assert.equal(writes(f).length, 0);
  const result = await f.quarantine.change({ ...ctx, id: '1', remove, data: { confirm: true, ...(remove ? {} : { action }) } }); const write = writes(f)[0];
  assert.equal(write.path, remove ? '/api/v1/delete/qitem' : '/api/v1/edit/qitem'); assert.deepEqual(write.body, remove ? ['1'] : { items: ['1'], attr: { action } }); assert.equal(f.messages.length, 0);
  const record = await f.history.detail(result.auditId); assert.equal(record.kind, 'irreversible'); assert.deepEqual(record.before, { id: '1', qid: 'qid-synthetic', action }); assert.equal(record.canRevert, false); assert.equal(record.before.action, action); assert.equal(record.before.msg, undefined);
  await assert.rejects(revert(f, result.auditId), { statusCode: 409 }); const recorded = JSON.stringify(await f.audit.read()); for (const marker of ['SyntheticConfidentialSubject984', 'sender@example.net', 'recipient@example.com', 'synthetic-raw-mail-marker']) assert.ok(!recorded.includes(marker)); if (action === 'release' || action === 'learnham') assert.match(result.notice, /실제로 배달/);
});
for (const data of [{ action: 'delete', confirm: true }, { action: 'release', confirm: 1 }, { action: 'release', confirm: false }, { action: 'unknown', confirm: true }]) test(`quarantine: invalid request ${JSON.stringify(data)}`, async t => { const f = await fixture(t); await assert.rejects(f.quarantine.change({ ...ctx, id: '1', data }), { statusCode: 422 }); assert.equal(writes(f).length, 0); });
test('quarantine: absent404 and ignored release readback502', async t => {
  const f = await fixture(t); await assert.rejects(f.quarantine.change({ ...ctx, id: '99', data: { action: 'release', confirm: true } }), { statusCode: 404 }); f.options.ignoreWrites = true; await assert.rejects(f.quarantine.change({ ...ctx, id: '1', data: { action: 'release', confirm: true } }), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
});
test('quarantine: locked duplicate operations cannot release one message twice', async t => {
  const f = await fixture(t), args = { ...ctx, id: '1', data: { action: 'release', confirm: true } }, results = await Promise.allSettled([f.quarantine.change(args), f.quarantine.change(args)]); assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.statusCode, 404); assert.equal(writes(f).length, 1);
});

for (const host of ['192.0.2.24', '192.0.2.0/24', '2001:db8::24', '2001:db8::/64']) test(`fwdhosts: add/delete/undo actual IP ${host}`, async t => {
  const f = await fixture(t), added = await f.fwdhosts.create({ ...ctx, data: { host } }); assert.deepEqual(writes(f)[0].body, { hostname: host, filter_spam: '0' }); assert.equal(added.hosts[0].keepSpam, true);
  await assert.rejects(f.fwdhosts.create({ ...ctx, data: { host } }), { statusCode: 409 }); const record = await f.history.detail(added.auditId); assert.equal(record.canRevert, true);
  const undo = await revert(f, added.auditId); assert.equal(f.hosts.length, 0); await revert(f, undo.id); assert.equal(f.hosts[0].host, host);
  await assert.rejects(f.fwdhosts.remove({ ...ctx, data: { host } }), { statusCode: 422 }); const removed = await f.fwdhosts.remove({ ...ctx, data: { host, confirm: true } }); assert.equal(f.hosts.length, 0); await revert(f, removed.auditId); assert.equal(f.hosts[0].host, host);
});
test('fwdhosts: name resolves once, keepSpam false mapping, undo deletes registered IPs without resolving name again', async t => {
  const f = await fixture(t), added = await f.fwdhosts.create({ ...ctx, data: { host: 'Forward.Example.NET', keepSpam: false } }); assert.equal(added.hosts.length, 2); assert.match(added.notice, /한 번만 IP/); assert.match(added.notice, /릴레이/); assert.deepEqual(writes(f)[0].body, { hostname: 'forward.example.net', filter_spam: '1' });
  const parent = await f.history.detail(added.flowId); assert.equal(parent.canRevert, false); assert.equal(parent.after.host, 'forward.example.net'); assert.equal(parent.detail.changeId, added.auditId);
  await assert.rejects(f.fwdhosts.create({ ...ctx, data: { host: 'forward.example.net' } }), { statusCode: 409 });
  f.options.resolved = ['192.0.2.99']; await revert(f, added.auditId); assert.deepEqual(writes(f).at(-1).body, ['192.0.2.10', '2001:db8::10']); assert.equal(f.hosts.length, 0);
});
test('fwdhosts: delete name group and undo preserve unrelated hosts; expected detects affected change only', async t => {
  const f = await fixture(t), added = await f.fwdhosts.create({ ...ctx, data: { host: 'forward.example.net' } }); f.hosts.push({ host: '192.0.2.88', source: 'unrelated.example.net', keep_spam: 'no' });
  const removed = await f.fwdhosts.remove({ ...ctx, data: { host: 'forward.example.net', confirm: true } }); assert.deepEqual(f.hosts.map(row => row.host), ['192.0.2.88']); await revert(f, removed.auditId); assert.equal(f.hosts.length, 3);
  f.hosts.find(row => row.host === '192.0.2.10').keep_spam = 'no'; await assert.rejects(revert(f, added.auditId), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
});
for (const host of ['bad', '192.0.2.1/33', '2001:db8::/129', '1.2.3.999', 'https://forward.example.net', 'a..example.net', 'host/path']) test(`fwdhosts: invalid ${host}`, async t => { const f = await fixture(t); await assert.rejects(f.fwdhosts.create({ ...ctx, data: { host } }), { statusCode: 422 }); assert.equal(writes(f).length, 0); });
test('fwdhosts: nonexistent404, nonboolean keepSpam422, postwrite mismatch502', async t => {
  const f = await fixture(t); await assert.rejects(f.fwdhosts.remove({ ...ctx, data: { host: '192.0.2.24', confirm: true } }), { statusCode: 404 }); await assert.rejects(f.fwdhosts.create({ ...ctx, data: { host: '192.0.2.24', keepSpam: 1 } }), { statusCode: 422 }); f.options.ignoreWrites = true; await assert.rejects(f.fwdhosts.create({ ...ctx, data: { host: '192.0.2.24' } }), { statusCode: 502 });
});

test('rspamd map: one allowlisted name only, raw comments/blanks preserved on GET', async t => {
  const f = await fixture(t), original = await fs.readFile(f.file, 'utf8'), result = await getMap(f); assert.equal(result.lines.join('\n') + '\n', original); assert.equal(result.normalizedOnSave, undefined);
  for (const other of ['global_smtp_from_whitelist.map', '../global_smtp_from_whitelist.map', 'Envelope Sender Denylist', 'Recipient Allowlist']) { await assert.rejects(f.maps.get({}, other), { statusCode: 404 }); await assert.rejects(f.maps.put({ ...ctx, name: other, data: { lines: [] } }), { statusCode: 404 }); }
});
test('rspamd map: API write only, etag conflict409, unchanged avoids writes, normalized undo swaps back', async t => {
  const f = await fixture(t), original = await getMap(f), result = await putMap(f, ['# comment', '', '/^new@example\\.com$/', 'new@example.com']);
  assert.deepEqual(writes(f)[0].body, { items: ['global_smtp_from_whitelist.map'], attr: { rspamd_map_data: '# comment\n\n/^new@example\\.com$/\nnew@example.com\n' } });
  await assert.rejects(putMap(f, ['stale'], original.etag), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); const count = writes(f).length; assert.equal((await putMap(f, result.lines)).unchanged, true); assert.equal(writes(f).length, count);
  const reverse = await revert(f, result.auditId); assert.deepEqual((await getMap(f)).lines, original.lines); await revert(f, reverse.id); assert.deepEqual((await getMap(f)).lines, result.lines);
});
test('rspamd map: raw CRLF/boundary spaces retained in detail.beforeRaw while history compares canonical states', async t => {
  const f = await fixture(t); const raw = '\r\n  # old\r\n\r\nold@example.com  \r\n\r\n'; await fs.writeFile(f.file, raw); const original = await getMap(f); assert.equal(original.normalizedOnSave, true); assert.equal(original.lines.join('\n') + '\n', raw);
  const result = await putMap(f, ['  # new\r', '', 'new@example.com  ', '']); assert.equal(await fs.readFile(f.file, 'utf8'), '# new\n\nnew@example.com\n'); const record = await f.history.detail(result.auditId); assert.deepEqual(record.before.lines, ['# old', '', 'old@example.com']); assert.deepEqual(record.detail.beforeRaw, original.lines); assert.match(record.detail.notice, /정리된 형태/);
  await revert(f, result.auditId); assert.equal(await fs.readFile(f.file, 'utf8'), '# old\n\nold@example.com\n');
});
test('rspamd map: normalization-only save is allowed; empty/comments/arbitrary map syntax source-level accepted', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, '\r\n  plain-content  \r\n'); const original = await getMap(f); const changed = await putMap(f, original.lines); assert.equal(changed.unchanged, undefined); assert.equal(await fs.readFile(f.file, 'utf8'), 'plain-content\n'); await revert(f, changed.auditId); assert.equal(await fs.readFile(f.file, 'utf8'), 'plain-content\n');
  await putMap(f, ['# comment', '', 'not-an-address-or-slash-regex', '\tinside']); assert.equal(await fs.readFile(f.file, 'utf8'), '# comment\n\nnot-an-address-or-slash-regex\n\tinside\n'); await putMap(f, []); assert.equal(await fs.readFile(f.file, 'utf8'), '\n');
});
for (const lines of [Array(1001).fill('x'), ['x'.repeat(1001)], ['bad\0value'], ['bad\x1bvalue'], [7]]) test(`rspamd map: invalid lines ${typeof lines[0]} count${lines.length}`, async t => { const f = await fixture(t); await assert.rejects(putMap(f, lines), { statusCode: 422 }); assert.equal(writes(f).length, 0); });
test('rspamd map: directory/file missing GET503 and PUT refuses without API write', async t => {
  const f = await fixture(t), tag = (await getMap(f)).etag; await fs.unlink(f.file); await assert.rejects(getMap(f), error => error.statusCode === 503 && error.code === 'MAP_READ_UNAVAILABLE' && error.message.includes('map 파일이 없음')); await assert.rejects(putMap(f, ['new'], tag), { statusCode: 503 }); assert.equal(writes(f).length, 0); await fs.rmdir(f.mapDir); await assert.rejects(getMap(f), { statusCode: 503, code: 'MAP_READ_UNAVAILABLE' });
});
test('rspamd map: readback failure502, external changes block undo409', async t => {
  const f = await fixture(t); f.options.ignoreWrites = true; await assert.rejects(putMap(f, ['new']), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' }); f.options.ignoreWrites = false; const result = await putMap(f, ['new']); await fs.writeFile(f.file, 'external\n'); await assert.rejects(revert(f, result.auditId), { statusCode: 409 });
});
test('rspamd map: same-etag requests serialize; one succeeds, second conflicts', async t => {
  const f = await fixture(t), tag = (await getMap(f)).etag; const results = await Promise.allSettled([putMap(f, ['first'], tag), putMap(f, ['second'], tag)]); assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.statusCode, 409); assert.equal(writes(f).length, 1);
});

test('delivery HTTP: guarded metadata/config routes smoke; no raw mail keys, attachment names, or original endpoints', async t => {
  const f = await fixture(t), logs = []; const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: join(f.dir, 'http-audit'), rspamdMapDir: f.mapDir }, logger: { level: 'info', stream: { write: line => logs.push(line) } }, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  assert.equal((await app.inject('/api/admin/quarantine')).statusCode, 403); const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } }); const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': login.json().csrf };
  const listed = await app.inject({ url: '/api/admin/quarantine', headers }); assert.equal(listed.statusCode, 200); assert.ok(!listed.body.includes('synthetic-raw-mail-marker')); assert.equal(listed.json().items[0].attachments, undefined);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/quarantine/1', headers, payload: { action: 'release' } })).statusCode, 422); assert.equal((await app.inject({ method: 'POST', url: '/api/admin/quarantine/1', headers, payload: { action: 'release', confirm: true } })).statusCode, 200);
  const added = await app.inject({ method: 'POST', url: '/api/admin/fwdhosts', headers, payload: { host: '192.0.2.24', keepSpam: false } }); assert.equal(added.statusCode, 200, added.body); assert.equal((await app.inject({ url: '/api/admin/fwdhosts', headers })).json().items[0].keepSpam, false);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/fwdhosts', headers, payload: { host: '192.0.2.24', confirm: true } })).statusCode, 200);
  const url = '/api/admin/rspamd-maps/' + encodeURIComponent(name), map = await app.inject({ url, headers }); assert.equal(map.statusCode, 200); const saved = await app.inject({ method: 'PUT', url, headers, payload: { etag: map.json().etag, lines: ['# new', '', 'new@example.com'] } }); assert.equal(saved.statusCode, 200, saved.body);
  const largeLines = Array(100).fill('x'.repeat(999)), large = await app.inject({ method: 'PUT', url, headers, payload: { etag: saved.json().etag, lines: largeLines } });
  assert.ok(Buffer.byteLength(JSON.stringify({ lines: largeLines })) > 64 * 1024); assert.equal(large.statusCode, 200, large.body);
  const oversized = await app.inject({ method: 'PUT', url, headers, payload: { etag: large.json().etag, lines: ['x'.repeat(2 * 1024 * 1024)] } }); assert.equal(oversized.statusCode, 413);
  assert.equal((await app.inject({ url: '/api/admin/quarantine/1', headers })).statusCode, 404); assert.equal((await app.inject({ url: '/api/admin/rspamd-maps/other', headers })).statusCode, 404); assert.ok(f.calls.every(row => !row.path.includes('/postcat') && (!row.path.includes('/get/quarantine/') || row.path.endsWith('/all'))));
  const audit = JSON.stringify(await app.audit.read()); for (const marker of ['synthetic-raw-mail-marker', 'synthetic-body-marker', 'synthetic-file-marker']) { assert.ok(!audit.includes(marker)); assert.ok(!logs.join('').includes(marker)); } assert.equal((await app.inject('/healthz')).json().ok, true);
});
test('delivery: authentication loss remains403', async t => { const f = await fixture(t); f.options.onCall = () => { throw new MailcowAuthLost(); }; await assert.rejects(f.quarantine.list({}), { statusCode: 403 }); await assert.rejects(f.fwdhosts.list({}), { statusCode: 403 }); });

test('rspamd map: canonical UTF8 256KiB boundary, one extra byte refuses without write', async t => {
  const f = await fixture(t), accepted = [...Array(262).fill('x'.repeat(999)), 'x'.repeat(143)];
  assert.equal(Buffer.byteLength(accepted.join('\n') + '\n'), 256 * 1024);
  await putMap(f, accepted); const count = writes(f).length;
  const rejected = [...accepted.slice(0, -1), 'x'.repeat(144)];
  assert.equal(Buffer.byteLength(rejected.join('\n') + '\n'), 256 * 1024 + 1);
  await assert.rejects(putMap(f, rejected), { statusCode: 422 }); assert.equal(writes(f).length, count);
});
