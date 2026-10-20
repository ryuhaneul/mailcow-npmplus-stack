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
import { decodeRef, encodeRef, originalRefs } from '../../server/mail/ref.js';
import { scopeOptions, resolveListScope, sortUids, searchUids, resolveCandidateSources, matchesFolderFilters } from '../../server/mail/list-query.js';
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


async function scopeCandidates(f, query, options = {}) {
  const scope = await resolveListScope(f.session, query, { imap: f.imap, budget: options.budget });
  return f.imap.withMailbox(f.session, scope.mailbox, async client => {
    const uids = await sortUids(client, scope.imap, scope.searching, { budget: options.budget });
    return resolveCandidateSources(client, f.session, uids, scope, options);
  }, { budget: options.budget });
}

test('shared scope: pagination is list-only, defaults and invalid conditions agree', async () => {
  assert.deepEqual(scopeOptions(), { mailbox: 'INBOX', filters: [], imap: [], searching: false });
  assert.deepEqual(scopeOptions({ page: 'invalid', pageSize: '-1' }), scopeOptions());
  assert.throws(() => listOptions({ page: 'invalid' }), { code: 'LIST_QUERY_INVALID' });
  for (const query of [{ view: 'bad' }, { view: 'folder' }, { quick: 'bad' }, { q: '\u0000' }, { in: [] }, { q: 'from:' }, { q: '"unclosed' }]) {
    const f = fixture();
    await assert.rejects(resolveListScope(f.session, query, { imap: f.imap }), { statusCode: 400 });
    await assert.rejects(f.service.messages(f.session, query), { statusCode: 400 });
  }
});

for (const view of ['inbox', 'allmail', 'folder', 'spam']) {
  for (const quick of ['all', 'unread', 'starred', 'attach']) {
    test(`shared candidates equal list: ${view}/${quick}, folder-only and combined filters`, async () => {
      const variants = [
        {}, { q: 'in:견적' }, { q: 'in:Projects/견적' }, { q: '폴더:견적', in: 'Projects/견적' },
        { q: 'in:견적', in: 'INBOX' }, { in: '견적' }, { q: 'subject:견적', in: '견적' },
        { q: 'from:sender@example.com' }, { q: 'in:missing' }, { q: 'in:INBOX in:견적' },
      ];
      for (const variant of variants) {
        const f = fixture(), query = { view, quick, ...(view === 'folder' ? { folder: 'Projects/견적' } : {}), ...variant };
        const listed = await f.service.messages(f.session, { ...query, pageSize: '100' });
        const candidates = await scopeCandidates(f, query, { freshValidity: true });
        assert.deepEqual(candidates.map(source => source.ref).sort(), listed.items.map(item => item.ref).sort(), JSON.stringify(query));
        assert.equal(candidates.length, listed.total);
        assert.ok(candidates.every(source => source.path !== 'WebmailVirtual/AllMail'));
        const narrowed = quick === 'all' ? [5, 4, 3, 2, 1] : [4, 2];
        const virtual = view === 'allmail' || (view !== 'spam' && Boolean(variant.q));
        const mailbox = view === 'spam' ? 'Junk' : view === 'folder' ? 'Projects/견적' : 'INBOX';
        const filters = [...(variant.q?.includes('in:INBOX') ? ['INBOX'] : []), ...(variant.q?.includes('견적') && !variant.q.startsWith('subject:') ? ['Projects/견적'] : []), ...(variant.q?.includes('in:missing') ? ['missing'] : []), ...(variant.in ? [variant.in === '견적' ? 'Projects/견적' : variant.in] : [])];
        const expected = narrowed.filter(uid => filters.every(path => path === (virtual ? f.client.sources.get(uid) : mailbox)));
        assert.deepEqual(candidates.map(source => source.uid), expected.map(uid => virtual ? uid + 100 : uid), JSON.stringify(query));
      }
    });
  }
}

test('shared folders: exact path wins; ambiguous basename fails in both callers; filters use AND', async () => {
  const f = fixture();
  f.client.mailboxes.push('Other/견적');
  for (const query of [{ q: 'in:견적' }, { view: 'allmail', in: '견적' }]) {
    await assert.rejects(scopeCandidates(f, query), { code: 'SEARCH_FOLDER_AMBIGUOUS' });
    await assert.rejects(f.service.messages(f.session, query), { code: 'SEARCH_FOLDER_AMBIGUOUS' });
  }
  assert.equal((await scopeCandidates(f, { q: 'in:Projects/견적' })).length, 2);
  f.client.mailboxes.push('견적');
  assert.deepEqual((await resolveListScope(f.session, { q: 'in:견적' }, { imap: f.imap })).filters, ['견적']);
  assert.equal((await scopeCandidates(f, { q: 'in:견적' })).length, 0);
  assert.equal(matchesFolderFilters('INBOX', ['INBOX', 'Projects/견적']), false);
});

test('shared special-use scope: Trash/Junk searches stay local; ordinary folders search actual virtual candidates', async () => {
  const f = fixture();
  f.client.mailboxes.push('Deleted Items', 'Spam Mail', 'Drafts', 'Shared/team', 'Excluded');
  f.client.specialUses = new Map([['Deleted Items', '\\Trash'], ['Spam Mail', '\\Junk']]);
  for (const query of [
    { view: 'folder', folder: 'Deleted Items', q: 'in:"Deleted Items"' },
    { view: 'folder', folder: 'Spam Mail', q: 'invoice' },
    { view: 'spam', q: 'invoice' },
    { view: 'folder', folder: 'Projects/견적', q: 'invoice' },
    { view: 'folder', folder: 'Trash', q: 'invoice' },
  ]) {
    const scope = await resolveListScope(f.session, query, { imap: f.imap });
    const listed = await f.service.messages(f.session, query), sources = await scopeCandidates(f, query);
    assert.deepEqual(sources.map(source => source.ref), listed.items.map(item => item.ref));
    const expected = query.folder === 'Deleted Items' ? 'Deleted Items' : query.view === 'spam' || query.folder === 'Spam Mail' ? 'Spam Mail' : 'WebmailVirtual/AllMail';
    assert.equal(scope.mailbox, expected);
    assert.ok(sources.every(source => !['Drafts', 'Shared/team', 'Excluded'].includes(source.path)));
  }
  const ordinary = await scopeCandidates(f, { view: 'folder', folder: 'Projects/견적', q: 'invoice' });
  assert.ok(ordinary.some(source => source.path === 'INBOX'));
  assert.deepEqual(scopeOptions({ q: '이전:2025-01-01' }).imap, [{ text: '이전:2025-01-01' }]);
});

test('list retains page-only original conversion; empty candidate input issues no FETCH', async () => {
  const f = fixture();
  await f.service.messages(f.session, { view: 'allmail', pageSize: '1' });
  assert.equal(f.client.rawFetches, 1);
  assert.deepEqual(await resolveCandidateSources(f.client, f.session, [], { mailbox: 'WebmailVirtual/AllMail', filters: [] }, { freshValidity: true }), []);
  assert.equal(f.client.rawFetches, 1);
});

test('fresh original validity bypasses the display cache and brackets authoritative mapping FETCH', async () => {
  const f = fixture(), exec = f.client.exec.bind(f.client);
  let validity = 123, statuses = 0;
  f.client.exec = async (command, attributes, options) => {
    if (command !== 'STATUS') return exec(command, attributes, options);
    statuses++;
    options.untagged.STATUS({ attributes: [attributes[0], [{ value: 'UIDVALIDITY' }, { value: String(validity) }]] });
    return { next() {} };
  };
  await f.client.getMailboxLock('WebmailVirtual/AllMail');
  const old = await originalRefs(f.client, f.session, '4');
  validity = 456;
  assert.equal(decodeRef((await originalRefs(f.client, f.session, '4'))[0].ref).uidValidity, 123);
  const fresh = await resolveCandidateSources(f.client, f.session, [4], { mailbox: 'WebmailVirtual/AllMail', filters: [] }, { freshValidity: true });
  assert.equal(decodeRef(old[0].ref).uidValidity, 123);
  assert.equal(fresh[0].uidValidity, 456);
  assert.equal(decodeRef(fresh[0].ref).uidValidity, 456);
  assert.equal(statuses, 9);
});

for (const race of ['source-recreated-same-uid', 'virtual-recreated', 'mapping-new-folder', 'mapping-missing']) {
  test(`fresh original conversion rejects ${race} before a candidate can be changed`, async () => {
    const f = fixture(), exec = f.client.exec.bind(f.client);
    await f.client.getMailboxLock('WebmailVirtual/AllMail');
    let validity = 123, fetches = 0, changes = 0;
    f.client.exec = async (command, attributes, options) => {
      if (command === 'STATUS') {
        options.untagged.STATUS({ attributes: [attributes[0], [{ value: 'UIDVALIDITY' }, { value: String(validity) }]] });
        return { next() {} };
      }
      if (command === 'UID FETCH' && ++fetches === 1) {
        if (race === 'source-recreated-same-uid') validity = 456;
        if (race === 'virtual-recreated') f.client.mailbox.uidValidity = 999n;
        if (race === 'mapping-new-folder') f.client.sources.set(4, 'NewFolder');
        if (race === 'mapping-missing') return { next() {} };
      }
      return exec(command, attributes, options);
    };
    await assert.rejects((async () => {
      await resolveCandidateSources(f.client, f.session, [4], { mailbox: 'WebmailVirtual/AllMail', filters: [] }, { freshValidity: true });
      changes++;
    })(), { code: 'STALE_SCOPE' });
    assert.equal(changes, 0);
    assert.equal(fetches, 1);
  });
}

test('fresh original conversion rejects an initially missing virtual UID', async () => {
  const f = fixture(); await f.client.getMailboxLock('WebmailVirtual/AllMail');
  const exec = f.client.exec.bind(f.client);
  f.client.exec = async (...args) => args[0] === 'UID FETCH' ? { next() {} } : exec(...args);
  await assert.rejects(resolveCandidateSources(f.client, f.session, [4], { mailbox: 'WebmailVirtual/AllMail', filters: [] }, { freshValidity: true }), { code: 'STALE_SCOPE' });
});

for (const [phase, failure, code] of [
  ['after', 'NO', 'STALE_SCOPE'], ['after', 'BAD', 'STALE_SCOPE'],
  ['before', 'NO', 'MAIL_REJECTED'], ['after', 'transport', 'ETIMEDOUT'],
]) {
  test(`fresh original conversion ${phase}-mapping STATUS ${failure} returns ${code}`, async () => {
    const f = fixture(); await f.client.getMailboxLock('WebmailVirtual/AllMail');
    const exec = f.client.exec.bind(f.client);
    let mapped = false;
    f.client.exec = async (command, attributes, options) => {
      if (command === 'STATUS' && attributes[0].value === 'INBOX' && mapped === (phase === 'after')) {
        throw Object.assign(new Error('synthetic source STATUS failure'), failure === 'transport' ? { code: 'ETIMEDOUT' } : { responseStatus: failure });
      }
      const result = await exec(command, attributes, options);
      if (command === 'UID FETCH') mapped = true;
      return result;
    };
    await assert.rejects(originalRefs(f.client, f.session, '5', { freshValidity: true }), error => error.code === code && (code !== 'STALE_SCOPE' || error.statusCode === 409));
    assert.equal(f.client.rawFetches, phase === 'after' ? 1 : 0);
  });
}

test('shared budget: forwards the same budget, rejects before I/O and preserves upstream errors', async () => {
  const f = fixture(), expired = { remainingMs: () => 0 }, budget = { remainingMs: () => 1000 };
  for (const operation of [
    () => resolveListScope(f.session, { q: 'in:견적' }, { imap: f.imap, budget: expired }),
    () => sortUids(f.client, [], false, { budget: expired }),
    () => resolveCandidateSources(f.client, f.session, [4], { mailbox: 'WebmailVirtual/AllMail', filters: [] }, { budget: expired }),
    () => f.service.metadata(f.session, [encodeRef('INBOX', 321, 4)], { budget: expired }),
  ]) await assert.rejects(operation(), error => error.code === 'MAIL_UNAVAILABLE' && error.budgetExhausted === true);
  assert.equal(f.client.sorts.length, 0); assert.equal(f.client.rawFetches, 0); assert.equal(f.client.fetches.length, 0);
  const failure = Object.assign(new Error('synthetic exhausted'), { code: 'MAIL_UNAVAILABLE', budgetExhausted: true });
  const imap = { async withMailbox(_session, _path, _operation, options) { assert.equal(options.budget, budget); throw failure; } };
  await assert.rejects(resolveListScope(f.session, { view: 'spam' }, { imap, budget }), error => error === failure);
  const metadata = createListService({ imap });
  await assert.rejects(metadata.metadata(f.session, [encodeRef('INBOX', 321, 4)], { budget }), error => error === failure);
});

test('shared budget stops original conversion between I/O operations', async () => {
  const f = fixture(); await f.client.getMailboxLock('WebmailVirtual/AllMail');
  const exec = f.client.exec.bind(f.client);
  let remaining = 1000, statuses = 0;
  f.client.exec = async (...args) => {
    if (args[0] === 'STATUS') statuses++;
    const result = await exec(...args);
    if (args[0] === 'UID FETCH') remaining = 0;
    return result;
  };
  await assert.rejects(originalRefs(f.client, f.session, '4', { freshValidity: true, budget: { remainingMs: () => remaining } }), error => error.budgetExhausted === true);
  assert.equal(statuses, 4);
});

test('shared SORT uses remaining request budget rather than a new search timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let remaining = 17, closed = 0;
  f.client.exec = async () => new Promise(() => {});
  f.client.close = () => { closed++; };
  const pending = assert.rejects(sortUids(f.client, [], true, { budget: { remainingMs: () => remaining } }), error => error.code === 'MAIL_UNAVAILABLE' && error.budgetExhausted === true);
  t.mock.timers.tick(16); await nextTurn(); assert.equal(closed, 0);
  remaining = 0; t.mock.timers.tick(1); await pending; assert.equal(closed, 1);
});

test('failed-list metadata: minimal read-only FETCH, original identity/order, missing omitted and stale refused', async () => {
  const f = fixture(), refs = [encodeRef('Projects/견적', 321, 2), encodeRef('INBOX', 321, 5), encodeRef('Projects/견적', 321, 4)];
  const budget = { remainingMs: () => 1000 }, withMailbox = f.imap.withMailbox.bind(f.imap);
  f.imap.withMailbox = async (session, path, operation, options) => {
    assert.equal(options.budget, budget);
    return withMailbox(session, path, operation);
  };
  f.client.disappeared = 4;
  const rows = await f.service.metadata(f.session, refs, { budget });
  assert.deepEqual(rows.map(row => row.ref), refs.slice(0, 2));
  assert.deepEqual(rows.map(row => row.folder), ['Projects/견적', 'INBOX']);
  assert.equal(f.client.fetches.length, 2);
  assert.deepEqual(f.client.fetches[0].query, { envelope: true, flags: true, internalDate: true, size: true, headers: ['CONTENT-TYPE'] });
  assert.deepEqual(f.client.fetches[0].options, { uid: true });
  assert.equal(f.client.unflagged.size, 0); assert.equal(f.client.rawFetches, 0); assert.equal(f.client.sorts.length, 0);
  f.client.fetches.length = 0;
  await assert.rejects(f.service.metadata(f.session, [encodeRef('INBOX', 999, 5)], { budget }), { code: 'STALE_REF' });
  await assert.rejects(f.service.metadata(f.session, [encodeRef('missing', 321, 5)], { budget }), { code: 'STALE_REF' });
  assert.equal(f.client.fetches.length, 0);
  assert.deepEqual(await f.service.metadata(f.session, [], { budget }), []);
});


test('scoped SEARCH shares compiler and UID validation without SORT or FETCH', async () => {
  let wire;
  const client = { enabled: new Set(), capabilities: new Map(), async exec(...args) {
    wire = args;
    args[2].untagged.SEARCH({ attributes: [{ value: '9' }, { value: '2' }] });
    return { next() {} };
  } };
  assert.deepEqual(await searchUids(client, [{ uid: '2,9' }, { seen: false }, { subject: '합성' }]), [9, 2]);
  assert.equal(wire[0], 'UID SEARCH');
  assert.deepEqual(wire[1].slice(0, 5), [{ type: 'ATOM', value: 'CHARSET' }, { type: 'ATOM', value: 'UTF-8' }, { type: 'ATOM', value: 'UID' }, { type: 'SEQUENCE', value: '2,9' }, { type: 'ATOM', value: 'UNSEEN' }]);
  client.exec = async (_command, _attributes, options) => { options.untagged.SEARCH({ attributes: [{ value: '4294967296' }] }); return { next() {} }; };
  await assert.rejects(searchUids(client, []), { code: 'MAIL_UNAVAILABLE' });
  await assert.rejects(searchUids(client, [], false, { budget: { remainingMs: () => 0 } }), error => error.budgetExhausted);
});

test('scoped SEARCH closes its connection on shared request deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = { enabled: new Set(), capabilities: new Map(), closed: false, close() { this.closed = true; }, exec() { return new Promise(() => {}); } };
  const result = assert.rejects(searchUids(client, [{ uid: '1:5000' }], true, { budget: { remainingMs: () => 25 } }), error => error.budgetExhausted && error.code === 'MAIL_UNAVAILABLE');
  t.mock.timers.tick(25); await result; assert.equal(client.closed, true);
});


test('scoped SEARCH follows compiler charset rules on ASCII and UTF8=ACCEPT connections', async () => {
  let attributes;
  const client = { enabled: new Set(), capabilities: new Map(), async exec(_command, wire) { attributes = wire; return { next() {} }; } };
  await searchUids(client, [{ uid: '1:5000' }]);
  assert.deepEqual(attributes, [{ type: 'ATOM', value: 'UID' }, { type: 'SEQUENCE', value: '1:5000' }]);
  client.enabled.add('UTF8=ACCEPT');
  await searchUids(client, [{ uid: '1:5000' }, { subject: '합성' }, { from: '합성@example.com' }]);
  assert.equal(attributes.some(attribute => attribute.value === 'CHARSET'), false);
  assert.equal(attributes.filter(attribute => attribute.type === 'LITERAL').length, 2);
});
