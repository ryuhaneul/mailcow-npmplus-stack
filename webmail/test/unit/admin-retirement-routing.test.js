import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetirementGraph, createRetirementRouting } from '../../server/admin/retirement-routing.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';
import { AppError } from '../../server/errors.js';

const owner = 'retired@example.test', healthy = 'healthy@example.test', team = 'team@example.test';
const box = (username, active = 1) => ({ username, active });
const alias = (address, goto, extra = {}) => ({ address, goto, active: 1, ...extra });
function fixture() {
  const facts = { mailboxes: [box(owner, 2), box(healthy), box(team)], aliases: [alias(owner, owner), alias(healthy, healthy)], aliasDomains: [], domains: [{ domain_name: 'example.test', active: 1 }] };
  const filters = [], globals = { prefilter: '', postfilter: '' }, scripts = new Map(), names = new Map(), calls = [], dbCalls = [];
  const options = {}; let concurrent = 0, peak = 0, lockCalls = 0;
  const mailcow = { async call(session, method, path) {
    calls.push({ method, path }); assert.equal(method, 'GET');
    if (options.onCall) await options.onCall(path);
    const source = { '/api/v1/get/mailbox/all': facts.mailboxes, '/api/v1/get/alias/all': facts.aliases, '/api/v1/get/alias-domain/all': facts.aliasDomains,
      '/api/v1/get/domain/all': facts.domains, '/api/v1/get/filters/all': filters, '/api/v1/get/global_filters/all': globals };
    if (Object.hasOwn(source, path)) return structuredClone(source[path]);
    if (path.startsWith('/api/v1/get/active-user-sieve/')) {
      const address = decodeURIComponent(path.split('/').at(-1));
      if (options.failUser === address) throw new Error('synthetic source text must not leak');
      return scripts.has(address) ? [scripts.get(address)] : {};
    }
    assert.fail(path);
  } };
  const dockerapi = { async listSieve(address) {
    concurrent++; peak = Math.max(peak, concurrent); await new Promise(resolve => setImmediate(resolve)); concurrent--;
    return names.get(address) ?? [];
  } };
  const store = { async blockedRecipients(addresses) { dbCalls.push([...addresses]); if (options.dbError) throw options.dbError; return addresses.filter(value => value === owner); },
    async withRoutingLock(operation) { lockCalls++; if (options.lockError) throw options.lockError; return operation(); } };
  return { facts, filters, globals, scripts, names, calls, dbCalls, options, store, mailcow, dockerapi,
    get peak() { return peak; }, get lockCalls() { return lockCalls; }, routing: createRetirementRouting({ mailcow, dockerapi, store }) };
}
function filter(script, type = 'prefilter', username = team, id = '1') { return { id, username, filter_type: type, active: 1, script_data: script }; }
const inspect = f => f.routing.inspect({}, owner);
const codes = plan => plan.blockers.map(row => row.code);

test('retirement routes: self alias terminates at its mailbox; canonical, aliases, chains, alias-domain and plus resolve', async () => {
  const f = fixture(); f.facts.aliases.push(alias('first@example.test', owner), alias('second@example.test', 'first@example.test'));
  f.facts.aliasDomains.push({ alias_domain: 'alternate.test', target_domain: 'example.test', active: 1 });
  const graph = createRetirementGraph(f.facts);
  for (const recipient of [owner, 'RETIRED+tag@example.test', 'second@example.test', 'retired@alternate.test', 'retired+tag@alternate.test']) assert.deepEqual(graph.resolve(recipient).targets, [owner]);
  const plan = await inspect(f);
  assert.equal(plan.ready, true); assert.deepEqual(plan.keys, ['first@example.test', owner, 'retired@alternate.test', 'second@example.test'].sort());
  assert.deepEqual(f.routing.assertReady(plan), plan.keys); assert.deepEqual(plan.changes, []); assert.equal(f.calls.filter(row => row.method !== 'GET').length, 0);
});
test('retirement routes: nested mixed aliases prune the leaf, preserving upstream and healthy recipients', async () => {
  const f = fixture(); f.facts.aliases.push(alias('leaf@example.test', [owner, healthy]), alias('outer@example.test', 'leaf@example.test'));
  const plan = await inspect(f); assert.equal(plan.canPrepare, true); assert.equal(plan.ready, false);
  assert.deepEqual(plan.changes.map(row => row.address), ['leaf@example.test']);
  assert.deepEqual(plan.changes[0].remove, [owner]); assert.deepEqual(plan.changes[0].keep, [healthy]);
  assert.throws(() => f.routing.assertReady(plan), { statusCode: 409 });
  f.facts.aliases.find(row => row.address === 'leaf@example.test').goto = healthy;
  const fresh = await inspect(f); assert.equal(fresh.ready, true); assert.notEqual(fresh.etag, plan.etag);
});
test('retirement routes: pure downstream alias is kept as a reject key; mixed parent drops only that edge', async () => {
  const f = fixture(); f.facts.aliases.push(alias('pure@example.test', owner), alias('mixed@example.test', ['pure@example.test', healthy]));
  const plan = await inspect(f); assert.ok(plan.keys.includes('pure@example.test')); assert.ok(!plan.keys.includes('mixed@example.test'));
  assert.deepEqual(plan.changes[0].remove, ['pure@example.test']); assert.deepEqual(plan.changes[0].keep, [healthy]);
});
test('retirement routes: discard leaves are not healthy recipients and cannot turn cleanup into silent dropping', async () => {
  const f = fixture(); f.facts.aliases.push(alias('only-retired@example.test', [owner, 'null@localhost']), alias('discard-only@example.test', 'null@localhost'));
  const plan = await inspect(f); assert.equal(plan.ready, true); assert.ok(plan.keys.includes('only-retired@example.test'));
  assert.ok(!plan.keys.includes('discard-only@example.test')); assert.deepEqual(plan.changes, []);
  assert.deepEqual(createRetirementGraph(f.facts).resolve('null@localhost').targets, []);
  f.filters.push(filter(`require ["copy"];\nredirect :copy "${owner}";\nredirect :copy "null@localhost";\n`));
  const teamPlan = await inspect(f); assert.ok(codes(teamPlan).includes('LAST_TEAM_MEMBER')); assert.deepEqual(teamPlan.changes, []);
});
test('retirement routes: pure catch-all blocks ON, mixed catch-all proposes only target removal', async () => {
  const f = fixture(); f.facts.aliases.push(alias('@example.test', owner));
  let plan = await inspect(f); assert.ok(codes(plan).includes('CATCH_ALL_TARGET')); assert.ok(!plan.keys.includes('@example.test'));
  f.facts.aliases.at(-1).goto = [owner, healthy]; plan = await inspect(f);
  assert.equal(plan.canPrepare, true); assert.deepEqual(plan.changes[0].keep, [healthy]); assert.equal(plan.changes[0].address, '@example.test');
});
test('retirement routes: alias loops and unknown internal leaves block instead of silently becoming healthy', async () => {
  const f = fixture(); f.facts.aliases.push(alias('a@example.test', 'b@example.test'), alias('b@example.test', ['a@example.test', owner]));
  assert.ok(codes(await inspect(f)).includes('ALIAS_LOOP'));
  f.facts.aliases.splice(-2, 2, alias('unknown@example.test', [owner, 'missing@example.test']));
  assert.ok(codes(await inspect(f)).includes('UNRESOLVED_INTERNAL'));
});
test('retirement routes: plus override and alias-domain normal-delivery collisions block ON', async () => {
  const f = fixture(); f.facts.aliases.push(alias('retired+special@example.test', healthy));
  assert.ok(codes(await inspect(f)).includes('PLUS_ADDRESS_CONFLICT'));
  f.facts.aliases.pop(); f.facts.aliasDomains.push({ alias_domain: 'alternate.test', target_domain: 'example.test', active: 1 });
  f.facts.aliases.push(alias('retired@alternate.test', healthy));
  assert.ok(codes(await inspect(f)).includes('RECIPIENT_KEY_CONFLICT'));
});
test('retirement routes: inactive aliases and alias-domains do not create rejection keys', async () => {
  const f = fixture(); f.facts.aliases.push(alias('inactive@example.test', owner, { active: 0 }));
  f.facts.aliasDomains.push({ alias_domain: 'off.test', target_domain: 'example.test', active: 0 });
  assert.deepEqual((await inspect(f)).keys, [owner]);
});
test('retirement routes: initial active mailbox can preview, but only active=2 can be ready for blocking', async () => {
  const f = fixture(); f.facts.mailboxes[0].active = 1;
  const plan = await inspect(f); assert.equal(plan.accountActive, 1); assert.equal(plan.canPrepare, true); assert.equal(plan.ready, false);
  assert.throws(() => f.routing.assertReady(plan), { statusCode: 409, code: 'RETIREMENT_STATE_CONFLICT' });
  f.facts.mailboxes[0].active = 0; await assert.rejects(inspect(f), { statusCode: 409 });
});
test('retirement routes: explicit tagged mailbox is protected from base-address overblocking', async () => {
  const f = fixture(); f.facts.mailboxes.push(box('retired+separate@example.test'));
  assert.ok(codes(await inspect(f)).includes('PLUS_ADDRESS_CONFLICT'));
});
test('retirement routes: managed top-level copy prefilter produces safe team removal; last member blocks', async () => {
  const f = fixture(); f.filters.push(filter(`require ["copy"];\nredirect :copy "${owner}";\nredirect :copy "${healthy}";\n`));
  let plan = await inspect(f); assert.equal(plan.canPrepare, true); assert.deepEqual(plan.changes.map(row => row.kind), ['team']);
  assert.deepEqual(plan.changes[0].remove, [owner]); assert.ok(plan.changes[0].etag); assert.equal(JSON.stringify(plan).includes('redirect :copy'), false);
  f.facts.mailboxes.find(row => row.username === team).active = 2;
  const inactiveOwner = await inspect(f); assert.ok(codes(inactiveOwner).includes('TEAM_UNEDITABLE')); assert.deepEqual(inactiveOwner.changes, []);
  f.facts.mailboxes.find(row => row.username === team).active = 1;
  f.filters[0].script_data = `require ["copy"];\nredirect :copy "${owner}";\n`;
  assert.ok(codes(await inspect(f)).includes('LAST_TEAM_MEMBER'));
});
test('retirement routes: member-alias cleanup carries team revision; pure last bundle blocks', async () => {
  const f = fixture(), bundle = 'members@example.test';
  f.facts.aliases.push(alias(bundle, [owner, healthy], { private_comment: 'mailadmin:team-members' }));
  f.filters.push(filter(`require ["copy"];\nredirect :copy "${bundle}";\n`));
  let plan = await inspect(f); assert.equal(plan.canPrepare, true); assert.equal(plan.changes[0].kind, 'team-member-alias'); assert.equal(plan.changes[0].team, team);
  f.facts.aliases.at(-1).goto = owner; plan = await inspect(f); assert.ok(codes(plan).includes('LAST_TEAM_MEMBER'));
});
test('retirement routes: member-alias editing refuses multiple active prefilters and inactive bundle semantics', async () => {
  const f = fixture(), bundle = 'members@example.test';
  f.facts.aliases.push(alias(bundle, [owner, healthy], { private_comment: 'mailadmin:team-members' }));
  f.filters.push(filter(`require ["copy"];\nredirect :copy "${bundle}";\n`),filter('keep;', 'prefilter', team, '2'));
  const multiple = await inspect(f); assert.ok(codes(multiple).includes('TEAM_ALIAS_UNEDITABLE')); assert.deepEqual(multiple.changes, []);
  f.filters.pop(); f.facts.aliases.at(-1).active = 2;
  assert.ok(codes(await inspect(f)).includes('TEAM_ALIAS_UNEDITABLE'));
});
test('retirement routes: conditional or move prefilter is a blocker, never an auto-edit proposal', async () => {
  for (const source of [`if true { redirect :copy "${owner}"; }`, `redirect "${owner}";`]) {
    const f = fixture(); f.filters.push(filter(source)); const plan = await inspect(f);
    assert.ok(codes(plan).includes('TEAM_UNEDITABLE')); assert.deepEqual(plan.changes, []);
  }
});
test('retirement routes: user, admin post and both global stages are scanned, including custom active script', async () => {
  const f = fixture(); f.filters.push(filter(`redirect :copy "${owner}";`, 'postfilter'));
  f.globals.prefilter = `redirect "${owner}";`; f.globals.postfilter = `redirect :copy "${owner}";`;
  f.scripts.set(healthy, `redirect :copy "${owner}";`); f.names.set(healthy, [{ name: 'custom-active', active: true }]);
  const plan = await inspect(f); assert.equal(plan.blockers.filter(row => row.code === 'FILTER_TARGET_REMAINS').length, 4);
  assert.deepEqual(plan.changes, []); assert.ok(plan.inspected.some(row => row.source === 'user' && row.address === healthy));
  assert.deepEqual(plan.inspected.map(row => row.order), [1, 3, 4, 5]);
});
test('retirement routes: unreadable active scripts, name/source mismatch and global include all block ON', async () => {
  const f = fixture(); f.options.failUser = healthy; f.globals.postfilter = 'include "opaque";';
  const first = await inspect(f); assert.ok(codes(first).includes('USER_SCRIPT_UNAVAILABLE')); assert.ok(codes(first).includes('FILTER_UNINSPECTABLE'));
  assert.equal(first.checkedMailboxes, 2); assert.equal(first.totalMailboxes, 3);
  assert.ok(!JSON.stringify(first).includes('synthetic source text'));
  delete f.options.failUser; f.globals.postfilter = ''; f.names.set(healthy, [{ name: 'missing', active: true }]);
  assert.ok(codes(await inspect(f)).includes('USER_SCRIPT_UNAVAILABLE'));
  f.names.clear(); f.globals.postfilter = 'redirect "invalid@bad..test";';
  assert.ok(codes(await inspect(f)).includes('FILTER_ROUTE_UNKNOWN'));
});
test('retirement routes: filters routing to a cleaned mixed alias become safe only after cleanup and rescan', async () => {
  const f = fixture(); f.facts.aliases.push(alias('mix@example.test', [owner, healthy]));
  f.globals.postfilter = 'redirect "mix@example.test";';
  let plan = await inspect(f); assert.equal(plan.canPrepare, true); assert.equal(plan.ready, false);
  f.facts.aliases.at(-1).goto = healthy; plan = await inspect(f); assert.equal(plan.ready, true);
});
test('retirement routes: owner forwarding is a blocker without auto-edits; unrelated global forwarding keeps its incoming meaning', async () => {
  const f = fixture(); f.filters.push(filter(`redirect :copy "${healthy}";`, 'prefilter', owner));
  let plan = await inspect(f); assert.ok(codes(plan).includes('OWNER_FORWARD_ACTIVE')); assert.deepEqual(plan.changes, []);
  f.filters.length = 0; f.scripts.set(owner, `redirect "${healthy}";`); f.names.set(owner, [{ name: 'personal', active: true }]);
  plan = await inspect(f); assert.ok(codes(plan).includes('OWNER_FORWARD_ACTIVE'));
  f.scripts.clear(); f.names.clear(); f.globals.postfilter = `redirect :copy "${healthy}";`;
  plan = await inspect(f); assert.equal(plan.ready, true); assert.ok(!codes(plan).includes('OWNER_FORWARD_ACTIVE'));
});
test('retirement routes: at most four active-user inspections; inactive mailbox skipped and source changes invalidate etag', async () => {
  const f = fixture(); f.facts.mailboxes.push(...Array.from({ length: 6 }, (_, i) => box(`u${i}@example.test`)), box('off@example.test', 0));
  const first = await inspect(f); assert.equal(f.peak, 4); assert.equal(first.checkedMailboxes, 9); assert.ok(!f.calls.some(row => row.path.includes('off%40')));
  f.globals.prefilter = '# changed\nkeep;'; assert.notEqual((await inspect(f)).etag, first.etag);
});
test('retirement routes: API row order does not alter the plan or optimistic version', async () => {
  const f = fixture(), second = 'team2@example.test'; f.facts.mailboxes.push(box(second));
  f.facts.aliases.push(alias('extra@example.test', owner));
  for (const [index, address] of [team, second].entries()) f.filters.push(filter(`require ["copy"];\nredirect :copy "${owner}";\nredirect :copy "${healthy}";\n`, 'prefilter', address, String(index + 1)));
  const before = await inspect(f); f.facts.mailboxes.reverse(); f.facts.aliases.reverse(); f.filters.reverse();
  const after = await inspect(f); assert.equal(after.etag,before.etag); assert.deepEqual(after.changes,before.changes);
});
test('retirement routes: session authentication loss propagates 403; malformed global response is unavailable', async () => {
  const f = fixture(), lost = new MailcowAuthLost(); f.options.onCall = path => { if (path.includes('active-user-sieve')) throw lost; };
  await assert.rejects(inspect(f), error => error === lost && error.statusCode === 403);
  delete f.options.onCall; f.globals.prefilter = null; await assert.rejects(inspect(f), { statusCode: 503 });
});
test('retirement routes: recipient/script guards and lock failure stop before the write callback', async () => {
  const f = fixture();
  await assert.rejects(f.routing.assertScript(`redirect :copy "${owner}";`), { statusCode: 409, code: 'RETIREMENT_RECIPIENT_BLOCKED' });
  assert.deepEqual(f.dbCalls, [[owner]]);
  f.options.dbError = new AppError(503,'RETIREMENT_BLOCK_UNAVAILABLE','unavailable');
  await assert.rejects(f.routing.assertRecipients([healthy]), { statusCode: 503 });
  f.options.lockError = new AppError(503,'RETIREMENT_BLOCK_UNAVAILABLE','busy'); let writes = 0;
  await assert.rejects(f.routing.withRoutingLock(() => { writes++; }), { statusCode: 503 }); assert.equal(writes, 0); assert.equal(f.lockCalls, 1);
});

test('retirement writes: projected alias chains and alias-domain namespaces cannot introduce a blocked recipient', async () => {
  const f = fixture();
  for (const mutation of [
    { kind: 'alias', address: 'new@example.test', after: alias('new@example.test', owner) },
    { kind: 'alias', address: 'new@example.test', after: alias('new@example.test', 'retired+tag@example.test') },
    { kind: 'alias-domain', address: 'new.test', after: { alias_domain: 'new.test', target_domain: 'example.test', active: 1 } },
    { kind: 'domain', address: 'example.test', after: { active: 0 } },
    { kind: 'mailbox', address: owner, after: { active: 1 } },
  ]) await assert.rejects(f.routing.assertMutation({}, mutation), { statusCode: 409, code: 'RETIREMENT_ROUTE_PROTECTED' });
  assert.equal(f.calls.filter(row => row.method !== 'GET').length, 0);
});

test('retirement writes: a fresh alias-domain is rejected even though its new envelope key is not in the DB', async () => {
  const f = fixture();
  await assert.rejects(f.routing.assertMutation({}, { kind: 'alias-domain', address: 'new.test', after: { alias_domain: 'new.test', target_domain: 'example.test', active: 1 } }), error => error.code === 'RETIREMENT_ROUTE_PROTECTED' && error.message.includes('먼저 해당 계정의 수신 차단을 끄세요'));
  assert.ok(f.dbCalls.at(-1).includes(owner)); assert.ok(f.dbCalls.at(-1).includes('retired@new.test'));
});

test('retirement writes: protected alias cannot be deleted or reassigned; unrelated healthy aliases still work', async () => {
  const f = fixture(), protectedAlias = 'protected@example.test'; f.facts.aliases.push(alias(protectedAlias, owner));
  f.store.blockedRecipients = async addresses => addresses.filter(value => [owner, protectedAlias].includes(value));
  for (const after of [null, alias(protectedAlias, healthy)]) await assert.rejects(f.routing.assertMutation({}, { kind: 'alias', address: protectedAlias, after }), { code: 'RETIREMENT_ROUTE_PROTECTED' });
  await f.routing.assertMutation({}, { kind: 'alias', address: 'new@example.test', after: alias('new@example.test', healthy) });
  await f.routing.assertMutation({}, { kind: 'alias', address: protectedAlias, after: { ...f.facts.aliases.at(-1), sender_allowed: '1' } });
});

test('retirement writes: projected fallback captures, reactivation and indirect targets are guarded', async () => {
  const f = fixture(); f.facts.aliasDomains.push({ alias_domain: 'alternate.test', target_domain: 'example.test', active: 1 });
  f.facts.aliases.push(alias('retired@alternate.test', healthy), alias('first@example.test', owner));
  await assert.rejects(f.routing.assertMutation({}, { kind: 'alias', address: 'retired@alternate.test', after: null }), { code: 'RETIREMENT_ROUTE_PROTECTED' });
  await assert.rejects(f.routing.assertMutation({}, { kind: 'alias', address: 'new@example.test', after: alias('new@example.test', 'first@example.test') }), { code: 'RETIREMENT_ROUTE_PROTECTED' });
  f.facts.aliasDomains[0].active = 0;
  f.facts.aliases = f.facts.aliases.filter(row => row.address !== 'retired@alternate.test');
  await assert.rejects(f.routing.assertMutation({}, { kind: 'alias-domain', address: 'alternate.test', after: { active: 1 } }), { code: 'RETIREMENT_ROUTE_PROTECTED' });
});

test('retirement writes: admin script guards target chains and the blocked owner before enabling forwarding', async () => {
  const f = fixture(); f.facts.aliases.push(alias('indirect@example.test', owner));
  for (const [target, sender] of [[owner, healthy], ['retired+tag@example.test', healthy], ['indirect@example.test', healthy], [healthy, owner]]) {
    await assert.rejects(f.routing.assertAdminScript({}, `redirect :copy "${target}";`, sender), { code: 'RETIREMENT_ROUTE_PROTECTED' });
  }
  await f.routing.assertAdminScript({}, 'discard;', owner);
  await f.routing.assertAdminScript({}, `redirect :copy "${healthy}";`, team);
  await assert.rejects(f.routing.assertAdminScript({}, 'include "dynamic";', healthy), { code: 'FILTER_UNINSPECTABLE' });
});

test('retirement writes: DB failure propagates and healthy removal does not require invented recipients', async () => {
  const f = fixture(); await f.routing.assertMutation({}, { kind: 'alias', address: healthy, after: null });
  f.options.dbError = new AppError(503, 'RETIREMENT_BLOCK_UNAVAILABLE', 'unavailable');
  await assert.rejects(f.routing.assertMutation({}, { kind: 'alias', address: 'new@example.test', after: alias('new@example.test', healthy) }), { statusCode: 503 });
  await assert.rejects(f.routing.assertAdminScript({}, `redirect :copy "${healthy}";`, team), { statusCode: 503 });
});

test('retirement writes: unresolved literal compatibility does not change the ON inspection blockers', async () => {
  const f = fixture();
  await f.routing.assertMutation({}, { kind: 'alias', address: 'future@example.test', after: alias('future@example.test', 'not-created@example.test') });
  await f.routing.assertAdminScript({}, 'redirect :copy "not-created@example.test";', healthy);
  f.filters.push(filter('redirect :copy "not-created@example.test";'));
  assert.ok(codes(await inspect(f)).includes('FILTER_ROUTE_UNKNOWN'));
  f.store.blockedRecipients = async values => values.filter(value => value === 'not-created@example.test');
  await assert.rejects(f.routing.assertMutation({}, { kind: 'alias', address: 'future@example.test', after: alias('future@example.test', 'not-created@example.test') }), { code: 'RETIREMENT_ROUTE_PROTECTED' });
});

test('retirement writes: a new alias-domain cannot activate a previously external alias cycle', async () => {
  const f = fixture(); f.facts.aliases[0].goto = 'retired@loop.test'; f.store.blockedRecipients = async () => [];
  await assert.rejects(f.routing.assertMutation({}, { kind: 'alias-domain', address: 'loop.test', after: { target_domain: 'example.test', active: 1 } }), { statusCode: 409, code: 'RETIREMENT_ROUTES_REMAIN' });
});
