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
  await assert.rejects(f.store.release(), { code: 'FTS_REMOTE_UNKNOWN' });
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
  await assert.rejects(f.store.release(), { code: 'FTS_REMOTE_UNKNOWN' });
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
