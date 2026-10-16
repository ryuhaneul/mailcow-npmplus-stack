import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAliasesService } from '../../server/admin/services/aliases.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';

const alias = 'alias@example.com', first = 'first@example.com', second = 'second@example.com', unrelated = 'other@example.com';
const meta = (address, goto) => ({ id: address, address, goto, active: '1', sender_allowed: '0', sogo_visible: '1', internal: '0', public_comment: '공개 설명', private_comment: '내부 설명' });
const context = { session: {}, actor: 'admin', ip: '198.51.100.31' };
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a10-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const aliases = [meta(alias, first)], boxes = [{ username: first, sender_acl: [alias, unrelated] }, { username: second, sender_acl: [unrelated] }];
  const primary = [{ domain_name: 'example.com', active: 1 }, { domain_name: 'inactive.example.com', active: 0 }];
  const aliasDomains = [{ alias_domain: 'alias.example.com', target_domain: 'example.com', active: 1 }, { alias_domain: 'off.example.com', target_domain: 'example.com', active: 0 }, { alias_domain: 'bad.example.com', target_domain: 'inactive.example.com', active: 1 }];
  const calls = [], options = {}; let sequence = 0;
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); await options.onCall?.({ method, path, body });
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/alias/all') return structuredClone(aliases);
    if (path === '/api/v1/get/mailbox/all') return structuredClone(boxes);
    if (path === '/api/v1/get/domain/all') return structuredClone(primary);
    if (path === '/api/v1/get/alias-domain/all') return structuredClone(aliasDomains);
    if (options.ignoreWrites) return [{ type: 'success' }];
    if (path === '/api/v1/add/alias') aliases.push({ ...meta(body.address, body.goto), ...body, id: `new-${sequence++}` });
    else if (path === '/api/v1/edit/alias') {
      const row = aliases.find(item => String(item.id) === body.items[0]); Object.assign(row, body.attr);
      // mailcow 2026-09a functions.mailbox.inc.php:2752 removes explicit duplicate grants for new targets.
      for (const box of boxes) if (row.goto.split(',').includes(box.username)) box.sender_acl = box.sender_acl.filter(value => value !== row.address);
    } else if (path === '/api/v1/delete/alias') {
      const row = aliases.find(item => String(item.id) === body[0]); aliases.splice(aliases.indexOf(row), 1);
      for (const box of boxes) box.sender_acl = box.sender_acl.filter(value => value !== row.address);
    } else if (path === '/api/v1/edit/mailbox') for (const address of body.items) {
      // mailcow functions.mailbox.inc.php:3409,4315 skips aliases already allowed by sender_allowed.
      const fixed = new Set(aliases.filter(row => !row.address.startsWith('@') && row.sender_allowed === '1' && row.goto.split(',').includes(address)).map(row => row.address));
      boxes.find(box => box.username === address).sender_acl = body.attr.sender_acl.filter(value => !fixed.has(value));
    }
    else assert.fail(path);
    return [{ type: 'success' }];
  } };
  const audit = createAudit({ dir }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const service = createAliasesService({ mailcow, audit, lock, history });
  return { dir, aliases, boxes, primary, aliasDomains, calls, options, mailcow, audit, lock, history, service };
}
const item = async (f, address = alias) => (await f.service.list({}, { q: address })).items.find(row => row.address === address);
const edit = (f, etag, data = {}, address = alias) => f.service.edit({ ...context, addr: address, data: { etag, ...data } });
const remove = (f, etag, data = {}, address = alias) => f.service.remove({ ...context, addr: address, data: { etag, confirmAddress: address, ...data } });
const create = (f, data = {}) => f.service.create({ ...context, data: { address: 'new@example.com', targets: [first], ...data } });
const writes = f => f.calls.filter(call => call.method === 'POST');
const revert = (f, id) => f.history.revert(id, { ...context, confirm: true });

test('aliases: list projects metadata, searches, reverse references, pages and permission-aware etag', async t => {
  const f = await fixture(t); for (let i = 0; i < 55; i++) f.aliases.push(meta(`a${i}@example.com`, second));
  const result = await f.service.list({}); assert.equal(result.items.length, 50); assert.equal(result.pageSize, 50); assert.equal((await f.service.list({}, { page: '2' })).items.length, 6);
  const found = await f.service.list({}, { target: first }); assert.equal(found.total, 1); assert.equal(found.items[0].address, alias);
  assert.equal(found.items[0].metadata.privateComment, '내부 설명'); assert.equal((await f.service.list({}, { q: 'alias@' })).total, 1);
  const revision = found.items[0].etag; f.boxes[0].sender_acl.push('extra@example.com'); assert.notEqual((await item(f)).etag, revision);
});

for (const target of ['outside@example.net', 'user@inactive.example.com', 'user@off.example.com', 'user@bad.example.com']) test(`aliases: rejects external or inactive target ${target}`, async t => {
  const f = await fixture(t); await assert.rejects(create(f, { targets: [target] }), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});

test('aliases: active alias domain pointing at active primary is internal', async t => {
  const f = await fixture(t), result = await create(f, { targets: ['user@alias.example.com'] }); assert.deepEqual(result.targets, ['user@alias.example.com']);
});

test('aliases: discard stores null@localhost and permits flags-only PATCH, normal writes cannot use the special target', async t => {
  const f = await fixture(t), result = await create(f, { discard: true, targets: [] }); assert.equal(result.discard, true); assert.deepEqual(result.targets, ['null@localhost']);
  assert.equal(writes(f).find(call => call.path === '/api/v1/add/alias').body.goto_null, '1');
  const edited = await edit(f, result.etag, { active: false }, result.address); assert.equal(edited.active, false);
  assert.equal(writes(f).find(call => call.path === '/api/v1/edit/alias').body.attr.goto_null, '1');
  await assert.rejects(create(f, { address: 'bad@example.com', targets: ['null@localhost'] }), { statusCode: 422 });
  await assert.rejects(edit(f, edited.etag, { targets: [first], mode: 'both' }, result.address), { statusCode: 422 });
  assert.equal((await edit(f, edited.etag, { targets: [first], mode: 'move' }, result.address)).discard, false);
});

test('aliases: both unions targets, move replaces, flags preserve metadata and reflect mailcow fixed sender grants', async t => {
  const f = await fixture(t), initial = await item(f);
  const both = await edit(f, initial.etag, { targets: [second, first], mode: 'both', sendAllowed: true }); assert.deepEqual(both.targets, [first, second]); assert.equal(both.sendAllowed, true);
  assert.deepEqual(f.boxes[0].sender_acl, [unrelated]);
  assert.equal(both.metadata.privateComment, '내부 설명');
  const moved = await edit(f, both.etag, { targets: [second], mode: 'move', active: false }); assert.deepEqual(moved.targets, [second]); assert.equal(moved.active, false);
  assert.deepEqual(f.boxes[0].sender_acl, [unrelated]); assert.equal(f.aliases[0].sender_allowed, '1');
});

for (const data of [{ targets: [], mode: 'move' }, { targets: [second] }, { mode: 'bad', active: true }, { active: 1 }, { sendAllowed: 'yes' }]) test(`aliases: invalid PATCH ${JSON.stringify(data)} does not mutate`, async t => {
  const f = await fixture(t); await assert.rejects(edit(f, (await item(f)).etag, data), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});

test('aliases: stale etag blocks PATCH/delete and confirmation must exactly match address', async t => {
  const f = await fixture(t); await assert.rejects(edit(f, 'stale', { active: false }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  await assert.rejects(remove(f, 'stale'), { statusCode: 409 }); await assert.rejects(remove(f, (await item(f)).etag, { confirmAddress: first }), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});

test('aliases: unchanged state returns unchanged without write or audit record', async t => {
  const f = await fixture(t); const result = await edit(f, (await item(f)).etag, { targets: [first], mode: 'move', sendAllowed: false, active: true });
  assert.equal(result.unchanged, true); assert.equal(writes(f).length, 0); assert.equal((await f.audit.read()).rows.length, 0);
});

test('aliases: create and edit are reversible with metadata and permission checks', async t => {
  const f = await fixture(t); const created = await create(f); await revert(f, created.auditId); assert.equal(await item(f, created.address), undefined);
  const edited = await edit(f, (await item(f)).etag, { targets: [second], mode: 'move', sendAllowed: true });
  await revert(f, edited.auditId); assert.deepEqual((await item(f)).targets, [first]); assert.equal((await item(f)).sendAllowed, false); assert.deepEqual(f.boxes[0].sender_acl, [alias, unrelated]);
});

test('aliases: delete is config/revertible and recreates all metadata plus explicit sender permissions', async t => {
  const f = await fixture(t), original = await item(f), result = await remove(f, original.etag);
  assert.equal(result.deleted, true); assert.deepEqual(f.boxes[0].sender_acl, [unrelated]);
  const record = await f.history.detail(result.auditId); assert.equal(record.kind, 'config'); assert.equal(record.canRevert, true);
  assert.equal(record.before.alias.private_comment, '내부 설명'); await revert(f, result.auditId);
  const restored = await item(f); assert.deepEqual(restored.targets, original.targets); assert.deepEqual(restored.metadata, original.metadata); assert.deepEqual(f.boxes[0].sender_acl, [alias, unrelated]);
});

test('aliases: unrelated permission changes on original grantee after deletion block restoration instead of overwriting', async t => {
  const f = await fixture(t), removed = await remove(f, (await item(f)).etag); f.boxes[0].sender_acl.push('extra@example.com'); const count = writes(f).length;
  await assert.rejects(revert(f, removed.auditId), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, count); assert.equal(await item(f), undefined);
});

test('aliases: permission added after create blocks undo deletion', async t => {
  const f = await fixture(t), created = await create(f); f.boxes[1].sender_acl.push(created.address); const count = writes(f).length;
  await assert.rejects(revert(f, created.auditId), { statusCode: 409 }); assert.equal(writes(f).length, count);
});

test('aliases: unsafe external/cycle deletion is not revertible and records reason', async t => {
  const f = await fixture(t); f.aliases[0].goto = 'outside@example.net'; const removed = await remove(f, (await item(f)).etag);
  const record = await f.history.detail(removed.auditId); assert.equal(record.canRevert, false); assert.equal(record.detail.reason, '정책 위반 별칭이라 되돌리기 없음');
  await assert.rejects(revert(f, removed.auditId), { statusCode: 409 });
  f.aliases.push(meta('loop@example.com', 'loop@example.com')); const removedLoop = await remove(f, (await item(f, 'loop@example.com')).etag, {}, 'loop@example.com');
  assert.equal((await f.history.detail(removedLoop.auditId)).canRevert, false);
});

test('aliases: catch-all can be listed, checked, deleted and restored, but cannot be newly created', async t => {
  const f = await fixture(t); f.aliases.push(meta('@example.com', first));
  await assert.rejects(create(f, { address: '@example.com' }), { statusCode: 422 });
  const removed = await remove(f, (await item(f, '@example.com')).etag, {}, '@example.com'); assert.equal((await f.history.detail(removed.auditId)).canRevert, true);
  await revert(f, removed.auditId); assert.equal((await item(f, '@example.com')).address, '@example.com');
});

test('aliases: POST/PATCH reject active loops and routes entering an existing loop; disabling a loop is allowed', async t => {
  const f = await fixture(t); f.aliases.push(meta('b@example.com', alias));
  await assert.rejects(edit(f, (await item(f)).etag, { targets: ['b@example.com'], mode: 'move' }), { code: 'ALIAS_LOOP', statusCode: 409 });
  f.aliases[0].goto = 'b@example.com'; await assert.rejects(create(f, { targets: [alias] }), { code: 'ALIAS_LOOP' });
  const disabled = await edit(f, (await item(f)).etag, { active: false }); assert.equal(disabled.active, false);
});

test('aliases: checks report external, active and latent cycles, and catch-all', async t => {
  const f = await fixture(t); f.aliases.push(meta('outside@example.com', 'remote@example.net'), meta('a@example.com', 'b@example.com'), meta('b@example.com', 'a@example.com'),
    { ...meta('c@example.com', 'd@example.com'), active: '0' }, meta('d@example.com', 'c@example.com'), meta('@example.com', first), meta('discard@example.com', 'null@localhost'));
  const result = await f.service.checks({}); assert.deepEqual(result.external.map(row => row.target), ['remote@example.net']);
  assert.deepEqual(result.cycles, [{ addresses: ['a@example.com', 'b@example.com'], active: true }, { addresses: ['c@example.com', 'd@example.com'], active: false }]);
  assert.equal(result.catchAll[0].address, '@example.com');
});

test('aliases: alias-domain target fallback participates in cycle detection', async t => {
  const f = await fixture(t); f.aliases[0].goto = 'b@example.com'; f.aliases.push(meta('b@example.com', 'alias@alias.example.com'));
  assert.equal((await f.service.checks({})).cycles[0].active, true);
});

test('aliases: failed intent prevents mutation and post-write mismatch returns 502', async t => {
  const f = await fixture(t); f.options.ignoreWrites = true;
  await assert.rejects(edit(f, (await item(f)).etag, { targets: [second], mode: 'move' }), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
  f.options.ignoreWrites = false; await fs.rm(f.dir, { recursive: true }); await fs.writeFile(f.dir, 'synthetic-blocker'); const count = writes(f).length;
  await assert.rejects(create(f), { statusCode: 500, code: 'AUDIT_UNAVAILABLE' }); assert.equal(writes(f).length, count);
});

test('aliases: concurrent stale PATCH serializes and only first changes target', async t => {
  const f = await fixture(t), initial = await item(f), results = await Promise.allSettled([edit(f, initial.etag, { targets: [second], mode: 'move' }), edit(f, initial.etag, { active: false })]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.code, 'CHANGED_ELSEWHERE');
});

test('aliases HTTP: list/checks and mutation use admin guard, 403 without challenge and no-store responses', async t => {
  const f = await fixture(t); const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: false,
    auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  assert.equal((await app.inject('/api/admin/aliases')).statusCode, 403);
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  const listed = await app.inject({ url: '/api/admin/aliases?target=first%40example.com', headers }); assert.equal(listed.statusCode, 200, listed.body);
  const denied = await app.inject({ method: 'PATCH', url: `/api/admin/aliases/${alias}`, headers: { ...headers, 'x-mailadmin-csrf': '' }, payload: { etag: listed.json().items[0].etag, active: false } }); assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
  const edited = await app.inject({ method: 'PATCH', url: `/api/admin/aliases/${alias}`, headers, payload: { etag: listed.json().items[0].etag, sendAllowed: true } }); assert.equal(edited.statusCode, 200, edited.body);
  const checks = await app.inject({ url: '/api/admin/checks/aliases', headers }); assert.equal(checks.statusCode, 200, checks.body); assert.equal(checks.headers['cache-control'], 'no-store');
});

test('aliases: a change during policy validation is rechecked after durable intent and before the upstream write', async t => {
  const f = await fixture(t), initial = await item(f); let reads = 0;
  f.options.onCall = ({ path }) => { if (path === '/api/v1/get/domain/all' && ++reads === 2) f.aliases[0].goto = second; };
  await assert.rejects(edit(f, initial.etag, { sendAllowed: true }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  assert.equal(writes(f).length, 0); assert.equal(f.aliases[0].goto, second);
});

test('aliases: POST existing alias/mailbox returns ADDRESS_IN_USE and DELETE missing alias returns NOT_FOUND', async t => {
  const f = await fixture(t);
  for (const address of [alias, first]) await assert.rejects(create(f, { address }), { statusCode: 409, code: 'ADDRESS_IN_USE' });
  await assert.rejects(remove(f, 'stale', {}, 'missing@example.com'), { statusCode: 404, code: 'NOT_FOUND' });
  assert.equal(writes(f).length, 0);
});


test('aliases: enabling sendAllowed with an explicit grant succeeds, records stored ACL and reverts', async t => {
  const f = await fixture(t), before = await item(f);
  const result = await edit(f, before.etag, { sendAllowed: true });
  assert.equal(result.sendAllowed, true); assert.deepEqual(f.boxes[0].sender_acl, [unrelated]);
  const record = await f.history.detail(result.auditId);
  assert.equal(record.result, 'ok'); assert.equal(record.canRevert, true);
  assert.deepEqual(record.before.senders, [{ mailbox: first, senderAcl: [alias, unrelated] }]);
  assert.deepEqual(record.after.senders, [{ mailbox: first, senderAcl: [unrelated] }]);
  await revert(f, result.auditId);
  assert.equal((await item(f)).sendAllowed, false); assert.deepEqual(f.boxes[0].sender_acl, [alias, unrelated]);
  const undo = (await f.history.list()).items.find(row => row.revertOf === result.auditId);
  assert.equal(undo.result, 'ok');
  await revert(f, undo.id); assert.equal((await item(f)).sendAllowed, true); assert.deepEqual(f.boxes[0].sender_acl, [unrelated]);
});

test('aliases: an original fixed-allowed duplicate cannot be restored and is recorded as non-revertible', async t => {
  const f = await fixture(t); f.aliases[0].sender_allowed = '1';
  const result = await edit(f, (await item(f)).etag, { active: false });
  assert.deepEqual(f.boxes[0].sender_acl, [unrelated]);
  const record = await f.history.detail(result.auditId);
  assert.equal(record.result, 'ok'); assert.equal(record.canRevert, false);
  await assert.rejects(revert(f, result.auditId), { code: 'NOT_REVERTIBLE' });
});

test('aliases: catch-all loop through a missing address is rejected and reported, mailbox delivery terminates', async t => {
  const f = await fixture(t); f.aliases.push(meta('@example.com', alias));
  assert.deepEqual((await f.service.checks({})).cycles, []);
  const before = await item(f);
  await assert.rejects(edit(f, before.etag, { targets: ['missing@example.com'], mode: 'move' }), { statusCode: 409, code: 'ALIAS_LOOP' });
  assert.equal(writes(f).length, 0); assert.equal(f.aliases[0].goto, first);
  f.aliases[0].goto = 'missing@example.com';
  assert.deepEqual((await f.service.checks({})).cycles, [{ addresses: ['@example.com', alias], active: true }]);
  f.aliases[0].goto = 'first@alias.example.com';
  assert.deepEqual((await f.service.checks({})).cycles, []);
  f.aliases[0].goto = 'missing@alias.example.com';
  assert.deepEqual((await f.service.checks({})).cycles, [{ addresses: ['@example.com', alias], active: true }]);
  f.aliases.push(meta('missing@example.com', second));
  assert.deepEqual((await f.service.checks({})).cycles, []);
});

test('aliases: edit and history undo share graph then target locks and reject the resulting loop', async t => {
  const f = await fixture(t), b = 'b@example.com';
  f.aliases[0].goto = b; f.aliases.push(meta(b, first));
  const changed = await edit(f, (await item(f)).etag, { targets: [first], mode: 'move' });
  const bState = await item(f, b);
  let reached, release;
  const writing = new Promise(resolve => { reached = resolve; });
  const permitted = new Promise(resolve => { release = resolve; });
  const baseRun = f.lock.run;
  f.options.onCall = async ({ method, path, body }) => {
    if (method === 'POST' && path === '/api/v1/edit/alias') {
      if (body.items[0] === b) { reached(); await permitted; }
      else release();
    }
  };
  const modifying = edit(f, bState.etag, { targets: [alias], mode: 'move' }, b);
  await writing;
  // Undo queues behind the graph lock; pre-fix undo instead releases B at its own upstream write.
  f.lock.run = (key, operation) => { if (key === 'alias-graph') release(); return baseRun(key, operation); };
  const undoing = revert(f, changed.auditId);
  const outcomes = await Promise.allSettled([modifying, undoing]);
  assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[1].reason.code, 'ALIAS_LOOP');
  assert.deepEqual((await f.service.checks({})).cycles, []);
  assert.equal(f.aliases[0].goto, first); assert.equal(f.aliases[1].goto, alias);
});
