import { AppError } from '../../server/errors.js';
import { createPublicTemplatesReader, decodePublicTemplateRef } from '../../server/templates/public.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { decodePath, encodePath } from 'imapflow/lib/tools.js';
import { createApp } from '../../server/app.js';
import { encodeRef, decodeRef, assertUidValidity } from '../../server/mail/ref.js';
import { templateMime } from '../../server/templates/mime.js';
import { PREFS_ENTRY } from '../../server/prefs.js';
import { templatesFolder, sharedTemplatesFolder } from '../../server/templates/store.js';

const user = 'viewer@example.com', owner = 'author@example.com', recipient = 'reader@example.com';
const received = `Shared/${owner}/Templates/공유`;
const config = { publicHostnames: ['newmail.example.com'], trustProxy: [], logLevel: 'silent', sessionIdleMin: 60, sessionMaxHours: 8, attachMaxMb: 1, defaultTheme: 'ink', defaultMode: 'light', mailTlsMode: 'verify', mailTlsServername: 'mail.example.com' };
const input = extra => ({ name: '안내', subject: '{{오늘}} 안내', html: '<p>{{내이름}}</p>', attachments: [], ...extra });
async function fixture(t, publicTemplates = {}) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'templates-api-'));
  const f = { calls: [], folders: new Map(), acl: new Map(), metadata: new Map(), activeCalls: 0 };
  for (const path of ['INBOX', templatesFolder, sharedTemplatesFolder, received]) { f.folders.set(path, { validity: 100 + f.folders.size, next: 1, rows: new Map() }); f.acl.set(path, new Map([[`user=${user}`, 'lrswipkxteacd']])); }
  function add(path, raw, flags = new Set(['\\Seen'])) {
    const folder = f.folders.get(path), uid = folder.next++;
    const row = { uid, source: Buffer.from(raw), headers: raw.subarray(0, raw.indexOf('\r\n\r\n') + 4), size: raw.length, flags, bodyStructure: { part: '1', type: 'text/html', size: 50 } };
    folder.rows.set(uid, row); return encodeRef(path, folder.validity, uid);
  }
  function client(path) {
    const box = f.folders.get(path);
    if (!box) throw new Error('synthetic nonexistent mailbox');
    const value = { options: { auth: { user } }, enabled: new Set(['UTF8=ACCEPT']), capabilities: new Set(['UIDPLUS', 'MOVE']), mailbox: { path, uidValidity: BigInt(box.validity), exists: box.rows.size },
      async list() { return [...f.folders.keys()].filter(name => !f.hidden?.has(name)).map(path => ({ path })); },
      async *fetch(set, query) { f.calls.push(['FETCH', path, query]); for (const row of box.rows.values()) yield row; },
      async fetchOne(uid, query) { f.calls.push(['FETCHONE', path, query]); return box.rows.get(uid); },
      async download(uid, part) { f.calls.push(['DOWNLOAD', path, part]); return { content: Readable.from([Buffer.from('<p>{{내이름}}</p>')]), meta: { charset: 'utf-8' } }; },
      async append(target, raw, flags) { f.calls.push(['APPEND', target, Buffer.from(raw)]); const ref = decodeRef(add(target, raw, new Set(flags))); return { uid: ref.uid, uidValidity: BigInt(ref.uidValidity) }; },
      async messageFlagsAdd(set, flags) { f.calls.push(['STORE', path, set]); for (const uid of String(set).split(',').map(Number)) for (const flag of flags) box.rows.get(uid)?.flags.add(flag); return true; },
      async messageMove(uid, target) { f.calls.push(['MOVE', path, uid, target]); const ref = decodeRef(add(target, box.rows.get(uid).source)); box.rows.delete(uid); return { uidMap: new Map([[uid, ref.uid]]), uidValidity: BigInt(ref.uidValidity) }; },
      async exec(command, args, options = {}) {
        f.calls.push([command, path, args]);
        if (command === 'GETMETADATA') { const key = args.at(-1).value; options.untagged.METADATA({ attributes: [{ value: '' }, [{ value: key }, { value: f.metadata.has(key) ? Buffer.from(f.metadata.get(key)) : null }]] }); }
        else if (command === 'SETMETADATA') for (let i = 0; i < args[1].length; i += 2) f.metadata.set(args[1][i].value, args[1][i + 1].value.toString());
        else if (command === 'UID EXPUNGE') for (const uid of args[0].value.split(',').map(Number)) box.rows.delete(uid);
        else {
          const target = decodePath(value, args[0].value);
          if (command === 'GETACL') options.untagged.ACL({ attributes: [{ value: encodePath(value, target) }, ...[...f.acl.get(target)].flatMap(([id, rights]) => [{ value: id }, { value: rights }])] });
          else if (command === 'SETACL') f.acl.get(target).set(args[1].value, args[2].value);
          else if (command === 'DELETEACL') f.acl.get(target).delete(args[1].value);
          else assert.fail(command);
        }
        return { next() {} };
      },
    }; return value;
  }
  const directory = { async mailboxName() { return 'Viewer'; }, async activeAccounts() { f.activeCalls++; return [{ username: recipient, active: 1 }]; }, async identities() { return { identities: [{ address: user, name: 'Viewer', kind: 'self' }] }; }, async close() {} };
  const app = await createApp({ config, logger: false, publicTemplates, directory: { service: directory }, auth: { tempRoot, async verifyLogin() { return { connection: { async logout() {} } }; } } });
  app.imap.withMailbox = async (_session, path, operation) => operation(client(path));
  app.imap.withFreshConnection = async (_session, operation) => operation(client('INBOX'));
  app.imap.refreshShared = () => {};
  app.imap.withRef = (session, token, operation) => { const ref = decodeRef(token); return app.imap.withMailbox(session, ref.path, current => { assertUidValidity(current, ref); return operation(current, ref); }); };
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://newmail.example.com' }, payload: { email: user, password: 'synthetic-api-password' } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'https://newmail.example.com', 'x-webmail-csrf': login.json().csrf };
  const request = (method, url, payload, custom = headers) => app.inject({ method, url, payload, headers: custom });
  const sharedId = randomUUID();
  const sharedRef = add(received, templateMime(Buffer.from('Subject: Shared\r\nDate: Wed, 28 Oct 2026 05:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/html\r\n\r\n<p>Shared</p>'), { id: sharedId, name: '공유 원본' }), new Set());
  return Object.assign(f, { app, request, headers, add, sharedRef, sharedId });
}
const status = (response, code) => { assert.equal(response.statusCode, code, response.body); assert.equal(response.headers['www-authenticate'], undefined); };
const changes = f => f.calls.filter(row => ['APPEND', 'STORE', 'MOVE', 'SETACL', 'DELETEACL', 'SETMETADATA', 'UID EXPUNGE'].includes(row[0]));

test('templates API: actual app wiring, health, create/list/get/update/move/delete contracts', async t => {
  const f = await fixture(t); status(await f.app.inject('/healthz'), 200);
  const created = await f.request('POST', '/api/templates', input()); status(created, 201); const item = created.json();
  const appended = f.calls.find(row => row[0] === 'APPEND')[2];
  assert.ok(appended.includes(Buffer.from('multipart/alternative'))); assert.ok(!/^From:/im.test(appended.toString()));
  f.calls = [];
  const list = await f.request('GET', '/api/templates'); status(list, 200);
  assert.deepEqual(Object.keys(list.json()).sort(), ['limits', 'mine', 'pins', 'public', 'shared']);
  assert.equal(list.json().mine[0].id, item.id); assert.equal(list.json().shared[0].owner, owner); assert.deepEqual(list.json().public, []); assert.deepEqual(list.json().limits, { max: 200 });
  assert.ok(f.calls.filter(row => row[0] === 'FETCH').every(row => !row[2].source && !row[2].bodyParts)); assert.equal(changes(f).length, 0);
  const read = await f.request('GET', `/api/templates/${item.ref}`); status(read, 200); assert.equal(read.json().id, item.id); assert.match(read.json().html, /내이름/);
  const updated = await f.request('PUT', `/api/templates/${item.ref}`, input({ baseUid: decodeRef(item.ref).uid })); status(updated, 200); assert.equal(updated.json().id, item.id);
  status(await f.request('PUT', `/api/templates/${item.ref}`, input({ baseUid: decodeRef(item.ref).uid })), 409);
  const moved = await f.request('POST', `/api/templates/${updated.json().ref}/move`, { shared: true }); status(moved, 200); assert.equal(moved.json().inShared, true);
  status(await f.request('DELETE', `/api/templates/${moved.json().ref}`, { baseUid: decodeRef(moved.json().ref).uid }), 200);
});

test('templates API: unauthenticated and bearer-only requests, bad CSRF/origin are 403 without side effects', async t => {
  const f = await fixture(t), ref = f.sharedRef;
  for (const [method, url, payload] of [['GET', '/api/templates'], ['GET', '/api/templates/share'], ['POST', '/api/templates', input()], ['PUT', `/api/templates/${ref}`, input({ baseUid: 1 })], ['DELETE', `/api/templates/${ref}`, { baseUid: 1 }], ['POST', `/api/templates/${ref}/move`, { shared: true }], ['POST', `/api/templates/${ref}/copy`], ['POST', `/api/templates/${ref}/attachments-to-compose`, { composeId: 'draft-one' }]]) status(await f.request(method, url, payload, { origin: f.headers.origin, authorization: 'Bearer synthetic-ignored' }), 403);
  status(await f.request('POST', '/api/templates', input(), { ...f.headers, 'x-webmail-csrf': 'wrong' }), 403);
  status(await f.request('POST', '/api/templates', input(), { ...f.headers, origin: 'https://evil.example.com' }), 403);
  assert.equal(changes(f).length, 0);
});

test('templates API: share setting wiring uses active mailbox provider; static share route does not decode as ref', async t => {
  const f = await fixture(t);
  status(await f.request('GET', '/api/templates/share'), 200);
  const shared = await f.request('PUT', '/api/templates/share', { domainAll: true, users: [recipient] }); status(shared, 200);
  assert.equal(shared.json().domainAll, true); assert.deepEqual(shared.json().users, [recipient]); assert.equal(f.activeCalls, 1);
  const snapshot = [...f.acl.get(sharedTemplatesFolder)];
  status(await f.request('PUT', '/api/templates/share', { domainAll: false, users: ['alias@example.com'] }), 422);
  assert.deepEqual([...f.acl.get(sharedTemplatesFolder)], snapshot);
});

test('templates API: shared get/copy and attachments response; shared PUT/DELETE/MOVE never write', async t => {
  const f = await fixture(t), original = Buffer.from(f.folders.get(received).rows.get(1).source);
  const read = await f.request('GET', `/api/templates/${f.sharedRef}`); status(read, 200); assert.equal(read.json().owner, owner);
  const copied = await f.request('POST', `/api/templates/${f.sharedRef}/copy`); status(copied, 201); assert.notEqual(copied.json().id, f.sharedId);
  const attached = await f.request('POST', `/api/templates/${f.sharedRef}/attachments-to-compose`, { composeId: 'draft-one' }); status(attached, 200); assert.deepEqual(attached.json().uploads, []); assert.equal(typeof attached.json().html, 'string');
  f.calls = [];
  status(await f.request('PUT', `/api/templates/${f.sharedRef}`, input({ baseUid: 1 })), 403);
  status(await f.request('DELETE', `/api/templates/${f.sharedRef}`, { baseUid: 1 }), 403);
  status(await f.request('POST', `/api/templates/${f.sharedRef}/move`, { shared: false }), 403);
  assert.equal(changes(f).length, 0); assert.deepEqual(f.folders.get(received).rows.get(1).source, original);
});

test('templates API: vanished pins are ignored in list without rewriting preferences', async t => {
  const f = await fixture(t), gone = { owner, id: randomUUID() }, live = { owner, id: f.sharedId };
  f.metadata.set(PREFS_ENTRY, JSON.stringify({ templatePins: [live, gone] }));
  const stored = f.metadata.get(PREFS_ENTRY), result = await f.request('GET', '/api/templates'); status(result, 200);
  assert.deepEqual(result.json().pins, [live]); assert.equal(f.metadata.get(PREFS_ENTRY), stored);
  f.hidden = new Set([received]);
  const after = await f.request('GET', '/api/templates'); status(after, 200); assert.deepEqual(after.json().pins, []);
});

test('templates API: decoded INBOX references are forbidden for every action', async t => {
  const f = await fixture(t), outside = encodeRef('INBOX', 100, 1);
  for (const [method, suffix, payload] of [['GET', ''], ['PUT', '', input({ baseUid: 1 })], ['DELETE', '', { baseUid: 1 }], ['POST', '/move', { shared: false }], ['POST', '/copy'], ['POST', '/attachments-to-compose', { composeId: 'draft-one' }]]) status(await f.request(method, `/api/templates/${outside}${suffix}`, payload), 403);
  assert.equal(changes(f).length, 0);
});


const publicRef = id => encodeRef(`PublicTemplates/${id}`, 1, 1);
function publicDatabase() {
  const rows = [
    { id: 1, name: '회사 원본', subject: '{{오늘}} 공용', html: '<p>{{이름}}</p><img src="https://example.test/a.png">', domains: ['example.com'], audienceAll: false, updatedAt: '2026-10-28T07:00:00.000001Z', hasAttachments: true, size: 16, attachments: [{ id: 11, name: 'public.bin', type: 'application/octet-stream', size: 16 }] },
    { id: 2, name: '다른 도메인', subject: '다른 도메인', html: '<p>private</p>', domains: ['other.test'], audienceAll: false, updatedAt: '2026-10-28T07:00:00.000002Z', hasAttachments: true, size: 5, attachments: [{ id: 22, name: 'private', type: 'text/plain', size: 5 }] },
    { id: 3, name: '전체 공개', subject: '전체', html: '<p>all</p>', domains: [], audienceAll: true, updatedAt: '2026-10-28T07:00:00.000003Z', hasAttachments: false, size: 0, attachments: [] },
  ];
  const calls = [], f = { fail: false, failFile: false, fileBytes: Buffer.from('synthetic-public') };
  const visible = (email, row) => row.audienceAll || row.domains.includes(email.split('@')[1]);
  const store = {
    async list(email) {
      calls.push(['list', email]);
      if (f.fail) throw new AppError(503, 'PUBLIC_TEMPLATES_UNAVAILABLE', 'synthetic unavailable');
      return { items: rows.filter(row => visible(email, row)).map(({ html, attachments, ...row }) => row) };
    },
    async get(email, id) {
      calls.push(['get', email, id]); const row = rows.find(row => row.id === id && visible(email, row));
      if (!row) throw new AppError(404, 'NOT_FOUND', '없어요.');
      return structuredClone(row);
    },
    async file(email, id, fileId) {
      calls.push(['file', email, id, fileId]); const row = await store.get(email, id), file = row.attachments.find(file => file.id === fileId);
      if (f.failFile || !file) throw new AppError(404, 'NOT_FOUND', '없어요.');
      return { ...file, data: f.fileBytes };
    },
    async close() {},
  };
  return Object.assign(f, { store, rows, calls });
}

test('public templates API: configured domain-filtered T list/detail and public pins, absent config stays empty', async t => {
  const db = publicDatabase(), f = await fixture(t, { store: db.store });
  const pins = [{ owner: 'public', id: '1' }, { owner: 'public', id: '2' }];
  status(await f.request('PUT', '/api/prefs', { templatePins: pins }), 204);
  let response = await f.request('GET', '/api/templates?domain=other.test&email=forged@other.test'); status(response, 200);
  const list = response.json();
  assert.deepEqual(list.public.map(row => row.id), ['1', '3']); assert.equal(list.publicUnavailable, undefined);
  assert.deepEqual(Object.keys(list.public[0]).sort(), ['hasAttachments','id','inShared','name','owner','ref','size','subject','updatedAt']);
  assert.deepEqual(list.pins, [pins[0]]); assert.equal(list.public[0].owner, 'public'); assert.equal(decodePublicTemplateRef(list.public[0].ref), 1);
  assert.ok(db.calls.every(call => call[1] === user));
  response = await f.request('GET', `/api/templates/${publicRef(1)}`); status(response, 200);
  assert.deepEqual(response.json().attachments, [{ part: '11', name: 'public.bin', type: 'application/octet-stream', size: 16 }]);
  assert.match(response.json().html, /{{이름}}/); assert.equal(response.json().text.includes('{{이름}}'), true);
  assert.equal(db.calls.filter(call => call[0] === 'file').length, 0, 'detail exposes metadata without loading file bytes');
  const unconfigured = await fixture(t);
  const empty = await unconfigured.request('GET', '/api/templates'); status(empty, 200);
  assert.deepEqual(empty.json().public, []); assert.equal(empty.json().publicUnavailable, undefined);
});

test('public templates API: configured DB failure preserves personal/shared list and public pins with partial flag', async t => {
  const db = publicDatabase(), f = await fixture(t, { store: db.store });
  status(await f.request('POST', '/api/templates', input()), 201);
  const pins = [{ owner: 'public', id: '1' }]; status(await f.request('PUT', '/api/prefs', { templatePins: pins }), 204);
  const stored = f.metadata.get(PREFS_ENTRY); db.fail = true;
  const response = await f.request('GET', '/api/templates'); status(response, 200);
  assert.equal(response.json().mine.length, 1); assert.equal(response.json().shared.length, 1);
  assert.deepEqual(response.json().public, []); assert.equal(response.json().publicUnavailable, true); assert.deepEqual(response.json().pins, pins);
  assert.equal(f.metadata.get(PREFS_ENTRY), stored);
  db.fail = false; assert.equal((await f.request('GET', '/api/templates')).json().publicUnavailable, undefined);
});

test('public templates API: unauthenticated/CSRF/origin denied and public templates never expose write actions', async t => {
  const db = publicDatabase(), f = await fixture(t, { store: db.store }), token = publicRef(1);
  for (const [method, suffix, payload] of [['GET',''], ['POST','/copy'], ['POST','/attachments-to-compose',{composeId:'public-draft'}]]) {
    status(await f.request(method, `/api/templates/${token}${suffix}`, payload, { origin: f.headers.origin, authorization: 'Bearer ignored' }), 403);
    if (method === 'POST') {
      status(await f.request(method, `/api/templates/${token}${suffix}`, payload, { ...f.headers, 'x-webmail-csrf': 'bad' }), 403);
      status(await f.request(method, `/api/templates/${token}${suffix}`, payload, { ...f.headers, origin: 'https://other.test' }), 403);
    }
  }
  for (const [method, suffix, payload] of [['PUT','',input({baseUid:1})], ['DELETE','',{baseUid:1}], ['POST','/move',{shared:true}]]) status(await f.request(method, `/api/templates/${token}${suffix}`, payload), 403);
  assert.equal(db.calls.length, 0); assert.equal(changes(f).length, 0);
});

test('public templates API: other-domain detail/copy/attachments are 404 and forged public refs cannot escape namespace', async t => {
  const db = publicDatabase(), f = await fixture(t, { store: db.store });
  for (const [method, suffix, payload] of [['GET',''], ['POST','/copy'], ['POST','/attachments-to-compose',{composeId:'public-draft'}]]) status(await f.request(method, `/api/templates/${publicRef(2)}${suffix}`, payload), 404);
  for (const token of [encodeRef('PublicTemplates',1,1),publicRef('01'),publicRef('0'),publicRef('1/../../INBOX'),publicRef(String(Number.MAX_SAFE_INTEGER+1)),encodeRef('PublicTemplates/1',2,1),encodeRef('PublicTemplates/1',1,2)]) status(await f.request('GET', `/api/templates/${token}`), 400);
  assert.equal(db.calls.some(call => call[0] === 'file'), false); assert.equal(changes(f).length, 0);
});

test('public templates API: attachment uploads and personal copy preserve file bytes; DB source stays unchanged', async t => {
  const db = publicDatabase(), original = structuredClone(db.rows), f = await fixture(t, { store: db.store });
  const attached = await f.request('POST', `/api/templates/${publicRef(1)}/attachments-to-compose`, { composeId: 'public-draft' }); status(attached, 200);
  assert.equal(attached.json().uploads.length, 1); assert.equal(attached.json().html, db.rows[0].html);
  const copied = await f.request('POST', `/api/templates/${publicRef(1)}/copy`); status(copied, 201);
  assert.equal(copied.json().owner, user); assert.notEqual(copied.json().id, '1'); assert.match(copied.json().id, /^[a-f\d-]{36}$/);
  assert.equal(copied.json().inShared, false);
  const raw = f.calls.find(call => call[0] === 'APPEND')[2].toString();
  assert.ok(raw.includes(db.fileBytes.toString('base64'))); assert.ok(raw.includes('Content-Disposition: attachment')); assert.equal(/Content-ID:/i.test(raw), false);
  assert.deepEqual(db.rows, original);
  status(await f.request('DELETE', `/api/attachments/${attached.json().uploads[0].id}`), 204);
});

test('public templates API: copy still respects personal 200-item limit without APPEND', async t => {
  const db = publicDatabase(), f = await fixture(t, { store: db.store });
  for (let i = 0; i < 200; i++) f.add('Templates', templateMime(Buffer.from('Subject: synthetic\r\nDate: Wed, 28 Oct 2026 05:00:00 +0000\r\nContent-Type: text/html\r\n\r\n<p>synthetic</p>'), { id: randomUUID(), name: '합성' }));
  const response = await f.request('POST', `/api/templates/${publicRef(1)}/copy`); status(response, 422); assert.equal(response.json().error.code, 'TEMPLATE_LIMIT');
  assert.equal(f.calls.some(call => call[0] === 'APPEND'), false);
});

test('public template reader: partial-list errors log cause and copy finally cleans temporary uploads on success/failure', async () => {
  const db = publicDatabase(), removed = [], created = [], logs = [], temp = { uploads: [{id:'temporary-one',name:'file',size:1}], html:'<p>clean</p>' };
  let fail = false;
  const reader = createPublicTemplatesReader({ store: db.store, templates: { async create(session, data) { created.push(data); if (fail) throw new AppError(413,'TEMPLATE_TOO_LARGE','large'); return { owner:session.email,id:'new-own' }; } },
    compose: { async publicTemplateAttachments(session, input, template, loadFile) { assert.match(input.composeId, /^public-copy-/); assert.equal((await loadFile(template.attachments[0].part)).data.toString(), 'synthetic-public'); return temp; }, async remove(session,id) { removed.push(id); } },
    logger: { error(data) {logs.push(data);} } });
  await reader.copy({email:user}, publicRef(1)); assert.deepEqual(removed, ['temporary-one']);
  assert.deepEqual(created[0].attachments, [{uploadId:'temporary-one'}]); assert.equal(created[0].shared,false);
  fail=true; await assert.rejects(reader.copy({email:user}, publicRef(1)), {statusCode:413}); assert.deepEqual(removed, ['temporary-one','temporary-one']);
  db.fail=true; assert.deepEqual(await reader.list({email:user}), {items:[],unavailable:true}); assert.equal(logs[0].causeCode,'PUBLIC_TEMPLATES_UNAVAILABLE');
});
