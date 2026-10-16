import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountsService } from '../../server/admin/services/accounts.js';
import { createSendersService } from '../../server/admin/services/senders.js';
import { createTeamsService } from '../../server/admin/services/teams.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';

const user = 'user@example.com', team = 'team@example.com', other = 'other@example.com', secret = 'synthetic-A07-sync-secret';
const source = `require ["copy"];\n# 원문 보존\nredirect :copy "${user}";\nredirect :copy "${other}";\nstop;\n`;
const context = { session: {}, actor: 'admin', ip: '198.51.100.23' };
const makeBox = username => ({ username, name: username, quota: 20 * 1024 ** 3, quota_used: 2048, messages: 12, active: 1, sender_acl: [], attributes: { imap_access: '1', pop3_access: '1', smtp_access: '1', sieve_access: '1', eas_access: '1', dav_access: '1' } });
async function fixture(t, populated = true) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a07-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const boxes = [user, team, other].map(makeBox), filters = [], aliases = [], jobs = [], acl = new Map(), calls = [], aclCalls = [], options = {};
  if (populated) {
    boxes[0].sender_acl = [team, 'archive@example.com']; boxes[2].sender_acl = [user, team];
    filters.push({ id: 10, username: team, filter_type: 'prefilter', active: 1, script_desc: '분배', script_data: source });
    aliases.push({ id: 1, address: 'only@example.com', goto: user, active: 1 }, { id: 2, address: 'multi@example.com', goto: `${user},${other}`, active: 1 });
    jobs.push({ id: 8, user2: user, active: 1, password1: secret, custom_params: '--synthetic' });
    acl.set(team, [{ user: team, id: user, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
    acl.set(user, [{ user, id: other, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
    // Individual mailbox sharing is included for deletion, beyond the normal detail scope.
    acl.set(other, [{ user: other, id: user, mailbox: 'INBOX', rights: ['lookup', 'read', 'write'] }]);
  }
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); options.onCall?.({ method, path, body });
    if (method === 'POST' && options.failPath === path) throw options.failure ?? new AppError(422, 'MAILCOW_REJECTED', secret);
    if (path === '/api/v1/edit/alias') await options.beforeAliasWrite?.();
    if (path === '/api/v1/get/domain/all') return [{ domain_name: 'example.com', active: 1 }];
    if (path === '/api/v1/get/alias-domain/all') return [];
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/mailbox/all') return structuredClone(boxes);
    if (path.startsWith('/api/v1/get/mailbox/')) return structuredClone(boxes.find(row => row.username === decodeURIComponent(path.split('/').at(-1))) ?? {});
    if (path === '/api/v1/get/filters/all') return structuredClone(filters);
    if (path === '/api/v1/get/alias/all') return structuredClone(aliases);
    if (path === '/api/v1/get/syncjobs/all/no_log') return structuredClone(jobs);
    if (path.startsWith('/api/v1/get/app-passwd/all/')) return [];
    if (options.ignoreWrites) return [{ type: 'success' }];
    if (path === '/api/v1/delete/alias') for (const id of body) aliases.splice(aliases.findIndex(row => String(row.id) === id), 1);
    else if (path === '/api/v1/edit/alias') for (const id of body.items) {
      const alias = aliases.find(row => String(row.id) === id); Object.assign(alias, body.attr);
      // mailcow deletes explicit alias grants for every supplied goto (functions.mailbox.inc.php:2752).
      if (Object.hasOwn(body.attr, 'goto')) for (const box of boxes) if (alias.goto.split(',').includes(box.username)) box.sender_acl = box.sender_acl.filter(value => value !== alias.address);
    } else if (path === '/api/v1/edit/filter') for (const id of body.items) Object.assign(filters.find(row => String(row.id) === id), body.attr);
    else if (path === '/api/v1/add/filter') filters.push({ id: 100 + filters.length, ...body });
    else if (path === '/api/v1/edit/mailbox') for (const addr of body.items) {
      const row = boxes.find(box => box.username === addr);
      for (const [key, value] of Object.entries(body.attr)) if (key !== 'sender_acl' || !options.ignoreSenderWrites) row[key] = key === 'active' ? Number(value) : structuredClone(value);
    } else if (path === '/api/v1/delete/syncjob') for (const id of body) jobs.splice(jobs.findIndex(row => String(row.id) === id), 1);
    else if (path === '/api/v1/delete/mailbox') for (const addr of body) {
      boxes.splice(boxes.findIndex(row => row.username === addr), 1);
      for (let i = filters.length - 1; i >= 0; i--) if (filters[i].username === addr) filters.splice(i, 1);
    } else assert.fail(path);
    return [{ type: 'success' }];
  } };
  const dockerapi = {
    async getAcl(owner) { aclCalls.push(owner); if (options.aclFailure === owner) throw new Error(secret); return structuredClone([...acl.values()].flat().filter(row => row.user === owner || row.id === owner)); },
    async deleteAcl(owner, grantee) { calls.push({ method: 'POST', path: 'dockerapi/delete_acl', body: { owner, grantee } }); if (!options.ignoreAclWrites) acl.set(owner, (acl.get(owner) ?? []).filter(row => row.mailbox !== 'INBOX' || row.id !== grantee)); },
  };
  const audit = createAudit({ dir }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const teams = createTeamsService({ mailcow, audit, lock, history, auditDir: dir });
  const service = createAccountsService({ mailcow, dockerapi, audit, lock, history, teams });
  return { dir, boxes, filters, aliases, jobs, acl, calls, aclCalls, options, mailcow, dockerapi, audit, lock, history, service };
}
const writes = f => f.calls.filter(row => row.method === 'POST');
const preview = f => f.service.deletePreview({}, user);
const remove = (f, data) => f.service.remove({ ...context, addr: user, data });
const confirmed = etag => ({ etag, confirmAddress: user, cleanRefs: true });
const leave = (f, data) => f.service.leave({ ...context, data: { address: user, mode: 'disable', cleanRefs: false, ...data } });

test('lifecycle: delete preview includes all five references, unique alias impact, counts and all ACL scope', async t => {
  const f = await fixture(t), result = await preview(f);
  assert.equal(result.messages, 12); assert.equal(result.usedBytes, 2048); assert.equal(result.irreversible, true);
  assert.match(result.confirmation, /복구할 수 없어요/); assert.equal(result.confirmAddress, user); assert.equal(result.sharesScope, 'all');
  assert.equal(result.refs.aliases.find(row => row.address === 'only@example.com').effect, 'deleted');
  assert.equal(result.refs.aliases.find(row => row.address === 'multi@example.com').effect, 'target_removed');
  assert.equal(result.refs.teams.length, 1); assert.equal(result.refs.senders.length, 3); assert.equal(result.refs.shares.length, 3); assert.equal(result.refs.syncjobs.length, 1);
  assert.ok(f.aclCalls.includes(other)); assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('redirect'));
  assert.equal(writes(f).length, 0);
});

test('lifecycle: delete validates exact confirmation and cleanRefs before any mutation', async t => {
  const f = await fixture(t), result = await preview(f);
  for (const data of [{ ...confirmed(result.etag), confirmAddress: other }, { ...confirmed(result.etag), confirmAddress: 'USER@example.com' }, { ...confirmed(result.etag), cleanRefs: false }]) {
    await assert.rejects(remove(f, data), { statusCode: 422 });
  }
  await assert.rejects(remove(f, confirmed('missing')), { statusCode: 409 }); assert.equal(writes(f).length, 0);
});

for (const [name, change] of [
  ['alias targets', f => { f.aliases[1].goto += ',new@example.com'; }],
  ['filter bytes with same members', f => { f.filters[0].script_data += '# concurrent\n'; }],
  ['sender permissions', f => { f.boxes[2].sender_acl.push('new@example.com'); }],
  ['individual share rights', f => { f.acl.get(other)[0].rights.push('delete'); }],
  ['sync options or secret', f => { f.jobs[0].password1 = 'changed-synthetic-secret'; }],
  ['account settings', f => { f.boxes[0].name = 'changed'; }],
]) test(`lifecycle: preview etag catches ${name} changes`, async t => {
  const f = await fixture(t), initial = await preview(f); change(f);
  await assert.rejects(remove(f, confirmed(initial.etag)), { statusCode: 409 }); assert.equal(writes(f).length, 0);
});

test('lifecycle: incoming message counts do not invalidate delete etag', async t => {
  const f = await fixture(t), initial = await preview(f); f.boxes[0].messages++; f.boxes[0].quota_used++;
  assert.equal((await preview(f)).etag, initial.etag);
});

test('lifecycle: cleanup follows alias→team→sender→ACL→sync→mailbox order and retains unrelated values', async t => {
  const f = await fixture(t), result = await remove(f, confirmed((await preview(f)).etag));
  assert.equal(result.result, 'ok');
  assert.deepEqual(writes(f).map(call => call.path), [
    '/api/v1/edit/alias', '/api/v1/delete/alias', '/api/v1/edit/filter', '/api/v1/edit/mailbox', '/api/v1/edit/mailbox',
    'dockerapi/delete_acl', 'dockerapi/delete_acl', 'dockerapi/delete_acl', '/api/v1/delete/syncjob', '/api/v1/delete/mailbox',
  ]);
  assert.deepEqual(f.aliases.map(row => [row.address, row.goto]), [['multi@example.com', other]]);
  assert.ok(!f.filters[0].script_data.includes(user)); assert.ok(f.filters[0].script_data.includes(other)); assert.ok(f.filters[0].script_data.includes('# 원문 보존'));
  assert.deepEqual(f.boxes.find(row => row.username === other).sender_acl, [team]); assert.equal(f.jobs.length, 0);
  assert.ok(!f.boxes.some(row => row.username === user));
  const record = (await f.history.list()).items.find(row => row.action === 'mailbox.delete');
  assert.equal(record.kind, 'irreversible'); assert.equal(record.canRevert, false); assert.equal(record.detail.messages, 12); assert.equal(record.detail.usedBytes, 2048);
  assert.equal(record.detail.cleaned.aliases.length, 2); assert.ok(!JSON.stringify(record).includes(secret));
  await assert.rejects(f.history.revert(record.id, { ...context, confirm: true }), { statusCode: 409 });
  const child = (await f.history.list()).items.find(row => row.action === 'team.member.remove');
  assert.equal(child.kind, 'irreversible'); assert.equal(child.canRevert, false);
  await assert.rejects(f.history.revert(child.id, { ...context, confirm: true }), { statusCode: 409 });
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${child.id}.before.sieve`), 'utf8'), source);
});

for (const [name, setup, code] of [
  ['last member', f => { f.filters[0].script_data = `redirect :copy "${user}";\n`; }, 'LAST_MEMBER'],
  ['unparseable unrelated redirect', f => { f.filters[0].script_data = 'redirect :copy "missing@example.com"'; }, 'UNPARSEABLE'],
  ['multiple prefilters', f => { f.filters.push({ ...f.filters[0], id: 11 }); }, 'MULTIPLE_PREFILTERS'],
  ['stopper', f => { f.filters[0].script_data = `stop;\n${source}`; }, 'STOPPER_BEFORE_MEMBER'],
]) test(`lifecycle: ${name} is rejected during preview before mutation`, async t => {
  const f = await fixture(t); setup(f);
  await assert.rejects(preview(f), error => error.statusCode === 409 && error.code === code && error.message.includes(team)); assert.equal(writes(f).length, 0);
});

test('lifecycle: ACL failures refuse preview and run without mutation, including unrelated individual mailbox', async t => {
  const f = await fixture(t), initial = await preview(f); f.options.aclFailure = other;
  await assert.rejects(preview(f), { statusCode: 502, code: 'SHARES_UNAVAILABLE' });
  await assert.rejects(remove(f, confirmed(initial.etag)), { statusCode: 502 }); assert.equal(writes(f).length, 0);
});

test('lifecycle: inactive target ACL is included and requests never exceed four concurrent workers', async t => {
  const f = await fixture(t, false); f.boxes[0].active = 0;
  for (let i = 0; i < 10; i++) f.boxes.push(makeBox(`extra${i}@example.com`));
  let active = 0, maximum = 0; const owners = [];
  f.dockerapi.getAcl = async owner => { owners.push(owner); active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--; return []; };
  await preview(f); assert.equal(maximum, 4); assert.ok(owners.includes(user));
});

test('lifecycle: late reference insertion stops final mailbox deletion with partial record', async t => {
  const f = await fixture(t), initial = await preview(f);
  f.options.onCall = ({ path }) => { if (path === '/api/v1/delete/syncjob') f.aliases.push({ id: 9, address: 'late@example.com', goto: user, active: 1 }); };
  const result = await remove(f, confirmed(initial.etag));
  assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'REFERENCES_REMAIN');
  assert.equal(writes(f).filter(row => row.path === '/api/v1/delete/mailbox').length, 0); assert.ok(f.boxes.some(row => row.username === user));
  assert.equal((await f.history.list()).items.find(row => row.action === 'mailbox.delete').result, 'partial');
});

test('lifecycle: first business failure preserves its status; later failure records partial with safe code', async t => {
  const f = await fixture(t), initial = await preview(f); f.options.failPath = '/api/v1/edit/alias';
  await assert.rejects(remove(f, confirmed(initial.etag)), { statusCode: 422 });
  f.options.failPath = '/api/v1/edit/filter';
  const result = await remove(f, confirmed((await preview(f)).etag));
  assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'MAILCOW_REJECTED'); assert.equal(f.aliases.length, 1);
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify((await f.audit.read()).rows).includes(secret));
});

test('lifecycle: later auth loss is recorded partial then rethrown as original 403', async t => {
  const f = await fixture(t); const expected = (await preview(f)).etag, failure = new MailcowAuthLost();
  f.options.failPath = '/api/v1/edit/filter'; f.options.failure = failure;
  await assert.rejects(remove(f, confirmed(expected)), error => error === failure);
  assert.equal((await f.history.list()).items.find(row => row.action === 'mailbox.delete').result, 'partial');
});

test('lifecycle: disable without cleanup blocks login, creates copy-only prefilter and keeps all references', async t => {
  const f = await fixture(t); const initial = await leave(f, { action: 'preview', forwardTo: other });
  assert.equal(initial.sharesScope, 'none'); assert.equal(f.aclCalls.length, 0);
  const result = await leave(f, { action: 'run', forwardTo: other, etag: initial.etag });
  assert.equal(result.result, 'ok'); assert.equal(f.boxes[0].active, 2);
  assert.deepEqual(writes(f).map(call => call.path), ['/api/v1/edit/mailbox', '/api/v1/add/filter']);
  const forward = f.filters.find(row => row.username === user); assert.equal(forward.script_data, `require ["copy"];\nredirect :copy "${other}";\n`);
  assert.equal(f.aliases.length, 2); assert.equal(f.jobs.length, 1); assert.ok(f.filters[0].script_data.includes(user));
  assert.deepEqual(result.warnings.map(row => row.message), ['로그인 차단은 최대 5분 안에 적용돼요', '퇴사자 기기의 메일 계정 설정을 지워 주세요']);
  const record = (await f.history.list()).items.find(row => row.action === 'team.forward');
  assert.equal(record.canRevert, false); assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${record.id}.before.sieve`), 'utf8'), '');
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${record.id}.after.sieve`), 'utf8'), forward.script_data);
  assert.ok(!JSON.stringify((await f.audit.read()).rows).includes('redirect'));
});

test('lifecycle: disable cleanRefs preserves aliases but cleans team, sender, individual shares and syncjobs', async t => {
  const f = await fixture(t), initial = await leave(f, { action: 'preview', cleanRefs: true });
  assert.ok(initial.refs.aliases.every(row => row.effect === 'kept'));
  const result = await leave(f, { action: 'run', cleanRefs: true, etag: initial.etag });
  assert.equal(result.result, 'ok'); assert.equal(f.boxes[0].active, 2); assert.equal(f.aliases.length, 2);
  assert.equal(writes(f)[0].path, '/api/v1/edit/mailbox'); assert.ok(!writes(f).some(row => row.path.endsWith('/alias')));
  assert.ok(!f.filters[0].script_data.includes(user)); assert.deepEqual(f.boxes[0].sender_acl, []); assert.deepEqual(f.boxes[2].sender_acl, [team]);
  assert.equal(f.jobs.length, 0); for (const acl of f.acl.values()) assert.equal(acl.length, 0);
  assert.equal((await f.history.list()).items.find(row => row.action === 'team.member.remove').canRevert, true);
});

test('lifecycle: disable appends to existing team filter with original bytes and reversible raw backup', async t => {
  const f = await fixture(t, false), original = `require ["copy"];\r\n# 보존\r\nredirect :copy "${team}";\r\nstop;\r\n`;
  f.filters.push({ id: 10, username: user, filter_type: 'prefilter', active: 1, script_data: original });
  const initial = await leave(f, { action: 'preview', forwardTo: other });
  const result = await leave(f, { action: 'run', forwardTo: other, etag: initial.etag }); assert.equal(result.result, 'ok');
  assert.equal(f.filters[0].script_data, original.replace('stop;', `redirect :copy "${other}";\r\nstop;`));
  const record = (await f.history.list()).items.find(row => row.action === 'team.forward'); assert.equal(record.canRevert, true);
  await f.history.revert(record.id, { ...context, confirm: true }); assert.equal(f.filters[0].script_data, original);
});

for (const forwardTo of ['external@example.net', user, 'bad-address']) test(`lifecycle: invalid/noninternal forward ${forwardTo} fails before active change`, async t => {
  const f = await fixture(t, false); await assert.rejects(leave(f, { action: 'preview', forwardTo }), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});

for (const script of ['keep;\n', 'redirect "other@example.com";\n', 'redirect :copy "other@example.com"']) test(`lifecycle: unsafe own forward prefilter refuses preview`, async t => {
  const f = await fixture(t, false); f.filters.push({ id: 10, username: user, filter_type: 'prefilter', active: 1, script_data: script });
  await assert.rejects(leave(f, { action: 'preview', forwardTo: team }), { statusCode: 409 }); assert.equal(writes(f).length, 0);
});

test('lifecycle: disable without cleanup ignores unrelated unsafe teams but hashes own filter/account and forwarding choice', async t => {
  const f = await fixture(t); f.filters[0].script_data = 'redirect "broken@example.com"';
  const initial = await leave(f, { action: 'preview' });
  assert.equal(f.aclCalls.length, 0); f.aliases[0].goto = other;
  assert.equal((await leave(f, { action: 'preview' })).etag, initial.etag);
  await assert.rejects(leave(f, { action: 'run', etag: initial.etag, forwardTo: other }), { statusCode: 409 });
  f.boxes[0].name = 'concurrent'; await assert.rejects(leave(f, { action: 'run', etag: initial.etag }), { statusCode: 409 });
});

test('lifecycle: forwarding failure after active update leaves mailbox receiving and returns partial warnings', async t => {
  const f = await fixture(t, false), initial = await leave(f, { action: 'preview', forwardTo: other });
  f.options.failPath = '/api/v1/add/filter';
  const result = await leave(f, { action: 'run', forwardTo: other, etag: initial.etag });
  assert.equal(result.result, 'partial'); assert.equal(f.boxes[0].active, 2); assert.equal(result.steps.at(-1).stage, 'forward'); assert.equal(result.warnings.length, 2);
});

test('lifecycle: leave delete delegates to the same deletion workflow and includes both notices', async t => {
  const f = await fixture(t, false), initial = await leave(f, { action: 'preview', mode: 'delete', cleanRefs: true });
  const result = await leave(f, { action: 'run', mode: 'delete', cleanRefs: true, etag: initial.etag, confirmAddress: user });
  assert.equal(result.result, 'ok'); assert.equal(result.warnings.length, 2); assert.equal(writes(f).at(-1).path, '/api/v1/delete/mailbox');
});

test('lifecycle: intent failure prevents every write', async t => {
  const f = await fixture(t, false), initial = await preview(f); await fs.rm(f.dir, { recursive: true }); await fs.writeFile(f.dir, 'synthetic-blocker');
  await assert.rejects(remove(f, confirmed(initial.etag)), { statusCode: 500, code: 'AUDIT_UNAVAILABLE' }); assert.equal(writes(f).length, 0);
});

test('lifecycle HTTP: preview/delete and leave use auth, JSON, Origin, CSRF guard and no challenge header', async t => {
  const f = await fixture(t, false);
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: false,
    dockerapi: f.dockerapi, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  const url = `/api/admin/mailboxes/${user}`;
  assert.equal((await app.inject({ method: 'POST', url: `${url}/delete-preview`, headers: { origin: 'https://mailadmin.example.com' }, payload: {} })).statusCode, 403);
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  const initial = await app.inject({ method: 'POST', url: `${url}/delete-preview`, headers, payload: {} }); assert.equal(initial.statusCode, 200, initial.body);
  const denied = await app.inject({ method: 'DELETE', url, headers: { ...headers, 'x-mailadmin-csrf': '' }, payload: confirmed(initial.json().etag) }); assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
  const off = await app.inject({ method: 'POST', url: '/api/admin/flows/leave', headers, payload: { action: 'preview', mode: 'disable', address: user, cleanRefs: false } }); assert.equal(off.statusCode, 200, off.body);
  const done = await app.inject({ method: 'DELETE', url, headers, payload: confirmed(initial.json().etag) }); assert.equal(done.statusCode, 200, done.body); assert.equal(done.json().result, 'ok'); assert.equal(done.headers['cache-control'], 'no-store');
});

test('lifecycle: a late unparseable redirect blocks final delete even when membership can no longer be read', async t => {
  const f = await fixture(t), initial = await preview(f);
  f.options.onCall = ({ path }) => { if (path === '/api/v1/delete/syncjob') f.filters[0].script_data = 'redirect :copy "hidden@example.com"'; };
  const result = await remove(f, confirmed(initial.etag));
  assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'UNPARSEABLE');
  assert.ok(!writes(f).some(row => row.path === '/api/v1/delete/mailbox'));
});

for (const ignoreSenderWrites of [false, true]) test(`lifecycle regression: alias goto preserves unrelated explicit sender ACL; restore ignored=${ignoreSenderWrites}`, async t => {
  const f = await fixture(t, false), alias = 'multi@example.com';
  f.aliases.push({ id: 2, address: alias, goto: `${user},${other}`, active: 1, sender_allowed: '0' });
  f.boxes[2].sender_acl = [alias, team];
  const initial = await preview(f); f.options.ignoreSenderWrites = ignoreSenderWrites;
  const result = await remove(f, confirmed(initial.etag));
  if (ignoreSenderWrites) {
    assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'WRITE_VERIFY_FAILED');
    assert.equal(result.steps.at(-1).stage, 'aliases'); assert.ok(result.recovery[0].message.includes('보내기 권한'));
    assert.ok(f.boxes.some(row => row.username === user));
    assert.equal((await f.history.list()).items.find(row => row.action === 'mailbox.delete').result, 'partial');
  } else {
    assert.equal(result.result, 'ok'); assert.deepEqual(f.boxes.find(row => row.username === other).sender_acl, [alias, team]);
  }
});

for (const active of [0, 1, 2]) test(`lifecycle regression: incoming shares from owner active=${active} are previewed and removed`, async t => {
  const f = await fixture(t, false); f.boxes[2].active = active;
  f.acl.set(other, [{ user: other, id: user, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
  const initial = await preview(f);
  assert.deepEqual(initial.refs.shares, [{ owner: other, grantee: user, rights: ['lookup', 'read'] }]);
  const result = await remove(f, confirmed(initial.etag)); assert.equal(result.result, 'ok');
  assert.deepEqual(f.acl.get(other), []); assert.ok(!f.boxes.some(row => row.username === user));
});

test('lifecycle regression: sender revocation waits for alias preservation and is never restored', { timeout: 5000 }, async t => {
  const f = await fixture(t, false), alias = 'multi@example.com';
  f.aliases.push({ id: 2, address: alias, goto: `${user},${team},${other},${other}`, active: 1, sender_allowed: '0' });
  f.boxes[1].sender_acl = [alias]; f.boxes[2].sender_acl = [alias];
  const senders = createSendersService(f), initial = await preview(f);
  const active = new Set(), acquired = [], originalRun = f.lock.run;
  let notifyBlocked, revocation, revoked = false, heldAtAliasWrite, acquiredAtAliasWrite;
  const blocked = new Promise(resolve => { notifyBlocked = resolve; });
  // Observe the real, non-reentrant lock; let the hook proceed once the writer is queued.
  f.lock.run = (key, operation) => {
    if (key === other && active.has(key)) notifyBlocked();
    return originalRun(key, async () => {
      active.add(key); acquired.push(key);
      try { return await operation(); } finally { active.delete(key); }
    });
  };
  f.options.beforeAliasWrite = async () => {
    heldAtAliasWrite = [...active]; acquiredAtAliasWrite = [...acquired];
    const current = await senders.get({}, other);
    revocation = senders.put({ ...context, addr: other, data: { etag: current.etag, add: [], remove: [alias] } }).then(result => {
      revoked = true; return result;
    });
    // Old code permits completion here; fixed code queues the revocation until restoration ends.
    await Promise.race([revocation, blocked]);
  };
  const result = await remove(f, confirmed(initial.etag));
  await revocation;
  assert.equal(result.result, 'ok'); assert.equal(revoked, true);
  assert.deepEqual(f.boxes.find(row => row.username === other).sender_acl, []);
  assert.deepEqual(f.boxes.find(row => row.username === team).sender_acl, [alias]);
  assert.ok(!f.boxes.some(row => row.username === user));
  assert.ok(heldAtAliasWrite.includes(other) && heldAtAliasWrite.includes(team));
  assert.deepEqual(acquiredAtAliasWrite.filter(key => [other, team].includes(key)), [other, team]);
  const senderWrites = writes(f).filter(row => row.path === '/api/v1/edit/mailbox' && row.body.items.includes(other));
  assert.deepEqual(senderWrites.map(row => row.body.attr.sender_acl), [[alias], []]);
});

test('lifecycle regression: concurrent deletes never lock a goto alias as a mailbox', async t => {
  const f = await fixture(t, false), u = 'u@example.com', v = 'v@example.com', mailbox = 'a-mailbox@example.com';
  const x = 'x-alias@example.com', z = 'z-alias@example.com';
  f.boxes.splice(0, f.boxes.length, ...[u, v, mailbox].map(makeBox));
  f.aliases.push({ id: 1, address: x, goto: `${u},${mailbox},${z}`, active: 1, sender_allowed: '0' },
    { id: 2, address: z, goto: `${v},${mailbox}`, active: 1, sender_allowed: '0' });
  const pu = await f.service.deletePreview({}, u), pv = await f.service.deletePreview({}, v);
  const active = new Set(), originalRun = f.lock.run;
  let notifyHeld, releaseMailbox, notifyWaiting, paused = false;
  const held = new Promise(resolve => { notifyHeld = resolve; });
  const released = new Promise(resolve => { releaseMailbox = resolve; });
  const waiting = new Promise(resolve => { notifyWaiting = resolve; });
  f.lock.run = (key, operation) => {
    if (key === mailbox && active.has(z)) notifyWaiting();
    return originalRun(key, async () => {
      active.add(key);
      try {
        if (key === mailbox && !paused && active.has(x) && !active.has(z)) {
          paused = true; notifyHeld(); await released;
        }
        return await operation();
      } finally { active.delete(key); }
    });
  };
  const removeAddress = (addr, plan) => f.service.remove({ ...context, addr, data: { etag: plan.etag, confirmAddress: addr, cleanRefs: true } });
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('concurrent deletes did not finish within 5 seconds')), 5000); });
  try {
    const results = await Promise.race([deadline, (async () => {
      const du = removeAddress(u, pu);
      await held;
      const dv = removeAddress(v, pv);
      await waiting;
      releaseMailbox();
      return Promise.all([du, dv]);
    })()]);
    assert.deepEqual(results.map(row => row.result), ['ok', 'ok']);
    assert.deepEqual(f.boxes.map(row => row.username), [mailbox]);
    assert.equal(f.aliases.find(row => row.address === x).goto, `${mailbox},${z}`);
    assert.equal(f.aliases.find(row => row.address === z).goto, mailbox);
  } finally { clearTimeout(timer); }
});
