import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSignaturesService, SIGNATURES_ENTRY, signatureMirrorHash, MAX_SIGNATURES_BYTES } from '../../server/signatures.js';
import { PREFS_ENTRY } from '../../server/prefs.js';
import { withSignatureStoreLock } from '../../server/signature-store-lock.js';

const session = { email: 'sender@example.invalid' }, second = 'second@example.invalid';
const sha256 = value => createHash('sha256').update(value).digest('hex');
function fixture(raw = null, control = {}) {
  const values = new Map(raw === null ? [] : [[PREFS_ENTRY, raw]]), commands = [];
  let active = 0;
  const client = { enabled: new Set(), capabilities: new Map(), async exec(command, args, { untagged }) {
    assert.equal(active, 1); commands.push({ command, args });
    if (command === 'GETMETADATA') {
      const key = args[2].value;
      assert.deepEqual(args, [[{ type: 'ATOM', value: 'MAXSIZE' }, { type: 'ATOM', value: String(key === PREFS_ENTRY ? 65536 : 262144) }], { type: 'STRING', value: '' }, { type: 'STRING', value: key }]);
      if (control.longEntries) { const error = new Error('synthetic LONGENTRIES'); error.response = { attributes: [{ section: [{ value: 'METADATA' }, { value: 'LONGENTRIES' }, { value: '262145' }] }] }; throw error; }
      untagged.METADATA({ attributes: [{ value: '' }, [{ value: key }, { value: values.get(key) ?? null }]] });
    } else {
      assert.equal(command, 'SETMETADATA'); assert.deepEqual(args[0], { type: 'STRING', value: '' });
      assert.equal(args[1].length, control.allowMirror ? 4 : 2);
      assert.deepEqual(args[1][0], { type: 'STRING', value: SIGNATURES_ENTRY }); assert.equal(args[1][1].type, 'LITERAL'); assert.ok(Buffer.isBuffer(args[1][1].value));
      if (control.failBefore) throw new Error('synthetic before write');
      for (let i = 0; i < args[1].length; i += 2) values.set(args[1][i].value, args[1][i + 1].value.toString('utf8'));
      if (control.ackLost) throw new Error('synthetic ACK loss');
    }
    return { next() {} };
  } };
  const imap = { async withMailbox(received, path, operation) {
    assert.equal(received, session); assert.equal(path, 'INBOX'); assert.equal(active, 0); active++;
    try { return await operation(client); } finally { active--; }
  } };
  const service = createSignaturesService({ imap, normalizeHtml: async ({ html }) => html, getIdentities: async () => [session.email, second] });
  return { service, values, commands, writes: () => commands.filter(item => item.command === 'SETMETADATA'), internal: operation => withSignatureStoreLock(session.email, () => imap.withMailbox(session, 'INBOX', operation)) };
}
const snapshot = result => ({ items: result.items.map(({ id, name, html }) => ({ id, name, html })), defaults: structuredClone(result.defaults) });
const editMirror = (f, signatures) => { const prefs = JSON.parse(f.values.get(PREFS_ENTRY)); prefs.signatures = signatures; f.values.set(PREFS_ENTRY, JSON.stringify(prefs)); };

test('first migration: per-address stable IDs, true/false/empty entries, both defaults and original bytes/hash/base64', async () => {
  const raw = '{\n "signatures": {" Sender@Example.Invalid ": {"html":"<p>같은 원문</p>","auto":true}, "second@example.invalid":{"html":"<p>같은 원문</p>","auto":false}, "empty@example.invalid":{"html":"","auto":true}},"theme":"synthetic"\n}';
  const f = fixture(raw), result = await f.service.get(session), stored = JSON.parse(f.values.get(SIGNATURES_ENTRY));
  assert.equal(result.items.length, 3);
  for (const item of result.items) { assert.equal(item.id, `legacy-v1-${sha256(item.name)}`); assert.equal(item.createdAt, item.updatedAt); }
  assert.notEqual(result.items[0].id, result.items[1].id);
  assert.deepEqual(result.defaults[session.email], { newDefault: result.items[0].id, replyDefault: result.items[0].id });
  assert.deepEqual(result.defaults[second], { newDefault: null, replyDefault: null });
  assert.equal(result.items[2].html, ''); assert.equal(result.defaults['empty@example.invalid'].newDefault, result.items[2].id);
  assert.equal(f.values.get(PREFS_ENTRY), raw); assert.equal(stored.migration.originalPrefsSha256, sha256(raw)); assert.equal(Buffer.from(stored.migration.originalPrefsBase64, 'base64').toString('utf8'), raw);
  assert.equal(stored.mirror.lastWrittenHash, null); assert.equal(stored.mirror.lastObservedHash, signatureMirrorHash(JSON.parse(raw)));
  assert.equal(stored.mirror.addresses[session.email].lastWrittenHash, null); assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].args[1][1].value.toString('utf8'), f.values.get(SIGNATURES_ENTRY));
  assert.equal(result.migration, undefined); assert.equal(result.mirror, undefined);
  assert.deepEqual(await f.service.get(session), result); assert.equal(f.writes().length, 1);
});
test('mirror fallback: first legacy manual signature survives saves, defaults and re-upgrades without false imports', async () => {
  const raw = JSON.stringify({ signatures: { [session.email]: { html: 'automatic', auto: true }, [second]: { html: 'manual legacy', auto: false } }, theme: 'old' });
  const control = {}, f = fixture(raw, control);
  let result = await f.service.get(session);
  const originalMigration = JSON.parse(f.values.get(SIGNATURES_ENTRY)).migration;
  const legacyId = result.items.find(item => item.name === second).id;
  assert.equal(f.values.get(PREFS_ENTRY), raw);
  control.allowMirror = true;
  async function save(input, expected) {
    result = await f.service.put(session, input, result.revision);
    const prefs = JSON.parse(f.values.get(PREFS_ENTRY)), stored = JSON.parse(f.values.get(SIGNATURES_ENTRY));
    assert.deepEqual(prefs.signatures[second], expected);
    assert.equal(stored.mirror.lastWrittenHash, signatureMirrorHash(prefs));
    assert.equal(stored.mirror.lastObservedHash, stored.mirror.lastWrittenHash);
    assert.deepEqual(stored.migration, originalMigration);
    // The old version can save unrelated settings with the same signature mirror.
    f.values.set(PREFS_ENTRY, JSON.stringify({ ...prefs, theme: 'old-version-save' }));
    for (let n = 0; n < 2; n++) {
      const upgraded = await f.service.get(session);
      assert.deepEqual(upgraded.items, result.items);
      assert.equal(upgraded.revision, result.revision);
      assert.deepEqual(upgraded.notices, []);
    }
  }
  await save(snapshot(result), { html: 'manual legacy', auto: false });
  let input = snapshot(result);
  input.items.push({ id: 'client-reply', name: 'Reply', html: 'reply fallback' }, { id: 'client-new', name: 'New', html: 'new priority' });
  input.defaults[second].replyDefault = 'client-reply';
  await save(input, { html: 'reply fallback', auto: false });
  const newId = result.idMap['client-new'];
  input = snapshot(result); input.defaults[second].newDefault = newId;
  await save(input, { html: 'new priority', auto: true });
  input = snapshot(result); input.defaults[second].newDefault = null;
  await save(input, { html: 'reply fallback', auto: false });
  input = snapshot(result); input.defaults[second].replyDefault = null;
  const legacy = input.items.find(item => item.id === legacyId); legacy.name = 'Renamed legacy'; legacy.html = 'edited legacy';
  await save(input, { html: 'edited legacy', auto: false });
  input = snapshot(result); input.items = input.items.filter(item => item.id !== legacyId);
  await save(input, { html: '', auto: false });
});
test('first migration: absent prefs and empty signatures produce empty list; no prefs key created', async () => {
  const f = fixture(), result = await f.service.get(session);
  assert.deepEqual(result.items, []); assert.deepEqual(result.defaults, {}); assert.equal(f.values.has(PREFS_ENTRY), false); assert.equal(f.writes().length, 1);
  assert.equal(JSON.parse(f.values.get(SIGNATURES_ENTRY)).migration.originalPrefsSha256, sha256(''));
});
test('first migration: data images and unsafe legacy source remain byte-exact in backup and item', async () => {
  const html = '<p onclick="synthetic()">원문</p><img src="data:image/png;base64,AAAA"><script>synthetic()</script>', raw = JSON.stringify({ signatures: { [session.email]: { html, auto: true } } });
  const f = fixture(raw), result = await f.service.get(session);
  assert.equal(result.items[0].html, html); assert.equal(f.values.get(PREFS_ENTRY), raw);
  assert.equal(Buffer.from(JSON.parse(f.values.get(SIGNATURES_ENTRY)).migration.originalPrefsBase64, 'base64').toString('utf8'), raw);
});
test('first migration: oversized aggregate creates no key, never truncates or partly migrates', async () => {
  const signatures = Object.fromEntries(Array.from({ length: 450 }, (_, n) => [`synthetic-${n}@example.invalid`, { html: '합성', auto: true }]));
  const raw = JSON.stringify({ signatures }); assert.ok(Buffer.byteLength(raw) < 65536);
  const f = fixture(raw); await assert.rejects(f.service.get(session), { statusCode: 413, code: 'SIGNATURE_MIGRATION_TOO_LARGE' });
  assert.equal(f.values.has(SIGNATURES_ENTRY), false); assert.equal(f.values.get(PREFS_ENTRY), raw); assert.equal(f.writes().length, 0);
});
test('first migration: invalid/oversized prefs, malformed mirror and LONGENTRIES are never treated as NIL', async () => {
  for (const raw of ['bad', '[]', '{"signatures":[]}', '{"signatures":null}', '{"signatures":{"sender@example.invalid":{"html":4,"auto":true}}}', JSON.stringify({ signatures: {} }) + ' '.repeat(65536)]) {
    const f = fixture(raw); await assert.rejects(f.service.get(session), { statusCode: 503 }); assert.equal(f.values.get(PREFS_ENTRY), raw); assert.equal(f.values.has(SIGNATURES_ENTRY), false); assert.equal(f.writes().length, 0);
  }
  const f = fixture(null, { longEntries: true }); await assert.rejects(f.service.get(session), { statusCode: 503, code: 'METADATA_TOO_LARGE' }); assert.equal(f.writes().length, 0);
});
test('migration ACK loss: re-read recognizes applied single-key write, subsequent requests do not duplicate', async () => {
  const f = fixture(JSON.stringify({ signatures: { [session.email]: { html: 'original', auto: true } } }), { ackLost: true });
  const result = await f.service.get(session); assert.equal(result.items.length, 1); assert.equal((await f.service.get(session)).revision, result.revision); assert.equal(f.writes().length, 1);
});
test('re-upgrade: changed HTML/auto and added address import exactly once; defaults, Written, original and actual mirror stay unchanged', async () => {
  const f = fixture(JSON.stringify({ signatures: { [session.email]: { html: 'original', auto: true }, [second]: { html: 'second', auto: false } } }));
  const initial = await f.service.get(session), before = JSON.parse(f.values.get(SIGNATURES_ENTRY));
  editMirror(f, { [session.email]: { html: 'changed', auto: false }, [second]: { html: 'second', auto: true }, 'added@example.invalid': { html: 'added', auto: true } });
  const mirror = f.values.get(PREFS_ENTRY), result = await f.service.get(session), stored = JSON.parse(f.values.get(SIGNATURES_ENTRY));
  assert.equal(result.items.length, 5); assert.deepEqual(result.defaults, initial.defaults); assert.equal(result.notices.filter(item => item.code === 'SIGNATURE_LEGACY_IMPORTED').length, 3);
  assert.equal(f.values.get(PREFS_ENTRY), mirror); assert.deepEqual(stored.migration, before.migration); assert.equal(stored.mirror.lastWrittenHash, before.mirror.lastWrittenHash);
  for (const item of stored.items.slice(2)) { assert.equal(item.name, `예전 판에서 고친 서명 — ${item.importSource.address}`); assert.equal(item.id, `import-v1-${sha256(JSON.stringify([item.importSource.address, item.importSource.hash]))}`); assert.equal(item.importSource.present, true); }
  const repeated = await f.service.get(session); assert.equal(repeated.items.length, 5); assert.equal(repeated.revision, result.revision); assert.equal(f.writes().length, 2);
  // Cycling back to a previously imported address/hash must not create another item.
  editMirror(f, { [session.email]: { html: 'third', auto: true } }); await f.service.get(session);
  editMirror(f, { [session.email]: { html: 'changed', auto: false } });
  const cycled = await f.service.get(session); assert.equal(cycled.items.filter(item => item.html === 'changed').length, 1);
});
test('re-upgrade: empty HTML/address deletion add zero items, retain all defaults and record present=false notices', async () => {
  const f = fixture(JSON.stringify({ signatures: { [session.email]: { html: 'original', auto: true }, [second]: { html: 'second', auto: true } } })), initial = await f.service.get(session);
  editMirror(f, { [session.email]: { html: '', auto: false } }); const mirror = f.values.get(PREFS_ENTRY);
  const result = await f.service.get(session), stored = JSON.parse(f.values.get(SIGNATURES_ENTRY));
  assert.deepEqual(result.items, initial.items); assert.deepEqual(result.defaults, initial.defaults); assert.equal(result.notices.length, 2); assert.ok(result.notices.every(item => item.code === 'SIGNATURE_LEGACY_DELETED'));
  assert.equal(stored.mirror.addresses[session.email].present, false); assert.equal(stored.mirror.addresses[second].present, false); assert.equal(f.values.get(PREFS_ENTRY), mirror);
  assert.notEqual(stored.mirror.addresses[session.email].lastObservedHash, stored.mirror.addresses[second].lastObservedHash);
  assert.deepEqual((await f.service.get(session)).notices, result.notices); assert.equal(f.writes().length, 2);
});
test('re-upgrade: preserve data HTML in imported item, hide internal importSource in response', async () => {
  const f = fixture(JSON.stringify({ signatures: {} })); await f.service.get(session);
  const html = '<img src="data:image/png;base64,AAAA">'; editMirror(f, { [session.email]: { html, auto: true } });
  const result = await f.service.get(session); assert.equal(result.items[0].html, html); assert.equal(result.items[0].importSource, undefined);
  assert.equal(JSON.parse(f.values.get(SIGNATURES_ENTRY)).items[0].importSource.address, session.email);
});
test('re-upgrade overflow: all items, Observed, revision and prefs unchanged; image-reference query blocked', async () => {
  const f = fixture(JSON.stringify({ signatures: { [session.email]: { html: 'original', auto: true } } })); await f.service.get(session);
  const doc = JSON.parse(f.values.get(SIGNATURES_ENTRY));
  doc.items[0].html += 'x'.repeat(MAX_SIGNATURES_BYTES - Buffer.byteLength(JSON.stringify(doc)) - 80);
  f.values.set(SIGNATURES_ENTRY, JSON.stringify(doc));
  editMirror(f, { [session.email]: { html: 'changed '.repeat(300), auto: true }, [second]: { html: 'second change', auto: true } });
  const before = new Map(f.values), writes = f.writes().length;
  await assert.rejects(f.service.get(session), { statusCode: 413, code: 'SIGNATURE_MIGRATION_TOO_LARGE' }); assert.deepEqual(f.values, before);
  await assert.rejects(f.internal(client => f.service.getReferences({ session, client })), { statusCode: 413 }); assert.deepEqual(f.values, before); assert.equal(f.writes().length, writes);
});
test('re-upgrade malformed mirror blocks import/save/references without replacing any stored value', async () => {
  const f = fixture(JSON.stringify({ signatures: {} })); const result = await f.service.get(session);
  editMirror(f, { [session.email]: { html: 'bad', auto: true, unexpected: true } }); const before = new Map(f.values);
  await assert.rejects(f.service.get(session), { statusCode: 503 });
  await assert.rejects(f.service.put(session, snapshot(result), result.revision), { statusCode: 503 });
  await assert.rejects(f.internal(client => f.service.getReferences({ session, client })), { statusCode: 503 }); assert.deepEqual(f.values, before);
});
test('re-upgrade detected by PUT: import first, reject stale revision, leave actual mirror until explicit fresh save', async () => {
  const control = {}, f = fixture(JSON.stringify({ signatures: { [session.email]: { html: 'original', auto: true } } }), control);
  const initial = await f.service.get(session); editMirror(f, { [session.email]: { html: 'legacy changed', auto: true } }); const raw = f.values.get(PREFS_ENTRY);
  await assert.rejects(f.service.put(session, snapshot(initial), initial.revision), { statusCode: 409, code: 'SIGNATURE_CONFLICT' }); assert.equal(f.values.get(PREFS_ENTRY), raw);
  const current = await f.service.get(session); assert.equal(current.items.length, 2); control.allowMirror = true;
  const saved = await f.service.put(session, snapshot(current), current.revision); assert.equal(saved.items.length, 2); assert.equal(JSON.parse(f.values.get(PREFS_ENTRY)).signatures[session.email].html, 'original');
  const stored = JSON.parse(f.values.get(SIGNATURES_ENTRY)); assert.equal(stored.mirror.lastWrittenHash, stored.mirror.lastObservedHash);
});
test('hash: stable normalized address sorting, raw whitespace significant, missing differs from empty false', () => {
  const a = { signatures: { 'B@Example.Invalid': { html: 'raw', auto: true }, 'a@example.invalid': { html: 'x', auto: false } } };
  const b = { signatures: { 'a@example.invalid': { html: 'x', auto: false }, 'b@example.invalid': { html: 'raw', auto: true } } };
  assert.equal(signatureMirrorHash(a), signatureMirrorHash(b)); b.signatures['b@example.invalid'].html = 'raw '; assert.notEqual(signatureMirrorHash(a), signatureMirrorHash(b));
  assert.notEqual(signatureMirrorHash({ signatures: {} }), signatureMirrorHash({ signatures: { [session.email]: { html: '', auto: false } } }));
});

test('long legacy address names: migration/import preserve full names, unchanged-name content edits allowed, renames remain 200 bytes', async () => {
  const longAddress = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.invalid`;
  const control = {}, f = fixture(JSON.stringify({ signatures: { [longAddress]: { html: 'original', auto: true } } }), control);
  let result = await f.service.get(session); assert.equal(result.items[0].name, longAddress); assert.ok(Buffer.byteLength(longAddress) > 200);
  let input = snapshot(result); input.items[0].html = 'edited'; control.allowMirror = true;
  result = await f.service.put(session, input, result.revision); assert.equal(result.items[0].name, longAddress); assert.equal(result.items[0].html, 'edited');
  input = snapshot(result); input.items[0].name = 'x'.repeat(201);
  await assert.rejects(f.service.put(session, input, result.revision), { statusCode: 422 });
  editMirror(f, { [longAddress]: { html: 'legacy changed', auto: true } }); control.allowMirror = false;
  result = await f.service.get(session); assert.equal(result.items.length, 2); assert.equal(result.items[1].name, `예전 판에서 고친 서명 — ${longAddress}`);
  input = snapshot(result); input.items[1].html = 'import edited'; control.allowMirror = true;
  result = await f.service.put(session, input, result.revision); assert.equal(result.items[1].html, 'import edited');
  input = snapshot(result); input.items[1].name = '가'.repeat(67);
  await assert.rejects(f.service.put(session, input, result.revision), { statusCode: 422 });
});
test('unchanged initial empty legacy entry does not acquire a deletion notice when another address changes', async () => {
  const f = fixture(JSON.stringify({ signatures: { [session.email]: { html: '', auto: false }, [second]: { html: 'old', auto: true } } }));
  await f.service.get(session); editMirror(f, { [session.email]: { html: '', auto: false }, [second]: { html: 'changed', auto: true } });
  const result = await f.service.get(session); assert.equal(result.notices.length, 1); assert.equal(result.notices[0].code, 'SIGNATURE_LEGACY_IMPORTED');
});

test('NIL list: image references and prefs preparation preserve raw mirror bytes and never initiate migration', async () => {
  const assetId = 'a'.repeat(32), raw = `{ "theme": "old", "signatures": {"${session.email}": {"html":"<img src=\\"cid:wm-sig-v1.${assetId}@signature.invalid\\">", "auto":false}} }`;
  const f = fixture(raw);
  const refs = await f.internal(client => f.service.getReferences({ session, client }));
  assert.deepEqual(refs, [{ id: null, name: `${session.email} (예전 판 서명)`, assetIds: [assetId] }]);
  const prepared = await f.internal(client => f.service.preparePrefs({ session, client, prefs: { theme: 'new', signatures: {} } }));
  assert.equal(prepared.mirrorSync, false); assert.deepEqual(prepared.prefs.signatures, JSON.parse(raw).signatures); assert.equal(prepared.prefs.theme, 'new');
  assert.equal(f.values.has(SIGNATURES_ENTRY), false); assert.equal(f.values.get(PREFS_ENTRY), raw); assert.equal(f.writes().length, 0);
});
test('migration-overflow account: NIL-list reference scan still includes every legacy mirror address', async () => {
  const assetId = 'b'.repeat(32), html = `<img src="cid:wm-sig-v1.${assetId}@signature.invalid">`;
  const signatures = Object.fromEntries(Array.from({ length: 420 }, (_, n) => [`synthetic-${n}@example.invalid`, { html, auto: false }]));
  const raw = JSON.stringify({ signatures }); assert.ok(Buffer.byteLength(raw) <= 65536);
  const f = fixture(raw); await assert.rejects(f.service.get(session), { statusCode: 413, code: 'SIGNATURE_MIGRATION_TOO_LARGE' });
  const refs = await f.internal(client => f.service.getReferences({ session, client }));
  assert.equal(refs.length, 420); assert.ok(refs.every(ref => ref.id === null && ref.assetIds.length === 1 && ref.assetIds[0] === assetId));
  assert.equal(f.values.has(SIGNATURES_ENTRY), false); assert.equal(f.values.get(PREFS_ENTRY), raw); assert.equal(f.writes().length, 0);
});
