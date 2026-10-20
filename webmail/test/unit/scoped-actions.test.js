import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uidSet, scopedUidBatches, scopedUidLimit, scopedSetLimit, scopedBatchPolicy, scopedBatchState, scopedBatchReserve, updateScopedBatch } from '../../server/mail/ref.js';
import { createScopedActionService } from '../../server/mail/scoped-actions.js';

function expandSet(set) {
  return set.split(',').flatMap(part => {
    const [first, last = first] = part.split(':').map(Number);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  });
}
const virtual = 'WebmailVirtual/AllMail';
function fixture({ uids = [9, 2, 7, 1], boxes, mapping } = {}) {
  let clock = 0, nested = false;
  const state = { searches: 0, fetches: [], selects: [], creates: [], commands: [], hook: null };
  const folders = boxes ?? new Map([['INBOX', { validity: 11, next: 10 }], ['Projects', { validity: 22, next: 1000 }], [virtual, { validity: 33, next: 1000 }]]);
  const session = { scanAbort: new AbortController() };
  state.live = new Map([...folders.keys()].map(path => [path, new Set(uids)]));
  state.seen = new Set(); state.flagged = new Set(); state.deleted = new Set(); state.mutations = [];
  const identity = uid => `${client.mailbox.path}:${uid}`;
  const client = {
    enabled: new Set(), capabilities: new Map([['MOVE', true]]),
    async *fetch(range) {
      clock += 1000; await state.onFetch?.();
      for (const uid of expandSet(range)) if (state.live.get(client.mailbox.path)?.has(uid)) yield { uid, internalDate: new Date(0), envelope: { subject: `synthetic ${uid}` }, flags: new Set(state.seen.has(identity(uid)) ? ['\\Seen'] : []), size: 10, headers: Buffer.from('') };
    },
    async list() { clock += 1000; return [...folders].map(([path, box]) => ({ path, name: path.split('/').at(-1), specialUse: box.specialUse, flags: new Set() })); },
    async mailboxCreate(path) { clock += 1000; state.creates.push(path); await state.onCreate?.(); folders.set(path, { validity: 44, next: 1 }); return true; },
    async exec(command, attributes, { untagged } = {}) {
      clock += 1000; state.commands.push(command);
      await state.hook?.(command, attributes);
      if (command === 'UID SEARCH') await state.onFetch?.();
      if (command === 'UID SORT' || command === 'UID SEARCH') {
        if (command === 'UID SORT') state.searches++; const wire = JSON.stringify(attributes);
        const current = uids.filter(uid => state.live.get(client.mailbox.path)?.has(uid) && (!wire.includes('UNSEEN') || !state.seen.has(identity(uid))) && (!wire.includes('FLAGGED') || state.flagged.has(identity(uid))));
        const requested = command === 'UID SEARCH' ? new Set(expandSet(attributes.find(attribute => attribute.type === 'SEQUENCE').value)) : null;
        untagged[command === 'UID SEARCH' ? 'SEARCH' : 'SORT']({ attributes: current.filter(uid => !requested || requested.has(uid)).map(uid => ({ value: String(uid) })) });
      }
      if (command === 'MYRIGHTS') untagged.MYRIGHTS({ attributes: [attributes[0], { value: state.readonly ? 'lr' : 'lrswite' }] });
      if (command === 'STATUS') untagged.STATUS({ attributes: [attributes[0], [{ value: 'UIDVALIDITY' }, { value: String(folders.get(attributes[0].value).validity) }]] });
      if (command === 'UID FETCH') {
        state.fetches.push(attributes[0].value);
        for (const uid of expandSet(attributes[0].value)) {
          if (uid === state.missing) continue;
          const source = mapping?.(uid) ?? { path: uid % 2 ? 'INBOX' : 'Projects', uid: uid };
          untagged.FETCH({ attributes: [{ value: 'FETCH' }, [{ value: 'UID' }, { value: String(uid) }, { value: 'X-MAILBOX' }, { value: source.path }, { value: 'X-REAL-UID' }, { value: String(source.uid) }]] });
        }
      }
      if (['UID STORE', 'UID MOVE', 'UID EXPUNGE'].includes(command)) {
        const selected = expandSet(attributes[0].value);
        state.mutations.push({ command, path: client.mailbox.path, uids: selected });
        for (const uid of selected) {
          if (command === 'UID STORE') {
            const flag = attributes[2][0].value;
            assert.equal(flag.codePointAt(0), 92, 'system flag atom starts with a literal backslash');
            const collection = flag === '\\Seen' ? state.seen : flag === '\\Flagged' ? state.flagged : state.deleted;
            if (attributes[1].value === '+FLAGS') collection.add(identity(uid)); else collection.delete(identity(uid));
          } else if (command === 'UID EXPUNGE') {
            if (state.deleted.has(identity(uid))) state.live.get(client.mailbox.path).delete(uid);
          } else {
            state.live.get(client.mailbox.path).delete(uid);
            const target = attributes[1].value;
            if (!state.live.has(target)) state.live.set(target, new Set());
            state.live.get(target).add(folders.get(target).next++);
          }
        }
      }
      return { next() {}, response: { command: 'OK' } };
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
  const service = createScopedActionService({ imap, now: () => clock, measureNow: () => clock });
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
test('prepare: bounded 5000-UID mapping resumes without re-search, same cursor replays identical receipt', async () => {
  const f = fixture({ uids: Array.from({ length: 10020 }, (_, i) => i + 1), boxes: new Map([['INBOX', { validity: 11, next: 20000 }], ['Projects', { validity: 22, next: 20000 }], [virtual, { validity: 33, next: 10021 }]]) });
  const body = { ...f.body, scope: { view: 'allmail' } };
  const first = await f.service.prepare(f.session, body, { budget: f.budget(11000) });
  assert.equal(first.phase, 'preparing'); const calls = f.state.commands.length;
  assert.deepEqual(await f.service.prepare(f.session, body), first); assert.equal(f.state.commands.length, calls);
  // New virtual arrivals stay outside the captured search and fence.
  f.folders.get(virtual).next = 20001;
  const { result, record, replies } = await ready(f, { ...body, cursor: first.cursor }, 11000);
  assert.ok(replies.length > 1); assert.equal(result.initialTotal, 10020); assert.equal(f.state.searches, 1);
  assert.equal(record.boundary.upper, 10020); assert.ok(f.state.fetches.every(set => expandSet(set).length <= 5000 && set.length <= 16384));
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
  f.state.hook = async command => { if (command === 'UID SEARCH') await state.onFetch?.();
      if (command === 'UID SORT' || command === 'UID SEARCH') { started(); await gate; } };
  const pending = f.service.prepare(f.session, f.body); await entered;
  await assert.rejects(f.service.prepare(f.session, f.body), { code: 'SCOPE_BUSY' });
  release(); await pending; assert.equal(f.state.searches, 1);
});
test('store: idle ready closes for new prepare; fourth record evicts oldest closed history', async () => {
  const f = fixture(); const first = await ready(f);
  const second = await ready(f, { ...f.body, selectionKey: 'synthetic-002' });
  assert.equal(first.record.phase, 'stopped'); second.record.phase = 'error';
  const third = await ready(f, { ...f.body, selectionKey: 'synthetic-003' }); third.record.phase = 'completed';
  // A later read does not turn the earliest created history into the newest one.
  f.service.getSelection(f.session, first.result.selectionId);
  const fourth = await ready(f, { ...f.body, selectionKey: 'synthetic-004' });
  assert.throws(() => f.service.getSelection(f.session, first.result.selectionId), { code: 'SCOPE_EXPIRED' });
  assert.equal(first.record.disposed, true);
  assert.equal(f.service.getSelection(f.session, second.result.selectionId), second.record);
  assert.equal(f.service.getSelection(f.session, third.result.selectionId), third.record);
  assert.equal(f.service.getSelection(f.session, fourth.result.selectionId), fourth.record);
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
  f.state.hook = async command => { if (command === 'UID SEARCH') await state.onFetch?.();
      if (command === 'UID SORT' || command === 'UID SEARCH') { entered(); await gate; } };
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
test('prepare: 2050 candidates retain immutable numeric manifest in immutable numeric manifest', async () => {
  const f = fixture({ uids: Array.from({ length: 2050 }, (_, i) => 2050 - i), boxes: new Map([['INBOX', { validity: 11, next: 2051 }]]) });
  const { record, replies } = await ready(f, f.body, 10000);
  assert.ok(replies.length >= 1); assert.equal(record.initialTotal, 2050);
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

function runBody(body, cursor) {
  return { scope: body.scope, cursor, action: body.action, ...(body.target === undefined ? {} : { target: body.target }) };
}
async function executeAll(f, body = f.body, requestMs = 50000) {
  const prepared = await ready(f, body), replies = [];
  let cursor = prepared.result.cursor;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const result = await f.service.execute(f.session, runBody(body, cursor), { budget: f.budget(requestMs) }); replies.push(result);
    assert.equal(result.totals.processed + result.totals.skipped + result.totals.failed + result.remainingEstimate, result.initialTotal);
    if (!result.nextCursor) return { ...prepared, replies, result };
    cursor = result.nextCursor;
  }
  assert.fail('execution did not converge');
}
for (const action of ['move', 'delete-forever', 'seen', 'flag']) test(`execute ${action}: 2050 shrinking/nonshrinking candidates settle once in a compressed batch`, async () => {
  const path = action === 'delete-forever' ? 'Trash' : 'INBOX';
  const f = fixture({ uids: Array.from({ length: 2050 }, (_, index) => 2050 - index), boxes: new Map([[path, { validity: 11, next: 2051 }], ['Projects', { validity: 22, next: 9000 }]]) });
  const body = { ...f.body, scope: { view: 'folder', folder: path }, action, ...(action === 'move' ? { target: 'Projects' } : {}) };
  const { result, record, replies } = await executeAll(f, body);
  assert.deepEqual(result.totals, { processed: 2050, skipped: 0, failed: 0 }); assert.equal(result.state, 'completed'); assert.equal(record.phase, 'completed');
  assert.equal(replies.length, 1);
  const command = action === 'move' ? 'UID MOVE' : action === 'delete-forever' ? 'UID EXPUNGE' : 'UID STORE';
  const applied = f.state.mutations.filter(mutation => mutation.command === command).flatMap(mutation => mutation.uids);
  assert.equal(applied.length, 2050); assert.equal(new Set(applied).size, 2050); assert.ok(f.state.mutations.every(mutation => mutation.uids.length <= 5000));
  if (action === 'move' || action === 'delete-forever') assert.equal(f.state.live.get(path).size, 0);
  else assert.equal(f.state.live.get(path).size, 2050);
});
test('execute: lost HTTP response and older cursor replay immutable totals without issuing any command', async () => {
  const f = fixture({ uids: Array.from({ length: 12000 }, (_, index) => index + 1), boxes: new Map([['INBOX', { validity: 11, next: 12001 }]]) });
  const { result: prepared } = await ready(f);
  const first = await f.service.execute(f.session, runBody(f.body, prepared.cursor), { budget: f.budget(18000) });
  assert.equal(first.state, 'running'); assert.equal(first.totals.processed, 10000);
  const calls = f.state.commands.length;
  assert.deepEqual(await f.service.execute(f.session, runBody(f.body, prepared.cursor)), first); assert.equal(f.state.commands.length, calls);
  const second = await f.service.execute(f.session, runBody(f.body, first.nextCursor)); assert.equal(second.state, 'completed');
  const completedCalls = f.state.commands.length;
  assert.deepEqual(await f.service.execute(f.session, runBody(f.body, prepared.cursor)), first); assert.equal(f.state.commands.length, completedCalls);
});
test('execute: start margin returns zero-progress budget receipt then explicit resume processes remaining only', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  const paused = await f.service.execute(f.session, runBody(f.body, prepared.cursor), { budget: f.budget(9999) });
  assert.equal(paused.reason, 'budget'); assert.deepEqual(paused.totals, { processed: 0, skipped: 0, failed: 0 }); assert.equal(f.state.mutations.length, 0);
  const completed = await f.service.execute(f.session, runBody(f.body, paused.nextCursor)); assert.equal(completed.totals.processed, 4);
  assert.equal(new Set(f.state.mutations.flatMap(mutation => mutation.uids)).size, 4);
});
test('execute: session-scoped cursor, action, target and original scope cannot be replaced', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  const body = runBody(f.body, prepared.cursor);
  for (const change of [{ action: 'unseen' }, { target: 'Projects' }, { scope: { quick: 'unread' } }]) await assert.rejects(f.service.execute(f.session, { ...body, ...change }), { code: 'SCOPE_CURSOR_MISMATCH' });
  await assert.rejects(f.service.execute({ scanAbort: new AbortController() }, body), { code: 'SCOPE_CURSOR_MISMATCH' });
  assert.equal(f.state.mutations.length, 0);
});
test('execute: same cursor concurrent requests yield BUSY and command count stays one', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  let entered, release; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.state.hook = async command => { if (command === 'UID STORE') { entered(); await gate; } };
  const pending = f.service.execute(f.session, runBody(f.body, prepared.cursor)); await started;
  await assert.rejects(f.service.execute(f.session, runBody(f.body, prepared.cursor)), { code: 'SCOPE_BUSY' });
  release(); assert.equal((await pending).totals.processed, 4); assert.equal(f.state.mutations.length, 1);
});
test('execute: unknown is a nonretryable failed subset; response replay never repeats the command', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  f.state.hook = async command => { if (command === 'UID STORE') throw new Error('synthetic lost ACK'); };
  const result = await f.service.execute(f.session, runBody(f.body, prepared.cursor));
  assert.deepEqual(result.totals, { processed: 0, skipped: 0, failed: 4 }); assert.equal(result.state, 'completed');
  assert.ok(result.failed.every(item => item.code === 'ACTION_OUTCOME_UNKNOWN' && !item.retryable));
  const calls = f.state.commands.length; assert.deepEqual(await f.service.execute(f.session, runBody(f.body, prepared.cursor)), result); assert.equal(f.state.commands.length, calls);
});
test('execute: source UIDVALIDITY change produces identical 409/detail on first and replay, never complete', async () => {
  const f = fixture(); const { result: prepared, record } = await ready(f);
  f.folders.get('INBOX').validity++;
  let initial;
  await assert.rejects(f.service.execute(f.session, runBody(f.body, prepared.cursor)), error => { initial = error; return error.statusCode === 409 && error.code === 'STALE_SCOPE'; });
  await assert.rejects(f.service.execute(f.session, runBody(f.body, prepared.cursor)), error => { assert.deepEqual(error.detail, initial.detail); return error.statusCode === 409 && error.code === 'STALE_SCOPE'; });
  assert.equal(initial.detail.state, 'stopped'); assert.equal(initial.detail.reason, 'stale_scope'); assert.equal(initial.detail.nextCursor, null);
  assert.equal(initial.detail.remainingEstimate, 4); assert.equal(record.phase, 'error'); assert.equal(f.state.mutations.length, 0);
  await ready(f, { ...f.body, selectionKey: 'synthetic-after-stale' });
});
test('execute: partial successes survive later STALE_SCOPE; terminal invariant and replay remain exact', async () => {
  const f = fixture({ uids: Array.from({ length: 10000 }, (_, index) => index + 1), boxes: new Map([['INBOX', { validity: 11, next: 10001 }]]) });
  const { result: prepared } = await ready(f);
  f.state.hook = async command => { if (command === 'UID STORE') f.folders.get('INBOX').validity++; };
  let detail;
  await assert.rejects(f.service.execute(f.session, runBody(f.body, prepared.cursor)), error => { detail = error.detail; return error.code === 'STALE_SCOPE'; });
  assert.equal(detail.totals.processed, 5000); assert.equal(detail.remainingEstimate, 5000);
  assert.equal(detail.totals.processed + detail.totals.skipped + detail.totals.failed + detail.remainingEstimate, 10000);
  assert.equal(f.state.mutations.length, 1);
  await assert.rejects(f.service.execute(f.session, runBody(f.body, prepared.cursor)), error => { assert.deepEqual(error.detail, detail); return error.code === 'STALE_SCOPE'; });
});
test('execute: vanished and no-longer-unread candidates skip; late arrivals stay outside manifest', async () => {
  const f = fixture(); const body = { ...f.body, scope: { quick: 'unread' } }; const { result: prepared } = await ready(f, body);
  f.state.live.get('INBOX').delete(2); f.state.seen.add('INBOX:7'); f.state.live.get('INBOX').add(1000);
  const result = await f.service.execute(f.session, runBody(body, prepared.cursor));
  assert.deepEqual(result.totals, { processed: 2, skipped: 2, failed: 0 });
  assert.equal(f.state.seen.has('INBOX:1000'), false); assert.deepEqual(f.state.mutations[0].uids, [1, 9]);
});
test('execute: existing UID newly matching flags is never added to fixed candidates', async () => {
  const f = fixture(); f.state.flagged.add('INBOX:1');
  const body = { ...f.body, scope: { quick: 'starred' } }; const { result: prepared } = await ready(f, body);
  f.state.flagged.add('INBOX:2');
  const result = await f.service.execute(f.session, runBody(body, prepared.cursor)); assert.equal(result.initialTotal, 1);
  assert.equal(f.state.seen.has('INBOX:2'), false); assert.equal(f.state.seen.has('INBOX:1'), true);
});
test('execute: ready reserve refuses an oversized manifest before any mutation', async () => {
  const f = fixture({ uids: Array.from({ length: 100000 }, (_, index) => index + 1), boxes: new Map([['INBOX', { validity: 11, next: 100001 }]]) });
  await assert.rejects(ready(f), { code: 'SCOPE_LIMIT' }); assert.equal(f.state.mutations.length, 0); assert.deepEqual(f.state.creates, []);
});
test('execute: request capacity admission rejects before changing mail and preserves prior record', async () => {
  const f = fixture(); const { result: prepared, record } = await ready(f);
  record.runReceipts.synthetic = { padding: 'x'.repeat(32 * 1024 * 1024) };
  await assert.rejects(f.service.execute(f.session, runBody(f.body, prepared.cursor)), { code: 'SCOPE_LIMIT' }); assert.equal(f.state.mutations.length, 0);
  assert.equal(record.phase, 'ready'); assert.equal(record.cursor, prepared.cursor);
});
test('execute: archive fixes destination, creates once, and replay performs neither CREATE nor MOVE', async () => {
  const f = fixture(); const body = { ...f.body, action: 'archive' }; const { result: prepared } = await ready(f, body);
  const result = await f.service.execute(f.session, runBody(body, prepared.cursor));
  assert.equal(result.totals.processed, 4); assert.deepEqual(f.state.creates, ['Archive']);
  assert.deepEqual(await f.service.execute(f.session, runBody(body, prepared.cursor)), result); assert.deepEqual(f.state.creates, ['Archive']);
});
test('failures: unknown entries use one grouped read-only metadata FETCH, pagination is independent of scope', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  f.state.hook = async command => { if (command === 'UID STORE') throw new Error('synthetic lost ACK'); };
  await f.service.execute(f.session, runBody(f.body, prepared.cursor)); f.state.hook = null;
  const selects = f.state.selects.length, mutations = f.state.mutations.length;
  const listed = await f.service.failures(f.session, prepared.selectionId, { page: 1, pageSize: 3 });
  assert.equal(listed.total, 4); assert.equal(listed.items.length, 3); assert.equal(f.state.selects.length - selects, 1);
  assert.ok(listed.items.every(item => item.subject.startsWith('synthetic') && item.code === 'ACTION_OUTCOME_UNKNOWN' && !item.retryable));
  assert.equal(f.state.mutations.length, mutations); assert.equal((await f.service.failures(f.session, prepared.selectionId, { page: '2', pageSize: '3' })).items.length, 1);
});
test('failures: missing UID or replacement validity is unavailable row with original ref, never substituted', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  f.state.hook = async command => { if (command === 'UID STORE') throw new Error('synthetic lost ACK'); };
  const result = await f.service.execute(f.session, runBody(f.body, prepared.cursor)); f.state.hook = null;
  f.state.live.get('INBOX').delete(1);
  const missing = await f.service.failures(f.session, prepared.selectionId);
  assert.equal(missing.items[0].unavailable, true); assert.equal(missing.items[0].ref, result.failed[0].ref);
  f.folders.get('INBOX').validity++;
  const stale = await f.service.failures(f.session, prepared.selectionId); assert.ok(stale.items.every(item => item.unavailable));
  assert.deepEqual(stale.items.map(item => item.ref), result.failed.map(item => item.ref));
});

test('execute: expired own signed cursor is EXPIRED; foreign or one-character tamper is MISMATCH', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  const body = runBody(f.body, prepared.cursor);
  const changed = (prepared.cursor[0] === 'A' ? 'B' : 'A') + prepared.cursor.slice(1);
  await assert.rejects(f.service.execute(f.session, { ...body, cursor: changed }), { code: 'SCOPE_CURSOR_MISMATCH' });
  await assert.rejects(f.service.execute({ scanAbort: new AbortController() }, body), { code: 'SCOPE_CURSOR_MISMATCH' });
  f.advance(30 * 60000);
  await assert.rejects(f.service.execute(f.session, body), { code: 'SCOPE_EXPIRED' });
  assert.equal(f.state.mutations.length, 0);
});
test('execute: noncanonical cursor encodings cannot alias an existing signed cursor', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  await assert.rejects(f.service.execute(f.session, { ...runBody(f.body, prepared.cursor), cursor: '*'.repeat(43) }), { code: 'SCOPE_CURSOR_INVALID' });
});
test('execute: archive CREATE fatal error saves exact terminal error receipt and releases active slot', async () => {
  const f = fixture(); const body = { ...f.body, action: 'archive' }; const { result: prepared, record } = await ready(f, body);
  f.state.onCreate = async () => { throw new Error('synthetic lost CREATE response'); };
  let first;
  await assert.rejects(f.service.execute(f.session, runBody(body, prepared.cursor)), error => { first = error; return error.code === 'MAIL_UNAVAILABLE' && error.statusCode === 503; });
  await assert.rejects(f.service.execute(f.session, runBody(body, prepared.cursor)), error => { assert.deepEqual(error.detail, first.detail); return error.statusCode === first.statusCode && error.code === first.code; });
  assert.equal(first.detail.state, 'stopped'); assert.equal(first.detail.reason, 'error'); assert.equal(record.phase, 'error');
  assert.equal(first.detail.remainingEstimate, 4); assert.deepEqual(f.state.creates, ['Archive']); assert.equal(f.state.mutations.length, 0);
  await ready(f, { ...f.body, selectionKey: 'synthetic-after-create-error' });
});
test('retry failed: copies only retryable original refs without searching; totals start at zero', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  f.state.onFetch = async () => { throw new Error('synthetic unavailable before mutation'); };
  const failed = await f.service.execute(f.session, runBody(f.body, prepared.cursor));
  assert.equal(failed.totals.failed, 4); assert.ok(failed.failed.every(item => item.code === 'MAIL_UNAVAILABLE' && item.retryable));
  const searches = f.state.searches; f.state.onFetch = null;
  const retryBody = { ...f.body, selectionKey: 'synthetic-retry-001', selectionId: prepared.selectionId, retry: 'failed' };
  const retried = await ready(f, retryBody); assert.equal(f.state.searches, searches); assert.equal(retried.result.initialTotal, 4);
  assert.deepEqual(retried.record.totals, { processed: 0, skipped: 0, failed: 0 });
  const result = await f.service.execute(f.session, runBody(retryBody, retried.result.cursor));
  assert.deepEqual(result.totals, { processed: 4, skipped: 0, failed: 0 }); assert.equal(result.state, 'completed');
  assert.deepEqual(f.service.getSelection(f.session, prepared.selectionId).totals, { processed: 0, skipped: 0, failed: 4 });
});
test('retry failed: unknowns never become retry candidates', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  f.state.hook = async command => { if (command === 'UID STORE') throw new Error('synthetic lost ACK'); };
  await f.service.execute(f.session, runBody(f.body, prepared.cursor)); f.state.hook = null;
  const searches = f.state.searches;
  const retried = await ready(f, { ...f.body, selectionKey: 'synthetic-retry-unknown', selectionId: prepared.selectionId, retry: 'failed' });
  assert.equal(retried.result.initialTotal, 0); assert.equal(f.state.searches, searches);
  const result = await f.service.execute(f.session, runBody(f.body, retried.result.cursor)); assert.equal(result.totals.processed, 0);
});
test('retry failed: replaced source with same UID fails fresh SELECT; never re-searches or changes replacement', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  f.state.onFetch = async () => { throw new Error('synthetic unavailable'); };
  await f.service.execute(f.session, runBody(f.body, prepared.cursor)); f.state.onFetch = null;
  f.folders.get('INBOX').validity++;
  const searches = f.state.searches;
  await assert.rejects(f.service.prepare(f.session, { ...f.body, selectionKey: 'synthetic-retry-stale', selectionId: prepared.selectionId, retry: 'failed' }), { code: 'STALE_SCOPE' });
  assert.equal(f.state.searches, searches); assert.equal(f.state.mutations.length, 0);
});
test('retry failed: changed action/scope/target, arbitrary refs and foreign source id are rejected', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  await f.service.execute(f.session, runBody(f.body, prepared.cursor));
  const body = { ...f.body, selectionKey: 'synthetic-retry-invalid', selectionId: prepared.selectionId, retry: 'failed' };
  for (const change of [{ action: 'unseen' }, { scope: { quick: 'unread' } }, { action: 'move', target: 'Projects' }]) await assert.rejects(f.service.prepare(f.session, { ...body, ...change }), { code: 'SCOPE_CURSOR_MISMATCH' });
  await assert.rejects(f.service.prepare(f.session, { ...body, refs: ['synthetic'] }), { code: 'SCOPE_CURSOR_INVALID' });
  await assert.rejects(f.service.prepare({ scanAbort: new AbortController() }, body), { code: 'SCOPE_EXPIRED' });
});
test('execute: settled skip ahead of budget-stopped UID is not repeated or advanced past', async () => {
  const f = fixture(); const { result: prepared, record } = await ready(f); f.state.live.get('INBOX').delete(7);
  const first = await f.service.execute(f.session, runBody(f.body, prepared.cursor), { budget: f.budget(12000) });
  assert.equal(first.reason, 'budget'); assert.deepEqual(first.totals, { processed: 0, skipped: 1, failed: 0 });
  assert.deepEqual(record.outcomes[0], [0, 0, 2, 0]);
  const completed = await f.service.execute(f.session, runBody(f.body, first.nextCursor));
  assert.deepEqual(completed.totals, { processed: 3, skipped: 1, failed: 0 }); assert.deepEqual(f.state.mutations[0].uids, [1, 2, 9]);
});
test('execute: logout during command clears held records and forbids late ACK from restoring counters', async () => {
  const f = fixture(); const { result: prepared, record } = await ready(f);
  f.state.hook = async command => { if (command === 'UID STORE') f.session.scanAbort.abort(); };
  await assert.rejects(f.service.execute(f.session, runBody(f.body, prepared.cursor)), { code: 'SESSION_EXPIRED' });
  assert.equal(record.disposed, true); assert.equal(record.totals, undefined); assert.deepEqual(record.runReceipts, {});
});

test('execute: one HTTP request handles all 50k when time allows, with bounded commands and cached rights', async () => {
  const f = fixture({ uids: Array.from({ length: 50000 }, (_, index) => index + 1), boxes: new Map([['INBOX', { validity: 11, next: 50001 }]]) });
  const { result: prepared, record } = await ready(f);
  assert.ok(f.service.checkStorage(f.session) < 32 * 1024 * 1024);
  const commands = f.state.commands.length, selects = f.state.selects.length;
  const result = await f.service.execute(f.session, runBody(f.body, prepared.cursor), { budget: { remainingMs: () => 50000 } });
  assert.equal(result.delta.processed, 50000); assert.equal(result.reason, 'complete'); assert.equal(result.remainingEstimate, 0);
  assert.equal(f.state.selects.length - selects, 10);
  assert.deepEqual(f.state.commands.slice(commands), ['MYRIGHTS', ...Array.from({ length: 10 }, () => ['UID SEARCH', 'UID STORE']).flat()]);
  assert.ok(f.state.mutations.every(row => row.uids.length === 5000));
  assert.equal(record.reserveBytes, 0);
  assert.ok(f.service.checkStorage(f.session) < 32 * 1024 * 1024);
  const count = f.state.commands.length;
  assert.deepEqual(await f.service.execute(f.session, runBody(f.body, prepared.cursor)), result);
  assert.equal(f.state.commands.length, count);
});

test('execute: destination also a later source never reselects fresh destination UIDs', async () => {
  const f = fixture(); const body = { ...f.body, scope: { view: 'allmail' }, action: 'move', target: 'Projects' };
  const { result: prepared, record } = await ready(f, body);
  assert.deepEqual(record.manifest.map(group => group.path), ['INBOX', 'Projects']);
  const beforeTarget = f.state.live.get('Projects').size;
  const result = await f.service.execute(f.session, runBody(body, prepared.cursor));
  assert.deepEqual(result.totals, { processed: 4, skipped: 0, failed: 0 }); assert.equal(result.state, 'completed');
  assert.equal(f.state.live.get('Projects').size - beforeTarget, 3);
  assert.deepEqual(f.state.mutations, [{ command: 'UID MOVE', path: 'INBOX', uids: [1, 7, 9] }]);
});
test('execute: repeated read/unread and flag/unflag choices use fixed identities for all ten actions', async () => {
  for (const action of ['unseen', 'unflag', 'trash', 'spam', 'notspam']) {
    const f = fixture(); f.folders.set('Trash', { validity: 44, next: 100 }); f.folders.set('Junk', { validity: 55, next: 100 });
    for (const uid of [1, 2, 7, 9]) { f.state.seen.add(`INBOX:${uid}`); f.state.flagged.add(`INBOX:${uid}`); }
    const { result } = await executeAll(f, { ...f.body, action });
    assert.deepEqual(result.totals, { processed: 4, skipped: 0, failed: 0 });
    if (action === 'unseen') assert.equal(f.state.seen.size, 0);
    if (action === 'unflag') assert.equal(f.state.flagged.size, 0);
    if (action === 'notspam') assert.equal(f.state.mutations.length, 0);
  }
});
test('failures: foreign and expired selection cannot be read; invalid pagination is rejected', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  await assert.rejects(f.service.failures({ scanAbort: new AbortController() }, prepared.selectionId), { code: 'SCOPE_EXPIRED' });
  for (const query of [{ page: 0 }, { pageSize: -1 }, { page: ['1'] }, { scope: {} }]) await assert.rejects(f.service.failures(f.session, prepared.selectionId, query));
  f.advance(30 * 60000); await assert.rejects(f.service.failures(f.session, prepared.selectionId), { code: 'SCOPE_EXPIRED' });
});
test('failures: deadline and transport failures remain errors instead of synthetic missing-mail rows', async () => {
  const f = fixture(); const { result: prepared } = await ready(f);
  f.state.onFetch = async () => { throw new Error('synthetic unavailable'); };
  await f.service.execute(f.session, runBody(f.body, prepared.cursor));
  await assert.rejects(f.service.failures(f.session, prepared.selectionId), { code: 'MAIL_UNAVAILABLE' });
  f.state.onFetch = null;
  await assert.rejects(f.service.failures(f.session, prepared.selectionId, {}, { budget: f.budget(0) }), { budgetExhausted: true });
});
test('execute: terminal outcome releases unused reserved bytes while retaining receipts and original manifest', async () => {
  const f = fixture(); const { result: prepared, record } = await ready(f); assert.ok(record.reserveBytes > 0);
  await f.service.execute(f.session, runBody(f.body, prepared.cursor));
  assert.equal(record.reserveBytes, 0); assert.equal(record.manifest[0].uids.length, 4); assert.ok(record.runReceipts[prepared.cursor]);
});
test('retry failed: a partial failure retries only failed refs and never successful candidates', async () => {
  const f = fixture(); const body = { ...f.body, scope: { view: 'allmail' } }; const { result: prepared } = await ready(f, body);
  f.state.onFetch = async () => { if (f.client.mailbox.path === 'Projects') throw new Error('synthetic folder transport'); };
  const result = await f.service.execute(f.session, runBody(body, prepared.cursor));
  assert.deepEqual(result.totals, { processed: 3, skipped: 0, failed: 1 }); f.state.onFetch = null;
  const searches = f.state.searches;
  const retryBody = { ...body, selectionKey: 'synthetic-retry-partial', selectionId: prepared.selectionId, retry: 'failed' };
  const retried = await ready(f, retryBody); assert.equal(f.state.searches, searches); assert.equal(retried.result.initialTotal, 1);
  assert.deepEqual(retried.record.manifest.map(group => group.path), ['Projects']);
  const count = f.state.mutations.length;
  const retriedResult = await f.service.execute(f.session, runBody(body, retried.result.cursor)); assert.equal(retriedResult.totals.processed, 1);
  assert.equal(f.state.mutations.length - count, 1); assert.deepEqual(f.state.mutations.at(-1).uids, [2]);
});

test('S3: superseded ready record stays queryable but all its execution/preparation cursors expire', async () => {
  const f = fixture(); const first = await ready(f);
  const second = await ready(f, { ...f.body, selectionKey: 'synthetic-new-scope', scope: { quick: 'unread' } });
  assert.equal(first.record.phase, 'stopped'); assert.equal(first.record.reserveBytes, 0); assert.equal(second.record.phase, 'ready');
  assert.deepEqual(await f.service.failures(f.session, first.result.selectionId), { total: 0, page: 1, pageSize: 50, items: [] });
  const calls = f.state.commands.length;
  await assert.rejects(f.service.execute(f.session, runBody(f.body, first.result.cursor)), { statusCode: 409, code: 'SCOPE_EXPIRED' });
  await assert.rejects(f.service.prepare(f.session, f.body), { code: 'SCOPE_EXPIRED' }); assert.equal(f.state.commands.length, calls);
});
test('S3: paused running record closes for new prepare, retains failures, rejects next and settled cursors', async () => {
  const f = fixture({ uids: Array.from({ length: 12000 }, (_, i) => i + 1), boxes: new Map([['INBOX', { validity: 11, next: 12001 }]]) });
  const first = await ready(f); let fetches = 0;
  f.state.onFetch = async () => { if (++fetches === 1) throw new Error('synthetic first-group failure'); };
  const paused = await f.service.execute(f.session, runBody(f.body, first.result.cursor), { budget: f.budget(17000) });
  assert.equal(paused.state, 'running'); assert.deepEqual(paused.totals, { processed: 5000, skipped: 0, failed: 5000 });
  f.state.onFetch = null;
  await ready(f, { ...f.body, selectionKey: 'synthetic-after-pause' }); assert.equal(first.record.phase, 'stopped');
  const failures = await f.service.failures(f.session, first.result.selectionId); assert.equal(failures.total, 5000); assert.ok(failures.items.every(item => item.retryable));
  const changes = f.state.mutations.length;
  for (const cursor of [first.result.cursor, paused.nextCursor]) await assert.rejects(f.service.execute(f.session, runBody(f.body, cursor)), { code: 'SCOPE_EXPIRED' });
  assert.equal(f.state.mutations.length, changes);
});
test('S3: failed-only prepare can replace a paused running source without waiting for TTL', async () => {
  const f = fixture({ uids: Array.from({ length: 6000 }, (_, i) => i + 1), boxes: new Map([['INBOX', { validity: 11, next: 6001 }]]) });
  const first = await ready(f); f.state.onFetch = async () => { throw new Error('synthetic read failure'); };
  const paused = await f.service.execute(f.session, runBody(f.body, first.result.cursor), { budget: f.budget(12000) });
  assert.equal(paused.state, 'running'); assert.equal(paused.totals.failed, 5000); f.state.onFetch = null;
  const searches = f.state.searches;
  const retry = await ready(f, { ...f.body, selectionKey: 'synthetic-retry-paused', selectionId: first.result.selectionId, retry: 'failed' });
  assert.equal(first.record.phase, 'stopped'); assert.equal(retry.result.initialTotal, 5000); assert.equal(f.state.searches, searches);
  assert.equal((await f.service.failures(f.session, first.result.selectionId)).total, 5000);
});
test('S3: partially prepared idle selection closes and its old preparation cursor cannot resume', async () => {
  const f = fixture(); const body = { ...f.body, scope: { view: 'allmail' } };
  const first = await f.service.prepare(f.session, body, { budget: f.budget(2500) }); assert.equal(first.phase, 'preparing');
  const old = f.service.getSelection(f.session, first.selectionId);
  await ready(f, { ...f.body, selectionKey: 'synthetic-replace-preparing' }); assert.equal(old.phase, 'stopped');
  await assert.rejects(f.service.prepare(f.session, { ...body, cursor: first.cursor }), { code: 'SCOPE_EXPIRED' });
});
test('S3: new preparation during an in-flight prepare is BUSY and does not close the old selection', async () => {
  const f = fixture(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.state.hook = async command => { if (command === 'UID SEARCH') await state.onFetch?.();
      if (command === 'UID SORT' || command === 'UID SEARCH') { entered(); await gate; } };
  const pending = f.service.prepare(f.session, f.body); await started;
  const selects = f.state.selects.length;
  await assert.rejects(f.service.prepare(f.session, { ...f.body, selectionKey: 'synthetic-during-preparing' }), { statusCode: 409, code: 'SCOPE_BUSY' });
  assert.equal(f.state.selects.length, selects); release(); assert.equal((await pending).phase, 'ready');
});
test('S3: fourth preparation during in-flight execution preserves the active record and all histories', async () => {
  const f = fixture(); const first = await ready(f); first.record.phase = 'completed';
  const second = await ready(f, { ...f.body, selectionKey: 'synthetic-history-2' }); second.record.phase = 'error';
  const thirdBody = { ...f.body, selectionKey: 'synthetic-active-3' }, third = await ready(f, thirdBody);
  let entered, release; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.state.hook = async command => { if (command === 'UID STORE') { entered(); await gate; } };
  const pending = f.service.execute(f.session, runBody(thirdBody, third.result.cursor)); await started;
  await assert.rejects(f.service.prepare(f.session, { ...f.body, selectionKey: 'synthetic-busy-fourth' }), { code: 'SCOPE_BUSY' });
  assert.equal(f.service.getSelection(f.session, first.result.selectionId), first.record);
  assert.equal(f.service.getSelection(f.session, second.result.selectionId), second.record);
  assert.equal(f.service.getSelection(f.session, third.result.selectionId), third.record); assert.equal(third.record.phase, 'running');
  release(); assert.equal((await pending).totals.processed, 4);
});
test('S3: eviction skips a closed record whose failures metadata request is still in flight', async () => {
  const f = fixture(); const first = await ready(f);
  f.state.onFetch = async () => { throw new Error('synthetic failure'); };
  await f.service.execute(f.session, runBody(f.body, first.result.cursor)); f.state.onFetch = null;
  const second = await ready(f, { ...f.body, selectionKey: 'synthetic-closed-2' }); second.record.phase = 'completed';
  const third = await ready(f, { ...f.body, selectionKey: 'synthetic-closed-3' }); third.record.phase = 'error';
  let entered, release; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.state.onFetch = async () => { entered(); await gate; };
  const reading = f.service.failures(f.session, first.result.selectionId); await started;
  // No new mailbox operation can start with this exhausted request budget.
  await assert.rejects(f.service.prepare(f.session, { ...f.body, selectionKey: 'synthetic-fourth-reader' }, { budget: f.budget(0) }), { code: 'MAIL_UNAVAILABLE' });
  assert.equal(f.service.getSelection(f.session, first.result.selectionId), first.record);
  assert.throws(() => f.service.getSelection(f.session, second.result.selectionId), { code: 'SCOPE_EXPIRED' });
  assert.equal(f.service.getSelection(f.session, third.result.selectionId), third.record);
  release(); assert.equal((await reading).items.length, 4); assert.equal(first.record.readers, 0);
});


test('UID sets: range compression preserves gaps, uint32 edge and the 5000/16KiB limits', () => {
  assert.equal(uidSet([1, 2, 3, 7, 9, 10, 0xfffffffe, 0xffffffff]), '1:3,7,9:10,4294967294:4294967295');
  for (const uids of [
    Array.from({ length: 50000 }, (_, index) => index + 1),
    Array.from({ length: 5000 }, (_, index) => 0xffffffff - 10000 + index * 2),
  ]) {
    const batches = [...scopedUidBatches(uids)];
    assert.deepEqual(batches.flat(), uids);
    for (const batch of batches) {
      assert.ok(batch.length <= scopedUidLimit);
      assert.ok(uidSet(batch).length <= scopedSetLimit);
      assert.deepEqual(expandSet(uidSet(batch)), batch);
    }
    if (uids.length === 50000) assert.equal(batches.length, 10);
    else { assert.equal(batches.length, 4); assert.equal(uidSet(batches[0]).length, 16378); }
  }
});
for (const action of ['trash', 'move']) test(`PERF 50k ${action}: adaptive SEARCH/MOVE pairs, one source/target rights and LIST per request`, async t => {
  const f = fixture({ uids: Array.from({ length: 50000 }, (_, index) => index + 1), boxes: new Map([['INBOX', { validity: 11, next: 50001 }], ['Trash', { validity: 22, next: 1 }], ['Projects', { validity: 33, next: 1 }]]) });
  const body = { ...f.body, action, scope: { quick: 'unread' }, ...(action === 'move' ? { target: 'Projects' } : {}) };
  const { result: prepared } = await ready(f, body);
  const commands = f.state.commands.length;
  let lists = 0; const list = f.client.list;
  f.client.list = async (...args) => { lists++; return list(...args); };
  const result = await f.service.execute(f.session, runBody(body, prepared.cursor), { budget: { remainingMs: () => 50000 } });
  assert.equal(result.totals.processed, 50000); assert.equal(result.state, 'completed');
  const wire = f.state.commands.slice(commands);
  assert.equal(wire.filter(command => command === 'UID SEARCH').length, 27);
  assert.equal(wire.filter(command => command === 'UID MOVE').length, 27);
  assert.equal(wire.filter(command => command === 'MYRIGHTS').length, 2); assert.equal(lists, 1);
  assert.equal(wire.filter(command => ['UID SORT', 'UID FETCH'].includes(command)).length, 0);
  assert.deepEqual(f.state.mutations.slice(0, 3).map(row => row.uids.length), [500, 1000, 2000]);
  assert.ok(f.state.mutations.every(row => row.uids.length <= 2000));
  assert.equal(f.state.live.get('INBOX').size, 0);
  assert.equal(f.state.live.get(action === 'trash' ? 'Trash' : 'Projects').size, 50000);
  t.diagnostic(`50k ${action}: ${wire.length + lists} IMAP commands excluding SELECT, storage ${f.service.checkStorage(f.session)} bytes`);
});

test('PERF 50k retryable failures: prepare, full failure receipts and failed-only retry fit 32MiB', async t => {
  const f = fixture({ uids: Array.from({ length: 50000 }, (_, index) => index + 1), boxes: new Map([['INBOX', { validity: 11, next: 50001 }]]) });
  const { result: prepared } = await ready(f);
  const preparedBytes = f.service.checkStorage(f.session);
  f.state.onFetch = async () => { throw new Error('synthetic read failure'); };
  const result = await f.service.execute(f.session, runBody(f.body, prepared.cursor), { budget: { remainingMs: () => 50000 } });
  assert.equal(result.totals.failed, 50000); assert.equal(result.state, 'completed');
  assert.ok(result.failed.every(row => row.retryable));
  const failedBytes = f.service.checkStorage(f.session);
  assert.ok(preparedBytes < 32 * 1024 * 1024); assert.ok(failedBytes < 32 * 1024 * 1024);
  const count = f.state.commands.length;
  assert.deepEqual(await f.service.execute(f.session, runBody(f.body, prepared.cursor)), result);
  assert.equal(f.state.commands.length, count);
  f.state.onFetch = null;
  const retryBody = { ...f.body, selectionKey: 'synthetic-50k-retry', selectionId: prepared.selectionId, retry: 'failed' };
  const retry = await ready(f, retryBody);
  assert.equal(retry.result.initialTotal, 50000);
  const retryBytes = f.service.checkStorage(f.session); assert.ok(retryBytes < 32 * 1024 * 1024);
  const recovered = await f.service.execute(f.session, runBody(f.body, retry.result.cursor), { budget: { remainingMs: () => 50000 } });
  assert.equal(recovered.totals.processed, 50000);
  t.diagnostic(`50k storage: prepared=${preparedBytes}, failed=${failedBytes}, retained failure plus ready retry=${retryBytes} bytes`);
});

test('PERF 50k lost ACK: exactly 5000 unknown per request, no next group, replay and retry exclusion', async t => {
  const f = fixture({ uids: Array.from({ length: 50000 }, (_, index) => index + 1), boxes: new Map([['INBOX', { validity: 11, next: 50001 }]]) });
  const { result: prepared } = await ready(f);
  f.state.hook = async command => { if (command === 'UID STORE') throw new Error('synthetic lost ACK'); };
  let cursor = prepared.cursor, maximumBytes = f.service.checkStorage(f.session), result;
  for (let batch = 0; batch < 10; batch++) {
    const before = f.state.commands.length;
    result = await f.service.execute(f.session, runBody(f.body, cursor), { budget: { remainingMs: () => 50000 } });
    assert.equal(result.delta.failed, 5000);
    assert.equal(result.remainingEstimate, 50000 - (batch + 1) * 5000);
    assert.ok(result.failed.every(row => row.code === 'ACTION_OUTCOME_UNKNOWN' && !row.retryable));
    assert.deepEqual(f.state.commands.slice(before), ['MYRIGHTS', 'UID SEARCH', 'UID STORE']);
    const after = f.state.commands.length;
    assert.deepEqual(await f.service.execute(f.session, runBody(f.body, cursor)), result);
    assert.equal(f.state.commands.length, after);
    maximumBytes = Math.max(maximumBytes, f.service.checkStorage(f.session));
    cursor = result.nextCursor;
  }
  assert.equal(result.totals.failed, 50000); assert.equal(result.state, 'completed');
  assert.ok(maximumBytes < 32 * 1024 * 1024);
  const retry = await ready(f, { ...f.body, selectionKey: 'synthetic-no-unknown-retry', selectionId: prepared.selectionId, retry: 'failed' });
  assert.equal(retry.result.initialTotal, 0);
  t.diagnostic(`50k unknown: maximum admitted storage=${maximumBytes} bytes`);
});


for (const loseSecond of [false, true]) test(`sparse recheck: bounded mutation subgroups preserve ${loseSecond ? 'first ACK and unknown remainder' : 'all ACKs'}`, async () => {
  const uids = Array.from({ length: 5000 }, (_, index) => 0xffffffff - 4999 + index);
  const f = fixture({ uids, boxes: new Map([['INBOX', { validity: 11, next: 0x100000000 }]]) });
  const { result: prepared } = await ready(f);
  const matching = uids.filter(uid => uid % 2 === 0);
  f.state.live.set('INBOX', new Set(matching));
  const batches = [...scopedUidBatches(matching)]; assert.equal(batches.length, 2);
  const wire = [];
  f.state.hook = async (command, attributes) => {
    if (command !== 'UID STORE') return;
    wire.push(attributes[0].value);
    if (loseSecond && wire.length === 2) throw new Error('synthetic second-subgroup ACK loss');
  };
  const result = await f.service.execute(f.session, runBody(f.body, prepared.cursor));
  assert.deepEqual(wire, batches.map(uidSet));
  assert.ok(wire.every(set => set.length <= scopedSetLimit));
  assert.equal(result.totals.skipped, 2500);
  assert.equal(result.totals.processed, loseSecond ? batches[0].length : 2500);
  assert.equal(result.totals.failed, loseSecond ? batches[1].length : 0);
  assert.ok(result.failed.every(row => row.code === 'ACTION_OUTCOME_UNKNOWN' && !row.retryable));
  assert.equal(result.state, 'completed');
  const count = f.state.commands.length;
  assert.deepEqual(await f.service.execute(f.session, runBody(f.body, prepared.cursor)), result);
  assert.equal(f.state.commands.length, count);
});

test('execution rights cache expires with each request, and changed ACL prevents the next mutation', async () => {
  const f = fixture({ uids: Array.from({ length: 12000 }, (_, index) => index + 1), boxes: new Map([['INBOX', { validity: 11, next: 12001 }]]) });
  const { result: prepared } = await ready(f);
  const first = await f.service.execute(f.session, runBody(f.body, prepared.cursor), { budget: f.budget(18000) });
  assert.equal(first.totals.processed, 10000); assert.equal(first.state, 'running');
  const mutations = f.state.mutations.length, rights = f.state.commands.filter(command => command === 'MYRIGHTS').length;
  f.state.readonly = true;
  const second = await f.service.execute(f.session, runBody(f.body, first.nextCursor));
  assert.equal(second.totals.failed, 2000); assert.equal(second.state, 'completed');
  assert.equal(f.state.mutations.length, mutations);
  assert.equal(f.state.commands.filter(command => command === 'MYRIGHTS').length, rights + 1);
  assert.ok(second.failed.every(row => row.code === 'FOLDER_READONLY' && !row.retryable));
});


test('PERF 50k allmail preparation: ten mapping groups preserve both STATUS fences', async t => {
  const f = fixture({ uids: Array.from({ length: 50000 }, (_, index) => index + 1), boxes: new Map([['INBOX', { validity: 11, next: 50001 }], ['Projects', { validity: 22, next: 50001 }], [virtual, { validity: 33, next: 50001 }]]) });
  let lists = 0; const list = f.client.list;
  f.client.list = async (...args) => { lists++; return list(...args); };
  const result = await f.service.prepare(f.session, { ...f.body, scope: { view: 'allmail' } }, { budget: { remainingMs: () => 50000 } });
  assert.equal(result.phase, 'ready'); assert.equal(result.initialTotal, 50000);
  assert.equal(f.state.fetches.length, 10); assert.equal(lists, 10);
  assert.equal(f.state.commands.filter(command => command === 'STATUS').length, 40);
  assert.equal(f.state.searches, 1);
  assert.ok(f.state.fetches.every(set => expandSet(set).length === 5000 && set.length <= scopedSetLimit));
  assert.ok(f.service.checkStorage(f.session) < 32 * 1024 * 1024);
  t.diagnostic(`50k allmail, two source folders: ${f.state.commands.length + lists} preparation commands excluding SELECT`);
});

test('sparse recheck: budget after first subgroup ACK preserves success and resumes only unsent UIDs', async () => {
  const uids = Array.from({ length: 5000 }, (_, index) => 0xffffffff - 4999 + index);
  const f = fixture({ uids, boxes: new Map([['INBOX', { validity: 11, next: 0x100000000 }]]) });
  const { result: prepared } = await ready(f);
  const matching = uids.filter(uid => uid % 2 === 0), batches = [...scopedUidBatches(matching)];
  f.state.live.set('INBOX', new Set(matching));
  let stores = 0;
  f.state.hook = async command => { if (command === 'UID STORE' && ++stores === 1) f.advance(2000); };
  const first = await f.service.execute(f.session, runBody(f.body, prepared.cursor), { budget: f.budget(15000) });
  assert.deepEqual(first.totals, { processed: batches[0].length, skipped: 2500, failed: 0 });
  assert.equal(first.remainingEstimate, batches[1].length); assert.equal(first.reason, 'budget');
  assert.equal(stores, 1);
  f.state.hook = null;
  const second = await f.service.execute(f.session, runBody(f.body, first.nextCursor));
  assert.equal(second.totals.processed, 2500); assert.equal(second.state, 'completed');
  assert.deepEqual(f.state.mutations.at(-1).uids, batches[1]);
});


test('adaptive policy: initial/min/max/growth bounds and size-scaled strict start reserve', () => {
  const state = scopedBatchState('move'); assert.equal(state.size, 500);
  updateScopedBatch(state, 500, 100); assert.equal(state.size, 1000);
  updateScopedBatch(state, 1000, 100); assert.equal(state.size, 2000);
  updateScopedBatch(state, 2000, 1); assert.equal(state.size, 2000);
  updateScopedBatch(state, 2000, 80000); assert.equal(state.size, 50);
  assert.equal(scopedBatchReserve(state, 50), 10000, 'smaller next group can resume after a slow large command');
  updateScopedBatch(state, 50, 6000); assert.equal(state.size, 50);
  assert.equal(scopedBatchReserve(state, 50), 14000);
  assert.equal(scopedBatchReserve(state, 100), 26000);
  for (const action of ['seen', 'unseen', 'flag', 'unflag']) {
    const fixed = scopedBatchState(action); updateScopedBatch(fixed, 5000, 80000); assert.equal(fixed.size, 5000);
  }
  for (const action of ['move', 'trash', 'archive', 'spam', 'notspam', 'delete-forever']) assert.equal(scopedBatchState(action).size, scopedBatchPolicy.initial);
});

test('adaptive MOVE: size and previous cost survive cursor boundaries, slow commands reduce next group', async () => {
  const f = fixture({ uids: Array.from({ length: 3000 }, (_, index) => index + 1), boxes: new Map([['INBOX', { validity: 11, next: 3001 }], ['Projects', { validity: 22, next: 1 }]]) });
  const body = { ...f.body, action: 'move', target: 'Projects' };
  const { result: prepared, record } = await ready(f, body);
  let first = true;
  f.state.hook = async command => { if (command === 'UID MOVE' && first) { first = false; f.advance(29000); } };
  const response = await f.service.execute(f.session, runBody(body, prepared.cursor), { budget: f.budget(50000) });
  assert.equal(f.state.mutations[0].uids.length, 500);
  assert.equal(record.batchStates[0].lastMs, 1000, 'subsequent smaller fast groups replace the initial 30s observation');
  assert.ok(f.state.mutations.some(row => row.uids.length === 50), 'slow first unit shrinks to minimum');
  assert.ok(response.nextCursor); assert.ok(response.totals.processed > 500);
  const state = structuredClone(record.batchStates[0]);
  const count = f.state.mutations.length;
  const resumed = await f.service.execute(f.session, runBody(body, response.nextCursor));
  assert.equal(f.state.mutations[count].uids.length, state.size);
  assert.equal(resumed.state, 'completed'); assert.equal(resumed.totals.processed, 3000);
});
