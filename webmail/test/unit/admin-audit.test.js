import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createAudit, sanitizeAudit } from '../../server/admin/audit.js';
import { createResourceLock, etag, assertUnchanged } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';
import { logOptions } from '../../server/log.js';

const entry = { actor: 'admin', ip: '198.51.100.9', action: 'team.member.add', target: 'operations@example.com', kind: 'config', revertible: true,
  before: { members: ['first@example.com'] }, after: { members: ['first@example.com', 'second@example.com'] } };
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a04-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = Date.UTC(2026, 9, 16, 8);
  const logs = [];
  const logger = { info: value => logs.push(value), warn: value => logs.push(value) };
  const audit = createAudit({ dir, now: () => time, logger, ...options });
  const lock = createResourceLock(); const history = createHistoryService({ audit, lock });
  return { dir, audit, lock, history, logs, setTime(value) { time = value; }, advance(ms) { time += ms; } };
}
const seed = (f, changes = {}, result = {}) => f.audit.run({ ...entry, ...changes }, async intent => ({ id: intent.id, ...result }));

function syncFault(shouldFail) {
  let syncs = 0;
  return { ...fs, async open(...args) {
    const handle = await fs.open(...args);
    return {
      chmod: (...values) => handle.chmod(...values), stat: () => handle.stat(), read: (...values) => handle.read(...values),
      writeFile: (...values) => handle.writeFile(...values), close: () => handle.close(),
      async sync() { syncs++; if (shouldFail(syncs)) throw new Error('synthetic-fsync-failure'); await handle.sync(); },
    };
  } };
}

test('admin audit: durable intent exists before operation, matching result and private monthly file', async t => {
  const f = await fixture(t); let calls = 0;
  const returned = await f.audit.run(entry, async intent => {
    calls++; const { rows } = await f.audit.read();
    assert.equal(rows.length, 1); assert.equal(rows[0].phase, 'intent'); assert.equal(rows[0].id, intent.id);
    return { id: intent.id, detail: { steps: ['saved'] } };
  });
  assert.equal(calls, 1);
  const { rows, damaged } = await f.audit.read();
  assert.equal(rows.length, 2); assert.equal(rows[1].id, returned.id); assert.equal(rows[1].result, 'ok');
  assert.equal(rows[0].v, 1); assert.match(rows[0].id, /^[a-f0-9]{32}$/); assert.match(rows[0].ts, /\+09:00$/);
  assert.equal((await fs.stat(join(f.dir, '2026-10.jsonl'))).mode & 0o777, 0o600);
  assert.deepEqual(damaged, { count: 0, lines: [] });
  assert.deepEqual(Object.keys(f.logs[0]).sort(), ['action', 'code', 'id']);
});

test('admin audit: intent fsync failure prevents external writes and returns AUDIT_UNAVAILABLE', async t => {
  const f = await fixture(t, { fs: syncFault(() => true) }); let calls = 0;
  await assert.rejects(f.audit.run(entry, async () => { calls++; }), { statusCode: 500, code: 'AUDIT_UNAVAILABLE' });
  assert.equal(calls, 0);
  const record = (await f.history.list()).items[0]; assert.match(record.summary, /결과 확인 안 됨/); assert.equal(record.canRevert, false);
});

test('admin audit: result fsync failure distinguishes an already applied change', async t => {
  const f = await fixture(t, { fs: syncFault(number => number === 2) }); let calls = 0;
  await assert.rejects(f.audit.run(entry, async () => { calls++; return {}; }), {
    statusCode: 500, code: 'AUDIT_RESULT_UNAVAILABLE', message: '변경은 적용됐지만 결과 기록을 남기지 못했어요. 변경 기록을 확인해 주세요',
  });
  assert.equal(calls, 1);
});

test('admin audit: failed operations write paired safe code, omit exception text and rethrow original', async t => {
  const f = await fixture(t); const error = new AppError(422, 'MAILCOW_REJECTED', 'synthetic-private-error');
  await assert.rejects(f.audit.run(entry, async () => { throw error; }), value => value === error);
  const { rows } = await f.audit.read(); assert.equal(rows[1].phase, 'result'); assert.equal(rows[1].result, 'failed');
  assert.equal(rows[1].code, 'MAILCOW_REJECTED'); assert.equal(rows[0].id, rows[1].id);
  assert.ok(!(await fs.readFile(join(f.dir, '2026-10.jsonl'), 'utf8')).includes('synthetic-private-error'));
});

test('admin audit: partial operations preserve safe successful-step detail', async t => {
  const f = await fixture(t);
  await seed(f, {}, { result: 'partial', detail: { steps: ['mailbox-created'], count: 1 } });
  const record = (await f.history.list()).items[0]; assert.equal(record.result, 'partial'); assert.equal(record.canRevert, false);
  assert.deepEqual(record.detail, { steps: ['mailbox-created'], count: 1 });
});

test('admin audit: full nested secret list removed from before, after and detail; password markers retained', async t => {
  const f = await fixture(t);
  const names = ['password', 'password1', 'password2', 'initialPassword', 'code', 'script', 'script_data', 'key', 'apiKey', 'DOVEADM_KEY',
    'token', 'csrf', 'csrfToken', 'cookie', 'cookieJar', 'session', 'mailcowSession', 'body', 'html', 'text', 'subject', 'Message-ID', 'totp_secret'];
  const values = Object.fromEntries(names.map((name, index) => [name, `synthetic-secret-${index}`]));
  const nested = { allowed: 'safe', nested: [{ ...values, deeper: { ...values } }] };
  await seed(f, { before: nested, after: { ...nested, password: 'changed' } }, { detail: { ...nested, password: 'set' } });
  const source = await fs.readFile(join(f.dir, '2026-10.jsonl'), 'utf8');
  for (const secret of Object.values(values)) assert.ok(!source.includes(secret), secret);
  const { rows } = await f.audit.read();
  assert.deepEqual(rows[0].before, { allowed: 'safe', nested: [{ deeper: {} }] });
  assert.equal(rows[0].after.password, 'changed'); assert.equal(rows[1].detail.password, 'set');
  assert.equal(sanitizeAudit(values).code, undefined);
});

test('admin audit: month selection follows KST intent time and result stays with its intent', async t => {
  const f = await fixture(t); f.setTime(Date.UTC(2026, 9, 31, 14, 59, 59));
  await f.audit.run(entry, async () => { f.advance(2000); return {}; });
  await seed(f);
  const october = (await fs.readFile(join(f.dir, '2026-10.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const november = (await fs.readFile(join(f.dir, '2026-11.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(october.length, 2); assert.equal(november.length, 2);
  assert.equal(october[0].ts, '2026-10-31T23:59:59+09:00'); assert.equal(october[1].ts, '2026-11-01T00:00:01+09:00');
  assert.equal(november[0].ts, '2026-11-01T00:00:01+09:00');
});

test('admin history: trusted titles omit the internal target in list and detail without changing records', async t => {
  const f = await fixture(t);
  const before = { version: 1, senders: [] }, after = { version: 1, senders: [{ sender: 'device@example.com', memo: '장비', ips: ['203.0.113.8'] }] };
  for (const action of ['add-sender', 'add-ips', 'remove-ip', 'remove-sender', 'memo']) {
    f.history.register(`trusted.${action}`, { label: '신뢰 발신 장비를 바꿨어요' });
    for (const [result, suffix] of [['ok', ''], ['partial', ' (일부 적용)']]) {
      const { id } = await seed(f, { action: `trusted.${action}`, target: 'trusted', before, after }, { result });
      const record = await f.history.detail(id);
      assert.equal(record.summary, `admin님이 신뢰 발신 장비를 바꿨어요${suffix}`);
      assert.equal((await f.history.list()).items.find(row => row.id === id).summary, record.summary);
      assert.equal(record.target, 'trusted'); assert.equal(record.action, `trusted.${action}`);
      assert.deepEqual(record.before, before); assert.deepEqual(record.after, after);
      assert.equal(record.canRevert, result === 'ok');
    }
  }
});

test('admin history: other titles retain the changed target', async t => {
  const f = await fixture(t);
  f.history.register(entry.action, { label: '구성원을 바꿨어요' });
  const { id } = await seed(f);
  assert.equal((await f.history.detail(id)).summary, 'admin님이 operations@example.com 구성원을 바꿨어요');
});

test('admin history: missing result is visible and cannot be reverted', async t => {
  const f = await fixture(t); const id = 'a'.repeat(32);
  await fs.writeFile(join(f.dir, '2026-10.jsonl'), JSON.stringify({ v: 1, id, phase: 'intent', ts: '2026-10-16T17:00:00+09:00', ...entry }) + '\n');
  f.history.register(entry.action, { label: '구성원을 바꿨어요', read: async () => entry.after, write: async () => assert.fail('must not write') });
  const record = await f.history.detail(id); assert.match(record.summary, /결과 확인 안 됨/); assert.equal(record.canRevert, false);
  await assert.rejects(f.history.revert(id, { confirm: true }), { statusCode: 409, code: 'NOT_REVERTIBLE' });
});

for (const kind of ['irreversible', 'info']) test(`admin history: ${kind} is never revertible even when caller asks`, async t => {
  const f = await fixture(t); const { id } = await seed(f, { kind });
  f.history.register(entry.action, { read: async () => entry.after, write: async () => assert.fail('must not write') });
  const record = await f.history.detail(id); assert.equal(record.revertible, false); assert.equal(record.canRevert, false);
  await assert.rejects(f.history.revert(id, { confirm: true }), { statusCode: 409, code: 'NOT_REVERTIBLE' });
});

test('admin history: unregistered actions and failed operations cannot revert', async t => {
  const f = await fixture(t); const { id } = await seed(f);
  await assert.rejects(f.history.revert(id, { confirm: true }), { code: 'NOT_REVERTIBLE' });
  f.history.register(entry.action, { read: async () => entry.after, write: async () => assert.fail('must not write') });
  await assert.rejects(f.audit.run(entry, async () => { throw new AppError(422, 'REJECTED', '실패'); }));
  const failed = (await f.history.list()).items.find(row => row.result === 'failed');
  await assert.rejects(f.history.revert(failed.id, { confirm: true }), { code: 'NOT_REVERTIBLE' });
});

test('admin history: changed current value blocks revert before intent or write', async t => {
  const f = await fixture(t); const { id } = await seed(f); let writes = 0;
  f.history.register(entry.action, { read: async () => ({ members: [] }), write: async () => { writes++; } });
  await assert.rejects(f.history.revert(id, { confirm: true }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  assert.equal(writes, 0); assert.equal((await f.audit.read()).rows.length, 2);
});

test('admin history: revert is a newly paired change linked by revertOf, with verified reread', async t => {
  const f = await fixture(t); const original = await seed(f); let value = entry.after;
  const session = { username: 'other-admin' };
  f.history.register(entry.action, { label: '구성원을 바꿨어요', read: async args => { assert.equal(args.session, session); return value; },
    write: async args => { assert.equal(args.session, session); assert.equal(args.target, entry.target); assert.deepEqual(args.expected, entry.after); assert.equal(args.record.id, original.id); value = args.value; } });
  const reverted = await f.history.revert(original.id, { confirm: true, actor: 'other-admin', ip: '203.0.113.7', session });
  assert.notEqual(reverted.id, original.id); assert.deepEqual(value, entry.before);
  const record = await f.history.detail(reverted.id);
  assert.equal(record.revertOf, original.id); assert.equal(record.actor, 'other-admin'); assert.equal(record.result, 'ok');
  assert.deepEqual(record.before, entry.after); assert.deepEqual(record.after, entry.before);
  assert.equal((await f.audit.read()).rows.length, 4); assert.match(record.summary, /구성원을 바꿨어요/);
});

test('admin history: failed post-write verification is recorded and returns 502', async t => {
  const f = await fixture(t); const { id } = await seed(f); let writes = 0;
  f.history.register(entry.action, { read: async () => entry.after, write: async () => { writes++; } });
  await assert.rejects(f.history.revert(id, { confirm: true, actor: 'admin', ip: entry.ip }), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
  assert.equal(writes, 1); const result = (await f.audit.read()).rows.at(-1);
  assert.equal(result.result, 'failed'); assert.equal(result.code, 'WRITE_VERIFY_FAILED');
});

test('admin history: list supports effective filters, search, fifty-row pages, limits and safe summaries', async t => {
  const f = await fixture(t);
  f.history.register(entry.action, { label: '구성원을 바꿨어요', read: async () => entry.after, write: async () => {} });
  for (let index = 0; index < 52; index++) { await seed(f, { target: `team${index}@example.com` }); f.advance(1000); }
  await seed(f, { kind: 'irreversible', action: 'mailbox.delete', target: 'deleted@example.com' });
  const first = await f.history.list(); assert.equal(first.total, 53); assert.equal(first.items.length, 50); assert.equal(first.pageSize, 50);
  assert.equal((await f.history.list({ page: '2' })).items.length, 3);
  assert.equal((await f.history.list({ limit: '3' })).items.length, 3);
  assert.equal((await f.history.list({ filter: 'revertible' })).total, 52);
  assert.equal((await f.history.list({ filter: 'irreversible' })).total, 1);
  const found = await f.history.list({ q: 'team51@example.com' }); assert.equal(found.total, 1);
  assert.equal(first.items[0].target, 'deleted@example.com'); assert.ok(!first.items[0].summary.includes('mailbox.delete'));
  assert.match(first.items[0].summary, /설정을 바꿨어요/); assert.match(first.items[0].summary, /되돌리기 불가/);
});

test('admin history: incomplete final line is visible as damaged and new records start on a fresh line', async t => {
  const f = await fixture(t); const broken = '{"v":1,"id":"synthetic-incomplete';
  await fs.writeFile(join(f.dir, '2026-10.jsonl'), broken);
  const first = await f.history.list(); assert.equal(first.total, 0);
  assert.deepEqual(first.damaged, { count: 1, lines: [{ file: '2026-10.jsonl', line: 1 }] });
  await seed(f); const second = await f.history.list(); assert.equal(second.total, 1); assert.equal(second.damaged.count, 1);
  const source = await fs.readFile(join(f.dir, '2026-10.jsonl'), 'utf8'); assert.ok(source.startsWith(broken + '\n'));
  assert.ok(f.logs.some(row => row.file === '2026-10.jsonl' && row.line === 1));
});

test('admin lock: same target queues in order, unrelated targets proceed, failure releases the queue', async () => {
  const lock = createResourceLock(); let release;
  const gate = new Promise(resolve => { release = resolve; }); const order = [];
  const first = lock.run('team@example.com', async () => { order.push('first-start'); await gate; order.push('first-end'); throw new Error('synthetic'); });
  const rejected = assert.rejects(first);
  const second = lock.run('team@example.com', async () => { order.push('second'); return 2; });
  await lock.run('other@example.com', async () => { order.push('other'); });
  assert.deepEqual(order, ['first-start', 'other']); release();
  await rejected; assert.equal(await second, 2); assert.deepEqual(order, ['first-start', 'other', 'first-end', 'second']);
});

test('admin lock: etags are stable across object-key order and reject stale snapshots', () => {
  const expected = etag({ members: ['first@example.com'], active: true });
  assert.equal(expected, etag({ active: true, members: ['first@example.com'] }));
  assert.doesNotThrow(() => assertUnchanged(expected, { active: true, members: ['first@example.com'] }));
  assert.throws(() => assertUnchanged(expected, { active: false, members: [] }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
});

test('admin history: concurrent reverts of one record serialize and the stale second write is blocked', async t => {
  const f = await fixture(t); const { id } = await seed(f); let value = entry.after, writes = 0;
  f.history.register(entry.action, { read: async () => value, write: async args => { writes++; value = args.value; } });
  const results = await Promise.allSettled([1, 2].map(() => f.history.revert(id, { confirm: true, actor: 'admin', ip: entry.ip })));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'CHANGED_ELSEWHERE'); assert.equal(writes, 1);
});

async function httpFixture(t) {
  const f = await fixture(t); const calls = []; let logs = '';
  const client = {
    async login({ username }) { return { state: 'ready', username }; },
    async call(_session, _method, path) { calls.push(path); return { version: '2026-09a' }; }, async logout() {},
  };
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', sessionIdleMin: 60, sessionMaxHours: 8,
    trustProxy: ['192.0.2.0/24'], auditDir: f.dir }, logger: { ...logOptions('info'), stream }, auth: { client } });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic-http-password' } });
  const headers = { origin: 'https://mailadmin.example.com', cookie: response.headers['set-cookie'].split(';')[0], 'x-mailadmin-csrf': response.json().csrf };
  return { ...f, app, calls, headers, get httpLogs() { return logs; } };
}

test('admin history HTTP: authenticated list and detail probe mailcow; malformed queries and id rejected', async t => {
  const f = await httpFixture(t); const { id } = await seed(f);
  const response = await f.app.inject({ url: '/api/admin/history?limit=3', headers: f.headers });
  assert.equal(response.statusCode, 200); assert.equal(response.json().total, 1);
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['www-authenticate'], undefined);
  assert.equal((await f.app.inject({ url: `/api/admin/history/${id}`, headers: f.headers })).json().id, id);
  for (const query of ['filter=invalid', 'page=0', 'page=NaN', 'limit=51']) assert.equal((await f.app.inject({ url: `/api/admin/history?${query}`, headers: f.headers })).statusCode, 422);
  assert.equal((await f.app.inject({ url: '/api/admin/history/not-an-id', headers: f.headers })).statusCode, 404);
  assert.ok(f.calls.every(path => path === '/api/v1/get/status/version'));
  assert.equal((await f.app.inject('/api/admin/history')).statusCode, 403);
});

test('admin history HTTP: revert requires confirmation, uses session actor and records new change', async t => {
  const f = await httpFixture(t); const { id } = await seed(f); let value = entry.after;
  f.app.adminHistory.register(entry.action, { read: async () => value, write: async args => { value = args.value; } });
  const url = `/api/admin/history/${id}/revert`;
  assert.equal((await f.app.inject({ method: 'POST', url, headers: f.headers, payload: {} })).statusCode, 422);
  const response = await f.app.inject({ method: 'POST', url, headers: f.headers, remoteAddress: '203.0.113.7', payload: { confirm: true, actor: 'forged' } });
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(value, entry.before);
  const record = await f.app.adminHistory.detail(response.json().id); assert.equal(record.revertOf, id); assert.equal(record.actor, 'admin'); assert.equal(record.ip, '203.0.113.7');
});

test('admin history HTTP: intent storage unavailable prevents adapter write with 500', async t => {
  const f = await httpFixture(t); const { id } = await seed(f); let writes = 0;
  f.app.adminHistory.register(entry.action, { read: async () => entry.after, write: async () => { writes++; } });
  // Keep existing rows readable while failing only future append opens.
  const read = f.app.audit.read;
  const failed = createAudit({ dir: join(f.dir, 'not-a-directory') });
  await fs.writeFile(join(f.dir, 'not-a-directory'), 'synthetic');
  f.app.audit.run = failed.run; f.app.audit.read = read;
  const response = await f.app.inject({ method: 'POST', url: `/api/admin/history/${id}/revert`, headers: f.headers, payload: { confirm: true } });
  assert.equal(response.statusCode, 500); assert.equal(response.json().error.code, 'AUDIT_UNAVAILABLE'); assert.equal(writes, 0);
});

test('admin history HTTP: incomplete line produces 200 plus damaged locations without exposing raw data', async t => {
  const f = await httpFixture(t); await fs.writeFile(join(f.dir, '2026-10.jsonl'), '{"password":"synthetic-damaged-secret');
  const response = await f.app.inject({ url: '/api/admin/history', headers: f.headers });
  assert.equal(response.statusCode, 200); assert.equal(response.json().damaged.count, 1);
  assert.ok(!response.body.includes('synthetic-damaged-secret')); assert.ok(!f.httpLogs.includes('synthetic-damaged-secret'));
});

test('admin history: both adapter reads receive the original record for participant-scoped snapshots', async t => {
  const f = await fixture(t), original = await seed(f); let current = entry.after; const received = [];
  f.history.register(entry.action, {
    read({ record }) { received.push(record); return current; },
    write({ value }) { current = value; },
  });
  await f.history.revert(original.id, { confirm: true, actor: 'admin', ip: '198.51.100.9', session: {} });
  assert.equal(received.length, 2); assert.ok(received.every(record => record.id === original.id));
  assert.deepEqual(current, entry.before);
});

test('admin history: adapters without prepareRevert retain the existing result and intent contract', async t => {
  const f = await fixture(t), original = await seed(f, {}, { detail: { skipped: ['legacy-step'] } });
  let value = entry.after, reads = 0, preparedId;
  f.history.register(entry.action, {
    read({ record }) { reads++; assert.equal(record.id, original.id); return value; },
    write(args) {
      assert.deepEqual(Object.keys(args).sort(), ['expected', 'record', 'session', 'target', 'value']);
      assert.deepEqual(args.expected, entry.after); value = args.value;
      return { target: { ignored: true }, skipped: ['ignored'] };
    },
    prepare({ record, intent }) { assert.equal(record.id, original.id); preparedId = intent.id; },
  });
  assert.equal((await f.history.detail(original.id)).skipped, undefined);
  const result = await f.history.revert(original.id, { confirm: true, actor: 'other-admin', ip: '203.0.113.7', session: {} });
  assert.deepEqual(result, { id: preparedId, result: 'ok', detail: {} }); assert.equal(reads, 2);
  const rows = (await f.audit.read()).rows;
  assert.deepEqual(rows[2], { v: 1, id: preparedId, phase: 'intent', ts: '2026-10-16T17:00:00+09:00', actor: 'other-admin', ip: '203.0.113.7', action: entry.action, target: entry.target, kind: 'config', revertible: true, before: entry.after, after: entry.before, revertOf: original.id });
  assert.deepEqual(rows[3].detail, {}); assert.equal((await f.history.detail(preparedId)).skipped, undefined);
});
