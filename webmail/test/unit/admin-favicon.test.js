import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { createFaviconService } from '../../server/admin/services/favicon.js';
import { readFaviconState, resolveFaviconFile } from '../../server/favicon-store.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
const ctx = { owner: 'synthetic-a', actor: 'admin', ip: '192.0.2.1' };
const svg = text => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text>${text}</text></svg>`);
function png(width = 32, height = width, rows = height) {
  const chunk = (type, bytes) => { const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); result.write(type, 4); bytes.copy(result, 8); result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * rows))), chunk('IEND', Buffer.alloc(0))]);
}
function ico(bytes = png(), size = 32) { const data = Buffer.alloc(22); data.writeUInt16LE(1, 2); data.writeUInt16LE(1, 4); data[6] = data[7] = size === 256 ? 0 : size; data.writeUInt16LE(1, 10); data.writeUInt16LE(32, 12); data.writeUInt32LE(bytes.length, 14); data.writeUInt32LE(22, 18); return Buffer.concat([data, bytes]); }
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'synthetic-favicon-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = 0; const logs = [], hooks = {}, audit = createAudit({ dir: join(dir, 'audit'), logger: { info() {} } }), baseLock = createResourceLock(), targets = [];
  const lock = { run(target, operation) { targets.push(target); return baseLock.run(target, operation); } }, history = createHistoryService({ audit, lock });
  const io = { ...fs, async rename(from, to) { await hooks.rename?.(from, to); return fs.rename(from, to); }, async writeFile(path, ...args) { await hooks.write?.(path); return fs.writeFile(path, ...args); }, async unlink(path) { await hooks.unlink?.(path); return fs.unlink(path); }, async readFile(path, ...args) { const bytes = await fs.readFile(path, ...args); return hooks.read ? hooks.read(path, bytes) : bytes; }, async open(path, ...args) { const handle = await fs.open(path, ...args), sync = handle.sync.bind(handle); handle.sync = async () => { await hooks.sync?.(path); return sync(); }; return handle; } };
  const service = createFaviconService({ dir, audit, lock, history, io, now: () => time, logger: { warn(value) { logs.push(value); } } });
  return { dir, service, history, audit, hooks, logs, targets, advance: value => { time += value; } };
}
const preview = (f, bytes = svg('one'), mime = 'image/svg+xml', owner = ctx.owner) => f.service.preview({ owner, data: { mime, dataBase64: bytes.toString('base64') } });
const put = async (f, id, etag) => f.service.put({ ...ctx, data: { previewId: id, etag: etag ?? (await f.service.get()).etag } });
const save = async (f, name) => put(f, (await preview(f, svg(name))).id);
const mutate = async (f, method) => f.service[method]({ ...ctx, data: { etag: (await f.service.get()).etag } });
for (const [mime, bytes] of [['image/png', png(16)], ['image/png', png(512)], ['image/svg+xml', svg('valid')], ['image/vnd.microsoft.icon', ico()], ['image/x-icon', ico()]]) test(`favicon accepts ${mime} ${bytes.length}`, async t => {
  const f = await fixture(t), value = await preview(f, bytes, mime), result = await put(f, value.id);
  assert.deepEqual(await fs.readFile(resolveFaviconFile(f.dir, result.current)), bytes);
  assert.equal(result.current.mime, mime === 'image/x-icon' ? 'image/vnd.microsoft.icon' : mime);
});
const icoBad = field => { const data = ico(); if (field === 'count') data.writeUInt16LE(0, 4); if (field === 'directory') data.writeUInt16LE(65535, 4); if (field === 'offset') data.writeUInt32LE(1, 18); if (field === 'length') data.writeUInt32LE(data.length, 14); if (field === 'zero') data.writeUInt32LE(0, 14); if (field === 'square') data[7] = 16; return data; };
const invalids = [['empty', 'image/png', Buffer.alloc(0)], ['oversize', 'image/png', Buffer.alloc(262145)], ['truncated PNG signature', 'image/png', png().subarray(0, 24)], ['truncated PNG body', 'image/png', png().subarray(0, -8)], ['truncated PNG scanlines', 'image/png', png(32, 32, 1)], ['PNG rectangular', 'image/png', png(32, 16)], ['PNG small', 'image/png', png(15)], ['PNG large', 'image/png', png(513)], ['MIME mismatch', 'image/svg+xml', png()], ['ICO embedded truncated PNG', 'image/x-icon', ico(png().subarray(0, 40))], ['ICO embedded unknown critical PNG', 'image/x-icon', ico(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAA0FBQUFiYWSARdYyAAAAGklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAO8GECAAARlDNO4AAAAASUVORK5CYII=', 'base64'))], ...['count','directory','offset','length','zero','square'].map(field => [`ICO ${field}`, 'image/x-icon', icoBad(field)]), ...['', '0 0 32', '0 0 32 16', '0 0 -1 -1', '0 0 NaN NaN', '0 0 Infinity Infinity', '0 0 1e999 1e999', '0,0,,32,32', '0 0 0 0'].map(viewBox => [`viewBox ${viewBox}`, 'image/svg+xml', Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"/>`)]), ['SVG non-root', 'image/svg+xml', Buffer.from('<html><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"/></html>')], ['SVG malformed', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">')], ['SVG doctype', 'image/svg+xml', Buffer.from('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"/>')]];
for (const [name, mime, bytes] of invalids) test(`favicon rejects ${name} with 422`, async t => { const f = await fixture(t); await assert.rejects(preview(f, bytes, mime), { statusCode: 422 }); });
test('favicon exact 256KiB SVG preserved, malformed base64 rejected', async t => {
  const f = await fixture(t), bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><!--' + ' '.repeat(262144 - 73) + '--></svg>');
  assert.equal(bytes.length, 262144); const p = await preview(f, bytes); assert.deepEqual((await f.service.file(p.id, ctx.owner)).data, bytes);
  for (const dataBase64 of ['@===', 'a===', 'Zg=', 'Zh==']) await assert.rejects(f.service.preview({ owner: ctx.owner, data: { mime: 'image/png', dataBase64 } }), { statusCode: 422 });
});
test('favicon original malicious SVG is retained byte for byte; owner isolation and TTL', async t => {
  const f = await fixture(t), bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" onload="alert(1)"><script>alert(2)</script><image href="https://outside.example.test/pixel"/></svg>'), p = await preview(f, bytes);
  await assert.rejects(f.service.file(p.id, 'other'), { statusCode: 404 }); await assert.rejects(f.service.put({ ...ctx, owner: 'other', data: { etag: (await f.service.get()).etag, previewId: p.id } }), { statusCode: 404 });
  assert.deepEqual((await f.service.file(p.id, ctx.owner)).data, bytes); f.advance(600000); await assert.rejects(put(f, p.id), { statusCode: 404 });
  const next = await put(f, (await preview(f, bytes)).id); assert.deepEqual(await fs.readFile(resolveFaviconFile(f.dir, next.current)), bytes);
});
test('favicon save/revert/delete/revert and history all share favicon lock; metadata-only audit', async t => {
  const f = await fixture(t), first = await save(f, 'synthetic-private-content'), second = await save(f, 'second');
  assert.equal((await mutate(f, 'revert')).current.version, first.current.version); assert.equal((await mutate(f, 'remove')).current, null);
  assert.equal((await mutate(f, 'revert')).current.version, first.current.version);
  const removed = await mutate(f, 'remove'); await f.history.revert(removed.auditId, { ...ctx, confirm: true });
  assert.equal((await f.service.get()).current.version, first.current.version); assert.ok(f.targets.length >= 7); assert.ok(f.targets.every(target => target === 'favicon'));
  await assert.rejects(f.history.revert(second.auditId, { ...ctx, confirm: true }), { statusCode: 409 });
  const records = JSON.stringify(await f.audit.read()); assert.ok(!records.includes('synthetic-private-content')); assert.ok(!records.includes(svg('synthetic-private-content').toString('base64')));
});
test('favicon concurrent stale writes yield one save and one409, input and disabled checks', async t => {
  const f = await fixture(t), a = await preview(f, svg('a')), b = await preview(f, svg('b')), tag = (await f.service.get()).etag;
  const results = await Promise.allSettled([put(f, a.id, tag), put(f, b.id, tag)]); assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.statusCode, 409);
  await assert.rejects(f.service.remove({ ...ctx, data: { etag: tag } }), { statusCode: 409 });
  await assert.rejects(f.service.revert({ ...ctx, data: { etag: tag } }), { statusCode: 409 });
  await assert.rejects(f.service.preview({ data: { variant: 'light' } }), { statusCode: 422 });
  const disabled = createFaviconService({ dir: '', history: { register() {} } });
  for (const operation of [() => disabled.get(), () => disabled.preview({}), () => disabled.file('x'), () => disabled.put({}), () => disabled.revert({}), () => disabled.remove({})]) await assert.rejects(operation(), { statusCode: 503 });
});
for (const failure of ['previous-rename', 'current-rename', 'current-write']) test(`favicon ${failure} preserves old states, atomic names and preview retry`, async t => {
  const f = await fixture(t); await save(f, 'one'); await save(f, 'two'); const before = await f.service.get(), p = await preview(f, svg('three')), names = [];
  f.hooks.rename = (from, to) => { assert.equal(from, `${to}.tmp`); names.push(to); if (to.endsWith(failure === 'previous-rename' ? '/favicon.previous.json' : '/favicon.json') && failure !== 'current-write') throw new Error('synthetic-failure'); };
  f.hooks.write = path => { if (failure === 'current-write' && path.endsWith('/favicon.json.tmp')) throw new Error('synthetic-failure'); };
  await assert.rejects(put(f, p.id), /synthetic-failure/); assert.deepEqual(await f.service.get(), before);
  f.hooks.rename = f.hooks.write = null; await put(f, p.id); assert.equal((await f.service.get()).current.version, (await readFaviconState(f.dir)).version);
});
test('favicon cleanup touches only favicon assets, cleanup failure is pending and recovers', async t => {
  const f = await fixture(t), preserved = { 'current.json': 'synthetic-logo-state', 'previous.json': 'synthetic-previous-logo', 'light-0123456789abcdef.svg': '<svg/>', 'dark-fedcba9876543210.png': 'logo-bytes', 'custom.svg': 'custom' };
  for (const [name, bytes] of Object.entries(preserved)) await fs.writeFile(join(f.dir, name), bytes);
  const first = await save(f, 'one'); await save(f, 'two'); f.hooks.unlink = () => { throw new Error('synthetic-private-cleanup'); };
  const result = await save(f, 'three'); assert.equal(result.detail.cleanupPending, true); assert.ok(f.logs.some(row => row.code === 'FAVICON_CLEANUP_FAILED'));
  f.hooks.unlink = null; await mutate(f, 'remove'); await mutate(f, 'revert');
  await assert.rejects(fs.readFile(join(f.dir, first.current.file)), { code: 'ENOENT' });
  for (const [name, bytes] of Object.entries(preserved)) assert.equal(await fs.readFile(join(f.dir, name), 'utf8'), bytes);
});
test('favicon initial failed current rename restores absent previous; corrupt asset fails closed', async t => {
  const f = await fixture(t); f.hooks.rename = (_from, to) => { if (to.endsWith('/favicon.json')) throw new Error('synthetic-failure'); };
  await assert.rejects(save(f, 'one'), /synthetic-failure/); await assert.rejects(fs.readFile(join(f.dir, 'favicon.previous.json')), { code: 'ENOENT' });
  f.hooks.rename = null; const result = await save(f, 'one'); await fs.writeFile(resolveFaviconFile(f.dir, result.current), 'corrupt');
  await mutate(f, 'remove'); await assert.rejects(mutate(f, 'revert'), { statusCode: 503 }); assert.equal((await f.service.get()).current, null);
});
test('favicon asset rename failure preserves old state and allows preview retry', async t => {
  const f = await fixture(t); await save(f, 'old'); const before = await f.service.get(), p = await preview(f, svg('new'));
  f.hooks.rename = (_from, to) => { if (to.endsWith('.svg')) throw new Error('synthetic-asset-rename-failure'); };
  await assert.rejects(put(f, p.id), /synthetic-asset-rename-failure/); assert.deepEqual(await f.service.get(), before);
  f.hooks.rename = null; await put(f, p.id);
});
for (const mode of ['remove','revert','history']) test(`favicon ${mode} failed current rename preserves both states`, async t => {
  const f = await fixture(t); await save(f, 'one'); const saved = await save(f, 'two'), before = await f.service.get();
  f.hooks.rename = (_from, to) => { if (to.endsWith('/favicon.json')) throw new Error('synthetic-current-rename-failure'); };
  await assert.rejects(mode === 'history' ? f.history.revert(saved.auditId, { ...ctx, confirm: true }) : mutate(f, mode), /synthetic-current-rename-failure/);
  assert.deepEqual(await f.service.get(), before);
});

for (const mode of ['put','remove','revert','history']) for (const fault of ['current-write-once','current-verify-once','current-rename-once','persistent-ENOSPC']) test(`favicon evaluator storage ${mode} ${fault} preserves exact state bytes and recovery`, async t => {
  const f = await fixture(t), first = await save(f, 'A'), second = await save(f, 'B');
  const paths = ['favicon.json', 'favicon.previous.json'].map(name => join(f.dir, name)), before = await Promise.all(paths.map(path => fs.readFile(path)));
  let fired = false; const renames = [];
  f.hooks.write = path => {
    if (fault === 'persistent-ENOSPC' && (fired || path.endsWith('/favicon.json.tmp'))) { fired = true; throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' }); }
    if (!fired && fault === 'current-write-once' && path.endsWith('/favicon.json.tmp')) { fired = true; throw new Error('synthetic write failure'); }
  };
  f.hooks.read = (path, bytes) => { if (!fired && fault === 'current-verify-once' && path.endsWith('/favicon.json.tmp')) { fired = true; return Buffer.from('synthetic corrupt read'); } return bytes; };
  f.hooks.rename = (_from, to) => { renames.push(to); if (!fired && fault === 'current-rename-once' && to.endsWith('/favicon.json')) { fired = true; throw new Error('synthetic rename failure'); } };
  await assert.rejects(mode === 'put' ? save(f, 'C') : mode === 'history' ? f.history.revert(second.auditId, { ...ctx, confirm: true }) : mutate(f, mode));
  assert.equal(fired, true); assert.deepEqual(await Promise.all(paths.map(path => fs.readFile(path))), before);
  if (fault !== 'current-rename-once') assert.deepEqual(renames, []);
  assert.deepEqual((await fs.readdir(f.dir)).filter(name => name.endsWith('.tmp')), []);
  f.hooks.write = f.hooks.read = f.hooks.rename = null;
  assert.equal((await mutate(f, 'revert')).current.version, first.current.version);
  assert.deepEqual(await fs.readFile(resolveFaviconFile(f.dir, first.current)), svg('A'));
});

test('favicon stages and fsyncs new icon and both states before rename; fsync failure preserves bytes', async t => {
  const f = await fixture(t); await save(f, 'A'); await save(f, 'B');
  const paths = ['favicon.json','favicon.previous.json'].map(name => join(f.dir, name)), before = await Promise.all(paths.map(path => fs.readFile(path)));
  let renames = 0;
  f.hooks.sync = path => { if (path.endsWith('/favicon.json.tmp')) throw Object.assign(new Error('synthetic fsync ENOSPC'), { code: 'ENOSPC' }); };
  f.hooks.rename = () => { renames++; };
  await assert.rejects(save(f, 'C'), { code: 'ENOSPC' }); assert.equal(renames, 0);
  assert.deepEqual(await Promise.all(paths.map(path => fs.readFile(path))), before);
  assert.deepEqual((await fs.readdir(f.dir)).filter(name => name.endsWith('.tmp')), []);
  const written = new Set(), synced = new Set();
  f.hooks.write = path => { written.add(path); }; f.hooks.sync = path => { synced.add(path); };
  f.hooks.rename = () => { assert.equal(written.size, 3); assert.deepEqual(synced, written); };
  await save(f, 'C');
});

function dibIco(size) {
  const stride = size * 4, mask = Math.ceil(size / 32) * 4, data = Buffer.alloc(40 + stride * size + mask * size);
  data.writeUInt32LE(40); data.writeInt32LE(size, 4); data.writeInt32LE(size * 2, 8); data.writeUInt16LE(1, 12); data.writeUInt16LE(32, 14); data.writeUInt32LE(stride * size, 20);
  for (let offset = 40; offset < 40 + stride * size; offset += 4) { data[offset + 2] = 255; data[offset + 3] = 255; }
  return ico(data, size);
}
const normalFormats = [
  ['PNG16', 'image/png', png(16)], ['PNG32', 'image/png', png(32)], ['PNG512', 'image/png', png(512)],
  ['SVG default xmlns', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="red"/></svg>')],
  ['SVG prefixed namespace', 'image/svg+xml', Buffer.from('<s:svg xmlns:s="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><s:rect width="32" height="32" fill="red"/></s:svg>')],
  ...[8,16,32,256].map(size => [`ICO PNG${size}`, size === 256 ? 'image/x-icon' : 'image/vnd.microsoft.icon', ico(png(size), size)]),
  ...[8,32].map(size => [`ICO DIB${size}`, 'image/vnd.microsoft.icon', dibIco(size)]),
];
for (const [name, mime, bytes] of normalFormats) test(`favicon evaluator normal format ${name} accepts and preserves original`, async t => {
  const f = await fixture(t), result = await put(f, (await preview(f, bytes, mime)).id);
  assert.deepEqual(await fs.readFile(resolveFaviconFile(f.dir, result.current)), bytes);
});
