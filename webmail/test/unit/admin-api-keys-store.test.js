import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiKeyStore } from '../../server/admin/api-keys.js';

const start = Date.UTC(2026, 9, 21, 0, 0, 0);
const ip = '192.0.2.7';
const input = { name: '자동화', permission: 'read', allowedIps: [], expiresAt: null };
const unavailable = { statusCode: 503, code: 'API_KEY_STORE_UNAVAILABLE' };
const invalid = code => ({ statusCode: 422, code: 'INVALID_INPUT', detail: { code } });

async function setup(t, overrides = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'admin-api-keys-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = join(root, 'api-keys'), path = join(directory, 'keys.json');
  const clock = { value: start }, options = { directory, now: () => clock.value, ...overrides };
  const store = createApiKeyStore(options);
  const create = (values = {}, id = store.allocateId()) => store.create({ ...input, ...values }, 'admin', { id });
  return { root, directory, path, clock, options, store, create };
}
const handleWith = (handle, overrides) => new Proxy(handle, { get(target, name) {
  if (Object.hasOwn(overrides, name)) return overrides[name];
  const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
} });

test('issue persists only digest with private modes, independent id, restart authentication and safe DTOs', async t => {
  const f = await setup(t), id = f.store.allocateId();
  assert.match(id, /^[a-f0-9]{32}$/);
  const result = await f.create({ name: '  자동화  ' }, id);
  assert.match(result.token, /^mak_v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(result.item.id, id); assert.equal(result.item.name, '자동화');
  assert.equal(result.item.status, 'active'); assert.equal(result.item.createdBy, 'admin');
  assert.equal(result.item.lastUsedAt, null); assert.equal(result.item.lastUsedIp, null);
  const text = await fs.readFile(f.path, 'utf8'), data = JSON.parse(text);
  assert.equal(data.version, 1); assert.equal(data.records.length, 1);
  assert.equal(data.records[0].digest, createHash('sha256').update(result.token).digest('hex'));
  assert.equal(text.includes(result.token), false); assert.equal(text.includes('"token"'), false);
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(f.path)).mode & 0o777, 0o600);
  const restarted = createApiKeyStore(f.options);
  assert.deepEqual(await restarted.authenticate(result.token, ip), { ok: true, item: result.item });
  assert.deepEqual(await restarted.get(id), result.item);
  assert.deepEqual(await restarted.list(), [result.item]);
  for (const item of [result.item, await restarted.get(id), ...(await restarted.list()), (await restarted.authenticate(result.token, ip)).item]) {
    assert.equal(Object.hasOwn(item, 'digest'), false); assert.equal(Object.hasOwn(item, 'token'), false);
    item.name = 'tampered'; item.allowedIps.push('203.0.113.1');
  }
  assert.equal((await restarted.get(id)).name, '자동화'); assert.deepEqual((await restarted.get(id)).allowedIps, []);
});

test('first missing file is empty, missing known store and non-ENOENT read errors fail closed', async t => {
  const f = await setup(t);
  assert.deepEqual(await f.store.list(), []);
  await f.create(); await fs.unlink(f.path);
  await assert.rejects(f.store.list(), unavailable);
  await assert.rejects(f.create({ name: 'new' }), unavailable);
  const denied = createApiKeyStore({ ...f.options, fs: { ...fs, open: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } });
  await assert.rejects(denied.list(), unavailable);
});

test('id allocation is local, ids and names cannot be reused after revoke', async t => {
  const f = await setup(t), id = f.store.allocateId();
  await assert.rejects(f.store.create(input, 'admin'), invalid('INVALID_ID'));
  await assert.rejects(f.create({}, 'a'.repeat(32)), invalid('INVALID_ID'));
  const other = createApiKeyStore(f.options);
  await assert.rejects(other.create(input, 'admin', { id }), invalid('INVALID_ID'));
  const result = await f.create({}, id);
  await assert.rejects(f.create({ name: 'different' }, id), { statusCode: 409, code: 'CONFLICT' });
  await assert.rejects(f.create(), { statusCode: 409, code: 'CONFLICT' });
  const revoked = await f.store.revoke(id);
  assert.equal(revoked.status, 'revoked');
  const bytes = await fs.readFile(f.path, 'utf8');
  f.clock.value++;
  assert.deepEqual(await f.store.revoke(id), revoked);
  assert.equal(await fs.readFile(f.path, 'utf8'), bytes);
  await assert.rejects(f.create(), { statusCode: 409, code: 'CONFLICT' });
  assert.deepEqual(await f.store.authenticate(result.token, ip), { ok: false, reason: 'REVOKED' });
  assert.equal((await f.store.list()).length, 1);
  for (const operation of ['get', 'revoke']) await assert.rejects(f.store[operation]('f'.repeat(32)), { statusCode: 404, code: 'NOT_FOUND' });
});

test('input name, permission, field and IP count limits', async t => {
  const f = await setup(t);
  for (const name of ['', '  ', null, 42, 'x'.repeat(81), 'line\nbreak', 'bad\tname', 'bad\0name', 'bad\u0085name', 'bad\u2028name']) {
    await assert.rejects(f.create({ name }), invalid('INVALID_NAME'));
  }
  assert.equal(Array.from((await f.create({ name: '😀'.repeat(80) })).item.name).length, 80);
  for (const permission of [null, '', 'write', 'READ', {}, 0]) await assert.rejects(f.create({ permission }), invalid('INVALID_PERMISSION'));
  await assert.rejects(f.create({ unexpected: true }), invalid('INVALID_INPUT'));
  await assert.rejects(f.store.create([], 'admin', { id: f.store.allocateId() }), invalid('INVALID_INPUT'));
  await assert.rejects(f.store.create(input, '', { id: f.store.allocateId() }), invalid('INVALID_CREATOR'));
  for (const allowedIps of [null, '192.0.2.1', Array(33).fill(ip)]) {
    await assert.rejects(f.create({ allowedIps }), invalid('INVALID_IPS'));
  }
  const max = await f.create({ name: '32 IPs', allowedIps: Array.from({ length: 32 }, (_, n) => `192.0.2.${n}`) });
  assert.equal(max.item.allowedIps.length, 32);
});

test('expiry requires future UTC ISO and changes authentication exactly at the boundary; revoke wins status', async t => {
  const f = await setup(t);
  for (const expiresAt of ['', 'tomorrow', 42, '2026-10-22', '2026-10-22T00:00:00+09:00', new Date(start).toISOString(), new Date(start - 1).toISOString(), '2026-02-30T00:00:00.000Z']) {
    await assert.rejects(f.create({ expiresAt }), invalid('INVALID_EXPIRY'));
  }
  const expiresAt = new Date(start + 1_000).toISOString(), result = await f.create({ expiresAt });
  f.clock.value = start + 999;
  assert.equal((await f.store.authenticate(result.token, ip)).ok, true);
  f.clock.value++;
  assert.deepEqual(await f.store.authenticate(result.token, ip), { ok: false, reason: 'EXPIRED' });
  await assert.rejects(f.store.recordUse(result.item.id, ip), { statusCode: 403, code: 'API_KEY_FORBIDDEN', reason: 'EXPIRED' });
  assert.equal((await f.store.get(result.item.id)).status, 'expired');
  assert.equal((await f.store.revoke(result.item.id)).status, 'revoked');
  assert.deepEqual(await f.store.authenticate(result.token, ip), { ok: false, reason: 'REVOKED' });
});

test('authentication returns only fixed failure reasons and never records failed attempts', async t => {
  const f = await setup(t), result = await f.create({ allowedIps: [ip] });
  for (const token of [null, [], 123, '', result.token + 'x', result.token.slice(1), 'mak_v1_' + '!'.repeat(43)]) {
    assert.deepEqual(await f.store.authenticate(token, ip), { ok: false, reason: 'INVALID_TOKEN' });
  }
  assert.deepEqual(await f.store.authenticate('mak_v1_' + 'A'.repeat(43), ip), { ok: false, reason: 'UNKNOWN_KEY' });
  for (const value of ['203.0.113.1', '', null, 'fe80::1%eth0']) assert.deepEqual(await f.store.authenticate(result.token, value), { ok: false, reason: 'IP_DENIED' });
  assert.equal((await f.store.get(result.item.id)).lastUsedAt, null);
  await assert.rejects(f.store.recordUse('f'.repeat(32), ip), { reason: 'UNKNOWN_KEY', statusCode: 403 });
  await assert.rejects(f.store.recordUse(result.item.id, '203.0.113.1'), { reason: 'IP_DENIED', statusCode: 403 });
});

const ipCases = [
  ['IPv4 host', [ip], [ip, '::ffff:192.0.2.7'], ['192.0.2.8'], [ip]],
  ['IPv4 host bits', [' 192.0.2.199/24 ', '192.0.2.0/24'], ['192.0.2.0', '192.0.2.255', '::ffff:c000:207'], ['192.0.3.0'], ['192.0.2.0/24']],
  ['IPv4 /0', ['192.0.2.7/0'], ['0.0.0.0', '255.255.255.255'], ['2001:db8::1'], ['0.0.0.0/0']],
  ['IPv4 /32', ['192.0.2.7/32', ip], [ip], ['192.0.2.8'], [ip]],
  ['IPv6 /0', ['2001:db8::1/0'], ['::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'], [], ['::/0']],
  ['IPv6 /128', ['2001:0DB8:0:0:0:0:0:1/128', '2001:db8::1'], ['2001:db8::1', '2001:0DB8:0:0:0:0:0:1'], ['2001:db8::2'], ['2001:db8::1']],
  ['IPv6 host bits', ['2001:db8:abcd:ffff::1/48'], ['2001:db8:abcd::', '2001:db8:abcd:ffff:ffff:ffff:ffff:ffff'], ['2001:db8:abce::'], ['2001:db8:abcd::/48']],
  ['mapped host', ['::FFFF:192.0.2.7', ip], [ip, '::ffff:c000:207'], ['192.0.2.8'], [ip]],
  ['mapped subnet', ['::ffff:192.0.2.199/120'], [ip, '::ffff:192.0.2.255'], ['192.0.3.0'], ['192.0.2.0/24']],
  ['empty allowlist', [], [ip, '2001:db8::1', '::ffff:192.0.2.7'], [], []],
];
for (const [name, allowedIps, allowed, denied, normalized] of ipCases) test(`IP/CIDR ${name}`, async t => {
  const f = await setup(t), result = await f.create({ allowedIps });
  assert.deepEqual(result.item.allowedIps, normalized);
  for (const address of allowed) assert.equal((await f.store.authenticate(result.token, address)).ok, true, address);
  for (const address of denied) assert.deepEqual(await f.store.authenticate(result.token, address), { ok: false, reason: 'IP_DENIED' }, address);
});

test('invalid IP/CIDR inputs are rejected without changing the file', async t => {
  const f = await setup(t); await f.create();
  const before = await fs.readFile(f.path, 'utf8');
  for (const value of ['', '192.0.2.07', '256.0.0.1', '192.0.2.1/-1', '192.0.2.1/33', '192.0.2.1/', '192.0.2.1/24/1', '192.0.2.1/ 24', '::1/129', '::1/x', 'fe80::1%eth0', 'not-an-ip', null, {}]) {
    await assert.rejects(f.create({ name: 'bad IP', allowedIps: [value] }), invalid('INVALID_IP'));
  }
  assert.equal(await fs.readFile(f.path, 'utf8'), before);
});

test('lastUsed writes once per 60 seconds, keeps newer memory values, and restart loses only unsaved use', async t => {
  const f = await setup(t), result = await f.create(), id = result.item.id;
  await f.store.recordUse(id, '::ffff:192.0.2.7');
  const first = await fs.readFile(f.path, 'utf8');
  f.clock.value += 59_999;
  const latest = await f.store.recordUse(id, '203.0.113.8');
  assert.equal(latest.lastUsedAt, new Date(f.clock.value).toISOString()); assert.equal(latest.lastUsedIp, '203.0.113.8');
  assert.equal(await fs.readFile(f.path, 'utf8'), first);
  assert.equal((await f.store.list())[0].lastUsedIp, '203.0.113.8');
  assert.equal((await f.store.authenticate(result.token, ip)).item.lastUsedIp, '203.0.113.8');
  assert.equal((await createApiKeyStore(f.options).get(id)).lastUsedIp, ip);
  await f.create({ name: 'second' });
  assert.equal(JSON.parse(await fs.readFile(f.path, 'utf8')).records[0].lastUsedIp, ip);
  assert.equal((await f.store.get(id)).lastUsedIp, '203.0.113.8');
  f.clock.value++;
  await f.store.recordUse(id, '203.0.113.9');
  const saved = JSON.parse(await fs.readFile(f.path, 'utf8')).records[0];
  assert.equal(saved.lastUsedAt, new Date(start + 60_000).toISOString()); assert.equal(saved.lastUsedIp, '203.0.113.9');
});

test('serialization keeps concurrent issues, limits concurrent lastUsed writes, and never resurrects revoke', async t => {
  let renames = 0;
  const f = await setup(t, { fs: { ...fs, async rename(...args) { renames++; return fs.rename(...args); } } });
  const issued = await Promise.all(Array.from({ length: 20 }, (_, n) => f.create({ name: `key ${n}`, permission: n % 2 ? 'full' : 'read' })));
  assert.equal((await f.store.list()).length, 20); assert.equal(renames, 20);
  const { item, token } = issued[0];
  await Promise.all(Array.from({ length: 20 }, () => f.store.recordUse(item.id, ip)));
  assert.equal(renames, 21);
  const pending = [f.store.recordUse(item.id, ip), f.store.revoke(item.id), f.store.recordUse(item.id, ip), f.create({ name: 'during revoke' })];
  const outcomes = await Promise.allSettled(pending);
  assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'fulfilled');
  assert.equal(outcomes[2].status, 'rejected'); assert.equal(outcomes[2].reason.reason, 'REVOKED');
  assert.equal(outcomes[3].status, 'fulfilled');
  assert.equal((await f.store.list()).length, 21);
  assert.deepEqual(await createApiKeyStore(f.options).authenticate(token, ip), { ok: false, reason: 'REVOKED' });
  assert.deepEqual(await fs.readdir(f.directory), ['keys.json']);
});

test('concurrent duplicate names produce exactly one key', async t => {
  const f = await setup(t);
  const results = await Promise.allSettled([f.create(), f.create()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'CONFLICT');
  assert.equal((await f.store.list()).length, 1);
});

const corruptions = {
  json: () => '{', version: data => ({ ...data, version: 2 }), records: data => ({ ...data, records: {} }),
  unknownField: data => ({ ...data, token: 'synthetic' }),
  digest: data => { data.records[0].digest = 'invalid'; return data; },
  permission: data => { data.records[0].permission = 'write'; return data; },
  name: data => { data.records[0].name = ''; return data; },
  extraRecordField: data => { data.records[0].token = 'synthetic'; return data; },
  missingField: data => { delete data.records[0].revokedAt; return data; },
  badIp: data => { data.records[0].allowedIps = ['bad']; return data; },
  unnormalizedIp: data => { data.records[0].allowedIps = ['192.0.2.199/24']; return data; },
  expiry: data => { data.records[0].expiresAt = 'tomorrow'; return data; },
  missingLastIp: data => { data.records[0].lastUsedAt = new Date(start).toISOString(); return data; },
  lastIp: data => { data.records[0].lastUsedAt = new Date(start).toISOString(); data.records[0].lastUsedIp = 'bad'; return data; },
  duplicateId: data => { data.records.push({ ...data.records[0], name: 'different' }); return data; },
  duplicateName: data => { data.records.push({ ...data.records[0], id: 'f'.repeat(32) }); return data; },
  tooManyRecords: data => { data.records = Array(1001).fill(data.records[0]); return data; },
};
for (const [name, corrupt] of Object.entries(corruptions)) test(`damaged store ${name} fails closed and is never overwritten`, async t => {
  const f = await setup(t), result = await f.create();
  const value = corrupt(JSON.parse(await fs.readFile(f.path, 'utf8'))), text = typeof value === 'string' ? value : JSON.stringify(value);
  await fs.writeFile(f.path, text);
  for (const operation of [() => f.store.list(), () => f.store.authenticate(result.token, ip), () => f.create({ name: 'new' }), () => f.store.revoke(result.item.id), () => f.store.recordUse(result.item.id, ip)]) await assert.rejects(operation(), unavailable);
  assert.equal(await fs.readFile(f.path, 'utf8'), text);
});

test('1000 record cap includes revoked records', async t => {
  const f = await setup(t); await f.create();
  const data = JSON.parse(await fs.readFile(f.path, 'utf8'));
  data.records = Array.from({ length: 1000 }, (_, n) => ({ ...data.records[0], id: n.toString(16).padStart(32, '0'), name: `synthetic ${n}`, revokedAt: new Date(start).toISOString() }));
  await fs.writeFile(f.path, JSON.stringify(data));
  assert.equal((await f.store.list()).length, 1000);
  await assert.rejects(f.create({ name: 'over cap' }), invalid('TOO_MANY_KEYS'));
});

for (const target of ['directory', 'file']) test(`rejects ${target} symlink, broad modes and wrong owner`, async t => {
  const f = await setup(t); await f.create();
  const path = target === 'directory' ? f.directory : f.path, real = `${path}.real`;
  await fs.rename(path, real); await fs.symlink(real, path);
  await assert.rejects(f.store.list(), unavailable);
  await fs.unlink(path); await fs.rename(real, path);
  await fs.chmod(path, target === 'directory' ? 0o755 : 0o644);
  await assert.rejects(f.store.list(), unavailable);
  await fs.chmod(path, target === 'directory' ? 0o700 : 0o600);
  const wrongOwner = stat => handleWith(stat, { uid: process.getuid() + 1 });
  const injected = { ...fs,
    lstat: async value => target === 'directory' ? wrongOwner(await fs.lstat(value)) : fs.lstat(value),
    open: async (...args) => {
      const handle = await fs.open(...args);
      return target === 'file' && args[0] === f.path ? handleWith(handle, { stat: async () => wrongOwner(await handle.stat()) }) : handle;
    },
  };
  await assert.rejects(createApiKeyStore({ ...f.options, fs: injected }).list(), unavailable);
});

test('atomic write ordering: private exclusive temp, file fsync, close, rename, directory fsync', async t => {
  const events = [];
  const f = await setup(t, { fs: { ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (flags === 'wx') {
        assert.equal(mode, 0o600); assert.match(path, /\.keys\.[a-f0-9]{32}\.tmp$/);
        return handleWith(handle, {
          chmod: async value => { events.push('chmod'); return handle.chmod(value); },
          writeFile: async (...args) => { events.push('write'); return handle.writeFile(...args); },
          sync: async () => { events.push('file sync'); return handle.sync(); },
          close: async () => { events.push('file close'); return handle.close(); },
        });
      }
      if (flags & constants.O_DIRECTORY) return handleWith(handle, { sync: async () => { events.push('directory sync'); return handle.sync(); } });
      return handle;
    },
    async rename(...args) { events.push('rename'); return fs.rename(...args); },
  } });
  await f.create();
  assert.deepEqual(events, ['chmod', 'write', 'file sync', 'file close', 'rename', 'directory sync']);
  assert.deepEqual(await fs.readdir(f.directory), ['keys.json']);
});

for (const stage of ['open', 'writeFile', 'sync', 'close', 'rename']) test(`atomic ${stage} failure preserves previous file, cleans temp and fails use closed`, async t => {
  const f = await setup(t), result = await f.create(), before = await fs.readFile(f.path, 'utf8');
  let enabled = true;
  const fail = () => { throw new Error('synthetic storage failure'); };
  const injected = { ...fs,
    async open(path, flags, mode) {
      if (enabled && flags === 'wx' && stage === 'open') fail();
      const handle = await fs.open(path, flags, mode);
      if (flags !== 'wx' || ['open', 'rename'].includes(stage)) return handle;
      let failedClose = false;
      return handleWith(handle, { [stage]: async (...args) => {
        if (enabled && !(stage === 'close' && failedClose)) { failedClose = true; fail(); }
        return handle[stage](...args);
      } });
    },
    async rename(...args) { if (enabled && stage === 'rename') fail(); return fs.rename(...args); },
  };
  const store = createApiKeyStore({ ...f.options, fs: injected });
  await assert.rejects(store.create({ ...input, name: 'new' }, 'admin', { id: store.allocateId() }), unavailable);
  await assert.rejects(store.revoke(result.item.id), unavailable);
  await assert.rejects(store.recordUse(result.item.id, ip), unavailable);
  assert.equal(await fs.readFile(f.path, 'utf8'), before);
  assert.deepEqual(await fs.readdir(f.directory), ['keys.json']);
  assert.equal((await store.get(result.item.id)).lastUsedAt, null);
  enabled = false;
  await store.revoke(result.item.id);
  assert.deepEqual(await store.authenticate(result.token, ip), { ok: false, reason: 'REVOKED' });
});

test('directory fsync failure after rename reloads committed revoke and never restores prior memory', async t => {
  const f = await setup(t), result = await f.create();
  let fail = true;
  const store = createApiKeyStore({ ...f.options, fs: { ...fs, async open(path, flags, mode) {
    const handle = await fs.open(path, flags, mode);
    return flags & constants.O_DIRECTORY ? handleWith(handle, { sync: async () => { if (fail) throw new Error('synthetic sync failure'); return handle.sync(); } }) : handle;
  } } });
  await assert.rejects(store.revoke(result.item.id), { statusCode: 503, code: 'API_KEY_STORE_DURABILITY_UNCERTAIN' });
  assert.equal(JSON.parse(await fs.readFile(f.path, 'utf8')).records[0].revokedAt, new Date(start).toISOString());
  assert.deepEqual(await store.authenticate(result.token, ip), { ok: false, reason: 'REVOKED' });
  assert.equal((await store.get(result.item.id)).status, 'revoked');
  await assert.rejects(store.recordUse(result.item.id, ip), { reason: 'REVOKED' });
  fail = false;
  assert.equal((await store.revoke(result.item.id)).status, 'revoked');
  assert.deepEqual(await fs.readdir(f.directory), ['keys.json']);
});

test('directory fsync failure after issue leaves an orphan DTO without returning its token', async t => {
  const f = await setup(t);
  const store = createApiKeyStore({ ...f.options, fs: { ...fs, async open(path, flags, mode) {
    const handle = await fs.open(path, flags, mode);
    return flags & constants.O_DIRECTORY ? handleWith(handle, { sync: async () => { throw new Error('synthetic failure'); } }) : handle;
  } } });
  const id = store.allocateId();
  await assert.rejects(store.create(input, 'admin', { id }), { statusCode: 503, code: 'API_KEY_STORE_DURABILITY_UNCERTAIN' });
  const rows = await store.list(); assert.equal(rows.length, 1); assert.equal(rows[0].id, id);
  assert.equal(Object.hasOwn(rows[0], 'token'), false); assert.equal(Object.hasOwn(rows[0], 'digest'), false);
  await assert.rejects(store.create(input, 'admin', { id }), { code: 'CONFLICT' });
});
