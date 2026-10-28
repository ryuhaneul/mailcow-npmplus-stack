import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { createActionService } from '../../server/mail/actions.js';
import { loadInboxHeaders } from '../../server/sieve/match.js';
import { AppError } from '../../server/errors.js';
import { generateScript } from '../../server/sieve/generate.js';
import { decodeRef, assertUidValidity } from '../../server/mail/ref.js';

const rule = (actions = { move: 'Projects' }) => ({ id: 'rule0001', enabled: false, match: 'all', conditions: [{ field: 'subject', op: 'has', value: '회의' }], actions, stop: true });
function message(uid, date = new Date(Date.UTC(2026, 9, 1) + uid * 1000)) {
  return { uid, internalDate: date, headers: Buffer.from(`Subject: =?UTF-8?B?${Buffer.from('회의').toString('base64')}?=\r\nFrom: sender@example.com\r\n`),
    envelope: { subject: '회의', from: [{ address: 'sender@example.com' }], to: [{ address: 'user@example.com' }] }, flags: new Set(), size: 100 };
}
async function fixture(t, count = 2, mailActions) {
  const doc = { v: 1, rev: 0, rules: [rule()], blocked: [], vacation: { enabled: false, start: null, end: null, subject: '', body: '' } };
  const scripts = new Map([['webmail-rules', generateScript(doc, { checkPolicy: false })]]);
  const connect = async () => ({
    listScripts: async () => [...scripts.keys()].map(name => ({ name, active: name === 'webmail-rules' })),
    getScript: async name => scripts.get(name),
    putScript: async (name, bytes) => scripts.set(name, bytes), checkScript: async () => {}, setActive: async () => {}, logout: async () => {}, close() {},
  });
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-w13b-'));
  const app = await createApp({ config: { publicHostnames: ['newmail.example.com'], trustProxy: [], sessionIdleMin: 480, sessionMaxHours: 24,
    dbHost: '127.0.0.1', dbName: 'mailcow', dbUser: 'webmail_ro', dbPassword: 'synthetic', internalDomains: [] }, logger: false,
    staticDir: '/nonexistent-webmail-w13b', auth: { tempRoot }, rules: { connect, now: () => Date.UTC(2026, 9, 15), ...(mailActions ? { mailActions } : {}) } });
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  app.directory.internalDomains = async () => ['example.com'];
  app.directory.identities = async () => ({ identities: [{ address: 'user@example.com' }] });
  const commands = [], rows = Array.from({ length: count }, (_, i) => message(i + 1));
  const client = { rows, enabled: new Set(), capabilities: new Map(), mailbox: { path: 'INBOX', uidValidity: 123n },
    list: async () => ['INBOX', 'Trash', 'Junk', 'Drafts', 'Projects', 'Shared/Team'].map(path => ({ path, flags: new Set() })),
    async exec(command, args, options) {
      commands.push([command]);
      if (command === 'MYRIGHTS') options.untagged.MYRIGHTS({ attributes: [args[0], { value: 'lrswipkxte' }] });
      else { assert.equal(command, 'UID SORT'); options.untagged.SORT({ attributes: [...client.rows].reverse().map(row => ({ value: String(row.uid) })) }); }
      return { next() {} };
    },
    async *fetch(range, query, options) {
      assert.equal(options.uid, true);
      if (!query.headers && !query.internalDate) commands.push(['FETCH', range]);
      const uids = new Set(range.split(',').map(Number));
      for (const row of client.rows) if (uids.has(row.uid)) {
        yield query.headers ? row : { uid: row.uid, internalDate: row.internalDate };
        if (query.headers) await client.afterHeader?.();
      }
    },
    async messageFlagsAdd(range, flags, options) {
      assert.equal(options.uid, true); commands.push(['STORE', range, ...flags]);
      const uids = range.split(',').map(Number);
      if (uids.includes(client.failFlag)) throw new AppError(502, 'MAIL_REJECTED', '합성 실패');
      for (const row of client.rows) if (uids.includes(row.uid)) for (const flag of flags) row.flags.add(flag);
      return true;
    },
    async messageMove(range, target, options) {
      assert.equal(options.uid, true); commands.push(['MOVE', range, target]);
      const uids = new Set(range.split(',').map(Number));
      if (uids.has(client.failMove)) throw new AppError(502, 'MAIL_REJECTED', '합성 실패');
      client.rows = client.rows.filter(row => !uids.has(row.uid)); return true;
    },
  };
  app.imap.withMailbox = async (_session, path, operation) => { assert.equal(path, 'INBOX'); return operation(client); };
  app.imap.withRef = async (_session, token, operation) => { const ref = decodeRef(token); assertUidValidity(client, ref); return operation(client, ref); };
  const created = app.sessions.create({ email: 'user@example.com', name: '합성 사용자', password: Buffer.from('synthetic'), connection: { logout: async () => {} }, ip: '198.51.100.9' });
  const headers = { cookie: `webmail_sid=${created.token}`, origin: 'https://newmail.example.com', 'x-webmail-csrf': created.session.csrf };
  const request = (action, value = rule(), customHeaders = headers) => app.inject({ method: 'POST', url: `/api/rules/${action}`, payload: { rule: value }, headers: customHeaders });
  return { app, client, commands, request, headers, doc, scripts, session: created.session };
}
function ok(response) { assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers['cache-control'], 'no-store'); return response.json(); }
function rejected(response, status, code) { assert.equal(response.statusCode, status, response.body); assert.equal(response.json().error.code, code); assert.equal(response.headers['www-authenticate'], undefined); }

test('rules preview returns newest 20 of all matches, ignores enabled/stop and caches headers', async t => {
  const f = await fixture(t, 25), first = ok(await f.request('preview'));
  assert.deepEqual(Object.keys(first), ['count', 'items', 'scanned', 'limited', 'partial']);
  assert.equal(first.count, 25); assert.equal(first.scanned, 25); assert.equal(first.limited, false); assert.equal(first.items.length, 20);
  assert.deepEqual(first.items.map(row => decodeRef(row.ref).uid), Array.from({ length: 20 }, (_, i) => 25 - i));
  const other = rule(); other.conditions[0].value = '없는 제목';
  assert.equal(ok(await f.request('preview', other)).count, 0);
  assert.equal(f.commands.filter(row => row[0] === 'UID SORT').length, 1);
  assert.equal(f.commands.some(row => ['STORE', 'MOVE'].includes(row[0])), false);
  assert.equal(ok(await f.request('apply-existing')).matched, first.count);
});

for (const [name, actions, expected] of [
  ['move', { move: 'Projects' }, { moved: 2, trashed: 0, flagged: 0 }],
  ['trash', { trash: true }, { moved: 0, trashed: 2, flagged: 0 }],
  ['read', { read: true }, { moved: 0, trashed: 0, flagged: 2 }],
  ['star', { star: true }, { moved: 0, trashed: 0, flagged: 2 }],
  ['read+star+move', { read: true, star: true, move: 'Projects' }, { moved: 2, trashed: 0, flagged: 2 }],
]) test(`rules apply-existing ${name} reuses UID flag/move actions`, async t => {
  const f = await fixture(t);
  assert.deepEqual(ok(await f.request('apply-existing', rule(actions))), { matched: 2, ...expected, failed: [] });
  const mutations = f.commands.filter(row => ['STORE', 'MOVE'].includes(row[0])).flatMap(([command, range, ...args]) => range.split(',').map(uid => [command, Number(uid), ...args]));
  for (const uid of [1, 2]) {
    const expectedCommands = [];
    if (actions.read) expectedCommands.push(['STORE', uid, '\\Seen']);
    if (actions.star) expectedCommands.push(['STORE', uid, '\\Flagged']);
    if (actions.move || actions.trash) expectedCommands.push(['MOVE', uid, actions.move ?? 'Trash']);
    assert.deepEqual(mutations.filter(row => row[1] === uid), expectedCommands);
  }
});

test('rules apply-existing reloads Inbox so repeat adds zero moves and later preview is fresh', async t => {
  const f = await fixture(t);
  ok(await f.request('preview'));
  assert.equal(ok(await f.request('apply-existing')).moved, 2);
  assert.deepEqual(ok(await f.request('apply-existing')), { matched: 0, moved: 0, trashed: 0, flagged: 0, failed: [] });
  assert.equal(ok(await f.request('preview')).count, 0);
  assert.equal(f.commands.filter(row => row[0] === 'MOVE').length, 1);
});

test('rules apply-existing excludes vanished snapshot UIDs and leaves newly arrived mail for the next preview', async t => {
  const f = await fixture(t);
  assert.equal(ok(await f.request('preview')).count, 2);
  f.client.rows = [message(3)];
  const result = ok(await f.request('apply-existing'));
  assert.equal(result.matched, 0); assert.equal(result.moved, 0); assert.deepEqual(result.failed, []);
  assert.deepEqual(f.commands.filter(row => row[0] === 'MOVE'), []);
  assert.equal(ok(await f.request('preview')).count, 1);
});

test('rules apply-existing ignores external forwarding but validates all addresses and other actions', async t => {
  const f = await fixture(t);
  assert.deepEqual(ok(await f.request('apply-existing', rule({ forward: ['outside@example.net'] }))), { matched: 2, moved: 0, trashed: 0, flagged: 0, failed: [] });
  assert.equal(ok(await f.request('apply-existing', rule({ forward: ['outside@example.net'], read: true }))).flagged, 2);
  assert.ok(f.commands.every(row => ['UID SORT', 'MYRIGHTS', 'FETCH', 'STORE'].includes(row[0])));
  assert.equal(ok(await f.request('preview', rule({ forward: ['outside@example.net'] }))).count, 2);
  rejected(await f.request('apply-existing', rule({ forward: ['outside@example.net', 'malformed'] })), 422, 'RULES_INVALID');
  rejected(await f.request('apply-existing', rule({ forward: ['outside@example.net'], move: 'Missing' })), 422, 'RULES_INVALID');
});

test('rules apply-existing reports a per-message move failure and continues', async t => {
  let f;
  f = await fixture(t, 3, { async run(session, body) {
    const failed = body.refs.filter(ref => decodeRef(ref).uid === 2);
    const outcome = await createActionService({ imap: f.app.imap }).run(session, { ...body, refs: body.refs.filter(ref => !failed.includes(ref)) });
    return { done: outcome.done, failed: failed.map(ref => ({ ref, code: 'MAIL_REJECTED' })) };
  } });
  const result = ok(await f.request('apply-existing'));
  assert.equal(result.matched, 3); assert.equal(result.moved, 2); assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].code, 'MAIL_REJECTED'); assert.equal(decodeRef(result.failed[0].ref).uid, 2);
  assert.deepEqual(f.client.rows.map(row => row.uid), [2]);
});

test('rules apply-existing skips remaining actions on a flag failure', async t => {
  let f;
  f = await fixture(t, 2, { async run(session, body) {
    const failed = body.action === 'seen' ? body.refs.filter(ref => decodeRef(ref).uid === 1) : [];
    const outcome = await createActionService({ imap: f.app.imap }).run(session, { ...body, refs: body.refs.filter(ref => !failed.includes(ref)) });
    return { done: outcome.done, failed: failed.map(ref => ({ ref, code: 'MAIL_REJECTED' })) };
  } });
  const result = ok(await f.request('apply-existing', rule({ read: true, star: true, move: 'Projects' })));
  assert.equal(result.matched, 2); assert.equal(result.flagged, 1); assert.equal(result.moved, 1); assert.equal(result.failed.length, 1);
  assert.equal(f.commands.some(row => ['STORE', 'MOVE'].includes(row[0]) && row[1].split(',').includes('1')), false);
});

test('rules preview reloads cached headers when UIDVALIDITY changes', async t => {
  const f = await fixture(t);
  ok(await f.request('preview')); f.client.mailbox.uidValidity = 124n; f.client.rows.push(message(3));
  const result = ok(await f.request('preview'));
  assert.equal(result.count, 3); assert.equal(decodeRef(result.items[0].ref).uidValidity, 124);
});

for (const endpoint of ['preview', 'apply-existing']) test(`rules ${endpoint} validates rule and enforces session/CSRF before IMAP`, async t => {
  const f = await fixture(t);
  rejected(await f.request(endpoint, null), 422, 'RULES_INVALID');
  rejected(await f.request(endpoint, rule({ move: 'Shared/Team' })), 422, 'RULES_INVALID');
  rejected(await f.request(endpoint, rule(), {}), 403, 'NO_SESSION');
  const { 'x-webmail-csrf': _csrf, ...headers } = f.headers;
  rejected(await f.request(endpoint, rule(), headers), 403, 'CSRF');
  assert.equal(f.commands.length, 0);
});

test('rules apply-existing: 2500 matches use three runs per action and bounded UID commands', async t => {
  const runs = []; let f;
  f = await fixture(t, 2500, { async run(session, body) {
    runs.push(body); return createActionService({ imap: f.app.imap }).run(session, body);
  } });
  const result = ok(await f.request('apply-existing', rule({ read: true, star: true, move: 'Projects' })));
  assert.deepEqual(result, { matched: 2500, moved: 2500, trashed: 0, flagged: 2500, failed: [] });
  assert.deepEqual(runs.map(body => [body.action, body.refs.length]), ['seen', 'flag', 'move'].flatMap(action => [1000, 1000, 500].map(count => [action, count])));
  const counts = Object.fromEntries(['MYRIGHTS', 'FETCH', 'STORE', 'MOVE'].map(command => [command, f.commands.filter(row => row[0] === command).length]));
  assert.deepEqual(counts, { MYRIGHTS: 12, FETCH: 12, STORE: 6, MOVE: 3 });
  assert.ok(f.commands.filter(row => ['FETCH', 'STORE', 'MOVE'].includes(row[0])).every(row => row[1].split(',').length <= 1000));
  const moves = counts.MOVE;
  assert.equal(ok(await f.request('apply-existing', rule({ read: true, star: true, move: 'Projects' }))).moved, 0);
  assert.equal(f.commands.filter(row => row[0] === 'MOVE').length, moves);
});

test('rules apply-existing: three read failures are excluded from later star and move batches', async t => {
  const runs = [], bad = new Set([1, 1001, 2001]); let f;
  f = await fixture(t, 2500, { async run(session, body) {
    runs.push(body);
    const failed = body.action === 'seen' ? body.refs.filter(ref => bad.has(decodeRef(ref).uid)) : [];
    const outcome = await createActionService({ imap: f.app.imap }).run(session, { ...body, refs: body.refs.filter(ref => !failed.includes(ref)) });
    return { done: outcome.done, failed: failed.map(ref => ({ ref, code: 'MAIL_REJECTED' })) };
  } });
  const result = ok(await f.request('apply-existing', rule({ read: true, star: true, move: 'Projects' })));
  assert.equal(result.matched, 2500); assert.equal(result.flagged, 2497); assert.equal(result.moved, 2497);
  assert.deepEqual(new Set(result.failed.map(row => decodeRef(row.ref).uid)), bad);
  for (const action of ['flag', 'move']) {
    const batches = runs.filter(body => body.action === action);
    assert.deepEqual(batches.map(body => body.refs.length), [1000, 1000, 497]);
    assert.ok(batches.every(body => body.refs.every(ref => !bad.has(decodeRef(ref).uid))));
  }
  assert.deepEqual(new Set(f.client.rows.map(row => row.uid)), bad);
});

test('rules apply-existing: a thrown run fails its whole batch and later batches continue', async t => {
  const runs = []; let f;
  f = await fixture(t, 2500, { async run(session, body) {
    runs.push(body);
    if (runs.length === 1) throw new Error('synthetic disconnect');
    return createActionService({ imap: f.app.imap }).run(session, body);
  } });
  const result = ok(await f.request('apply-existing', rule({ read: true, move: 'Projects' })));
  assert.equal(result.matched, 2500); assert.equal(result.flagged, 1500); assert.equal(result.moved, 1500);
  assert.deepEqual(result.failed, runs[0].refs.map(ref => ({ ref, code: 'MAIL_UNAVAILABLE' })));
  assert.deepEqual(runs.filter(body => body.action === 'move').map(body => body.refs.length), [1000, 500]);
  assert.equal(f.client.rows.length, 1000);
});

test('rules apply-existing: session failure is rethrown rather than converted into batch failures', async t => {
  const f = await fixture(t, 2, { async run() { throw new AppError(403, 'SESSION_EXPIRED', '합성 만료'); } });
  rejected(await f.request('apply-existing', rule({ read: true })), 403, 'SESSION_EXPIRED');
  assert.equal(f.commands.some(row => ['STORE', 'MOVE'].includes(row[0])), false);
});


test('rules slow preview returns within 4s, shares one producer, polls complete and refuses early apply', async t => {
  const f = await fixture(t, 2);
  const gate = Promise.withResolvers();
  let headers = 0;
  f.client.afterHeader = async () => { if (++headers === 1) await gate.promise; };
  const started = performance.now();
  const first = ok(await f.request('preview'));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 4000, `first partial ${elapsed}ms`);
  assert.equal(first.partial, true); assert.equal(first.scanned, 1); assert.equal(first.count, 1);
  assert.equal(ok(await f.request('preview')).scanned, 1);
  const changed = rule(); changed.conditions[0].value = '없는 제목';
  const recalc = performance.now();
  assert.equal(ok(await f.request('preview', changed)).count, 0);
  assert.ok(performance.now() - recalc < 200);
  rejected(await f.request('apply-existing'), 409, 'PREVIEW_NOT_READY');
  assert.equal(f.commands.filter(row => row[0] === 'UID SORT').length, 1);
  assert.equal(f.commands.some(row => ['STORE', 'MOVE'].includes(row[0])), false);
  gate.resolve();
  await loadInboxHeaders(f.app.imap, f.session, { now: () => Date.UTC(2026, 9, 15) });
  const complete = ok(await f.request('preview'));
  assert.equal(complete.partial, false); assert.equal(complete.count, 2); assert.equal(complete.scanned, 2);
  assert.equal(ok(await f.request('apply-existing')).moved, 2);
  t.diagnostic(`first partial ${Math.round(elapsed)}ms; one SORT; final count ${complete.count}`);
});

test('rules scan logout immediately cancels the producer and clears cached headers', async t => {
  const f = await fixture(t, 2);
  const gate = Promise.withResolvers();
  const began = Promise.withResolvers();
  let closed = 0;
  f.client.close = () => { closed++; gate.resolve(); };
  f.client.afterHeader = async () => { began.resolve(); await gate.promise; };
  const loading = loadInboxHeaders(f.app.imap, f.session, { now: () => Date.UTC(2026, 9, 15) });
  const rejectedLoading = assert.rejects(loading, { code: 'SESSION_EXPIRED' });
  await began.promise;
  const partial = await loadInboxHeaders(f.app.imap, f.session, { budgetMs: 0 });
  assert.equal(partial.scanned, 1);
  const started = performance.now();
  const logout = await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: f.headers });
  assert.equal(logout.statusCode, 204);
  assert.ok(performance.now() - started < 200);
  assert.equal(closed, 1); assert.equal(partial.items.length, 0); assert.equal(partial.scanned, 0);
  await rejectedLoading;
  rejected(await f.request('preview'), 403, 'SESSION_EXPIRED');
});


for (const enabled of [true, false]) test(`existing mail respects earlier enabled=${enabled} rule priority`, async t => {
  const f = await fixture(t);
  const earlier = { ...rule({ star: true }), id: 'early001', enabled, conditions: [{ field: 'from', op: 'has', value: 'sender@example.com' }] };
  f.doc.rules.unshift(earlier);
  f.scripts.set('webmail-rules', generateScript(f.doc, { checkPolicy: false }));
  f.client.rows[1].headers = Buffer.from('Subject: 회의\r\nFrom: other@example.com\r\n');
  const result = ok(await f.request('apply-existing', rule({ read: true, move: 'Projects' })));
  assert.equal(result.matched, 2);
  assert.equal(result.moved, enabled ? 1 : 2);
  assert.equal(result.flagged, enabled ? 1 : 2);
  assert.equal(result.skipped, enabled ? 1 : undefined);
  assert.deepEqual(f.client.rows.map(row => row.uid), enabled ? [1] : []);
  assert.equal(f.commands.some(row => row[0] === 'STORE' && row.includes('\\Flagged')), false);
});

for (const state of ['missing_rule', 'damaged', 'none']) test(`existing mail refuses unknown saved priority: ${state}`, async t => {
  const f = await fixture(t);
  if (state === 'missing_rule') { f.doc.rules = []; f.scripts.set('webmail-rules', generateScript(f.doc)); }
  else if (state === 'damaged') f.scripts.set('webmail-rules', 'damaged');
  else f.scripts.clear();
  rejected(await f.request('apply-existing'), 409, state === 'missing_rule' ? 'RULES_CONFLICT' : 'RULES_STATE');
  assert.equal(f.commands.some(row => ['STORE', 'MOVE'].includes(row[0])), false);
});


for (const actions of [{ move: 'Projects' }, { read: true }]) test(`Gate D: changed priority before ${actions.move ? 'MOVE' : 'STORE'} refuses all actions`, async t => {
  const f = await fixture(t);
  const earlier = { ...rule({ star: true }), id: 'early001', enabled: false };
  f.doc.rules.unshift(earlier);
  f.scripts.set('webmail-rules', generateScript(f.doc, { checkPolicy: false }));
  await loadInboxHeaders(f.app.imap, f.session);
  const other = f.app.sessions.create({ email: 'user@example.com', name: '다른 합성 세션', password: Buffer.from('synthetic'), connection: { logout: async () => {} }, ip: '198.51.100.10' });
  const fetch = f.client.fetch.bind(f.client); let changed = false;
  f.client.fetch = async function* (range, query, options) {
    if (!query.headers && !query.internalDate && !changed) {
      changed = true; earlier.enabled = true;
      const response = await f.app.rules.save(other.session, { baseRev: 0, doc: f.doc });
      assert.equal(response.rev, 1);
    }
    yield* fetch(range, query, options);
  };
  rejected(await f.request('apply-existing', rule(actions)), 409, 'RULES_CONFLICT');
  assert.equal(changed, true);
  assert.equal(f.commands.some(row => ['STORE', 'MOVE'].includes(row[0])), false);
  assert.equal(f.client.rows.length, 2);
});


const bodyCondition = (value = 'needle', op = 'has') => ({ field: 'body', op, value });
function storeBodyRules(f, conditions, { match = 'all', earlier = [], actions = { move: 'Projects' } } = {}) {
  const target = { ...rule(actions), enabled: true, match, conditions };
  f.doc.v = 2; f.doc.rules = [...earlier, target];
  f.scripts.set('webmail-rules', generateScript(f.doc, { checkPolicy: false }));
  return target;
}
const noMailMutations = f => assert.equal(f.commands.some(row => ['STORE', 'MOVE'].includes(row[0])), false);

test('body preview is not counted, never starts a scan/search and is not partial', async t => {
  const f = await fixture(t);
  f.client.search = async () => { assert.fail('preview must not search'); };
  const target = storeBodyRules(f, [bodyCondition()]);
  assert.deepEqual(ok(await f.request('preview', target)), { state: 'body_unavailable', partial: false });
  assert.deepEqual(f.commands, []);
});

for (const [name, conditions, match] of [
  ['body has', [bodyCondition()], 'all'],
  ['body not', [bodyCondition('needle', 'not')], 'all'],
  ['OR with matching header', [{ field: 'subject', op: 'has', value: '회의' }, bodyCondition()], 'any'],
  ['nested body', [{ field: 'from', op: 'has', value: 'sender' }, { match: 'any', conditions: [bodyCondition(), { field: 'subject', op: 'has', value: '회의' }] }], 'all'],
]) test(`existing-mail request refuses ${name} before scanning or acting`, async t => {
  const f = await fixture(t);
  const target = storeBodyRules(f, conditions, { match, actions: { read: true, star: true, move: 'Projects' } });
  let searches = 0;
  f.client.search = async () => { searches++; assert.fail('body search must not run'); };
  rejected(await f.request('apply-existing', target), 422, 'RULES_BODY_EXISTING');
  assert.equal(searches, 0); assert.deepEqual(f.commands, []); noMailMutations(f);
  assert.equal(f.client.rows.length, 2);
});

for (const enabled of [true, false]) test(`upper body-only rule enabled=${enabled} is unknown without searching`, async t => {
  const f = await fixture(t, 3);
  const earlier = { ...rule({ star: true }), id: 'body0001', enabled, conditions: [bodyCondition()] };
  const target = storeBodyRules(f, [{ field: 'subject', op: 'has', value: '회의' }], { earlier: [earlier] });
  let searches = 0;
  f.client.search = async () => { searches++; assert.fail('body search must not run'); };
  await loadInboxHeaders(f.app.imap, f.session);
  const result = ok(await f.request('apply-existing', target));
  assert.equal(result.matched, 3); assert.equal(result.skipped ?? 0, enabled ? 3 : 0);
  assert.equal(result.moved, enabled ? 0 : 3); assert.equal(searches, 0);
  if (enabled) noMailMutations(f);
});

for (const match of ['all', 'any']) for (const headerMatches of [false, true]) for (const op of ['has', 'not']) {
  test(`upper ${match} with header=${headerMatches} and body ${op} preserves three-valued priority without searching`, async t => {
    const f = await fixture(t, 3);
    const earlier = { ...rule({ star: true }), id: 'body0001', enabled: true, match,
      conditions: [{ field: 'subject', op: 'has', value: headerMatches ? '회의' : 'absent' }, bodyCondition('needle', op)] };
    const target = storeBodyRules(f, [{ field: 'subject', op: 'has', value: '회의' }], { earlier: [earlier] });
    let searches = 0;
    f.client.search = async () => { searches++; assert.fail('body search must not run'); };
    await loadInboxHeaders(f.app.imap, f.session);
    const result = ok(await f.request('apply-existing', target));
    const skipped = match === 'all' && !headerMatches ? 0 : 3;
    assert.equal(result.skipped ?? 0, skipped); assert.equal(result.moved, 3 - skipped);
    assert.equal(searches, 0); if (skipped) noMailMutations(f);
  });
}
