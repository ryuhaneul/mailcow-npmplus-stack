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
