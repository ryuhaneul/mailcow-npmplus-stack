import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignaturesService, parseSignatures, SIGNATURES_ENTRY, MAX_SIGNATURES_BYTES, signatureMirrorHash } from '../../server/signatures.js';
import { PREFS_ENTRY } from '../../server/prefs.js';
import { AppError } from '../../server/errors.js';
import { createSignatureImagesService, SIGNATURE_IMAGES_ENTRY } from '../../server/signature-images.js';
import { withSignatureStoreLock } from '../../server/signature-store-lock.js';

const session = { email: 'sender@example.invalid' }, alias = 'alias@example.invalid', old = 'old@example.invalid';
const asset = 'a'.repeat(32), cid = `<img src="cid:wm-sig-v1.${asset}@signature.invalid">`;
function fixture({ identities = [session.email, alias], normalizeHtml = async ({ html }) => html, signatures = {}, prefs, fail } = {}) {
  const values = new Map([[PREFS_ENTRY, prefs ?? JSON.stringify({ signatures, theme: 'synthetic', untouched: { nested: true } })]]), commands = [];
  let active = 0;
  const client = { enabled: new Set(), capabilities: new Map(), async exec(command, args, { untagged }) {
    assert.equal(active, 1); commands.push({ command, args });
    if (command === 'GETMETADATA') {
      const key = args[2].value;
      assert.deepEqual(args, [[{ type: 'ATOM', value: 'MAXSIZE' }, { type: 'ATOM', value: String(key === PREFS_ENTRY ? 65536 : key === SIGNATURE_IMAGES_ENTRY ? 1572864 : 262144) }], { type: 'STRING', value: '' }, { type: 'STRING', value: key }]);
      assert.ok([PREFS_ENTRY, SIGNATURES_ENTRY, SIGNATURE_IMAGES_ENTRY].includes(key));
      untagged.METADATA({ attributes: [{ value: '' }, [{ value: key }, { value: values.get(key) ?? null }]] });
    } else {
      assert.equal(command, 'SETMETADATA');
      assert.deepEqual(args[0], { type: 'STRING', value: '' });
      assert.ok(args[1].length === 2 || args[1].length === 4);
      assert.ok([SIGNATURES_ENTRY, SIGNATURE_IMAGES_ENTRY].includes(args[1][0].value));
      for (let i = 0; i < args[1].length; i += 2) {
        assert.deepEqual(args[1][i], { type: 'STRING', value: i === 0 ? args[1][0].value === SIGNATURE_IMAGES_ENTRY ? SIGNATURE_IMAGES_ENTRY : SIGNATURES_ENTRY : PREFS_ENTRY });
        assert.equal(args[1][i + 1].type, 'LITERAL'); assert.ok(Buffer.isBuffer(args[1][i + 1].value));
        assert.equal(Buffer.from(args[1][i + 1].value.toString('utf8')).equals(args[1][i + 1].value), true);
      }
      if (fail?.mode === 'before') throw new Error('synthetic failure');
      for (let i = 0; i < args[1].length; i += 2) {
        if (fail?.mode === 'partial' && i === 2) break;
        values.set(args[1][i].value, args[1][i + 1].value.toString('utf8'));
      }
      if (fail?.mode) throw new Error('synthetic ACK loss');
    }
    return { next() {} };
  } };
  const imap = { async withMailbox(received, path, operation) {
    assert.equal(received.email, session.email); assert.equal(path, 'INBOX'); assert.equal(active, 0); active++;
    try { return await operation(client); } finally { active--; }
  } };
  const service = createSignaturesService({ imap, normalizeHtml, getIdentities: async () => identities });
  return { service, values, commands, client, imap, internal: operation => withSignatureStoreLock(session.email, () => imap.withMailbox(session, 'INBOX', operation)), writes: () => commands.filter(item => item.command === 'SETMETADATA') };
}
const body = result => ({ items: result.items.map(({ id, name, html }) => ({ id, name, html })), defaults: structuredClone(result.defaults) });
async function seed(f, count = 1) {
  const doc = await f.service.get(session);
  return f.service.put(session, { items: Array.from({ length: count }, (_, n) => ({ id: `client-${n}`, name: `서명 ${n}`, html: `<p>합성 ${n}</p>` })), defaults: { [session.email]: { newDefault: 'client-0', replyDefault: count > 1 ? 'client-1' : null } } }, doc.revision);
}

test('list/save: 21 signatures, opaque IDs, idMap, canonical HTML and exact two-key command', async () => {
  const f = fixture({ normalizeHtml: async ({ html }) => html.replace('합성', '정리') }), result = await seed(f, 21);
  assert.equal(result.items.length, 21); assert.equal(Object.keys(result.idMap).length, 21);
  assert.match(result.items[0].id, /^[A-Za-z0-9_-]{32}$/); assert.match(result.items[0].html, /정리/);
  assert.equal(result.defaults[session.email].newDefault, result.idMap['client-0']);
  assert.equal(result.defaults[session.email].replyDefault, result.idMap['client-1']);
  assert.deepEqual(result.defaults[alias], { newDefault: null, replyDefault: null });
  const [list, mirror] = [JSON.parse(f.values.get(SIGNATURES_ENTRY)), JSON.parse(f.values.get(PREFS_ENTRY))];
  assert.equal(result.usedBytes, Buffer.byteLength(f.values.get(SIGNATURES_ENTRY))); assert.equal(result.maxBytes, 262144);
  assert.deepEqual(mirror.signatures, { [session.email]: { html: result.items[0].html, auto: true }, [alias]: { html: '', auto: false } });
  assert.deepEqual(mirror.untouched, { nested: true }); assert.equal(mirror.theme, 'synthetic');
  assert.equal(list.mirror.lastWrittenHash, signatureMirrorHash(mirror)); assert.equal(list.mirror.lastObservedHash, list.mirror.lastWrittenHash);
  const last = f.writes().at(-1); assert.equal(last.args[1].length, 4);
  assert.equal(last.args[1][1].value.toString('utf8'), f.values.get(SIGNATURES_ENTRY));
  assert.equal(last.args[1][3].value.toString('utf8'), f.values.get(PREFS_ENTRY));
  assert.equal(result.migration, undefined); assert.equal(result.mirror, undefined); assert.equal(result.items[0].importSource, undefined);
});
test('edit/copy/delete: stable IDs and timestamps, new copy ID, all historical defaults cleared on delete', async () => {
  const f = fixture({ signatures: { [old]: { html: '<p>old</p>', auto: true } } });
  let result = await f.service.get(session); const original = result.items[0];
  let input = body(result); input.items.push({ id: 'client-copy', name: original.name, html: original.html });
  result = await f.service.put(session, input, result.revision);
  assert.equal(result.items[0].id, original.id); assert.equal(result.items[0].createdAt, original.createdAt); assert.equal(result.items[0].updatedAt, original.updatedAt);
  assert.notEqual(result.idMap['client-copy'], original.id);
  input = body(result); input.items = input.items.filter(item => item.id !== original.id);
  result = await f.service.put(session, input, result.revision);
  assert.deepEqual(result.defaults[old], { newDefault: null, replyDefault: null });
  assert.equal(result.items.length, 1);
});
test('reply-only change leaves legacy mirror meaning unchanged', async () => {
  const f = fixture(); let result = await seed(f, 2), raw = f.values.get(PREFS_ENTRY), input = body(result);
  input.defaults[session.email].replyDefault = result.items[0].id;
  result = await f.service.put(session, input, result.revision);
  assert.equal(f.values.get(PREFS_ENTRY), raw); assert.equal(result.defaults[session.email].replyDefault, result.items[0].id);
});
test('validation: revision missing/stale, unknown IDs/defaults, duplicate IDs and forged server fields write nothing', async () => {
  const f = fixture(), result = await seed(f), valid = body(result), before = f.writes().length;
  await assert.rejects(f.service.put(session, valid), { statusCode: 428 });
  await assert.rejects(f.service.put(session, valid, 'stale'), { statusCode: 409 });
  for (const mutate of [input => input.items.push(input.items[0]), input => input.items[0].id = 'b'.repeat(32), input => input.items[0].createdAt = 'forged', input => input.items[0].importSource = {}, input => input.defaults[session.email].newDefault = 'missing', input => input.defaults[session.email].replyDefault = false]) {
    const input = structuredClone(valid); mutate(input); await assert.rejects(f.service.put(session, input, result.revision));
  }
  assert.equal(f.writes().length, before);
});
test('names: trim, duplicate names allowed, 200 UTF-8 bytes inclusive, invalid controls/empty/201 bytes fail', async () => {
  const f = fixture(); let result = await seed(f), input = body(result);
  input.items[0].name = `  ${'가'.repeat(66)}ab  `;
  result = await f.service.put(session, input, result.revision); assert.equal(Buffer.byteLength(result.items[0].name), 200);
  for (const value of ['', ' \t', 'a\nb', '가'.repeat(67)]) {
    input = body(result); input.items[0].name = value;
    await assert.rejects(f.service.put(session, input, result.revision), { statusCode: 422 });
  }
});
test('identity authorization: preserve old alias, clear deleted references, reject new foreign address and changed historical defaults', async () => {
  const f = fixture({ signatures: { [old]: { html: '<p>old</p>', auto: true } } });
  let result = await f.service.get(session), input = body(result);
  input.items.push({ id: 'client-extra', name: 'extra', html: 'extra' });
  result = await f.service.put(session, input, result.revision); assert.ok(result.defaults[old].newDefault);
  input = body(result); input.defaults['foreign@example.invalid'] = { newDefault: null, replyDefault: null };
  await assert.rejects(f.service.put(session, input, result.revision), { statusCode: 422 });
  input = body(result); input.defaults[old].newDefault = result.idMap['client-extra'];
  await assert.rejects(f.service.put(session, input, result.revision), { statusCode: 422 });
  input = body(result); input.items.shift();
  result = await f.service.put(session, input, result.revision); assert.deepEqual(result.defaults[old], { newDefault: null, replyDefault: null });
});
test('limits: raw input and canonical result limits checked, mirror overflow writes neither key', async () => {
  const f = fixture(), result = await seed(f), before = new Map(f.values), input = body(result);
  input.items[0].html = '가'.repeat(90000);
  await assert.rejects(f.service.put(session, input, result.revision), { statusCode: 413 }); assert.deepEqual(f.values, before);
  input.items[0].html = 'a'.repeat(65000); input.defaults[alias] = { newDefault: result.items[0].id, replyDefault: null };
  await assert.rejects(f.service.put(session, input, result.revision), { statusCode: 413, code: 'SIGNATURE_MIRROR_TOO_LARGE' }); assert.deepEqual(f.values, before);
  const g = fixture({ normalizeHtml: async () => 'x'.repeat(MAX_SIGNATURES_BYTES) }); const empty = await g.service.get(session), saved = new Map(g.values);
  await assert.rejects(g.service.put(session, { items: [{ id: 'client-a', name: 'a', html: '' }], defaults: {} }, empty.revision), { statusCode: 413 }); assert.deepEqual(g.values, saved);
});
test('stored document: exact 256KiB boundary, one byte overflow, corrupt shape/base64/hash are preserved', async () => {
  const f = fixture(); await seed(f); const raw = f.values.get(SIGNATURES_ENTRY), pad = MAX_SIGNATURES_BYTES - Buffer.byteLength(raw);
  assert.equal(parseSignatures(raw + ' '.repeat(pad)).version, 1);
  assert.throws(() => parseSignatures(raw + ' '.repeat(pad + 1)), { statusCode: 503 });
  for (const transform of [() => '{bad', doc => JSON.stringify({ ...doc, unknown: true }), doc => { doc.defaults[session.email].newDefault = 'missing'; return JSON.stringify(doc); }, doc => { doc.migration.originalPrefsSha256 = '0'.repeat(64); return JSON.stringify(doc); }, doc => { doc.migration.originalPrefsBase64 = '!'; return JSON.stringify(doc); }]) {
    const bad = transform(JSON.parse(raw)); f.values.set(SIGNATURES_ENTRY, bad);
    await assert.rejects(f.service.get(session), { statusCode: 503 }); assert.equal(f.values.get(SIGNATURES_ENTRY), bad);
  }
});
test('references: all nondefault signatures and actual mirror, canonical entities parsed, backup excluded, no lock recursion', async () => {
  const f = fixture({ signatures: { [session.email]: { html: cid, auto: false } } });
  let result = await f.service.get(session), input = body(result);
  input.items[0].html = '<p>no active image</p>'; input.items.push({ id: 'client-image', name: '비기본', html: cid.replace('cid:', 'cid&#58;') });
  result = await f.service.put(session, input, result.revision);
  let refs = await f.internal(client => f.service.getReferences({ session, client }));
  assert.deepEqual(refs.find(ref => ref.id === result.idMap['client-image']).assetIds, [asset]);
  assert.deepEqual(refs.find(ref => ref.id === result.items[0].id).assetIds, []);
  assert.equal(refs.filter(ref => ref.id === null).every(ref => ref.assetIds.length === 0), true);
  const prefs = JSON.parse(f.values.get(PREFS_ENTRY)); prefs.signatures[alias] = { html: cid, auto: false }; f.values.set(PREFS_ENTRY, JSON.stringify(prefs));
  refs = await f.internal(client => f.service.getReferences({ session, client }));
  assert.deepEqual(refs.find(ref => ref.name === `${alias} (예전 판 서명)`), { id: null, name: `${alias} (예전 판 서명)`, assetIds: [asset] });
});
test('preparePrefs: preserve unsynchronized actual mirror; use list mirror only after explicit save', async () => {
  const f = fixture({ signatures: { [session.email]: { html: 'original', auto: false } } });
  let result = await f.service.get(session);
  let prepared = await f.internal(client => f.service.preparePrefs({ session, client, prefs: { theme: 'new', signatures: {} } }));
  assert.equal(prepared.mirrorSync, false); assert.equal(prepared.prefs.signatures[session.email].html, 'original'); assert.equal(prepared.prefs.theme, 'new');
  result = await f.service.put(session, body(result), result.revision);
  prepared = await f.internal(client => f.service.preparePrefs({ session, client, prefs: { theme: 'new', signatures: { stale: true } } }));
  assert.equal(prepared.mirrorSync, true); assert.deepEqual(prepared.prefs.signatures[session.email], { html: 'original', auto: false });
  const prefs = JSON.parse(f.values.get(PREFS_ENTRY)); prefs.signatures[session.email] = { html: 'legacy edit', auto: true }; f.values.set(PREFS_ENTRY, JSON.stringify(prefs));
  prepared = await f.internal(client => f.service.preparePrefs({ session, client, prefs: { mode: 'dark' } }));
  assert.equal(prepared.mirrorSync, false); assert.equal(prepared.prefs.signatures[session.email].html, 'legacy edit');
});
test('ACK loss: successful two-key write recovered; rejected atomic write leaves both values unchanged', async () => {
  const fail = {}, f = fixture({ fail }); let result = await seed(f), input = body(result); input.items[0].html = 'edited';
  fail.mode = 'after'; result = await f.service.put(session, input, result.revision); assert.equal(result.items[0].html, 'edited');
  input = body(result); input.items[0].html = 'rejected'; const before = new Map(f.values); fail.mode = 'before';
  await assert.rejects(f.service.put(session, input, result.revision), { statusCode: 503, code: 'SIGNATURE_SAVE_RETRY' }); assert.deepEqual(f.values, before);
});
test('normalization: callback sees locked client/session and rejects entire save; missing callback blocks save', async () => {
  let called = false;
  const f = fixture({ normalizeHtml: async ({ session: received, client, html }) => { called = true; assert.equal(received, session); assert.equal(client, f.client); assert.equal(html, 'bad'); throw new AppError(422, 'SIGNATURE_DATA_IMAGE_UNSUPPORTED', 'synthetic'); } });
  const empty = await f.service.get(session), before = new Map(f.values);
  await assert.rejects(f.service.put(session, { items: [{ id: 'client-a', name: 'a', html: 'bad' }], defaults: {} }, empty.revision), { statusCode: 422, code: 'SIGNATURE_DATA_IMAGE_UNSUPPORTED' }); assert.equal(called, true); assert.deepEqual(f.values, before);
  const service = createSignaturesService({ imap: f.imap, getIdentities: async () => [] });
  await assert.rejects(service.put(session, { items: [], defaults: {} }, empty.revision), { statusCode: 503, code: 'SIGNATURE_SERVICE_UNAVAILABLE' });
});

test('save: exact 256KiB serialized list accepted, one byte over rejected with zero writes', async () => {
  const f = fixture(), result = await f.service.get(session);
  const input = { items: [{ id: 'client-large', name: 'large', html: '' }], defaults: {} };
  let saved = await f.service.put(session, input, result.revision);
  let next = body(saved); next.items[0].html = '가'.repeat(1000) + 'x'.repeat(MAX_SIGNATURES_BYTES - saved.usedBytes - 3000);
  saved = await f.service.put(session, next, saved.revision);
  assert.equal(saved.usedBytes, MAX_SIGNATURES_BYTES); assert.equal(Buffer.byteLength(f.values.get(SIGNATURES_ENTRY)), MAX_SIGNATURES_BYTES);
  next = body(saved); next.items[0].html += 'x'; const before = new Map(f.values), writes = f.writes().length;
  await assert.rejects(f.service.put(session, next, saved.revision), { statusCode: 413 }); assert.deepEqual(f.values, before); assert.equal(f.writes().length, writes);
});
test('save: mirror plus all non-signature prefs exactly 64KiB accepted; one byte over rejected', async () => {
  const f = fixture(); let result = await seed(f), input = body(result);
  const size = Buffer.byteLength(f.values.get(PREFS_ENTRY)); input.items[0].html += 'x'.repeat(65536 - size);
  result = await f.service.put(session, input, result.revision); assert.equal(Buffer.byteLength(f.values.get(PREFS_ENTRY)), 65536);
  input = body(result); input.items[0].html += 'x'; const before = new Map(f.values);
  await assert.rejects(f.service.put(session, input, result.revision), { statusCode: 413, code: 'SIGNATURE_MIRROR_TOO_LARGE' }); assert.deepEqual(f.values, before);
});
test('partial write: log only account/key hashes, block subsequent list/save/image references for the account', async t => {
  const records = []; t.mock.method(console, 'error', line => records.push(JSON.parse(line)));
  const fail = {}, f = fixture({ fail }); const initial = await seed(f), input = body(initial); input.items[0].html = 'sensitive synthetic content'; fail.mode = 'partial';
  await assert.rejects(f.service.put(session, input, initial.revision), { statusCode: 503, code: 'SIGNATURE_SYNC_FAILED' });
  assert.equal(records.length, 1); assert.equal(records[0].email, session.email); assert.equal(records[0].keys.length, 2);
  for (const state of records[0].keys) { assert.deepEqual(Object.keys(state), ['key', 'expectedHash', 'previousHash', 'observedHash']); for (const field of ['expectedHash', 'previousHash', 'observedHash']) assert.match(state[field], /^[a-f0-9]{64}$/); }
  assert.equal(JSON.stringify(records).includes('sensitive'), false); fail.mode = undefined;
  await assert.rejects(f.service.get(session), { code: 'SIGNATURE_SYNC_FAILED' });
  await assert.rejects(f.service.put(session, input, initial.revision), { code: 'SIGNATURE_SYNC_FAILED' });
  await assert.rejects(f.internal(client => f.service.getReferences({ session, client })), { code: 'SIGNATURE_SYNC_FAILED' });
});
test('reserved malformed/encoded image CIDs block reference scan instead of allowing deletion', async () => {
  const f = fixture(); const initial = await seed(f), doc = JSON.parse(f.values.get(SIGNATURES_ENTRY));
  for (const src of [`cid:wm-sig-v1.bad@signature.invalid`, `cid:wm-sig-v1%2E${asset}@signature.invalid`, `CID:wm-sig-v1.${asset}@signature.invalid`]) {
    doc.items[0].html = `<img src="${src}">`; f.values.set(SIGNATURES_ENTRY, JSON.stringify(doc));
    await assert.rejects(f.internal(client => f.service.getReferences({ session, client })), { statusCode: 503 });
  }
  assert.ok(initial.revision);
});
test('concurrent sessions for one account serialize list revisions and permit exactly one stale-snapshot save', async () => {
  const f = fixture(), initial = await seed(f), input = body(initial); input.items[0].html = 'one of two';
  const results = await Promise.allSettled([f.service.put(session, input, initial.revision), f.service.put({ ...session }, input, initial.revision)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'SIGNATURE_CONFLICT');
});

test('defaults: cannot newly select an item omitted from the saved list', async () => {
  const f = fixture(); const result = await seed(f, 2), input = body(result);
  const removed = input.items.pop(); input.defaults[alias].newDefault = removed.id;
  await assert.rejects(f.service.put(session, input, result.revision), { statusCode: 422 });
});
test('legacy/imported items can be renamed to ordinary display names and remain readable', async () => {
  const f = fixture({ signatures: { [session.email]: { html: 'old', auto: true } } });
  let result = await f.service.get(session); const initialId = result.items[0].id;
  let input = body(result); input.items[0].name = '외부 연락용';
  result = await f.service.put(session, input, result.revision); result = await f.service.get(session);
  assert.equal(result.items[0].id, initialId); assert.equal(result.items[0].name, '외부 연락용');
  const prefs = JSON.parse(f.values.get(PREFS_ENTRY)); prefs.signatures[session.email].html = 'changed'; f.values.set(PREFS_ENTRY, JSON.stringify(prefs));
  result = await f.service.get(session); const importedId = result.items[1].id;
  input = body(result); input.items[1].name = '가져온 서명';
  result = await f.service.put(session, input, result.revision); result = await f.service.get(session);
  assert.equal(result.items[1].id, importedId); assert.equal(result.items[1].name, '가져온 서명');
  assert.ok(JSON.parse(f.values.get(SIGNATURES_ENTRY)).items[1].importSource);
});

test('image deletion integration: nondefault signature blocks deletion, last active reference removal permits it despite migration backup', async () => {
  const f = fixture(), images = createSignatureImagesService({ imap: f.imap, getReferences: f.service.getReferences });
  const bytes = Buffer.alloc(13); bytes.write('GIF89a'); bytes.writeUInt16LE(1, 6); bytes.writeUInt16LE(1, 8);
  const uploaded = await images.upload(session, { name: 'synthetic.gif', bytes }, '0');
  const html = `<img src="cid:wm-sig-v1.${uploaded.image.id}@signature.invalid">`;
  f.values.set(PREFS_ENTRY, JSON.stringify({ signatures: { [session.email]: { html, auto: false } } }));
  let result = await f.service.get(session), input = body(result); input.items[0].html = '<p>edited</p>'; input.items.push({ id: 'client-active', name: '비기본 이미지', html });
  result = await f.service.put(session, input, result.revision);
  const imageBefore = f.values.get(SIGNATURE_IMAGES_ENTRY);
  await assert.rejects(images.delete(session, uploaded.image.id, uploaded.revision), { statusCode: 409, code: 'SIGNATURE_IMAGE_IN_USE' }); assert.equal(f.values.get(SIGNATURE_IMAGES_ENTRY), imageBefore);
  input = body(result); input.items.pop(); await f.service.put(session, input, result.revision);
  const stored = JSON.parse(f.values.get(SIGNATURES_ENTRY)); assert.ok(Buffer.from(stored.migration.originalPrefsBase64, 'base64').toString('utf8').includes(uploaded.image.id));
  await images.delete(session, uploaded.image.id, uploaded.revision);
  assert.deepEqual((await images.get(session)).images, []);
});
