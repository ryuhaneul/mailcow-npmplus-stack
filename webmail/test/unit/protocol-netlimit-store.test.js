import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProtocolNetlimitStore } from '../../server/security/protocol-netlimit-store.js';
const email = 'user@example.test', initial = { enabled: false, version: null };
function database() {
  const rows = new Map(), calls = []; let released = 0, destroyed = 0;
  const connection = { release() { released++; }, destroy() { destroyed++; }, async execute(sql, values) {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT')) { const row = rows.get(values[0]); return [[{ enabled: Number(row?.enabled ?? false), version: row?.version ?? null, allowlist_empty: 1, ip: null }]]; }
    if (sql.startsWith('INSERT')) {
      const [key, enabled, version] = values;
      if (rows.has(key)) throw Object.assign(new Error('synthetic duplicate'), { code: 'ER_DUP_ENTRY' });
      rows.set(key, { enabled: Boolean(enabled), version }); return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE')) {
      const [enabled, version, key, expected] = values;
      if (rows.get(key)?.version !== expected) return [{ affectedRows: 0 }];
      rows.set(key, { enabled: Boolean(enabled), version }); return [{ affectedRows: 1 }];
    }
    const [key, expected] = values;
    if (rows.get(key)?.version !== expected) return [{ affectedRows: 0 }];
    rows.delete(key); return [{ affectedRows: 1 }];
  } };
  return { rows, calls, connection, get released() { return released; }, get destroyed() { return destroyed; }, db: { async getConnection() { return connection; }, async end() {} } };
}
test('netlimit store: absent OFF, fresh generations, CAS, cleanup and one statement per read', async () => {
  const f = database(), store = createProtocolNetlimitStore({ db: f.db });
  assert.deepEqual(await store.read(email), { ...initial, allowlistEmpty: true, ips: [] });
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].sql.includes('LEFT JOIN mailstack_webmail.login_ip_allowlist'));
  const on = await store.write({ email, enabled: true, expected: initial });
  assert.match(on.version, /^[a-f0-9]{32}$/);
  await assert.rejects(store.write({ email, enabled: true, expected: initial }), { statusCode: 409 });
  const off = await store.write({ email, enabled: false, expected: on }); assert.notEqual(off.version, on.version);
  await assert.rejects(store.write({ email, enabled: true, expected: on }), { statusCode: 409 });
  await assert.rejects(store.remove({ email, expected: on }), { statusCode: 409 });
  await store.remove({ email, expected: off }); assert.equal((await store.read(email)).version, null);
  assert.equal(f.released, f.calls.length); assert.ok(f.calls.every(c => !c.sql.includes(email)));
});
test('netlimit store: missing backend and backend errors fail instead of returning OFF', async () => {
  await assert.rejects(createProtocolNetlimitStore().read(email), { statusCode: 503 });
  const f = database(); f.connection.execute = async () => { throw Error('synthetic backend detail'); };
  await assert.rejects(createProtocolNetlimitStore({ db: f.db }).read(email), e => e.statusCode === 503 && !e.message.includes('synthetic backend detail'));
  assert.equal(f.released, 1);
});
test('netlimit store: total acquisition budget releases a late connection', async () => {
  const f = database(); let acquire;
  const store = createProtocolNetlimitStore({ timeoutMs: 10, db: { getConnection: () => new Promise(resolve => { acquire = resolve; }) } });
  await assert.rejects(store.read(email), { statusCode: 503, reason: 'DB_TIMEOUT' });
  acquire(f.connection); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.released, 1); assert.equal(f.calls.length, 0);
});
test('netlimit store: timed out query destroys rather than returns a busy connection', async () => {
  const f = database(); f.connection.execute = () => new Promise(() => {});
  await assert.rejects(createProtocolNetlimitStore({ db: f.db, timeoutMs: 10 }).read(email), { statusCode: 503 });
  assert.equal(f.destroyed, 1); assert.equal(f.released, 0);
});
