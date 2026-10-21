import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createFtsState } from '../../server/admin/fts-state.js';

const current = { user: 'person@example.test', mailbox: '받은 편지함', guid: 'abc123' };
const evidence = { by: 'operator', at: '2026-10-21T01:00:00Z', reason: 'host verified idle', remoteStopped: true,
  remeasured: { messages: 10, indexedMessages: 10 }, note: 'scheduler disabled before recovery' };
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'fts-state-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = Date.parse('2026-10-20T18:00:00Z');
  return { dir, store: createFtsState({ dir, now: () => time, ...options }), setTime: value => { time = Date.parse(value); } };
}
function child(dir) {
  const code = `import {createFtsState} from ${JSON.stringify(new URL('../../server/admin/fts-state.js', import.meta.url).href)};
    const store = createFtsState({dir:process.argv[1]});
    process.send({ready:true});
    process.once('message', async () => {try {const token = await store.acquire(); process.send({token}); process.disconnect();}
      catch(error) {process.send({error:error.code || error.message}); process.exitCode=1; process.disconnect();}});`;
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  processChild.stderr.on('data', bytes => { stderr += bytes; });
  const result = new Promise((resolve, reject) => {
    processChild.once('error', reject);
    processChild.on('message', message => { if (!message.ready) resolve(message); });
    processChild.once('exit', code => { if (code) reject(new Error(stderr)); });
  });
  const ready = new Promise(resolve => processChild.once('message', resolve));
  const exited = new Promise(resolve => processChild.once('exit', resolve));
  return { process: processChild, ready, result, exited };
}

test('fts state: two actual processes racing share exactly one durable owner; dead PID and old lock never auto-unlock', { timeout: 10_000 }, async t => {
  const { dir, store } = await fixture(t);
  const children = [child(dir), child(dir)];
  t.after(() => children.forEach(value => { if (value.process.exitCode === null) value.process.kill(); }));
  await Promise.all(children.map(value => value.ready));
  children.forEach(value => value.process.send('race'));
  const results = await Promise.all(children.map(value => value.result));
  assert.equal(results.filter(value => typeof value.token === 'string').length, 1);
  assert.equal(results.filter(value => value.token === null).length, 1);
  assert.deepEqual(await Promise.all(children.map(value => value.exited)), [0, 0]);
  const [filename] = await fs.readdir(join(dir, 'lock'));
  const ownerPath = join(dir, 'lock', filename);
  const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  owner.pid = 2147483647; owner.acquiredAt = '2000-01-01T00:00:00Z';
  await fs.writeFile(ownerPath, JSON.stringify(owner));
  for (let i = 0; i < 3; i++) assert.equal(await createFtsState({ dir, now: () => Date.parse('2099-01-01') }).acquire(), null);
  assert.equal(await store.acquire(), null);
  await store.manualUnlock(evidence);
  assert.equal((await store.read()).state.unlockHistory[0].lockToken, owner.token);
  const token = await store.acquire(); assert.ok(token); await store.release(token);
});

test('fts state: KST day boundary, persisted run IDs, same-day ticks and restarts cannot create a second run', async t => {
  const f = await fixture(t);
  await f.store.acquire();
  const first = await f.store.startRun();
  assert.equal(first.day, '2026-10-21');
  await assert.rejects(f.store.startRun(), { code: 'FTS_ALREADY_RUN' });
  await f.store.save({ ...first, status: 'done', finishedAt: '2026-10-20T19:00:00Z' });
  await f.store.release();
  const restarted = createFtsState({ dir: f.dir });
  await restarted.acquire();
  await assert.rejects(restarted.startRun('2026-10-21'), { code: 'FTS_ALREADY_RUN' });
  await restarted.release();
  f.setTime('2026-10-21T14:59:59Z');
  await f.store.acquire();
  await assert.rejects(f.store.startRun(), { code: 'FTS_ALREADY_RUN' });
  f.setTime('2026-10-21T15:00:00Z');
  const next = await f.store.startRun();
  assert.equal(next.day, '2026-10-22'); assert.notEqual(next.runId, first.runId);
  await assert.rejects(f.store.startRun('2026-10-21'), { code: 'FTS_ALREADY_RUN' });
  await assert.rejects(f.store.startRun('2026-02-30'), { code: 'FTS_DAY_INVALID' });
});

test('fts state: reads are local, private files and atomic save preserve all progress across restart', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.read(), { state: null, damaged: false });
  const token = await f.store.acquire(); const state = await f.store.startRun();
  const updated = { ...state, current, folders: [
    { ...current, before: { messages: 10, indexedMessages: 0 }, after: null, result: 'running', error: null },
    { user: current.user, mailbox: 'deleted-folder', guid: null, before: null, after: null, result: 'failed', error: 'FOLDER_MISSING' },
  ] };
  await f.store.save(updated);
  assert.deepEqual((await createFtsState({ dir: f.dir }).read()).state, updated);
  assert.equal((await fs.stat(f.dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(join(f.dir, 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(join(f.dir, 'lock', `${token}.json`))).mode & 0o777, 0o600);
  assert.equal((await fs.readdir(f.dir)).filter(name => name.endsWith('.tmp')).length, 0);
  await f.store.release();
});

test('fts state: only owner can mutate or release, including an obsolete token after recovery', async t => {
  const f = await fixture(t); const oldToken = await f.store.acquire(); const state = await f.store.startRun();
  const other = createFtsState({ dir: f.dir });
  await assert.rejects(other.save(state, oldToken), { code: 'FTS_LOCK_OWNER' });
  await assert.rejects(other.release(oldToken), { code: 'FTS_LOCK_OWNER' });
  await assert.rejects(f.store.release('wrong'), { code: 'FTS_LOCK_OWNER' });
  await other.manualUnlock(evidence);
  const newToken = await other.acquire();
  await assert.rejects(f.store.release(oldToken), { code: 'FTS_LOCK_OWNER' });
  assert.ok(await fs.stat(join(f.dir, 'lock', `${newToken}.json`)));
  await other.release(newToken);
});

test('fts state: remote unknown blocks index flag and subsequent runs until durable evidence-based recovery', async t => {
  const f = await fixture(t); await f.store.acquire(); const run = await f.store.startRun();
  await f.store.save({ ...run, current });
  const unknown = await f.store.markRemoteUnknown(current);
  assert.equal(unknown.indexBlocked, true); assert.equal(unknown.status, 'unknown');
  assert.deepEqual(unknown.remoteUnknown, { user: current.user, mailbox: current.mailbox, at: run.startedAt });
  const restarted = createFtsState({ dir: f.dir });
  assert.equal((await restarted.read()).state.indexBlocked, true);
  await assert.rejects(f.store.save({ ...unknown, remoteUnknown: null, indexBlocked: false }), { code: 'FTS_REMOTE_UNKNOWN' });
  await assert.rejects(f.store.startRun('2026-10-22'), { code: 'FTS_REMOTE_UNKNOWN' });
  assert.equal((await f.store.inspectLock()).locked, true);
  for (const value of [undefined, {}, { ...evidence, remoteStopped: false }, { ...evidence, by: '' }, { ...evidence, at: 'invalid' }])
    await assert.rejects(restarted.manualUnlock(value), { code: 'FTS_UNLOCK_EVIDENCE' });
  const restored = await restarted.manualUnlock(evidence);
  assert.equal(restored.status, 'failed'); assert.equal(restored.indexBlocked, false); assert.equal(restored.current, null);
  assert.deepEqual(restored.unlockHistory[0].previousRemoteUnknown, unknown.remoteUnknown);
  assert.equal(restored.unlockHistory[0].remeasured.messages, 10);
  await restarted.acquire();
  await assert.rejects(restarted.startRun(run.day), { code: 'FTS_ALREADY_RUN' });
  assert.equal((await restarted.startRun('2026-10-22')).unlockHistory.length, 1);
});

test('fts state: truncated, wrong-schema and oversized state fail closed without overwriting evidence', async t => {
  const f = await fixture(t); await f.store.acquire();
  for (const bytes of ['{', '{}', JSON.stringify({ v: 2 }), ' '.repeat(4 * 1024 * 1024 + 1)]) {
    await fs.writeFile(join(f.dir, 'state.json'), bytes);
    assert.deepEqual(await f.store.read(), { state: null, damaged: true, code: 'FTS_STATE_CORRUPT' });
    await assert.rejects(f.store.startRun(), { code: 'FTS_STATE_CORRUPT' });
    await assert.rejects(f.store.manualUnlock(evidence), { code: 'FTS_STATE_CORRUPT' });
    assert.equal(await fs.readFile(join(f.dir, 'state.json'), 'utf8'), bytes);
    assert.equal(await createFtsState({ dir: f.dir }).acquire(), null);
  }
});

test('fts state: incomplete owner creation remains locked across restarts and allows evidence-only recovery', async t => {
  const f = await fixture(t);
  await fs.mkdir(join(f.dir, 'lock'));
  assert.equal(await f.store.acquire(), null);
  await f.store.manualUnlock(evidence);
  assert.equal((await f.store.read()).state.unlockHistory[0].lockToken, null);
  assert.ok(await f.store.acquire());
});

function faultFs(controls, events = []) {
  return { ...fs, async rename(...args) { events.push('rename'); if (controls.rename) throw new Error('rename-fault'); return fs.rename(...args); },
    async open(path, ...args) {
      const handle = await fs.open(path, ...args);
      return { stat: () => handle.stat(), read: (...values) => handle.read(...values), writeFile: (...values) => handle.writeFile(...values), close: () => handle.close(),
        async sync() { const kind = path.endsWith('.tmp') ? 'file-sync' : path.endsWith('/lock') ? 'lock-sync' : 'dir-sync'; events.push(kind);
          if (controls[kind]) throw new Error(kind); await handle.sync(); } };
    } };
}

test('fts state: file fsync precedes rename and directory fsync; failed save preserves previous state', async t => {
  const controls = {}; const events = [];
  const f = await fixture(t, { fs: faultFs(controls, events) });
  await f.store.acquire(); const run = await f.store.startRun();
  events.length = 0;
  await f.store.save({ ...run, status: 'done' });
  assert.deepEqual(events, ['file-sync', 'rename', 'dir-sync']);
  for (const kind of ['file-sync', 'rename']) {
    controls[kind] = true;
    await assert.rejects(f.store.save({ ...run, status: 'failed' }));
    assert.equal((await f.store.read()).state.status, 'done');
    assert.equal((await fs.readdir(f.dir)).filter(name => name.endsWith('.tmp')).length, 0);
    controls[kind] = false;
  }
  controls['dir-sync'] = true;
  await assert.rejects(f.store.save({ ...run, status: 'failed' }), /dir-sync/);
  assert.equal(await createFtsState({ dir: f.dir }).acquire(), null);
});

test('fts state: recovery fsync failure never removes lock; failed acquisition is never stolen', async t => {
  const controls = {};
  const f = await fixture(t, { fs: faultFs(controls) });
  await f.store.acquire(); await f.store.startRun();
  controls['file-sync'] = true;
  await assert.rejects(f.store.manualUnlock(evidence), /file-sync/);
  assert.equal(await createFtsState({ dir: f.dir }).acquire(), null);
  const other = await fixture(t, { fs: faultFs({ 'lock-sync': true }) });
  await assert.rejects(other.store.acquire(), /lock-sync/);
  assert.equal(await createFtsState({ dir: other.dir }).acquire(), null);
});


for (const status of ['running', 'failed', 'done']) for (const hasCurrent of [false, true]) {
  test(`fts state: restart marks orphan ${status}, current=${hasCurrent}, preserves lock and blocks ownership`, async t => {
    const f = await fixture(t); await f.store.acquire(); const run = await f.store.startRun();
    const original = await f.store.save({ ...run, status, current: hasCurrent ? current : null });
    const names = await fs.readdir(join(f.dir, 'lock'));
    // The live owner must never be mistaken for an orphan.
    assert.deepEqual(await f.store.markRemoteUnknown({ reason: 'restart' }), original);
    const restarted = createFtsState({ dir: f.dir });
    const marked = await restarted.markRemoteUnknown({ reason: 'restart' });
    assert.equal(marked.status, 'unknown'); assert.equal(marked.indexBlocked, true);
    assert.equal(marked.remoteUnknown.reason, 'restart');
    assert.equal(marked.remoteUnknown.user, hasCurrent ? current.user : null);
    assert.equal(marked.remoteUnknown.mailbox, hasCurrent ? current.mailbox : null);
    assert.deepEqual((await restarted.read()).state, marked);
    assert.deepEqual(await fs.readdir(join(f.dir, 'lock')), names);
    assert.equal(await restarted.acquire(), null);
    assert.deepEqual(await restarted.markRemoteUnknown({ reason: 'restart' }), marked);
    await assert.rejects(restarted.markRemoteUnknown(current), { code: 'FTS_LOCK_OWNER' });
  });
}

test('fts state: startup without leftover lock never marks a completed run unknown', async t => {
  const f = await fixture(t); await f.store.acquire(); const run = await f.store.startRun();
  const done = await f.store.save({ ...run, status: 'done' }); await f.store.release();
  const restarted = createFtsState({ dir: f.dir });
  assert.deepEqual(await restarted.markRemoteUnknown({ reason: 'restart' }), done);
});

test('fts state: restart preserves existing remote unknown evidence verbatim', async t => {
  const f = await fixture(t); await f.store.acquire(); await f.store.startRun();
  const unknown = await f.store.markRemoteUnknown(current);
  const restarted = createFtsState({ dir: f.dir });
  assert.deepEqual(await restarted.markRemoteUnknown({ reason: 'restart' }), unknown);
});

async function runningFixture(t, options = {}) {
  const f = await fixture(t, options); await f.store.acquire(); const run = await f.store.startRun();
  const before = { ...current, messages: 20001, indexed: 1, unindexed: 20000, shards: 1,
    status: 'ok', reason: null, measuredAt: run.startedAt };
  await f.store.save({ ...run, current, folders: [{ ...current, before, after: null, result: 'running', error: null }],
    snapshot: { measuredAt: run.startedAt, folders: [before], totals: { messages: 20001, indexed: 1, unindexed: 20000, unmeasured: 0, excluded: 0 }, top: [before] } });
  await f.store.markRemoteUnknown(current); // interrupted index with a durable running row
  return f;
}

for (const locked of [true, false]) test(`fts state: explicit damaged reset preserves original bytes and records evidence, lock=${locked}`, async t => {
  const f = await fixture(t); if (locked) await f.store.acquire();
  const bytes = '{synthetic-damaged-state'; await fs.writeFile(join(f.dir, 'state.json'), bytes, { mode: 0o600 });
  await assert.rejects(f.store.manualUnlock(evidence), { code: 'FTS_STATE_CORRUPT' });
  await assert.rejects(f.store.manualUnlock({ ...evidence, resetDamagedState: true, remoteStopped: false }), { code: 'FTS_UNLOCK_EVIDENCE' });
  assert.equal(await fs.readFile(join(f.dir, 'state.json'), 'utf8'), bytes);
  const restored = await f.store.manualUnlock({ ...evidence, resetDamagedState: true });
  assert.equal(restored.runId, null); assert.deepEqual(restored.runIds, {}); assert.deepEqual(restored.folders, []);
  const saved = restored.unlockHistory[0]; assert.equal(saved.resetDamagedState, true);
  assert.ok(saved.damagedBackup.startsWith('state.json.damaged-'));
  assert.equal(await fs.readFile(join(f.dir, saved.damagedBackup), 'utf8'), bytes);
  assert.equal((await f.store.read()).damaged, false); assert.equal((await f.store.inspectLock()).locked, false);
  assert.equal((await fs.stat(join(f.dir, 'state.json'))).mode & 0o777, 0o600);
});

test('fts state: release checks its owner even when state is damaged and never changes evidence', async t => {
  const f = await fixture(t); const token = await f.store.acquire();
  await fs.writeFile(join(f.dir, 'state.json'), '{');
  const other = createFtsState({ dir: f.dir });
  await assert.rejects(other.release(token), { code: 'FTS_LOCK_OWNER' });
  await f.store.release(token); assert.equal((await f.store.inspectLock()).locked, false);
  assert.equal(await fs.readFile(join(f.dir, 'state.json'), 'utf8'), '{');
});

test('fts state: damaged recovery write failure keeps the lock and the preserved source file', async t => {
  const controls = {}, f = await fixture(t, { fs: faultFs(controls) }); await f.store.acquire();
  await fs.writeFile(join(f.dir, 'state.json'), '{synthetic'); controls['file-sync'] = true;
  await assert.rejects(f.store.manualUnlock({ ...evidence, resetDamagedState: true }), /file-sync/);
  assert.equal((await f.store.inspectLock()).locked, true);
  const backups = (await fs.readdir(f.dir)).filter(name => name.startsWith('state.json.damaged-'));
  assert.equal(backups.length, 1); assert.equal(await fs.readFile(join(f.dir, backups[0]), 'utf8'), '{synthetic');
});

const remeasured = { user: current.user, mailbox: current.mailbox, messages: 20001, indexed: 20001,
  at: '2026-10-21T04:29:39Z', by: 'synthetic status + stats' };
for (const measured of [undefined, {}, { ...remeasured, mailbox: 'other' }, { ...remeasured, indexed: 20002 },
  { ...remeasured, messages: -1 }, { ...remeasured, indexed: 0.5 }, { ...remeasured, messages: Number.MAX_SAFE_INTEGER + 1 },
  { ...remeasured, at: 'invalid' }]) {
  test(`fts state: manual recovery without valid matching remeasurement excludes stale backlog ${JSON.stringify(measured)}`, async t => {
    const f = await runningFixture(t);
    const restored = await f.store.manualUnlock({ ...evidence, remeasured: measured });
    assert.equal(restored.current, null); assert.equal(restored.status, 'failed');
    assert.equal(restored.folders[0].result, 'unknown'); assert.equal(restored.folders[0].error, 'manual-unlock');
    assert.equal(restored.folders[0].after, null); assert.equal(restored.snapshot.totals.unmeasured, 1);
    assert.equal(restored.snapshot.totals.unindexed, 0); assert.deepEqual(restored.snapshot.top, []);
    assert.equal(restored.snapshot.folders[0].status, 'unmeasured'); assert.equal(restored.snapshot.folders[0].messages, null);
  });
}

for (const indexed of [20001, 10001]) test(`fts state: matching VM-shaped remeasurement updates totals/top with indexed=${indexed} but retains unknown run outcome`, async t => {
  const f = await runningFixture(t);
  const restored = await f.store.manualUnlock({ ...evidence, remeasured: { ...remeasured, indexed } });
  assert.equal(restored.folders[0].result, 'unknown'); assert.equal(restored.folders[0].error, 'manual-unlock');
  assert.equal(restored.folders[0].after.guid, current.guid); assert.equal(restored.folders[0].after.measuredAt, remeasured.at);
  assert.equal(restored.folders[0].after.unindexed, 20001 - indexed);
  assert.equal(restored.snapshot.totals.unmeasured, 0); assert.equal(restored.snapshot.totals.unindexed, 20001 - indexed);
  assert.equal(restored.snapshot.top.length, indexed === 20001 ? 0 : 1);
  assert.equal(restored.snapshot.measuredAt, remeasured.at); assert.equal(restored.status, 'failed');
});

function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('../../bin/fts-unlock.js', import.meta.url).pathname, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('fts recovery CLI: preview never mutates, flags are required, confirmed recovery hides private tokens', async t => {
  const f = await runningFixture(t), bytes = await fs.readFile(join(f.dir, 'state.json'), 'utf8');
  const [tokenFile] = await fs.readdir(join(f.dir, 'lock'));
  const args = ['--state-dir', f.dir, '--by', 'operator', '--reason', 'synthetic remote idle', '--remote-stopped'];
  const preview = await cli(args); assert.equal(preview.code, 2); assert.match(preview.stderr, /CLI_CONFIRM_REQUIRED/);
  assert.equal(JSON.parse(preview.stdout).locked, true); assert.equal(JSON.parse(preview.stdout).current.mailbox, current.mailbox);
  assert.equal(await fs.readFile(join(f.dir, 'state.json'), 'utf8'), bytes);
  for (const missing of ['--by', '--reason', '--remote-stopped']) {
    const values = args.filter((value, index) => value !== missing && args[index - 1] !== missing);
    const result = await cli([...values, '--yes']); assert.equal(result.code, 2); assert.match(result.stderr, /CLI_EVIDENCE_REQUIRED/);
    assert.equal((await f.store.inspectLock()).locked, true);
  }
  const result = await cli([...args, '--yes']); assert.equal(result.code, 0, result.stderr);
  const [before, after] = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(before.locked, true); assert.equal(after.ok, true); assert.equal(after.locked, false); assert.equal(after.status, 'failed');
  for (const value of [f.dir, tokenFile, tokenFile.slice(0, -5), 'unlockHistory":[' ]) assert.ok(!result.stdout.includes(value));
  assert.equal((await f.store.read()).state.snapshot.totals.unmeasured, 1);
});

test('fts recovery CLI: damaged reset is explicit, preserves bytes, and sanitizes malformed inputs and IO errors', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.dir, 'state.json'), '{synthetic-private');
  const args = ['--state-dir', f.dir, '--by', 'operator', '--reason', 'synthetic damaged state', '--remote-stopped', '--yes'];
  assert.equal((await cli(args)).code, 2);
  const result = await cli([...args, '--reset-damaged']); assert.equal(result.code, 0, result.stderr);
  const backup = (await f.store.read()).state.unlockHistory[0].damagedBackup;
  assert.equal(await fs.readFile(join(f.dir, backup), 'utf8'), '{synthetic-private');
  for (const bad of [['--unknown'], ['--by'], ['--yes', '--yes'], ['--state-dir', join(f.dir, 'state.json')]]) {
    const result = await cli(bad); assert.equal(result.code, 2); assert.ok(!result.stderr.includes(f.dir));
    assert.ok(!result.stderr.includes('synthetic-private'));
  }
  const help = await cli(['--help']); assert.equal(help.code, 0); assert.match(help.stdout, /시험용/);
});
