import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { AppError } from '../../server/errors.js';
import { decodeRef, assertUidValidity } from '../../server/mail/ref.js';

const rule = (actions = { move: 'Projects' }) => ({ id: 'rule0001', enabled: false, match: 'all', conditions: [{ field: 'subject', op: 'has', value: '회의' }], actions, stop: true });
function message(uid, date = new Date(Date.UTC(2026, 9, 1) + uid * 1000)) {
  return { uid, internalDate: date, headers: Buffer.from(`Subject: =?UTF-8?B?${Buffer.from('회의').toString('base64')}?=\r\nFrom: sender@example.com\r\n`),
    envelope: { subject: '회의', from: [{ address: 'sender@example.com' }], to: [{ address: 'user@example.com' }] }, flags: new Set(), size: 100 };
}
async function fixture(t, count = 2) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-w13b-'));
  const app = await createApp({ config: { publicHostnames: ['newmail.example.com'], trustProxy: [], sessionIdleMin: 480, sessionMaxHours: 24,
    dbHost: '127.0.0.1', dbName: 'mailcow', dbUser: 'webmail_ro', dbPassword: 'synthetic', internalDomains: [] }, logger: false,
    staticDir: '/nonexistent-webmail-w13b', auth: { tempRoot }, rules: { now: () => Date.UTC(2026, 9, 15) } });
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
      const uids = new Set(range.split(',').map(Number));
      for (const row of client.rows) if (uids.has(row.uid)) yield query.headers ? row : { uid: row.uid, internalDate: row.internalDate };
    },
    async fetchOne(uid, _query, options) { assert.equal(options.uid, true); return client.rows.find(row => row.uid === uid) || false; },
    async messageFlagsAdd(uid, flags, options) {
      assert.equal(options.uid, true); commands.push(['STORE', uid, ...flags]);
      if (client.failFlag === uid) throw new AppError(502, 'MAIL_REJECTED', '합성 실패');
      for (const flag of flags) client.rows.find(row => row.uid === uid).flags.add(flag);
      return true;
    },
    async messageMove(uid, target, options) {
      assert.equal(options.uid, true); commands.push(['MOVE', uid, target]);
      if (client.failMove === uid) throw new AppError(502, 'MAIL_REJECTED', '합성 실패');
      client.rows = client.rows.filter(row => row.uid !== uid); return true;
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
  const mutations = f.commands.filter(row => ['STORE', 'MOVE'].includes(row[0]));
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
  assert.equal(f.commands.filter(row => row[0] === 'MOVE').length, 2);
});

test('rules apply-existing refreshes a preview snapshot before choosing targets', async t => {
  const f = await fixture(t);
  assert.equal(ok(await f.request('preview')).count, 2);
  f.client.rows = [message(3)];
  const result = ok(await f.request('apply-existing'));
  assert.equal(result.matched, 1); assert.equal(result.moved, 1); assert.deepEqual(result.failed, []);
  assert.deepEqual(f.commands.filter(row => row[0] === 'MOVE'), [['MOVE', 3, 'Projects']]);
});

test('rules apply-existing ignores external forwarding but validates all addresses and other actions', async t => {
  const f = await fixture(t);
  assert.deepEqual(ok(await f.request('apply-existing', rule({ forward: ['outside@example.net'] }))), { matched: 2, moved: 0, trashed: 0, flagged: 0, failed: [] });
  assert.equal(ok(await f.request('apply-existing', rule({ forward: ['outside@example.net'], read: true }))).flagged, 2);
  assert.ok(f.commands.every(row => ['UID SORT', 'MYRIGHTS', 'STORE'].includes(row[0])));
  rejected(await f.request('preview', rule({ forward: ['outside@example.net'] })), 422, 'FORWARD_EXTERNAL');
  rejected(await f.request('apply-existing', rule({ forward: ['outside@example.net', 'malformed'] })), 422, 'RULES_INVALID');
  rejected(await f.request('apply-existing', rule({ forward: ['outside@example.net'], move: 'Missing' })), 422, 'RULES_INVALID');
});

test('rules apply-existing reports a per-message move failure and continues', async t => {
  const f = await fixture(t, 3); f.client.failMove = 2;
  const result = ok(await f.request('apply-existing'));
  assert.equal(result.matched, 3); assert.equal(result.moved, 2); assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].code, 'MAIL_REJECTED'); assert.equal(decodeRef(result.failed[0].ref).uid, 2);
  assert.deepEqual(f.client.rows.map(row => row.uid), [2]);
});

test('rules apply-existing skips remaining actions on a flag failure', async t => {
  const f = await fixture(t); f.client.failFlag = 1;
  const result = ok(await f.request('apply-existing', rule({ read: true, star: true, move: 'Projects' })));
  assert.equal(result.matched, 2); assert.equal(result.flagged, 1); assert.equal(result.moved, 1); assert.equal(result.failed.length, 1);
  assert.deepEqual(f.commands.filter(row => ['STORE', 'MOVE'].includes(row[0]) && row[1] === 1), [['STORE', 1, '\\Seen']]);
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
