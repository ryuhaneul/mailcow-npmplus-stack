import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../../server/errors.js';
import { createAclFolders } from '../../server/admin/acl-folders.js';
import { createSharesService } from '../../server/admin/services/shares.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createAudit } from '../../server/admin/audit.js';

const owner = 'owner@example.com', grantee = 'reader@example.com', other = 'other@example.com';
const rights = ['lookup', 'read'];
const config = { doveadmUrl: 'http://dovecot:12346', doveadmKey: 'synthetic-key' };
const row = (mailbox, id = grantee, value = rights) => ({ user: owner, id, mailbox, rights: [...value] });
const revertOptions = { confirm: true, actor: 'admin', ip: '192.0.2.1', session: {} };

async function fixture(t, initial = [], options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'webmail-share-folders-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = { rows: structuredClone(initial), folders: new Set(['INBOX', 'Archive', 'Archive/2026', 'Shared', 'Shared/other@example.com/INBOX']), writes: [], reads: [], placeholders: new Set(), lists: 0 };
  const doveadm = { async call(command, args) {
    assert.equal(args.user, owner);
    if (command === 'mailboxList') {
      assert.deepEqual(args, { user: owner });
      f.lists++; f.onList?.();
      return [...f.folders, ...f.placeholders].map(mailbox => ({ mailbox }));
    }
    assert.equal(command, 'aclGet');
    f.reads.push(args.mailbox);
    if (f.placeholders.has(args.mailbox)) throw new AppError(404, 'MAILBOX_NOT_FOUND', 'synthetic doveadm exit 68');
    return f.rows.filter(item => item.mailbox === args.mailbox).map(item => ({ id: `user=${item.id}`, global: '', rights: item.rights.join(' ') }));
  } };
  const dockerapi = {
    async getAcl() { return f.rows; },
    async setAcl(who, id, mailbox) {
      assert.equal(who, owner); f.writes.push(['set', id, mailbox]);
      if (f.placeholders.has(mailbox)) throw new AppError(502, 'DOCKERAPI_REJECTED', 'dockerapi가 요청을 거절했어요.');
      f.rows = f.rows.filter(item => item.id !== id || item.mailbox !== mailbox);
      f.rows.push(row(mailbox, id));
    },
    async deleteAcl(who, id, mailbox) {
      assert.equal(who, owner); assert.equal(f.placeholders.has(mailbox), false); f.writes.push(['delete', id, mailbox]);
      f.rows = f.rows.filter(item => item.id !== id || item.mailbox !== mailbox);
      f.onDelete?.();
    },
  };
  const aclFolders = createAclFolders({ doveadm, dockerapi, config: options.disabled ? {} : config });
  const audit = createAudit({ dir }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const mailcow = { async call(_session, _method, path) {
    if (path.endsWith('/filters/all')) return [];
    return [owner, grantee, other].map(username => ({ username, active: 1 }));
  } };
  // Limit listing to the tested owner: readOwned must never receive a grantee address.
  const service = createSharesService({ dockerapi, aclFolders, mailcow, audit, lock, history, config: { wholeMailbox: options.wholeMailbox === true } });
  const item = async () => service.get({}, owner);
  const change = async (grant, expected) => service.change({ owner, grantee, grant, etag: expected ?? (await item()).etag, actor: 'admin', ip: '192.0.2.1', session: {} });
  return Object.assign(f, { dir, doveadm, aclFolders, audit, history, service, item, change });
}

for (const wholeMailbox of [false, true]) test(`shares: history title is mode independent wholeMailbox=${wholeMailbox}`, async t => {
  const f = await fixture(t, [], { wholeMailbox });
  await f.change(true);
  const record = (await f.history.list()).items[0];
  assert.equal(record.summary, `admin님이 ${owner} 읽기 공유를 바꿨어요`);
});

test('ACL folders: list preserves exact names and excludes only the received namespace', async t => {
  const f = await fixture(t);
  for (const name of [' 한글 "폴더" ', 'MySharedNotes', 'Archive/Shared', 'Sharedness']) f.folders.add(name);
  assert.deepEqual(await f.aclFolders.list(owner), ['INBOX', 'Archive', 'Archive/2026', ' 한글 "폴더" ', 'MySharedNotes', 'Archive/Shared', 'Sharedness']);
  await f.aclFolders.assertExist(owner, [' 한글 "폴더" ', 'Archive/Shared']);
  await assert.rejects(f.aclFolders.assertExist(owner, ['INBOX', 'Missing']), { statusCode: 409, code: 'CONFLICT' });
  for (const name of ['', ' ', 'A\nB', 'A\0B', 'A\x7fB', 'A\x85B', '*', 'A%', 'Shared', 'Shared/foo']) {
    const before = f.lists;
    await assert.rejects(f.aclFolders.assertExist(owner, ['INBOX', name]), { statusCode: 422, code: 'INVALID_INPUT' });
    assert.equal(f.lists, before);
  }
});

test('shares: revoke removes INBOX and every copied own-row folder and records version 2', async t => {
  const f = await fixture(t, [row('INBOX'), row('Archive'), row('Archive/2026'), row('INBOX', other)]);
  const result = await f.change(false);
  assert.deepEqual(f.writes, [['delete', grantee, 'Archive'], ['delete', grantee, 'Archive/2026'], ['delete', grantee, 'INBOX']]);
  assert.deepEqual(result.grantees, [other]); assert.equal(result.applied, true);
  assert.equal(f.rows.some(item => item.id === grantee), false);
  const record = await f.history.detail(result.auditId);
  assert.equal(record.before.version, 2); assert.equal(record.after.version, 2);
  assert.deepEqual(record.before.grants.find(item => item.grantee === grantee).folders.map(item => item.mailbox), ['Archive', 'Archive/2026', 'INBOX']);
});

test('shares: residual-only recipients are distinct from INBOX shares and granting adds INBOX', async t => {
  const f = await fixture(t, [row('Archive'), row('Archive/2026')], { wholeMailbox: true });
  let item = await f.item();
  assert.deepEqual(item.grantees, []);
  assert.deepEqual(item.grants.map(({ grantee, shared, residualFolders, readOnly }) => ({ grantee, shared, residualFolders, readOnly })), [{ grantee, shared: false, residualFolders: 2, readOnly: true }]);
  assert.equal(item.wholeMailbox, true); assert.deepEqual(item.warnings, []);
  const result = await f.change(true, item.etag);
  assert.notEqual(result.unchanged, true); assert.deepEqual(f.writes, [['set', grantee, 'INBOX']]);
  assert.deepEqual(result.grantees, [grantee]); assert.equal(result.grants[0].residualFolders, 0);
  assert.equal(result.grants[0].folders.length, 3);
  item = await f.item();
  assert.equal((await f.change(true, item.etag)).unchanged, true);
});

test('shares: residual-only revoke deletes all remaining rows', async t => {
  const f = await fixture(t, [row('Archive'), row('Archive/2026')]);
  const result = await f.change(false);
  assert.deepEqual(result.grants, []); assert.deepEqual(result.grantees, []); assert.equal(f.writes.length, 2);
});

for (const grant of [false, true]) test(`shares: unsupported subfolder rights block grant=${grant}, including unchanged INBOX`, async t => {
  const f = await fixture(t, [row('INBOX'), row('Archive', grantee, ['lookup', 'read', 'write'])]);
  assert.equal((await f.item()).grants[0].readOnly, false);
  await assert.rejects(f.change(grant), { statusCode: 409, code: 'ACL_UNSUPPORTED' });
  assert.equal(f.writes.length, 0); assert.equal((await f.audit.read()).rows.length, 0);
});

test('shares: all folders are checked before the first write when one vanishes', async t => {
  const f = await fixture(t, [row('INBOX'), row('Archive')]);
  const expected = (await f.item()).etag;
  f.lists = 0; f.onList = () => { if (f.lists === 3) f.folders.delete('Archive'); };
  await assert.rejects(f.change(false, expected), { statusCode: 409, code: 'CONFLICT' });
  assert.equal(f.writes.length, 0);
  assert.equal((await f.history.list()).items[0].result, 'failed');
});

test('shares: a newly copied row during revoke prevents a success report', async t => {
  const f = await fixture(t, [row('INBOX')]);
  f.onDelete = () => { f.rows.push(row('Archive/2026')); };
  await assert.rejects(f.change(false), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
  assert.equal((await f.history.list()).items[0].result, 'failed');
});

test('shares: disabled doveadm retains only INBOX and explicitly warns', async t => {
  const f = await fixture(t, [row('INBOX'), row('Archive'), { ...row('INBOX'), user: other }], { disabled: true });
  assert.equal(f.aclFolders.enabled, false); assert.deepEqual(await f.aclFolders.list(owner), ['INBOX']);
  assert.deepEqual(await f.aclFolders.readOwned(owner), [row('INBOX')]);
  const item = await f.item(); assert.equal(item.wholeMailbox, false);
  assert.deepEqual(item.warnings, ['SUBFOLDER_ACL_UNCHECKED']); assert.equal(item.grants[0].folders.length, 1);
  const result = await f.change(false, item.etag);
  assert.deepEqual(result.warnings, ['SUBFOLDER_ACL_UNCHECKED']);
  assert.deepEqual(f.writes, [['delete', grantee, 'INBOX']]); assert.ok(f.rows.some(item => item.mailbox === 'Archive'));
});

for (const action of ['share.grant', 'share.revoke']) test(`history: old ${action} has an explanation and rejects without modifying JSONL`, async t => {
  const f = await fixture(t);
  const original = await f.audit.run({ action, actor: 'admin', ip: '192.0.2.1', target: owner, kind: 'config', revertible: true, before: { grants: [] }, after: { grants: [{ grantee, rights }] } }, async intent => ({ id: intent.id }));
  const file = join(f.dir, (await readdir(f.dir))[0]), source = await readFile(file, 'utf8');
  const detail = await f.history.detail(original.id);
  assert.equal(detail.canRevert, false); assert.equal(detail.revertCode, 'RECORD_FORMAT_OLD'); assert.match(detail.revertReason, /이전 형식/);
  assert.equal((await f.history.list({ filter: 'revertible' })).total, 0);
  await assert.rejects(f.history.revert(original.id, revertOptions), { statusCode: 409, code: 'RECORD_FORMAT_OLD' });
  assert.equal(await readFile(file, 'utf8'), source); assert.equal(f.writes.length, 0);
});

test('history: restoring skips vanished target folders and persists the actual target and skipped names', async t => {
  const f = await fixture(t, [row('INBOX'), row('Archive'), row('Archive/2026'), row('Archive', other)]);
  // Revoke only the reader; the other user's surviving ACL must remain unchanged.
  const removed = await f.change(false);
  f.folders.delete('Archive'); f.folders.delete('Archive/2026');
  f.rows = f.rows.filter(item => f.folders.has(item.mailbox));
  const result = await f.history.revert(removed.auditId, revertOptions);
  assert.deepEqual(result.skipped, ['Archive', 'Archive/2026']); assert.deepEqual(result.detail.skipped, result.skipped);
  const record = await f.history.detail(result.id);
  assert.deepEqual(record.skipped, result.skipped);
  assert.deepEqual(record.after, { version: 2, grants: [{ grantee, folders: [{ mailbox: 'INBOX', rights }] }] });
  assert.deepEqual(f.rows, [row('INBOX')]);
  assert.equal(record.result, 'ok');
});

test('history: vanished folders are omitted from expected as well as target', async t => {
  const f = await fixture(t, [row('Archive')]);
  const granted = await f.change(true);
  f.folders.delete('Archive'); f.rows = f.rows.filter(item => item.mailbox !== 'Archive');
  const result = await f.history.revert(granted.auditId, revertOptions);
  assert.deepEqual(result.skipped, ['Archive']); assert.deepEqual(f.rows, []);
});

test('history: surviving folders still compare strictly and refuse unrelated changes', async t => {
  const f = await fixture(t, [row('Archive')]);
  const granted = await f.change(true); f.rows.push(row('Archive/2026', other));
  const writes = f.writes.length;
  await assert.rejects(f.history.revert(granted.auditId, revertOptions), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  assert.equal(f.writes.length, writes); assert.equal((await f.history.list()).total, 1);
});

test('history: a folder vanishing after preparation stops with 409 and a failed result', async t => {
  const f = await fixture(t, [row('INBOX'), row('Archive')]);
  const removed = await f.change(false), writes = f.writes.length;
  const run = f.audit.run;
  f.audit.run = (entry, operation, options) => run(entry, intent => {
    f.folders.delete('Archive');
    return operation(intent);
  }, options);
  await assert.rejects(f.history.revert(removed.auditId, revertOptions), { statusCode: 409, code: 'CONFLICT' });
  assert.equal(f.writes.length, writes);
  const records = (await f.history.list()).items.filter(record => record.revertOf === removed.auditId);
  assert.equal(records.length, 1); assert.equal(records[0].result, 'failed'); assert.equal(records[0].canRevert, false);
});

test('history: skipped folder names are unique across multiple recipients', async t => {
  const f = await fixture(t, [row('Archive'), row('Archive', other)]);
  const removed = await f.change(false);
  f.folders.delete('Archive'); f.rows = [];
  const result = await f.history.revert(removed.auditId, revertOptions);
  assert.deepEqual(result.skipped, ['Archive']); assert.equal(result.result, 'ok'); assert.deepEqual(f.rows, []);
});

test('history: folder existence checks run inside the owner lock', async t => {
  const f = await fixture(t, [row('INBOX')]);
  const removed = await f.change(false);
  let held = false;
  const lock = { async run(target, operation) { assert.equal(target, owner); held = true; try { return await operation(); } finally { held = false; } } };
  const history = createHistoryService({ audit: f.audit, lock });
  const aclFolders = { ...f.aclFolders, async list(who) { assert.equal(held, true); return f.aclFolders.list(who); } };
  // Register the real adapter against a lock with an observable critical section.
  createSharesService({ dockerapi: {}, aclFolders, history });
  // Expected differs because this record was a revoke, so restoration would add INBOX.
  // Stop after preparation and verify lock scope without running a write.
  aclFolders.readOwned = async () => { throw new Error('synthetic-stop-after-prepare'); };
  await assert.rejects(history.revert(removed.auditId, revertOptions), /synthetic-stop-after-prepare/);
  assert.equal(held, false);
});

test('shares: invalid later folder prevents all writes in a multi-folder revoke', async t => {
  const f = await fixture(t, [row('INBOX'), row('Archive/%')]);
  f.folders.add('Archive/%');
  await assert.rejects(f.change(false), { statusCode: 422, code: 'INVALID_INPUT' });
  assert.equal(f.writes.length, 0); assert.equal(f.rows.length, 2);
});

test('shares: revoke preserves exact quoted, spaced and Korean folder names', async t => {
  const mailbox = 'Archive/ 한글 "폴더" ';
  const f = await fixture(t, [row('INBOX'), row(mailbox)]); f.folders.add(mailbox);
  const result = await f.change(false);
  assert.equal(result.applied, true); assert.deepEqual(f.rows, []);
  assert.ok(f.writes.some(call => call[2] === mailbox));
});

test('shares: placeholder parents have no ACL rows and are never written by grant, revoke or both reverts', async t => {
  const children = ['Projects/Leaf', 'Projects/Branch/Leaf'];
  const f = await fixture(t, children.map(mailbox => row(mailbox)));
  children.forEach(mailbox => f.folders.add(mailbox));
  ['Projects', 'Projects/Branch'].forEach(mailbox => f.placeholders.add(mailbox));
  const listed = await f.doveadm.call('mailboxList', { user: owner });
  for (const mailbox of f.placeholders) {
    assert.ok(listed.some(row => row.mailbox === mailbox));
    await assert.rejects(f.doveadm.call('aclGet', { user: owner, mailbox }), { code: 'MAILBOX_NOT_FOUND' });
  }
  f.reads = [];
  const item = await f.item();
  assert.deepEqual(item.grants[0].folders.map(folder => folder.mailbox), children.toSorted((a, b) => a.localeCompare(b)));
  assert.deepEqual(await f.aclFolders.list(owner), ['INBOX', 'Archive', 'Archive/2026', ...children, ...f.placeholders]);
  await f.aclFolders.assertExist(owner, ['Projects']);
  assert.deepEqual(await f.aclFolders.readOwned(owner), children.map(mailbox => row(mailbox)));
  const granted = await f.change(true, item.etag);
  assert.deepEqual(f.rows, [...children.map(mailbox => row(mailbox)), row('INBOX')]);
  await f.history.revert(granted.auditId, revertOptions);
  assert.deepEqual(f.rows, children.map(mailbox => row(mailbox)));
  const removed = await f.change(false);
  assert.deepEqual(f.rows, []);
  await f.history.revert(removed.auditId, revertOptions);
  assert.deepEqual(f.rows.toSorted((a, b) => a.mailbox.localeCompare(b.mailbox)), children.map(mailbox => row(mailbox)).toSorted((a, b) => a.mailbox.localeCompare(b.mailbox)));
  assert.deepEqual(new Set(f.writes.map(call => call[2])), new Set(['INBOX', ...children]));
  assert.ok(children.every(mailbox => f.reads.includes(mailbox)));
  assert.ok([...f.placeholders].every(mailbox => f.reads.includes(mailbox)));
  assert.equal(f.writes.some(call => f.placeholders.has(call[2])), false);
});

test('history known limit: restoring a placeholder fails after an earlier folder ACL was restored', async t => {
  const f = await fixture(t, [row('INBOX'), row('Projects')]);
  f.placeholders.delete('Projects'); f.folders.add('Projects'); f.folders.add('Projects/Leaf');
  const removed = await f.change(false);
  f.folders.delete('Projects'); f.placeholders.add('Projects'); f.writes = [];
  await assert.rejects(f.history.revert(removed.auditId, revertOptions), { statusCode: 502, code: 'DOCKERAPI_REJECTED', message: 'dockerapi가 요청을 거절했어요.' });
  assert.deepEqual(f.writes, [['set', grantee, 'INBOX'], ['set', grantee, 'Projects']]);
  assert.deepEqual(f.rows, [row('INBOX')]);
  const record = (await f.history.list()).items.find(record => record.revertOf === removed.auditId);
  assert.equal(record.result, 'failed'); assert.equal(record.code, 'DOCKERAPI_REJECTED');
});
