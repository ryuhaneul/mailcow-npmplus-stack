import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFtsNightly } from '../../server/admin/services/fts-nightly.js';
import { createFtsMeasure } from '../../server/admin/services/fts-measure.js';
import { createFtsState } from '../../server/admin/fts-state.js';
import { createAudit } from '../../server/admin/audit.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { AppError } from '../../server/errors.js';

const start = Date.parse('2026-10-20T18:00:00Z'); // 03:00 KST on October 21
const end = Date.parse('2026-10-20T21:00:00Z');
const row = (mailbox, unindexed = 10, extra = {}) => ({ user: 'user@example.test', mailbox,
  guid: `guid-${mailbox}`, messages: 100, indexed: 100 - unindexed, unindexed, status: 'ok', reason: null, ...extra });
const fault = code => new AppError(502, code, 'synthetic-private-error-cookie-password-body');
async function fixture(t, folders = [row('INBOX')]) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'fts-nightly-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = start, active = 0, maximum = 0;
  const events = [], warnings = [], indexed = new Set();
  const now = () => time;
  const state = createFtsState({ dir: join(dir, 'state'), now });
  const audit = createAudit({ dir: join(dir, 'audit'), now });
  const history = createHistoryService({ audit, lock: createResourceLock() });
  const measure = {
    async measureAll() {
      events.push('all');
      return { measuredAt: new Date(time).toISOString(), folders: structuredClone(folders),
        totals: { messages: 100, indexed: 0, unindexed: 100, unmeasured: 0, excluded: 0 }, top: folders.slice(0, 20) };
    },
    async measureFolder(user, mailbox) {
      events.push(`measure:${mailbox}`);
      assert.equal(user, 'user@example.test');
      return structuredClone(indexed.has(mailbox) ? { ...folders.find(row => row.mailbox === mailbox), indexed: 100, unindexed: 0 } : folders.find(row => row.mailbox === mailbox));
    },
  };
  const doveadm = { async indexMailbox(user, mailbox) {
    assert.equal(user, 'user@example.test');
    events.push(`index:${mailbox}`); active++; maximum = Math.max(maximum, active);
    const { rows } = await audit.read();
    assert.equal(rows[0].phase, 'intent');
    const saved = (await state.read()).state;
    assert.equal(saved.current.mailbox, mailbox); assert.equal(saved.status, 'running');
    await Promise.resolve(); indexed.add(mailbox); active--;
  } };
  const deps = { state, measure, doveadm, audit, history, now, logger: { warn: value => warnings.push(value) } };
  return { dir, state, audit, history, deps, events, warnings, indexed, folders,
    setTime(value) { time = value; }, getMaximum: () => maximum,
    run: () => createFtsNightly(deps).runOnce({ deadline: end }) };
}

test('fts nightly: indexes only backlog, largest first, serially with before/after measures and durable current', async t => {
  const f = await fixture(t, [row('small', 2), row('empty', 0), row('big', 90),
    row('trash', null, { status: 'excluded', reason: 'trash', messages: null, indexed: null }),
    row('unknown', null, { status: 'unmeasured', reason: 'stats', messages: null, indexed: null })]);
  const result = await f.run();
  assert.equal(result.status, 'failed'); // unknown measurement remains visible
  assert.equal(f.getMaximum(), 1);
  assert.deepEqual(f.events, ['all', 'measure:big', 'index:big', 'measure:big', 'measure:small', 'index:small', 'measure:small']);
  assert.equal(result.state.folders[0].before.unindexed, 2);
  assert.equal(result.state.folders[0].after.unindexed, 0);
  assert.equal(result.state.folders[4].before.messages, null);
  assert.equal((await f.state.read()).state.status, 'failed');
  assert.ok(await f.state.acquire()); await f.state.release();
});

test('fts nightly: success records irreversible intent/result and specific history label without revert', async t => {
  const f = await fixture(t); const result = await f.run();
  assert.equal(result.status, 'done'); assert.deepEqual(result.warnings, []);
  assert.equal(result.state.current, null);
  assert.equal(result.state.day, '2026-10-21');
  const record = (await f.history.list()).items[0];
  assert.equal(record.action, 'fts.nightly'); assert.equal(record.kind, 'irreversible');
  assert.equal(record.canRevert, false); assert.match(record.summary, /검색 색인을 정리했어요/);
  assert.equal(record.result, 'ok'); assert.equal(record.detail.processed, 1);
});

test('fts nightly: all-zero/excluded snapshot starts zero indexes', async t => {
  const f = await fixture(t, [row('zero', 0), row('junk', 10, { status: 'excluded', reason: 'junk' })]);
  assert.equal((await f.run()).status, 'done'); assert.deepEqual(f.events, ['all']);
});

test('fts nightly: premeasure zero or exclusion skips index and GUID replacement is failed safely', async t => {
  const f = await fixture(t, [row('zero'), row('changed'), row('excluded')]);
  f.deps.measure.measureFolder = async (user, mailbox) => row(mailbox, 0,
    mailbox === 'changed' ? { guid: 'replacement' } : mailbox === 'excluded' ? { status: 'excluded', reason: 'shared' } : {});
  const result = await f.run();
  assert.equal(result.status, 'failed'); assert.equal(f.indexed.size, 0);
  assert.equal(result.state.folders.find(row => row.mailbox === 'changed').error, 'FTS_FOLDER_CHANGED');
});

test('fts nightly: folder rejection is saved and next folder still runs, errors contain safe codes only', async t => {
  const f = await fixture(t, [row('first', 20), row('second')]);
  const index = f.deps.doveadm.indexMailbox;
  f.deps.doveadm.indexMailbox = async (...args) => {
    if (args[1] === 'first') throw fault('DOVEADM_REJECTED');
    return index(...args);
  };
  const result = await f.run();
  assert.equal(result.status, 'failed'); assert.equal(result.state.folders[0].error, 'DOVEADM_REJECTED');
  assert.ok(f.indexed.has('second'));
  assert.ok(!JSON.stringify(result).includes('synthetic-private'));
});

test('fts nightly: before and after measurement exceptions are isolated per folder', async t => {
  const f = await fixture(t, [row('before', 30), row('after', 20), row('last')]);
  const measure = f.deps.measure.measureFolder;
  f.deps.measure.measureFolder = async (user, mailbox) => {
    if (mailbox === 'before' || mailbox === 'after' && f.indexed.has(mailbox)) throw new Error('synthetic-private');
    return measure(user, mailbox);
  };
  const result = await f.run();
  assert.equal(result.status, 'failed'); assert.ok(f.indexed.has('last'));
  assert.equal(result.state.folders[0].error, 'INTERNAL_ERROR');
  assert.equal(result.state.folders[1].error, 'INTERNAL_ERROR');
  assert.equal(result.state.current, null);
});

test('fts nightly: postmeasure GUID mismatch or unmeasured never reports folder completion', async t => {
  const f = await fixture(t, [row('changed', 20), row('unknown')]);
  const measure = f.deps.measure.measureFolder;
  f.deps.measure.measureFolder = async (user, mailbox) => {
    const value = await measure(user, mailbox);
    return !f.indexed.has(mailbox) ? value : mailbox === 'changed' ? { ...value, guid: 'replacement' } :
      { ...value, status: 'unmeasured', messages: null, indexed: null, unindexed: null };
  };
  const result = await f.run();
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.state.folders.map(row => row.error), ['FTS_FOLDER_CHANGED', 'FTS_MEASURE_FAILED']);
});

test('fts nightly: remote unknown stops immediately, persists marker and lock, restart starts zero indexes', async t => {
  const f = await fixture(t, [row('first', 20), row('next')]);
  f.deps.doveadm.indexMailbox = async () => { f.events.push('unknown-index'); throw fault('DOVEADM_INDEX_UNKNOWN'); };
  const result = await f.run();
  assert.equal(result.status, 'unknown'); assert.equal(result.state.indexBlocked, true);
  assert.equal(result.state.current.mailbox, 'first');
  assert.deepEqual(f.events, ['all', 'measure:first', 'unknown-index']);
  assert.equal((await f.state.read()).state.remoteUnknown.mailbox, 'first');
  const restarted = createFtsState({ dir: join(f.dir, 'state') });
  assert.equal(await restarted.acquire(), null);
  assert.equal((await f.run()).status, 'busy');
});

test('fts nightly: markRemoteUnknown persistence failure still retains durable current and stops', async t => {
  const f = await fixture(t, [row('first', 20), row('next')]);
  f.deps.state = { ...f.state, markRemoteUnknown: async () => { throw new Error('private'); } };
  f.deps.doveadm.indexMailbox = async () => { throw fault('DOVEADM_INDEX_UNKNOWN'); };
  const result = await f.run();
  assert.equal(result.status, 'unknown'); assert.equal(result.warnings[0].stage, 'remoteUnknown');
  assert.equal((await f.state.read()).state.indexBlocked, true);
  assert.equal(await f.state.acquire(), null);
});

test('fts nightly: durable indexBlocked is checked immediately before every index', async t => {
  const f = await fixture(t, [row('first', 20), row('next')]);
  const measure = f.deps.measure.measureFolder;
  f.deps.measure.measureFolder = async (user, mailbox) => {
    const value = await measure(user, mailbox);
    if (mailbox === 'next') await f.state.markRemoteUnknown(value);
    return value;
  };
  const result = await f.run();
  assert.equal(result.status, 'unknown'); assert.deepEqual([...f.indexed], ['first']);
  assert.equal(await f.state.acquire(), null);
});

for (const phase of ['all', 'before', 'save', 'read']) {
  test(`fts nightly: deadline reached during ${phase} starts no new index`, async t => {
    const f = await fixture(t);
    if (phase === 'all') {
      const all = f.deps.measure.measureAll;
      f.deps.measure.measureAll = async () => { const value = await all(); f.setTime(end); return value; };
    } else if (phase === 'before') {
      const measure = f.deps.measure.measureFolder;
      f.deps.measure.measureFolder = async (...args) => { const value = await measure(...args); f.setTime(end); return value; };
    } else if (phase === 'save') {
      f.deps.state = { ...f.state, async save(value, token) {
        const saved = await f.state.save(value, token); if (value.current) f.setTime(end); return saved;
      } };
    } else {
      f.deps.state = { ...f.state, async read() {
        const value = await f.state.read(); if (value.state?.current) f.setTime(end); return value;
      } };
    }
    const result = await f.run();
    assert.equal(result.status, 'cutoff'); assert.equal(f.indexed.size, 0);
    assert.equal(result.state.current, null); assert.equal(result.state.folders[0].result, 'pending');
  });
}

test('fts nightly: running folder finishes past 06:00, saves after measurement, next folder remains pending', async t => {
  const f = await fixture(t, [row('first', 20), row('next')]);
  const index = f.deps.doveadm.indexMailbox;
  f.deps.doveadm.indexMailbox = async (...args) => { await index(...args); f.setTime(end + 1000); };
  const result = await f.run();
  assert.equal(result.status, 'cutoff'); assert.equal(result.state.current, null);
  assert.deepEqual(f.events, ['all', 'measure:first', 'index:first', 'measure:first']);
  assert.equal(result.state.folders[0].after.unindexed, 0);
  assert.equal(result.state.folders[1].result, 'pending');
  assert.equal((await f.history.list()).items[0].result, 'partial');
});

test('fts nightly: next day remeasures unfinished first and processes them before larger new folders; deduplicates snapshot', async t => {
  const f = await fixture(t, [row('first', 90), row('pending', 2), row('failed', 3)]);
  await f.state.acquire(); const previous = await f.state.startRun('2026-10-20');
  await f.state.save({ ...previous, status: 'cutoff', folders: ['pending', 'failed'].map(mailbox => ({
    user: 'user@example.test', mailbox, guid: `guid-${mailbox}`, before: null, after: null,
    result: mailbox === 'failed' ? 'failed' : 'pending', error: null,
  })) });
  await f.state.release();
  f.folders.push(row('pending', 2));
  const result = await f.run();
  assert.equal(result.status, 'done');
  assert.deepEqual(f.events.slice(0, 3), ['measure:pending', 'measure:failed', 'all']);
  assert.deepEqual(f.events.filter(event => event.startsWith('index:')), ['index:failed', 'index:pending', 'index:first']);
  assert.equal(result.state.folders.length, 3);
});

test('fts nightly: positive backlog after index is retained for next day without retry in same run', async t => {
  const f = await fixture(t);
  f.deps.measure.measureFolder = async () => row('INBOX', 4);
  assert.equal((await f.run()).state.folders[0].after.unindexed, 4);
  assert.equal(f.events.filter(event => event.startsWith('index:')).length, 1);
  assert.equal((await f.run()).status, 'failed'); // same day is never resumed automatically
  assert.equal(f.events.filter(event => event.startsWith('index:')).length, 1);
  f.setTime(start + 86_400_000);
  await createFtsNightly(f.deps).runOnce({ deadline: end + 86_400_000 });
  assert.equal(f.events.filter(event => event.startsWith('index:')).length, 2);
});

function auditFs(failAt) {
  let syncs = 0;
  return { ...fs, async open(...args) {
    const handle = await fs.open(...args);
    return { chmod: (...args) => handle.chmod(...args), stat: () => handle.stat(), read: (...args) => handle.read(...args),
      writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(),
      async sync() { if (++syncs === failAt) throw new Error('synthetic-private'); await handle.sync(); } };
  } };
}
for (const phase of ['intent', 'result']) {
  test(`fts nightly: real audit ${phase} fsync failure is visible and never hidden as complete`, async t => {
    const f = await fixture(t);
    f.deps.audit = createAudit({ dir: join(f.dir, 'audit'), now: f.deps.now, fs: auditFs(phase === 'intent' ? 1 : 2) });
    const result = await f.run();
    assert.equal(result.status, 'failed');
    assert.equal(f.indexed.size, phase === 'intent' ? 0 : 1);
    assert.equal((await f.state.read()).state.status, 'failed');
    assert.equal(result.warnings[0].code, phase === 'intent' ? 'AUDIT_UNAVAILABLE' : 'AUDIT_RESULT_UNAVAILABLE');
    assert.ok(!JSON.stringify(result.warnings).includes('synthetic-private'));
  });
}

for (const phase of ['before', 'after']) {
  test(`fts nightly: state save failure ${phase} index blocks subsequent work and warns`, async t => {
    const f = await fixture(t, [row('first', 20), row('next')]);
    f.deps.state = { ...f.state, async save(value, token) {
      if (phase === 'before' ? Boolean(value.current) : f.indexed.size > 0) throw new Error('synthetic-private');
      return f.state.save(value, token);
    } };
    const result = await f.run();
    assert.equal(result.status, 'failed'); assert.equal(f.indexed.size, phase === 'before' ? 0 : 1);
    assert.ok(result.warnings.some(row => row.stage === 'state'));
    const token = await f.state.acquire();
    if (phase === 'before') { assert.ok(token); await f.state.release(token); }
    else assert.equal(token, null);
  });
}

test('fts nightly: concurrent invocations return busy without measurement, duplicate day and corrupt state fail closed', async t => {
  const f = await fixture(t);
  let resume; const gate = new Promise(resolve => { resume = resolve; });
  const all = f.deps.measure.measureAll;
  let entered; const waiting = new Promise(resolve => { entered = resolve; });
  f.deps.measure.measureAll = async () => { entered(); await gate; return all(); };
  const running = f.run(); await waiting;
  assert.equal((await f.run()).status, 'busy'); resume(); assert.equal((await running).status, 'done');
  assert.equal((await f.run()).status, 'failed'); assert.equal(f.indexed.size, 1);
  await fs.writeFile(join(f.dir, 'state', 'state.json'), '{');
  assert.equal((await f.run()).status, 'failed'); assert.equal(f.indexed.size, 1);
});

test('fts nightly: invalid deadline is rejected before acquiring a lock', async t => {
  const f = await fixture(t);
  const runner = createFtsNightly(f.deps);
  for (const value of [undefined, null, '06:00', Infinity])
    await assert.rejects(runner.runOnce({ deadline: value }), { code: 'FTS_DEADLINE_INVALID' });
  assert.ok(await f.state.acquire()); await f.state.release();
});

test('fts nightly: next day handles previously zero/excluded folders and prioritizes unmeasured folders safely', async t => {
  const f = await fixture(t, [row('zero', 0), row('excluded', 0, { status: 'excluded', reason: 'junk' }),
    row('unknown', null, { status: 'unmeasured', guid: null, indexed: null, messages: null })]);
  assert.equal((await f.run()).status, 'failed');
  f.events.length = 0;
  f.folders[2] = row('unknown', 2);
  f.folders.push(row('new', 90));
  f.setTime(start + 86_400_000);
  const result = await createFtsNightly(f.deps).runOnce({ deadline: end + 86_400_000 });
  assert.equal(result.status, 'done');
  assert.deepEqual(f.events.filter(event => event.startsWith('index:')), ['index:unknown', 'index:new']);
  assert.equal(f.events[0], 'measure:unknown');
});


test('fts nightly: initial snapshot save failure releases the lock before any remote work', async t => {
  const f = await fixture(t);
  f.deps.state = { ...f.state, async save() { throw new Error('synthetic-private'); } };
  const result = await f.run();
  assert.equal(result.status, 'failed'); assert.equal(f.indexed.size, 0);
  assert.ok(result.warnings.some(row => row.stage === 'state'));
  assert.ok(await f.state.acquire()); await f.state.release();
});

test('fts nightly: aborted before run starts no folders and releases lock as cutoff', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  const result = await createFtsNightly(f.deps).runOnce({ deadline: end, signal: controller.signal });
  assert.equal(result.status, 'cutoff'); assert.equal(f.indexed.size, 0);
  assert.equal((await f.state.read()).state.status, 'cutoff');
  assert.ok(await f.state.acquire()); await f.state.release();
});

test('fts nightly: shutdown during remote index lets it finish and starts zero next folders', async t => {
  const f = await fixture(t, [row('first', 20), row('next')]); const controller = new AbortController();
  const index = f.deps.doveadm.indexMailbox;
  f.deps.doveadm.indexMailbox = async (...args) => {
    controller.abort(); await index(...args); // no signal is forwarded to the remote operation
  };
  const result = await createFtsNightly(f.deps).runOnce({ deadline: end, signal: controller.signal });
  assert.equal(result.status, 'cutoff'); assert.deepEqual([...f.indexed], ['first']);
  assert.equal(result.state.folders[0].result, 'done'); assert.equal(result.state.folders[1].result, 'pending');
  assert.ok(await f.state.acquire()); await f.state.release();
});

test('fts nightly: shutdown while saving current blocks index at the final start check', async t => {
  const f = await fixture(t); const controller = new AbortController(); const save = f.state.save;
  f.state.save = async (...args) => { const saved = await save(...args); if (saved.current) controller.abort(); return saved; };
  const result = await createFtsNightly(f.deps).runOnce({ deadline: end, signal: controller.signal });
  assert.equal(result.status, 'cutoff'); assert.equal(f.indexed.size, 0);
  assert.equal(result.state.current, null); assert.equal(result.state.folders[0].result, 'pending');
});

test('fts nightly: shutdown does not release remote unknown lock', async t => {
  const f = await fixture(t, [row('first', 20), row('next')]); const controller = new AbortController();
  f.deps.doveadm.indexMailbox = async () => { controller.abort(); throw fault('DOVEADM_INDEX_UNKNOWN'); };
  const result = await createFtsNightly(f.deps).runOnce({ deadline: end, signal: controller.signal });
  assert.equal(result.status, 'unknown'); assert.equal(await f.state.acquire(), null);
  assert.equal(result.state.indexBlocked, true); assert.equal(f.indexed.size, 0);
});


test('fts nightly: failed account folder list remains durable while healthy account indexes', async t => {
  const f = await fixture(t);
  const guid = 'a'.repeat(32);
  f.deps.measure = createFtsMeasure({ now: f.deps.now, doveadm: {
    async listUsers() { return ['bad@example.test', 'user@example.test']; },
    async call(_command, { user }) { if (user === 'bad@example.test') throw new Error('synthetic'); return [{ mailbox: 'INBOX' }]; },
    async specialUse() { return [{ value: '' }]; },
    async mailboxStatus() { return [{ mailbox: 'INBOX', guid, messages: 100 }]; },
    async ftsStats() { return [{ mailbox: 'INBOX', guid, messages: f.indexed.size ? 100 : 90, shards: 3 }]; },
  } });
  const result = await f.run();
  assert.equal(result.status, 'failed'); assert.deepEqual([...f.indexed], ['INBOX']);
  const saved = (await f.state.read()).state;
  assert.equal(saved.folders[0].mailbox, null); assert.equal(saved.folders[0].result, 'unmeasured');
  assert.equal(saved.snapshot.totals.unmeasured, 1); assert.equal(saved.snapshot.totals.unindexed, 0);
  assert.deepEqual(saved.snapshot.top, []); assert.equal(saved.folders[1].after.shards, 3);
  assert.equal(saved.folders[1].after.measuredAt, new Date(start).toISOString());
  assert.equal(saved.current, null); assert.ok(await f.state.acquire()); await f.state.release();
});

test('fts nightly: each completed folder updates durable totals/top using after or latest before', async t => {
  const f = await fixture(t, [row('first', 30), row('second', 20), row('third', 10)]);
  const save = f.state.save, snapshots = [];
  f.state.save = async (...args) => { const saved = await save(...args); snapshots.push(structuredClone(saved)); return saved; };
  const measure = f.deps.measure.measureFolder;
  f.deps.measure.measureFolder = async (user, mailbox) => {
    const value = await measure(user, mailbox);
    return mailbox === 'second' && f.indexed.has(mailbox) ? { ...value, status: 'unmeasured', messages: null, indexed: null, unindexed: null } : value;
  };
  const result = await f.run();
  const afterFirst = snapshots.find(state => state.folders[0].result === 'done' && state.folders[1].result === 'pending');
  assert.equal(afterFirst.snapshot.totals.unindexed, 30);
  assert.deepEqual(afterFirst.snapshot.top.map(row => row.mailbox), ['second', 'third']);
  assert.equal(result.state.snapshot.totals.unindexed, 0);
  assert.equal(result.state.snapshot.totals.unmeasured, 1);
  assert.deepEqual(result.state.snapshot.top, []);
  assert.equal(result.state.status, 'failed');
});

for (const stop of ['deadline', 'signal']) test(`fts nightly: real full measurement ${stop} stops before next folder, indexes zero and persists cutoff`, async t => {
  const f = await fixture(t), controller = new AbortController(), calls = [];
  const guid = 'b'.repeat(32);
  f.deps.measure = createFtsMeasure({ now: f.deps.now, doveadm: {
    async listUsers() { return ['user@example.test']; },
    async call() { return ['A', 'B', 'C'].map(mailbox => ({ mailbox })); },
    async specialUse(user, mailbox) { calls.push(mailbox); return [{ value: '' }]; },
    async mailboxStatus(user, mailbox) { return [{ mailbox, guid, messages: 100 }]; },
    async ftsStats(user, mailbox) {
      if (stop === 'deadline') f.setTime(end); else controller.abort();
      return [{ mailbox, guid, messages: 0, shards: 2 }];
    },
  } });
  const result = await createFtsNightly(f.deps).runOnce({ deadline: end, signal: controller.signal });
  assert.equal(result.status, 'cutoff'); assert.equal(f.indexed.size, 0);
  assert.deepEqual(calls, ['A']); assert.equal(result.state.snapshot.incomplete, true);
  assert.equal(result.state.folders.length, 1); assert.equal(result.state.folders[0].result, 'pending');
  assert.equal((await f.state.read()).state.status, 'cutoff');
  assert.ok(await f.state.acquire()); await f.state.release();
});

test('fts nightly: damaged state fails before any lock acquisition or remote work', async t => {
  const f = await fixture(t); await fs.mkdir(join(f.dir, 'state'));
  const bytes = '{synthetic-corrupt'; await fs.writeFile(join(f.dir, 'state', 'state.json'), bytes);
  f.deps.state = { ...f.state, async acquire() { assert.fail('must not acquire a lock for damaged state'); } };
  const result = await f.run(); assert.equal(result.status, 'failed'); assert.equal(result.state, null);
  assert.equal(result.warnings[0].code, 'FTS_STATE_CORRUPT'); assert.deepEqual(f.events, []);
  assert.equal((await f.state.inspectLock()).locked, false);
  assert.equal(await fs.readFile(join(f.dir, 'state', 'state.json'), 'utf8'), bytes);
});

test('fts nightly: damage appearing after preflight releases only its own lock', async t => {
  const f = await fixture(t), acquire = f.state.acquire;
  f.state.acquire = async () => { const token = await acquire(); await fs.writeFile(join(f.dir, 'state', 'state.json'), '{'); return token; };
  const result = await f.run(); assert.equal(result.status, 'failed'); assert.deepEqual(f.events, []);
  assert.equal((await f.state.inspectLock()).locked, false); assert.equal((await f.state.read()).damaged, true);
});

test('fts nightly: uninitialized flatcurve databases are indexed, empty folders are skipped without failures', async t => {
  const f = await fixture(t), indexes = [];
  f.deps.measure = createFtsMeasure({ now: f.deps.now, doveadm: {
    async listUsers() { return ['user@example.test']; },
    async call() { return ['Archive', 'Imported'].map(mailbox => ({ mailbox })); },
    async specialUse() { return [{ value: '' }]; },
    async mailboxStatus(user, mailbox) { return [{ mailbox, guid: (mailbox === 'Archive' ? 'a' : 'b').repeat(32), messages: mailbox === 'Archive' ? 0 : 20000 }]; },
    async ftsStats(user, mailbox) { return indexes.includes(mailbox) ? [{ mailbox, guid: 'b'.repeat(32), messages: 20000, shards: 5 }] : []; },
  } });
  f.deps.doveadm.indexMailbox = async (user, mailbox) => { indexes.push(mailbox); };
  const result = await f.run(); assert.equal(result.status, 'done'); assert.deepEqual(indexes, ['Imported']);
  assert.equal(result.state.snapshot.totals.unmeasured, 0); assert.equal(result.state.snapshot.totals.unindexed, 0);
  assert.equal(result.state.folders[0].before.indexed, 0); assert.equal(result.state.folders[1].after.shards, 5);
});
