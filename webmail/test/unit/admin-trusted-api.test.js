import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';
import { trustedHeader } from '../../server/admin/trusted-senders.js';

const origin = 'https://mailadmin.example.com', sender = 'device@example.com';
const root = '/api/admin/trusted', path = `${root}/senders/${encodeURIComponent(sender)}`;
const config = { adminHostname: 'mailadmin.example.com', sessionIdleMin: 60, sessionMaxHours: 8, trustProxy: ['192.0.2.0/24'], logLevel: 'silent' };
async function setup(t, enabled = true) {
  const dir = await mkdtemp(join(tmpdir(), 'admin-trusted-api-')), file = join(dir, 'trusted_senders.map');
  await writeFile(file, `${trustedHeader}\n`);
  const options = { rows: [] };
  const client = { async login({ username }) { return { state: 'ready', username }; }, async logout() {}, async call(_session, _method, path) {
    if (path === '/api/v1/get/status/version') return { version: 'synthetic' };
    if (path === '/api/v1/get/logs/rspamd-history/1000') { if (options.fail) throw new Error(); return options.rows; }
    throw new Error(`unexpected ${path}`);
  } };
  const app = await createAdminApp({ config: { ...config, auditDir: join(dir, 'audit'), trustedSenderFile: enabled ? file : '' }, logger: false, staticDir: '/nonexistent-trusted-static', auth: { client } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin }, payload: { username: 'admin', password: 'synthetic-test' } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { origin, cookie: login.headers['set-cookie'].split(';')[0], 'x-mailadmin-csrf': login.json().csrf };
  const request = (method, url, payload, overrides = {}) => app.inject({ method, url, headers: { ...headers, ...overrides }, ...(payload === undefined ? {} : { payload }) });
  const list = async () => { const response = await request('GET', root); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  const add = async () => request('POST', `${root}/senders`, { sender, memo: '장비', ips: ['203.0.113.8'], etag: (await list()).etag });
  return { app, file, headers, options, request, list, add, features: login.json().features };
}
function failure(response, status, code, detail) {
  assert.equal(response.statusCode, status, response.body); assert.equal(response.json().error.code, code, response.body);
  assert.equal(response.headers['www-authenticate'], undefined); assert.equal(response.headers['cache-control'], 'no-store');
  if (detail) assert.deepEqual(response.json().error.detail, { code: detail });
}
function success(response) {
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().result, 'ok'); assert.match(response.json().auditId, /^[a-f0-9]{32}$/); assert.match(response.json().etag, /^[a-f0-9]{64}$/);
}
test('trusted API all operations, feature session, decoded paths, audit and history revert', async t => {
  const f = await setup(t); assert.equal(f.features.trusted, true);
  assert.deepEqual(Object.keys(await f.list()).sort(), ['etag', 'pairs', 'senders']);
  success(await f.add());
  success(await f.request('POST', `${path}/ips`, { ips: ['2001:0DB8::1'], etag: (await f.list()).etag }));
  const memo = await f.request('PATCH', path, { memo: '', etag: (await f.list()).etag }); success(memo);
  const record = await f.request('GET', `/api/admin/history/${memo.json().auditId}`);
  assert.equal(record.statusCode, 200, record.body); assert.equal(record.json().before.version, 1); assert.equal(record.json().action, 'trusted.memo');
  const reverted = await f.request('POST', `/api/admin/history/${memo.json().auditId}/revert`, { confirm: true });
  assert.equal(reverted.statusCode, 200, reverted.body); assert.equal((await f.list()).senders[0].memo, '장비');
  success(await f.request('DELETE', `${path}/ips/${encodeURIComponent('2001:db8::1')}`, { etag: (await f.list()).etag }));
  success(await f.request('DELETE', `${path}/ips/203.0.113.8`, { etag: (await f.list()).etag }));
  assert.deepEqual((await f.list()).senders, []);
  success(await f.add()); success(await f.request('DELETE', path, { etag: (await f.list()).etag })); assert.equal((await f.list()).pairs, 0);
  const recent = await f.request('GET', `${root}/recent`); assert.equal(recent.statusCode, 200); assert.deepEqual(recent.json(), { range: null, failed: false, counts: {} });
  f.options.fail = true; assert.equal((await f.request('GET', `${root}/recent`)).json().failed, true);
});
test('trusted API every route enforces session, csrf and ignores Authorization', async t => {
  const f = await setup(t);
  const routes = [['GET', root], ['GET', `${root}/recent`], ['POST', `${root}/senders`], ['POST', `${path}/ips`], ['DELETE', `${path}/ips/203.0.113.8`], ['DELETE', path], ['PATCH', path]];
  for (const [method, url] of routes) {
    const payload = method === 'GET' ? undefined : {};
    const denied = await f.app.inject({ method, url, headers: { origin, authorization: 'Basic synthetic' }, ...(payload ? { payload } : {}) });
    failure(denied, 403, 'NO_SESSION');
    if (method !== 'GET') failure(await f.request(method, url, payload, { 'x-mailadmin-csrf': '' }), 403, 'CSRF');
  }
  assert.equal((await f.request('GET', root, undefined, { authorization: 'Bearer invalid' })).statusCode, 200);
  success(await f.request('POST', `${root}/senders`, { sender, ips: ['203.0.113.8'], etag: (await f.list()).etag }, { authorization: 'Basic ignored' }));
  failure(await f.request('PATCH', path, { memo: '', etag: (await f.list()).etag }, { origin: 'https://other.example.com' }), 403, 'BAD_ORIGIN');
});
test('trusted API feature off registers no routes and returns 404 for every path', async t => {
  const f = await setup(t, false); assert.equal(f.features.trusted, false);
  for (const [method, url] of [['GET', root], ['GET', `${root}/recent`], ['POST', `${root}/senders`], ['POST', `${path}/ips`], ['DELETE', `${path}/ips/203.0.113.8`], ['DELETE', path], ['PATCH', path]]) failure(await f.request(method, url, method === 'GET' ? undefined : {}), 404, 'NOT_FOUND');
});
test('trusted API validates all input detail codes and sender/IP/memo injection', async t => {
  const f = await setup(t), etag = (await f.list()).etag;
  const base = { sender, ips: ['203.0.113.8'], etag };
  for (const [data, code] of [
    [{ sender: 'bad' }, 'INVALID_SENDER'], [{ sender: 'a#b@example.com' }, 'INVALID_SENDER'], [{ sender: 'a|b@example.com' }, 'INVALID_SENDER'], [{ sender: 'a b@example.com' }, 'INVALID_SENDER'],
    [{ ips: ['not-ip'] }, 'INVALID_IP'], [{ ips: ['203.0.113.0/24'] }, 'CIDR_NOT_ALLOWED'], [{ ips: Array.from({ length: 51 }, (_, n) => `203.0.113.${n}`) }, 'TOO_MANY_IPS'],
    [{ ips: ['203.0.113.8', '203.0.113.8'] }, 'DUPLICATE_IP'], [{ memo: '가'.repeat(81) }, 'MEMO_TOO_LONG'], [{ memo: '\nother@example.net|203.0.113.99' }, 'MEMO_INVALID'], [{ memo: '\r' }, 'MEMO_INVALID'], [{ memo: '\t' }, 'MEMO_INVALID'], [{ memo: null }, 'MEMO_INVALID'],
  ]) failure(await f.request('POST', `${root}/senders`, { ...base, ...data }), 422, 'INVALID_INPUT', code);
  assert.deepEqual((await f.list()).senders, []);
  success(await f.add());
  failure(await f.request('POST', `${path}/ips`, { ips: ['203.0.113.8'], etag: (await f.list()).etag }), 422, 'INVALID_INPUT', 'DUPLICATE_PAIR');
  failure(await f.request('PATCH', path, { memo: '\nother@example.net|203.0.113.99', etag: (await f.list()).etag }), 422, 'INVALID_INPUT', 'MEMO_INVALID');
  assert.equal((await f.list()).pairs, 1);
});
for (const separator of ['\u2028', '\u2029']) test(`trusted API rejects U+${separator.codePointAt(0).toString(16)} memos without changing bytes and preserves valid roundtrips`, async t => {
  const f = await setup(t), invalidMemo = `업무${separator}백업`;
  const empty = await readFile(f.file);
  failure(await f.request('POST', `${root}/senders`, { sender, memo: invalidMemo, ips: ['203.0.113.8'], etag: (await f.list()).etag }), 422, 'INVALID_INPUT', 'MEMO_INVALID');
  assert.deepEqual(await readFile(f.file), empty);
  success(await f.add());
  const before = await readFile(f.file);
  failure(await f.request('PATCH', path, { memo: invalidMemo, etag: (await f.list()).etag }), 422, 'INVALID_INPUT', 'MEMO_INVALID');
  assert.deepEqual(await readFile(f.file), before);
  assert.equal((await f.list()).senders[0].memo, '장비');
  const memo = '업무 백업 😀 #@sender memo=|', changed = await f.request('PATCH', path, { memo, etag: (await f.list()).etag });
  success(changed);
  assert.equal((await f.list()).senders[0].memo, memo);
  const reverted = await f.request('POST', `/api/admin/history/${changed.json().auditId}/revert`, { confirm: true });
  assert.equal(reverted.statusCode, 200, reverted.body);
  assert.equal((await f.list()).senders[0].memo, '장비');
  assert.deepEqual(await readFile(f.file), before);
});
test('trusted API EXISTS, NOT_FOUND, CONFLICT, invalid file and WRITE_FAILED contract', async t => {
  const f = await setup(t), stale = (await f.list()).etag; success(await f.add());
  failure(await f.add(), 409, 'EXISTS');
  for (const [method, url, data] of [['POST', `${path}/ips`, { ips: ['203.0.113.9'] }], ['DELETE', `${path}/ips/203.0.113.8`, {}], ['DELETE', path, {}], ['PATCH', path, { memo: '' }]]) failure(await f.request(method, url, { ...data, etag: stale }), 409, 'CONFLICT');
  failure(await f.request('POST', `${root}/senders`, { sender: 'other@example.com', ips: ['203.0.113.9'], etag: stale }), 409, 'CONFLICT');
  const missing = `${root}/senders/${encodeURIComponent('missing@example.com')}`;
  for (const [method, url, data] of [['POST', `${missing}/ips`, { ips: ['203.0.113.9'] }], ['DELETE', `${path}/ips/203.0.113.99`, {}], ['DELETE', missing, {}], ['PATCH', missing, { memo: '' }]]) failure(await f.request(method, url, { ...data, etag: (await f.list()).etag }), 404, 'NOT_FOUND');
  // The writer's actual I/O failure and byte preservation are tested separately.
  f.app.trusted.memo = async () => { throw new AppError(502, 'WRITE_FAILED', '저장하지 못했어요.'); };
  failure(await f.request('PATCH', path, { memo: '', etag: (await f.list()).etag }), 502, 'WRITE_FAILED');
  await writeFile(f.file, `${trustedHeader}\ninvalid\n`);
  failure(await f.request('GET', root), 409, 'TRUSTED_FILE_INVALID');
  failure(await f.request('DELETE', path, { etag: stale }), 409, 'TRUSTED_FILE_INVALID');
});
