import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScopedActionService } from '../../server/mail/scoped-actions.js';

const virtual = 'WebmailVirtual/AllMail';
function fixture({ uids = [9, 2, 7, 1], boxes, mapping } = {}) {
  let clock = 0, nested = false;
  const state = { searches: 0, fetches: [], selects: [], creates: [], commands: [], hook: null };
  const folders = boxes ?? new Map([['INBOX', { validity: 11, next: 10 }], ['Projects', { validity: 22, next: 1000 }], [virtual, { validity: 33, next: 1000 }]]);
  const session = { scanAbort: new AbortController() };
  const client = {
    enabled: new Set(), capabilities: new Map(),
    async list() { clock += 1000; return [...folders].map(([path, box]) => ({ path, name: path.split('/').at(-1), specialUse: box.specialUse, flags: new Set() })); },
    async mailboxCreate(path) { clock += 1000; state.creates.push(path); await state.onCreate?.(); folders.set(path, { validity: 44, next: 1 }); return true; },
    async exec(command, attributes, { untagged } = {}) {
      clock += 1000; state.commands.push(command);
      await state.hook?.(command, attributes);
      if (command === 'UID SORT') { state.searches++; untagged.SORT({ attributes: uids.map(uid => ({ value: String(uid) })) }); }
      if (command === 'MYRIGHTS') untagged.MYRIGHTS({ attributes: [attributes[0], { value: state.readonly ? 'lr' : 'lrswite' }] });
      if (command === 'STATUS') untagged.STATUS({ attributes: [attributes[0], [{ value: 'UIDVALIDITY' }, { value: String(folders.get(attributes[0].value).validity) }]] });
      if (command === 'UID FETCH') {
        state.fetches.push(attributes[0].value);
        for (const uid of attributes[0].value.split(',').map(Number)) {
          if (uid === state.missing) continue;
          const source = mapping?.(uid) ?? { path: uid % 2 ? 'INBOX' : 'Projects', uid: uid };
          untagged.FETCH({ attributes: [{ value: 'FETCH' }, [{ value: 'UID' }, { value: String(uid) }, { value: 'X-MAILBOX' }, { value: source.path }, { value: 'X-REAL-UID' }, { value: String(source.uid) }]] });
        }
      }
      return { next() {} };
    },
  };
  const imap = { async withMailbox(_session, path, operation, { budget } = {}) {
    assert.equal(nested, false, 'mailbox locks must not nest'); assert.equal(typeof budget.remainingMs, 'function');
    clock += 1000; state.selects.push(path);
    const box = folders.get(path); if (!box) throw Object.assign(new Error('synthetic missing folder'), { code: 'NotFound' });
    client.mailbox = { path, uidValidity: BigInt(box.validity), uidNext: box.next };
    nested = true;
    try { return await operation(client); } finally { nested = false; }
  } };
  const service = createScopedActionService({ imap, now: () => clock });
  const body = { selectionKey: 'synthetic-001', scope: {}, action: 'seen', cursor: null };
  return { state, folders, client, session, service, body, advance(ms) { clock += ms; }, budget(ms) { const end = clock + ms; return { remainingMs: () => end - clock }; } };
}
async function ready(f, body = f.body, requestMs = 50000) {
  let result; const replies = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await f.service.prepare(f.session, body, { budget: f.budget(requestMs) }); replies.push(result);
    if (result.phase === 'ready') return { result, replies, record: f.service.getSelection(f.session, result.selectionId) };
    body = { ...body, cursor: result.cursor };
  }
  assert.fail('preparation did not converge');
}

test('prepare: direct manifest uses first fence, numeric ascending UIDs, holes and duplicates', async () => {
  const f = fixture({ uids: [9, 2, 7, 2, 1, 10, 100] });
  const { result, record } = await ready(f);
  assert.equal(result.initialTotal, 4); assert.equal(result.phase, 'ready');
  assert.deepEqual(record.manifest, [{ path: 'INBOX', uidValidity: 11, upper: 9, uids: [1, 2, 7, 9] }]);
  assert.equal(record.boundary.upper, 9); assert.equal(result.cutoff.kind, 'uid-fences');
  assert.deepEqual(f.state.creates, []); assert.equal(f.state.searches, 1);
});
for (const [name, uids, next, expected] of [
  ['empty', [], 1, []], ['maximum UID', [0xffffffff, 1, 500], 0x100000000, [1, 500, 0xffffffff]], ['fenced', [1, 2, 3], 3, [1, 2]],
]) test(`prepare: ${name} avoids reversed/wildcard ranges`, async () => {
  const f = fixture({ uids, boxes: new Map([['INBOX', { validity: 0xffffffff, next }]]) });
  const { record, result } = await ready(f);
  assert.equal(result.initialTotal, expected.length);
  assert.deepEqual(record.manifest[0]?.uids ?? [], expected);
  if (!expected.length) assert.equal(f.state.searches, 0);
  assert.ok(!f.state.fetches.some(set => set.includes('*') || set.includes(':0')));
});
test('prepare: virtual conversion deduplicates originals and sorts paths, preserving original validity and upper', async () => {
  const f = fixture({ uids: [6, 5, 4, 3, 2, 1], mapping: uid => ({ path: uid % 2 ? 'INBOX' : 'Projects', uid: uid > 4 ? uid - 4 : uid }) });
  const { record, result } = await ready(f, { ...f.body, scope: { view: 'allmail' } });
  assert.equal(result.initialTotal, 4);
  assert.deepEqual(record.manifest, [
    { path: 'INBOX', uidValidity: 11, upper: 9, uids: [1, 3] },
    { path: 'Projects', uidValidity: 22, upper: 999, uids: [2, 4] },
  ]);
  assert.equal(record.boundary.path, virtual); assert.equal(record.boundary.uidValidity, 33);
  assert.equal(f.state.commands.filter(command => /STORE|MOVE|EXPUNGE/.test(command)).length, 0);
});
test('prepare: bounded 50-UID mapping resumes without re-search, same cursor replays identical receipt', async () => {
  const f = fixture({ uids: Array.from({ length: 120 }, (_, i) => i + 1), boxes: new Map([['INBOX', { validity: 11, next: 1000 }], ['Projects', { validity: 22, next: 1000 }], [virtual, { validity: 33, next: 121 }]]) });
  const body = { ...f.body, scope: { view: 'allmail' } };
  const first = await f.service.prepare(f.session, body, { budget: f.budget(11000) });
  assert.equal(first.phase, 'preparing'); const calls = f.state.commands.length;
  assert.deepEqual(await f.service.prepare(f.session, body), first); assert.equal(f.state.commands.length, calls);
  // New virtual arrivals stay outside the captured search and fence.
  f.folders.get(virtual).next = 1001;
  const { result, record, replies } = await ready(f, { ...body, cursor: first.cursor }, 11000);
  assert.ok(replies.length > 1); assert.equal(result.initialTotal, 120); assert.equal(f.state.searches, 1);
  assert.equal(record.boundary.upper, 120); assert.ok(f.state.fetches.every(set => set.split(',').length <= 50));
  assert.deepEqual(await f.service.prepare(f.session, body), first);
});
for (const when of ['before mapping', 'during mapping', 'before original SELECT']) test(`prepare: replacement with same UID ${when} is STALE_SCOPE, mutation count zero`, async () => {
  const f = fixture({ uids: [1] }); const body = { ...f.body, scope: { view: 'allmail' } };
  if (when === 'before mapping') {
    const first = await f.service.prepare(f.session, body, { budget: f.budget(2500) });
    f.folders.get(virtual).validity++;
    await assert.rejects(f.service.prepare(f.session, { ...body, cursor: first.cursor }), { code: 'STALE_SCOPE' });
  } else {
    f.state.hook = async command => {
      if (command === 'UID FETCH' && when === 'during mapping') f.folders.get('INBOX').validity++;
      if (command === 'STATUS' && when === 'before original SELECT') {
        f.state.statusCount = (f.state.statusCount ?? 0) + 1;
        if (f.state.statusCount === 4) f.folders.get('INBOX').validity++;
      }
    };
    await assert.rejects(f.service.prepare(f.session, body), { code: 'STALE_SCOPE' });
  }
  assert.deepEqual(f.state.creates, []); assert.equal(f.state.commands.filter(command => /STORE|MOVE|EXPUNGE/.test(command)).length, 0);
});
test('prepare: incomplete virtual mapping fails instead of returning a partial manifest', async () => {
  const f = fixture(); f.state.missing = 7;
  await assert.rejects(f.service.prepare(f.session, { ...f.body, scope: { view: 'allmail' } }), { code: 'STALE_SCOPE' });
});
test('prepare: folder filters use intersection, original paths, and Q basename resolution', async () => {
  const f = fixture();
  const { record } = await ready(f, { ...f.body, scope: { view: 'allmail', q: 'in:Projects', in: 'Projects' } });
  assert.deepEqual(record.manifest.map(group => group.path), ['Projects']);
  assert.deepEqual(record.manifest[0].uids, [2]);
});
test('prepare: invalid conditions, action and target do not create selection or perform mail commands', async () => {
  const f = fixture();
  for (const change of [{ scope: { page: '1' } }, { refs: ['synthetic'] }, { action: 'other' }, { action: 'move' }, { action: 'move', target: 'Shared/team' }, { target: 'Archive' }, { selectionKey: 'bad key' }, { cursor: 'bad' }]) {
    await assert.rejects(f.service.prepare(f.session, { ...f.body, ...change }));
  }
  assert.equal(f.state.commands.length, 0);
});
test('prepare: same key locks canonical scope, original q, action and target', async () => {
  const f = fixture(); await ready(f);
  for (const change of [{ scope: { quick: 'unread' } }, { action: 'unseen' }, { action: 'move', target: 'Projects' }]) await assert.rejects(f.service.prepare(f.session, { ...f.body, ...change }), { code: 'SCOPE_CURSOR_MISMATCH' });
  assert.equal((await f.service.prepare(f.session, { ...f.body, scope: { view: 'inbox', folder: '', quick: 'all', q: '', in: '' } })).phase, 'ready');
});
test('prepare: foreign cursor mismatches without exposing foreign selection; unknown id expires', async () => {
  const f = fixture(); const { result } = await ready(f);
  const other = { scanAbort: new AbortController() };
  await assert.rejects(f.service.prepare(other, { ...f.body, cursor: result.cursor }), { code: 'SCOPE_CURSOR_MISMATCH' });
  assert.throws(() => f.service.getSelection(other, result.selectionId), { code: 'SCOPE_EXPIRED' });
});
test('prepare: concurrent same selection is busy, never performs duplicate search', async () => {
  const f = fixture(); let release, started;
  const gate = new Promise(resolve => { release = resolve; }); const entered = new Promise(resolve => { started = resolve; });
  f.state.hook = async command => { if (command === 'UID SORT') { started(); await gate; } };
  const pending = f.service.prepare(f.session, f.body); await entered;
  await assert.rejects(f.service.prepare(f.session, f.body), { code: 'SCOPE_BUSY' });
  release(); await pending; assert.equal(f.state.searches, 1);
});
test('store: ready is active, completed/error release active slot but retain three histories', async () => {
  const f = fixture(); const first = await ready(f);
  await assert.rejects(f.service.prepare(f.session, { ...f.body, selectionKey: 'synthetic-002' }), { code: 'SCOPE_LIMIT' });
  first.record.phase = 'completed';
  const second = await ready(f, { ...f.body, selectionKey: 'synthetic-002' }); second.record.phase = 'error';
  const third = await ready(f, { ...f.body, selectionKey: 'synthetic-003' }); third.record.phase = 'completed';
  await assert.rejects(f.service.prepare(f.session, { ...f.body, selectionKey: 'synthetic-004' }), { code: 'SCOPE_LIMIT' });
  assert.deepEqual((await f.service.prepare(f.session, f.body)).selectionId, first.result.selectionId);
  assert.equal(f.service.getSelection(f.session, second.result.selectionId), second.record);
});
test('store: 30-minute idle TTL touches on access, expires and clears held manifest references', async () => {
  const f = fixture(); const { result, record } = await ready(f);
  f.advance(29 * 60000); f.service.getSelection(f.session, result.selectionId);
  f.advance(29 * 60000); assert.equal(f.service.getSelection(f.session, result.selectionId), record);
  f.advance(30 * 60000); assert.throws(() => f.service.getSelection(f.session, result.selectionId), { code: 'SCOPE_EXPIRED' });
  assert.deepEqual(record.manifest, []); assert.equal(record.disposed, true);
  await ready(f, { ...f.body, selectionKey: 'synthetic-new' });
});
test('store: memory cap includes metadata and receipts; no valid history silently evicted', async () => {
  const f = fixture(); const { result, record } = await ready(f); record.phase = 'completed';
  record.runReceipts = { synthetic: 'x'.repeat(32 * 1024 * 1024) };
  assert.throws(() => f.service.checkStorage(f.session), { code: 'SCOPE_LIMIT' });
  await assert.rejects(f.service.prepare(f.session, { ...f.body, selectionKey: 'synthetic-overflow' }), { code: 'SCOPE_LIMIT' });
  assert.equal(f.service.getSelection(f.session, result.selectionId), record);
  assert.equal(record.runReceipts.synthetic.length, 32 * 1024 * 1024);
});
test('store: abort removes data even from active request references and forbids late completion', async () => {
  const f = fixture(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  f.state.hook = async command => { if (command === 'UID SORT') { entered(); await gate; } };
  const pending = f.service.prepare(f.session, f.body); await started;
  f.session.scanAbort.abort(); release();
  await assert.rejects(pending, { code: 'SESSION_EXPIRED', statusCode: 403 });
  await assert.rejects(f.service.prepare(f.session, f.body), { code: 'SESSION_EXPIRED' });
});
test('store: logout scrubs held selection manifest and receipts immediately', async () => {
  const f = fixture(); const { record } = await ready(f);
  f.session.scanAbort.abort(); assert.deepEqual(record.manifest, []); assert.deepEqual(record.receipts, {});
});
for (const path of ['INBOX', 'Deleted Items']) test(`preflight: delete-forever rejects entire ${path} manifest before mutations`, async () => {
  const f = fixture({ boxes: new Map([[path, { validity: 1, next: 100 }]]) });
  await assert.rejects(f.service.prepare(f.session, { ...f.body, scope: { view: 'folder', folder: path }, action: 'delete-forever' }), { code: 'DELETE_NOT_ALLOWED' });
  assert.deepEqual(f.state.creates, []);
});
for (const path of ['Trash', 'Junk']) test(`preflight: exact ${path} delete-forever is allowed`, async () => {
  const f = fixture({ boxes: new Map([[path, { validity: 1, next: 100 }]]) });
  assert.equal((await ready(f, { ...f.body, scope: { view: 'folder', folder: path }, action: 'delete-forever' })).result.phase, 'ready');
});
test('preflight: all readonly fails with 403 and no mutations', async () => {
  const f = fixture(); f.state.readonly = true;
  await assert.rejects(f.service.prepare(f.session, f.body), { code: 'FOLDER_READONLY', statusCode: 403 });
  assert.deepEqual(f.state.creates, []);
});
for (const existing of [false, true, 'special']) test(`archive: destination fixed at preparation, creation deferred and at most once (${existing})`, async () => {
  const f = fixture();
  if (existing) f.folders.set(existing === 'special' ? 'Old Archive' : 'Archive', { validity: 55, next: 1, specialUse: existing === 'special' ? '\\Archive' : undefined });
  const { record, result } = await ready(f, { ...f.body, action: 'archive' });
  assert.equal(record.resolvedTarget, existing === 'special' ? 'Old Archive' : 'Archive'); assert.deepEqual(f.state.creates, []);
  f.folders.set('New Archive', { validity: 66, next: 1, specialUse: '\\Archive' });
  assert.equal(await f.service.ensureTarget(f.session, result.selectionId), record.resolvedTarget);
  await f.service.ensureTarget(f.session, result.selectionId);
  assert.deepEqual(f.state.creates, existing ? [] : ['Archive']);
});
test('archive: lost create response is never automatically sent again', async () => {
  const f = fixture(); const { result } = await ready(f, { ...f.body, action: 'archive' });
  f.state.onCreate = async () => { throw new Error('synthetic response lost'); };
  await assert.rejects(f.service.ensureTarget(f.session, result.selectionId));
  await assert.rejects(f.service.ensureTarget(f.session, result.selectionId), { code: 'MAIL_REJECTED' });
  assert.deepEqual(f.state.creates, ['Archive']);
});
test('prepare: search deadline is terminal and same key does not retry forever', async () => {
  const f = fixture();
  await assert.rejects(f.service.prepare(f.session, f.body, { budget: f.budget(1000) }), { code: 'MAIL_UNAVAILABLE' });
  const calls = f.state.selects.length;
  await assert.rejects(f.service.prepare(f.session, f.body), { code: 'MAIL_UNAVAILABLE' }); assert.equal(f.state.selects.length, calls);
});

test('prepare: ready run cursor is rejected by preparation endpoint, initial ready receipt still replays', async () => {
  const f = fixture(); const { result } = await ready(f);
  await assert.rejects(f.service.prepare(f.session, { ...f.body, cursor: result.cursor }), { code: 'SCOPE_CURSOR_INVALID' });
  assert.deepEqual(await f.service.prepare(f.session, f.body), result);
});
test('prepare: cutoff timestamp records SELECT boundary before the search returns', async () => {
  const f = fixture(); const { result } = await ready(f);
  assert.equal(result.cutoff.capturedAt, new Date(1000).toISOString());
});
test('prepare: initial oversized scope refuses admission before mail commands and retains no oversized record', async () => {
  const f = fixture();
  await assert.rejects(f.service.prepare(f.session, { ...f.body, scope: { view: 'folder', folder: 'x'.repeat(17 * 1024 * 1024) } }), { code: 'SCOPE_LIMIT' });
  assert.equal(f.state.selects.length, 0); assert.equal(f.service.checkStorage(f.session), 0);
  await ready(f);
});
test('prepare: missing virtual mailbox keeps ALLMAIL_UNAVAILABLE without rebuilding from real folders', async () => {
  const f = fixture(); f.folders.delete(virtual);
  await assert.rejects(f.service.prepare(f.session, { ...f.body, scope: { view: 'allmail' } }), { code: 'ALLMAIL_UNAVAILABLE' });
  assert.equal(f.state.searches, 0); assert.deepEqual(f.state.selects, [virtual]);
});
test('archive: creation obeys the same 10-second start margin and can resume before sending', async () => {
  const f = fixture(); const { result, record } = await ready(f, { ...f.body, action: 'archive' });
  await assert.rejects(f.service.ensureTarget(f.session, result.selectionId, { budget: f.budget(10000) }), { budgetExhausted: true });
  assert.deepEqual(f.state.creates, []); assert.equal(record.targetCreateAttempted, false);
  await f.service.ensureTarget(f.session, result.selectionId); assert.deepEqual(f.state.creates, ['Archive']);
});
for (const action of ['seen', 'unseen', 'flag', 'unflag', 'move', 'archive', 'trash', 'spam', 'notspam', 'delete-forever']) test(`preflight: ${action} binds its action and destination`, async () => {
  const path = action === 'delete-forever' ? 'Trash' : 'INBOX';
  const f = fixture(); f.folders.set('Trash', { validity: 1, next: 100 });
  const { record } = await ready(f, { ...f.body, scope: { view: 'folder', folder: path }, action, ...(action === 'move' ? { target: 'Projects' } : {}) });
  assert.equal(record.action, action);
  assert.equal(record.resolvedTarget, { move: 'Projects', archive: 'Archive', trash: 'Trash', spam: 'Junk', notspam: 'INBOX' }[action] ?? null);
  assert.deepEqual(f.state.creates, []);
});
test('prepare: 2050 candidates retain all 50/200/1000 boundaries in immutable numeric manifest', async () => {
  const f = fixture({ uids: Array.from({ length: 2050 }, (_, i) => 2050 - i), boxes: new Map([['INBOX', { validity: 11, next: 2051 }]]) });
  const { record, replies } = await ready(f, f.body, 10000);
  assert.ok(replies.length > 1); assert.equal(record.initialTotal, 2050);
  assert.deepEqual(record.manifest[0].uids, Array.from({ length: 2050 }, (_, i) => i + 1));
  assert.equal(f.state.searches, 1);
});
test('preflight: shared-only source refuses before any mutation', async () => {
  const f = fixture({ boxes: new Map([['Shared/synthetic/Inbox', { validity: 1, next: 100 }]]) });
  await assert.rejects(f.service.prepare(f.session, { ...f.body, scope: { view: 'folder', folder: 'Shared/synthetic/Inbox' } }), { code: 'FOLDER_READONLY', statusCode: 403 });
  assert.equal(f.state.commands.some(command => /STORE|MOVE|EXPUNGE/.test(command)), false);
});

test('prepare: older successful preparation receipts survive a later STALE_SCOPE error', async () => {
  const f = fixture(); const body = { ...f.body, scope: { view: 'allmail' } };
  const first = await f.service.prepare(f.session, body, { budget: f.budget(2500) });
  f.folders.get(virtual).validity++;
  await assert.rejects(f.service.prepare(f.session, { ...body, cursor: first.cursor }), { code: 'STALE_SCOPE' });
  assert.deepEqual(await f.service.prepare(f.session, body), first);
  await assert.rejects(f.service.prepare(f.session, { ...body, cursor: first.cursor }), { code: 'STALE_SCOPE' });
});
test('archive: empty candidate set never creates an unused destination', async () => {
  const f = fixture({ uids: [] }); const { result } = await ready(f, { ...f.body, action: 'archive' });
  await f.service.ensureTarget(f.session, result.selectionId); assert.deepEqual(f.state.creates, []);
});
test('store: abort also clears held scope and destination metadata', async () => {
  const f = fixture(); const { record } = await ready(f, { ...f.body, action: 'move', target: 'Projects' });
  f.session.scanAbort.abort(); assert.equal(record.scope, undefined); assert.equal(record.resolvedTarget, undefined); assert.equal(record.boundary, undefined);
});
