import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { openStore, DEFAULT_RETENTION } from '../store.js';

const moduleUrl = new URL('../store.js', import.meta.url).href;
const stamp = '2026-10-21T08:00:00.123456789Z';
const row = (text, eventTime = stamp, source = 'postfix') => ({ source, raw: Buffer.from(`${text}\n`), eventTime, observedAt: '2026-10-21T10:20:30.000Z' });

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-store-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await openStore({ root: path.join(dir, 'archive'), onDelete: () => {}, ...options });
  t.after(() => store.close());
  return { dir, store, root: store.root };
}

async function contents(store) {
  const { catalog } = await store.snapshot();
  const rows = [];
  for (const entry of catalog.hours) {
    const raw = await fs.readFile(path.join(store.root, entry.file));
    assert.equal(raw.length, entry.compressedBytes);
    rows.push(...gunzipSync(raw).toString('utf8').split('\n').slice(0, -1));
  }
  return rows.sort();
}

async function child(script, env = {}) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, STORE_MODULE: moduleUrl, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', (chunk) => { output += chunk; });
  const result = await new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code, signal) => resolve({ code, signal, output }));
  });
  return result;
}

// Intercept real filesystem writes, including atomicJson's temporary-file writes
// and rename, so initialization crashes do not depend on transaction fault hooks.
const crashInitializer = `
  import { syncBuiltinESMExports } from 'node:module';
  import fs from 'node:fs/promises';
  import path from 'node:path';
  const steps = [];
  function step(label) {
    steps.push(label);
    if (steps.length === Number(process.env.CRASH_STEP)) process.kill(process.pid, 'SIGKILL');
  }
  const label = (file) => path.relative(process.env.ARCHIVE_ROOT, String(file)).replace(/\\.[^/.]+\\.tmp$/, '.tmp');
  for (const method of ['mkdir', 'chmod', 'rename']) {
    const original = fs[method];
    fs[method] = async (...args) => {
      const name = method + ':' + label(method === 'rename' ? args[1] : args[0]);
      step('before:' + name);
      const result = await original(...args);
      step('after:' + name);
      return result;
    };
  }
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const name = label(args[0]);
    if (args[1] === 'wx') step('before:open:' + name);
    const handle = await originalOpen(...args);
    if (args[1] === 'wx') step('after:open:' + name);
    for (const method of ['writeFile', 'sync']) {
      const original = handle[method].bind(handle);
      handle[method] = async (...values) => {
        step('before:' + method + ':' + name);
        if (method === 'writeFile' && name === process.env.CRASH_PARTIAL) {
          const bytes = Buffer.from(values[0]);
          await handle.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
          process.kill(process.pid, 'SIGKILL');
        }
        const result = await original(...values);
        step('after:' + method + ':' + name);
        return result;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  const {openStore} = await import(process.env.STORE_MODULE);
  const store = await openStore({root: process.env.ARCHIVE_ROOT});
  await store.close();
  console.log(JSON.stringify(steps));
`;

test('SIGKILL at every initial filesystem write recovers an empty archive without manual cleanup', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-init-crash-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const baseline = await child(crashInitializer, { ARCHIVE_ROOT: path.join(dir, 'baseline') });
  assert.equal(baseline.code, 0, baseline.output);
  const steps = JSON.parse(baseline.output);
  assert.ok(steps.includes('after:rename:state/catalog.json'));
  assert.ok(steps.includes('after:rename:state/checkpoint.json'));
  const cases = steps.map((name, index) => ({ name, CRASH_STEP: String(index + 1) }));
  for (const file of ['catalog', 'checkpoint']) cases.push({ name: `partial ${file} temporary write`, CRASH_PARTIAL: `state/${file}.json.tmp` });
  for (const [index, crash] of cases.entries()) {
    await t.test(crash.name, async () => {
      const root = path.join(dir, String(index));
      const result = await child(crashInitializer, { ARCHIVE_ROOT: root, ...crash });
      assert.equal(result.signal, 'SIGKILL', result.output);
      for (let reopen = 0; reopen < 2; reopen++) {
        const store = await openStore({ root });
        try {
          assert.deepEqual(await store.snapshot(), {
            transactionId: '0',
            catalog: { version: 1, transactionId: '0', hours: [] },
            checkpoint: { version: 1, transactionId: '0', generations: {} },
          });
          if (reopen === 1) {
            await store.commit({ records: [row('after recovered initialization')], checkpoints: { g: { offset: 31 } } });
            assert.deepEqual(await contents(store), ['after recovered initialization']);
          }
        } finally { await store.close(); }
      }
    });
  }
});

test('missing checkpoint only completes a pristine initial catalog without pending or data', async (t) => {
  const initial = { version: 1, transactionId: '0', hours: [] };
  for (const change of [
    { catalog: { ...initial, transactionId: 'previous-commit' } },
    { catalog: { ...initial, version: 2 } },
    { catalog: { ...initial, hours: [{ source: 'postfix' }] } },
    { data: true },
    { pending: true },
  ]) {
    const { store, root } = await fixture(t);
    await store.close();
    const catalog = JSON.stringify(change.catalog ?? initial);
    await fs.writeFile(path.join(root, 'state/catalog.json'), catalog);
    await fs.unlink(path.join(root, 'state/checkpoint.json'));
    if (change.data) await fs.mkdir(path.join(root, 'data'));
    if (change.pending) await fs.writeFile(path.join(root, 'state/pending.json'), '{}');
    await assert.rejects(openStore({ root }), { code: 'ARCHIVE_RECOVERY_FAILED' });
    assert.equal(await fs.readFile(path.join(root, 'state/catalog.json'), 'utf8'), catalog);
    await assert.rejects(fs.stat(path.join(root, 'state/checkpoint.json')), { code: 'ENOENT' });
  }
});

test('raw bytes, identical lines, nanosecond times, late hours and bounded members', async (t) => {
  const { store, root } = await fixture(t, { memberBytes: 80 });
  const records = [row('한글 같은 줄\r'), row('한글 같은 줄\r'), row('reversed', '2026-10-21T08:00:00.000000001Z'), row('other hour', '2026-10-21T07:00:00Z'), row('unparseable', null)];
  const result = await store.commit({ records, checkpoints: { 'dev:inode:g1': { offset: 456, fingerprint: 'synthetic-fingerprint' } } });
  assert.equal(result.transactionId, result.checkpoint.transactionId);
  assert.equal(result.catalog.transactionId, result.transactionId);
  assert.equal(result.checkpoint.generations['dev:inode:g1'].fingerprint, 'synthetic-fingerprint');
  assert.deepEqual(await contents(store), records.map((record) => record.raw.toString().slice(0, -1)).sort());
  const hour = result.catalog.hours.find((entry) => entry.hour.includes('T08:'));
  assert.equal(hour.minTime, '2026-10-21T08:00:00.000000001Z');
  assert.equal(hour.maxTime, stamp);
  const unknown = result.catalog.hours.find((entry) => entry.hour.includes('T10:'));
  assert.equal(unknown.unknownTimeCount, 1);
  assert.equal(unknown.minTime, records.at(-1).observedAt);
  for (const entry of result.catalog.hours) {
    const index = await store.readIndex(entry);
    const compressed = await fs.readFile(path.join(root, entry.file));
    let next = 0;
    for (const member of index.members) {
      assert.equal(member.start, next);
      next = member.end;
      const raw = gunzipSync(compressed.subarray(member.start, member.end));
      assert.equal(raw.length, member.uncompressedBytes);
      assert.ok(raw.length <= 80);
      assert.equal(raw.toString().split('\n').length - 1, member.lineCount);
    }
    assert.equal(next, entry.compressedBytes);
    assert.equal((await fs.stat(path.join(root, entry.file))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(path.join(root, entry.file)))).mode & 0o777, 0o700);
  }
  assert.equal((await fs.stat(path.join(root, 'state/checkpoint.json'))).mode & 0o777, 0o600);
  const frozen = await store.snapshot();
  frozen.checkpoint.generations['dev:inode:g1'].offset = 99999;
  assert.equal((await store.snapshot()).checkpoint.generations['dev:inode:g1'].offset, 456);
});

test('100,000 synthetic physical JSON lines retain exact multiplicity and original bytes', async (t) => {
  const { store } = await fixture(t);
  const records = Array.from({ length: 100000 }, (_, index) => row(JSON.stringify({ time: stamp, stream: index % 2 ? 'stderr' : 'stdout', log: `합성 ${index % 1000} a@example.test 2001:db8::1\n` })));
  await store.commit({ records, checkpoints: { synthetic: { offset: records.reduce((sum, item) => sum + item.raw.length, 0) } } });
  assert.deepEqual(await contents(store), records.map((item) => item.raw.toString().slice(0, -1)).sort());
  const snapshot = await store.snapshot();
  const index = await store.readIndex(snapshot.catalog.hours[0]);
  assert.ok(index.members.length > 1);
  assert.ok(index.members.every((member) => member.uncompressedBytes <= 1048576));
});

test('oversize physical line gets its own streaming gzip member without byte changes', async (t) => {
  const { store, root } = await fixture(t);
  const records = [row('prefix'), row('x'.repeat(2 * 1024 * 1024)), row('suffix')];
  const result = await store.commit({ records });
  const entry = result.catalog.hours[0];
  const index = await store.readIndex(entry);
  assert.equal(index.members.length, 3);
  assert.equal(index.members[1].lineCount, 1);
  assert.equal(index.members[1].uncompressedBytes, records[1].raw.length);
  assert.deepEqual(gunzipSync(await fs.readFile(path.join(root, entry.file))), Buffer.concat(records.map((record) => record.raw)));
});

test('snapshot index remains bounded after later append; publication waits for commit', async (t) => {
  let block;
  let arrived;
  const reached = new Promise((resolve) => { arrived = resolve; });
  const { store } = await fixture(t);
  await store.commit({ records: [row('first')] });
  const first = await store.snapshot();
  const oldIndex = await store.readIndex(first.catalog.hours[0]);
  store.fault = async (point) => {
    if (point === 'afterCatalog') { arrived(); await new Promise((resolve) => { block = resolve; }); }
  };
  const writing = store.commit({ records: [row('second')] });
  await reached;
  let visible = false;
  const snapshot = store.snapshot().then((value) => { visible = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(visible, false);
  block();
  await writing;
  const current = await snapshot;
  assert.equal(current.catalog.hours[0].lineCount, 2);
  assert.deepEqual(await store.readIndex(first.catalog.hours[0]), oldIndex);
});

const crashWriter = `
  import fs from 'node:fs/promises';
  const {openStore} = await import(process.env.STORE_MODULE);
  const store = await openStore({root:process.env.ARCHIVE_ROOT, onDelete:()=>{}, fault:async(point)=>{if(point===process.env.CRASH_POINT)process.kill(process.pid,'SIGKILL');}});
  const snap=await store.snapshot();
  const source=await fs.readFile(process.env.SOURCE_FILE);
  const offset=snap.checkpoint.generations.g?.offset??0;
  const records=source.subarray(offset).toString().split('\\n').slice(0,-1).map(raw=>({source:'postfix',raw:Buffer.from(raw+'\\n'),eventTime:JSON.parse(raw).time}));
  await store.commit({records,checkpoints:{g:{offset:source.length,fingerprint:'source-still-present'}}});
  await store.close();
`;

for (const point of ['beforePending', 'afterPending', 'appendPartial', 'afterAppendSync', 'afterIndex', 'afterCatalog', 'beforeCheckpoint', 'afterCheckpoint', 'beforePendingRemove', 'afterPendingRemove']) {
  test(`SIGKILL at ${point}: recovery and original replay lose/duplicate zero lines`, async (t) => {
    const { dir, root, store } = await fixture(t);
    const texts = [
      JSON.stringify({ time: stamp, log: 'original baseline' }),
      JSON.stringify({ time: stamp, log: 'identical 정상 줄' }),
      JSON.stringify({ time: stamp, log: 'identical 정상 줄' }),
      JSON.stringify({ time: '2026-10-21T09:00:00Z', log: 'new output file' }),
    ];
    const source = Buffer.from(`${texts.join('\n')}\n`);
    const sourceFile = path.join(dir, 'synthetic-original.log');
    await fs.writeFile(sourceFile, source);
    const hash = createHash('sha256').update(source).digest('hex');
    await store.commit({ records: [row(texts[0])], checkpoints: { g: { offset: Buffer.byteLength(`${texts[0]}\n`), fingerprint: 'source-still-present' } } });
    await store.close();
    const result = await child(crashWriter, { ARCHIVE_ROOT: root, SOURCE_FILE: sourceFile, CRASH_POINT: point });
    assert.equal(result.signal, 'SIGKILL', result.output);
    const recovered = await openStore({ root, onDelete: () => {} });
    const committed = ['afterCheckpoint', 'beforePendingRemove', 'afterPendingRemove'].includes(point);
    assert.equal((await contents(recovered)).length, committed ? 4 : 1);
    await recovered.close();
    const replayed = await child(crashWriter, { ARCHIVE_ROOT: root, SOURCE_FILE: sourceFile, CRASH_POINT: 'never' });
    assert.equal(replayed.code, 0, replayed.output);
    const final = await openStore({ root, onDelete: () => {} });
    try {
      assert.deepEqual(await contents(final), texts.sort());
      assert.equal((await final.snapshot()).checkpoint.generations.g.offset, source.length);
      await assert.rejects(fs.stat(path.join(root, 'state/pending.json')), { code: 'ENOENT' });
    } finally { await final.close(); }
    assert.equal(createHash('sha256').update(await fs.readFile(sourceFile)).digest('hex'), hash);
  });
}

test('actual gzip ENOSPC and atomic JSON rename failures do not advance checkpoint', async (t) => {
  for (const target of ['gzip', 'catalog.json', 'checkpoint.json']) {
    const { store, root } = await fixture(t);
    await store.commit({ records: [row('baseline')], checkpoints: { g: { offset: 9 } } });
    const originalOpen = fs.open;
    const originalRename = fs.rename;
    const code = target === 'gzip' ? 'ENOSPC' : 'EIO';
    let failed = false;
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (target === 'gzip' && String(args[0]).endsWith('.log.gz') && args[1] === 'r+') {
        const originalWrite = handle.write.bind(handle);
        let writes = 0;
        handle.write = async (...writeArgs) => {
          if (++writes === 2) { failed = true; throw Object.assign(new Error('synthetic filesystem full'), { code }); }
          return originalWrite(...writeArgs);
        };
      }
      return handle;
    };
    fs.rename = async (...args) => {
      if (String(args[1]) === path.join(root, 'state', target)) {
        failed = true;
        throw Object.assign(new Error('synthetic filesystem I/O failure'), { code });
      }
      return originalRename(...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(store.commit({ records: [row('next')], checkpoints: { g: { offset: 14 } } }), { code });
      assert.equal(failed, true);
    } finally {
      fs.open = originalOpen;
      fs.rename = originalRename;
      syncBuiltinESMExports();
    }
    const checkpoint = JSON.parse(await fs.readFile(path.join(root, 'state/checkpoint.json')));
    assert.equal(checkpoint.generations.g.offset, 9);
    await store.close();
    const recovered = await openStore({ root, onDelete: () => {} });
    assert.deepEqual(await contents(recovered), ['baseline']);
    await recovered.close();
  }
});

test('committed corruption is a recovery failure rather than successful collection', async (t) => {
  const { store, root } = await fixture(t);
  store.fault = async (point) => { if (point === 'afterCheckpoint') throw new Error('synthetic crash'); };
  await assert.rejects(store.commit({ records: [row('committed with pending')] }));
  await store.close();
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'state/catalog.json')));
  const file = path.join(root, catalog.hours[0].file);
  const bytes = await fs.readFile(file);
  bytes[bytes.length - 8] ^= 255; // CRC damage, keeping committed length unchanged.
  await fs.writeFile(file, bytes);
  await assert.rejects(openStore({ root }), { code: 'ARCHIVE_RECOVERY_FAILED' });
  assert.ok(await fs.stat(path.join(root, 'state/pending.json')));
});

test('damaged checkpoint never restarts collection from offset zero', async (t) => {
  const { store, root } = await fixture(t);
  await store.commit({ records: [row('preserved')], checkpoints: { g: { offset: 10 } } });
  await store.close();
  const before = await fs.readFile(path.join(root, (await readCatalog(root)).hours[0].file));
  await fs.writeFile(path.join(root, 'state/checkpoint.json'), '{broken');
  await assert.rejects(openStore({ root }), { code: 'ARCHIVE_RECOVERY_FAILED' });
  assert.deepEqual(await fs.readFile(path.join(root, (await readCatalog(root)).hours[0].file)), before);
});

test('missing checkpoint/catalog never resets an existing archive to zero', async (t) => {
  const { store, root } = await fixture(t);
  await store.commit({ records: [row('must not reset')], checkpoints: { g: { offset: 15 } } });
  await store.close();
  const entry = (await readCatalog(root)).hours[0];
  const before = await fs.readFile(path.join(root, entry.file));
  await fs.unlink(path.join(root, 'state/checkpoint.json'));
  await fs.unlink(path.join(root, 'state/catalog.json'));
  await assert.rejects(openStore({ root }), { code: 'ARCHIVE_RECOVERY_FAILED' });
  assert.deepEqual(await fs.readFile(path.join(root, entry.file)), before);
});

async function readCatalog(root) { return JSON.parse(await fs.readFile(path.join(root, 'state/catalog.json'))); }

test('policy expiration uses each source maximum timestamp; checkpoint remains after deletion', async (t) => {
  const deleted = [];
  const { store } = await fixture(t, { onDelete: (entry) => deleted.push(`${entry.source}/${entry.hour}`) });
  const now = new Date('2026-10-21T12:00:00Z');
  const records = [];
  for (const [source, days] of Object.entries(DEFAULT_RETENTION)) {
    records.push(row(`${source} expired`, new Date(+now - days * 86400000 - 3600000).toISOString(), source));
    records.push(row(`${source} keep`, new Date(+now - days * 86400000 + 3600000).toISOString(), source));
  }
  await store.commit({ records, checkpoints: { g: { offset: 1234, fingerprint: 'keep-input-position' } } });
  const snapshot = await store.snapshot();
  const oldEntry = snapshot.catalog.hours.find((entry) => entry.source === 'postfix' && entry.minTime < new Date(+now - 90 * 86400000).toISOString());
  const result = await store.expire({ now });
  assert.equal(result.deleted.length, 8);
  assert.equal(deleted.length, 8);
  assert.equal(new Set(deleted).size, 8);
  assert.equal((await store.snapshot()).checkpoint.generations.g.offset, 1234);
  assert.equal((await store.expire({ now })).deleted.length, 0);
  assert.equal(deleted.length, 8);
  assert.deepEqual(await contents(store), Object.keys(DEFAULT_RETENTION).map((source) => `${source} keep`).sort());
  await assert.rejects(store.readIndex(oldEntry), { code: 'ARCHIVE_SNAPSHOT_EXPIRED' });
});

test('retention override and late timestamp prevent premature whole-hour deletion', async (t) => {
  const { store } = await fixture(t, { retention: { postfix: 2 } });
  assert.equal(store.retention.dovecot, 90);
  await store.commit({ records: [row('early', '2026-10-19T08:01:00Z'), row('late', '2026-10-19T08:59:00Z')] });
  assert.equal((await store.expire({ now: '2026-10-21T08:30:00Z' })).deleted.length, 0);
  assert.equal((await store.expire({ now: '2026-10-21T09:00:00Z' })).deleted.length, 1);
});

test('retention rejects unknown names, zero, fractional, negative and infinite days', async (t) => {
  const { root } = await fixture(t);
  for (const retention of [{ 'npmplus-access': 90 }, { postfix: 0 }, { postfix: 1.5 }, { postfix: -1 }, { postfix: Infinity }]) {
    await assert.rejects(openStore({ root, retention }), TypeError);
  }
});

test('recreated hour has a new fileId and expires the original snapshot', async (t) => {
  const { store } = await fixture(t, { retention: { postfix: 2 } });
  const first = await store.commit({ records: [row('first event', '2026-10-19T08:01:00Z')] });
  const oldEntry = first.catalog.hours[0];
  await store.expire({ now: '2026-10-21T08:30:00Z' });
  const second = await store.commit({ records: [row('late arriving event'.repeat(100), '2026-10-19T08:59:00Z')] });
  assert.equal(second.catalog.hours[0].file, oldEntry.file);
  assert.notEqual(second.catalog.hours[0].fileId, oldEntry.fileId);
  await assert.rejects(store.readIndex(oldEntry), { code: 'ARCHIVE_SNAPSHOT_EXPIRED' });
});

for (const point of ['deleteAfterPending', 'deleteAfterCatalog', 'deleteAfterUnlink', 'beforePendingRemove', 'afterPendingRemove']) {
  test(`SIGKILL at ${point}: expiration completes idempotently and retains input cursor`, async (t) => {
    const { store, root, dir } = await fixture(t);
    const source = path.join(dir, 'original.log');
    await fs.writeFile(source, 'expired\nkeep\n');
    await store.commit({ records: [row('expired', '2026-01-01T00:00:00Z'), row('keep')], checkpoints: { g: { offset: 13 } } });
    await store.close();
    const result = await child(`
      const {openStore}=await import(process.env.STORE_MODULE);
      const s=await openStore({root:process.env.ARCHIVE_ROOT,onDelete:()=>console.log('DELETE_NOTICE'),fault:async(p)=>{if(p===process.env.CRASH_POINT)process.kill(process.pid,'SIGKILL');}});
      await s.expire({now:'2026-10-21T12:00:00Z'}); await s.close();
    `, { ARCHIVE_ROOT: root, CRASH_POINT: point });
    assert.equal(result.signal, 'SIGKILL', result.output);
    const notices = [];
    const recovered = await openStore({ root, onDelete: (entry) => notices.push(entry) });
    assert.deepEqual(await contents(recovered), ['keep']);
    assert.equal((await recovered.snapshot()).checkpoint.generations.g.offset, 13);
    assert.equal((await recovered.expire({ now: '2026-10-21T12:00:00Z' })).deleted.length, 0);
    assert.ok((result.output.match(/DELETE_NOTICE/g)?.length ?? 0) + notices.length >= 1);
    assert.ok(notices.every((entry) => entry.recovered === true));
    await recovered.close();
    const again = await openStore({ root, onDelete: () => {} });
    assert.deepEqual(await contents(again), ['keep']);
    await again.close();
    assert.equal(await fs.readFile(source, 'utf8'), 'expired\nkeep\n');
    const entries = await fs.readdir(path.join(root, 'data/postfix/2026/01/01'));
    assert.deepEqual(entries, []);
  });
}

test('same archive writer lock fails with EADDRINUSE in another process and releases on close', async (t) => {
  const { store, root } = await fixture(t);
  await assert.rejects(openStore({ root }), { code: 'EADDRINUSE' });
  const result = await child(`
    const {openStore}=await import(process.env.STORE_MODULE);
    try {const s=await openStore({root:process.env.ARCHIVE_ROOT});await s.close();process.exitCode=2;}
    catch(e){if(e.code!=='EADDRINUSE')throw e;}
  `, { ARCHIVE_ROOT: root });
  assert.equal(result.code, 0, result.output);
  await store.close();
  const next = await openStore({ root });
  await next.close();
});

test('rejects nonphysical lines, aliases, offset regression and unsafe source names', async (t) => {
  const { store } = await fixture(t);
  await store.commit({ checkpoints: { g: { offset: 100 } } });
  await assert.rejects(store.commit({ checkpoints: { g: { offset: 99 } } }), TypeError);
  for (const invalid of [row('unsafe', stamp, '../postfix'), row('alias', stamp, 'npmplus-access'), { ...row('line'), raw: Buffer.from('partial') }, { ...row('line'), raw: Buffer.from('a\nb\n') }]) {
    const other = await fixture(t);
    await assert.rejects(other.store.commit({ records: [invalid] }), TypeError);
  }
  assert.equal((await store.snapshot()).checkpoint.generations.g.offset, 100);
});
