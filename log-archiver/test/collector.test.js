import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../store.js';
import { openCollector } from '../collector.js';
import { createSources, discoverSources, parseRecord, SOURCE_NAMES, MAX_LINE_BYTES } from '../sources.js';

const stamp = '2026-10-21T08:00:00.123456789Z';
const json = (text, time = stamp) => Buffer.from(`${JSON.stringify({ log: `${text}\n`, stream: 'stdout', time })}\n`);
const access = (text) => Buffer.from(`2001:db8::1 - - [21/Oct/2026:17:00:00 +0900] "GET /${text} HTTP/1.1" 200 1\n`);
const digest = (raw) => createHash('sha256').update(raw).digest('hex');
const id = (value) => value.repeat(64);

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-collector-'));
  const dockerRoot = path.join(root, 'containers');
  const npmplusRoot = path.join(root, 'npmplus');
  await fs.mkdir(dockerRoot);
  await fs.mkdir(path.join(npmplusRoot, 'nginx/logs'), { recursive: true });
  const storeRoot = path.join(root, 'archive');
  let store = await openStore({ root: storeRoot, onDelete: () => {} });
  let collector;
  const collectorOptions = { dockerRoot, npmplusRoot, now: () => new Date('2026-10-21T09:00:00Z'), requiredSources: ['postfix'], ...options };
  const restart = async () => {
    if (collector) await collector.close();
    if (collector) { await store.close(); store = await openStore({ root: storeRoot, onDelete: () => {} }); }
    collector = await openCollector({ store, ...collectorOptions });
    return collector;
  };
  await restart();
  t.after(async () => { await collector.close(); await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, dockerRoot, npmplusRoot, accessFile: path.join(npmplusRoot, 'nginx/logs/access.log'), restart,
    get store() { return store; }, get collector() { return collector; } };
}
async function container(f, instance = id('a'), { source = 'postfix', project = 'mailcowdockerized', name, driver = 'json-file' } = {}) {
  const service = ['webmail', 'webmail-admin'].includes(source) ? source : `${source}-mailcow`;
  const dir = path.join(f.dockerRoot, instance);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.v2.json'), JSON.stringify({ ID: instance, Name: name ?? `/${project}-${service}-1`, Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service }, Env: ['SECRET=synthetic-do-not-persist'] }, LogConfig: { Type: driver } }));
  const file = path.join(dir, `${instance}-json.log`);
  return file;
}
async function output(f, source) {
  const snapshot = await f.store.snapshot();
  const pieces = [];
  for (const entry of snapshot.catalog.hours.filter((item) => !source || item.source === source)) pieces.push(gunzipSync(await fs.readFile(path.join(f.store.root, entry.file))));
  return Buffer.concat(pieces);
}
const lines = (buffer) => buffer.toString().split('\n').slice(0, -1).sort();

test('eight exact source contracts, config name + project + service; unrelated logs never read', async (t) => {
  const f = await fixture(t, { requiredSources: SOURCE_NAMES });
  assert.deepEqual(new Set(createSources().map((item) => item.source)), new Set(SOURCE_NAMES));
  await fs.writeFile(await container(f), json('yes'));
  await fs.writeFile(await container(f, id('b'), { project: 'other' }), json('no-other-project'));
  await fs.writeFile(await container(f, id('c'), { name: '/prefix-mailcowdockerized-postfix-mailcow-1' }), json('no-substring'));
  await fs.writeFile(await container(f, id('d'), { source: 'webmail', project: 'webmail', name: '/webmail' }), json('app'));
  await fs.writeFile(await container(f, id('e'), { source: 'dovecot', driver: 'local' }), json('no-driver'));
  await fs.writeFile(f.accessFile, access('yes'));
  await fs.writeFile(`${f.accessFile}.gz`, 'not-access');
  const found = await discoverSources(createSources(f));
  assert.equal(found.files.length, 3);
  assert.equal(found.issues[0].reason, 'logging-driver-mismatch');
  const result = await f.collector.collect();
  assert.equal(result.collected, 3);
  assert.equal(JSON.stringify(result).includes('synthetic-do-not-persist'), false);
  assert.equal(lines(await output(f)).some((line) => line.includes('no-')), false);
  const sources = createSources({ mailcowProject: 'custom', webmailProject: 'custom-app' });
  assert.equal(sources.find((item) => item.source === 'postfix').project, 'custom');
});

test('partial physical lines, identical messages, nanoseconds, out-of-order times and restart', async (t) => {
  const f = await fixture(t);
  const file = await container(f);
  const first = json('한글 a@example.test 2001:db8::1');
  const second = json('same', '2026-10-21T07:59:59Z');
  const partial = json('partial');
  await fs.writeFile(file, Buffer.concat([first, second, second, partial.subarray(0, 15)]));
  const before = digest(await fs.readFile(file));
  await f.collector.collect();
  const state = await f.collector.status();
  assert.equal(state.generations[0].offset, first.length + second.length * 2);
  assert.equal(state.backfillComplete, false);
  assert.equal(digest(await fs.readFile(file)), before);
  await f.restart();
  await fs.appendFile(file, partial.subarray(15));
  await f.collector.collect();
  await f.collector.collect();
  assert.deepEqual(lines(await output(f)), lines(Buffer.concat([first, second, second, partial])));
  const { catalog } = await f.store.snapshot();
  assert.equal(catalog.hours.find((item) => item.hour.includes('T08:')).maxTime, stamp);
  assert.equal((await f.collector.status()).backfillComplete, true);
});

test('rename, multiple Docker rotations, old/new container IDs coexist, open unlinked fd is drained', async (t) => {
  const f = await fixture(t);
  const file = await container(f);
  const a = json('old-a'); const b = json('old-b'); const c = json('old-c'); const d = json('new-id');
  await fs.writeFile(file, a);
  await f.collector.collect();
  await fs.appendFile(file, b);
  await fs.rename(file, `${file}.1`);
  await fs.writeFile(file, c);
  await fs.writeFile(await container(f, id('b')), d);
  await f.collector.collect();
  await fs.rename(`${file}.1`, `${file}.2`);
  await fs.rename(file, `${file}.1`);
  const e = json('next'); await fs.writeFile(file, e);
  await f.restart();
  await f.collector.collect();
  const extra = json('pinned-before-unlink');
  await fs.appendFile(`${file}.2`, extra);
  await fs.unlink(`${file}.2`);
  await f.collector.collect();
  assert.deepEqual(lines(await output(f)), lines(Buffer.concat([a, b, c, d, e, extra])));
});

test('copytruncate follows residual copy and starts new active generation without duplicates, including restart', async (t) => {
  const f = await fixture(t, { requiredSources: ['npmplus'] });
  const a = access('a'); const b = access('b'); const c = access('c');
  await fs.writeFile(f.accessFile, a);
  await f.collector.collect();
  await fs.appendFile(f.accessFile, b);
  await fs.copyFile(f.accessFile, `${f.accessFile}.1`);
  await fs.truncate(f.accessFile, 0);
  await fs.appendFile(f.accessFile, c);
  await f.restart();
  await f.collector.collect();
  await f.collector.collect();
  assert.deepEqual(lines(await output(f)), lines(Buffer.concat([a, b, c])));
  const { checkpoint } = await f.store.snapshot();
  const gaps = Object.values(checkpoint.generations).flatMap((item) => item.gaps ?? []);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, 'copytruncate-window');
  assert.deepEqual(Object.keys(gaps[0]).sort(), ['source', 'generation', 'reason', 'start', 'end', 'fromOffset', 'toOffset', 'unknownLines'].sort());
  assert.equal(gaps[0].unknownLines, true);
});

test('fast regrowth and missing copy yield persistent gap, never silently skip new prefix', async (t) => {
  const f = await fixture(t, { requiredSources: ['npmplus'] });
  const old = access('old'); const replacement = Buffer.concat([access('new'), access('new')]);
  await fs.writeFile(f.accessFile, old);
  await f.collector.collect();
  await fs.truncate(f.accessFile, 0);
  await fs.appendFile(f.accessFile, replacement);
  await f.collector.collect();
  await f.restart();
  await f.collector.collect();
  assert.deepEqual(lines(await output(f)), lines(Buffer.concat([old, replacement])));
  assert.equal((await f.collector.status()).gaps[0].reason, 'source-truncated-or-rewritten');
});

test('unrecoverable source removal records gap; unknown time preserves raw bytes', async (t) => {
  const f = await fixture(t);
  const file = await container(f);
  const invalid = Buffer.from('invalid JSON synthetic\r\n');
  const unknown = json('invalid-time', 'nonsense');
  await fs.writeFile(file, Buffer.concat([invalid, unknown]));
  await f.collector.collect();
  await f.restart();
  await fs.rm(path.dirname(file), { recursive: true });
  await f.collector.collect();
  const state = await f.collector.status();
  assert.ok(state.gaps.some((gap) => gap.reason === 'source-disappeared'));
  assert.ok(state.gaps.some((gap) => gap.reason === 'unparseable-record-time'));
  assert.deepEqual(await output(f), Buffer.concat([invalid, unknown]));
  assert.equal((await f.store.snapshot()).catalog.hours[0].unknownTimeCount, 2);
});

test('initial backfill is bounded and resumes only from committed complete-line offsets', async (t) => {
  const f = await fixture(t, { maxBatchBytes: 150 });
  const file = await container(f);
  const expected = Buffer.concat(Array.from({ length: 20 }, (_, index) => json(`batch-${index}`)));
  await fs.writeFile(file, expected);
  let result = await f.collector.collect();
  assert.ok(result.collected > 0 && result.collected < 20);
  await f.restart();
  for (let count = 0; count < 30 && !(await f.collector.status()).backfillComplete; count++) result = await f.collector.collect();
  assert.equal(result.status.backfillComplete, true);
  assert.deepEqual(await output(f), expected);
});

test('policy backfill advances checkpoints over expired source bytes, preserving allowed lines', async (t) => {
  const f = await fixture(t, { requiredSources: ['nginx'] });
  const file = await container(f, id('a'), { source: 'nginx' });
  const old = json('expired', '2026-10-19T08:00:00Z'); const current = json('current');
  await fs.writeFile(file, Buffer.concat([old, current]));
  await f.collector.collect();
  await f.restart();
  await f.collector.collect();
  assert.deepEqual(await output(f), current);
  assert.equal((await f.collector.status()).generations[0].offset, old.length + current.length);
});

test('failed publication cannot advance durable checkpoint or allow a collector retry', async (t) => {
  const f = await fixture(t);
  const file = await container(f); await fs.writeFile(file, json('retry'));
  const commit = f.store.commit.bind(f.store);
  f.store.commit = async () => { throw new Error('synthetic ENOSPC'); };
  await assert.rejects(f.collector.collect(), /synthetic ENOSPC/);
  assert.deepEqual((await f.store.snapshot()).checkpoint.generations, {});
  await assert.rejects(f.collector.collect(), /requires recovery/);
  f.store.commit = commit;
  await f.restart();
  await f.collector.collect();
  assert.deepEqual(await output(f), json('retry'));
});

test('100,000 synthetic lines: exact bytes/multiplicity through rotations and restart', async (t) => {
  const f = await fixture(t);
  const file = await container(f);
  const rows = Array.from({ length: 100000 }, (_, index) => json(`test-marker-${Math.floor(index / 2)} 한글 a@example.test 2001:db8::1`, index % 3 ? stamp : '2026-10-21T07:59:59Z'));
  await fs.writeFile(`${file}.2`, Buffer.concat(rows.slice(0, 30000)));
  await fs.writeFile(`${file}.1`, Buffer.concat(rows.slice(30000, 60000)));
  await fs.writeFile(file, Buffer.concat(rows.slice(60000)));
  await f.collector.collect();
  await f.restart();
  for (let count = 0; count < 20; count++) { await f.collector.collect(); if ((await f.collector.status()).backfillComplete) break; }
  assert.equal((await f.collector.status()).backfillComplete, true);
  assert.deepEqual(lines(await output(f)), lines(Buffer.concat(rows)));
  await f.collector.collect();
  assert.equal((await f.store.snapshot()).catalog.hours.reduce((sum, item) => sum + item.lineCount, 0), 100000);
});

test('time parsing respects NPM timezone and rejects invalid calendar/time values', () => {
  assert.equal(parseRecord(access('time'), 'access').eventTime, '2026-10-21T08:00:00.000Z');
  assert.equal(parseRecord(json('nano'), 'docker').eventTime, stamp);
  assert.equal(parseRecord(json('bad', '2026-02-30T00:00:00Z'), 'docker').eventTime, null);
  assert.equal(parseRecord(Buffer.from('x [21/Noo/2026:17:00:00 +0900]\n'), 'access').valid, false);
});


test('requiredSources gates backfill and excludes disabled sources from collection', async (t) => {
  const f = await fixture(t, { requiredSources: ['postfix', 'webmail-admin'] });
  await fs.writeFile(await container(f), json('enabled'));
  await fs.writeFile(f.accessFile, access('disabled'));
  await f.collector.collect();
  const state = await f.collector.status();
  assert.equal(state.backfillComplete, false);
  assert.ok(state.issues.some((item) => item.source === 'webmail-admin' && item.reason === 'source-unavailable'));
  assert.deepEqual(await output(f), json('enabled'));
});

test('fully drained historical rotation removal leaves a tombstone without false gaps', async (t) => {
  const f = await fixture(t);
  const file = await container(f);
  await fs.writeFile(`${file}.1`, json('historical'));
  await fs.writeFile(file, json('active'));
  await f.collector.collect();
  await f.restart();
  await fs.unlink(`${file}.1`);
  await f.collector.collect();
  assert.equal((await f.collector.status()).gaps.length, 0);
  const checkpoints = Object.values((await f.store.snapshot()).checkpoint.generations);
  assert.equal(checkpoints.filter((item) => item.closed).length, 1);
});

test('hostconfig driver detection uses only allowlisted container metadata', async (t) => {
  const f = await fixture(t);
  const file = await container(f);
  await fs.writeFile(file, json('local-driver-must-not-be-collected'));
  await fs.writeFile(path.join(path.dirname(file), 'hostconfig.json'), JSON.stringify({ LogConfig: { Type: 'local' }, syntheticSecret: 'hostconfig-secret-do-not-persist' }));
  const state = (await f.collector.collect()).status;
  assert.equal(state.backfillComplete, false);
  assert.ok(state.issues.some((item) => item.reason === 'logging-driver-mismatch'));
  assert.ok(state.gaps.some((item) => item.reason === 'logging-driver-mismatch'));
  assert.equal((await output(f)).length, 0);
  assert.equal(JSON.stringify(await f.store.snapshot()).includes('hostconfig-secret-do-not-persist'), false);
});

test('read error keeps committed offset, records gap, and resumes without duplicates', async (t) => {
  const f = await fixture(t);
  const file = await container(f);
  const first = json('before-eio'); const second = json('after-eio');
  await fs.writeFile(file, first);
  await f.collector.collect();
  await fs.appendFile(file, second);
  const probe = await fs.open(file, 'r');
  const inode = (await probe.stat()).ino;
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.read;
  prototype.read = async function (...args) {
    if ((await this.stat()).ino === inode) throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
    return original.apply(this, args);
  };
  try {
    const result = await f.collector.collect();
    assert.equal(result.status.backfillComplete, false);
    assert.equal(result.status.generations[0].offset, first.length);
    assert.ok(result.status.gaps.some((gap) => gap.reason === 'source-read-error'));
  } finally { prototype.read = original; }
  await f.collector.collect();
  assert.deepEqual(await output(f), Buffer.concat([first, second]));
});

test('truncation during a read rolls back that batch; the next poll recovers the new generation', async (t) => {
  const f = await fixture(t);
  const file = await container(f);
  const original = json('before-racing-truncate');
  const replacement = json('after-racing-truncate');
  await fs.writeFile(file, original);
  const probe = await fs.open(file, 'r');
  const inode = (await probe.stat()).ino;
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = prototype.read;
  let replaced = false;
  prototype.read = async function (...args) {
    const result = await read.apply(this, args);
    if (!replaced && result.bytesRead > 0 && (await this.stat()).ino === inode) {
      replaced = true;
      await fs.writeFile(file, replacement);
    }
    return result;
  };
  try {
    const result = await f.collector.collect();
    assert.equal(result.collected, 0);
    assert.equal(result.status.generations[0].offset, 0);
    assert.ok(result.status.gaps.some((gap) => gap.reason === 'source-changed-during-read'));
  } finally { prototype.read = read; }
  await f.collector.collect();
  assert.deepEqual(await output(f), replacement);
});

test('concurrent polls serialize against the committed checkpoint', async (t) => {
  const f = await fixture(t);
  const file = await container(f);
  const expected = Buffer.concat([json('concurrent'), json('concurrent')]);
  await fs.writeFile(file, expected);
  const results = await Promise.all([f.collector.collect(), f.collector.collect(), f.collector.collect()]);
  assert.equal(results.reduce((sum, item) => sum + item.collected, 0), 2);
  assert.deepEqual(await output(f), expected);
});


test('1 MiB physical line boundary preserves raw Docker/access bytes and rejects the next byte', async (t) => {
  const f = await fixture(t, { requiredSources: ['postfix', 'npmplus'] });
  const dockerFile = await container(f);
  for (const [file, makeLine, source, kind] of [[dockerFile, json, 'postfix', 'docker'], [f.accessFile, access, 'npmplus', 'access']]) {
    const allowed = makeLine('x'.repeat(MAX_LINE_BYTES - makeLine('').length));
    const oversized = makeLine('x'.repeat(MAX_LINE_BYTES + 1 - makeLine('').length));
    const after = makeLine('after-boundary');
    assert.equal(allowed.length, MAX_LINE_BYTES);
    assert.equal(oversized.length, MAX_LINE_BYTES + 1);
    assert.equal(parseRecord(allowed, kind).valid, true);
    assert.equal(parseRecord(oversized, kind).valid, false);
    await fs.writeFile(file, Buffer.concat([allowed, oversized, after]));
    const result = await f.collector.collect();
    assert.deepEqual(await output(f, source), Buffer.concat([allowed, after]));
    const generation = result.status.generations.find((item) => item.source === source);
    assert.equal(generation.offset, allowed.length + oversized.length + after.length);
    const gaps = result.status.gaps.filter((item) => item.source === source);
    assert.equal(gaps.length, 1);
    assert.deepEqual(gaps[0], { source, generation: generation.generation, reason: 'line-too-long', start: result.status.observedAt,
      end: result.status.observedAt, fromOffset: allowed.length, toOffset: allowed.length + oversized.length, unknownLines: true });
  }
});

test('unfinished oversized line advances offsets and extends one gap across batches and restart', async (t) => {
  const f = await fixture(t, { maxBatchBytes: 128 * 1024 });
  const file = await container(f);
  const first = json('before-unfinished');
  const last = json('after-unfinished');
  const oversizedBytes = 2 * MAX_LINE_BYTES + 37;
  await fs.writeFile(file, Buffer.concat([first, Buffer.alloc(oversizedBytes, 120)]));
  let result;
  for (let poll = 0; poll < 20; poll++) {
    result = await f.collector.collect();
    if (result.status.generations[0].offset === first.length + oversizedBytes) break;
  }
  assert.equal(result.status.generations[0].offset, first.length + oversizedBytes);
  assert.equal(result.status.gaps.length, 1);
  assert.equal(result.status.gaps[0].fromOffset, first.length);
  assert.equal(result.status.gaps[0].toOffset, first.length + oversizedBytes);
  assert.deepEqual(await output(f), first);
  await f.restart();
  await f.collector.collect();
  await fs.appendFile(file, Buffer.concat([Buffer.from('tail\r\n'), last]));
  result = await f.collector.collect();
  assert.equal(result.status.generations[0].offset, (await fs.stat(file)).size);
  assert.equal(result.status.gaps.length, 1);
  assert.equal(result.status.gaps[0].toOffset, first.length + oversizedBytes + 6);
  assert.equal(result.status.gaps[0].reason, 'line-too-long');
  assert.deepEqual(await output(f), Buffer.concat([first, last]));
  await f.restart();
  await f.collector.collect();
  assert.equal((await f.collector.status()).gaps.length, 1);
  assert.deepEqual(await output(f), Buffer.concat([first, last]));
});

test('64 MiB physical line stays below 256 MiB peak RSS with one gap and exact surrounding lines/offset', async (t) => {
  // Isolate RSS from other tests, especially the existing 100,000-line fixture.
  if (process.env.LAG3_LARGE_LINE_CHILD !== '1') {
    const env = { ...process.env, LAG3_LARGE_LINE_CHILD: '1' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^64 MiB physical line', fileURLToPath(import.meta.url)], {
      env, encoding: 'utf8', timeout: 30000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const measurement = child.stdout.match(/peak RSS \d+(?:\.\d+)? MiB;[^\n]+/);
    assert.ok(measurement, child.stdout + child.stderr);
    t.diagnostic(measurement[0]);
    return;
  }
  const f = await fixture(t);
  const file = await container(f);
  const before = json('before-64-MiB');
  const after = json('after-64-MiB');
  const physicalBytes = 64 * 1024 * 1024;
  const prefix = Buffer.from('{"log":"');
  const suffix = Buffer.from(`","stream":"stdout","time":"${stamp}"}\n`);
  const chunk = Buffer.alloc(64 * 1024, 120);
  const handle = await fs.open(file, 'w');
  try {
    await handle.write(before);
    await handle.write(prefix);
    let remaining = physicalBytes - prefix.length - suffix.length;
    while (remaining > 0) {
      const size = Math.min(remaining, chunk.length);
      await handle.write(chunk.subarray(0, size));
      remaining -= size;
    }
    await handle.write(suffix);
    await handle.write(after);
  } finally { await handle.close(); }
  let result;
  let collected = 0;
  for (let poll = 0; poll < 20; poll++) {
    result = await f.collector.collect();
    collected += result.collected;
    if (result.status.backfillComplete) break;
  }
  const totalBytes = before.length + physicalBytes + after.length;
  assert.equal(collected, 2);
  assert.equal(result.status.backfillComplete, true);
  assert.equal(result.status.generations[0].offset, totalBytes);
  assert.equal((await fs.stat(file)).size, totalBytes);
  assert.deepEqual(await output(f), Buffer.concat([before, after]));
  assert.equal(result.status.gaps.length, 1);
  const gap = result.status.gaps[0];
  assert.equal(gap.reason, 'line-too-long');
  assert.equal(gap.fromOffset, before.length);
  assert.equal(gap.toOffset, before.length + physicalBytes);
  assert.equal(gap.unknownLines, true);
  await f.restart();
  assert.equal((await f.collector.collect()).collected, 0);
  assert.deepEqual(await output(f), Buffer.concat([before, after]));
  assert.equal((await f.collector.status()).gaps.length, 1);
  const peakRssKiB = process.resourceUsage().maxRSS;
  t.diagnostic(`peak RSS ${(peakRssKiB / 1024).toFixed(1)} MiB; discarded ${physicalBytes} bytes; offset ${totalBytes}; gaps 1`);
  assert.ok(peakRssKiB < 256 * 1024, `peak RSS ${peakRssKiB} KiB exceeds 256 MiB`);
});
