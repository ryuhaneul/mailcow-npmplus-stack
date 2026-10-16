import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDirectoryService, directoryQueries } from '../../server/directory/index.js';
import { recentRecipients } from '../../server/directory/recent.js';
import { createApp } from '../../server/app.js';

const session = () => ({ email: 'user@example.com', name: '사용자' });
const tables = () => ({
  mailbox: [{ username: 'user@example.com', name: '사용자', domain: 'example.com', active: 1 }],
  alias: [], alias_domain: [], domain: [{ domain: 'example.com', active: 1 }], sender_acl: [],
});
const alias = (address, goto = 'user@example.com', active = 1, sender_allowed = 1) => ({ address, goto, active, sender_allowed, domain: address.slice(address.lastIndexOf('@') + 1) });
const acl = send_as => ({ logged_in_as: 'user@example.com', send_as });
function fixture(data = tables(), options = {}) {
  const calls = []; let closed = 0;
  const db = { execute: async sql => {
    calls.push(sql);
    const table = Object.keys(directoryQueries).find(table => directoryQueries[table] === sql);
    assert.ok(table, 'only explicitly permitted SELECT statements are used');
    return [structuredClone(data[table])];
  }, end: async () => { closed++; } };
  const service = createDirectoryService({ config: { internalDomains: [] }, db, recentRecipients: async () => [], ...options });
  return { service, db, calls, closed: () => closed };
}
async function permitted(service, from) { await service.assertFrom(session(), from); }
async function denied(service, from) { await assert.rejects(service.assertFrom(session(), from), { statusCode: 403, code: 'FROM_NOT_ALLOWED' }); }

for (const [label, name, expected] of [
  ['trimmed mailbox name', '  데모 1  ', '데모 1'],
  ['empty mailbox name', '', 'user@example.com'],
  ['whitespace mailbox name', '  \t ', 'user@example.com'],
  ['null mailbox name', null, 'user@example.com'],
]) test(`login mailbox name: ${label}`, async () => {
  const data = tables(); data.mailbox[0].name = name;
  const { service } = fixture(data);
  assert.equal(await service.mailboxName('user@example.com'), expected);
  assert.equal(await service.mailboxName('missing@example.com'), 'missing@example.com');
});

test('login mailbox names share the existing ten-minute directory snapshot', async () => {
  let time = 0; const data = tables(); data.mailbox[0].name = '처음 이름';
  const { service, calls } = fixture(data, { now: () => time });
  await Promise.all([service.mailboxName('user@example.com'), service.identities(session())]);
  assert.equal(calls.length, 5);
  data.mailbox[0].name = '바뀐 이름'; time = 599999;
  assert.equal(await service.mailboxName('user@example.com'), '처음 이름');
  assert.equal(calls.length, 5);
  time = 600000;
  assert.equal(await service.mailboxName('user@example.com'), '바뀐 이름');
  assert.equal(calls.length, 10);
});

test('sender case 1: self is listed first; unauthorized addresses return 403', async () => {
  const { service } = fixture();
  assert.deepEqual(await service.identities(session()), { identities: [{ address: 'user@example.com', name: '사용자', kind: 'self' }], anyAtDomains: [], anyAddress: false, defaultFrom: 'user@example.com' });
  await permitted(service, 'USER@EXAMPLE.COM'); await denied(service, 'other@example.com');
  for (const bad of ['user@example.com\r\nBcc: hidden@example.com', 'Name <user@example.com>', '', null]) await denied(service, bad);
});

for (const [label, name, sessionName, expected] of [
  ['real mailbox name', '사용자', 'user@example.com', '사용자'],
  ['empty name', '', 'user@example.com', ''],
  ['whitespace name', '   ', 'user@example.com', ''],
  ['address as name', 'user@example.com', 'user@example.com', ''],
  ['other address as name', ' Other@EXAMPLE.COM ', 'user@example.com', ''],
  ['real session fallback', '', '사용자', '사용자'],
]) test(`sender names: ${label}`, async () => {
  const data = tables(); data.mailbox[0].name = name;
  data.alias = [alias('team@example.com')]; data.sender_acl = [acl('delegated@example.com')];
  const result = await fixture(data).service.identities({ email: 'user@example.com', name: sessionName });
  assert.equal(result.identities.length, 3);
  assert.deepEqual(result.identities.map(item => item.name), [expected, expected, expected]);
});
for (const ownName of ['사용자', '']) test(`sender names: alias and ACL prefer their own real mailbox names, login name=${ownName}`, async () => {
  const data = tables(); data.mailbox[0].name = ownName;
  data.alias = [alias('team@example.com')]; data.sender_acl = [acl('delegated@example.com')];
  data.mailbox.push({ username: 'team@example.com', name: '팀 이름' }, { username: 'delegated@example.com', name: 'delegated@example.com' });
  const result = await fixture(data).service.identities({ email: 'user@example.com', name: 'user@example.com' });
  assert.equal(result.identities.find(item => item.address === 'team@example.com').name, '팀 이름');
  assert.equal(result.identities.find(item => item.address === 'delegated@example.com').name, ownName);
});

test('sender case 2: active sender_allowed aliases use the complete comma-separated goto membership', async () => {
  const data = tables();
  data.alias = [alias('team@example.com', 'other@example.com,user@example.com'), alias('unrelated@example.com', 'other@example.com'), alias('partial@example.com', 'otheruser@example.com')];
  const { service } = fixture(data);
  const result = await service.identities(session());
  assert.deepEqual(result.identities.map(item => [item.address, item.kind]), [['user@example.com', 'self'], ['team@example.com', 'alias']]);
  await permitted(service, 'team@example.com'); await denied(service, 'unrelated@example.com'); await denied(service, 'partial@example.com');
});

test('sender case 3: active=2 direct alias blocks catch-all; inactive or sender-disallowed aliases do not', async () => {
  const data = tables();
  data.alias = [alias('@example.com'), alias('two@example.com', 'user@example.com', 2), alias('zero@example.com', 'other@example.com', 0), alias('no-sender@example.com', 'other@example.com', 1, 0), alias('other@example.com', 'other@example.com')];
  const { service } = fixture(data);
  assert.deepEqual((await service.identities(session())).anyAtDomains, ['@example.com']);
  await permitted(service, 'arbitrary@example.com'); await denied(service, 'two@example.com');
  await permitted(service, 'zero@example.com'); await permitted(service, 'no-sender@example.com'); await denied(service, 'other@example.com');
  const withoutCatchAll = tables(); withoutCatchAll.alias = [alias('disabled@example.com', 'user@example.com', 0), alias('two@example.com', 'user@example.com', 2), alias('disallowed@example.com', 'user@example.com', 1, 0)];
  const restricted = fixture(withoutCatchAll).service;
  for (const address of ['disabled@example.com', 'two@example.com', 'disallowed@example.com']) await denied(restricted, address);
});

test('sender case 4: exact ACL address is allowed without an active domain prerequisite', async () => {
  const data = tables(); data.sender_acl = [acl('delegated@outside.example.com'), { logged_in_as: 'other@example.com', send_as: 'not-mine@example.com' }];
  const { service } = fixture(data);
  assert.ok((await service.identities(session())).identities.some(item => item.address === 'delegated@outside.example.com' && item.kind === 'acl'));
  await permitted(service, 'delegated@outside.example.com'); await denied(service, 'not-mine@example.com');
});

test('sender case 5: domain ACL enables arbitrary local parts only at that exact domain', async () => {
  const data = tables(); data.sender_acl = [acl('@delegated.example.com')];
  const { service } = fixture(data);
  const result = await service.identities(session());
  assert.deepEqual(result.anyAtDomains, ['@delegated.example.com']); assert.equal(result.anyAddress, false);
  await permitted(service, 'any@delegated.example.com'); await denied(service, 'any@sub.delegated.example.com');
});

test('sender case 6: wildcard ACL uses anyAddress separately from anyAtDomains', async () => {
  const data = tables(); data.sender_acl = [acl('*')];
  const { service } = fixture(data);
  const result = await service.identities(session());
  assert.equal(result.anyAddress, true); assert.deepEqual(result.anyAtDomains, []);
  await permitted(service, 'arbitrary@outside.example.com');
  await assert.rejects(service.assertFrom({ email: 'other@example.com' }, 'arbitrary@outside.example.com'), { code: 'FROM_NOT_ALLOWED' });
});

test('sender case 7: ACL grants map through alias domains, including inactive mappings in the ACL UNION', async () => {
  const data = tables(); data.alias_domain = [{ alias_domain: 'alias.example.com', target_domain: 'target.example.com', active: 0 }];
  data.sender_acl = [acl('@target.example.com'), acl('named@target.example.com')];
  const { service } = fixture(data);
  const result = await service.identities(session());
  assert.deepEqual(result.anyAtDomains, ['@alias.example.com', '@target.example.com']);
  await permitted(service, 'any@alias.example.com'); await permitted(service, 'named@alias.example.com');
  const exactOnly = structuredClone(data); exactOnly.sender_acl = [acl('named@target.example.com')];
  const exactService = fixture(exactOnly).service;
  await permitted(exactService, 'named@alias.example.com'); await denied(exactService, 'other@alias.example.com');
  assert.ok((await exactService.identities(session())).identities.some(item => item.address === 'named@alias.example.com' && item.kind === 'acl'));
});

test('sender case 8: alias-domain mailbox branch accepts mailbox active 1 or 2, but requires active mapping', async () => {
  for (const value of [1, 2]) {
    const data = tables(); data.mailbox[0].active = value;
    data.alias_domain = [{ alias_domain: 'alias.example.com', target_domain: 'example.com', active: 1 }];
    const { service } = fixture(data);
    await permitted(service, 'user@alias.example.com');
    assert.ok((await service.identities(session())).identities.some(item => item.address === 'user@alias.example.com' && item.kind === 'alias'));
    data.alias_domain[0].active = 0;
    await denied(fixture(data).service, 'user@alias.example.com');
    data.alias_domain[0].active = 1; data.mailbox[0].active = 0;
    await denied(fixture(data).service, 'user@alias.example.com');
  }
});

test('sender case 9: original SQL NOT IN applies only to the final alias-domain address OR term', async () => {
  const base = tables(); base.alias_domain = [{ alias_domain: 'alias.example.com', target_domain: 'target.example.com', active: 0 }];
  base.alias = [alias('delegated@alias.example.com', 'user@example.com', 0)];
  for (const grant of ['delegated@alias.example.com', '@alias.example.com', '*', '@target.example.com']) {
    const data = structuredClone(base); data.sender_acl = [acl(grant)];
    await permitted(fixture(data).service, 'delegated@alias.example.com');
  }
  const data = structuredClone(base); data.sender_acl = [acl('delegated@target.example.com')];
  await denied(fixture(data).service, 'delegated@alias.example.com');
  // SQL NOT IN compares the whole goto value, not comma-separated membership.
  data.alias[0].goto = 'user@example.com,other@example.com';
  await permitted(fixture(data).service, 'delegated@alias.example.com');
  data.alias[0].goto = null;
  await denied(fixture(data).service, 'delegated@alias.example.com');
});

test('inactive domain and alias-domain rows reject direct aliases even when their goto matches', async () => {
  const data = tables(); data.domain[0].active = 0; data.alias = [alias('team@example.com')];
  await denied(fixture(data).service, 'team@example.com');
  data.alias_domain = [{ alias_domain: 'example.com', target_domain: 'target.example.com', active: 1 }];
  await permitted(fixture(data).service, 'team@example.com');
});

test('defaultFrom preference is used only while authorized; responses cannot mutate cached grants', async () => {
  const data = tables(); data.sender_acl = [acl('delegated@example.com')];
  const { service } = fixture(data); const owner = session(); owner.prefs = { defaultFrom: 'delegated@example.com' };
  const first = await service.identities(owner); assert.equal(first.defaultFrom, 'delegated@example.com');
  first.identities[0].address = 'corrupted@example.com'; first.anyAtDomains.push('@outside.example.com'); first.anyAddress = true;
  const next = await service.identities(owner); assert.equal(next.identities[0].address, 'user@example.com'); assert.equal(next.anyAddress, false);
  owner.prefs.defaultFrom = 'forbidden@example.com'; assert.equal((await service.identities(owner)).defaultFrom, 'user@example.com');
});

test('all DB statements use only granted columns; simultaneous requests share a ten-minute snapshot', async () => {
  let time = 0; const data = tables(); const { service, calls } = fixture(data, { now: () => time });
  await Promise.all([service.identities(session()), service.internalDomains(), service.identities(session())]);
  assert.equal(calls.length, 5); assert.deepEqual(new Set(calls), new Set(Object.values(directoryQueries)));
  assert.deepEqual(calls, ['SELECT username, name, domain, active FROM mailbox', 'SELECT address, goto, domain, sender_allowed, active FROM alias', 'SELECT alias_domain, target_domain, active FROM alias_domain', 'SELECT domain, active FROM domain', 'SELECT logged_in_as, send_as FROM sender_acl']);
  data.sender_acl = [acl('*')]; time = 599999;
  assert.equal((await service.identities(session())).anyAddress, false); assert.equal(calls.length, 5);
  time = 600000; assert.equal((await service.identities(session())).anyAddress, true); assert.equal(calls.length, 10);
});

test('internal domains combine active domains and alias domains; explicit config overrides without DB access', async () => {
  const data = tables(); data.domain.push({ domain: 'disabled.example.com', active: 0 });
  data.alias_domain = [{ alias_domain: 'alias.example.com', target_domain: 'example.com', active: 1 }, { alias_domain: 'old.example.com', target_domain: 'example.com', active: 0 }];
  assert.deepEqual(await fixture(data).service.internalDomains(), ['alias.example.com', 'example.com']);
  const override = fixture(data, { config: { internalDomains: ['ONLY.example.com', 'only.example.com'] } });
  assert.deepEqual(await override.service.internalDomains(), ['only.example.com']); assert.equal(override.calls.length, 0);
});

test('contacts prioritize recent recipients, then sorted people and teams, deduplicate and respect limit', async () => {
  const data = tables();
  data.mailbox.push({ username: 'z@example.com', name: 'Zulu', active: 1 }, { username: 'a@example.com', name: 'Alpha', active: 2 }, { username: 'off@example.com', name: 'Off', active: 0 });
  data.alias = [alias('team@example.com'), alias('@example.com'), alias('off-team@example.com', 'user@example.com', 0), alias('recent@example.com')];
  const owner = session(); let historyCalls = 0;
  const { service } = fixture(data, { recentRecipients: async () => { historyCalls++; return [{ name: 'Newest', address: 'RECENT@example.com' }, { name: 'Older', address: 'a@example.com' }, { name: 'Duplicate', address: 'recent@example.com' }]; } });
  const result = await service.contacts(owner, { q: 'example.com', limit: '8' });
  assert.deepEqual(result.items.map(item => [item.address, item.kind]), [['recent@example.com', 'recent'], ['a@example.com', 'recent'], ['user@example.com', 'person'], ['z@example.com', 'person'], ['team@example.com', 'team']]);
  assert.equal(result.items[0].name, 'Newest');
  assert.equal((await service.contacts(owner, { q: 'EXAMPLE.COM', limit: '2' })).items.length, 2);
  assert.deepEqual((await service.contacts(owner, { q: 'newest' })).items.map(item => item.address), ['recent@example.com']);
  assert.equal(historyCalls, 1);
});

test('recent recipient cache is isolated by session and expires after ten minutes', async () => {
  let time = 0, count = 0;
  const { service } = fixture(tables(), { now: () => time, recentRecipients: async owner => { count++; return [{ name: '', address: owner.recent }]; } });
  const a = { ...session(), recent: 'one@example.com' }, b = { ...session(), recent: 'two@example.com' };
  const [one, same, two] = await Promise.all([service.contacts(a, { q: 'one' }), service.contacts(a, { q: 'one' }), service.contacts(b, { q: 'two' })]);
  assert.equal(one.items[0].address, 'one@example.com'); assert.deepEqual(one, same); assert.equal(two.items[0].address, 'two@example.com'); assert.equal(count, 2);
  time = 600000; a.recent = 'new@example.com'; assert.equal((await service.contacts(a, { q: 'new' })).items[0].address, 'new@example.com'); assert.equal(count, 3);
});

test('invalid contact query is rejected before any DB or IMAP lookup', async () => {
  const { service, calls } = fixture();
  for (const query of [{}, { q: '' }, { q: ' ' }, { q: ['x'] }, { q: 'x\r\n' }, { q: 'x', limit: '0' }, { q: 'x', limit: '-1' }, { q: 'x', limit: '1.5' }, { q: 'x', limit: '9007199254740992' }]) await assert.rejects(service.contacts(session(), query), { statusCode: 400, code: 'CONTACTS_QUERY_INVALID' });
  assert.equal(calls.length, 0);
});

test('DB failure is sanitized, not cached, and cannot reuse expired authorization', async () => {
  let fail = true;
  const { service } = fixture(tables(), { db: { execute: async () => { if (fail) throw new Error('synthetic-private-db-password'); return [[]]; } } });
  await assert.rejects(service.identities(session()), error => error.code === 'DIRECTORY_UNAVAILABLE' && error.statusCode === 503 && !error.message.includes('private'));
  fail = false; assert.equal((await service.identities(session())).anyAddress, false);
});

test('recent IMAP lookup uses Sent special-use, latest 300 ARRIVAL-sorted messages, To and Cc only', async () => {
  const visits = []; let nextCalls = 0;
  const imap = { withMailbox: async (_session, path, operation) => {
    visits.push(path);
    return operation({
      list: async () => [{ path: '보낸 편지', specialUse: '\\Sent' }],
      exec: async (verb, args, options) => {
        assert.equal(verb, 'UID SORT'); assert.deepEqual(args[0].map(item => item.value), ['REVERSE', 'ARRIVAL']);
        options.untagged.SORT({ attributes: Array.from({ length: 350 }, (_, i) => ({ value: String(350 - i) })) });
        return { next: () => { nextCalls++; } };
      },
      fetch: async function* (set, fields, options) {
        const uids = set.split(',').map(Number); assert.equal(uids.length, 300); assert.equal(uids[0], 350); assert.equal(uids.at(-1), 51);
        assert.deepEqual(fields, { envelope: true }); assert.equal(options.uid, true);
        yield { uid: 349, envelope: { to: [{ name: 'Older', address: 'older@example.com' }], bcc: [{ address: 'hidden@example.com' }] } };
        yield { uid: 350, envelope: { to: [{ name: 'Newest', address: 'newest@example.com' }], cc: [{ name: '참조', address: 'cc@example.com' }] } };
      },
    });
  } };
  const result = await recentRecipients(imap, session());
  assert.deepEqual(visits, ['INBOX', '보낸 편지']); assert.equal(nextCalls, 1);
  assert.deepEqual(result.map(item => item.address), ['newest@example.com', 'cc@example.com', 'older@example.com']);
});

test('no Sent folder produces no recent addresses, and transport errors are sanitized', async () => {
  assert.deepEqual(await recentRecipients({ withMailbox: async (_session, _path, operation) => operation({ list: async () => [] }) }, session()), []);
  await assert.rejects(recentRecipients({ withMailbox: async () => { throw new Error('synthetic-private-imap-password'); } }, session()), error => error.statusCode === 503 && !error.message.includes('private'));
});

test('registered routes preserve auth 403, return contracts, disable caching and expose service to sending', async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-w08-test-'));
  const app = await createApp({ config: { trustProxy: [], publicHostnames: ['newmail.example.com'], sessionIdleMin: 480, sessionMaxHours: 24, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com', internalDomains: [], dbHost: '127.0.0.1', dbName: 'mailcow', dbUser: 'webmail_ro', dbPassword: 'synthetic-db-password' }, logger: false, staticDir: '/nonexistent-webmail-directory-fixture', auth: { tempRoot } });
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  const data = tables(); data.sender_acl = [acl('*')];
  const fake = fixture(data); app.directory.identities = fake.service.identities; app.directory.contacts = fake.service.contacts;
  assert.equal(typeof app.directory.assertFrom, 'function'); assert.equal(typeof app.directory.internalDomains, 'function');
  for (const url of ['/api/compose/identities', '/api/contacts?q=x']) {
    const denied = await app.inject({ method: 'GET', url }); assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
  }
  assert.equal(fake.calls.length, 0);
  const login = app.sessions.create({ ...session(), password: Buffer.from('synthetic-user-password'), connection: { logout: async () => {} }, ip: '198.51.100.8' });
  const cookie = `webmail_sid=${login.token}`;
  const identities = await app.inject({ method: 'GET', url: '/api/compose/identities', headers: { cookie } });
  assert.equal(identities.statusCode, 200); assert.equal(identities.json().anyAddress, true); assert.equal(identities.headers['cache-control'], 'no-store');
  const contacts = await app.inject({ method: 'GET', url: '/api/contacts?q=example.com&limit=8', headers: { cookie } });
  assert.equal(contacts.statusCode, 200); assert.equal(contacts.json().items[0].kind, 'person'); assert.equal(contacts.headers['cache-control'], 'no-store');
  const invalid = await app.inject({ method: 'GET', url: '/api/contacts?q=', headers: { cookie } }); assert.equal(invalid.statusCode, 400);
});

test('sender SQL NOT IN ignores trailing spaces and case in the complete goto value', async () => {
  const data = tables();
  data.alias_domain = [{ alias_domain: 'alias.example.com', target_domain: 'target.example.com', active: 0 }];
  data.alias = [alias('delegated@alias.example.com', 'USER@EXAMPLE.COM   ', 0)];
  data.sender_acl = [acl('delegated@target.example.com')];
  await denied(fixture(data).service, 'delegated@alias.example.com');
});

test('contacts restrict people and teams to own and explicitly configured domains, but not recent recipients', async () => {
  const data = tables();
  data.mailbox.push({ username: 'person@other.example.com', name: 'Other', domain: 'other.example.com', active: 1 });
  data.domain.push({ domain: 'other.example.com', active: 1 });
  data.alias = [alias('team@example.com'), alias('team@other.example.com'), alias('@other.example.com')];
  const options = { recentRecipients: async () => [{ name: 'Recent', address: 'recent@outside.example.com' }] };
  const own = fixture(data, options).service;
  assert.deepEqual((await own.contacts(session(), { q: 'example.com' })).items.map(item => item.address),
    ['recent@outside.example.com', 'user@example.com', 'team@example.com']);
  const extended = fixture(data, { ...options, config: { internalDomains: ['OTHER.example.com'] } }).service;
  assert.deepEqual((await extended.contacts(session(), { q: 'example.com' })).items.map(item => item.address),
    ['recent@outside.example.com', 'user@example.com', 'person@other.example.com', 'team@example.com', 'team@other.example.com']);
});

test('disabled contacts return an empty list before query validation with no DB or IMAP calls', async () => {
  let imapCalls = 0;
  const { service, calls } = fixture(tables(), {
    config: { internalDomains: [], contactsEnabled: false },
    imap: { withMailbox: async () => { imapCalls++; throw new Error('unexpected IMAP lookup'); } },
    recentRecipients: undefined,
  });
  assert.deepEqual(await service.contacts(session(), { q: 'example.com' }), { items: [] });
  assert.deepEqual(await service.contacts(session(), {}), { items: [] });
  assert.equal(calls.length, 0);
  assert.equal(imapCalls, 0);
});
