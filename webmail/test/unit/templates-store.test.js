import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import libmime from 'libmime';
import { AppError } from '../../server/errors.js';
import { encodeRef, decodeRef, assertUidValidity } from '../../server/mail/ref.js';
import { createTemplateStore, decodeTemplateRef, templatesFolder, sharedTemplatesFolder } from '../../server/templates/store.js';
import { templateMime } from '../../server/templates/mime.js';

const account = 'author@example.com';
const session = () => ({ email: account, connection: {} });
const data = (extra = {}) => ({ name: '안내 {{오늘}}', subject: '{{오늘}} 안내', html: '<p>{{내이름}}</p>', attachments: [], ...extra });
const attachment = Buffer.from([0, 255, 3, 200, 5, 6]), image = Buffer.from('synthetic-cid-image');
function source(subject = 'original', html = '<p>original</p>', date = 'Wed, 28 Oct 2026 05:00:00 +0000') {
  return Buffer.from(`From: author@example.com\r\nTo: reader@example.com\r\nCc: other@example.com\r\nBcc: hidden@example.com\r\nReply-To: reply@example.com\r\nIn-Reply-To: <reply@example.com>\r\nReferences: <original@example.com>\r\nSubject: ${libmime.encodeWord(subject, 'B', 52)}\r\nDate: ${date}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\nContent-Type: multipart/alternative; boundary="alt"\r\n\r\n--alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nplain {{오늘}}\r\n--alt\r\nContent-Type: multipart/related; boundary="rel"\r\n\r\n--rel\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}<img src="cid:logo@example">\r\n--rel\r\nContent-Type: image/png\r\nContent-ID: <logo@example>\r\nContent-Transfer-Encoding: base64\r\n\r\n${image.toString('base64')}\r\n--rel--\r\n--alt--\r\n--outer\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="sample.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment.toString('base64')}\r\n--outer--\r\n`);
}
const structure = { type: 'multipart/mixed', childNodes: [
  { part: '1', type: 'multipart/alternative', childNodes: [
    { part: '1.1', type: 'text/plain', size: 20 },
    { part: '1.2', type: 'multipart/related', childNodes: [{ part: '1.2.1', type: 'text/html', size: 80 }, { part: '1.2.2', type: 'image/png', id: '<logo@example>', disposition: 'inline', size: image.length }] },
  ] },
  { part: '2', type: 'application/octet-stream', disposition: 'attachment', dispositionParameters: { filename: 'sample.bin' }, size: attachment.length },
] };

function fixture({ folders = ['INBOX', templatesFolder, sharedTemplatesFolder], hook = true, config = {} } = {}) {
  const f = { folders: new Map(folders.map((path, i) => [path, { validity: i + 100, nextUid: 1, rows: new Map() }])), calls: [], warnings: [], builds: [] };
  function add(path, { id = randomUUID(), name = 'original', raw = source(), uid, date } = {}) {
    const folder = f.folders.get(path);
    if (date) raw = source('original', '<p>original</p>', date);
    const bytes = templateMime(raw, { id, name });
    const number = uid ?? folder.nextUid++;
    folder.nextUid = Math.max(folder.nextUid, number + 1);
    const row = { uid: number, source: bytes, headers: bytes.subarray(0, bytes.indexOf('\r\n\r\n') + 4), size: bytes.length, bodyStructure: structuredClone(structure), flags: new Set(['\\Seen']) };
    folder.rows.set(number, row);
    return { id, row, ref: encodeRef(path, folder.validity, number) };
  }
  function client(path) {
    const folder = f.folders.get(path);
    if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'synthetic');
    return {
      mailbox: { path, uidValidity: BigInt(folder.validity), exists: folder.rows.size }, capabilities: new Set(f.capabilities ?? ['UIDPLUS', 'MOVE']),
      async list() { f.calls.push(['list']); return [...f.folders.keys()].map(path => ({ path })); },
      async *fetch(set, query, options) { f.calls.push(['fetch', path, set, query, options]); for (const row of folder.rows.values()) yield row; },
      async fetchOne(uid, query, options) {
        f.calls.push(['fetchOne', path, uid, query, options]);
        const row = folder.rows.get(uid);
        if (query.source && f.verifyFailure) return row && { ...row, source: Buffer.from('corrupted') };
        return row;
      },
      async append(target, raw, flags) {
        f.calls.push(['append', target, Buffer.from(raw), flags]);
        if (f.appendFailure === 'before') throw new Error('synthetic quota exceeded');
        const dest = f.folders.get(target), uid = dest.nextUid++;
        const row = { uid, source: Buffer.from(raw), headers: raw.subarray(0, raw.indexOf('\r\n\r\n') + 4), size: raw.length, flags: new Set(flags), bodyStructure: structuredClone(structure) };
        dest.rows.set(uid, row);
        if (f.appendFailure === 'after') throw new Error('synthetic ACK lost');
        if (f.appendFailure === 'no-uid') return {};
        return { uid, uidValidity: BigInt(dest.validity) };
      },
      async messageFlagsAdd(set, flags, options) {
        f.calls.push(['flags', path, set, flags, options]);
        if (f.flagFailure) return false;
        for (const uid of String(set).split(',').map(Number)) for (const flag of flags) folder.rows.get(uid)?.flags.add(flag);
        return true;
      },
      async exec(command, args) {
        f.calls.push(['exec', path, command, args]);
        assert.equal(command, 'UID EXPUNGE');
        if (f.expungeFailure) throw new Error('synthetic expunge failure');
        for (const uid of args[0].value.split(',').map(Number)) folder.rows.delete(uid);
        return { next() { f.calls.push(['next']); } };
      },
      async mailboxCreate(target) { f.calls.push(['createFolder', target]); f.folders.set(target, { validity: 200, nextUid: 1, rows: new Map() }); return { path: target }; },
      async status(target, query) { f.calls.push(['status', target, query]); return { messages: f.folders.get(target).rows.size }; },
      async mailboxDelete(target) { f.calls.push(['deleteFolder', target]); if (f.deleteFailure) return false; f.folders.delete(target); return true; },
      async messageMove(uid, target, options) {
        f.calls.push(['move', path, uid, target, options]);
        if (f.moveFailure) throw new Error('synthetic move failure');
        const dest = f.folders.get(target), nextUid = dest.nextUid++;
        dest.rows.set(nextUid, { ...folder.rows.get(uid), uid: nextUid }); folder.rows.delete(uid);
        return { uidMap: new Map([[uid, nextUid]]), uidValidity: BigInt(dest.validity) };
      },
      async download(uid, part, options) {
        f.calls.push(['download', path, uid, part, options]);
        return { content: Readable.from([Buffer.from(f.downloadBody ?? (part === '1.2.1' ? '<p>{{내이름}}</p><script>evil()</script><img src="cid:logo@example">' : 'plain {{오늘}}'))]), meta: { charset: 'utf-8' } };
      },
    };
  }
  const imap = {
    async withMailbox(s, path, operation) { assert.equal(s.email.toLowerCase(), account); return operation(client(path)); },
    async withRef(s, token, operation) { const ref = decodeRef(token); return this.withMailbox(s, ref.path, value => { assertUidValidity(value, ref); return operation(value, ref); }); },
  };
  const buildMime = async (s, value) => {
    f.builds.push(structuredClone(value));
    await f.buildBarrier?.();
    return f.raw ?? source(value.subject, value.html);
  };
  const onFolderCreated = async (_client, path) => {
    f.calls.push(['hook', path]);
    if (f.hookFailure) {
      if (f.hookNonempty) add(path);
      throw new Error('synthetic inherited ACL cleanup failure');
    }
  };
  const options = { imap, config: { attachMaxMb: 1, ...config }, buildMime, ...(hook ? { onFolderCreated } : {}), logger: { warn(...args) { f.warnings.push(args); } } };
  return Object.assign(f, { add, imap, options, service: createTemplateStore(options) });
}
const mutations = f => f.calls.filter(row => ['append', 'flags', 'exec', 'move', 'createFolder', 'deleteFolder'].includes(row[0]));
const bytes = (f, ref) => { const value = decodeRef(ref); return f.folders.get(value.path).rows.get(value.uid)?.source; };
const mimeBody = value => value.subarray(value.indexOf('\r\n\r\n') + 4);

test('templates store: create/list/get uses header-only listing and sanitized body on demand', async () => {
  const f = fixture(), s = session();
  const value = await f.service.create(s, data());
  assert.match(value.id, /^[0-9a-f-]{36}$/); assert.equal(value.name, data().name); assert.equal(value.owner, account); assert.equal(value.inShared, false);
  const stored = bytes(f, value.ref), headers = libmime.decodeHeaders(stored.subarray(0, stored.indexOf('\r\n\r\n')).toString('latin1'));
  for (const name of ['from', 'to', 'cc', 'bcc', 'reply-to', 'in-reply-to', 'references']) assert.equal(headers[name], undefined);
  f.calls = [];
  assert.deepEqual(await f.service.list(s), [value]);
  assert.ok(!f.calls.some(row => ['download', 'fetchOne', 'flags'].includes(row[0])));
  for (const call of f.calls.filter(row => row[0] === 'fetch')) { assert.equal(call[3].source, undefined); assert.equal(call[3].bodyParts, undefined); assert.deepEqual(call[4], { uid: true }); }
  const result = await f.service.get(s, value.ref);
  assert.match(result.html, /{{내이름}}/); assert.ok(!result.html.includes('evil')); assert.equal(result.attachments.length, 2);
  assert.deepEqual(result.attachments.find(part => part.part === '2'), { part: '2', name: 'sample.bin', size: attachment.length, type: 'application/octet-stream' });
  assert.equal(mutations(f).length, 0);
});

test('templates store: update verifies new full MIME before old UID expunge and preserves attachment/CID bytes', async () => {
  const f = fixture(), s = session(), original = f.add(templatesFolder), oldBytes = Buffer.from(bytes(f, original.ref));
  const saved = await f.service.update(s, original.ref, data({ baseUid: decodeRef(original.ref).uid }));
  assert.equal(saved.id, original.id); assert.notEqual(saved.ref, original.ref); assert.equal(bytes(f, original.ref), undefined);
  assert.deepEqual(mimeBody(bytes(f, saved.ref)), mimeBody(source(data().subject, data().html)));
  for (const marker of [attachment.toString('base64'), image.toString('base64'), 'Content-ID: <logo@example>']) assert.ok(bytes(f, saved.ref).includes(Buffer.from(marker)));
  const order = f.calls.map(row => row[0]), verified = f.calls.findIndex(row => row[0] === 'fetchOne' && row[3].source); assert.ok(order.indexOf('append') < verified); assert.ok(verified < order.indexOf('flags'));
  assert.deepEqual(f.calls.find(row => row[0] === 'exec').slice(2), ['UID EXPUNGE', [{ type: 'SEQUENCE', value: String(decodeRef(original.ref).uid) }]]);
  assert.ok(oldBytes.length > 0);
});

for (const failure of ['before', 'after', 'no-uid']) test(`templates store: APPEND failure ${failure} preserves old MIME and never flags old UID`, async () => {
  const f = fixture(), original = f.add(templatesFolder), old = Buffer.from(bytes(f, original.ref)); f.appendFailure = failure;
  await assert.rejects(f.service.update(session(), original.ref, data({ baseUid: decodeRef(original.ref).uid })), { statusCode: 503 });
  assert.deepEqual(bytes(f, original.ref), old); assert.ok(!f.calls.some(row => ['flags', 'exec'].includes(row[0])));
  assert.equal(f.folders.get(templatesFolder).rows.get(decodeRef(original.ref).uid).flags.has('\\Deleted'), false);
});

test('templates store: corrupt APPEND readback leaves old MIME, attachments and CID untouched', async () => {
  const f = fixture(), original = f.add(templatesFolder), old = Buffer.from(bytes(f, original.ref)); f.verifyFailure = true;
  await assert.rejects(f.service.update(session(), original.ref, data({ baseUid: decodeRef(original.ref).uid })), { statusCode: 503 });
  assert.deepEqual(bytes(f, original.ref), old); assert.ok(!f.calls.some(row => row[0] === 'flags'));
});

for (const failure of ['flagFailure', 'expungeFailure']) test(`templates store: ${failure} returns verified save; next save cleans same-Date duplicates`, async () => {
  const f = fixture(), original = f.add(templatesFolder), s = session(); f[failure] = true;
  const saved = await f.service.update(s, original.ref, data({ baseUid: decodeRef(original.ref).uid }));
  assert.deepEqual(await f.service.list(s), [saved]); assert.ok(bytes(f, original.ref));
  assert.equal(f.warnings.length, 1); const logs = JSON.stringify(f.warnings); for (const secret of [account, data().name, data().html]) assert.ok(!logs.includes(secret));
  f[failure] = false;
  const second = await f.service.update(s, saved.ref, data({ baseUid: decodeRef(saved.ref).uid }));
  assert.deepEqual(await f.service.list(s), [second]); assert.equal(f.folders.get(templatesFolder).rows.size, 1);
  assert.ok(bytes(f, second.ref).includes(Buffer.from(attachment.toString('base64'))));
});

test('templates store: list selects latest Date, then larger UID, then path; list never cleans duplicates', async () => {
  const f = fixture({ folders: ['INBOX', 'Templates', 'Templates/공유', 'Templates/A'] }), id = randomUUID();
  const old = f.add(templatesFolder, { id, uid: 20, date: 'Tue, 27 Oct 2026 05:00:00 +0000' });
  f.add(sharedTemplatesFolder, { id, uid: 3 }); const winner = f.add('Templates/A', { id, uid: 3 });
  const values = await f.service.list(session()); assert.equal(values.length, 1); assert.equal(values[0].ref, winner.ref); assert.ok(bytes(f, old.ref)); assert.equal(mutations(f).length, 0);
  await assert.rejects(f.service.update(session(), old.ref, data({ baseUid: 20 })), { statusCode: 409 }); assert.equal(mutations(f).length, 0);
});

test('templates store: concurrent sessions and separate instances with equal baseUid have exactly one winner', async () => {
  const f = fixture(), original = f.add(templatesFolder), second = createTemplateStore(f.options);
  let unblock, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { unblock = resolve; });
  f.buildBarrier = async () => { entered(); await barrier; };
  const first = f.service.update(session(), original.ref, data({ baseUid: decodeRef(original.ref).uid }));
  await ready;
  const later = second.update(session(), original.ref, data({ baseUid: decodeRef(original.ref).uid }));
  unblock();
  const results = await Promise.allSettled([first, later]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.statusCode, 409);
  assert.equal(f.calls.filter(row => row[0] === 'append').length, 1);
});

test('templates store: stale baseUid and UIDVALIDITY fail with 409 before build or mutation', async () => {
  const f = fixture(), original = f.add(templatesFolder);
  await assert.rejects(f.service.update(session(), original.ref, data({ baseUid: 99 })), { statusCode: 409 });
  const stale = encodeRef(templatesFolder, 999, decodeRef(original.ref).uid);
  await assert.rejects(f.service.remove(session(), stale, { baseUid: decodeRef(stale).uid }), { statusCode: 409 });
  assert.equal(f.builds.length, 0); assert.equal(mutations(f).length, 0);
});

test('templates store: PUT rejects shared destination changes, preserving both folders', async () => {
  const f = fixture(), original = f.add(templatesFolder), shared = f.add(sharedTemplatesFolder);
  for (const [value, target] of [[original, true], [shared, false]]) await assert.rejects(f.service.update(session(), value.ref, data({ shared: target, baseUid: decodeRef(value.ref).uid })), { statusCode: 422 });
  assert.equal(mutations(f).length, 0);
});

test('templates store: MOVE in/out preserves exact MIME and returns destination UID/validity', async () => {
  const f = fixture(), original = f.add(templatesFolder), raw = Buffer.from(bytes(f, original.ref)), s = session();
  const shared = await f.service.move(s, original.ref, { shared: true });
  assert.equal(shared.id, original.id); assert.equal(shared.inShared, true); assert.equal(decodeRef(shared.ref).path, sharedTemplatesFolder); assert.deepEqual(bytes(f, shared.ref), raw); assert.equal(bytes(f, original.ref), undefined);
  const own = await f.service.move(s, shared.ref, { shared: false }); assert.equal(own.inShared, false); assert.deepEqual(bytes(f, own.ref), raw);
  assert.ok(!f.calls.some(row => ['append', 'flags', 'exec'].includes(row[0])));
});

test('templates store: MOVE rejection or missing MOVE capability leaves source MIME intact', async () => {
  for (const key of ['moveFailure', 'capabilities']) {
    const f = fixture(), original = f.add(templatesFolder), raw = Buffer.from(bytes(f, original.ref));
    f[key] = key === 'capabilities' ? ['UIDPLUS'] : true;
    await assert.rejects(f.service.move(session(), original.ref, { shared: true }), { statusCode: 503 }); assert.deepEqual(bytes(f, original.ref), raw);
  }
});

test('templates store: remove expunges only chosen Template-Id duplicates and keeps unrelated mail', async () => {
  const f = fixture(), id = randomUUID(), old = f.add(templatesFolder, { id }), selected = f.add(templatesFolder, { id }), unrelated = f.add(templatesFolder), inbox = f.add('INBOX');
  assert.deepEqual(await f.service.remove(session(), selected.ref, { baseUid: decodeRef(selected.ref).uid }), { ok: true });
  assert.equal(bytes(f, old.ref), undefined); assert.equal(bytes(f, selected.ref), undefined); assert.ok(bytes(f, unrelated.ref)); assert.ok(bytes(f, inbox.ref));
});

for (const path of ['INBOX', 'Drafts', 'Templates-old', 'Shared/other@example.com/Templates/공유', 'WebmailVirtual/AllMail', 'Templates/../INBOX', 'Templates//INBOX']) test(`templates store: decoded outside ref ${path} cannot read, PUT, DELETE or MOVE`, async () => {
  const f = fixture(), token = encodeRef(path, 123, 1), s = session();
  assert.throws(() => decodeTemplateRef(token), { statusCode: 403 });
  for (const operation of [() => f.service.get(s, token), () => f.service.update(s, token, data({ baseUid: 1 })), () => f.service.remove(s, token, { baseUid: 1 }), () => f.service.move(s, token, { shared: true })]) await assert.rejects(operation(), { statusCode: 403 });
  assert.equal(f.calls.length, 0);
});

test('templates store: 200 unique limit includes shared tree; duplicate UUID does not consume extra slot', async () => {
  const f = fixture(), s = session();
  for (let i = 0; i < 198; i++) f.add(i % 2 ? templatesFolder : sharedTemplatesFolder);
  const duplicate = f.add(templatesFolder); f.add(sharedTemplatesFolder, { id: duplicate.id });
  await f.service.create(s, data());
  assert.equal((await f.service.list(s)).length, 200);
  f.calls = [];
  await assert.rejects(f.service.create(s, data()), { statusCode: 422, code: 'TEMPLATE_LIMIT' }); assert.equal(mutations(f).length, 0);
  // Updates are still allowed at the limit and clean every same-Id duplicate.
  const winner = (await f.service.list(s)).find(row => row.id === duplicate.id);
  const updated = await f.service.update(s, winner.ref, data({ baseUid: decodeRef(winner.ref).uid, shared: winner.inShared })); assert.equal(updated.id, duplicate.id); assert.equal((await f.service.list(s)).length, 200);
});

test('templates store: concurrent creates at 199 stop at 200', async () => {
  const f = fixture(); for (let i = 0; i < 199; i++) f.add(templatesFolder);
  const results = await Promise.allSettled([f.service.create(session(), data()), f.service.create(session(), data())]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.code, 'TEMPLATE_LIMIT');
  assert.equal(f.calls.filter(row => row[0] === 'append').length, 1);
});

test('templates store: maximum stored RFC822 bytes reject before APPEND and preserve old message', async () => {
  const f = fixture(), original = f.add(templatesFolder), old = Buffer.from(bytes(f, original.ref)); f.raw = Buffer.concat([source(), Buffer.alloc(1024 * 1024)]);
  await assert.rejects(f.service.update(session(), original.ref, data({ baseUid: decodeRef(original.ref).uid })), { statusCode: 413 });
  assert.deepEqual(bytes(f, original.ref), old); assert.equal(mutations(f).length, 0);
});

test('templates store: new folders require hook, and hook runs immediately after CREATE before APPEND', async () => {
  const disabled = fixture({ folders: ['INBOX'], hook: false });
  await assert.rejects(disabled.service.create(session(), data()), { statusCode: 503, code: 'TEMPLATE_FOLDER_SETUP_REQUIRED' }); assert.equal(mutations(disabled).length, 0);
  const f = fixture({ folders: ['INBOX'] });
  await f.service.create(session(), data({ shared: true }));
  assert.deepEqual(f.calls.filter(row => ['createFolder', 'hook', 'append'].includes(row[0])).map(row => row.slice(0, 2)), [['createFolder', templatesFolder], ['hook', templatesFolder], ['createFolder', sharedTemplatesFolder], ['hook', sharedTemplatesFolder], ['append', sharedTemplatesFolder]]);
});

test('templates store: failed hook removes only newly created empty folder; retry re-creates and re-runs hook', async () => {
  const f = fixture({ folders: ['INBOX'] }); f.hookFailure = true;
  await assert.rejects(f.service.create(session(), data()), { statusCode: 503 }); assert.equal(f.folders.has(templatesFolder), false); assert.ok(!f.calls.some(row => row[0] === 'append'));
  f.hookFailure = false;
  await f.service.create(session(), data()); assert.equal(f.calls.filter(row => row[0] === 'hook').length, 2);
});

for (const fail of ['deleteFailure', 'hookNonempty']) test(`templates store: failed hook with ${fail} returns 503, keeps folder and never appends`, async () => {
  const f = fixture({ folders: ['INBOX'] }); f.hookFailure = true; f[fail] = true;
  await assert.rejects(f.service.create(session(), data()), { statusCode: 503 }); assert.equal(f.folders.has(templatesFolder), true); assert.ok(!f.calls.some(row => row[0] === 'append'));
  if (fail === 'hookNonempty') assert.ok(!f.calls.some(row => row[0] === 'deleteFolder'));
  assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0][0].code, 'TEMPLATE_FOLDER_RECOVERY_REQUIRED');
  assert.ok(!JSON.stringify(f.warnings).includes(account));
  assert.ok(!JSON.stringify(f.warnings).includes(data().html));
});

test('templates store: existing folder never invokes creation hook or changes explicit ACL', async () => {
  const f = fixture(); f.hookFailure = true;
  await f.service.create(session(), data({ shared: true })); assert.ok(!f.calls.some(row => row[0] === 'hook'));
});

test('templates store: incomplete session is 403 and invalid input cannot select server paths', async () => {
  const f = fixture(); await assert.rejects(f.service.list({ email: account }), { statusCode: 403 });
  for (const change of [{ name: '' }, { name: 'x'.repeat(101) }, { subject: 'x\r\nTo: injected@example.com' }, { shared: 'true' }, { owner: 'other@example.com' }, { path: 'INBOX' }, { attachments: [{ uploadId: '../../private' }] }]) await assert.rejects(f.service.create(session(), data(change)), { statusCode: 422 });
  await assert.rejects(f.service.create(session(), data({ attachments: [{ templateRef: encodeRef('INBOX', 1, 1), part: '1' }] })), { statusCode: 403 });
  assert.equal(f.calls.length, 0);
});


test('templates store: MOVE cleans same-Date larger old UIDs before changing UID space', async () => {
  const f = fixture(), id = randomUUID();
  const original = f.add(templatesFolder, { id, uid: 100 });
  const old = f.add(templatesFolder, { id, uid: 99 });
  const sharedOld = f.add(sharedTemplatesFolder, { id, uid: 50 });
  const unrelated = f.add(templatesFolder), raw = Buffer.from(bytes(f, original.ref));
  const result = await f.service.move(session(), original.ref, { shared: true });
  assert.deepEqual(bytes(f, result.ref), raw);
  for (const value of [original, old, sharedOld]) assert.equal(bytes(f, value.ref), undefined);
  const listed = (await f.service.list(session())).filter(row => row.id === id);
  assert.deepEqual(listed, [result]); assert.ok(bytes(f, unrelated.ref));
  const moveAt = f.calls.findIndex(row => row[0] === 'move');
  assert.ok(f.calls.every((row, i) => row[0] !== 'exec' || i < moveAt));
  assert.equal(f.calls.filter(row => row[0] === 'exec').length, 2);
});

for (const failure of ['flagFailure', 'expungeFailure']) test(`templates store: MOVE duplicate cleanup ${failure} returns 503 and keeps newest source untouched`, async () => {
  const f = fixture(), id = randomUUID();
  f.add(templatesFolder, { id, uid: 99 });
  const original = f.add(templatesFolder, { id, uid: 100 }), raw = Buffer.from(bytes(f, original.ref));
  f[failure] = true;
  await assert.rejects(f.service.move(session(), original.ref, { shared: true }), { statusCode: 503 });
  assert.deepEqual(bytes(f, original.ref), raw);
  assert.equal(f.folders.get(templatesFolder).rows.get(100).flags.has('\\Deleted'), false);
  assert.ok(!f.calls.some(row => row[0] === 'move'));
});


test('templates store: internal importRaw issues new Id, preserves MIME and uses quota-checked append without compose build', async () => {
  const f = fixture(), oldId = randomUUID();
  const raw = templateMime(source(), { id: oldId, name: '공유 원본' }), original = Buffer.from(raw);
  const copied = await f.service.importRaw(session(), raw);
  assert.notEqual(copied.id, oldId); assert.equal(copied.name, '공유 원본'); assert.equal(copied.inShared, false);
  assert.equal(decodeRef(copied.ref).path, templatesFolder);
  assert.deepEqual(mimeBody(bytes(f, copied.ref)), mimeBody(original)); assert.deepEqual(raw, original);
  assert.equal(f.builds.length, 0);
  const atLimit = fixture(); for (let i = 0; i < 200; i++) atLimit.add(templatesFolder);
  await assert.rejects(atLimit.service.importRaw(session(), raw), { statusCode: 422, code: 'TEMPLATE_LIMIT' }); assert.equal(mutations(atLimit).length, 0);
  await assert.rejects(f.service.importRaw(session(), Buffer.concat([raw, Buffer.alloc(1024 * 1024)])), { statusCode: 413 });
});

test('templates store: ensureSharedFolder passes session to creation hook and reuses existing safe folders', async () => {
  const f = fixture({ folders: ['INBOX'] }), s = session(), calls = [];
  const store = createTemplateStore({ ...f.options, async onFolderCreated(client, path, context) { assert.equal(context, s); assert.ok(client); calls.push(path); } });
  assert.equal(await store.ensureSharedFolder(s), sharedTemplatesFolder);
  assert.deepEqual(calls, [templatesFolder, sharedTemplatesFolder]);
  await store.ensureSharedFolder(s); assert.equal(calls.length, 2);
});


test('templates store: shared attachment manifest reaches the guarded compose builder, outside paths still reject', async () => {
  const f = fixture(), sharedRef = encodeRef('Shared/author@example.com/Templates/공유', 100, 1);
  await f.service.create(session(), data({ attachments: [{ templateRef: sharedRef, part: '2' }] }));
  assert.deepEqual(f.builds[0].attachments, [{ templateRef: sharedRef, part: '2' }]);
  const outside = encodeRef('Shared/author@example.com/INBOX', 100, 1);
  await assert.rejects(f.service.create(session(), data({ attachments: [{ templateRef: outside, part: '2' }] })), { statusCode: 403 });
});

for (const accurateSize of [true, false]) test(`templates store: omitted oversized body rejects overwrite and preserves original UID, MIME and attachments; accurateSize=${accurateSize}`, async () => {
  const f = fixture({ config: { attachMaxMb: 25, bodyMaxMb: 1 } });
  const html = '<p>' + 'a'.repeat(1024 * 1024) + '</p>';
  const original = f.add(templatesFolder, { raw: source('large', html) });
  original.row.bodyStructure.childNodes[0].childNodes[1].childNodes[0].size = accurateSize ? Buffer.byteLength(html) : 1;
  f.downloadBody = html;
  const before = Buffer.from(original.row.source), flags = [...original.row.flags];
  assert.ok(before.length < 25 * 1024 * 1024);
  const detail = await f.service.get(session(), original.ref);
  assert.equal(detail.bodyOmitted, true); assert.equal(detail.html, ''); assert.equal(detail.attachments.length, 2);
  f.calls = [];
  await assert.rejects(f.service.update(session(), original.ref, data({ name: '이름만 변경', html: detail.html, baseUid: original.row.uid })), { statusCode: 422, code: 'TEMPLATE_BODY_OMITTED' });
  assert.equal(mutations(f).length, 0); assert.equal(f.builds.length, 0);
  const rows = f.folders.get(templatesFolder).rows;
  assert.deepEqual([...rows.keys()], [original.row.uid]); assert.deepEqual(rows.get(original.row.uid).source, before); assert.deepEqual([...original.row.flags], flags);
});
