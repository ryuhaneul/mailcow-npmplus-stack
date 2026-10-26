import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudit, sanitizeAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createTeamsService } from '../../server/admin/services/teams.js';
import { createAdminApp } from '../../server/admin/app.js';

const team = 'team@example.com', first = 'first@example.com', second = 'second@example.com', next = 'next@example.com';
const script = `require ["copy"];\r\n# 합성 📨 보존\r\n  redirect :copy "${first}"; # 첫 줄\r\n  redirect :copy "${second}"; # 마지막 줄\r\nredirect "archive@example.com";\r\nstop;\r\n`;
async function fixture(t, source = script) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a12-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const rows = source === null ? [] : [{ id: 1, username: team, filter_type: 'prefilter', active: 1, script_desc: '원래 설명', script_data: source }];
  const boxes = [team, first, second, next].map(username => ({ username, name: username, active: 1 }));
  const calls = []; const options = {}; let reads = 0;
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body });
    if (path === '/api/v1/get/domain/all') return options.domains ?? [{ domain_name: 'example.com', active: '1' }];
    if (path === '/api/v1/get/alias-domain/all') return [];
    if (path === '/api/v1/get/alias/all') return structuredClone(options.aliases ?? []);
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/mailbox/all') return structuredClone(Object.hasOwn(options, 'mailboxes') ? options.mailboxes : boxes);
    if (path === '/api/v1/get/filters/all') { reads++; options.onRead?.(reads, rows); return structuredClone(Object.hasOwn(options, 'filters') ? options.filters : rows.length ? rows : {}); }
    if (path === '/api/v1/edit/filter') {
      if (!options.ignoreWrites) Object.assign(rows.find(row => String(row.id) === body.items[0]), body.attr);
      return [{ type: 'success', msg: 'filter_modified' }];
    }
    if (path === '/api/v1/add/filter') {
      if (!options.ignoreWrites) rows.push({ id: 100 + rows.length, ...body });
      return [{ type: 'success', msg: 'filter_added' }];
    }
    assert.fail(path);
  } };
  const audit = createAudit({ dir }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const service = createTeamsService({ mailcow, audit, lock, history, auditDir: dir });
  return { dir, rows, boxes, calls, options, mailcow, audit, lock, history, service };
}
async function item(f) { return (await f.service.list({})).items.find(row => row.mailbox === team); }
function change(f, expected, add = true, member = next) { return f.service.change({ session: {}, actor: 'admin', ip: '198.51.100.9', team, member, etag: expected, add }); }
const writes = f => f.calls.filter(row => row.method === 'POST');

test('teams: list shows deduplicated members, copy/mixed modes and active mailbox candidates', async t => {
  const f = await fixture(t); const result = await f.service.list({});
  assert.equal(result.total, 1); assert.equal(result.pageSize, 50); assert.equal(result.mailboxes.length, 4);
  const row = result.items[0]; assert.equal(row.distribution, 'mixed'); assert.equal(row.editable, true); assert.equal(row.filterId, 1);
  assert.deepEqual(row.members.map(member => member.address), [first, second]); assert.match(row.etag, /^[a-f0-9]{64}$/);
  assert.equal((await f.service.list({}, { q: 'missing' })).total, 0); assert.equal((await f.service.list({}, { page: '2' })).items.length, 0);
});

test('teams: marked active member alias expands targets before remaining Sieve links and contributes to etag', async t => {
  const alias = 'team-members@example.com', linked = 'linked@example.com';
  const f = await fixture(t, `require ["copy"];\nredirect :copy "${alias}";\nredirect :copy "${linked}";\n`);
  f.options.aliases = [{ id: 7, address: alias, goto: `${first},${second},${first}`, active: '1', private_comment: 'mailadmin:team-members' }];
  const row = await item(f);
  assert.equal(row.mode, 'alias'); assert.equal(row.memberAlias, alias); assert.equal(row.convertible, false); assert.equal(row.editable, true);
  assert.deepEqual(row.members, [
    { address: first, name: first, via: 'alias' }, { address: second, name: second, via: 'alias' }, { address: linked, name: '', via: 'sieve' },
  ]);
  assert.equal(f.calls.filter(row => row.path === '/api/v1/get/alias/all').length, 1);
  assert.equal((await f.service.list({}, { q: first })).total, 1);
  f.options.aliases[0].goto = next;
  const changed = await item(f); assert.notEqual(changed.etag, row.etag);
  assert.deepEqual(changed.members.map(member => member.address), [next, linked]);
});

test('teams: unmarked and inactive aliases remain ordinary Sieve members', async t => {
  const alias = 'ordinary@example.com', inactive = 'inactive@example.com';
  const f = await fixture(t, `redirect :copy "${alias}";\nredirect :copy "${inactive}";\n`);
  f.options.aliases = [
    { address: alias, goto: first, active: '1', private_comment: '' },
    { address: inactive, goto: second, active: '0', private_comment: 'mailadmin:team-members' },
  ];
  const row = await item(f);
  assert.equal(row.mode, 'sieve'); assert.equal(row.memberAlias, null); assert.equal(row.convertible, false);
  assert.deepEqual(row.members.map(({ address, via }) => ({ address, via })), [{ address: alias, via: 'sieve' }, { address: inactive, via: 'sieve' }]);
});

test('teams: multiple marked active member aliases make the team read-only', async t => {
  const f = await fixture(t);
  f.options.aliases = [first, second].map(address => ({ address, goto: next, active: '1', private_comment: 'mailadmin:team-members' }));
  const row = await item(f); assert.equal(row.editable, false); assert.equal(row.reason, 'multiple_member_aliases'); assert.equal(row.convertible, false);
});

test('teams: conversion requires three active personal mailbox members and an editable filter', async t => {
  const source = [first, second, next].map(address => `redirect :copy "${address}";\n`).join('');
  const f = await fixture(t, source);
  assert.equal((await item(f)).convertible, true);
  f.rows.push({ id: 2, username: next, filter_type: 'prefilter', active: 1, script_data: `redirect :copy "${first}";\n` });
  assert.equal((await item(f)).convertible, false);
  f.rows.pop(); f.boxes.find(row => row.username === next).active = 0;
  assert.equal((await item(f)).convertible, false);
  f.boxes.find(row => row.username === next).active = 1; f.rows[0].script_data = 'stop;\n' + source;
  assert.equal((await item(f)).convertible, false);
});

for (const [source, reason] of [
  [`redirect :copy "${first}"`, 'unparseable'],
  [`stop;\nredirect :copy "${first}";\n`, 'stopper_before_member'],
  [`redirect :copy "${first}"; redirect :copy "${second}";\n`, 'line_not_simple'],
]) test(`teams: ${reason} filter is visible read-only and refuses writes`, async t => {
  const f = await fixture(t, source); const row = await item(f); assert.equal(row.editable, false); assert.equal(row.reason, reason);
  await assert.rejects(change(f, row.etag), { statusCode: 409, code: reason.toUpperCase() }); assert.equal(writes(f).length, 0);
});

test('teams: multiple prefilters are visible read-only and forwarding-only mailbox stays separate', async t => {
  const f = await fixture(t); f.rows.push({ ...f.rows[0], id: 2 });
  const row = await item(f); assert.equal(row.reason, 'multiple_prefilters'); assert.equal(row.editable, false);
  await assert.rejects(change(f, row.etag), { statusCode: 409, code: 'MULTIPLE_PREFILTERS' });
  const forward = await fixture(t, 'redirect "first@example.com";\n');
  const result = await forward.service.list({}); assert.equal(result.items.length, 0); assert.equal(result.forwards[0].distribution, 'move');
  await assert.rejects(forward.service.create({ session: {}, teamAddress: team, members: [first] }), { statusCode: 409, code: 'TEAM_EXISTS' });
});

test('teams: add creates only a copy redirect before move/stop and preserves all unrelated bytes', async t => {
  const f = await fixture(t); const row = await item(f); const response = await change(f, row.etag);
  assert.deepEqual(response.members, [first, second, next]);
  assert.match(response.auditId, /^[a-f0-9]{32}$/);
  const inserted = `  redirect :copy "${next}";\r\n`;
  const expected = script.replace('redirect "archive@example.com";', inserted + 'redirect "archive@example.com";');
  assert.equal(f.rows[0].script_data, expected);
  const body = writes(f)[0].body;
  assert.deepEqual(body.items, ['1']); assert.equal(body.attr.script_desc, '원래 설명'); assert.equal(body.attr.active, '1'); assert.equal(body.attr.filter_type, 'prefilter');
  assert.equal(body.attr.script_data, expected);
});

test('teams: raw backups precede intent, are private, and JSONL contains only hashes/members/byte counts', async t => {
  const f = await fixture(t); await change(f, (await item(f)).etag);
  const record = (await f.history.list()).items[0];
  const before = join(f.dir, 'filter-backups', `${record.id}.before.sieve`), after = join(f.dir, 'filter-backups', `${record.id}.after.sieve`);
  assert.equal(await fs.readFile(before, 'utf8'), script); assert.equal(await fs.readFile(after, 'utf8'), f.rows[0].script_data);
  for (const path of [before, after]) assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  assert.equal(record.bytesBefore, Buffer.byteLength(script)); assert.match(record.scriptSha256Before, /^[a-f0-9]{64}$/);
  const file = (await fs.readdir(f.dir)).find(name => name.endsWith('.jsonl'));
  const jsonl = await fs.readFile(join(f.dir, file), 'utf8'); assert.ok(!jsonl.includes('redirect :copy')); assert.ok(!jsonl.includes('합성')); assert.ok(!jsonl.includes('원래 설명'));
  assert.equal(record.before.sha256, record.scriptSha256Before); assert.equal(record.after.sha256, record.scriptSha256After);
});

test('teams: removing and reverting restores the original bytes, comments and line endings exactly', async t => {
  const f = await fixture(t); await change(f, (await item(f)).etag, false, first);
  assert.ok(!f.rows[0].script_data.includes(`# 첫 줄`));
  const original = (await f.history.list()).items[0];
  const reverted = await f.history.revert(original.id, { confirm: true, session: {}, actor: 'admin', ip: '203.0.113.7' });
  assert.equal(f.rows[0].script_data, script);
  const reverse = await f.history.detail(reverted.id);
  assert.equal(reverse.revertOf, original.id); assert.equal(reverse.scriptSha256Before, original.scriptSha256After); assert.equal(reverse.scriptSha256After, original.scriptSha256Before);
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${reverted.id}.after.sieve`), 'utf8'), script);
  await f.history.revert(reverted.id, { confirm: true, session: {}, actor: 'admin', ip: '203.0.113.7' });
  assert.ok(!f.rows[0].script_data.includes(`# 첫 줄`));
});

test('teams: missing backup blocks revert with no new intent or mutation', async t => {
  const f = await fixture(t); await change(f, (await item(f)).etag);
  const record = (await f.history.list()).items[0]; const beforeWrites = writes(f).length;
  await fs.unlink(join(f.dir, 'filter-backups', `${record.id}.before.sieve`));
  await assert.rejects(f.history.revert(record.id, { confirm: true, session: {}, actor: 'admin', ip: '203.0.113.7' }), { statusCode: 409, code: 'NOT_REVERTIBLE' });
  assert.equal(writes(f).length, beforeWrites); assert.equal((await f.audit.read()).rows.length, 2);
});

test('teams: backup directory failure prevents mutation and intent with AUDIT_UNAVAILABLE', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.dir, 'filter-backups'), 'synthetic-file-blocks-directory');
  await assert.rejects(change(f, (await item(f)).etag), { statusCode: 500, code: 'AUDIT_UNAVAILABLE' });
  assert.equal(writes(f).length, 0); assert.equal((await f.audit.read()).rows.length, 0);
});

test('teams: changed script hash blocks revert before mutation', async t => {
  const f = await fixture(t); await change(f, (await item(f)).etag);
  const record = (await f.history.list()).items[0]; f.rows[0].script_data += '# outside edit\n';
  await assert.rejects(f.history.revert(record.id, { confirm: true, session: {} }), { code: 'CHANGED_ELSEWHERE' });
  assert.equal(writes(f).length, 1);
});

test('teams: last member is protected, missing member and duplicate adds are no-ops after etag validation', async t => {
  const f = await fixture(t, `require ["copy"];\nredirect :copy "${first}";\n`); let row = await item(f);
  await assert.rejects(change(f, row.etag, false, first), { statusCode: 409, code: 'LAST_MEMBER' });
  assert.equal((await change(f, row.etag, true, first)).unchanged, true);
  assert.equal((await change(f, row.etag, false, 'missing@example.com')).unchanged, true);
  await assert.rejects(change(f, 'stale', true, first), { code: 'CHANGED_ELSEWHERE' });
  assert.equal(writes(f).length, 0); assert.equal((await f.audit.read()).rows.length, 0);
});

test('teams: active/internal/self validation protects additions while inactive old member may be removed', async t => {
  const f = await fixture(t); const row = await item(f);
  for (const member of ['outside@example.org', team]) await assert.rejects(change(f, row.etag, true, member), { statusCode: 422 });
  f.boxes.find(box => box.username === first).active = 0;
  await change(f, row.etag, false, first); assert.deepEqual((await item(f)).members.map(row => row.address), [second]);
  f.boxes.find(box => box.username === team).active = 0;
  assert.equal((await item(f)).mailbox, team);
  await assert.rejects(change(f, (await item(f)).etag), { statusCode: 422 });
});

test('teams: conflict after durable intent but before POST preserves the outside edit', async t => {
  const f = await fixture(t); const row = await item(f); let read = 0;
  f.options.onRead = (_count, rows) => { read++; if (read === 2) rows[0].script_data += '# outside\n'; };
  await assert.rejects(change(f, row.etag), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  assert.equal(writes(f).length, 0); assert.ok(f.rows[0].script_data.endsWith('# outside\n'));
  assert.equal((await f.history.list()).items[0].result, 'failed');
});

test('teams: same team requests serialize; only first stale-snapshot change writes', async t => {
  const f = await fixture(t); const row = await item(f);
  const results = await Promise.allSettled([change(f, row.etag), change(f, row.etag, false, first)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'CHANGED_ELSEWHERE'); assert.equal(writes(f).length, 1);
});

test('teams: mismatch on reread after saving returns 502 and a failed record', async t => {
  const f = await fixture(t); f.options.ignoreWrites = true;
  await assert.rejects(change(f, (await item(f)).etag), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
  const record = (await f.history.list()).items[0]; assert.equal(record.result, 'failed'); assert.equal(record.code, 'WRITE_VERIFY_FAILED');
});

test('teams: initial filter creation has required copy extension, one active prefilter and non-revertible backup', async t => {
  const f = await fixture(t, null);
  const response = await f.service.create({ session: {}, actor: 'admin', ip: '198.51.100.9', teamAddress: team, members: [first, second] });
  assert.deepEqual(response.members, [first, second]); assert.equal(f.rows.length, 1);
  assert.deepEqual(writes(f)[0].body, { username: team, filter_type: 'prefilter', active: '1', script_desc: '팀 분배', script_data: `require ["copy"];\nredirect :copy "${first}";\nredirect :copy "${second}";\n` });
  const record = (await f.history.list()).items[0]; assert.equal(record.revertible, false); assert.equal(record.canRevert, false);
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${record.id}.before.sieve`), 'utf8'), '');
  await assert.rejects(f.history.revert(record.id, { confirm: true }), { code: 'NOT_REVERTIBLE' });
  await assert.rejects(f.service.create({ session: {}, teamAddress: team, members: [first] }), { code: 'TEAM_EXISTS' });
});

for (const members of [[], [team], [first, first], ['outside@example.org']]) test(`teams: invalid creation members ${JSON.stringify(members)} do not write`, async t => {
  const f = await fixture(t, null);
  await assert.rejects(f.service.create({ session: {}, teamAddress: team, members }), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});

test('teams: concurrent filter creation serializes and refuses a second active prefilter', async t => {
  const f = await fixture(t, null);
  const results = await Promise.allSettled([1, 2].map(() => f.service.create({ session: {}, actor: 'admin', ip: '198.51.100.9', teamAddress: team, members: [first] })));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.code, 'TEAM_EXISTS'); assert.equal(f.rows.length, 1);
});

test('audit: prepare runs before intent, safe hash exceptions are narrow, ordinary script remains excluded', async t => {
  const f = await fixture(t); let prepared = false;
  const hash = 'a'.repeat(64);
  assert.deepEqual(sanitizeAudit({ script: 'secret', scriptSha256Before: hash, scriptSha256After: 'not-a-hash' }), { scriptSha256Before: hash });
  await f.audit.run({ actor: 'admin', action: 'test.prepare', target: team, kind: 'info', scriptSha256Before: hash, scriptSha256After: hash, bytesBefore: 0, bytesAfter: 0 }, async () => { assert.equal(prepared, true); return {}; },
    { prepare: async ({ id }) => { assert.match(id, /^[a-f0-9]{32}$/); assert.equal((await f.audit.read()).rows.length, 0); prepared = true; } });
  const record = (await f.audit.read()).rows[0]; assert.equal(record.scriptSha256Before, hash); assert.equal(record.bytesBefore, 0);
});

test('teams HTTP: authentication, CSRF, list and member editing use the existing guard and history', async t => {
  const f = await fixture(t);
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', sessionIdleMin: 60, sessionMaxHours: 8, trustProxy: ['192.0.2.0/24'], auditDir: f.dir }, logger: false,
    auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } });
  t.after(() => app.close());
  assert.equal((await app.inject('/api/admin/teams')).statusCode, 403);
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  const listed = await app.inject({ url: '/api/admin/teams', headers }); assert.equal(listed.statusCode, 200);
  const url = `/api/admin/teams/${team}/members`, expected = listed.json().items[0].etag;
  const denied = await app.inject({ method: 'POST', url, headers: { ...headers, 'x-mailadmin-csrf': 'bad' }, payload: { member: next, etag: expected } }); assert.equal(denied.statusCode, 403);
  const edited = await app.inject({ method: 'POST', url, headers, payload: { member: next, etag: expected } }); assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.headers['www-authenticate'], undefined); assert.equal(edited.headers['cache-control'], 'no-store');
  const removed = await app.inject({ method: 'DELETE', url, headers, payload: { member: next, etag: edited.json().etag } }); assert.equal(removed.statusCode, 200, removed.body);
  const history = await app.inject({ url: '/api/admin/history', headers }); assert.equal(history.json().total, 2); assert.ok(!history.body.includes('redirect :copy'));
});


test('teams: duplicate member display preserves the first original spelling like Toolkit', async t => {
  const f = await fixture(t, 'redirect :copy "FIRST@EXAMPLE.COM";\nredirect :copy "first@example.com";\nredirect :copy "second@example.com";\n');
  assert.deepEqual((await item(f)).members.map(row => row.address), ['FIRST@EXAMPLE.COM', second]);
});


test('teams: empty mailbox object is an empty list and malformed lists still return 502', async t => {
  const f = await fixture(t, null); f.options.mailboxes = {};
  assert.deepEqual(await f.service.list({}), { items: [], forwards: [], mailboxes: [], total: 0, page: 1, pageSize: 50 });
  for (const value of [null, false, '', { unexpected: true }]) {
    f.options.mailboxes = value;
    await assert.rejects(f.service.list({}), { statusCode: 502, code: 'MAILCOW_REJECTED' });
    f.options.mailboxes = []; f.options.filters = value;
    await assert.rejects(f.service.list({}), { statusCode: 502, code: 'MAILCOW_REJECTED' });
  }
});

const externalScript = 'require ["copy"];\nredirect :copy "first@example.com";\nredirect :copy "outside@example.net";\n';
test('teams: member addition cannot preserve an unguarded external redirect; zero writes', async t => {
  const f = await fixture(t, externalScript);
  await assert.rejects(change(f, (await item(f)).etag), { statusCode: 422, code: 'EXTERNAL_SPAM_GUARD' });
  assert.equal(writes(f).length, 0); assert.equal(f.rows[0].script_data, externalScript);
});
test('teams: removing external redirect is allowed, but undo refuses its unguarded restoration and audits failure', async t => {
  const f = await fixture(t, externalScript);
  const removed = await change(f, (await item(f)).etag, false, 'outside@example.net');
  assert.equal(writes(f).length, 1); assert.ok(!f.rows[0].script_data.includes('outside@example.net'));
  await assert.rejects(f.history.revert(removed.auditId, { confirm: true, session: {}, actor: 'admin', ip: '203.0.113.7' }), { statusCode: 422, code: 'EXTERNAL_SPAM_GUARD' });
  assert.equal(writes(f).length, 1);
  const failed = (await f.history.list()).items.find(row => row.revertOf === removed.auditId);
  assert.equal(failed.result, 'failed'); assert.equal(failed.code, 'EXTERNAL_SPAM_GUARD');
});
test('teams: deleting an internal member while unguarded external forwarding remains is refused', async t => {
  const f = await fixture(t, externalScript.replace('redirect :copy "first@example.com";', 'redirect :copy "first@example.com";\nredirect :copy "second@example.com";'));
  await assert.rejects(change(f, (await item(f)).etag, false, first), { statusCode: 422, code: 'EXTERNAL_SPAM_GUARD' });
  assert.equal(writes(f).length, 0);
});
test('teams: guarded external forwarding permits internal membership changes and reversal', async t => {
  const f = await fixture(t, externalScript.replace('require ["copy"];', 'require ["copy"];\nif header :contains "X-Spam-Flag" "YES" { stop; }'));
  const changed = await change(f, (await item(f)).etag);
  assert.equal(writes(f).length, 1);
  await f.history.revert(changed.auditId, { confirm: true, session: {}, actor: 'admin', ip: '203.0.113.7' });
  assert.equal(writes(f).length, 2);
});
