import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { createActionService } from '../../server/mail/actions.js';
import { AppError } from '../../server/errors.js';
import { decodeRef, assertUidValidity } from '../../server/mail/ref.js';

const rule = (actions = { move: 'Projects' }) => ({ id: 'rule0001', enabled: false, match: 'all', conditions: [{ field: 'subject', op: 'has', value: '회의' }], actions, stop: true });
function message(uid, date = new Date(Date.UTC(2026, 9, 1) + uid * 1000)) {
  return { uid, internalDate: date, headers: Buffer.from(`Subject: =?UTF-8?B?${Buffer.from('회의').toString('base64')}?=\r\nFrom: sender@example.com\r\n`),
    envelope: { subject: '회의', from: [{ address: 'sender@example.com' }], to: [{ address: 'user@example.com' }] }, flags: new Set(), size: 100 };
}
async function fixture(t, count = 2, mailActions) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-w13b-'));
  const app = await createApp({ config: { publicHostnames: ['newmail.example.com'], trustProxy: [], sessionIdleMin: 480, sessionMaxHours: 24,
    dbHost: '127.0.0.1', dbName: 'mailcow', dbUser: 'webmail_ro', dbPassword: 'synthetic', internalDomains: [] }, logger: false,
    staticDir: '/nonexistent-webmail-w13b', auth: { tempRoot }, rules: { now: () => Date.UTC(2026, 9, 15), ...(mailActions ? { mailActions } : {}) } });
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
      for (const row of client.rows) if (uids.has(row.uid)) yield query.headers ? row : { uid: row.uid, internalDate: row.internalDate };
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
  return { app, client, commands, request, headers };
}
function ok(response) { assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers['cache-control'], 'no-store'); return response.json(); }
function rejected(response, status, code) { assert.equal(response.statusCode, status, response.body); assert.equal(response.json().error.code, code); assert.equal(response.headers['www-authenticate'], undefined); }

test('rules preview returns newest 20 of all matches, ignores enabled/stop and caches headers', async t => {
  const f = await fixture(t, 25), first = ok(await f.request('preview'));
  assert.deepEqual(Object.keys(first), ['count', 'items', 'scanned', 'limited']);
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

test('rules apply-existing refreshes a preview snapshot before choosing targets', async t => {
  const f = await fixture(t);
  assert.equal(ok(await f.request('preview')).count, 2);
  f.client.rows = [message(3)];
  const result = ok(await f.request('apply-existing'));
  assert.equal(result.matched, 1); assert.equal(result.moved, 1); assert.deepEqual(result.failed, []);
  assert.deepEqual(f.commands.filter(row => row[0] === 'MOVE'), [['MOVE', '3', 'Projects']]);
});

test('rules apply-existing ignores external forwarding but validates all addresses and other actions', async t => {
  const f = await fixture(t);
  assert.deepEqual(ok(await f.request('apply-existing', rule({ forward: ['outside@example.net'] }))), { matched: 2, moved: 0, trashed: 0, flagged: 0, failed: [] });
  assert.equal(ok(await f.request('apply-existing', rule({ forward: ['outside@example.net'], read: true }))).flagged, 2);
  assert.ok(f.commands.every(row => ['UID SORT', 'MYRIGHTS', 'FETCH', 'STORE'].includes(row[0])));
  rejected(await f.request('preview', rule({ forward: ['outside@example.net'] })), 422, 'FORWARD_EXTERNAL');
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
  assert.deepEqual(counts, { MYRIGHTS: 12, FETCH: 9, STORE: 6, MOVE: 3 });
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
