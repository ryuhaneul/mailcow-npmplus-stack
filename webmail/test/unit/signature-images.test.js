import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { createSignatureImagesService, inspectSignatureImage, parseSignatureImages, SIGNATURE_IMAGES_ENTRY, MAX_SIGNATURE_IMAGE_BYTES, MAX_SIGNATURE_IMAGES_BYTES, MAX_SIGNATURE_IMAGES_JSON_BYTES } from '../../server/signature-images.js';
import { withSignatureStoreLock } from '../../server/signature-store-lock.js';

const session = { email: 'sender@example.invalid' };
// Synthetic format headers: tests check headers and limits, not full bitmap decoding.
function png(width = 1, height = 1, size = 33, seed = 0) {
  const bytes = Buffer.alloc(size, seed);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  bytes[24] = 8; bytes[25] = 6; bytes[26] = 0; bytes[27] = 0; bytes[28] = 0;
  return bytes;
}
function gif(width = 1, height = 1) {
  const bytes = Buffer.alloc(13); bytes.write('GIF89a'); bytes.writeUInt16LE(width, 6); bytes.writeUInt16LE(height, 8); return bytes;
}
function jpeg(width = 1, height = 1) {
  const bytes = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0]);
  bytes.writeUInt16BE(height, 13); bytes.writeUInt16BE(width, 15); return bytes;
}
function webp(kind, width = 1, height = 1) {
  const bytes = Buffer.alloc(kind === 'VP8L' ? 26 : 30);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WEBP', 8); bytes.write(kind, 12); bytes.writeUInt32LE(kind === 'VP8L' ? 5 : 10, 16);
  if (kind === 'VP8X') { bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3); }
  if (kind === 'VP8L') { bytes[20] = 0x2f; bytes.writeUInt32LE(((height - 1) << 14) | (width - 1), 21); }
  if (kind === 'VP8 ') { Buffer.from([0x9d, 1, 0x2a]).copy(bytes, 23); bytes.writeUInt16LE(width, 26); bytes.writeUInt16LE(height, 28); }
  return bytes;
}
function fixture({ getReferences = async () => [], beforeExec } = {}) {
  const values = new Map(), writes = [];
  let locks = 0;
  const client = { enabled: new Set(), capabilities: new Map(), async exec(command, args, { untagged }) {
    await beforeExec?.(command);
    if (command === 'GETMETADATA') {
      assert.equal(args[0][0].value, 'MAXSIZE'); assert.equal(args[0][1].value, String(MAX_SIGNATURE_IMAGES_JSON_BYTES));
      untagged.METADATA({ attributes: [{ value: '' }, [{ value: SIGNATURE_IMAGES_ENTRY }, { value: values.get(SIGNATURE_IMAGES_ENTRY) ?? null }]] });
    } else {
      assert.equal(command, 'SETMETADATA'); writes.push(args);
      for (let i = 0; i < args[1].length; i += 2) values.set(args[1][i].value, args[1][i + 1].value.toString('utf8'));
    }
    return { next() {} };
  } };
  const imap = { async withMailbox(_session, path, operation) {
    assert.equal(path, 'INBOX'); assert.equal(locks, 0); locks++;
    try { return await operation(client); } finally { locks--; }
  } };
  return { service: createSignatureImagesService({ imap, getReferences }), values, writes, client };
}
const upload = (f, revision, bytes = png(), name = 'synthetic.png') => f.service.upload(session, { name, bytes, contentType: 'text/html', size: -1 }, revision);

test('headers: PNG, JPEG, GIF and all WebP header variants report actual dimensions and MIME', () => {
  for (const [bytes, contentType] of [[png(4, 3), 'image/png'], [jpeg(4, 3), 'image/jpeg'], [gif(4, 3), 'image/gif'], ...['VP8X', 'VP8L', 'VP8 '].map(kind => [webp(kind, 4, 3), 'image/webp'])]) {
    assert.deepEqual(inspectSignatureImage(bytes), { width: 4, height: 3, contentType });
  }
});
test('headers: 16MP and 200KiB boundaries are inclusive; larger and zero dimensions fail', () => {
  assert.equal(inspectSignatureImage(png(4000, 4000, MAX_SIGNATURE_IMAGE_BYTES)).width, 4000);
  assert.throws(() => inspectSignatureImage(png(4001, 4000)), { statusCode: 413 });
  assert.throws(() => inspectSignatureImage(png(1, 1, MAX_SIGNATURE_IMAGE_BYTES + 1)), { statusCode: 413 });
  for (const bytes of [png(0, 1), gif(1, 0), jpeg(0, 1)]) assert.throws(() => inspectSignatureImage(bytes), { statusCode: 422 });
});
test('headers: reject SVG, HTML, disguised files, truncated and malformed format headers', () => {
  for (const bytes of [Buffer.from('<svg/>'), Buffer.from('<html/>'), Buffer.from('PNG pretend'), ...[png(), gif(), jpeg(), webp('VP8X'), webp('VP8L'), webp('VP8 ')].flatMap(bytes => [bytes.subarray(0, 3), bytes.subarray(0, bytes.length - 2)])]) {
    assert.throws(() => inspectSignatureImage(bytes), { statusCode: 422 });
  }
  const badPng = png(); badPng[25] = 5;
  const badJpeg = jpeg(); badJpeg[11] = 10;
  const badWebp = webp('VP8X'); badWebp[21] = 1;
  const badLossless = webp('VP8L'); badLossless[24] = 0xe0;
  for (const bytes of [badPng, badJpeg, badWebp, badLossless]) assert.throws(() => inspectSignatureImage(bytes), { statusCode: 422 });
});
test('upload/get/content: trusted schema, opaque ID, bytes, no base64 leak and dedup preserves ID/revision/name', async () => {
  const f = fixture(), empty = await f.service.get(session);
  assert.equal(empty.revision, '0'); assert.equal(f.writes.length, 0);
  const result = await upload(f, empty.revision);
  assert.match(result.image.id, /^[A-Za-z0-9_-]{32}$/); assert.notEqual(result.revision, empty.revision);
  assert.equal(result.image.contentType, 'image/png'); assert.equal(result.image.size, 33);
  const again = await upload(f, result.revision, png(), 'another.png');
  assert.deepEqual(again, result); assert.equal(f.writes.length, 1);
  const listed = await f.service.get(session);
  assert.equal(listed.images.length, 1); assert.equal(listed.images[0].base64, undefined); assert.equal(listed.images[0].sha256, undefined);
  assert.deepEqual((await f.service.content(session, result.image.id)).bytes, png());
  const stored = JSON.parse(f.values.get(SIGNATURE_IMAGES_ENTRY));
  assert.deepEqual(Object.keys(stored.images[result.image.id]), ['name', 'contentType', 'size', 'sha256', 'base64']);
  assert.match(stored.images[result.image.id].sha256, /^[a-f0-9]{64}$/);
});
test('revision: required/stale checks precede writes and rejected input leaves metadata untouched', async () => {
  const f = fixture();
  await assert.rejects(upload(f, undefined), { statusCode: 428 });
  await assert.rejects(upload(f, 'stale'), { statusCode: 409, code: 'SIGNATURE_CONFLICT' });
  for (const name of ['', 'a\n.png', '가'.repeat(86)]) await assert.rejects(upload(f, '0', png(), name), { statusCode: 422 });
  await upload(f, '0', png(), '가'.repeat(85));
  assert.equal(f.writes.length, 1);
});
test('limits: exactly 20 distinct assets; dedup still succeeds at full count; 21st is rejected', async () => {
  const f = fixture(); let revision = '0', first;
  for (let n = 0; n < 20; n++) { const result = await upload(f, revision, png(n + 1)); revision = result.revision; first ??= result.image.id; }
  assert.equal((await upload(f, revision)).image.id, first);
  await assert.rejects(upload(f, revision, png(21)), { statusCode: 413 });
  assert.equal(f.writes.length, 20); assert.equal((await f.service.get(session)).images.length, 20);
});
test('limits: exactly 1MiB raw total and one-byte overflow; no partial write', async () => {
  const f = fixture(); let revision = '0';
  for (let n = 0; n < 5; n++) revision = (await upload(f, revision, png(n + 1, 1, MAX_SIGNATURE_IMAGE_BYTES))).revision;
  const result = await upload(f, revision, png(6, 1, MAX_SIGNATURE_IMAGES_BYTES - 5 * MAX_SIGNATURE_IMAGE_BYTES));
  assert.equal(result.usedBytes, MAX_SIGNATURE_IMAGES_BYTES);
  await assert.rejects(upload(f, result.revision, png(7)), { statusCode: 413 });
  assert.equal(f.writes.length, 6);
  const g = fixture(); revision = '0';
  for (let n = 0; n < 5; n++) revision = (await upload(g, revision, png(n + 1, 1, MAX_SIGNATURE_IMAGE_BYTES))).revision;
  await assert.rejects(upload(g, revision, png(6, 1, MAX_SIGNATURE_IMAGES_BYTES - 5 * MAX_SIGNATURE_IMAGE_BYTES + 1)), { statusCode: 413 });
  assert.equal(g.writes.length, 5);
});
test('stored JSON: 1.5MiB exact UTF-8 boundary, oversize/malformed/schema/hash/base64 mismatches preserve original', async () => {
  const f = fixture(); await upload(f, '0');
  const raw = f.values.get(SIGNATURE_IMAGES_ENTRY), padding = MAX_SIGNATURE_IMAGES_JSON_BYTES - Buffer.byteLength(raw);
  assert.equal(parseSignatureImages(raw + ' '.repeat(padding)).version, 1);
  assert.throws(() => parseSignatureImages(raw + ' '.repeat(padding + 1)), { statusCode: 503 });
  const doc = JSON.parse(raw), id = Object.keys(doc.images)[0];
  const corrupted = ['not json', '', JSON.stringify({ ...doc, extra: true }), JSON.stringify({ ...doc, revision: 'invalid' })];
  for (const [key, value] of [['size', 0], ['sha256', '0'.repeat(64)], ['base64', 'AA='], ['contentType', 'image/jpeg'], ['name', '']]) {
    corrupted.push(JSON.stringify({ ...doc, images: { [id]: { ...doc.images[id], [key]: value } } }));
  }
  for (const raw of corrupted) {
    f.values.set(SIGNATURE_IMAGES_ENTRY, raw);
    await assert.rejects(f.service.get(session), { statusCode: 503 });
    await assert.rejects(upload(f, doc.revision), { statusCode: 503 });
    assert.equal(f.values.get(SIGNATURE_IMAGES_ENTRY), raw);
  }
  assert.equal(f.writes.length, 1);
});
test('delete: nondefault and legacy mirror references block deletion; no backup or unused reference blocks it', async () => {
  let references = [];
  const f = fixture({ getReferences: async ({ session: received, client }) => {
    assert.equal(received, session); assert.equal(client, f.client); return references;
  } });
  const result = await upload(f, '0'), id = result.image.id;
  for (const ref of [{ id: 'nondefault-signature', name: '비기본 서명', assetIds: [id] }, { id: null, name: 'sender@example.invalid (예전 판 서명)', assetIds: [id] }]) {
    references = [ref];
    await assert.rejects(f.service.delete(session, id, result.revision), error => error.statusCode === 409 && error.code === 'SIGNATURE_IMAGE_IN_USE' && error.message.includes(ref.name));
  }
  references = [{ id: 'other', name: '다른 서명', assetIds: [] }];
  const removed = await f.service.delete(session, id, result.revision);
  assert.equal(removed.usedBytes, 0); assert.notEqual(removed.revision, result.revision);
  await assert.rejects(f.service.content(session, id), { statusCode: 404 });
  await assert.rejects(f.service.content(session, 'foreign-id'), { statusCode: 404 });
  await assert.rejects(f.service.delete(session, 'foreign-id', removed.revision), { statusCode: 404 });
});
test('delete: unavailable/failed references never allow a write, missing and stale revision fail', async () => {
  for (const getReferences of [null, async () => { throw new Error('synthetic failure'); }, async () => null]) {
    const f = fixture({ getReferences }), result = await upload(f, '0');
    await assert.rejects(f.service.delete(session, result.image.id), { statusCode: 428 });
    await assert.rejects(f.service.delete(session, result.image.id, 'stale'), { statusCode: 409 });
    await assert.rejects(f.service.delete(session, result.image.id, result.revision), { statusCode: 503 });
    assert.equal(f.writes.length, 1);
  }
});
test('account queue: serializes separate sessions/services; stale concurrent upload writes only once', async () => {
  const f = fixture();
  const results = await Promise.allSettled([upload(f, '0'), f.service.upload({ ...session }, { name: 'other.png', bytes: png(2) }, '0')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.statusCode, 409); assert.equal(f.writes.length, 1);
});
test('account queue: FIFO, independent accounts, failure recovery and immediate reentry rejection', async () => {
  const order = []; let release, entered;
  const start = new Promise(resolve => { entered = resolve; });
  const first = withSignatureStoreLock('SENDER@example.invalid', async () => { order.push(1); entered(); await new Promise(resolve => { release = resolve; }); throw new Error('synthetic failure'); });
  const rejected = assert.rejects(first, /synthetic failure/); await start;
  const second = withSignatureStoreLock(session.email, async () => { order.push(2); });
  await withSignatureStoreLock('other@example.invalid', () => { order.push('other'); });
  await immediate(); assert.deepEqual(order, [1, 'other']);
  release(); await Promise.all([rejected, second]); assert.deepEqual(order, [1, 'other', 2]);
  await withSignatureStoreLock(session.email, async () => {
    await assert.rejects(withSignatureStoreLock(session.email, () => assert.fail('reentered')), { code: 'SIGNATURE_STORE_REENTRANT' });
  });
  await withSignatureStoreLock(session.email, () => order.push(3)); assert.equal(order.at(-1), 3);
});
test('IMAP failures: unavailable on read/write, preserving previous bytes without automatic retries', async () => {
  let fail;
  const f = fixture({ beforeExec: async command => { if (command === fail) throw new Error('synthetic private failure'); } });
  fail = 'GETMETADATA'; await assert.rejects(f.service.get(session), { statusCode: 503 });
  fail = undefined; const result = await upload(f, '0'), raw = f.values.get(SIGNATURE_IMAGES_ENTRY);
  fail = 'SETMETADATA'; await assert.rejects(upload(f, result.revision, png(2)), { statusCode: 503 });
  assert.equal(f.values.get(SIGNATURE_IMAGES_ENTRY), raw); assert.equal(f.writes.length, 1);
});
