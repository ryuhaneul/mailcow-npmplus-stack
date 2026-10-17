import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSendersService, readAndMergeSenderAcl, mergeSenderAcl, senderAllowed } from '../../server/admin/services/senders.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';

const owner = 'owner@example.com', other = 'other@example.com';
const ctx = { session: {}, actor: 'admin', ip: '198.51.100.34', addr: owner };
const alias = (address, goto, sender_allowed = '1', active = '1') => ({ address, domain: address.split('@')[1], goto, sender_allowed, active });
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a11-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const mailbox = { username: owner, active: '1', sender_acl: ['first@example.com', 'second@example.com', 'third@example.com'] };
  const boxes = [mailbox, { username: other, active: '1', sender_acl: [] }];
  const aliases = [alias('receive@example.com', owner, '0'), alias('allowed@example.com', owner)];
  const domains = [{ domain_name: 'example.com', active: '1' }, { domain_name: 'off.example.com', active: '0' }];
  const aliasDomains = [{ alias_domain: 'alias.example.com', target_domain: 'example.com', active: '1' }, { alias_domain: 'alias-off.example.com', target_domain: 'example.com', active: '0' }];
  const options = {}, calls = [];
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); await options.onCall?.({ method, path, body });
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/mailbox/all') return structuredClone(boxes);
    if (path.startsWith('/api/v1/get/mailbox/')) return structuredClone(boxes.find(row => row.username === decodeURIComponent(path.split('/').at(-1))) ?? {});
    if (path === '/api/v1/get/alias/all') return structuredClone(aliases);
    if (path === '/api/v1/get/domain/all') return structuredClone(domains);
    if (path === '/api/v1/get/alias-domain/all') return aliasDomains.length ? structuredClone(aliasDomains) : {};
    if (path === '/api/v1/edit/mailbox') {
      if (!options.ignoreWrites) {
        const values = body.attr.sender_acl, fixed = aliases.filter(row => !row.address.startsWith('@') && row.sender_allowed === '1' && row.goto.split(',').includes(owner)).map(row => row.address);
        fixed.push(owner);
        mailbox.sender_acl = values.includes('*') ? ['*'] : values.filter(value => !fixed.includes(value));
      }
      return [{ type: 'success' }];
    }
    assert.fail(path);
  } };
  const audit = createAudit({ dir }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const service = createSendersService({ mailcow, audit, lock, history });
  return { dir, mailbox, boxes, aliases, domains, aliasDomains, options, calls, mailcow, audit, history, service };
}
const get = f => f.service.get({}, owner);
const diff = (f, data = {}) => f.service.diff({ ...ctx, data: { add: [], remove: [], ...data } });
const put = (f, etag, data = {}) => f.service.put({ ...ctx, data: { etag, add: [], remove: [], ...data } });
const writes = f => f.calls.filter(row => row.method === 'POST');
const revert = (f, id) => f.history.revert(id, { ...ctx, confirm: true });

test('senders: existing three grants plus one sends exactly four; diff is read-only; undo swaps back', async t => {
  const f = await fixture(t), initial = await get(f), p = await diff(f, { add: ['fourth@example.com'] });
  assert.deepEqual(p.kept, initial.senderAcl); assert.deepEqual(p.added, ['fourth@example.com']); assert.deepEqual(p.removed, []); assert.equal(writes(f).length, 0);
  const result = await put(f, initial.etag, { add: ['fourth@example.com'] });
  assert.equal(writes(f)[0].body.attr.sender_acl.length, 4); assert.deepEqual(writes(f)[0].body.items, [owner]); assert.equal(result.senderAcl.length, 4);
  const record = await f.history.detail(result.auditId); assert.equal(record.kind, 'config'); assert.equal(record.canRevert, true);
  const reverse = await revert(f, result.auditId); assert.deepEqual(f.mailbox.sender_acl, initial.senderAcl); assert.equal((await f.history.detail(reverse.id)).revertOf, result.auditId);
});

test('senders: receiver-only aliases, effective aliases/self/explicit grants and limits are visible', async t => {
  const f = await fixture(t), result = await get(f);
  assert.deepEqual(result.receiveOnlyAliases, [{ address: 'receive@example.com', active: '1' }]);
  assert.ok(result.effective.addresses.includes(owner)); assert.ok(result.effective.addresses.includes('allowed@example.com')); assert.ok(!result.effective.addresses.includes('receive@example.com'));
  assert.equal(result.effective.all, false); assert.equal(result.limits.length, 2); assert.ok(result.limits[0].includes('external')); assert.ok(result.limits[1].includes('가정'));
});

for (const data of [{ add: ['*'] }, { add: ['default'] }, { add: ['bad'] }, { add: ['a@..'] }, { add: ['a@-bad'] }, { add: ["o'neil@example.com"] }, { add: ['x@example.com', 'x@example.com'] }, { add: ['x@example.com', 'X@EXAMPLE.COM'] }, { add: ['x@example.com'], remove: ['x@example.com'] }, { remove: ['x@example.com', 'x@example.com'] }, { add: ['@missing.example.com'] }, { add: 'x@example.com' }, { remove: null }]) test(`senders: invalid change ${JSON.stringify(data)}`, async t => {
  const f = await fixture(t); await assert.rejects(put(f, (await get(f)).etag, data), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});

test('senders: domain and @domain normalize alike; inactive domains allowed; outside email allowed', async t => {
  const f = await fixture(t), initial = await get(f);
  const result = await put(f, initial.etag, { add: ['off.example.com', '@alias-off.example.com', 'external@example.net'] });
  assert.ok(result.senderAcl.includes('@off.example.com')); assert.ok(result.senderAcl.includes('@alias-off.example.com')); assert.ok(result.senderAcl.includes('external@example.net'));
  await assert.rejects(diff(f, { add: ['example.com', '@example.com'] }), { statusCode: 422 });
});
test('senders: wildcard GET all=true; existing wildcard blocks mutation unless explicitly removed', async t => {
  const f = await fixture(t); f.mailbox.sender_acl = ['*']; const initial = await get(f); assert.equal(initial.effective.all, true);
  await assert.rejects(put(f, initial.etag, { add: ['new@example.com'] }), { statusCode: 409, code: 'SENDER_WILDCARD_PRESENT' }); assert.equal(writes(f).length, 0);
  const changed = await put(f, initial.etag, { add: ['new@example.com'], remove: ['*'] }); assert.deepEqual(changed.senderAcl, ['new@example.com']);
  await revert(f, changed.auditId); assert.deepEqual(f.mailbox.sender_acl, ['*']); assert.deepEqual(writes(f).at(-1).body.attr.sender_acl, ['*']);
});
test('senders: already allowed alias grants are separated from actual storage; unchanged diff avoids write', async t => {
  const f = await fixture(t), initial = await get(f), p = await diff(f, { add: ['allowed@example.com'] });
  assert.deepEqual(p.alreadyAllowedByAlias, ['allowed@example.com']); assert.deepEqual(p.after, initial.senderAcl); assert.deepEqual(p.added, []);
  const result = await put(f, initial.etag, { add: ['allowed@example.com'] }); assert.equal(result.unchanged, true); assert.equal(writes(f).length, 0);
});
test('senders: removing everything sends empty array, verified and reversible', async t => {
  const f = await fixture(t), initial = await get(f), result = await put(f, initial.etag, { remove: initial.senderAcl });
  assert.deepEqual(writes(f)[0].body.attr.sender_acl, []); assert.deepEqual(result.senderAcl, []); await revert(f, result.auditId); assert.deepEqual(f.mailbox.sender_acl, initial.senderAcl);
});
for (const kind of ['acl', 'alias', 'domain']) test(`senders: changed ${kind} ${kind === 'domain' ? 'is display-only' : 'invalidates etag before write'}`, async t => {
  const f = await fixture(t), initial = await get(f);
  if (kind === 'acl') f.mailbox.sender_acl.push('later@example.com');
  if (kind === 'alias') f.aliases[0].sender_allowed = '1';
  if (kind === 'domain') {
    f.domains[0].active = '0';
    assert.ok((await put(f, initial.etag, { add: ['new@example.com'] })).senderAcl.includes('new@example.com'));
  } else {
    await assert.rejects(put(f, initial.etag, { add: ['new@example.com'] }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 0);
  }
});
test('senders: durable-intent recheck detects intervening change; ignored upstream write is 502', async t => {
  const f = await fixture(t), initial = await get(f); let reads = 0;
  f.options.onCall = ({ path }) => { if (path.includes('/get/mailbox/') && !path.endsWith('/all') && ++reads === 2) f.mailbox.sender_acl.push('later@example.com'); };
  await assert.rejects(put(f, initial.etag, { add: ['new@example.com'] }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 0);
  f.options.onCall = undefined; f.options.ignoreWrites = true;
  await assert.rejects(put(f, (await get(f)).etag, { add: ['new@example.com'] }), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
});
test('senders: adapter expected recheck blocks changed alias context', async t => {
  const f = await fixture(t), result = await put(f, (await get(f)).etag, { add: ['new@example.com'] }); f.aliases[1].sender_allowed = '0';
  await assert.rejects(revert(f, result.auditId), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 1);
});
test('senders: exported helper re-reads current state, preserves unrelated grants and enforces expected', async t => {
  const f = await fixture(t), initial = await get(f);
  const prepared = await readAndMergeSenderAcl({ mailcow: f.mailcow, session: {}, address: owner, add: ['new@example.com'], remove: [], expected: initial.etag }); assert.equal(prepared.diff.after.length, 4);
  f.mailbox.sender_acl.push('later@example.com'); await assert.rejects(f.service.readAndMerge({ session: {}, address: owner, add: [], remove: [], expected: initial.etag }), { statusCode: 409 });
  assert.deepEqual(mergeSenderAcl(['old@example.com'], { add: ['new@example.com'], remove: [] }).after, ['new@example.com', 'old@example.com']);
});
test('senders: missing target and missing etag are rejected', async t => {
  const f = await fixture(t); await assert.rejects(f.service.get({}, 'missing@example.com'), { statusCode: 404 }); await assert.rejects(put(f, undefined), { statusCode: 409 }); assert.equal(writes(f).length, 0);
});
test('senders: redundant pre-existing alias grant is removed with explicit notice and non-revertible record', async t => {
  const f = await fixture(t); f.mailbox.sender_acl.push('allowed@example.com'); const initial = await get(f), p = await diff(f);
  assert.deepEqual(p.removedAsAliasDuplicates, ['allowed@example.com']); assert.ok(p.storageNotice.includes('저장하면 목록에서 빠짐'));
  const result = await put(f, initial.etag); assert.deepEqual(result.diff.removedAsAliasDuplicates, ['allowed@example.com']); assert.ok(result.effective.addresses.includes('allowed@example.com')); assert.ok(!result.senderAcl.includes('allowed@example.com'));
  const record = await f.history.detail(result.auditId); assert.equal(record.kind, 'config'); assert.equal(record.revertible, false); assert.ok(record.detail.reason.includes('1개')); assert.deepEqual(record.detail.addresses, ['allowed@example.com']);
  await assert.rejects(revert(f, result.auditId), { statusCode: 409, code: 'NOT_REVERTIBLE' });
});

const calculationCases = [
  { title: 'Q1 self alias, active primary', candidate: owner, expected: true },
  { title: 'Q1 self alias outer active=1 rejects mailbox active=2', mutate: f => { f.mailbox.active = '2'; }, candidate: owner, expected: false },
  { title: 'Q1 CSV tokens authorize alias', mutate: f => { f.aliases.push(alias('csv@example.com', `${other},${owner}`)); }, candidate: 'csv@example.com', expected: true },
  { title: 'Q1 receive-only alias is not authorized', candidate: 'receive@example.com', expected: false },
  { title: 'Q1 inactive alias is not authorized', mutate: f => { f.aliases.push(alias('inactive@example.com', owner, '1', '0')); }, candidate: 'inactive@example.com', expected: false },
  { title: 'Q1 alias domain active does not require primary active', mutate: f => { f.domains[0].active = '0'; f.aliases.push(alias('visible@alias.example.com', owner)); }, candidate: 'visible@alias.example.com', expected: true },
  { title: 'Q1 inactive domain blocks allowed alias', mutate: f => { f.domains[0].active = '0'; }, candidate: 'allowed@example.com', expected: false },
  { title: 'Q1 inactive alias domain blocks alias', mutate: f => { f.aliases.push(alias('visible@alias-off.example.com', owner)); }, candidate: 'visible@alias-off.example.com', expected: false },
  { title: 'Q2b explicit address ignores inactive domain/alias', mutate: f => { f.domains[0].active = '0'; f.aliases.push(alias('explicit@example.com', owner, '0', '0')); f.mailbox.sender_acl = ['explicit@example.com']; }, candidate: 'explicit@example.com', expected: true },
  { title: 'Q2a explicit whole domain matches unseen local part even when off', mutate: f => { f.mailbox.sender_acl = ['@off.example.com']; }, candidate: 'unseen@off.example.com', expected: true, pattern: '@off.example.com' },
  { title: 'Q2c wildcard matches any sender', mutate: f => { f.mailbox.sender_acl = ['*']; }, candidate: 'unseen@example.net', expected: true },
  { title: 'Q2d mapped domain grant ignores inactive alias domain', mutate: f => { f.mailbox.sender_acl = ['@example.com']; }, candidate: 'unseen@alias-off.example.com', expected: true, pattern: '@alias-off.example.com' },
  { title: 'Q2e mapped exact address passes inactive alias domain', candidate: 'first@alias-off.example.com', expected: true },
  { title: 'Q2e NOT IN single goto excludes mapped grant regardless alias active', mutate: f => { f.aliases.push(alias('first@alias-off.example.com', owner, '0', '0')); }, candidate: 'first@alias-off.example.com', expected: false },
  { title: 'Q2e NOT IN compares whole CSV, not tokens', mutate: f => { f.aliases.push(alias('first@alias-off.example.com', `${other},${owner}`, '0', '0')); }, candidate: 'first@alias-off.example.com', expected: true },
  { title: 'Q2b direct grant bypasses final OR NOT IN', mutate: f => { f.aliases.push(alias('first@alias-off.example.com', owner, '0', '0')); f.mailbox.sender_acl.push('first@alias-off.example.com'); }, candidate: 'first@alias-off.example.com', expected: true },
  { title: 'Q3 alias domain mailbox uses active2 and ignores primary active', mutate: f => { f.mailbox.active = '2'; f.domains[0].active = '0'; }, candidate: 'owner@alias.example.com', expected: true },
  { title: 'Q3 inactive alias domain rejects mailbox-derived address', candidate: 'owner@alias-off.example.com', expected: false },
  { title: 'Q3 inactive mailbox rejects mailbox-derived address', mutate: f => { f.mailbox.active = '0'; }, candidate: 'owner@alias.example.com', expected: false },
  { title: 'Q1 catch-all permits unknown sender', mutate: f => { f.aliases.push(alias('@example.com', owner)); }, candidate: 'unseen@example.com', expected: true, pattern: '@example.com' },
  { title: 'Q1 catch-all exact alias override is excluded', mutate: f => { f.aliases.push(alias('@example.com', owner), alias('blocked@example.com', other)); }, candidate: 'blocked@example.com', expected: false, except: 'blocked@example.com' },
  { title: 'Q1 catch-all active2 exact alias overrides and fails outer filter', mutate: f => { f.aliases.push(alias('@example.com', owner), alias('blocked@example.com', owner, '1', '2')); }, candidate: 'blocked@example.com', expected: false, except: 'blocked@example.com' },
  { title: 'Q1 catch-all hidden self alias of other mailbox is excluded', mutate: f => { f.aliases.push(alias('@example.com', owner)); }, candidate: other, expected: false, except: other },
  { title: 'Q2 explicit grant restores catch-all excluded address', mutate: f => { f.aliases.push(alias('@example.com', owner), alias('blocked@example.com', other)); f.mailbox.sender_acl.push('blocked@example.com'); }, candidate: 'blocked@example.com', expected: true, notExcept: 'blocked@example.com' },
];
for (const scenario of calculationCases) test(`sender SQL: ${scenario.title}`, async t => {
  const f = await fixture(t); scenario.mutate?.(f);
  const state = (await readAndMergeSenderAcl({ mailcow: f.mailcow, session: {}, address: owner, add: [], remove: scenario.title.startsWith('Q2c') ? ['*'] : [] })).state;
  assert.equal(senderAllowed(state, scenario.candidate), scenario.expected);
  const result = await get(f);
  if (scenario.pattern) assert.ok(result.effective.domainPatterns.some(row => row.pattern === scenario.pattern));
  if (scenario.except) assert.ok(result.effective.domainPatterns.find(row => row.pattern === '@example.com').except.includes(scenario.except));
  if (scenario.notExcept) assert.ok(!result.effective.domainPatterns.find(row => row.pattern === '@example.com').except.includes(scenario.notExcept));
});
test('senders: empty alias-domain object is accepted and results have no virtual-domain address', async t => {
  const f = await fixture(t); f.aliasDomains.length = 0; assert.equal((await get(f)).effective.addresses.includes('owner@alias.example.com'), false);
});
test('senders: concurrent stale edits serialize and preserve first result', async t => {
  const f = await fixture(t), initial = await get(f), results = await Promise.allSettled([put(f, initial.etag, { add: ['new@example.com'] }), put(f, initial.etag, { remove: ['first@example.com'] })]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.code, 'CHANGED_ELSEWHERE'); assert.equal(writes(f).length, 1);
});
test('senders: intent write failure prevents mailcow mutation', async t => {
  const f = await fixture(t), initial = await get(f); await fs.rm(f.dir, { recursive: true }); await fs.writeFile(f.dir, 'synthetic-blocker');
  await assert.rejects(put(f, initial.etag, { add: ['new@example.com'] }), { statusCode: 500, code: 'AUDIT_UNAVAILABLE' }); assert.equal(writes(f).length, 0);
});
test('senders HTTP: GET/diff/PUT are guarded and do not send challenge headers', async t => {
  const f = await fixture(t), app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: false,
    auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  const denied = await app.inject(`/api/admin/senders/${owner}`); assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  const listed = await app.inject({ url: `/api/admin/senders/${owner}`, headers }); assert.equal(listed.statusCode, 200, listed.body); assert.equal(listed.headers['cache-control'], 'no-store');
  const preview = await app.inject({ method: 'POST', url: `/api/admin/senders/${owner}/diff`, headers, payload: { add: ['new@example.com'], remove: [] } }); assert.equal(preview.statusCode, 200, preview.body); assert.equal(writes(f).length, 0);
  const badOrigin = await app.inject({ method: 'PUT', url: `/api/admin/senders/${owner}`, headers: { ...headers, origin: 'https://other.example.com' }, payload: { etag: listed.json().etag, add: [], remove: [] } }); assert.equal(badOrigin.statusCode, 403); assert.equal(badOrigin.headers['www-authenticate'], undefined);
  const noCsrf = await app.inject({ method: 'PUT', url: `/api/admin/senders/${owner}`, headers: { ...headers, 'x-mailadmin-csrf': '' }, payload: { etag: listed.json().etag, add: [], remove: [] } }); assert.equal(noCsrf.statusCode, 403); assert.equal(noCsrf.headers['www-authenticate'], undefined);
  const wrongType = await app.inject({ method: 'PUT', url: `/api/admin/senders/${owner}`, headers: { ...headers, 'content-type': 'text/plain' }, payload: 'synthetic' }); assert.equal(wrongType.statusCode, 415);
  const applied = await app.inject({ method: 'PUT', url: `/api/admin/senders/${owner}`, headers, payload: { etag: listed.json().etag, add: ['new@example.com'], remove: [] } }); assert.equal(applied.statusCode, 200, applied.body); assert.ok(applied.json().senderAcl.includes('new@example.com'));
  assert.equal((await app.inject('/healthz')).json().ok, true);
});
test('senders review: unrelated alias edits do not invalidate PUT/helper or enter audit snapshots', async t => {
  const f = await fixture(t), initial = await get(f);
  f.aliases.push(alias('unrelated@example.com', other));
  const prepared = await f.service.readAndMerge({ session: {}, address: owner, add: ['new@example.com'], remove: [], expected: initial.etag }); assert.equal(prepared.etag, initial.etag);
  const result = await put(f, initial.etag, { add: ['new@example.com'] }), record = await f.history.detail(result.auditId);
  for (const value of [record.before, record.after]) {
    assert.deepEqual(Object.keys(value).sort(), ['address', 'aliasAllowed', 'senderAcl']);
    assert.equal(JSON.stringify(value).includes('unrelated@example.com'), false); assert.equal(value.aliases, undefined);
  }
});
test('senders review: unrelated alias edit allows undo, newly allowed alias for this mailbox blocks undo', async t => {
  const f = await fixture(t), initial = await get(f), first = await put(f, initial.etag, { add: ['new@example.com'] });
  f.aliases.push(alias('unrelated@example.com', other)); await revert(f, first.auditId); assert.deepEqual(f.mailbox.sender_acl, initial.senderAcl);
  const second = await put(f, (await get(f)).etag, { add: ['new@example.com'] });
  f.aliases.push(alias('newly-allowed@example.com', owner));
  await assert.rejects(revert(f, second.auditId), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 3);
});
test('senders review: obsolete domain grant can be removed but cannot be added', async t => {
  const f = await fixture(t), old = '@deleted.example.com'; f.mailbox.sender_acl.push(old);
  const result = await put(f, (await get(f)).etag, { remove: [old] }); assert.equal(result.senderAcl.includes(old), false);
  await assert.rejects(put(f, result.etag, { add: [old] }), { statusCode: 422 }); assert.equal(writes(f).length, 1);
});
test('senders review HTTP: existing unsupported address is readable and removable, absent unsupported input is rejected', async t => {
  const f = await fixture(t), stored = "o'brien@example.com"; f.mailbox.sender_acl.push(` ${stored.toUpperCase()} `);
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: false,
    auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  const listed = await app.inject({ url: `/api/admin/senders/${owner}`, headers }); assert.equal(listed.statusCode, 200, listed.body); assert.ok(listed.json().senderAcl.includes(stored));
  const kept = await app.inject({ method: 'PUT', url: `/api/admin/senders/${owner}`, headers, payload: { etag: listed.json().etag, add: ['new@example.com'], remove: [] } }); assert.equal(kept.statusCode, 200, kept.body); assert.ok(kept.json().senderAcl.includes(stored));
  const removed = await app.inject({ method: 'PUT', url: `/api/admin/senders/${owner}`, headers, payload: { etag: kept.json().etag, add: [], remove: [stored] } }); assert.equal(removed.statusCode, 200, removed.body); assert.equal(removed.json().senderAcl.includes(stored), false);
  const invalid = await app.inject({ method: 'PUT', url: `/api/admin/senders/${owner}`, headers, payload: { etag: removed.json().etag, add: [], remove: [stored] } }); assert.equal(invalid.statusCode, 422); assert.equal(writes(f).length, 2);
});
