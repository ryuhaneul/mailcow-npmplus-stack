import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFtsScheduler } from '../../server/admin/fts-scheduler.js';
import { createFtsState } from '../../server/admin/fts-state.js';
import { createFtsNightly } from '../../server/admin/services/fts-nightly.js';

const config = { enabled: true, start: '03:00', end: '06:00' };
function fixture(overrides = {}) {
  let time = Date.parse('2026-10-20T18:00:00Z'), scheduled = 0, cleared = 0, unreferenced = 0;
  const calls = [], warnings = [];
  let callback;
  const nightly = { async runOnce(args) { calls.push(args); return { status: 'done' }; } };
  const deps = { config, nightly, now: () => time,
    logger: { warn: (...args) => warnings.push(args) },
    setInterval(fn, delay) { scheduled++; callback = fn; assert.equal(delay, 60_000); return { unref() { unreferenced++; } }; },
    clearInterval() { cleared++; }, ...overrides };
  const scheduler = createFtsScheduler(deps);
  return { scheduler, calls, warnings, nightly, setTime(value) { time = Date.parse(value); },
    fire: () => callback(), counts: () => ({ scheduled, cleared, unreferenced }) };
}

test('fts scheduler: exact KST START inclusive and END exclusive, daily deduplication and next day', async () => {
  const f = fixture();
  f.setTime('2026-10-20T17:59:59.999Z'); await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  f.setTime('2026-10-20T18:00:00Z'); await f.scheduler.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].deadline, Date.parse('2026-10-20T21:00:00Z'));
  await f.scheduler.tick(); f.setTime('2026-10-20T20:59:59.999Z'); await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  f.setTime('2026-10-21T18:00:00Z'); await f.scheduler.tick(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].deadline, Date.parse('2026-10-21T21:00:00Z'));
  const outside = fixture(); outside.setTime('2026-10-20T21:00:00Z'); await outside.scheduler.tick();
  outside.setTime('2026-10-20T21:01:00Z'); await outside.scheduler.tick(); assert.equal(outside.calls.length, 0);
});

test('fts scheduler: UTC midnight is KST 09:00, outside the window', async () => {
  const f = fixture();
  for (const time of ['2026-10-20T23:59:59.999Z', '2026-10-21T00:00:00Z', '2026-10-21T14:59:59.999Z', '2026-10-21T15:00:00Z']) {
    f.setTime(time); await f.scheduler.tick();
  }
  assert.equal(f.calls.length, 0);
  f.setTime('2026-10-21T18:00:00Z'); await f.scheduler.tick(); assert.equal(f.calls.length, 1);
});

test('fts scheduler: custom same-day window can straddle UTC midnight', async () => {
  const f = fixture({ config: { ...config, start: '08:00', end: '10:00' } });
  f.setTime('2026-10-20T23:00:00Z'); await f.scheduler.tick();
  assert.equal(f.calls[0].deadline, Date.parse('2026-10-21T01:00:00Z'));
  f.setTime('2026-10-21T00:00:00Z'); await f.scheduler.tick(); assert.equal(f.calls.length, 1);
  f.setTime('2026-10-22T00:00:00Z'); await f.scheduler.tick(); assert.equal(f.calls.length, 2);
});

test('fts scheduler: restart inside window attempts once; outside waits for next window', async () => {
  const first = fixture(); await first.scheduler.tick();
  const restarted = fixture(); restarted.setTime('2026-10-20T19:00:00Z'); await restarted.scheduler.tick();
  assert.equal(restarted.calls.length, 1);
  const outside = fixture(); outside.setTime('2026-10-20T22:00:00Z'); outside.scheduler.start();
  assert.equal(outside.calls.length, 0);
  outside.setTime('2026-10-21T18:00:00Z'); outside.fire(); assert.equal(outside.calls.length, 1);
  outside.scheduler.stop();
});

test('fts scheduler: disabled starts no timer and all ticks start zero runs', async () => {
  const f = fixture({ config: { ...config, enabled: false } });
  f.scheduler.start(); await f.scheduler.tick(); f.setTime('2026-10-21T18:00:00Z'); await f.scheduler.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.counts().scheduled, 0);
});

test('fts scheduler: start is idempotent, timer is unreferenced, stop aborts and clears once', async () => {
  const f = fixture(); f.scheduler.start(); f.scheduler.start();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, false);
  assert.deepEqual(f.counts(), { scheduled: 1, cleared: 0, unreferenced: 1 });
  f.scheduler.stop(); f.scheduler.stop(); assert.equal(f.calls[0].signal.aborted, true);
  f.setTime('2026-10-21T18:00:00Z'); f.fire(); await f.scheduler.tick(); f.scheduler.start();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.counts(), { scheduled: 1, cleared: 1, unreferenced: 1 });
});

test('fts scheduler: concurrent ticks and next-day overlap start zero additional runs', async () => {
  let finish;
  const f = fixture(); f.nightly.runOnce = args => { f.calls.push(args); return new Promise(resolve => { finish = resolve; }); };
  const pending = f.scheduler.tick(); await f.scheduler.tick();
  f.setTime('2026-10-21T18:00:00Z'); await f.scheduler.tick(); assert.equal(f.calls.length, 1);
  f.scheduler.stop(); assert.equal(f.calls[0].signal.aborted, true);
  finish({ status: 'cutoff' }); assert.equal((await pending).status, 'cutoff');
});

test('fts scheduler: busy and rejected runs are not retried that day; errors log no private detail', async () => {
  for (const fails of [false, true]) {
    const f = fixture(); f.nightly.runOnce = async args => {
      f.calls.push(args); if (fails) throw new Error('synthetic-secret'); return { status: 'busy' };
    };
    const result = await f.scheduler.tick(); await f.scheduler.tick(); assert.equal(f.calls.length, 1);
    assert.equal(result?.status, fails ? undefined : 'busy');
    assert.equal(f.warnings.length, fails ? 1 : 0); assert.ok(!JSON.stringify(f.warnings).includes('synthetic-secret'));
    f.setTime('2026-10-21T18:00:00Z'); await f.scheduler.tick(); assert.equal(f.calls.length, 2);
  }
});

test('fts scheduler: real persistent orphan lock remains busy across restart and next day', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fts-scheduler-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const owner = createFtsState({ dir }); await owner.acquire();
  const store = createFtsState({ dir }); let measurements = 0;
  const runner = createFtsNightly({ state: store, measure: { async measureAll() { measurements++; } } });
  const f = fixture({ nightly: runner });
  assert.equal((await f.scheduler.tick()).status, 'busy');
  await f.scheduler.tick(); f.setTime('2026-10-21T18:00:00Z'); assert.equal((await f.scheduler.tick()).status, 'busy');
  assert.equal(measurements, 0); assert.equal(await store.acquire(), null);
  await owner.release();
});


for (const enabled of [true, false]) test(`fts scheduler: startup recovers orphan outside window even enabled=${enabled}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fts-restart-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const owner = createFtsState({ dir }); await owner.acquire(); await owner.startRun();
  const state = createFtsState({ dir }); let remoteCalls = 0;
  const nightly = createFtsNightly({ state, measure: { async measureAll() { remoteCalls++; } } });
  const f = fixture({ nightly, config: { ...config, enabled } });
  f.setTime('2026-10-20T22:00:00Z');
  await f.scheduler.start(); t.after(() => f.scheduler.stop());
  assert.equal((await state.read()).state.status, 'unknown');
  assert.equal((await state.read()).state.remoteUnknown.reason, 'restart');
  assert.equal(remoteCalls, 0); assert.equal(await state.acquire(), null);
});

test('fts scheduler: failed recovery logs a safe warning and does not block startup', async () => {
  const f = fixture({ nightly: { async recoverAfterRestart() { throw new Error('synthetic-secret'); }, async runOnce() {} } });
  f.setTime('2026-10-20T22:00:00Z');
  await f.scheduler.start();
  assert.equal(f.counts().scheduled, 1);
  assert.equal(f.warnings[0][0].code, 'FTS_RESTART_RECOVERY_FAILED');
  assert.ok(!JSON.stringify(f.warnings).includes('synthetic-secret')); f.scheduler.stop();
});

const overnight = { ...config, start: '22:00', end: '06:00' };
test('fts scheduler: overnight window includes START, keeps its date across KST midnight and excludes END', async () => {
  const f = fixture({ config: overnight });
  f.setTime('2026-10-20T12:59:59.999Z'); await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  f.setTime('2026-10-20T13:00:00Z'); await f.scheduler.tick();
  assert.equal(f.calls[0].day, '2026-10-20');
  assert.equal(f.calls[0].deadline, Date.parse('2026-10-20T21:00:00Z'));
  for (const time of ['2026-10-20T14:59:59.999Z', '2026-10-20T15:00:00Z', '2026-10-20T20:59:59.999Z', '2026-10-20T21:00:00Z', '2026-10-21T00:00:00Z']) {
    f.setTime(time); await f.scheduler.tick();
  }
  assert.equal(f.calls.length, 1);
  f.setTime('2026-10-21T13:00:00Z'); await f.scheduler.tick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].day, '2026-10-21');
  assert.equal(f.calls[1].deadline, Date.parse('2026-10-21T21:00:00Z'));
});

test('fts scheduler: overnight month/year rollover and UTC midnight use the opening KST date', async () => {
  for (const [start, end, time, day, deadline] of [
    ['22:00', '06:00', '2026-12-31T15:00:00Z', '2026-12-31', '2026-12-31T21:00:00Z'],
    ['22:00', '06:00', '2026-10-31T20:59:59Z', '2026-10-31', '2026-10-31T21:00:00Z'],
    ['22:00', '10:00', '2026-10-21T00:00:00Z', '2026-10-20', '2026-10-21T01:00:00Z'],
    ['22:00', '00:00', '2026-10-20T14:59:59Z', '2026-10-20', '2026-10-20T15:00:00Z'],
  ]) {
    const f = fixture({ config: { ...config, start, end } });
    f.setTime(time); await f.scheduler.tick();
    assert.equal(f.calls[0].day, day); assert.equal(f.calls[0].deadline, Date.parse(deadline));
  }
  const f = fixture({ config: { ...overnight, end: '00:00' } });
  f.setTime('2026-10-20T15:00:00Z'); await f.scheduler.tick(); assert.equal(f.calls.length, 0);
});

for (const firstTime of ['2026-10-20T14:59:59.999Z', '2026-10-20T15:00:00Z']) {
  test(`fts scheduler: persistent overnight runIds deduplicate same-window restarts starting at ${firstTime}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'fts-overnight-')); t.after(() => rm(dir, { recursive: true, force: true }));
    let time = Date.parse(firstTime), measurements = 0;
    const now = () => time;
    const make = () => {
      const state = createFtsState({ dir, now });
      const nightly = createFtsNightly({ state, now,
        measure: { async measureAll() { measurements++; return { folders: [], measuredAt: new Date(time).toISOString() }; } },
        audit: { async run(meta, fn) { return fn(); } } });
      return { state, scheduler: createFtsScheduler({ config: overnight, nightly, now }) };
    };
    const first = make(); assert.equal((await first.scheduler.tick()).status, 'done');
    const saved = (await first.state.read()).state;
    assert.equal(saved.day, '2026-10-20'); assert.deepEqual(Object.keys(saved.runIds), ['2026-10-20']);
    for (const at of ['2026-10-20T15:00:00Z', '2026-10-20T20:59:59.999Z']) {
      time = Date.parse(at);
      const restart = make(); await restart.scheduler.tick(); await restart.scheduler.tick();
      assert.equal((await restart.state.read()).state.runId, saved.runId); assert.equal(measurements, 1);
    }
    time = Date.parse('2026-10-21T00:00:00Z');
    const outside = make(); await outside.scheduler.start(); t.after(() => outside.scheduler.stop());
    await outside.scheduler.tick(); assert.equal(measurements, 1);
    time = Date.parse('2026-10-21T13:00:00Z');
    assert.equal((await outside.scheduler.tick()).status, 'done'); assert.equal(measurements, 2);
    const next = (await outside.state.read()).state;
    assert.deepEqual(Object.keys(next.runIds), ['2026-10-20', '2026-10-21']);
    assert.notEqual(next.runId, saved.runId); assert.equal(next.day, '2026-10-21');
  });
}

test('fts scheduler: overnight cutoff leaves a folder for the next opening date', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fts-overnight-cutoff-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let time = Date.parse('2026-10-20T20:59:59Z'); const now = () => time;
  const state = createFtsState({ dir, now }), indexed = [];
  const row = mailbox => ({ user: 'user@example.test', mailbox, guid: `guid-${mailbox}`, status: 'ok',
    messages: 10, indexed: indexed.includes(mailbox) ? 10 : 0, unindexed: indexed.includes(mailbox) ? 0 : 10 });
  const nightly = createFtsNightly({ state, now,
    measure: { async measureAll() { return { folders: ['A', 'B'].map(row), measuredAt: new Date(time).toISOString() }; },
      async measureFolder(user, mailbox) { return row(mailbox); } },
    doveadm: { async indexMailbox(user, mailbox) { indexed.push(mailbox); if (indexed.length === 1) time = Date.parse('2026-10-20T21:00:00Z'); } },
    audit: { async run(meta, fn) { return fn(); } } });
  const scheduler = createFtsScheduler({ config: overnight, nightly, now });
  assert.equal((await scheduler.tick()).status, 'cutoff'); assert.deepEqual(indexed, ['A']);
  assert.equal((await state.read()).state.deadline, '2026-10-20T21:00:00.000Z');
  await scheduler.tick(); assert.deepEqual(indexed, ['A']);
  time = Date.parse('2026-10-21T13:00:00Z');
  assert.equal((await scheduler.tick()).status, 'done'); assert.deepEqual(indexed, ['A', 'B']);
  const saved = (await state.read()).state;
  assert.deepEqual(Object.keys(saved.runIds), ['2026-10-20', '2026-10-21']);
  assert.equal(saved.deadline, '2026-10-21T21:00:00.000Z');
});
