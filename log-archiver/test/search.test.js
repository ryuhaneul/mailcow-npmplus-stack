import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openStore } from '../store.js';
import { openCollector } from '../collector.js';
import { createSearch, validateQuery, projectLine, MAX_RESPONSE_BYTES } from '../search.js';
import { createArchiveServer } from '../api.js';

const stamp = '2026-10-21T08:00:00.123456789Z';
const base = { source: 'postfix', start: '2026-10-21T08:00:00Z', end: '2026-10-21T09:00:00Z' };
const row = (message, time = stamp, source = 'postfix') => ({ source, raw: Buffer.from(`${JSON.stringify({ time, log: `${message}\n`, stream: 'stdout' })}\n`), eventTime: time, observedAt: stamp });
const params = (value = {}) => ({ ...base, ...value });
const position = cursor => JSON.parse(Buffer.from(cursor.split('.')[0], 'base64url').toString()).position;
const orderedPosition = cursor => { const p = position(cursor); return [p.hour, p.memberStart, p.line, p.byte]; };
const greater = (next, previous) => next.some((value, index) => value !== previous[index] && next.slice(0, index).every((item, n) => item === previous[n]) && value > previous[index]);
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await openStore({ root, memberBytes: 512, onDelete: () => {}, ...options });
  t.after(() => store.close());
  return store;
}
async function pages(engine, query, max = 1000) {
  const rows = [], responses = [];
  let cursor;
  do {
    const response = await engine.search({ ...query, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= MAX_RESPONSE_BYTES);
    if (cursor && response.nextCursor) assert.ok(greater(orderedPosition(response.nextCursor), orderedPosition(cursor)), 'strictly advancing member/line/byte position');
    rows.push(...response.lines); responses.push(response); cursor = response.nextCursor;
    assert.ok(responses.length < max, 'finite continuation');
  } while (cursor);
  return { rows, responses };
}
async function serverFixture(t, store, options = {}) {
  const server = createArchiveServer({ store, key: 'synthetic-archive-key', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (route, options = {}) => fetch(`${url}${route}`, { headers: { 'X-Log-Archive-Key': 'synthetic-archive-key' }, ...options });
  return { server, url, get };
}

test('query allowlist, duplicates, UTC/KST boundaries, literal text and nanoseconds', () => {
  assert.equal(validateQuery(params({ start: '2026-10-21T17:00:00+09:00', end: '2026-10-21T18:00:00+09:00' })).start, '2026-10-21T08:00:00.000Z');
  assert.equal(validateQuery(params({ start: '2026-10-21T17:00:00.123456789+09:00' })).start, stamp);
  assert.equal(validateQuery(params({ limit: '1', q: '[a+b].*' })).limit, 1);
  for (const change of [{ source: 'php-fpm' }, { source: 'nginx' }, { source: 'ui' }, { source: '../../x' }, { start: '2026-10-21T08:00:00' }, { end: base.start }, { start: '2026-02-30T08:00:00Z' }, { start: '2026-10-21T25:00:00Z' }, { q: '가'.repeat(201) }, { limit: '0' }, { limit: '1001' }, { limit: '1.5' }, { limit: ['1', '2'] }, { extra: 'x' }, { end: '2027-10-21T09:00:00Z' }]) assert.throws(() => validateQuery(params(change)), { status: 422 });
  assert.throws(() => validateQuery(new URLSearchParams('source=postfix&source=postfix&start=2026-10-21T08:00:00Z&end=2026-10-21T09:00:00Z')), { status: 422 });
});

test('1/1000-line pagination equals one snapshot across equal/reversed times, members and hours', async t => {
  const store = await fixture(t);
  const records = Array.from({ length: 1100 }, (_, index) => row(`한글 duplicate-${index % 7} a@example.test 2001:db8::1`, index % 3 ? stamp : '2026-10-21T08:00:00.000000001Z'));
  records.push(row('next-hour', '2026-10-21T09:00:00Z'));
  await store.commit({ records });
  const engine = createSearch({ store });
  const query = params({ end: '2026-10-21T10:00:00Z' });
  const one = await pages(engine, { ...query, limit: '1' }, 1200);
  const thousand = await pages(engine, { ...query, limit: '1000' });
  assert.deepEqual(one.rows, thousand.rows);
  assert.equal(new Set(one.rows.map(line => line.id)).size, 1101);
  assert.equal(one.responses.at(-1).complete, true);
});

test('[start,end) filters each line including submillisecond instants and KST month boundary', async t => {
  const store = await fixture(t);
  await store.commit({ records: [row('before', '2026-09-30T14:59:59.999999999Z'), row('included', '2026-09-30T15:00:00.000000001Z'), row('excluded', '2026-09-30T15:00:00.000000002Z')] });
  const engine = createSearch({ store });
  const response = await engine.search(params({ start: '2026-10-01T00:00:00.000000001+09:00', end: '2026-10-01T00:00:00.000000002+09:00' }));
  assert.deepEqual(response.lines.map(line => line.message), ['included']);
  const boundary = await engine.search(params({ start: '2026-09-30T15:00:00Z', end: '2026-09-30T15:00:00.000000002Z' }));
  assert.deepEqual(boundary.lines.map(line => line.message), ['included']);
});

test('append cannot enter a pinned snapshot; new search sees committed members', async t => {
  const store = await fixture(t);
  await store.commit({ records: [row('first'), row('second')] });
  const engine = createSearch({ store });
  const query = params({ limit: '1' });
  const first = await engine.search(query);
  await store.commit({ records: [row('appended'), row('new-hour', '2026-10-21T09:00:00Z')] });
  const rest = await pages(engine, { ...query, cursor: first.nextCursor });
  assert.deepEqual(rest.rows.map(line => line.message), ['second']);
  assert.deepEqual((await pages(engine, params())).rows.map(line => line.message), ['first', 'second', 'appended']);
});

test('zero-match partial pages advance inside a single hour and finish; rare matches are not lost', async t => {
  const store = await fixture(t, { memberBytes: 1024 });
  await store.commit({ records: Array.from({ length: 2000 }, (_, index) => row(`${index % 499 === 0 ? 'rare' : 'ordinary'} ${index} ${'x'.repeat(140)}`)) });
  const engine = createSearch({ store, maxScanBytes: 2200 });
  const empty = await pages(engine, params({ q: 'no-match' }));
  assert.equal(empty.rows.length, 0);
  assert.ok(empty.responses.length > 100);
  assert.ok(empty.responses.slice(0, -1).every(response => !response.complete && response.nextCursor && response.scannedBytes <= 2200));
  const rare = await pages(engine, params({ q: 'rare' }));
  assert.equal(rare.rows.length, 5);
});

test('snapshot expiry, restart, eviction, deletion and replacement are 410; tamper/reuse is 422', async t => {
  const store = await fixture(t);
  await store.commit({ records: [row('a'), row('b')] });
  let now = 1000;
  const engine = createSearch({ store, now: () => now, snapshotTtlMs: 100, maxSnapshots: 2 });
  const query = params({ limit: '1' }), page = await engine.search(query);
  await assert.rejects(engine.search({ ...query, q: 'changed', cursor: page.nextCursor }), { status: 422 });
  const [body, signature] = page.nextCursor.split('.');
  await assert.rejects(engine.search({ ...query, cursor: `${body}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}` }), { status: 422 });
  const restarted = createSearch({ store });
  await assert.rejects(restarted.search({ ...query, cursor: page.nextCursor }), { status: 410 });
  now += 101;
  await assert.rejects(engine.search({ ...query, cursor: page.nextCursor }), { status: 410 });
  const evicted = await engine.search(query);
  await engine.search(query); await engine.search(query);
  await assert.rejects(engine.search({ ...query, cursor: evicted.nextCursor }), { status: 410 });
  const beforeDelete = await engine.search(query);
  await store.expire({ now: '2027-10-21T00:00:00Z' });
  await assert.rejects(engine.search({ ...query, cursor: beforeDelete.nextCursor }), { status: 410 });
  await store.commit({ records: [row('replacement')] });
  await assert.rejects(engine.search({ ...query, cursor: beforeDelete.nextCursor }), { status: 410 });
});

test('projection sanitizes before literal search, keeps addresses, hides structure/header/mail/URL secrets', async t => {
  const store = await fixture(t);
  const canaries = ['nested-secret-canary', 'cookie-canary', 'subject-canary', 'body-canary', 'url-canary', 'arg-canary', '*secretuser@mailcow.local'];
  const messages = [JSON.stringify({ message: 'nested-secret-canary a@example.test', password: 'nested-secret-canary', headers: { cookie: 'cookie-canary' }, subject: 'subject-canary', body: 'body-canary' }), 'Cookie: cookie-canary', 'Subject: subject-canary', 'mail_body=body-canary', 'GET /safe?token=url-canary HTTP/1.1 https://u:url-canary@example.test/safe?q=url-canary', 'imapsync --password1 arg-canary *secretuser@mailcow.local', 'literal [a+b].* 2001:db8::1'];
  const records = messages.map(text => row(text));
  await store.commit({ records });
  const engine = createSearch({ store });
  for (const q of canaries) assert.equal((await engine.search(params({ q }))).returned, 0, q);
  const response = await engine.search(params());
  for (const secret of canaries) assert.ok(!JSON.stringify(response).includes(secret));
  assert.equal((await engine.search(params({ q: 'a@example.test' }))).returned, 1);
  assert.equal((await engine.search(params({ q: '2001:DB8::1' }))).returned, 1);
  assert.equal((await engine.search(params({ q: '[a+b].*' }))).returned, 1);
  const { catalog } = await store.snapshot();
  const raw = gunzipSync(await fs.readFile(store.file(catalog.hours[0].file)));
  assert.deepEqual(raw, Buffer.concat(records.map(record => record.raw)));
  assert.ok(raw.includes(Buffer.from(canaries[0])));
});

test('NPM access timestamp, URL and structured fields project only allowed values', () => {
  const entry = { source: 'npmplus' };
  const line = projectLine('2001:db8::1 - - [21/Oct/2026:17:00:00 +0900] "GET /path?token=canary HTTP/1.1" 200', entry, 'id');
  assert.equal(line.time, '2026-10-21T08:00:00.000Z');
  assert.ok(!line.message.includes('canary'));
  const structured = projectLine(JSON.stringify({ time: stamp, message: 'safe', path: '/path?secret=canary', subject: 'hidden', req: { headers: 'hidden' }, status: 200 }), entry, 'id2');
  assert.deepEqual(structured.fields, { path: '/path', status: '200' });
});

test('2MiB response boundary returns the unreturned line on the next page without loss', async t => {
  const store = await fixture(t, { memberBytes: 1024 * 1024 });
  await store.commit({ records: Array.from({ length: 220 }, (_, i) => row(`${i} ${'가'.repeat(3990)}`)) });
  const engine = createSearch({ store });
  const result = await pages(engine, params({ limit: '1000' }));
  assert.ok(result.responses.length > 1);
  assert.equal(result.responses[0].partialReason, 'response_bytes');
  assert.equal(result.rows.length, 220);
  assert.equal(new Set(result.rows.map(line => line.id)).size, 220);
  assert.ok(result.rows.every(line => Array.from(line.message).length <= 4000));
});

test('oversized lines never expose unsafe fragments and cannot repeat a cursor without progress', async t => {
  const store = await fixture(t, { memberBytes: 1024 * 1024 });
  await store.commit({ records: [row(`Cookie: ${'s'.repeat(2 * 1024 * 1024)}`), row('suffix')] });
  const normal = await createSearch({ store }).search(params());
  assert.equal(normal.lines[0].truncated, true);
  assert.equal(normal.lines[0].message, '[긴 로그 줄 생략]');
  assert.equal(normal.lines[1].message, 'suffix');
  const limited = createSearch({ store, maxScanBytes: 1024 });
  const first = await limited.search(params());
  assert.equal(first.returned, 0);
  assert.equal(position(first.nextCursor).byte, 1024);
  await assert.rejects(limited.search(params({ cursor: first.nextCursor })), { code: 'LOG_SCAN_CANNOT_ADVANCE' });
});

test('coverage includes all eight policies and collection gaps, with empty vs incomplete distinct', async t => {
  const store = await fixture(t);
  await store.commit({ records: [row('kept')] });
  const wrapped = {
    root: store.root, file: store.file.bind(store), readIndex: store.readIndex.bind(store),
    async snapshot() {
      const state = await store.snapshot();
      state.checkpoint.generations = {
        old: { source: 'postfix', closed: true, gaps: [{ source: 'postfix', generation: 'old', start: base.start, end: base.end, reason: 'copytruncate', fromOffset: 100, toOffset: null, unknownLines: true }] },
        current: { source: 'postfix', gaps: [{ source: 'postfix', generation: 'current', start: null, end: null, reason: 'source-read-error', fromOffset: 0, toOffset: null, unknownLines: true }] },
        other: { source: 'dovecot', gaps: [{ source: 'dovecot', generation: 'other', start: base.start, end: base.end, reason: 'source-disappeared', fromOffset: 100, toOffset: null, unknownLines: true }] },
      };
      return state;
    },
  };
  const engine = createSearch({ store: wrapped });
  const coverage = await engine.coverage();
  assert.equal(coverage.sources.length, 8);
  for (const item of coverage.sources) {
    assert.equal(Object.hasOwn(item, 'backfill'), false);
    assert.equal(Object.hasOwn(item, 'collectionLagSeconds'), false);
  }
  assert.equal(coverage.sources.find(item => item.source === 'rspamd').retentionDays, 7);
  assert.equal(coverage.sources.find(item => item.source === 'nginx').retentionDays, 1);
  const response = await engine.search(params({ q: 'absent' }));
  assert.equal(response.returned, 0); assert.equal(response.complete, true); assert.equal(response.incomplete, true);
  assert.deepEqual(response.coverage.gaps, [
    { source: 'postfix', from: '2026-10-21T08:00:00.000Z', to: '2026-10-21T09:00:00.000Z', reason: 'copytruncate' },
    { source: 'postfix', from: null, to: null, reason: 'source-read-error' },
  ]);
  assert.deepEqual(coverage.sources.find(item => item.source === 'postfix').gaps, response.coverage.gaps);
  assert.equal(coverage.sources.find(item => item.source === 'dovecot').gaps.length, 1);
  const empty = await engine.search(params({ source: 'dovecot' }));
  assert.equal(empty.coverage.oldest, null); assert.equal(empty.incomplete, true);
});

test('collector checkpoint gaps survive access truncation and appear in coverage and search by source', async t => {
  const store = await fixture(t);
  const npmplusRoot = path.join(store.root, 'synthetic-npmplus');
  const file = path.join(npmplusRoot, 'nginx/logs/access.log');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const access = minute => `2001:db8::1 - - [21/Oct/2026:08:${minute}:00 +0000] "GET /synthetic HTTP/1.1" 200 1\n`;
  await fs.writeFile(file, access('00'));
  let now = new Date('2026-10-21T08:10:00Z');
  const collector = await openCollector({ store, npmplusRoot, requiredSources: ['npmplus'], now: () => now });
  t.after(() => collector.close());
  await collector.collect();
  await fs.writeFile(file, access('59'));
  now = new Date('2026-10-21T08:20:00Z');
  await collector.collect();
  const { checkpoint } = await store.snapshot();
  const collected = Object.values(checkpoint.generations).flatMap(item => item.gaps ?? []);
  assert.equal(collected.length, 1);
  assert.equal(collected[0].reason, 'source-truncated-or-rewritten');
  const expected = [{ source: 'npmplus', from: collected[0].start, to: collected[0].end, reason: collected[0].reason }];
  const engine = createSearch({ store });
  const coverage = await engine.coverage();
  assert.deepEqual(coverage.sources.find(item => item.source === 'npmplus').gaps, expected);
  assert.ok(coverage.sources.filter(item => item.source !== 'npmplus').every(item => item.gaps.length === 0));
  const response = await engine.search(params({ source: 'npmplus', start: '2026-10-21T08:05:00Z', end: '2026-10-21T08:25:00Z', q: 'absent' }));
  assert.deepEqual(response.coverage.gaps, expected);
  assert.ok(response.coverage.oldest < response.requestedRange.start);
  assert.ok(response.coverage.newest > response.requestedRange.end);
  assert.equal(response.returned, 0);
  assert.equal(response.complete, true);
  assert.equal(response.incomplete, true);
});

test('corrupt gzip, read failure and cancellation return errors without paths or content', async t => {
  const store = await fixture(t);
  await store.commit({ records: [row('synthetic-canary')] });
  const engine = createSearch({ store });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(engine.search(params(), { signal: controller.signal }), { code: 'LOG_QUERY_CANCELLED' });
  const { catalog } = await store.snapshot();
  const file = store.file(catalog.hours[0].file);
  const raw = await fs.readFile(file); raw[raw.length - 8] ^= 255; await fs.writeFile(file, raw);
  await assert.rejects(engine.search(params()), error => error.status === 502 && !error.message.includes(file) && !error.message.includes('synthetic-canary'));
  await fs.unlink(file);
  await assert.rejects(engine.search(params()), { status: 410 });
});

test('HTTP read API authenticates shared header, rejects duplicates/input, bounds concurrent queries and cancels', async t => {
  const store = await fixture(t);
  await store.commit({ records: [row('smoke')] });
  const { get, url } = await serverFixture(t, store);
  assert.equal((await fetch(`${url}/healthz`)).status, 204);
  for (const headers of [{}, { 'X-Log-Archive-Key': 'wrong' }, { Authorization: 'Bearer synthetic-archive-key' }]) {
    const response = await fetch(`${url}/v1/coverage`, { headers });
    assert.equal(response.status, 403); assert.equal(response.headers.has('WWW-Authenticate'), false);
  }
  const route = `/v1/search?${new URLSearchParams(base)}`;
  const response = await get(route); assert.equal(response.status, 200); assert.equal((await response.json()).lines[0].message, 'smoke');
  assert.equal((await get(`${route}&source=postfix`)).status, 422);
  for (const source of ['php-fpm', 'nginx']) assert.equal((await get(`/v1/search?${new URLSearchParams({ ...base, source })}`)).status, 422);
  assert.equal((await get('/v1/coverage')).status, 200);
  assert.equal((await get('/v1/status')).status, 200);
  assert.equal((await get('/v1/search', { method: 'POST' })).status, 405);
  const state = await (await get('/v1/status')).json(); assert.deepEqual(state, { generations: [] });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered = 0, bothEntered;
  const ready = new Promise(resolve => { bothEntered = resolve; });
  const wrapped = { ...store, snapshot: async () => { if (++entered === 2) bothEntered(); await held; return store.snapshot(); }, readIndex: store.readIndex.bind(store), file: store.file.bind(store) };
  const busyEngine = createSearch({ store: wrapped });
  const busyServer = await serverFixture(t, store, { search: busyEngine });
  const first = busyServer.get(route), second = busyServer.get(route);
  await ready;
  const third = await busyServer.get(route);
  assert.equal(third.status, 429); assert.equal(third.headers.get('Retry-After'), '1');
  release(); assert.equal((await first).status, 200); assert.equal((await second).status, 200);
});

test('over 256MiB in one hourly file completes zero/rare searches with bounded member continuation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-large-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const physical = index => row(`${index === 0 ? 'rare-marker' : 'ordinary'} ${'x'.repeat(8000)}`).raw;
  const raw = Buffer.concat(Array.from({ length: 128 }, (_, index) => physical(index)));
  assert.ok(raw.length <= 1024 * 1024);
  const compressed = gzipSync(raw), members = [];
  const handle = await fs.open(path.join(root, 'hour.gz'), 'wx');
  const count = Math.ceil(257 * 1024 * 1024 / raw.length);
  for (let index = 0; index < count; index++) {
    await handle.write(compressed);
    members.push({ start: index * compressed.length, end: (index + 1) * compressed.length, lineCount: 128, uncompressedBytes: raw.length, minTime: stamp, maxTime: stamp });
  }
  await handle.close();
  assert.ok(raw.length * count > 256 * 1024 * 1024);
  const entry = { source: 'postfix', hour: '2026-10-21T08:00:00.000Z', fileId: 'synthetic-large', file: 'hour.gz', compressedBytes: compressed.length * count, minTime: stamp, maxTime: stamp, lineCount: 128 * count, unknownTimeCount: 0 };
  let indexes = 0;
  const store = { file: relative => path.join(root, relative), async snapshot() { return { catalog: { hours: [entry] }, checkpoint: { generations: {} } }; }, async readIndex() { indexes++; return { members }; } };
  const engine = createSearch({ store, maxScanBytes: 8 * 1024 * 1024 });
  const empty = await pages(engine, params({ q: 'never-present' }));
  assert.equal(empty.rows.length, 0); assert.ok(empty.responses.length > 32);
  const rare = await pages(engine, params({ q: 'rare-marker' }));
  assert.equal(rare.rows.length, count);
  assert.equal(new Set(rare.rows.map(line => line.id)).size, count);
  assert.equal(indexes, empty.responses.length + rare.responses.length);
  // Every continuation seeks to its member, rather than decompressing the hour prefix.
  const scanned = empty.responses.reduce((sum, page) => sum + page.scannedBytes, 0);
  assert.ok(scanned < raw.length * count + empty.responses.length * 1024 * 1024);
});

test('time budget yields an advancing partial page and a blocked initial snapshot times out', async t => {
  const store = await fixture(t, { memberBytes: 512 });
  await store.commit({ records: Array.from({ length: 100 }, (_, index) => row(`line-${index}`)) });
  let clock = 0;
  const engine = createSearch({ store, now: () => ++clock, timeoutMs: 15 });
  const first = await engine.search(params({ q: 'absent' }));
  assert.equal(first.partialReason, 'timeout'); assert.ok(first.nextCursor); assert.ok(first.scannedBytes > 0);
  const next = await engine.search(params({ q: 'absent', cursor: first.nextCursor }));
  if (next.nextCursor) assert.ok(greater(orderedPosition(next.nextCursor), orderedPosition(first.nextCursor)));
  const stuck = createSearch({ store: { snapshot: () => new Promise(() => {}) }, timeoutMs: 10 });
  await assert.rejects(stuck.search(params()), { code: 'LOG_SCAN_CANNOT_ADVANCE' });
});

test('in-flight HTTP disconnect propagates cancellation to query and releases capacity', async t => {
  const store = await fixture(t);
  let started, cancelled;
  const ready = new Promise(resolve => { started = resolve; });
  const aborted = new Promise(resolve => { cancelled = resolve; });
  const search = { coverage: async () => ({}), close() {}, async search(_, { signal }) {
    started();
    await new Promise(resolve => signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }));
    throw Object.assign(new Error('cancelled'), { status: 499, code: 'LOG_QUERY_CANCELLED' });
  } };
  const { get } = await serverFixture(t, store, { search });
  const controller = new AbortController();
  const request = get(`/v1/search?${new URLSearchParams(base)}`, { headers: { 'X-Log-Archive-Key': 'synthetic-archive-key' }, signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await aborted;
});

test('a last-line page limit does not bypass gzip CRC verification', async t => {
  const store = await fixture(t);
  await store.commit({ records: [row('only-line')] });
  const { catalog } = await store.snapshot();
  const file = store.file(catalog.hours[0].file), raw = await fs.readFile(file);
  raw[raw.length - 8] ^= 255; await fs.writeFile(file, raw);
  await assert.rejects(createSearch({ store }).search(params({ limit: '1' })), { status: 502 });
});


test('malformed/nested structured text and quoted credential fields never reveal raw secrets', async t => {
  const store = await fixture(t);
  const records = [
    row('{"password":"malformed-canary",'),
    row(JSON.stringify({ message: '{"headers":{"cookie":"nested-header-canary"}}' })),
    row('some text "password":"quoted-canary"'),
    row('repeat-arg-canary --password1=repeat-arg-canary'),
    row('request url=/path?unusual=query-canary'),
    row(JSON.stringify({ key: 'bare-key-canary', message: 'bare-key-canary' })),
    row(JSON.stringify({ token: 'remote-canary', remote: 'remote-canary', message: 'safe' })),
  ];
  await store.commit({ records });
  const engine = createSearch({ store });
  const result = await engine.search(params());
  for (const q of ['malformed-canary', 'nested-header-canary', 'quoted-canary', 'query-canary', 'bare-key-canary', 'remote-canary', 'repeat-arg-canary']) {
    assert.ok(!JSON.stringify(result).includes(q), q);
    assert.equal((await engine.search(params({ q }))).returned, 0, q);
  }
});


test('each page excludes rows before the current source retention cutoff inside a retained hour', async t => {
  const store = await fixture(t, { memberBytes: 1024 * 1024 });
  for (const source of ['postfix', 'dovecot', 'rspamd', 'webmail', 'webmail-admin', 'npmplus']) {
    const day = source === 'rspamd' ? '2026-10-14' : '2026-07-23';
    await store.commit({ records: [
      row('expired-0929', `${day}T09:29:00Z`, source),
      row('cutoff-0930', `${day}T09:30:00Z`, source),
      row('expires-before-next-page', `${day}T09:30:30Z`, source),
      row('next-cutoff', `${day}T09:31:00Z`, source),
    ] });
    let clock = Date.parse('2026-10-21T09:30:00Z');
    const engine = createSearch({ store, now: () => clock });
    const query = params({ source, start: `${day}T09:00:00Z`, end: `${day}T10:00:00Z`, limit: '1' });
    const first = await engine.search(query);
    assert.deepEqual(first.lines.map(line => line.message), ['cutoff-0930'], source);
    clock += 60000;
    const next = await engine.search({ ...query, cursor: first.nextCursor });
    assert.deepEqual(next.lines.map(line => line.message), ['next-cutoff'], source);
    assert.equal(next.complete, true);
  }
});

test('early limit, response and scan boundaries never publish rows from an unverified member', async t => {
  const store = await fixture(t, { memberBytes: 1024 * 1024 });
  await store.commit({ records: Array.from({ length: 400 }, (_, index) => row(`${index} ${'x'.repeat(1000)}`)) });
  const { catalog } = await store.snapshot();
  const file = store.file(catalog.hours[0].file), original = await fs.readFile(file);
  for (const trailer of [8, 4]) {
    const corrupt = Buffer.from(original); corrupt[corrupt.length - trailer] ^= 255;
    await fs.writeFile(file, corrupt);
    for (const [options, query] of [[{}, { limit: '1' }], [{ maxResponseBytes: 4096 }, {}]]) {
      await assert.rejects(createSearch({ store, ...options }).search(params(query)), { status: 502, code: 'ARCHIVE_CORRUPT' });
    }
  }
  await fs.writeFile(file, original);
  const limited = await createSearch({ store }).search(params({ limit: '1' }));
  assert.equal(limited.returned, 1);
  assert.equal(limited.partialReason, 'limit');
  assert.ok(limited.scannedBytes > 400000, 'verification drains the returned row member');
  const smallResponse = await createSearch({ store, maxResponseBytes: 4096 }).search(params());
  assert.equal(smallResponse.partialReason, 'response_bytes');
  assert.ok(smallResponse.scannedBytes > 400000);
  await assert.rejects(createSearch({ store, maxScanBytes: 16384 }).search(params({ limit: '1' })), { code: 'LOG_SCAN_CANNOT_ADVANCE' });
});


test('scan budget discards only the unverified member and resumes without duplicates or lost rows', async t => {
  const store = await fixture(t, { memberBytes: 64 * 1024 });
  await store.commit({ records: Array.from({ length: 400 }, (_, index) => row(`${index} ${'x'.repeat(1000)}`)) });
  const { catalog } = await store.snapshot(), index = await store.readIndex(catalog.hours[0]);
  const engine = createSearch({ store, maxScanBytes: 100000 });
  const first = await engine.search(params({ limit: '1000' }));
  assert.equal(first.partialReason, 'scan_bytes');
  assert.equal(first.returned, index.members[0].lineCount);
  assert.equal(position(first.nextCursor).memberStart, index.members[1].start);
  assert.equal(position(first.nextCursor).line, 0);
  const result = await pages(engine, params({ limit: '1000' }));
  assert.equal(result.rows.length, 400);
  assert.equal(new Set(result.rows.map(line => line.id)).size, 400);
  assert.ok(result.responses.every(response => response.scannedBytes <= 100000));
  let tick = 0;
  const timed = createSearch({ store, now: () => Date.parse('2026-10-21T10:00:00Z') + (tick++ >= 4 ? 10000 : 0), timeoutMs: 10000 });
  await assert.rejects(timed.search(params({ limit: '1' })), { code: 'LOG_SCAN_CANNOT_ADVANCE' });
});

test('compaction between index lookup and gzip open returns snapshot-expired 410 through the API', async t => {
  const store = await fixture(t, { memberBytes: 4096 });
  const records = Array.from({ length: 20 }, (_, index) => row(`synthetic original-${index}`));
  for (const record of records) await store.commit({ records: [record] });
  const originalReadIndex = store.readIndex.bind(store);
  let replaced = false;
  store.readIndex = async entry => {
    const index = await originalReadIndex(entry);
    if (!replaced) {
      replaced = true;
      const result = await store.compact({ now: '2026-10-21T10:00:00Z' });
      assert.equal(result.compacted.length, 1);
    }
    return index;
  };
  const { get } = await serverFixture(t, store);
  const route = `/v1/search?${new URLSearchParams(params())}`;
  const expired = await get(route);
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error.code, 'ARCHIVE_SNAPSHOT_EXPIRED');
  const fresh = await get(route);
  assert.equal(fresh.status, 200);
  const body = await fresh.json();
  assert.deepEqual(body.lines.map(line => line.message), records.map((_, index) => `synthetic original-${index}`));
});

test('compaction invalidates a previous pagination cursor and a fresh search keeps every original line', async t => {
  const store = await fixture(t, { memberBytes: 4096 });
  for (const message of ['same', 'same', 'last']) await store.commit({ records: [row(message)] });
  const engine = createSearch({ store });
  const first = await engine.search(params({ limit: '1' }));
  assert.ok(first.nextCursor);
  await store.compact({ now: '2026-10-21T10:00:00Z' });
  await assert.rejects(engine.search(params({ limit: '1', cursor: first.nextCursor })), { status: 410, code: 'ARCHIVE_SNAPSHOT_EXPIRED' });
  assert.deepEqual((await pages(engine, params({ limit: '1' }))).rows.map(line => line.message), ['same', 'same', 'last']);
});
