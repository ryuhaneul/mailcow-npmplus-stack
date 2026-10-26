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
    if (path === '/api/v1/add/alias') {
      if (!options.ignoreAliasWrites) (options.aliases ??= []).push({ id: 70, ...body });
      return [{ type: 'success' }];
    }
    if (path === '/api/v1/edit/alias') {
      if (!options.ignoreAliasWrites) Object.assign(options.aliases.find(row => String(row.id) === body.items[0]), body.attr);
      return [{ type: 'success' }];
    }
    if (path === '/api/v1/delete/alias') {
      if (options.failAliasDelete) throw new Error('synthetic delete failure');
      options.aliases = options.aliases.filter(row => !body.includes(String(row.id)));
      return [{ type: 'success' }];
    }
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
  assert.deepEqual(writes(f)[0].body, { address: 'team-members@example.com', goto: `${first},${second}`, active: '1', internal: '1', private_comment: 'mailadmin:team-members', sogo_visible: '0' });
  assert.deepEqual(writes(f)[1].body, { username: team, filter_type: 'prefilter', active: '1', script_desc: '팀 분배', script_data: 'require ["copy"];\nredirect :copy "team-members@example.com";\n' });
  assert.equal(response.etag, (await item(f)).etag);
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
  const added = await app.inject({ method: 'POST', url, headers, payload: { member: next, etag: removed.json().etag } });
  assert.equal(added.statusCode, 200, added.body);
  const convertUrl = `/api/admin/teams/${team}/convert`;
  assert.equal((await app.inject(convertUrl)).statusCode, 403);
  const preview = await app.inject({ url: convertUrl, headers }); assert.equal(preview.statusCode, 200, preview.body);
  const deniedConvert = await app.inject({ method: 'POST', url: convertUrl, headers: { ...headers, 'x-mailadmin-csrf': 'bad' }, payload: { etag: preview.json().etag } });
  assert.equal(deniedConvert.statusCode, 403);
  const converted = await app.inject({ method: 'POST', url: convertUrl, headers, payload: { etag: preview.json().etag } });
  assert.equal(converted.statusCode, 200, converted.body); assert.equal(converted.json().memberAlias, 'team-members@example.com');
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

const memberAliasAddress = 'team-members@example.com', linkedTeam = 'linked@example.com';
async function aliasFixture(t, goto = `${first},${second}`) {
  const f = await fixture(t, `require ["copy"];\nredirect :copy "${memberAliasAddress}";\nredirect :copy "${linkedTeam}";\n`);
  f.options.aliases = [{ id: 7, address: memberAliasAddress, goto, active: '1', internal: '1', private_comment: 'mailadmin:team-members' }];
  return f;
}
test('teams alias: add edits only goto and audits the combined members', async t => {
  const f = await aliasFixture(t), source = f.rows[0].script_data;
  const result = await change(f, (await item(f)).etag);
  assert.deepEqual(result.members, [first, second, next, linkedTeam]);
  assert.deepEqual(writes(f).map(row => row.path), ['/api/v1/edit/alias']);
  assert.deepEqual(writes(f)[0].body, { items: ['7'], attr: { goto: `${first},${second},${next}` } });
  assert.equal(f.rows[0].script_data, source); assert.equal(result.etag, (await item(f)).etag);
  const record = await f.history.detail(result.auditId);
  assert.deepEqual(record.before.members, [first, second, linkedTeam]);
  assert.deepEqual(record.after.members, result.members);
  assert.equal(record.before.aliasGoto, `${first},${second}`); assert.equal(record.after.aliasGoto, `${first},${second},${next}`);
});
test('teams alias: removal after account disable active=2 still edits goto', async t => {
  const f = await aliasFixture(t); f.boxes.find(row => row.username === first).active = 2;
  const result = await change(f, (await item(f)).etag, false, first);
  assert.deepEqual(result.members, [second, linkedTeam]); assert.equal(f.options.aliases[0].goto, second);
  assert.equal(writes(f)[0].path, '/api/v1/edit/alias');
});
test('teams alias: last alias target is protected even with a remaining Sieve link', async t => {
  const f = await aliasFixture(t, first);
  await assert.rejects(change(f, (await item(f)).etag, false, first), { code: 'LAST_MEMBER', statusCode: 409 });
  assert.equal(writes(f).length, 0);
});
test('teams alias: changed goto invalidates etag and a verification mismatch audits failure', async t => {
  const f = await aliasFixture(t); const expected = (await item(f)).etag;
  f.options.aliases[0].goto = first;
  await assert.rejects(change(f, expected), { code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 0);
  f.options.ignoreAliasWrites = true;
  await assert.rejects(change(f, (await item(f)).etag), { code: 'WRITE_VERIFY_FAILED', statusCode: 502 });
  assert.equal((await f.history.list()).items[0].result, 'failed');
});
test('teams alias: undo and redo restore goto without editing the filter; outside changes block undo', async t => {
  const f = await aliasFixture(t), source = f.rows[0].script_data;
  const result = await change(f, (await item(f)).etag);
  const reverse = await f.history.revert(result.auditId, { confirm: true, session: {}, actor: 'admin' });
  assert.equal(f.options.aliases[0].goto, `${first},${second}`);
  await f.history.revert(reverse.id, { confirm: true, session: {}, actor: 'admin' });
  assert.equal(f.options.aliases[0].goto, `${first},${second},${next}`);
  f.options.aliases[0].goto = second;
  await assert.rejects(f.history.revert(result.auditId, { confirm: true, session: {} }), { code: 'CHANGED_ELSEWHERE' });
  assert.equal(f.rows[0].script_data, source); assert.ok(writes(f).every(row => row.path === '/api/v1/edit/alias'));
});
test('teams create: new E team keeps linked teams in Sieve and creates no alias for links alone', async t => {
  const f = await fixture(t, null);
  f.rows.push({ id: 2, username: second, filter_type: 'prefilter', active: 1, script_data: `redirect :copy "${first}";\n` });
  await f.service.create({ session: {}, teamAddress: team, members: [first, second] });
  assert.equal(f.options.aliases[0].goto, first);
  assert.equal(f.rows.find(row => row.username === team).script_data, `require ["copy"];\nredirect :copy "${memberAliasAddress}";\nredirect :copy "${second}";\n`);
  const links = await fixture(t, null);
  links.rows.push({ id: 2, username: second, filter_type: 'prefilter', active: 1, script_data: `redirect :copy "${first}";\n` });
  await links.service.create({ session: {}, teamAddress: team, members: [second] });
  assert.ok(!writes(links).some(row => row.path === '/api/v1/add/alias'));
});
test('teams create: failed filter verification deletes unused alias but preserves one referenced by an applied filter', async t => {
  const f = await fixture(t, null); f.options.ignoreWrites = true;
  await assert.rejects(f.service.create({ session: {}, teamAddress: team, members: [first] }), { code: 'WRITE_VERIFY_FAILED' });
  assert.deepEqual(f.options.aliases, []); assert.equal(writes(f).at(-1).path, '/api/v1/delete/alias');
  const applied = await fixture(t, null);
  applied.options.onRead = (_count, rows) => { if (rows.length) rows[0].script_data += '# outside edit\n'; };
  await assert.rejects(applied.service.create({ session: {}, teamAddress: team, members: [first] }), error => {
    assert.equal(error.code, 'WRITE_VERIFY_FAILED'); assert.ok(error.message.includes(memberAliasAddress)); return true;
  });
  assert.equal(applied.options.aliases.length, 1); assert.ok(!writes(applied).some(row => row.path === '/api/v1/delete/alias'));
});

const convertibleScript = `require ["copy"];\r\nif header :contains "Subject" "AuthCode" { redirect :copy "notice@example.com"; }\r\n` +
  [first, second, next, linkedTeam].map(address => `  redirect :copy "${address}";\r\n`).join('');
const convertTeam = (f, expected) => f.service.convert({ session: {}, actor: 'admin', ip: '198.51.100.9', team, etag: expected });

test('teams convert: preview is read-only; success creates and verifies the internal alias before the single filter edit', async t => {
  const f = await fixture(t, convertibleScript);
  const preview = await f.service.previewConvert({}, team);
  assert.deepEqual(preview.members, [first, second, next]); assert.deepEqual(preview.remaining, [linkedTeam]);
  assert.equal(preview.memberAlias, memberAliasAddress); assert.equal(preview.before, convertibleScript);
  assert.equal(preview.after, convertibleScript.replace([first, second, next].map(address => `  redirect :copy "${address}";\r\n`).join(''), `  redirect :copy "${memberAliasAddress}";\r\n`));
  assert.equal(writes(f).length, 0);
  const result = await convertTeam(f, preview.etag);
  assert.deepEqual(writes(f).map(row => row.path), ['/api/v1/add/alias', '/api/v1/edit/filter']);
  const createIndex = f.calls.findIndex(row => row.path === '/api/v1/add/alias'), editIndex = f.calls.findIndex(row => row.path === '/api/v1/edit/filter');
  assert.ok(f.calls.slice(createIndex + 1, editIndex).some(row => row.path === '/api/v1/get/alias/all'));
  assert.deepEqual(f.options.aliases[0], { id: 70, address: memberAliasAddress, goto: `${first},${second},${next}`, active: '1', internal: '1', private_comment: 'mailadmin:team-members', sogo_visible: '0' });
  assert.equal(f.rows[0].script_data, preview.after); assert.equal(result.etag, (await item(f)).etag);
  assert.deepEqual(result.members, [first, second, next, linkedTeam]);
  const record = await f.history.detail(result.auditId);
  assert.equal(record.action, 'team.convert'); assert.equal(record.canRevert, true);
  assert.equal(record.after.memberAlias, memberAliasAddress); assert.equal(record.after.aliasGoto, `${first},${second},${next}`);
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${record.id}.before.sieve`), 'utf8'), convertibleScript);
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${record.id}.after.sieve`), 'utf8'), preview.after);
});

test('teams convert: external redirects without a leading spam guard block list, preview and execution before writes', async t => {
  const f = await fixture(t, convertibleScript + 'redirect :copy "outside@external.test";\r\n');
  const row = await item(f);
  assert.equal(row.convertible, false); assert.equal(row.conversionReason, 'external_spam_guard');
  assert.equal(row.editable, true); assert.equal(row.reason, '');
  for (const operation of [() => f.service.previewConvert({}, team), () => convertTeam(f, row.etag)]) {
    await assert.rejects(operation, { statusCode: 422, code: 'EXTERNAL_SPAM_GUARD', message: '외부 전달이 있어 맨 앞에 스팸 멈춤 줄이 필요해요.' });
  }
  assert.equal(writes(f).length, 0); assert.equal((await f.history.list()).items.length, 0);
});

test('teams convert: leading spam guard allows external redirects through preview and execution', async t => {
  const source = convertibleScript.replace('require ["copy"];', 'require ["copy"];\r\nif header :contains "X-Spam-Flag" "YES" { stop; }') + 'redirect :copy "outside@external.test";\r\n';
  const f = await fixture(t, source), row = await item(f);
  assert.equal(row.convertible, true); assert.equal(row.conversionReason, '');
  const preview = await f.service.previewConvert({}, team);
  const result = await convertTeam(f, preview.etag);
  assert.equal(result.memberAlias, memberAliasAddress);
  assert.ok(f.rows[0].script_data.includes('if header :contains "X-Spam-Flag" "YES" { stop; }'));
  assert.ok(f.rows[0].script_data.includes('redirect :copy "outside@external.test";'));
});

test('teams convert: stale etag, occupied addresses, and ineligible teams refuse conversion without writes', async t => {
  const f = await fixture(t, convertibleScript), preview = await f.service.previewConvert({}, team);
  f.rows[0].script_data += '# outside\n';
  await assert.rejects(convertTeam(f, preview.etag), { code: 'CHANGED_ELSEWHERE' });
  f.rows[0].script_data = `redirect :copy "${first}";\n`;
  await assert.rejects(convertTeam(f, preview.etag), { code: 'CHANGED_ELSEWHERE' });
  f.rows[0].script_data = convertibleScript;
  f.options.aliases = [{ id: 9, address: memberAliasAddress, active: 0, goto: first }];
  await assert.rejects(convertTeam(f, preview.etag), { code: 'ADDRESS_IN_USE' });
  f.options.aliases = []; f.boxes.push({ username: memberAliasAddress, active: 0 });
  await assert.rejects(convertTeam(f, preview.etag), { code: 'ADDRESS_IN_USE' });
  assert.equal(writes(f).length, 0);
  const small = await fixture(t);
  await assert.rejects(small.service.previewConvert({}, team), { statusCode: 409, code: 'NOT_CONVERTIBLE' });
  const alias = await aliasFixture(t);
  await assert.rejects(alias.service.previewConvert({}, team), { statusCode: 409, code: 'NOT_CONVERTIBLE' });
});

for (const scenario of ['unchanged', 'applied-read-fails', 'unchanged-reads-fail', 'cleanup-fails']) {
  test(`teams convert: filter save failure alias handling — ${scenario}`, async t => {
    const f = await fixture(t, convertibleScript), preview = await f.service.previewConvert({}, team);
    f.options.ignoreWrites = scenario !== 'applied-read-fails';
    f.options.failAliasDelete = scenario === 'cleanup-fails';
    f.options.onRead = () => {
      if (scenario.includes('read') && writes(f).some(row => row.path === '/api/v1/edit/filter')) throw new Error('synthetic read failure');
    };
    await assert.rejects(convertTeam(f, preview.etag), error => {
      if (scenario === 'unchanged') assert.equal(error.code, 'WRITE_VERIFY_FAILED');
      else { assert.ok(error.message.includes('적용 여부 확인 필요')); assert.ok(error.message.includes(memberAliasAddress)); }
      return true;
    });
    assert.equal(f.options.aliases.length, scenario === 'unchanged' ? 0 : 1);
    if (scenario.includes('read')) assert.ok(!writes(f).some(row => row.path === '/api/v1/delete/alias'));
    assert.equal(f.rows[0].script_data, scenario === 'applied-read-fails' ? preview.after : convertibleScript);
    assert.equal((await f.history.list()).items[0].result, 'failed');
  });
}

test('teams convert: undo verifies original filter restoration before deleting the alias; changed members refuse undo', async t => {
  const f = await fixture(t, convertibleScript), preview = await f.service.previewConvert({}, team);
  const result = await convertTeam(f, preview.etag), callCount = f.calls.length;
  f.options.aliases[0].goto = first;
  await assert.rejects(f.history.revert(result.auditId, { confirm: true, session: {} }), { code: 'CHANGED_ELSEWHERE' });
  assert.equal(writes(f).length, 2);
  f.options.aliases[0].goto = `${first},${second},${next}`;
  const reversed = await f.history.revert(result.auditId, { confirm: true, session: {}, actor: 'admin' });
  assert.equal(f.rows[0].script_data, convertibleScript); assert.deepEqual(f.options.aliases, []);
  const undoCalls = f.calls.slice(callCount), restore = undoCalls.findIndex(row => row.path === '/api/v1/edit/filter'), remove = undoCalls.findIndex(row => row.path === '/api/v1/delete/alias');
  assert.ok(restore >= 0 && remove > restore);
  assert.ok(undoCalls.slice(restore + 1, remove).some(row => row.path === '/api/v1/get/filters/all'));
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${reversed.id}.after.sieve`), 'utf8'), convertibleScript);
  await assert.rejects(f.history.revert(reversed.id, { confirm: true, session: {} }), { code: 'NOT_REVERTIBLE' });
});

test('teams convert: undo preserves alias when filter restoration cannot be verified', async t => {
  const f = await fixture(t, convertibleScript), preview = await f.service.previewConvert({}, team);
  const result = await convertTeam(f, preview.etag);
  f.options.ignoreWrites = true;
  await assert.rejects(f.history.revert(result.auditId, { confirm: true, session: {} }), { code: 'WRITE_VERIFY_FAILED' });
  assert.equal(f.options.aliases.length, 1); assert.equal(f.rows[0].script_data, preview.after);
  assert.ok(!writes(f).some(row => row.path === '/api/v1/delete/alias'));
});
