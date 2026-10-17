import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDoveadm } from '../../server/admin/doveadm.js';
import { createCleanupService } from '../../server/admin/services/cleanup.js';
import { createQuotaService, quotaUsage } from '../../server/admin/services/quota.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createAudit } from '../../server/admin/audit.js';
import { createAdminApp } from '../../server/admin/app.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';

const examples = JSON.parse(await readFile(new URL('../fixtures/admin/doveadm.json', import.meta.url)));
const mailbox = 'user@example.com', secret = 'synthetic-doveadm-credential', session = {};
const ctx = { session, actor: 'admin', ip: '192.0.2.24' };
const input = { mailbox, folder: 'inbox', before: '2026-10-01' };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'webmail-b02-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { count: 3, used: '11', team: false, mode: '', remaining: 0, now: Date.parse('2026-10-17T00:00:00Z') }, requests = [], mailcowRequests = [], logs = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/doveadm/v1');
    assert.equal(req.headers.authorization, `X-Dovecot-API ${Buffer.from(secret).toString('base64')}`);
    const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.length, 1);
    const [command, args, tag] = body[0]; requests.push({ command, args });
    if (state.mode === 'httpAuth') { res.writeHead(401); res.end(); return; }
    if (state.mode === 'broken') { res.end('invalid'); return; }
    const reply = structuredClone(examples[state.mode || command]);
    if (!state.mode && command === 'search') reply[1] = Array.from({ length: state.count }, (_, i) => ({ 'mailbox-guid': '0123456789abcdef0123456789abcdef', uid: String(i + 1) }));
    if (!state.mode && command === 'expunge') { state.count = state.remaining; state.used = '7'; }
    if (!state.mode && command === 'quotaGet') reply[1][0].value = state.used;
    if (!state.mode && command === 'quotaRecalc') state.used = '6';
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([[...reply, tag]]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { doveadmUrl: `http://127.0.0.1:${server.address().port}`, doveadmKey: secret };
  const doveadm = createDoveadm({ config }), audit = createAudit({ dir, logger: { info: row => logs.push(row) } }), lock = createResourceLock();
  const mailcow = { async call(_session, _method, path) {
    mailcowRequests.push({ method: _method, path });
    if (state.authLost) throw new MailcowAuthLost();
    if (path.endsWith('/status/version')) return { version: '2026-09a' };
    if (path.endsWith('/filters/all') && state.emptyFilters) return {};
    if (path.endsWith('/filters/all')) return state.team ? [{ username: mailbox, active: '1', filter_type: 'prefilter', script_data: state.teamScript ?? 'redirect :copy "member@example.com";' }] : [];
    throw new Error('unexpected mailcow path');
  }, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} };
  const quota = createQuotaService({ doveadm, audit, lock });
  const cleanup = createCleanupService({ doveadm, mailcow, quota, audit, lock, now: () => state.now });
  return { state, requests, mailcowRequests, config, doveadm, audit, logs, quota, cleanup, mailcow, dir };
}
const count = (f, data = input, context = ctx) => f.cleanup.count({ ...context, data });
const run = (f, token, context = ctx, confirmAddress = mailbox) => f.cleanup.run({ ...context, data: { token, confirmAddress } });
const expunges = f => f.requests.filter(row => row.command === 'expunge');
for (const before of [undefined, '', '2026/10/01', '2026-02-30', '2026-13-01', '2027-01-01']) test(`cleanup date ${before}: 422 and no doveadm`, async t => {
  const f = await fixture(t); await assert.rejects(count(f, { ...input, before }), { statusCode: 422, code: 'DATE_REQUIRED' }); assert.equal(f.requests.length, 0);
});
for (const [before, timestamp] of [['2025-01-01', '1735657200'], ['2024-03-01', '1709218800']]) test(`cleanup: ${before} uses KST midnight for count and token execution`, async t => {
  const f = await fixture(t), query = ['mailbox', 'INBOX', 'before', timestamp];
  const preview = await count(f, { ...input, before });
  assert.deepEqual(f.requests.find(row => row.command === 'search').args.query, query);
  const result = await run(f, preview.token);
  assert.equal(result.beforeDate, before); assert.equal(result.detail.beforeDate, before);
  const searches = f.requests.filter(row => row.command === 'search');
  assert.equal(searches.length, 3); assert.equal(expunges(f).length, 1);
  for (const request of [...searches, ...expunges(f)]) assert.deepEqual(request.args.query, query);
  const rows = (await f.audit.read()).rows;
  assert.equal(rows[0].before.before, before); assert.equal(rows[0].after.before, before);
  assert.equal(rows[1].detail.beforeDate, before);
  assert.equal(result.before.usedKiB, '11'); assert.equal(result.after.usedKiB, '7');
  assert.deepEqual(rows[1].detail.before, result.before); assert.deepEqual(rows[1].detail.after, result.after);
});
for (const command of ['redirect', 'REDIRECT']) test(`cleanup: ${command} team confirmation required and preserved through execution`, async t => {
  const f = await fixture(t); f.state.team = true; f.state.teamScript = `${command} :copy "member@example.com";`;
  await assert.rejects(count(f), { statusCode: 422, code: 'TEAM_CONFIRM_REQUIRED' }); assert.equal(f.requests.length, 0); assert.equal(expunges(f).length, 0);
  const preview = await count(f, { ...input, confirmTeam: true }); assert.equal((await run(f, preview.token)).remaining, 0); assert.equal(expunges(f).length, 1);
});
for (const invalidMailbox of ['*@example.com', 'user?@example.com', '*']) {
  test(`cleanup: mailbox ${invalidMailbox} rejected before upstream calls`, async t => {
    const f = await fixture(t);
    await assert.rejects(count(f, { ...input, mailbox: invalidMailbox, folder: 'all' }), { statusCode: 422, code: 'INVALID_INPUT', message: '메일함과 정리 조건을 확인해 주세요.' });
    assert.equal(f.mailcowRequests.length, 0); assert.equal(f.requests.length, 0);
  });
  test(`quota: mailbox ${invalidMailbox} rejected before upstream calls`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.quota.recheck({ ...ctx, data: { mailbox: invalidMailbox } }), { statusCode: 422, code: 'INVALID_INPUT', message: '메일함 주소를 확인해 주세요.' });
    assert.equal(f.mailcowRequests.length, 0); assert.equal(f.requests.length, 0);
  });
  test(`doveadm: user ${invalidMailbox} rejected for all commands before HTTP`, async t => {
    const f = await fixture(t);
    for (const command of ['search', 'expunge', 'quotaGet', 'quotaRecalc', 'mailboxList']) {
      const args = { user: invalidMailbox, ...(['search', 'expunge'].includes(command) ? { query: ['mailbox', '*', 'before', '2026-10-01'] } : {}) };
      await assert.rejects(f.doveadm.call(command, args), { statusCode: 422, code: 'INVALID_INPUT', message: '메일함과 검색 조건을 확인해 주세요.' });
    }
    assert.equal(f.requests.length, 0);
  });
}
test('cleanup: count changed rejects without expunge or audit intent', async t => {
  const f = await fixture(t), preview = await count(f); f.state.count++;
  await assert.rejects(run(f, preview.token), { statusCode: 409, code: 'COUNT_CHANGED' }); assert.equal(expunges(f).length, 0); assert.equal((await f.audit.read()).rows.length, 0);
});
test('cleanup: one expunge, difference count, quota and irreversible result with no secrets', async t => {
  const f = await fixture(t), preview = await count(f); assert.equal(preview.count, 3); assert.equal(preview.usage.usedBytes, 11264);
  const result = await run(f, preview.token); assert.equal(result.deleted, 3); assert.equal(result.remaining, 0); assert.equal(result.after.usedBytes, 7168); assert.equal(expunges(f).length, 1);
  assert.deepEqual(expunges(f)[0].args.query, ['mailbox', 'INBOX', 'before', '1790780400']);
  const rows = (await f.audit.read()).rows; assert.equal(rows[0].kind, 'irreversible'); assert.equal(rows[0].revertible, false); assert.equal(rows[1].detail.deleted, 3);
  for (const value of [secret, Buffer.from(secret).toString('base64'), preview.token]) assert.ok(!JSON.stringify({ rows, logs: f.logs, result }).includes(value));
  await assert.rejects(run(f, preview.token), { statusCode: 409 }); assert.equal(expunges(f).length, 1);
});
test('cleanup: partial deletion records actual difference and remaining', async t => {
  const f = await fixture(t); f.state.remaining = 1; const result = await run(f, (await count(f)).token);
  assert.equal(result.deleted, 2); assert.equal(result.remaining, 1); assert.equal(result.result, 'partial'); assert.equal((await f.audit.read()).rows[1].result, 'partial');
});
test('cleanup: address, session binding, expiry and concurrent replay', async t => {
  const f = await fixture(t), preview = await count(f);
  await assert.rejects(run(f, preview.token, ctx, 'other@example.com'), { statusCode: 422 });
  await assert.rejects(run(f, preview.token, { ...ctx, session: {} }), { statusCode: 409 });
  const results = await Promise.allSettled([run(f, preview.token), run(f, preview.token)]); assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(expunges(f).length, 1);
  const next = await count(f); f.state.now += 600_000; await assert.rejects(run(f, next.token), { statusCode: 409 }); assert.equal(expunges(f).length, 1);
});
test('cleanup: current team transition and audit intent failure block expunge', async t => {
  const f = await fixture(t), preview = await count(f); f.state.team = true;
  await assert.rejects(run(f, preview.token), { statusCode: 422 }); assert.equal(expunges(f).length, 0);
  f.state.team = false; const next = await count(f); await rm(f.dir, { recursive: true }); await writeFile(f.dir, 'synthetic-blocker');
  await assert.rejects(run(f, next.token), { statusCode: 500, code: 'AUDIT_UNAVAILABLE' }); assert.equal(expunges(f).length, 0);
});
for (const folder of ['sent', 'junk', 'all']) test(`cleanup folder ${folder}: exact query`, async t => {
  const f = await fixture(t); await count(f, { ...input, folder }); assert.equal(f.requests.find(row => row.command === 'search').args.query[1], { sent: 'Sent', junk: 'Junk', all: '*' }[folder]);
});
test('doveadm: forbidden command sends zero requests', async t => {
  const f = await fixture(t); for (const command of ['fetch', 'mailboxStatus', 'toString']) await assert.rejects(f.doveadm.call(command, { user: mailbox }), { statusCode: 422 }); assert.equal(f.requests.length, 0);
});
for (const [mode, statusCode, code] of [['unauthorized', 502, 'DOVEADM_REJECTED'], ['httpAuth', 502, 'DOVEADM_REJECTED'], ['missing', 404, 'NOT_FOUND'], ['broken', 502, 'DOVEADM_REJECTED']]) test(`doveadm: ${mode} maps to ${statusCode}`, async t => {
  const f = await fixture(t); f.state.mode = mode; await assert.rejects(f.doveadm.call('quotaGet', { user: mailbox }), error => { assert.equal(error.statusCode, statusCode); assert.equal(error.code, code); assert.ok(!error.message.includes(secret)); return true; });
});
test('quota: before/recalc/after, string KiB, unlimited raw and info audit', async t => {
  const f = await fixture(t), result = await f.quota.recheck({ ...ctx, data: { mailbox } });
  assert.deepEqual(f.requests.map(row => row.command), ['quotaGet', 'quotaRecalc', 'quotaGet']); assert.equal(result.before.usedKiB, '11'); assert.equal(result.after.usedKiB, '6'); assert.equal(result.diff, -5120); assert.equal(result.before.raw[1].limit, '-');
  const rows = (await f.audit.read()).rows; assert.equal(rows[0].kind, 'info'); assert.equal(rows[1].detail.diff, -5120);
  const unlimited = structuredClone(examples.quotaGet[1]); unlimited[0].limit = '-'; assert.equal(quotaUsage(unlimited).limitBytes, null); assert.equal(quotaUsage(unlimited).limitKiB, '-');
});
test('cleanup routes: guard, disabled feature, health, date contract, execution and mailcow loss', async t => {
  const f = await fixture(t), logs = [];
  async function appFor(enabled) {
    const app = await createAdminApp({ config: { ...f.config, ...(enabled ? {} : { doveadmUrl: '', doveadmKey: '' }), adminHostname: 'mailadmin.example.com', trustProxy: [], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: join(f.dir, enabled ? 'enabled' : 'disabled') }, logger: { level: 'info', stream: { write: line => logs.push(line) } }, auth: { client: f.mailcow } }); t.after(() => app.close());
    const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
    assert.equal(login.json().features.cleanup, enabled);
    return { app, headers: { origin: 'https://mailadmin.example.com', cookie: login.headers['set-cookie'].split(';')[0], 'x-mailadmin-csrf': login.json().csrf } };
  }
  const disabled = await appFor(false);
  for (const url of ['/api/admin/cleanup/count', '/api/admin/cleanup/run', '/api/admin/quota-recheck']) { const res = await disabled.app.inject({ method: 'POST', url, headers: disabled.headers, payload: {} }); assert.equal(res.statusCode, 404); assert.equal(res.json().error.code, 'CLEANUP_DISABLED'); }
  const { app, headers } = await appFor(true); assert.equal((await app.inject('/healthz')).json().ok, true);
  const post = (url, payload, h = headers) => app.inject({ method: 'POST', url, headers: h, payload });
  assert.equal((await post('/api/admin/cleanup/count', input, { origin: headers.origin })).statusCode, 403);
  assert.equal((await post('/api/admin/cleanup/count', input, { ...headers, 'x-mailadmin-csrf': 'wrong' })).statusCode, 403);
  assert.equal((await post('/api/admin/cleanup/count', { ...input, before: '' })).statusCode, 422);
  const preview = await post('/api/admin/cleanup/count', input); assert.equal(preview.statusCode, 200, preview.body);
  const result = await post('/api/admin/cleanup/run', { token: preview.json().token, confirmAddress: mailbox }); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().deleted, 3);
  assert.equal(result.json().beforeDate, input.before); assert.equal(result.json().detail.beforeDate, input.before);
  assert.equal(result.json().before.usedKiB, '11'); assert.equal(result.json().after.usedKiB, '7');
  const recorded = (await app.audit.read()).rows.find(row => row.phase === 'result');
  assert.equal(recorded.detail.beforeDate, input.before);
  assert.equal((await post('/api/admin/quota-recheck', { mailbox })).statusCode, 200);
  f.state.authLost = true; const lost = await post('/api/admin/quota-recheck', { mailbox }); assert.equal(lost.statusCode, 403); assert.equal(lost.json().error.code, 'MAILCOW_SESSION_LOST');
  for (const marker of [secret, Buffer.from(secret).toString('base64')]) assert.ok(!logs.join('').includes(marker));
});


test('cleanup: empty filter object counts mail without team confirmation', async t => {
  const f = await fixture(t); f.state.emptyFilters = true;
  const result = await count(f);
  assert.equal(result.count, 3); assert.match(result.token, /^[a-f0-9]{64}$/);
  assert.equal(expunges(f).length, 0);
});
