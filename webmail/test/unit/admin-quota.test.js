import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { installAdminGuard } from '../../server/admin/guard.js';
import { AppError, installErrors } from '../../server/errors.js';
import accountsRoutes from '../../server/admin/routes/accounts.js';
import { collectMailboxQuota } from '../../server/admin/services/quota.js';
import { quotaPercent, quotaTone, quotaRows, topQuota, saveQuota } from '../../web/src/admin/pages/quota.js';
const GB = 1024 ** 3;
const row = (address, used, quotaGb = 10, name = address) => ({ address, name, usedBytes: used * GB, quotaGb, etag: 'synthetic-etag' });
const rows = [row('b@example.com', 8), row('a@example.com', 9), row('c@example.com', 20, 0), row('d@example.com', 10), row('e@example.com', 4), row('f@example.com', 5), row('g@example.com', 7)];
test('quota: top N uses every finite account, stable order and excludes unlimited', () => {
  assert.deepEqual(topQuota(rows).map(row => row.address), ['d@example.com','a@example.com','b@example.com','g@example.com','f@example.com']);
  assert.deepEqual(topQuota(rows, 2).map(row => row.address), ['d@example.com','a@example.com']);
  assert.deepEqual(topQuota(rows, 0), []); assert.deepEqual(topQuota([]), []);
  assert.equal(rows[0].address, 'b@example.com');
});
test('quota: unrounded thresholds and unlimited exclude percentage and emphasis', () => {
  for (const [used, percent, tone] of [[7.99,79.9,''],[8,80,'warn'],[8.99,89.9,'warn'],[9,90,'danger'],[10,100,'danger'],[11,110,'danger']]) {
    assert.ok(Math.abs(quotaPercent(row('test', used)) - percent) < 0.00001); assert.equal(quotaTone(row('test', used)), tone);
  }
  assert.equal(quotaPercent(rows[2]), null); assert.equal(quotaTone(rows[2]), '');
});
test('quota: search matches name/address literally and ordering covers percent/used/name', () => {
  const source = [row('b@example.com', 5, 10, '가나다'), row('a@example.com', 1, 1, '나다라'), row('c@example.com', 10, 0, '[합성]')];
  assert.deepEqual(quotaRows(source).map(row => row.address), ['a@example.com','b@example.com','c@example.com']);
  assert.deepEqual(quotaRows(source, { sort: 'used' }).map(row => row.address), ['c@example.com','b@example.com','a@example.com']);
  assert.deepEqual(quotaRows(source, { sort: 'name', q: '다' }).map(row => row.address), ['b@example.com','a@example.com']);
  assert.equal(quotaRows(source, { q: ' A@EXAMPLE ' })[0].address, 'a@example.com');
  assert.equal(quotaRows(source, { q: '[' })[0].address, 'c@example.com'); assert.deepEqual(quotaRows(source, { q: 'missing' }), []);
});
test('quota: inline save reuses PATCH with quotaGb and original etag only', async () => {
  const calls = [], response = { result: 'ok' };
  assert.equal(await saveQuota(rows[0], '25', async (...args) => { calls.push(args); return response; }), response);
  assert.deepEqual(calls, [['/api/admin/mailboxes/b%40example.com', { method: 'PATCH', body: { quotaGb: 25, etag: 'synthetic-etag' } }]]);
});
for (const input of ['', '0', '-1', 'NaN', 'Infinity', '0.001']) test(`quota: invalid inline limit ${JSON.stringify(input)} never sends a PATCH`, async () => {
  await assert.rejects(saveQuota(rows[0], input, () => assert.fail('must not write')), { status: 422, code: 'INVALID_INPUT' });
});
test('quota: inline save preserves conflict response for mandatory fresh read', async () => {
  const conflict = Object.assign(new Error('synthetic conflict'), { status: 409, code: 'CHANGED_ELSEWHERE' });
  await assert.rejects(saveQuota(rows[0], '30', async () => { throw conflict; }), error => error === conflict);
});
test('quota: shared collector uses mailcow mailbox/all with given API/session context', async () => {
  const context = {}, calls = [];
  assert.equal(await collectMailboxQuota({ call: async (...args) => { calls.push(args); return rows; } }, context), rows);
  assert.deepEqual(calls, [[context, 'GET', '/api/v1/get/mailbox/all']]);
  assert.deepEqual(await collectMailboxQuota({ call: async () => ({}) }, context), []);
  await assert.rejects(collectMailboxQuota({ call: async () => null }, context), { statusCode: 502, code: 'MAILCOW_REJECTED' });
});
for (const permission of ['read', 'full']) test(`quota HTTP: ${permission} key reads quota; only full changes mailbox`, async t => {
  const app = Fastify(); t.after(() => app.close()); installErrors(app); await app.register(cookie);
  const calls = [], context = {};
  const client = { createApiContext: () => context, call: async () => ({ version: 'synthetic' }) };
  installAdminGuard(app, { config: { adminHostname: 'admin.example.com', mailcowApiKey: 'synthetic' }, sessions: { get: async () => { throw new AppError(403, 'NO_SESSION', '로그인을 먼저 완료해 주세요.'); } }, client,
    apiKeys: { authenticate: async () => ({ ok: true, item: { id: 'synthetic', name: 'quota', permission } }), recordUse: async () => {} } });
  await app.register(accountsRoutes, { service: { quotaList: async session => { assert.equal(session, context); return { items: rows }; }, edit: async data => { calls.push(data); return { result: 'ok' }; } } });
  const headers = { 'x-mailadmin-api-key': `mak_v1_${'A'.repeat(43)}` };
  const read = await app.inject({ url: '/api/admin/quota', headers });
  assert.equal(read.statusCode, 200, read.body); assert.equal(read.json().items.length, rows.length);
  const write = await app.inject({ url: '/api/admin/mailboxes/b%40example.com', method: 'PATCH', headers, payload: { quotaGb: 25, etag: 'synthetic' } });
  assert.equal(write.statusCode, permission === 'full' ? 200 : 403, write.body);
  assert.equal(write.headers['www-authenticate'], undefined); assert.equal(calls.length, permission === 'full' ? 1 : 0);
  assert.equal((await app.inject('/api/admin/quota')).statusCode, 403);
});
