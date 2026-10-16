import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createEventService } from '../../server/mail/events.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSearchQuery } from '../../server/mail/search-query.js';
import { createListService, listOptions } from '../../server/mail/list.js';
import { decodeRef } from '../../server/mail/ref.js';
import { validateDocument } from '../../server/sieve/model.js';
import { createApp } from '../../server/app.js';

const cases = [
  ['from:sender@example.com', [{ from: 'sender@example.com' }], [{ field: 'from', op: 'has', value: 'sender@example.com' }]],
  ['보낸사람:홍길동', [{ from: '홍길동' }], [{ field: 'from', op: 'has', value: '홍길동' }]],
  ['to:team@example.com', [{ or: [{ to: 'team@example.com' }, { cc: 'team@example.com' }] }], [{ field: 'to', op: 'has', value: 'team@example.com' }]],
  ['받는사람:영업팀', [{ or: [{ to: '영업팀' }, { cc: '영업팀' }] }], [{ field: 'to', op: 'has', value: '영업팀' }]],
  ['subject:invoice', [{ subject: 'invoice' }], [{ field: 'subject', op: 'has', value: 'invoice' }]],
  ['제목:견적', [{ subject: '견적' }], [{ field: 'subject', op: 'has', value: '견적' }]],
  ['has:attachment', [{ header: { 'Content-Type': 'multipart/mixed' } }], [{ field: 'attachment', op: 'has', value: '' }]],
  ['첨부:있음', [{ header: { 'Content-Type': 'multipart/mixed' } }], [{ field: 'attachment', op: 'has', value: '' }]],
  ['annual', [{ text: 'annual' }], []],
  ['"annual report"', [{ text: 'annual report' }], []],
  ['from:"Jane Doe"', [{ from: 'Jane Doe' }], [{ field: 'from', op: 'has', value: 'Jane Doe' }]],
  ['SUBJECT:"견적 요청"', [{ subject: '견적 요청' }], [{ field: 'subject', op: 'has', value: '견적 요청' }]],
  ['unknown:value', [{ text: 'unknown:value' }], []],
  ['from:a@example.com from:b@example.org', [{ from: 'a@example.com' }, { from: 'b@example.org' }], [{ field: 'from', op: 'has', value: 'a@example.com' }, { field: 'from', op: 'has', value: 'b@example.org' }]],
];
for (const [query, imap, rules] of cases) test(`search: ${query}`, () => {
  const parsed = parseSearchQuery(query); assert.deepEqual(parsed.imap, imap); assert.deepEqual(parsed.ruleConditions, rules);
  if (rules.length) assert.doesNotThrow(() => validateDocument({ v: 1, rev: 0, blocked: [], vacation: { enabled: false, start: null, end: null, subject: '', body: '' }, rules: [{ id: 'rule0001', enabled: true, match: 'all', conditions: rules, actions: { read: true }, stop: false }] }, { checkPolicy: false }));
});
test('search: folder filters excluded from rule conditions, body words retained separately', () => {
  const parsed = parseSearchQuery('폴더:"Projects/견적" in:Archive 본문 "두 낱말"'); assert.deepEqual(parsed.folderFilters, ['Projects/견적', 'Archive']); assert.deepEqual(parsed.ruleConditions, []); assert.deepEqual(parsed.textTerms, ['본문', '두 낱말']);
});
test('search: escaped quotes, invalid quotes/empty field/control/model-invalid values', () => {
  assert.equal(parseSearchQuery('subject:"say \\"hello\\""').imap[0].subject, 'say "hello"');
  for (const q of ['"unclosed', 'from:', 'from:${bad}', 'subject:' + 'x'.repeat(201), 'bad\r\nquery']) assert.throws(() => parseSearchQuery(q), { statusCode: 400 });
});
test('list options: K13 allmail search and spam/trash exceptions, input validation', () => {
  assert.equal(listOptions({ q: 'invoice' }).mailbox, 'WebmailVirtual/AllMail');
  assert.equal(listOptions({ view: 'spam', q: 'invoice' }).mailbox, 'Junk');
  assert.equal(listOptions({ view: 'folder', folder: 'Trash', q: 'invoice' }).mailbox, 'Trash');
  assert.equal(listOptions({ view: 'folder', folder: 'Projects' }).mailbox, 'Projects');
  for (const query of [{ view: 'bad' }, { view: 'folder' }, { quick: 'bad' }, { page: '0' }, { pageSize: '-1' }, { page: ['1', '2'] }, { q: ['one', 'two'] }]) assert.throws(() => listOptions(query), { statusCode: 400 });
});

class ListImap extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.usable = false; this.enabled = new Set(); this.capabilities = new Map(); this.sorts = []; this.fetches = []; this.rawFetches = 0; this.uidValidity = 321;
    this.unflagged = new Set(); this.uids = [5, 4, 3, 2, 1]; this.sources = new Map(this.uids.map(uid => [uid, uid % 2 ? 'INBOX' : 'Projects/견적']));
    this.mailboxes = ['INBOX', 'Junk', 'Trash', 'Projects/견적', 'WebmailVirtual/AllMail'];
  }
  async connect() { this.usable = true; }
  close() { this.usable = false; }
  async logout() { this.close(); }
  async getMailboxLock(path) { if (!this.mailboxes.includes(path)) throw Object.assign(new Error('synthetic missing mailbox'), { code: 'NotFound' }); this.mailbox = { path, uidValidity: BigInt(this.uidValidity) }; return { release() {} }; }
  async list() { return this.mailboxes.map(path => ({ path, name: path.split('/').at(-1), specialUse: this.specialUses?.get(path) })); }
  async fetchOne(uid) { return this.uids.includes(uid) ? { uid } : false; }
  async messageFlagsRemove(range) { for (const uid of range.split(',').map(Number)) this.unflagged.add(uid); return true; }
  async exec(command, attributes, { untagged } = {}) {
    if (command === 'MYRIGHTS') untagged.MYRIGHTS({ attributes: [attributes[0], { value: 'lrswite' }] });
    if (command === 'UID SORT') {
      this.sorts.push(attributes);
      const wire = JSON.stringify(attributes);
      const filtered = /UNSEEN|FLAGGED|multipart\/mixed/.test(wire) ? this.uids.filter(uid => uid % 2 === 0 && (!wire.includes('FLAGGED') || !this.unflagged.has(uid))) : this.uids;
      untagged.SORT({ attributes: filtered.map(uid => ({ value: String(uid) })) });
    }
    if (command === 'UID FETCH') {
      this.rawFetches++;
      for (const uid of attributes[0].value.split(',').map(Number)) untagged.FETCH({ attributes: [{ value: 'FETCH' }, [{ value: 'UID' }, { value: String(uid) }, { value: 'X-MAILBOX' }, { value: this.sources.get(uid) }, { value: 'X-REAL-UID' }, { value: String(uid + 100) }]] });
    }
    if (command === 'STATUS') untagged.STATUS({ attributes: [attributes[0], [{ value: 'UIDVALIDITY' }, { value: '123' }]] });
    return { next() {} };
  }
  async *fetch(range, query, options) {
    this.fetches.push({ range, query, options });
    // UID 순으로 응답해도 목록은 SORT 순서로 복원한다.
    for (const uid of range.split(',').map(Number).sort((a, b) => a - b)) {
      if (uid === this.disappeared) continue;
      yield { uid, envelope: { from: [{ name: '예제', address: 'sender@example.com' }], to: [{ name: '팀', address: 'team@example.org' }], subject: '합성 메일 ' + uid, date: new Date('1999-01-01') }, internalDate: new Date(Date.UTC(2026, 0, uid)), size: uid * 100, flags: new Set(uid % 2 ? ['\\Seen', '\\Answered'] : ['\\Flagged']), headers: Buffer.from(uid % 2 ? 'Content-Type: multipart/alternative\r\n' : 'Content-Type:\r\n multipart/mixed; boundary=synthetic\r\n') };
    }
  }
}
function fixture() {
  const client = new ListImap(); let time = 0;
  const imap = { async withMailbox(_session, path, operation) { await client.getMailboxLock(path); return operation(client); } };
  return { client, imap, session: {}, service: createListService({ imap, now: () => time }), advance(ms) { time += ms; } };
}
test('list: received-time SORT and minimal FETCH, returned order/flags/attachments/date/ref', async () => {
  const f = fixture(); const result = await f.service.messages(f.session, { pageSize: '2' });
  assert.equal(result.total, 5); assert.deepEqual(result.items.map(item => decodeRef(item.ref).uid), [5, 4]);
  assert.deepEqual(f.client.sorts[0].slice(0, 2), [[{ type: 'ATOM', value: 'REVERSE' }, { type: 'ATOM', value: 'ARRIVAL' }], { type: 'ATOM', value: 'UTF-8' }]);
  assert.equal(result.items[0].date, '2026-01-05T00:00:00.000Z'); assert.equal(result.items[0].seen, true); assert.equal(result.items[0].answered, true); assert.equal(result.items[1].flagged, true); assert.equal(result.items[0].hasAttachment, false); assert.equal(result.items[1].hasAttachment, true);
  assert.deepEqual(f.client.fetches[0].query, { envelope: true, flags: true, internalDate: true, size: true, headers: ['CONTENT-TYPE'] }); assert.deepEqual(f.client.fetches[0].options, { uid: true });
});
test('list: pagination keeps snapshot for 60s, then refreshes; session and search keys are isolated', async () => {
  const f = fixture(); await f.service.messages(f.session, { pageSize: '2' }); f.client.uids.unshift(6);
  const second = await f.service.messages(f.session, { page: '2', pageSize: '2' }); assert.deepEqual(second.items.map(item => decodeRef(item.ref).uid), [3, 2]); assert.equal(second.total, 5); assert.equal(f.client.sorts.length, 1);
  f.advance(59999); await f.service.messages(f.session, {}); assert.equal(f.client.sorts.length, 1);
  f.advance(1); assert.equal((await f.service.messages(f.session, {})).total, 6); assert.equal(f.client.sorts.length, 2);
  await f.service.messages({}, {}); assert.equal(f.client.sorts.length, 3);
  await f.service.messages(f.session, { quick: 'unread' }); assert.equal(f.client.sorts.length, 4);
});
for (const [quick, token] of [['unread', 'UNSEEN'], ['starred', 'FLAGGED'], ['attach', 'multipart/mixed']]) test(`quick filter: ${quick}`, async () => {
  const f = fixture(); const result = await f.service.messages(f.session, { quick }); assert.ok(JSON.stringify(f.client.sorts[0]).includes(token)); assert.deepEqual(result.items.map(item => decodeRef(item.ref).uid), [4, 2]);
});
test('list: UIDVALIDITY change invalidates cache; out of range pages and vanished messages are safe', async () => {
  const f = fixture(); await f.service.messages(f.session, {}); f.client.uidValidity = 322; f.client.disappeared = 5;
  const changed = await f.service.messages(f.session, {}); assert.equal(f.client.sorts.length, 2); assert.equal(changed.items.length, 4); assert.equal(decodeRef(changed.items[0].ref).uidValidity, 322);
  const far = await f.service.messages(f.session, { page: '100' }); assert.equal(far.total, 5); assert.deepEqual(far.items, []);
});
test('list: allmail uses original folder/UID/UIDVALIDITY, no virtual reference leaks', async () => {
  const f = fixture(); const result = await f.service.messages(f.session, { view: 'allmail', pageSize: '2' });
  assert.deepEqual(decodeRef(result.items[1].ref), { path: 'Projects/견적', uidValidity: 123, uid: 104 }); assert.equal(result.items[1].folder, 'Projects/견적'); assert.equal(result.items[1].folderName, '견적'); assert.equal(f.client.rawFetches, 1);
});
test('list: source folder filtering happens before total and pagination, Korean folder name resolves', async () => {
  const f = fixture(); const result = await f.service.messages(f.session, { q: '폴더:견적', pageSize: '1', page: '2' });
  assert.equal(result.total, 2); assert.equal(decodeRef(result.items[0].ref).uid, 102); assert.equal(result.items[0].folder, 'Projects/견적');
  const unknown = await f.service.messages(f.session, { view: 'allmail', in: 'missing' }); assert.equal(unknown.total, 0);
});
test('list: Korean SORT contains one UTF-8 charset, duplicate conditions survive, missing allmail fails without fallback', async () => {
  const f = fixture(); await f.service.messages(f.session, { q: 'from:홍길동 subject:견적 subject:요청' });
  const wire = f.client.sorts[0]; assert.equal(wire.filter(token => token?.value === 'UTF-8').length, 1); assert.ok(!wire.some(token => token?.value === 'CHARSET')); assert.equal(wire.filter(token => token?.value === 'SUBJECT').length, 2);
  f.client.mailboxes = f.client.mailboxes.filter(path => path !== 'WebmailVirtual/AllMail');
  await assert.rejects(f.service.messages(f.session, { view: 'allmail' }), { statusCode: 503, code: 'ALLMAIL_UNAVAILABLE' });
});
test('route: authenticated messages endpoint, invalid query 400 and non-login 403', async t => {
  const config = { publicHostnames: ['newmail.example.com'], trustProxy: ['127.0.0.0/8'], logLevel: 'silent', sessionIdleMin: 480, sessionMaxHours: 24, imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com', brandName: '메일' };
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-w05-test-'));
  const app = await createApp({ config, logger: false, auth: { tempRoot, clientFactory: options => new ListImap(options) } });
  app.directory.mailboxName = async email => email;
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  assert.equal((await app.inject('/api/messages')).statusCode, 403);
  const logged = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://newmail.example.com' }, payload: { email: 'user@example.com', password: 'synthetic-imap-password' } }); assert.equal(logged.statusCode, 200);
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://newmail.example.com', 'x-webmail-csrf': logged.json().csrf };
  const listed = await app.inject({ url: '/api/messages?pageSize=2', headers }); assert.equal(listed.statusCode, 200); assert.equal(listed.json().items.length, 2); assert.equal(listed.headers['www-authenticate'], undefined);
  assert.equal((await app.inject({ url: '/api/messages?page=-1', headers })).statusCode, 400);
  const starred = await app.inject({ url: '/api/messages?quick=starred', headers });
  assert.equal(starred.json().total, 2);
  const token = starred.json().items[0].ref;
  const changed = await app.inject({ method: 'POST', url: '/api/messages/actions', headers, payload: { refs: [token], action: 'unflag' } });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().done, 1);
  const refreshed = await app.inject({ url: '/api/messages?quick=starred', headers });
  assert.equal(refreshed.json().total, 1);
  assert.ok(refreshed.json().items.every(item => item.ref !== token));
});


test('list: special-use paths scope searches; ordinary folders search allmail; defaults remain fallback', async () => {
  const f = fixture();
  f.client.mailboxes.push('Deleted Items', 'Spam Mail');
  f.client.specialUses = new Map([['Deleted Items', '\\Trash'], ['Spam Mail', '\\Junk']]);
  for (const path of ['Deleted Items', 'Spam Mail']) {
    await f.service.messages(f.session, { view: 'folder', folder: path, q: 'invoice' });
    assert.equal(f.client.mailbox.path, path);
  }
  await f.service.messages(f.session, { view: 'spam', q: 'invoice' });
  assert.equal(f.client.mailbox.path, 'Spam Mail');
  await f.service.messages(f.session, { view: 'folder', folder: 'Projects/견적', q: 'invoice' });
  assert.equal(f.client.mailbox.path, 'WebmailVirtual/AllMail');
  const folders = await f.client.list();
  assert.equal(listOptions({ view: 'folder', folder: 'Trash', q: 'invoice' }, folders).mailbox, 'WebmailVirtual/AllMail');
  f.client.specialUses.clear();
  for (const path of ['Trash', 'Junk']) {
    await f.service.messages(f.session, { view: 'folder', folder: path, q: 'fallback' });
    assert.equal(f.client.mailbox.path, path);
  }
  await f.service.messages(f.session, { view: 'folder', folder: 'Deleted Items', q: 'fallback' });
  assert.equal(f.client.mailbox.path, 'WebmailVirtual/AllMail');
  await f.service.messages(f.session, { view: 'spam', q: 'fallback' });
  assert.equal(f.client.mailbox.path, 'Junk');
});

test('list: explicit invalidation refreshes only the given session', async () => {
  const f = fixture(), other = {};
  await f.service.messages(f.session, {}); await f.service.messages(other, {});
  f.client.uids.pop(); f.service.invalidate(f.session);
  assert.equal((await f.service.messages(f.session, {})).total, 4);
  assert.equal((await f.service.messages(other, {})).total, 5);
  assert.equal(f.client.sorts.length, 3);
});


test('SSE mailbox change: watch invalidates only the matching session list cache', async t => {
  const f = fixture(), other = {};
  let notify;
  f.imap.watch = (session, callback) => { assert.equal(session, f.session); notify = callback; return () => {}; };
  f.client.status = async () => ({ messages: f.client.uids.length, unseen: 2 });
  f.client.getQuota = async () => ({ storage: { usage: 100, limit: 1000 } });
  const events = createEventService({ imap: f.imap, listService: f.service, sessions: { expiresAt: () => '2099-01-01T00:00:00Z' } });
  const stream = events.open(f.session);
  t.after(() => stream.destroy());
  let text = '';
  stream.on('data', chunk => { text += chunk; });
  await nextTurn();
  assert.match(text, /event: mailbox\ndata: {"path":"INBOX","unseen":2,"total":5}/);
  await f.service.messages(f.session, {});
  await f.service.messages(other, {});
  assert.equal(f.client.sorts.length, 2);
  const before = text;
  notify(); await nextTurn();
  assert.equal(text, before);
  await f.service.messages(f.session, {});
  assert.equal(f.client.sorts.length, 2);
  f.client.uids.unshift(6);
  notify(); await nextTurn();
  assert.match(text, /event: mailbox\ndata: {"path":"INBOX","unseen":2,"total":6}/);
  const refreshed = await f.service.messages(f.session, {});
  assert.equal(refreshed.total, 6);
  assert.equal(decodeRef(refreshed.items[0].ref).uid, 6);
  assert.equal((await f.service.messages(other, {})).total, 5);
  assert.equal(f.client.sorts.length, 3);
});

for (const query of ['view=allmail&q=invoice', 'view=folder&folder=Trash&q=invoice']) test(`search timeout: ${query} returns SEARCH_SLOW at 50s, reconnects work and preserves SSE monitor`, async t => {
  const config = { publicHostnames: ['newmail.example.com'], trustProxy: ['127.0.0.0/8'], logLevel: 'silent', sessionIdleMin: 480, sessionMaxHours: 24, imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com', brandName: '메일' };
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-search-timeout-')), clients = [];
  let started = false;
  const app = await createApp({ config, logger: false, auth: { tempRoot, clientFactory: options => {
    const client = new ListImap(options), exec = client.exec.bind(client);
    clients.push(client);
    client.close = () => { client.usable = false; client.emit('close'); };
    client.mailboxOpen = async path => { await client.getMailboxLock(path); return client.mailbox; };
    client.idle = async () => new Promise(() => {});
    client.exec = async (...args) => {
      if (client.slow && args[0] === 'UID SORT') {
        started = true;
        return new Promise((_resolve, reject) => client.once('close', () => reject(new Error('synthetic closed command'))));
      }
      return exec(...args);
    };
    return client;
  } } });
  let stop;
  app.directory.mailboxName = async email => email;
  t.after(async () => { stop?.(); await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  const logged = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://newmail.example.com' }, payload: { email: 'user@example.com', password: 'synthetic-search-password' } });
  assert.equal(logged.statusCode, 200);
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0] };
  const session = await app.sessions.get(headers.cookie.split('=')[1]);
  let notifications = 0;
  stop = app.imap.watch(session, () => notifications++);
  for (let i = 0; i < 5; i++) await nextTurn();
  const monitor = clients[1];
  assert.equal(monitor.usable, true);
  clients[0].slow = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = app.inject({ url: '/api/messages?' + query, headers }).then(response => { settled = true; return response; });
  for (let i = 0; i < 5; i++) await nextTurn();
  assert.equal(started, true);
  t.mock.timers.tick(49999); await nextTurn(); assert.equal(settled, false);
  t.mock.timers.tick(1);
  const response = await pending;
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: { code: 'SEARCH_SLOW', message: '메일함 검색 색인을 만드는 중이에요. 잠시 뒤 다시 검색해 주세요.' } });
  assert.equal(response.headers['www-authenticate'], undefined);
  assert.equal(clients[0].usable, false);
  assert.equal(monitor.usable, true);
  monitor.emit('exists', { count: 6 }); assert.equal(notifications, 1);
  const listed = await app.inject({ url: '/api/messages', headers });
  assert.equal(listed.statusCode, 200); assert.equal(listed.json().total, 5);
  const searched = await app.inject({ url: '/api/messages?' + query, headers });
  assert.equal(searched.statusCode, 200); assert.equal(searched.json().total, 5);
  assert.equal(clients.length, 3); assert.equal(clients[2].usable, true); assert.equal(monitor.usable, true);
});

test('ordinary list SORT can exceed 50 seconds without SEARCH_SLOW or closing its connection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), exec = f.client.exec.bind(f.client);
  let resume, closed = 0, settled = false;
  f.client.close = () => { closed++; };
  f.client.exec = async (...args) => { if (args[0] === 'UID SORT') await new Promise(resolve => { resume = resolve; }); return exec(...args); };
  const pending = f.service.messages(f.session, {}).then(result => { settled = true; return result; });
  await nextTurn();
  t.mock.timers.tick(55000); await nextTurn();
  assert.equal(settled, false); assert.equal(closed, 0);
  resume(); assert.equal((await pending).total, 5); assert.equal(closed, 0);
});
