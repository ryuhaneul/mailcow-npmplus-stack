import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncService, sanitizeSyncResponse } from '../../server/admin/services/sync.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';

const ctx = { session: {}, actor: 'admin', ip: '198.51.100.58', id: '1' };
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a14-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const jobs = [{ id: 1, user2: 'owner@example.com', user1: 'source@example.net', host1: 'imap.example.net', active: '1', maxage: '0', delete1: '0', delete2: '0', delete2duplicates: '0', custom_params: '', mins_interval: '20', last_run: '2026-10-16 10:00:00', log: '' }];
  const calls = [], options = {};
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); await options.onCall?.({ method, path, body });
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/syncjobs/all/no_log') return jobs.map(row => { const { log, ...safe } = row; return structuredClone(safe); });
    if (path === '/api/v1/get/syncjobs/owner%40example.com') return structuredClone(jobs.filter(row => row.user2 === 'owner@example.com'));
    if (path === '/api/v1/edit/syncjob') { if (!options.ignoreWrites) Object.assign(jobs.find(row => String(row.id) === body.items[0]), body.attr); return [{ type: 'success', log: ['edit', { password1: 'synthetic-password-marker' }] }]; }
    if (path === '/api/v1/delete/syncjob') { if (!options.ignoreWrites) jobs.splice(jobs.findIndex(row => String(row.id) === body[0]), 1); return [{ type: 'success' }]; }
    assert.fail(path);
  } };
  const audit = createAudit({ dir }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const service = createSyncService({ mailcow, audit, lock, history });
  return { dir, jobs, calls, options, mailcow, audit, history, service };
}
const get = f => f.service.get({}, '1');
const patch = async (f, data, tag) => f.service.patch({ ...ctx, data: { etag: tag ?? (await get(f)).etag, ...data } });
const writes = f => f.calls.filter(row => row.method === 'POST');
const revert = (f, auditId) => f.history.revert(auditId, { ...ctx, confirm: true });

test('sync: list no_log; ID resolves mailbox, selects matching detail; password/master masked', async t => {
  const f = await fixture(t); f.jobs.push({ ...f.jobs[0], id: 2, log: 'other job' }); f.jobs[0].password1 = 'synthetic-password-marker'; f.jobs[0].log = '--password1 synthetic-password-marker --user2 owner@example.com*synthetic-master@mailcow.local';
  const list = await f.service.list({}); assert.equal(list.items.length, 2); assert.equal(list.items[0].log, undefined);
  const result = await get(f); assert.equal(result.id, 1); assert.match(result.log, /--password1 \*\*\*/); assert.match(result.log, /owner@example.com\*\*\*\*@mailcow.local/);
  assert.ok(!JSON.stringify(result).includes('synthetic-password-marker')); assert.ok(!JSON.stringify(result).includes('synthetic-master')); assert.equal(result.password1, undefined);
  assert.equal(f.calls.at(-1).path, '/api/v1/get/syncjobs/owner%40example.com'); assert.ok(f.calls.every(row => !row.path.includes(['with', 'password'].join('_'))));
});
test('sync sanitizer: add log nested password keys removed, secrets masked throughout response/error', () => {
  const result = sanitizeSyncResponse({ log: ['add', { password1: 'synthetic-password-marker', nested: { PASSWORD_1: 'second-marker' } }], msg: 'synthetic-password-marker second-marker owner@example.com*synthetic-master@mailcow.local' });
  assert.deepEqual(result.log, ['add', { nested: {} }]); assert.equal(result.msg, '*** *** owner@example.com****@mailcow.local'); assert.equal(sanitizeSyncResponse('bad arbitrary-secret', ['arbitrary-secret']), 'bad ***');
});
for (const flag of ['--password1 test-secret', '--password1=test-secret', '-password1 "test secret"', "--password1='test secret'", '--passfile1 /tmp/source-secret', 'password1: test-secret', '"password1":"test-secret"']) test(`sync sanitizer masks ${flag}`, () => {
  const result = sanitizeSyncResponse(`${flag} end`); for (const secret of ['test-secret', 'test secret', '/tmp/source-secret']) assert.ok(!result.includes(secret)); assert.match(result, /\*\*\*/); assert.match(result, /end$/);
});
test('sync: changed attrs only, reversible config including re-enabling deletes on confirmed undo', async t => {
  const f = await fixture(t), original = await get(f);
  const changed = await patch(f, { active: false, options: { maxage: 300, mins_interval: 60, delete1: true, delete2: true, delete2duplicates: true, custom_params: '--maxsize=100 --dry' }, confirmDelete1: true, confirmDelete2: true });
  assert.deepEqual(writes(f)[0].body, { items: ['1'], attr: { active: 0, maxage: 300, delete1: 1, delete2: 1, delete2duplicates: 1, custom_params: '--maxsize=100 --dry', mins_interval: 60 } });
  const record = await f.history.detail(changed.auditId); assert.equal(record.kind, 'config'); assert.equal(record.canRevert, true); for (const key of ['user1', 'last_run', 'log', 'password1']) assert.equal(record.before[key], undefined);
  await revert(f, changed.auditId); assert.equal((await get(f)).etag, original.etag);
  await patch(f, { options: { delete1: true, delete2: true }, confirmDelete1: true, confirmDelete2: true }); const disabled = await patch(f, { options: { delete1: false, delete2: false } }); await revert(f, disabled.auditId); assert.equal(f.jobs[0].delete1, 1); assert.equal(f.jobs[0].delete2, 1);
  assert.ok(!JSON.stringify(await f.audit.read()).includes('synthetic-password-marker'));
});
for (const key of ['delete1', 'delete2']) test(`sync: ${key} requires strong confirmation`, async t => { const f = await fixture(t); await assert.rejects(patch(f, { options: { [key]: true } }), { statusCode: 422 }); assert.equal(writes(f).length, 0); });
for (const data of [
  { options: { host1: 'imap.example.net' } }, { options: { password1: 'synthetic' } }, { user1: 'new@example.net' }, { active: 1 }, { active: '1' }, { options: { delete1: 1 } }, { options: { delete2: '0' } }, { options: { delete2duplicates: null } },
  { options: { maxage: -1 } }, { options: { maxage: 32001 } }, { options: { maxage: 0.5 } }, { options: { maxage: '20' } }, { options: { mins_interval: 0 } }, { options: { mins_interval: 43801 } }, { options: { custom_params: null } }, { confirmDelete1: 1 }, { options: [] },
]) test(`sync: invalid fields ${JSON.stringify(data)}`, async t => { const f = await fixture(t); await assert.rejects(patch(f, data), { statusCode: 422 }); assert.equal(writes(f).length, 0); });
for (const params of ['--delete1', '--delete2', '--delete', '--delete2duplicates', '--delete1emptyfolders', '--delete2folders', '--delete2foldersonly=INBOX', '--delete2foldersbutnot=INBOX', '--expunge', '--expunge1', '--expunge2', '--uidexpunge2', '--expungeaftereach', '-DELETE1EMPTYFOLDERS', '--del', '--exp', '--uidexp', '--dry --delete2folders', '--showpasswords', '-SHOWPASSWORDS', '--showpass', '--not-an-option', '--folder INBOX']) test(`sync: blocked extra parameter ${params}`, async t => { const f = await fixture(t); await assert.rejects(patch(f, { options: { custom_params: params } }), { statusCode: 422 }); assert.equal(writes(f).length, 0); });
test('sync: numeric boundaries accepted; unchanged skips write/audit', async t => {
  const f = await fixture(t); await patch(f, { options: { maxage: 32000, mins_interval: 43800 } }); await patch(f, { options: { maxage: 0, mins_interval: 1 } }); const count = writes(f).length, records = (await f.audit.read()).rows.length;
  assert.equal((await patch(f, { active: true })).unchanged, true); assert.equal(writes(f).length, count); assert.equal((await f.audit.read()).rows.length, records);
});
test('sync: existing showpasswords hides whole log; only removing it allows PATCH', async t => {
  const f = await fixture(t); f.jobs[0].custom_params = '--showpasswords --dry'; f.jobs[0].log = 'unknown-cleartext-source-password';
  const detail = await get(f); assert.equal(detail.log, undefined); assert.equal(detail.logHidden, true); assert.match(detail.logHiddenReason, /인자에서 빼면/); assert.ok(!JSON.stringify(detail).includes('unknown-cleartext-source-password')); assert.equal((await f.service.list({})).items[0].log, undefined);
  await assert.rejects(patch(f, { active: false }), { statusCode: 422 }); const changed = await patch(f, { active: false, options: { custom_params: '--dry', maxage: 20 } }); assert.equal(changed.custom_params, '--dry');
  assert.match(changed.detail.reason, /다시 넣지 않음/); assert.match(changed.detail.notice, /전체/); assert.equal((await f.history.detail(changed.auditId)).canRevert, false); await assert.rejects(revert(f, changed.auditId), { code: 'NOT_REVERTIBLE' });
});
test('sync: stale/missing etag409; log/time changes leave config etag intact', async t => {
  const f = await fixture(t), initial = await get(f); f.jobs[0].last_run = 'later'; f.jobs[0].log = 'new execution'; await patch(f, { active: false }, initial.etag);
  await assert.rejects(patch(f, { active: true }, initial.etag), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); await assert.rejects(f.service.patch({ ...ctx, data: { active: true } }), { statusCode: 409 });
});
test('sync: expected rechecked after audit intent, external change stops write', async t => {
  const f = await fixture(t), initial = await get(f); let reads = 0; f.options.onCall = ({ path }) => { if (path.endsWith('all/no_log') && ++reads === 2) f.jobs[0].mins_interval = '30'; };
  await assert.rejects(patch(f, { active: false }, initial.etag), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 0);
});
test('sync: write readback mismatch502 with failed audit', async t => { const f = await fixture(t); f.options.ignoreWrites = true; await assert.rejects(patch(f, { active: false }), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' }); assert.equal((await f.audit.read()).rows.at(-1).result, 'failed'); });
test('sync: concurrent writes serialize and reject second stale etag', async t => {
  const f = await fixture(t), tag = (await get(f)).etag, results = await Promise.allSettled([patch(f, { active: false }, tag), patch(f, { options: { maxage: 30 } }, tag)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.statusCode, 409); assert.equal(writes(f).length, 1);
});
test('sync: undo rejects changed/deleted config, ignores execution metadata', async t => {
  const f = await fixture(t), changed = await patch(f, { active: false }); f.jobs[0].maxage = '20'; await assert.rejects(revert(f, changed.auditId), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  f.jobs[0].maxage = '0'; f.jobs[0].last_run = 'later'; await revert(f, changed.auditId); const second = await patch(f, { active: false }); f.jobs.length = 0; await assert.rejects(revert(f, second.auditId), { statusCode: 409 });
});
test('sync: run-now last_run empty only; active required, no undo', async t => {
  const f = await fixture(t), result = await f.service.runNow(ctx); assert.deepEqual(writes(f)[0].body, { items: ['1'], attr: { last_run: '' } }); assert.match(result.notice, /로그/); assert.equal((await f.history.detail(result.auditId)).canRevert, false); await assert.rejects(revert(f, result.auditId), { statusCode: 409, code: 'NOT_REVERTIBLE' });
  f.jobs[0].active = '0'; await assert.rejects(f.service.runNow(ctx), { statusCode: 409, code: 'SYNC_INACTIVE' });
});
test('sync: run-now verifies reset', async t => { const f = await fixture(t); f.options.ignoreWrites = true; await assert.rejects(f.service.runNow(ctx), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' }); });
test('sync: delete safe config snapshot, verifies absence, irreversible; repeat404', async t => {
  const f = await fixture(t), initial = await get(f); await assert.rejects(f.service.remove({ ...ctx, data: { etag: 'stale' } }), { statusCode: 409 });
  const result = await f.service.remove({ ...ctx, data: { etag: initial.etag } }); assert.deepEqual(writes(f)[0].body, ['1']); assert.equal(result.deleted, true); const record = await f.history.detail(result.auditId); assert.equal(record.kind, 'irreversible'); assert.equal(record.canRevert, false); assert.equal(record.before.id, '1'); assert.equal(record.before.log, undefined);
  await assert.rejects(revert(f, result.auditId), { code: 'NOT_REVERTIBLE' }); await assert.rejects(f.service.remove({ ...ctx, data: { etag: initial.etag } }), { statusCode: 404 }); await assert.rejects(get(f), { statusCode: 404 });
});
test('sync: delete readback mismatch502', async t => { const f = await fixture(t); f.options.ignoreWrites = true; await assert.rejects(f.service.remove({ ...ctx, data: { etag: (await get(f)).etag } }), { statusCode: 502 }); });
test('sync: error redaction preserves auth-loss class', async t => {
  const f = await fixture(t); f.options.onCall = () => { throw new AppError(422, 'MAILCOW_REJECTED', 'bad --password1 test-secret owner@example.com*master-marker@mailcow.local'); }; await assert.rejects(get(f), error => error.statusCode === 422 && !error.message.includes('test-secret') && !error.message.includes('master-marker'));
  f.options.onCall = () => { throw new MailcowAuthLost(); }; await assert.rejects(get(f), error => error instanceof MailcowAuthLost && error.statusCode === 403);
});
test('sync: HTTP guard and list/detail/edit/run/delete/health smoke; no creation API', async t => {
  const f = await fixture(t), lines = []; f.jobs[0].password1 = 'synthetic-password-marker'; f.jobs[0].log = '--password1 synthetic-password-marker --user2 owner@example.com*synthetic-master@mailcow.local';
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: { level: 'info', stream: { write: line => lines.push(line) } }, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  assert.equal((await app.inject('/api/admin/syncjobs')).statusCode, 403); const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  assert.equal((await app.inject({ url: '/api/admin/syncjobs', headers })).json().items.length, 1); const detail = await app.inject({ url: '/api/admin/syncjobs/1', headers }); assert.equal(detail.statusCode, 200); assert.ok(!detail.body.includes('synthetic-password-marker')); assert.ok(!detail.body.includes('synthetic-master'));
  const changed = await app.inject({ method: 'PATCH', url: '/api/admin/syncjobs/1', headers, payload: { etag: detail.json().etag, options: { maxage: 20 } } }); assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/syncjobs/1/run-now', headers, payload: {} })).statusCode, 200); assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/syncjobs/1', headers, payload: { etag: changed.json().etag } })).statusCode, 200);
  assert.ok(!lines.join('').includes('synthetic-password-marker')); assert.ok(!lines.join('').includes('synthetic-master')); assert.equal((await app.inject('/healthz')).json().ok, true); assert.equal((await app.inject({ method: 'POST', url: '/api/admin/syncjobs', headers, payload: {} })).statusCode, 404);
});

test('sync: historical undo adapter rejects restoring showpasswords even if old record says reversible', async t => {
  const f = await fixture(t); await patch(f, { active: false });
  const safe = (await f.history.list()).items[0].after, unsafe = structuredClone(safe); unsafe.options.custom_params = '--showpasswords';
  const record = await f.audit.run({ actor: ctx.actor, ip: ctx.ip, action: 'sync.edit', target: 'sync:1', kind: 'config', revertible: true, before: unsafe, after: safe }, async intent => ({ auditId: intent.id }));
  const count = writes(f).length; await assert.rejects(revert(f, record.auditId), { statusCode: 422 }); assert.equal(writes(f).length, count);
});
test('sync: active rechecked after intent before run-now write', async t => {
  const f = await fixture(t); let count = 0; f.options.onCall = ({ path }) => { if (path.endsWith('all/no_log') && ++count === 2) f.jobs[0].active = '0'; };
  await assert.rejects(f.service.runNow(ctx), { statusCode: 409, code: 'SYNC_INACTIVE' }); assert.equal(writes(f).length, 0);
});
for (const value of ['0', '-1', '1.5', 'bad']) test(`sync: invalid ID ${value}`, async t => { const f = await fixture(t); await assert.rejects(f.service.get({}, value), { statusCode: 422 }); });
test('sync: empty upstream object is empty list; malformed result is502', async t => {
  const f = await fixture(t), history = { register() {} }, base = { audit: f.audit, lock: createResourceLock(), history };
  const empty = createSyncService({ ...base, mailcow: { async call() { return {}; } } }); assert.deepEqual(await empty.list({}), { items: [] });
  const malformed = createSyncService({ ...base, mailcow: { async call() { return 'bad'; } } }); await assert.rejects(malformed.list({}), { statusCode: 502 });
});

test('sync multi-source: inactive source blocks delete2, projects safe list, basic confirmation422 comes first', async t => {
  const f = await fixture(t); f.jobs.push({ ...f.jobs[0], id: 2, user1: 'other@example.net', host1: 'other.example.net', active: '0', password1: 'synthetic-other-password', log: 'synthetic-other-log' });
  await assert.rejects(patch(f, { options: { delete2: true }, confirmDelete2: true }), error => {
    assert.equal(error.statusCode, 409); assert.equal(error.code, 'DELETE2_MULTI_SOURCE'); assert.deepEqual(error.jobs, [{ id: '2', user1: 'other@example.net', host1: 'other.example.net', active: false, delete2: false }]); assert.ok(!JSON.stringify(error.jobs).includes('password')); assert.ok(!JSON.stringify(error.jobs).includes('log')); return true;
  });
  assert.equal(writes(f).length, 0); assert.equal((await f.audit.read()).rows.length, 0);
  await assert.rejects(patch(f, { options: { delete2: true }, confirmMultiSource: true }), { statusCode: 422 });
  await assert.rejects(patch(f, { options: { delete2: true }, confirmDelete2: true, confirmMultiSource: false }), { statusCode: 409 });
});
test('sync multi-source: confirmed change allowed and audited; user2 case ignored', async t => {
  const f = await fixture(t); f.jobs.push({ ...f.jobs[0], id: 2, user2: 'OWNER@EXAMPLE.COM', active: '0', delete2: '1' });
  await assert.rejects(patch(f, { options: { delete2: true }, confirmDelete2: true }), { code: 'DELETE2_MULTI_SOURCE' });
  const result = await patch(f, { options: { delete2: true }, confirmDelete2: true, confirmMultiSource: true }); assert.equal(f.jobs[0].delete2, 1); assert.equal(writes(f).length, 1);
  const record = await f.history.detail(result.auditId); assert.equal(record.kind, 'config'); assert.equal(record.result, 'ok'); assert.equal(record.detail.multiSourceConfirmed, true);
});
for (const value of [1, 0, 'true', null]) test(`sync multi-source: boolean confirmation required ${value}`, async t => {
  const f = await fixture(t); await assert.rejects(patch(f, { options: { delete2: true }, confirmDelete2: true, confirmMultiSource: value }), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});
test('sync multi-source: self only/different user2 no additional confirmation', async t => {
  const f = await fixture(t); await patch(f, { options: { delete2: true }, confirmDelete2: true }); assert.equal(f.jobs[0].delete2, 1);
  await patch(f, { options: { delete2: false } }); f.jobs.push({ ...f.jobs[0], id: 2, user2: 'other@example.com' }); await patch(f, { options: { delete2: true }, confirmDelete2: true }); assert.equal(f.jobs[0].delete2, 1);
});
test('sync multi-source: already enabled delete2 allows other options and disabling', async t => {
  const f = await fixture(t); f.jobs[0].delete2 = '1'; f.jobs.push({ ...f.jobs[0], id: 2 }); await patch(f, { options: { maxage: 20 } }); assert.equal(f.jobs[0].maxage, 20); await patch(f, { options: { delete2: false } }); assert.equal(f.jobs[0].delete2, 0);
});
test('sync multi-source: undo cannot re-enable delete2 with another job; no upstream changes', async t => {
  const f = await fixture(t); f.jobs[0].delete2 = '1'; const result = await patch(f, { options: { delete2: false } }); f.jobs.push({ ...f.jobs[0], id: 2 });
  const count = writes(f).length; await assert.rejects(revert(f, result.auditId), error => error.statusCode === 409 && error.code === 'DELETE2_MULTI_SOURCE' && error.message.includes('동기화 화면') && error.message.includes('다른 동기화 작업')); assert.equal(writes(f).length, count); assert.equal(f.jobs[0].delete2, 0);
});
test('sync multi-source: source appearing after preflight caught immediately before write', async t => {
  const f = await fixture(t), tag = (await get(f)).etag; let reads = 0; f.options.onCall = ({ path }) => { if (path.endsWith('all/no_log') && ++reads === 3) f.jobs.push({ ...f.jobs[0], id: 2 }); };
  await assert.rejects(patch(f, { options: { delete2: true }, confirmDelete2: true }, tag), { code: 'DELETE2_MULTI_SOURCE' }); assert.equal(writes(f).length, 0);
});
test('sync multi-source HTTP:409 with jobs, confirmed PATCH success, history409 contains guidance', async t => {
  const f = await fixture(t); f.jobs.push({ ...f.jobs[0], id: 2, active: '0', password1: 'synthetic-other-password', log: 'synthetic-other-log' });
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: false, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } }); const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': login.json().csrf };
  const send = payload => app.inject({ method: 'PATCH', url: '/api/admin/syncjobs/1', headers, payload });
  const data = { etag: (await get(f)).etag, options: { delete2: true }, confirmDelete2: true }, denied = await send(data); assert.equal(denied.statusCode, 409, denied.body); assert.deepEqual(denied.json().error.jobs, [{ id: '2', user1: 'source@example.net', host1: 'imap.example.net', active: false, delete2: false }]); assert.ok(!denied.body.includes('password1')); assert.ok(!denied.body.includes('log')); assert.equal(writes(f).length, 0);
  const allowed = await send({ ...data, confirmMultiSource: true }); assert.equal(allowed.statusCode, 200, allowed.body);
  const disabled = await send({ etag: allowed.json().etag, options: { delete2: false } }); assert.equal(disabled.statusCode, 200);
  const reverted = await app.inject({ method: 'POST', url: `/api/admin/history/${disabled.json().auditId}/revert`, headers, payload: { confirm: true } }); assert.equal(reverted.statusCode, 409, reverted.body); assert.equal(reverted.json().error.code, 'DELETE2_MULTI_SOURCE'); assert.match(reverted.json().error.message, /동기화 화면/);
});
