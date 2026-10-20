import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { integration, login, imap, message, unique, cleanup, email, password, tlsConfig } from './lib/runtime.js';
import { createScopedActionService } from '../../server/mail/scoped-actions.js';
import { createImapPool } from '../../server/mail/imap-pool.js';

// Separate top-level integration() cases keep seeding and each measurement within 300s.
// Run this file alone on the approved VM; it must not race the core auth limiter.
const user = process.env.WEBMAIL_INT_SELECT_USER || 'user1';
const count = 2050;
async function cleanupConnection(t, direct) {
  if (direct.usable) {
    try { await direct.logout(); } finally { direct.close(); }
  }
  return imap(t, user);
}
async function scratch(t, web, direct) {
  const name = unique();
  await web.request('POST', '/api/folders', { name }, 201);
  // Owned unique folders only. Keep cleanup independent of the existing empty API.
  cleanup(t, async () => {
    const fresh = await cleanupConnection(t, direct);
    try {
      await fresh.mailboxOpen(name);
      const uids = await fresh.search({ all: true }, { uid: true });
      for (let index = 0; index < uids.length; index += 1000) {
        assert.ok(await fresh.messageDelete(uids.slice(index, index + 1000).join(','), { uid: true }));
      }
      await fresh.mailboxClose();
      assert.ok(await fresh.mailboxDelete(name));
      t.diagnostic(JSON.stringify({ cleanupFolder: name, deletedUids: uids.length }));
    } finally {
      try { await fresh.logout(); } finally { fresh.close(); }
    }
  });
  return name;
}
async function timed(t, label, operation) {
  const start = performance.now();
  let result;
  try { result = await operation(); return result; }
  finally {
    t.diagnostic(JSON.stringify({ request: label, ms: Math.round(performance.now() - start),
      ...(result?.totals ? { sequence: result.sequence, delta: result.delta, totals: result.totals, remaining: result.remainingEstimate } : {}) }));
  }
}
async function prepare(t, web, scope, action, target, extra = {}) {
  const body = { selectionKey: unique(), scope, action, ...(target ? { target } : {}), ...extra };
  let result;
  do {
    result = await timed(t, 'HTTP prepare', () => web.request('POST', '/api/messages/selections', body));
    body.cursor = result.cursor;
  } while (result.phase === 'preparing');
  assert.equal(result.phase, 'ready');
  return result;
}
async function snapshot(t, path, subject) {
  // A new authenticated connection for EVERY observation, never selected STATUS/cache.
  const fresh = await imap(t, user);
  try {
    await fresh.mailboxOpen(path, { readOnly: true });
    const validity = Number(fresh.mailbox.uidValidity);
    const uids = await fresh.search({ subject }, { uid: true });
    const rows = uids.length ? await fresh.fetchAll(uids.join(','), { uid: true, flags: true, envelope: true }, { uid: true }) : [];
    // Recent is connection-specific; compare only persistent message flags.
    return { validity, rows: rows.map(row => ({ uid: row.uid, subject: row.envelope.subject, flags: [...row.flags].filter(flag => flag !== '\\Recent').sort() })) };
  } finally { await fresh.logout(); fresh.close(); }
}
async function cleanSubject(t, direct, path, subject) {
  const fresh = await cleanupConnection(t, direct);
  try {
    await fresh.mailboxOpen(path);
    const uids = await fresh.search({ subject }, { uid: true });
    if (uids.length) assert.ok(await fresh.messageDelete(uids.join(','), { uid: true }));
  } finally {
    try { await fresh.logout(); } finally { fresh.close(); }
  }
}
function subjects(rows) { return rows.map(row => row.subject).sort(); }
function has(row, flag) { return row.flags.includes(flag); }
async function seed(direct, path, token, n, flags = []) {
  const uids = [];
  for (let index = 0; index < n; index++) uids.push((await direct.append(path, message(`${token}-${index}`), flags)).uid);
  return uids;
}
function checkReceipt(result, initial) {
  assert.equal(result.initialTotal, initial);
  assert.equal(result.totals.processed + result.totals.skipped + result.totals.failed + result.remainingEstimate, initial);
}

for (const action of ['move', 'trash', 'seen', 'flag']) {
  integration('mail', `select-all HTTP ${action}: 2050 identities, external changes, stop/resume and cursor replay`, async t => {
    const web = await login(t, user), direct = await imap(t, user);
    const source = await scratch(t, web, direct), destination = action === 'trash' ? 'Trash' : action === 'move' ? await scratch(t, web, direct) : undefined;
    const external = await scratch(t, web, direct), token = unique();
    if (action === 'trash') cleanup(t, () => cleanSubject(t, direct, destination, token));
    const uids = await seed(direct, source, token, count);
    const excluded = (await direct.append(source, message(`${token}-outside`), ['\\Seen'])).uid;
    const baseline = await snapshot(t, source, token);
    assert.deepEqual(baseline.rows.map(row => row.uid).sort((a, b) => a - b), [...uids, excluded].sort((a, b) => a - b));
    const scope = { view: 'folder', folder: source, quick: 'unread' };
    const target = action === 'move' ? destination : undefined;
    const selection = await prepare(t, web, scope, action, target);
    assert.equal(selection.initialTotal, count);
    const late = (await direct.append(source, message(`${token}-late`))).uid;
    const body = { scope, action, ...(target ? { target } : {}), cursor: selection.cursor };
    let result = await timed(t, 'HTTP execute', () => web.request('POST', '/api/messages/actions/scope', body));
    const first = structuredClone(result);
    checkReceipt(result, count);
    assert.equal(result.state, 'running');
    assert.ok(result.totals.processed > 0 && result.totals.processed <= 1000);
    // Stop means no further request; IMAP observation confirms no autonomous worker.
    await new Promise(resolve => setTimeout(resolve, 300));
    const stopped = await snapshot(t, source, token);
    assert.equal(stopped.rows.length, ['move', 'trash'].includes(action) ? count + 2 - first.totals.processed : count + 2);
    await direct.mailboxOpen(source);
    await direct.messageMove(uids[1500], external, { uid: true });
    await direct.messageDelete(uids[1501], { uid: true });
    await direct.messageFlagsAdd(uids[1502], ['\\Seen'], { uid: true });
    await direct.messageFlagsAdd(uids[1503], ['\\Flagged'], { uid: true });
    const arrival = (await direct.append(source, message(`${token}-arrival`))).uid;
    while (result.nextCursor) {
      result = await timed(t, 'HTTP execute/resume', () => web.request('POST', '/api/messages/actions/scope', { ...body, cursor: result.nextCursor }));
      checkReceipt(result, count);
    }
    assert.equal(result.state, 'completed');
    assert.deepEqual(result.totals, { processed: count - 3, skipped: 3, failed: 0 });
    const replay = await timed(t, 'HTTP replay first cursor', () => web.request('POST', '/api/messages/actions/scope', body));
    assert.deepEqual(replay, first);
    const sourceResult = await snapshot(t, source, token);
    assert.equal(sourceResult.validity, baseline.validity);
    for (const uid of [late, arrival]) assert.deepEqual(sourceResult.rows.find(row => row.uid === uid)?.flags, [], 'post-fence arrival unchanged');
    assert.deepEqual(sourceResult.rows.find(row => row.uid === excluded)?.flags, ['\\Seen'], 'condition-outside sentinel unchanged');
    const expected = Array.from({ length: count }, (_, index) => `${token}-${index}`).filter((_, index) => ![1500, 1501, 1502].includes(index));
    if (['move', 'trash'].includes(action)) {
      const moved = await snapshot(t, destination, token);
      assert.deepEqual(subjects(moved.rows), expected.sort(), 'exact destination identities: omission=0, duplicate=0');
      assert.equal(new Set(moved.rows.map(row => row.uid)).size, count - 3);
      assert.equal(sourceResult.rows.filter(row => !['outside', 'late', 'arrival', '1502'].some(suffix => row.subject === `${token}-${suffix}`)).length, 0);
    } else {
      const affected = sourceResult.rows.filter(row => expected.includes(row.subject));
      t.diagnostic(JSON.stringify({ action, path: source, actualCandidates: affected.length, expectedFlagged: count - 3,
        actualSystemFlagged: affected.filter(row => has(row, action === 'seen' ? '\\Seen' : '\\Flagged')).length,
        sample: affected.slice(0, 2) }));
      assert.equal(affected.length, count - 3);
      assert.ok(affected.every(row => has(row, action === 'seen' ? '\\Seen' : '\\Flagged')));
      assert.ok(affected.every(row => row.uid === uids[Number(row.subject.slice(token.length + 1))]), 'source UID identities preserved');
      assert.deepEqual(subjects(sourceResult.rows.filter(row => row.uid <= uids.at(-1))), Array.from({ length: count }, (_, i) => `${token}-${i}`).filter((_, i) => ![1500, 1501].includes(i)).sort());
    }
    assert.deepEqual(subjects((await snapshot(t, external, token)).rows), [`${token}-1500`]);
    const failed = await timed(t, 'HTTP failures', () => web.get(`/api/messages/selections/${selection.selectionId}/failed`));
    assert.equal(failed.total, 0);
    t.diagnostic(JSON.stringify({ action, expected: count, sourceValidity: baseline.validity, uidFirst: uids[0], uidLast: uids.at(-1), ...result.totals, omissions: 0, duplicates: 0, sentinelsChanged: 0, folders: [source, ...(action === 'move' ? [destination] : []), external], destinationCleanupSubject: action === 'trash' ? token : null }));
  });
}

integration('mail', 'select-all HTTP delete-forever: Trash 2050 identities and arrival/condition sentinels', async t => {
  const web = await login(t, user), direct = await imap(t, user), token = unique();
  cleanup(t, () => cleanSubject(t, direct, 'Trash', token));
  await seed(direct, 'Trash', token, count);
  await direct.append('Trash', message(`${token}-outside`), ['\\Seen']);
  const scope = { view: 'folder', folder: 'Trash', quick: 'unread', q: `subject:${token}` };
  const selection = await prepare(t, web, scope, 'delete-forever');
  assert.equal(selection.initialTotal, count);
  await direct.append('Trash', message(`${token}-late`));
  let cursor = selection.cursor, result;
  while (cursor) {
    result = await timed(t, 'HTTP delete-forever', () => web.request('POST', '/api/messages/actions/scope', { scope, action: 'delete-forever', cursor }));
    checkReceipt(result, count); cursor = result.nextCursor;
  }
  assert.deepEqual(result.totals, { processed: count, skipped: 0, failed: 0 });
  const left = (await snapshot(t, 'Trash', token)).rows;
  t.diagnostic(JSON.stringify({ action: 'delete-forever', expectedRemaining: 2, actualRemaining: left.length,
    sample: left.slice(0, 2), cleanup: { folder: 'Trash', subject: token } }));
  assert.deepEqual(subjects(left), [`${token}-late`, `${token}-outside`]);
  assert.deepEqual(left.find(row => row.subject.endsWith('-late')).flags, []);
  assert.deepEqual(left.find(row => row.subject.endsWith('-outside')).flags, ['\\Seen']);
  t.diagnostic(JSON.stringify({ action: 'delete-forever', cleanup: { folder: 'Trash', subject: token }, ...result.totals, sentinelsChanged: 0 }));
});

integration('mail', 'select-all HTTP multi-folder search: original identity/flag sets and failure-only retry', async t => {
  const web = await login(t, user), direct = await imap(t, user), token = unique();
  const paths = [await scratch(t, web, direct), await scratch(t, web, direct)];
  for (const path of paths) {
    await seed(direct, path, token, 155, ['\\Flagged']);
    await direct.append(path, message(`${token}-outside`));
  }
  const scope = { view: 'allmail', quick: 'starred', q: `subject:${token}` };
  const selection = await prepare(t, web, scope, 'seen');
  assert.equal(selection.initialTotal, 310);
  for (const path of paths) await direct.append(path, message(`${token}-late`), ['\\Flagged']);
  let cursor = selection.cursor, result;
  while (cursor) {
    result = await timed(t, 'HTTP multi-folder seen', () => web.request('POST', '/api/messages/actions/scope', { scope, action: 'seen', cursor }));
    checkReceipt(result, 310); cursor = result.nextCursor;
  }
  assert.deepEqual(result.totals, { processed: 310, skipped: 0, failed: 0 });
  for (const path of paths) {
    const rows = (await snapshot(t, path, token)).rows;
    t.diagnostic(JSON.stringify({ action: 'multi-folder seen', path, expectedSeen: 155,
      actualSeen: rows.filter(row => has(row, '\\Seen') && has(row, '\\Flagged')).length, sample: rows.slice(0, 2) }));
    assert.equal(rows.filter(row => has(row, '\\Seen') && has(row, '\\Flagged')).length, 155);
    assert.deepEqual(rows.find(row => row.subject.endsWith('-outside')).flags, []);
    assert.deepEqual(rows.find(row => row.subject.endsWith('-late')).flags, ['\\Flagged']);
  }
  const failures = await web.get(`/api/messages/selections/${selection.selectionId}/failed`);
  assert.equal(failures.total, 0);
  const retry = await prepare(t, web, scope, 'seen', undefined, { retry: 'failed', selectionId: selection.selectionId });
  assert.equal(retry.initialTotal, 0, 'failed-only retry does not reselect successful matching messages');
  const empty = await web.request('POST', '/api/messages/actions/scope', { scope, action: 'seen', cursor: retry.cursor });
  assert.deepEqual(empty.totals, { processed: 0, skipped: 0, failed: 0 });
  t.diagnostic(JSON.stringify({ mode: 'HTTP multi-folder', paths, expected: 310, ...result.totals, sentinelsChanged: 0 }));
});

async function realService(t, wrap) {
  const pool = createImapPool({ config: { ...tlsConfig(), imapPort: 993 }, destroySession: async () => {}, logger: { warn() {} } });
  const verified = await pool.verifyLogin({ email: email(user), password: Buffer.from(password()), ip: '127.0.0.1' });
  const session = { email: email(user), connection: verified.connection, scanAbort: new AbortController() };
  cleanup(t, async () => { session.scanAbort.abort(); await verified.connection.logout(); });
  const adapter = { withMailbox: (s, path, fn, options) => pool.withMailbox(s, path, client => wrap(client, path, fn), options) };
  return { service: createScopedActionService({ imap: adapter }), session };
}

integration('mail', 'select-all service + real IMAP: one pre-mutation failure, failed-only retry', async t => {
  const web = await login(t, user), direct = await imap(t, user), token = unique();
  const path = await scratch(t, web, direct);
  await seed(direct, path, token, 101);
  let inject = false, injected = 0;
  const { service, session } = await realService(t, async (client, selected, fn) => {
    if (inject && selected === path && injected++ === 0) throw new Error('Synthetic connection failure before mutation');
    return fn(client);
  });
  const scope = { view: 'folder', folder: path }, action = 'flag';
  const ready = await service.prepare(session, { selectionKey: unique(), scope, action });
  assert.equal(ready.phase, 'ready'); inject = true;
  const result = await timed(t, 'service execute injected failure', () => service.execute(session, { scope, action, cursor: ready.cursor }));
  assert.deepEqual(result.totals, { processed: 51, skipped: 0, failed: 50 });
  const failed = await service.failures(session, ready.selectionId, { pageSize: '50' });
  assert.equal(failed.total, 50);
  assert.ok(failed.items.every(row => row.retryable && row.code === 'MAIL_UNAVAILABLE'));
  const retry = await service.prepare(session, { selectionKey: unique(), scope, action, selectionId: ready.selectionId, retry: 'failed' });
  assert.equal(retry.initialTotal, 50);
  const retried = await timed(t, 'service retry failed only', () => service.execute(session, { scope, action, cursor: retry.cursor }));
  assert.deepEqual(retried.totals, { processed: 50, skipped: 0, failed: 0 });
  const rows = (await snapshot(t, path, token)).rows;
  t.diagnostic(JSON.stringify({ mode: 'service + real IMAP injected', path, initial: result.totals, retry: retried.totals,
    actualSystemFlagged: rows.filter(row => has(row, '\\Flagged')).length, sample: rows.slice(0, 2) }));
  assert.equal(rows.length, 101); assert.ok(rows.every(row => has(row, '\\Flagged')));
  t.diagnostic(JSON.stringify({ mode: 'service + real IMAP injected', path, initial: result.totals, retry: retried.totals }));
});

integration('mail', 'select-all service + real IMAP: source recreation during virtual mapping, reused UID changes zero', async t => {
  const web = await login(t, user), direct = await imap(t, user), token = unique();
  const path = await scratch(t, web, direct);
  const original = await direct.append(path, message(token));
  await direct.mailboxOpen(path);
  const validity = Number(direct.mailbox.uidValidity);
  let injected = false, replacement;
  const { service, session } = await realService(t, async (client, selected, fn) => {
    const exec = client.exec;
    client.exec = async function (name, attrs, options) {
      if (!injected && selected === 'WebmailVirtual/AllMail' && name === 'UID FETCH' && attrs?.[1]?.some(item => item.value === 'X-MAILBOX')) {
        injected = true;
        await direct.mailboxClose(); await direct.mailboxDelete(path); await direct.mailboxCreate(path);
        replacement = await direct.append(path, message(`${token}-replacement`));
        assert.equal(replacement.uid, original.uid, 'same source UID reused');
      }
      return exec.call(this, name, attrs, options);
    };
    try { return await fn(client); } finally { client.exec = exec; }
  });
  const scope = { view: 'allmail', q: `subject:${token}` };
  let rejected;
  try { await timed(t, 'service prepare source replacement race', () => service.prepare(session, { selectionKey: unique(), scope, action: 'flag' })); }
  catch (error) { rejected = error; }
  assert.equal(injected, true);
  const result = await snapshot(t, path, token);
  assert.notEqual(result.validity, validity);
  assert.deepEqual(result.rows, [{ uid: replacement.uid, subject: `${token}-replacement`, flags: [] }]);
  t.diagnostic(JSON.stringify({ mode: 'service + real IMAP race', path, originalValidity: validity, replacementValidity: result.validity, uid: replacement.uid, code: rejected?.code, expectedCode: 'STALE_SCOPE', replacementChanges: 0 }));
  assert.equal(rejected?.code, 'STALE_SCOPE');
});
