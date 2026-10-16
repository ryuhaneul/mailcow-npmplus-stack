import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePath } from 'imapflow/lib/tools.js';
import { createApp } from '../../server/app.js';
import { AppError } from '../../server/errors.js';
import { logOptions } from '../../server/log.js';

class FolderImap extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.enabled = new Set(); this.capabilities = new Map([['UIDPLUS', true]]); this.usable = false;
    this.rows = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive', 'Projects', 'Empty', 'Shared/team@example.com/INBOX', 'WebmailVirtual/AllMail'].map(path => ({ path, name: path.split('/').at(-1), parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', flags: new Set() }));
    this.stats = new Map(this.rows.map((row, index) => [row.path, { messages: row.path === 'Empty' ? 0 : 2, size: row.path === 'Empty' ? 0 : (index + 1) * 100 }]));
    this.acl = new Map(); this.uids = new Map(); this.calls = []; this.listCount = 0; this.statusCount = 0; this.renameCount = 0; this.uidValidity = 123;
  }
  async connect() { this.usable = true; }
  close() { this.usable = false; }
  async logout() { this.close(); }
  async getMailboxLock(path) { if (!this.rows.some(row => row.path === path)) throw Object.assign(new Error('synthetic missing folder'), { code: 'NotFound' }); this.mailbox = { path, uidValidity: BigInt(this.uidValidity) }; return { release() {} }; }
  async list(options) { this.listCount++; assert.deepEqual(options.statusQuery, { messages: true, unseen: true }); return this.rows.map(row => ({ ...row, status: { messages: this.stats.get(row.path).messages, unseen: 1 } })); }
  async exec(command, args, options = {}) {
    this.calls.push({ command, args });
    if (command === 'UID SORT') options.untagged.SORT({ attributes: Array.from({ length: this.stats.get(this.mailbox.path).messages }, (_, i) => ({ value: String(i + 1) })) });
    if (command === 'MYRIGHTS') options.untagged.MYRIGHTS({ attributes: [args[0], { value: this.acl.get(decodePath(this, args[0].value)) ?? 'lrswipkxte' }] });
    if (command === 'STATUS') {
      this.statusCount++;
      const path = decodePath(this, args[0].value); const stat = this.stats.get(path);
      options.untagged.STATUS({ attributes: [args[0], args[1].flatMap(field => [{ value: field.value }, { value: String(stat[field.value.toLowerCase()]) }])] });
    }
    if (command === 'UID EXPUNGE') {
      const removed = args[0].value.split(',').map(Number), path = this.mailbox.path;
      const uids = this.uids.get(path) ?? [];
      this.uids.set(path, uids.filter(uid => !removed.includes(uid)));
      const stat = this.stats.get(path); stat.messages -= removed.length; stat.size = Math.max(0, stat.size - removed.length * 100);
    }
    return { next() {} };
  }
  async *fetch(range) {
    for (const uid of range.split(',').map(Number)) yield { uid, envelope: {}, flags: new Set(), internalDate: new Date('2026-10-15T00:00:00Z'), size: 100 };
  }
  async mailboxCreate(path) { this.calls.push({ command: 'CREATE', path }); this.rows.push({ path, name: path.split('/').at(-1), flags: new Set() }); this.stats.set(path, { messages: 0, size: 0 }); return { path }; }
  async mailboxRename(path, newPath) {
    this.renameCount++; this.calls.push({ command: 'RENAME', path, newPath });
    if (this.failRollback && this.renameCount > 1) throw new Error('synthetic-imap-password');
    for (const row of this.rows) if (row.path === path || row.path.startsWith(path + '/')) {
      const changed = newPath + row.path.slice(path.length); this.stats.set(changed, this.stats.get(row.path)); this.stats.delete(row.path); row.path = changed; row.name = changed.split('/').at(-1);
    }
    return { path, newPath };
  }
  async mailboxDelete(path) { this.calls.push({ command: 'DELETE', path }); this.rows = this.rows.filter(row => row.path !== path); this.stats.delete(path); return { path }; }
  async getQuota(path) { assert.equal(path, 'INBOX'); return { storage: { usage: this.quotaUsed ?? 100 * 1024, limit: this.quotaLimit ?? 1000 * 1024 } }; }
  async search(query, options) { assert.deepEqual(query, { all: true }); assert.deepEqual(options, { uid: true }); return [...(this.uids.get(this.mailbox.path) ?? [1, 2])]; }
  async messageFlagsAdd(range, flags, options) { this.calls.push({ command: 'STORE', range, flags, options }); return true; }
}
const config = {
  publicHostnames: ['newmail.example.com'], trustProxy: ['127.0.0.0/8'], logLevel: 'info', sessionIdleMin: 480, sessionMaxHours: 24,
  imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com',
  brandName: '메일', orgName: '', brandMark: '', defaultTheme: 'ink', defaultMode: 'system', attachMaxMb: 25, autoexpungeDays: 30,
};
async function fixture(t, { rules = true } = {}) {
  let client, logs = '', time = 0;
  const rulesCalls = [];
  const service = rules === true ? { async getState() { return 'ok'; }, async renameFolderRefs(_session, from, to) { rulesCalls.push({ from, to }); }, async folderInUse() { return false; } } : rules || undefined;
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-w04-test-'));
  const stream = new Writable({ write(chunk, _enc, done) { logs += chunk.toString(); done(); } });
  const app = await createApp({ config, logger: { ...logOptions('info'), stream }, auth: { tempRoot, clientFactory: options => { client = new FolderImap(options); return client; } }, folders: { rulesService: service, now: () => time } });
  t.after(async () => { await app.close(); if (process.env.WEBMAIL_TEST_LOG) await appendFile(process.env.WEBMAIL_TEST_LOG, logs); await rm(tempRoot, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://newmail.example.com' }, payload: { email: 'user@example.com', password: 'synthetic-imap-password' } });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'https://newmail.example.com', 'x-webmail-csrf': login.json().csrf };
  const request = (method, path, payload) => app.inject({ method, url: path, headers, payload });
  return { app, client, headers, request, rulesCalls, service, advance(ms) { time += ms; }, get logs() { return logs; } };
}
const pathFor = path => '/api/folders/' + encodeURIComponent(path);
function error(response, status, code) { assert.equal(response.statusCode, status, response.body); assert.equal(response.json().error.code, code); assert.equal(response.headers['www-authenticate'], undefined); }

test('folders: non-login requests are 403 and authenticated list has rights, special folders and no virtual duplicates', async t => {
  const f = await fixture(t);
  error(await f.app.inject('/api/folders'), 403, 'NO_SESSION');
  const response = await f.request('GET', '/api/folders'); assert.equal(response.statusCode, 200);
  const result = response.json(); assert.equal(result.virtualAllMail, 'WebmailVirtual/AllMail'); assert.ok(result.folders.every(row => !row.path.startsWith('WebmailVirtual')));
  const inbox = result.folders.find(row => row.path === 'INBOX'); assert.equal(inbox.specialUse, '\\Inbox'); assert.equal(inbox.color, null); assert.equal(inbox.parent, null); assert.deepEqual(inbox.rights, { write: true, delete: true, insert: true, seen: true });
  const shared = result.folders.find(row => row.shared); assert.equal(shared.owner, 'team@example.com'); assert.equal(shared.rights.write, false);
});
for (const [label, name] of [['empty', ' '], ['length', 'x'.repeat(101)], ['slash', 'bad/name'], ['variable', '${value}'], ['dot', '.hidden'], ['virtual prefix', 'WebmailVirtualX'], ['shared prefix', 'SharedX']]) {
  test(`folder name: ${label} returns 422 before CREATE`, async t => {
    const f = await fixture(t); error(await f.request('POST', '/api/folders', { name }), 422, 'INVALID_NAME'); assert.equal(f.client.calls.filter(call => call.command === 'CREATE').length, 0);
  });
}
test('folder create: Unicode nested name, duplicate and missing parent', async t => {
  const f = await fixture(t);
  const created = await f.request('POST', '/api/folders', { name: '견적', parent: 'Projects' }); assert.equal(created.statusCode, 201); assert.equal(created.json().folder.path, 'Projects/견적');
  error(await f.request('POST', '/api/folders', { name: 'Projects' }), 409, 'EXISTS');
  error(await f.request('POST', '/api/folders', { name: 'new', parent: 'missing' }), 404, 'FOLDER_NOT_FOUND');
});
test('folder writes: shared and virtual paths return 403 for create, rename, delete and empty', async t => {
  const f = await fixture(t);
  for (const path of ['Shared/team@example.com/INBOX', 'WebmailVirtual/AllMail']) {
    error(await f.request('POST', '/api/folders', { name: 'new', parent: path }), 403, 'FOLDER_READONLY');
    error(await f.request('PATCH', pathFor(path), { name: 'new' }), 403, 'FOLDER_READONLY');
    error(await f.request('DELETE', pathFor(path)), 403, 'FOLDER_READONLY');
    error(await f.request('POST', pathFor(path) + '/empty', { confirmName: 'INBOX' }), 403, 'FOLDER_READONLY');
  }
  assert.ok(!f.client.calls.some(call => ['CREATE', 'RENAME', 'DELETE', 'STORE'].includes(call.command)));
});
test('MYRIGHTS: absent write/delete bits block actions before commands', async t => {
  const f = await fixture(t); f.client.acl.set('Projects', 'lris');
  error(await f.request('POST', '/api/folders', { name: 'new', parent: 'Projects' }), 403, 'FOLDER_READONLY');
  error(await f.request('PATCH', pathFor('Projects'), { name: 'new' }), 403, 'FOLDER_READONLY');
  error(await f.request('DELETE', pathFor('Projects')), 403, 'FOLDER_READONLY');
  error(await f.request('POST', pathFor('Projects') + '/empty', { confirmName: 'Projects' }), 403, 'FOLDER_READONLY');
  f.client.acl.set('Projects', 'lrswipt');
  error(await f.request('POST', pathFor('Projects') + '/empty', { confirmName: 'Projects' }), 403, 'FOLDER_READONLY');
});
test('rules missing: rename and delete fail closed with approved 409 message', async t => {
  const f = await fixture(t, { rules: false });
  for (const [method, payload] of [['PATCH', { name: 'new' }], ['DELETE', undefined]]) {
    const response = await f.request(method, pathFor('Empty'), payload); error(response, 409, 'RULES_LOCKED'); assert.equal(response.json().error.message, '필터 기능 준비 중이라 지금은 폴더 이름을 바꾸거나 지울 수 없어요');
  }
  assert.equal(f.client.renameCount, 0);
});
test('rename: IMAP change precedes rule references update and non-ok state prevents rename', async t => {
  const f = await fixture(t);
  f.service.renameFolderRefs = async (_session, from, to) => { assert.ok(f.client.rows.some(row => row.path === to)); f.rulesCalls.push({ from, to }); };
  const result = await f.request('PATCH', pathFor('Projects'), { name: 'Renamed' }); assert.equal(result.statusCode, 200); assert.equal(result.json().folder.path, 'Renamed'); assert.deepEqual(f.rulesCalls, [{ from: 'Projects', to: 'Renamed' }]);
  f.service.getState = async () => 'damaged'; error(await f.request('PATCH', pathFor('Renamed'), { name: 'Again' }), 409, 'RULES_LOCKED'); assert.equal(f.client.renameCount, 1);
});
test('rename: rule failure rolls IMAP name back and returns original error', async t => {
  const f = await fixture(t); f.service.renameFolderRefs = async () => { throw new AppError(409, 'RULES_CONFLICT', '필터가 바뀌었어요.'); };
  error(await f.request('PATCH', pathFor('Projects'), { name: 'Changed' }), 409, 'RULES_CONFLICT');
  assert.deepEqual(f.client.calls.filter(call => call.command === 'RENAME').map(call => [call.path, call.newPath]), [['Projects', 'Changed'], ['Changed', 'Projects']]); assert.ok(f.client.rows.some(row => row.path === 'Projects'));
});
test('rename: failed rollback returns mismatch 500 and logs both safe errors without credentials', async t => {
  const f = await fixture(t); f.client.failRollback = true; f.service.renameFolderRefs = async () => { throw Object.assign(new Error('synthetic-imap-password'), { code: 'RULES_WRITE_FAILED' }); };
  const response = await f.request('PATCH', pathFor('Projects'), { name: 'Changed' }); error(response, 500, 'FOLDER_RULES_MISMATCH'); assert.equal(response.json().error.message, '폴더 이름은 바뀌었지만 필터에 반영하지 못했어요. 필터 화면에서 확인해 주세요.');
  const logged = f.logs.split('\n').filter(Boolean).map(JSON.parse).find(row => row.code === 'FOLDER_RULES_MISMATCH'); assert.equal(logged.oldPath, 'Projects'); assert.equal(logged.newPath, 'Changed'); assert.equal(logged.rulesError.code, 'RULES_WRITE_FAILED'); assert.ok(logged.rollbackError); assert.ok(!f.logs.includes('synthetic-imap-password'));
});
test('delete: rules use checked before DELETE; nonempty and special folders blocked; empty succeeds', async t => {
  const f = await fixture(t); f.service.folderInUse = async () => { throw Object.assign(new AppError(409, 'FOLDER_IN_RULES', '필터에서 쓰는 폴더예요.'), { rules: ['rule0001'] }); };
  const used = await f.request('DELETE', pathFor('Empty')); error(used, 409, 'FOLDER_IN_RULES'); assert.deepEqual(used.json().error.rules, ['rule0001']); assert.ok(!f.client.calls.some(call => call.command === 'DELETE'));
  f.service.folderInUse = async () => false;
  error(await f.request('DELETE', pathFor('Projects')), 409, 'FOLDER_NOT_EMPTY');
  error(await f.request('DELETE', pathFor('Sent')), 422, 'SPECIAL_FOLDER');
  const removed = await f.request('DELETE', pathFor('Empty')); assert.equal(removed.statusCode, 204); assert.equal(removed.body, '');
});
test('empty: confirmation mismatch does not mark or expunge', async t => {
  const f = await fixture(t); error(await f.request('POST', pathFor('Trash') + '/empty', { confirmName: 'trash' }), 422, 'CONFIRM_MISMATCH'); assert.ok(!f.client.calls.some(call => ['STORE', 'UID EXPUNGE'].includes(call.command)));
});
test('empty: 2501 UIDs split into 1000/1000/501, precise UID EXPUNGE and freed bytes', async t => {
  const f = await fixture(t); f.client.uids.set('Trash', Array.from({ length: 2501 }, (_, i) => i + 1)); f.client.stats.set('Trash', { messages: 2501, size: 250100 });
  const result = await f.request('POST', pathFor('Trash') + '/empty', { confirmName: 'Trash' }); assert.equal(result.statusCode, 200, result.body); assert.deepEqual(result.json(), { deleted: 2501, freedBytes: 250100 });
  const flags = f.client.calls.filter(call => call.command === 'STORE'); assert.deepEqual(flags.map(call => call.range.split(',').length), [1000, 1000, 501]); for (const call of flags) { assert.deepEqual(call.flags, ['\\Deleted']); assert.deepEqual(call.options, { uid: true }); }
  assert.equal(f.client.calls.filter(call => call.command === 'UID EXPUNGE').length, 3); assert.ok(!f.client.calls.some(call => call.command === 'EXPUNGE')); assert.ok(f.logs.includes('FOLDER_EMPTIED'));
});
test('storage: virtual/shared excluded, sizes sorted descending, cached 60s; quotaOnly skips folder scans', async t => {
  const f = await fixture(t);
  let response = await f.request('GET', '/api/storage?quotaOnly=1'); assert.equal(response.statusCode, 200); assert.deepEqual(response.json().folders, []); assert.equal(f.client.listCount, 0);
  response = await f.request('GET', '/api/storage'); const body = response.json(); assert.equal(body.quota.usedBytes, 100 * 1024); assert.ok(body.folders.every(row => !/^(Shared|WebmailVirtual)/.test(row.path))); assert.deepEqual(body.folders.map(row => row.sizeBytes), [...body.folders.map(row => row.sizeBytes)].sort((a, b) => b - a));
  const calls = f.client.statusCount; await f.request('GET', '/api/storage'); assert.equal(f.client.statusCount, calls);
  f.advance(59999); await f.request('GET', '/api/storage'); assert.equal(f.client.statusCount, calls);
  f.advance(1); await f.request('GET', '/api/storage'); assert.ok(f.client.statusCount > calls);
});
for (const quotaOnly of [false, true]) test(`storage: no QUOTA response sums personal STATUS sizes, quotaOnly=${quotaOnly}`, async t => {
  const f = await fixture(t);
  f.client.getQuota = async () => ({ path: 'INBOX' });
  f.client.rows.push({ path: 'NotSelectable', flags: new Set(['\\Noselect']) });
  f.client.stats.set('NotSelectable', { messages: 0, size: 999999 });
  const response = await f.request('GET', '/api/storage' + (quotaOnly ? '?quotaOnly=1' : ''));
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(body.quota, { usedBytes: 2800, limitBytes: 0 });
  assert.equal(body.level, 'ok');
  const paths = f.client.calls.filter(call => call.command === 'STATUS').map(call => decodePath(f.client, call.args[0].value));
  assert.deepEqual(paths, ['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive', 'Projects', 'Empty']);
  assert.equal(f.client.statusCount, paths.length);
  assert.equal(body.folders.length, quotaOnly ? 0 : paths.length);
});
for (const [label, result] of [['false', false], ['undefined', undefined], ['empty object', {}], ['invalid storage', { path: 'INBOX', storage: {} }], ['null storage', { path: 'INBOX', storage: null }]]) test(`storage: ${label} is not mistaken for unlimited quota`, async t => {
  const f = await fixture(t); f.client.getQuota = async () => result;
  error(await f.request('GET', '/api/storage?quotaOnly=1'), 503, 'MAIL_UNAVAILABLE');
  assert.equal(f.client.statusCount, 0);
});
for (const step of ['quota', 'status', 'status-no']) test(`storage: real ${step} command failure stays 503`, async t => {
  const f = await fixture(t);
  f.client.getQuota = async () => { if (step === 'quota') throw new Error('synthetic connection lost'); return { path: 'INBOX' }; };
  if (step.startsWith('status')) { const exec = f.client.exec.bind(f.client); f.client.exec = async (command, ...args) => { if (command === 'STATUS') throw Object.assign(new Error('synthetic command failed'), { responseStatus: step === 'status-no' ? 'NO' : undefined }); return exec(command, ...args); }; }
  error(await f.request('GET', '/api/storage?quotaOnly=1'), 503, 'MAIL_UNAVAILABLE');
});
test('storage: level thresholds 80/95 percent and zero limit', async t => {
  const f = await fixture(t); f.client.quotaLimit = 10000;
  for (const [used, level] of [[7999, 'ok'], [8000, 'warn'], [9499, 'warn'], [9500, 'crit']]) { f.client.quotaUsed = used; assert.equal((await f.request('GET', '/api/storage?quotaOnly=1')).json().level, level); }
  f.client.quotaLimit = 0; assert.equal((await f.request('GET', '/api/storage?quotaOnly=1')).json().level, 'ok');
});
test('storage cache: create invalidates list and all mutation routes require CSRF', async t => {
  const f = await fixture(t); await f.request('GET', '/api/storage');
  const calls = f.client.statusCount; await f.request('POST', '/api/folders', { name: 'New' }); await f.request('GET', '/api/storage'); assert.ok(f.client.statusCount > calls);
  const headers = { ...f.headers }; delete headers['x-webmail-csrf'];
  error(await f.app.inject({ method: 'POST', url: '/api/folders', headers, payload: { name: 'Blocked' } }), 403, 'CSRF');
});


test('folder rename: success invalidates list cache, rejected rename keeps snapshot', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/api/messages')).json().total, 2);
  error(await f.request('PATCH', pathFor('Projects'), { name: 'Trash' }), 409, 'EXISTS');
  await f.request('GET', '/api/messages');
  assert.equal(f.client.calls.filter(call => call.command === 'UID SORT').length, 1);
  assert.equal((await f.request('PATCH', pathFor('Projects'), { name: 'Renamed' })).statusCode, 200);
  assert.equal((await f.request('GET', '/api/messages')).json().total, 2);
  assert.equal(f.client.calls.filter(call => call.command === 'UID SORT').length, 2);
});

test('folder empty: next list query immediately reflects empty total', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/api/messages')).json().total, 2);
  const result = await f.request('POST', pathFor('INBOX') + '/empty', { confirmName: 'INBOX' });
  assert.equal(result.statusCode, 200); assert.equal(result.json().deleted, 2);
  const refreshed = await f.request('GET', '/api/messages');
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.json().total, 0); assert.deepEqual(refreshed.json().items, []);
});
