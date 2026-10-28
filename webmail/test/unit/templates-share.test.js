import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { encodePath, decodePath } from 'imapflow/lib/tools.js';
import { AppError } from '../../server/errors.js';
import { encodeRef, decodeRef, assertUidValidity } from '../../server/mail/ref.js';
import { createTemplateStore, templatesFolder, sharedTemplatesFolder } from '../../server/templates/store.js';
import { templateMime } from '../../server/templates/mime.js';
import { clearInheritedTemplateAcl, createTemplateShareService, decodeSharedTemplateRef } from '../../server/templates/share.js';

const viewer = 'viewer@example.com', owner = 'author@example.com', reader = 'reader@example.com', other = 'other@other.example';
const received = `Shared/${owner}/Templates/공유`;
const config = { attachMaxMb: 1 };
const rawBody = Buffer.from('--synthetic\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>{{오늘}}</p><img src="cid:logo@example">\r\n--synthetic\r\nContent-Type: image/png\r\nContent-ID: <logo@example>\r\nContent-Transfer-Encoding: base64\r\n\r\nc3ludGhldGljLWltYWdl\r\n--synthetic\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="sample.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAP8AAQ==\r\n--synthetic--\r\n');
function raw(id = randomUUID(), name = '공유 {{오늘}}') {
  return templateMime(Buffer.concat([Buffer.from('From: author@example.com\r\nTo: private@example.com\r\nSubject: Shared subject\r\nDate: Wed, 28 Oct 2026 05:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="synthetic"\r\n\r\n'), rawBody]), { id, name });
}
const structure = { type: 'multipart/mixed', childNodes: [
  { part: '1', type: 'text/html', size: 100 },
  { part: '2', type: 'image/png', id: '<logo@example>', size: 15 },
  { part: '3', type: 'application/octet-stream', disposition: 'attachment', dispositionParameters: { filename: 'sample.bin' }, size: 4 },
] };
function fixture({ folders = ['INBOX', templatesFolder, sharedTemplatesFolder, received], utf8 = true } = {}) {
  const f = { session: { email: viewer, connection: {}, prefs: { sharedView: { [owner]: false } } }, calls: [], acl: new Map(), folders: new Map(), accounts: [viewer, reader, other].map(username => ({ username, active: 1 })), directoryCalls: 0, locks: 0 };
  function folder(path) {
    const result = { validity: f.folders.size + 100, nextUid: 1, rows: new Map() };
    f.folders.set(path, result); f.acl.set(path, new Map([[viewer, 'lrswipkxteacd']]));
    return result;
  }
  folders.forEach(folder);
  function add(path, { id, name, bytes = raw(id, name), uid } = {}) {
    const box = f.folders.get(path) ?? folder(path), number = uid ?? box.nextUid++;
    box.nextUid = Math.max(box.nextUid, number + 1);
    box.rows.set(number, { uid: number, source: Buffer.from(bytes), headers: bytes.subarray(0, bytes.indexOf('\r\n\r\n') + 4), size: bytes.length, flags: new Set(), bodyStructure: structuredClone(structure) });
    return encodeRef(path, box.validity, number);
  }
  function client(path = 'INBOX') {
    const box = f.folders.get(path);
    if (!box) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'synthetic missing');
    const value = {
      options: { auth: { user: f.authUser ?? viewer } }, enabled: new Set(utf8 ? ['UTF8=ACCEPT'] : []), capabilities: new Set(['UIDPLUS', 'MOVE']),
      mailbox: { path, uidValidity: BigInt(box.validity), exists: box.rows.size },
      async list(options) { f.calls.push(['list', path, options]); return [...f.folders.keys()].filter(name => !f.hidden?.has(name)).map(path => ({ path })); },
      async exec(command, args, options = {}) {
        const mailbox = decodePath(value, args[0]?.value);
        f.calls.push([command, mailbox, ...args.slice(1).map(arg => arg.value)]);
        if (f.failCommand === command) throw new Error('synthetic ACL failure');
        if (command === 'GETACL') {
          const acl = f.acl.get(mailbox) ?? new Map();
          options.untagged.ACL({ attributes: f.malformedAcl ? [{ value: encodePath(value, mailbox) }, { value: 'unpaired' }] : [{ value: encodePath(value, mailbox) }, ...[...acl].flatMap(([id, rights]) => [{ value: Buffer.from(id) }, { value: Buffer.from(rights) }])] });
        } else if (command === 'SETACL') {
          assert.equal(mailbox, sharedTemplatesFolder); assert.equal(args[2].value, 'lr');
          if (!f.ignoreWrites) f.acl.get(mailbox).set(args[1].value, args[2].value);
        } else if (command === 'DELETEACL') {
          assert.ok([templatesFolder, sharedTemplatesFolder].includes(mailbox));
          if (!f.ignoreWrites) f.acl.get(mailbox).delete(args[1].value);
        } else assert.fail(`Unexpected command ${command}`);
        return { next() {} };
      },
      async *fetch(set, query, options) { f.calls.push(['fetch', path, set, query, options]); for (const row of box.rows.values()) yield row; },
      async fetchOne(uid, query, options) { f.calls.push(['fetchOne', path, uid, query, options]); return box.rows.get(uid); },
      async download(uid, part, options) { f.calls.push(['download', path, uid, part, options]); return { content: Readable.from([Buffer.from('<p>{{오늘}}</p><script>evil()</script><img src="cid:logo@example">')]), meta: { charset: 'utf-8' } }; },
      async messageFlagsAdd() { f.calls.push(['STORE', path]); assert.fail('Shared read must never STORE'); },
      async append(target, bytes, flags) {
        assert.ok(!target.startsWith('Shared/')); f.calls.push(['APPEND', target]);
        if (f.failAppend) throw new Error('synthetic quota');
        const ref = add(target, { bytes }), parsed = decodeRef(ref); f.folders.get(target).rows.get(parsed.uid).flags = new Set(flags);
        return { uid: parsed.uid, uidValidity: BigInt(parsed.uidValidity) };
      },
      async mailboxCreate(target) { f.calls.push(['CREATE', target]); folder(target); f.acl.set(target, new Map(f.acl.get('INBOX'))); return { path: target }; },
      async status(target) { return { messages: f.folders.get(target).rows.size }; },
      async mailboxDelete(target) { f.calls.push(['DELETE', target]); f.folders.delete(target); f.acl.delete(target); return { path: target }; },
    };
    return value;
  }
  const imap = {
    async withMailbox(session, path, operation) {
      assert.equal(session.email.toLowerCase(), viewer); assert.equal(f.locks, 0, 'mailbox operations must not be nested'); f.locks++;
      try { return await operation(client(path)); } finally { f.locks--; }
    },
    async withFreshConnection(session, operation) { f.calls.push(['fresh']); assert.equal(f.locks, 0); return operation(client()); },
    refreshShared(session, paths) { f.calls.push(['refresh', paths]); },
    async withRef(session, token, operation) { const ref = decodeRef(token); return this.withMailbox(session, ref.path, current => { assertUidValidity(current, ref); return operation(current, ref); }); },
  };
  const store = createTemplateStore({ imap, config, onFolderCreated: clearInheritedTemplateAcl, async buildMime() { assert.fail('Shared copy must preserve raw MIME rather than rebuild'); } });
  const service = createTemplateShareService({ imap, config, store, async activeAccounts(session) { assert.equal(session, f.session); f.directoryCalls++; return structuredClone(f.accounts); } });
  return Object.assign(f, { add, client, imap, store, service });
}
const writes = f => f.calls.filter(row => ['SETACL', 'DELETEACL', 'CREATE', 'DELETE', 'STORE', 'APPEND'].includes(row[0]));
const sourceOf = (f, token) => { const ref = decodeRef(token); return f.folders.get(ref.path)?.rows.get(ref.uid)?.source; };
const bodyOf = value => value.subarray(value.indexOf('\r\n\r\n') + 4);

test('template sharing: GET is non-creating and reports only exact lr targets plus INBOX readers', async () => {
  const f = fixture({ folders: ['INBOX'] });
  f.acl.set('INBOX', new Map([[viewer, 'lrsw'], [reader, 'lrs'], [other, 'lr'], ['not-reader@example.com', 'l'], ['$example.com', 'lr'], ['$staff@example.com', 'lr'], ['-negative@example.com', 'lr'], ['anyone', 'lr']]));
  assert.deepEqual(await f.service.get(f.session), { domainAll: false, domain: 'example.com', users: [], inboxReaders: [other, reader].sort() });
  assert.equal(writes(f).length, 0); assert.equal(f.directoryCalls, 0);
});

test('template sharing: PUT manages users and own-domain lr only, with readback and unrelated manual ACL preserved', async () => {
  const f = fixture();
  const manual = [['owner', 'lrswipkxteacd'], [viewer, 'lrswipkxteacd'], ['anyone', 'lr'], ['authenticated', 'lrs'], ['$other.example', 'lr'], ['manual@example.com', 'lrs'], ['-negative@example.com', 'lr'], ['$staff@example.com', 'lr']];
  f.acl.set(sharedTemplatesFolder, new Map([...manual, ['old@example.com', 'rl']]));
  const value = await f.service.put(f.session, { domainAll: true, users: [reader.toUpperCase(), other] });
  assert.deepEqual(value, { domainAll: true, domain: 'example.com', users: [other, reader].sort(), inboxReaders: [] });
  for (const [id, rights] of manual) assert.equal(f.acl.get(sharedTemplatesFolder).get(id), rights);
  assert.equal(f.acl.get(sharedTemplatesFolder).has('old@example.com'), false);
  assert.deepEqual(writes(f).map(row => row.slice(0, 3)), [['DELETEACL', sharedTemplatesFolder, 'old@example.com'], ['SETACL', sharedTemplatesFolder, reader], ['SETACL', sharedTemplatesFolder, other], ['SETACL', sharedTemplatesFolder, '$example.com']]);
  f.calls = [];
  await f.service.put(f.session, { domainAll: true, users: [reader, other] }); assert.equal(writes(f).length, 0);
  await f.service.put(f.session, { domainAll: false, users: [] });
  assert.deepEqual([...f.acl.get(sharedTemplatesFolder)], manual);
});

for (const manual of [[reader, 'lrs'], ['$example.com', 'lrs']]) test(`template sharing: requested manual principal ${manual[0]} conflicts before every write`, async () => {
  const f = fixture(); f.acl.get(sharedTemplatesFolder).set(...manual); f.acl.get(sharedTemplatesFolder).set('old@example.com', 'lr');
  const before = [...f.acl.get(sharedTemplatesFolder)];
  await assert.rejects(f.service.put(f.session, { domainAll: true, users: [reader] }), error => { assert.equal(error.statusCode, 422); assert.equal(error.code, 'TEMPLATE_SHARE_CONFLICT'); assert.ok(error.message.includes(manual[0])); return true; });
  assert.equal(writes(f).length, 0); assert.deepEqual([...f.acl.get(sharedTemplatesFolder)], before);
});

for (const input of [
  { domainAll: true, users: [viewer] }, { domainAll: true, users: ['anyone'] }, { domainAll: true, users: ['authenticated'] },
  { domainAll: true, users: ['$other.example'] }, { domainAll: true, users: [{ address: reader, rights: 'lrs' }] },
  { domainAll: true, users: [reader], rights: 'lrs' }, { domainAll: true, users: [], path: 'INBOX' },
  { domainAll: true, users: [], group: 'other.example' }, { domainAll: true, users: [reader, reader.toUpperCase()] },
  { domainAll: 'true', users: [] }, { users: [] }, { domainAll: true, users: Array.from({ length: 51 }, (_, i) => `user${i}@example.com`) },
]) test(`template sharing: input rejects ${JSON.stringify(input).slice(0, 100)} with no directory/IMAP writes`, async () => {
  const f = fixture(); await assert.rejects(f.service.put(f.session, input), { statusCode: 422 }); assert.equal(f.calls.length, 0); assert.equal(f.directoryCalls, 0);
});

for (const requested of ['alias@example.com', 'disabled@example.com', 'active2@example.com', 'missing@example.com']) test(`template sharing: ${requested} is not a distinct active=1 mailbox`, async () => {
  const f = fixture(); f.accounts.push({ address: 'alias@example.com', active: 1 }, { username: 'disabled@example.com', active: 0 }, { username: 'active2@example.com', active: 2 });
  await assert.rejects(f.service.put(f.session, { domainAll: false, users: [requested] }), { statusCode: 422 }); assert.equal(writes(f).length, 0); assert.equal(f.calls.length, 0);
});

test('template sharing: exactly 50 active users are accepted', async () => {
  const f = fixture(), users = Array.from({ length: 50 }, (_, i) => `user${i}@example.com`);
  f.accounts.push(...users.map(username => ({ username, active: 1 })));
  const result = await f.service.put(f.session, { domainAll: false, users }); assert.equal(result.users.length, 50);
});

for (const utf8 of [true, false]) test(`template sharing: initial ACL hook clears copied entries but keeps owner; UTF8=${utf8}`, async () => {
  const f = fixture({ folders: ['INBOX'], utf8 });
  f.acl.set('INBOX', new Map([['owner', 'lrswipkxteacd'], [viewer, 'lrsw'], [reader, 'lr'], ['$example.com', 'lr'], ['anyone', 'lr']]));
  await f.service.put(f.session, { domainAll: true, users: [other] });
  assert.deepEqual([...f.acl.get(templatesFolder)], [['owner', 'lrswipkxteacd'], [viewer, 'lrsw']]);
  assert.deepEqual([...f.acl.get(sharedTemplatesFolder)], [['owner', 'lrswipkxteacd'], [viewer, 'lrsw'], [other, 'lr'], ['$example.com', 'lr']]);
  assert.equal(f.calls.filter(row => row[0] === 'CREATE').length, 2);
  assert.ok(writes(f).every(row => !row[1].startsWith('Shared/')));
});

test('template sharing: hook account mismatch and outside path stop before GETACL or DELETEACL', async () => {
  const f = fixture(); f.authUser = 'other@example.com';
  await assert.rejects(clearInheritedTemplateAcl(f.client(), sharedTemplatesFolder, f.session), { statusCode: 503 }); assert.equal(f.calls.length, 0);
  f.authUser = viewer;
  await assert.rejects(clearInheritedTemplateAcl(f.client(), 'INBOX', f.session), { statusCode: 422 }); assert.equal(f.calls.length, 0);
});

test('template sharing: hook failure removes only newly created empty folder through store recovery', async () => {
  const f = fixture({ folders: ['INBOX'] }); f.acl.get('INBOX').set(reader, 'lr'); f.failCommand = 'DELETEACL';
  await assert.rejects(f.service.put(f.session, { domainAll: false, users: [other] }), { statusCode: 503 });
  assert.equal(f.folders.has(templatesFolder), false); assert.ok(!f.calls.some(row => row[0] === 'SETACL'));
});

test('template sharing: ignored SETACL fails readback, malformed GETACL fails without mutations', async () => {
  const f = fixture(); f.ignoreWrites = true;
  await assert.rejects(f.service.put(f.session, { domainAll: true, users: [reader] }), { statusCode: 503 });
  const bad = fixture(); bad.malformedAcl = true;
  await assert.rejects(bad.service.put(bad.session, { domainAll: false, users: [reader] }), { statusCode: 503 }); assert.equal(writes(bad).length, 0);
});

test('template sharing: discovers only exact shared template folder despite hidden sharedView, fetches heads only', async () => {
  const f = fixture();
  const valid = f.add(received);
  for (const path of [`Shared/${owner}/Templates`, `Shared/${owner}/Templates/공유/child`, `Shared/${owner}/Templates/공유-old`, `Shared/${owner}/INBOX`, `Shared/${viewer}/Templates/공유`, 'Templates/공유-old']) f.add(path);
  const result = await f.service.list(f.session);
  assert.equal(result.length, 1); assert.equal(result[0].ref, valid); assert.equal(result[0].owner, owner); assert.equal(result[0].inShared, true);
  assert.ok(f.calls.some(row => row[0] === 'fresh')); assert.ok(f.calls.some(row => row[0] === 'refresh'));
  assert.ok(!f.calls.some(row => ['fetchOne', 'download'].includes(row[0]))); assert.equal(writes(f).length, 0);
  for (const call of f.calls.filter(row => row[0] === 'fetch')) { assert.equal(call[1], received); assert.equal(call[3].source, undefined); assert.equal(call[3].bodyParts, undefined); }
});

test('template sharing: identical Id under different owners remains separate; own owner duplicate picks higher UID', async () => {
  const f = fixture(), id = randomUUID(), secondPath = 'Shared/second@example.com/Templates/공유';
  f.add(received, { id, uid: 1 }); const current = f.add(received, { id, uid: 2 }); const second = f.add(secondPath, { id });
  const result = await f.service.list(f.session); assert.equal(result.length, 2); assert.deepEqual(new Set(result.map(row => row.ref)), new Set([current, second])); assert.equal(writes(f).length, 0);
});

test('template sharing: read is sanitized and never STOREs even when unread and source offers write rights', async () => {
  const f = fixture(), token = f.add(received);
  const result = await f.service.read(f.session, token);
  assert.match(result.html, /{{오늘}}/); assert.ok(!result.html.includes('evil')); assert.equal(result.attachments.length, 2);
  assert.equal(writes(f).length, 0); assert.ok(!f.calls.some(row => row[0] === 'MYRIGHTS'));
  assert.deepEqual(Object.keys(f.service).sort(), ['copy', 'get', 'list', 'put', 'read']);
});

test('template sharing: copy uses store, issues new Id and preserves original raw body/attachment/CID', async () => {
  const f = fixture(), id = randomUUID(), token = f.add(received, { id }), original = Buffer.from(sourceOf(f, token));
  const result = await f.service.copy(f.session, token);
  assert.notEqual(result.id, id); assert.equal(result.owner, viewer); assert.equal(result.inShared, false); assert.equal(decodeRef(result.ref).path, templatesFolder);
  assert.deepEqual(sourceOf(f, token), original); assert.deepEqual(bodyOf(sourceOf(f, result.ref)), bodyOf(original));
  assert.deepEqual(writes(f).map(row => row.slice(0, 2)), [['APPEND', templatesFolder]]);
});

test('template sharing: copy at 200 limit or APPEND failure leaves shared original byte exact', async () => {
  for (const full of [true, false]) {
    const f = fixture(), token = f.add(received), original = Buffer.from(sourceOf(f, token));
    if (full) for (let i = 0; i < 200; i++) f.add(templatesFolder);
    else f.failAppend = true;
    await assert.rejects(f.service.copy(f.session, token), { statusCode: full ? 422 : 503 }); assert.deepEqual(sourceOf(f, token), original);
    assert.ok(!writes(f).some(row => row[1].startsWith('Shared/')));
  }
});

test('template sharing: oversized copy rejects before raw source FETCH', async () => {
  const f = fixture(), token = f.add(received), ref = decodeRef(token);
  f.folders.get(ref.path).rows.get(ref.uid).size = 2 * 1024 * 1024;
  await assert.rejects(f.service.copy(f.session, token), { statusCode: 413 });
  assert.ok(!f.calls.some(row => row[0] === 'fetchOne' && row[3].source)); assert.equal(writes(f).length, 0);
});

test('template sharing: revocation disappears from next list and stale open/copy returns 404 without writes', async () => {
  const f = fixture(), token = f.add(received);
  assert.equal((await f.service.list(f.session)).length, 1); f.hidden = new Set([received]);
  assert.deepEqual(await f.service.list(f.session), []);
  await assert.rejects(f.service.read(f.session, token), { statusCode: 404 }); await assert.rejects(f.service.copy(f.session, token), { statusCode: 404 }); assert.equal(writes(f).length, 0);
});

for (const path of ['INBOX', 'Templates/공유', 'Shared/author@example.com/Templates', `${received}/child`, `${received}-old`, `Shared/${viewer}/Templates/공유`, 'Shared/anyone/Templates/공유']) test(`template sharing: outside ref ${path} rejects without LIST/FETCH/STORE`, async () => {
  const f = fixture(), token = encodeRef(path, 123, 1);
  assert.throws(() => decodeSharedTemplateRef(token, f.session), { statusCode: 403 });
  await assert.rejects(f.service.read(f.session, token), { statusCode: 403 }); await assert.rejects(f.service.copy(f.session, token), { statusCode: 403 }); assert.equal(f.calls.length, 0);
});
