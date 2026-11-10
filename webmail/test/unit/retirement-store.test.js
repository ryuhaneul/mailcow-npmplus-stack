import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetirementStore, emptyRetirementState } from '../../server/security/retirement-store.js';

const email = 'retired@example.test';
function fixture() {
  let accounts = new Map(), keys = [], backup, released = 0, destroyed = 0, lock = 1, failKey = false;
  const calls = [];
  const connection = { release() { released++; }, destroy() { destroyed++; if (backup) { accounts = backup.accounts; keys = backup.keys; backup = null; } }, async execute(sql, values = []) {
    calls.push({ sql, values });
    if (sql === 'START TRANSACTION') { backup = structuredClone({ accounts, keys }); return [{}]; }
    if (sql === 'COMMIT') { backup = null; return [{}]; }
    if (sql === 'ROLLBACK') { accounts = backup.accounts; keys = backup.keys; backup = null; return [{}]; }
    if (sql.includes('GET_LOCK')) return [[{ acquired: lock }]];
    if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
    if (sql.startsWith('SELECT retired')) return [[accounts.get(values[0])].filter(Boolean)];
    if (sql.startsWith('SELECT DISTINCT')) return [[...new Set(keys.filter(row => values.includes(row.recipient)).map(row => row.recipient))].sort().map(recipient => ({ recipient }))];
    if (sql.startsWith('SELECT recipient')) return [keys.filter(row => row.owner === values[0]).map(({ recipient }) => ({ recipient }))];
    if (sql.startsWith('INSERT INTO mailstack_webmail.retirement_recipient_keys')) {
      if (failKey) throw Error('synthetic insertion failure');
      keys.push({ recipient: values[0], owner: values[1] }); return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('DELETE FROM mailstack_webmail.retirement_recipient_keys')) { keys = keys.filter(row => row.owner !== values[0]); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('DELETE FROM mailstack_webmail.account_retirement')) {
      if (accounts.get(values[0])?.version !== values[1]) return [{ affectedRows: 0 }];
      accounts.delete(values[0]); keys = keys.filter(row => row.owner !== values[0]); return [{ affectedRows: 1 }];
    }
    const [retired, receive_blocked, recorded_at, source, source_audit_id, updated_by, pending_operation, version, address, expected] = values;
    if (sql.startsWith('INSERT')) { if (accounts.has(address)) throw Object.assign(Error(), { code: 'ER_DUP_ENTRY' }); }
    else if (accounts.get(address)?.version !== expected) return [{ affectedRows: 0 }];
    accounts.set(address, { retired, receive_blocked, recorded_at, source, source_audit_id, updated_by, pending_operation, version, updated_at: '2026-01-01 00:00:00.000000' });
    return [{ affectedRows: 1 }];
  } };
  return { calls, connection, db: { getConnection: async () => connection, end: async () => {} },
    get accounts() { return accounts; }, get keys() { return keys; }, get released() { return released; }, get destroyed() { return destroyed; },
    set lock(value) { lock = value; }, set failKey(value) { failKey = value; } };
}
const input = (expected = { version: null }, override = {}) => ({ email, retired: true, receiveBlocked: false, source: 'leave', updatedBy: 'test-admin', expected, ...override });

test('retirement: absent record, CAS insert/update/remove, immutable generations and parameterized addresses', async () => {
  const f = fixture(), store = createRetirementStore({ db: f.db });
  assert.deepEqual(await store.read(email), emptyRetirementState());
  const first = await store.write(input());
  assert.match(first.version, /^[a-f0-9]{32}$/);
  await assert.rejects(store.write(input()), { statusCode: 409 });
  const on = await store.write(input(first, { receiveBlocked: true, keys: [email, 'alias@example.test'] }));
  assert.notEqual(first.version, on.version);
  assert.equal((await store.read(email)).receiveBlocked, true);
  await assert.rejects(store.write(input(first)), { statusCode: 409 });
  await assert.rejects(store.remove({ email, expected: first }), { statusCode: 409 });
  await store.remove({ email, expected: on });
  assert.deepEqual(await store.read(email), emptyRetirementState()); assert.deepEqual(f.keys, []);
  assert.ok(f.calls.every(call => !call.sql.includes(email)));
});
test('retirement: recorded audit time stays UTC across SQL storage and readback', async () => {
  const f = fixture(), store = createRetirementStore({ db: f.db });
  const written = await store.write(input(undefined, { recordedAt: '2026-02-05T12:00:00+09:00' }));
  assert.equal(written.recordedAt, '2026-02-05T03:00:00.000Z');
  assert.equal((await store.read(email)).recordedAt, written.recordedAt);
});
test('retirement: key insertion failure rolls back both metadata and keys', async () => {
  const f = fixture(), store = createRetirementStore({ db: f.db }), first = await store.write(input());
  f.failKey = true;
  await assert.rejects(store.write(input(first, { receiveBlocked: true, keys: [email] })), { statusCode: 503 });
  assert.equal((await store.read(email)).version, first.version); assert.deepEqual(f.keys, []); assert.equal(f.destroyed, 1);
});
test('retirement: owner-specific OFF preserves another owner on the same envelope key', async () => {
  const f = fixture(), store = createRetirementStore({ db: f.db });
  const a = await store.write(input(undefined, { receiveBlocked: true, keys: [email, 'shared@example.test'] }));
  await store.write(input(undefined, { email: 'other@example.test', receiveBlocked: true, keys: ['other@example.test', 'shared@example.test'] }));
  await store.write(input(a));
  assert.deepEqual(await store.keysForOwner(email), []);
  assert.deepEqual(await store.blockedRecipients(['shared@example.test']), ['shared@example.test']);
});
test('retirement: public role exposes only a single SELECT guard, with lowercase and full/base keys', async () => {
  const f = fixture(), admin = createRetirementStore({ db: f.db });
  await admin.write(input(undefined, { receiveBlocked: true, keys: [email] })); f.calls.length = 0;
  const reader = createRetirementStore({ db: f.db, mode: 'public' });
  assert.deepEqual(Object.keys(reader).sort(), ['blockedRecipients', 'close']);
  assert.deepEqual(await reader.blockedRecipients(['RETIRED+tag@EXAMPLE.TEST', email]), [email]);
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].sql.startsWith('SELECT DISTINCT'));
  assert.deepEqual(f.calls[0].values, ['retired+tag@example.test', email]);
  assert.deepEqual(await reader.blockedRecipients([]), []); assert.equal(f.calls.length, 1);
  assert.deepEqual(await reader.blockedRecipients(['+tag@example.test']), []);
});
test('retirement: invalid bool, missing canonical key and unsupported addresses fail before writes', async () => {
  const f = fixture(), store = createRetirementStore({ db: f.db });
  for (const data of [{ retired: 'true' }, { receiveBlocked: 'false' }, { retired: false, receiveBlocked: true },
    { receiveBlocked: true, keys: [] }, { receiveBlocked: false, keys: [email] }, { email: 'broken' }, { version: 'bad' }, { pendingOperation: [] }]) {
    await assert.rejects(store.write(input(undefined, data)), { statusCode: 422 });
  }
  assert.equal(f.calls.length, 0);
});
test('retirement: named lock uses one connection across nested calls and releases on application failure', async () => {
  const f = fixture(), store = createRetirementStore({ db: f.db });
  await assert.rejects(store.withRoutingLock(() => store.withRoutingLock(async () => { await store.write(input()); throw new Error('application'); })), /application/);
  assert.equal(f.calls.filter(call => call.sql.includes('GET_LOCK')).length, 1);
  assert.equal(f.calls.filter(call => call.sql.includes('RELEASE_LOCK')).length, 1); assert.equal(f.released, 1);
  f.calls.length = 0; f.lock = 0;
  await assert.rejects(store.withRoutingLock(() => store.write(input())), { statusCode: 503, reason: 'ROUTING_BUSY' });
  assert.equal(f.calls.length, 1);
});
test('retirement: missing backend, corrupt DB state and failed query never return OFF', async () => {
  await assert.rejects(createRetirementStore().read(email), { statusCode: 503 });
  const f = fixture(), store = createRetirementStore({ db: f.db });
  await store.write(input()); f.accounts.get(email).receive_blocked = 9;
  await assert.rejects(store.read(email), { statusCode: 503 });
  f.connection.execute = async () => { throw Error('synthetic secret'); };
  await assert.rejects(store.read(email), error => error.statusCode === 503 && !error.message.includes('synthetic secret'));
});
test('retirement: acquisition timeout releases late connection without executing SQL', async () => {
  const f = fixture(); let acquire;
  const store = createRetirementStore({ timeoutMs: 10, db: { getConnection: () => new Promise(resolve => { acquire = resolve; }) } });
  await assert.rejects(store.read(email), { statusCode: 503, reason: 'DB_TIMEOUT' });
  acquire(f.connection); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0); assert.equal(f.released, 1);
});
test('retirement: query timeout destroys locked connection, never reuses it', async () => {
  const f = fixture(), execute = f.connection.execute;
  f.connection.execute = (sql, values) => sql.includes('GET_LOCK') ? execute(sql, values) : new Promise(() => {});
  const store = createRetirementStore({ db: f.db, timeoutMs: 10 });
  await assert.rejects(store.withRoutingLock(() => store.read(email)), { statusCode: 503 });
  assert.equal(f.destroyed, 1); assert.equal(f.released, 0);
});
test('retirement: swallowed backend errors cannot turn a lost routing lock into success', async () => {
  const f = fixture(), execute = f.connection.execute;
  f.connection.execute = async (sql, values) => { if (sql.includes('GET_LOCK')) return execute(sql, values); throw Error('synthetic disconnect'); };
  const store = createRetirementStore({ db: f.db });
  await assert.rejects(store.withRoutingLock(async () => { try { await store.read(email); } catch {} return 'unsafe success'; }), { statusCode: 503 });
  assert.equal(f.destroyed,1); assert.equal(f.released,0);
});
