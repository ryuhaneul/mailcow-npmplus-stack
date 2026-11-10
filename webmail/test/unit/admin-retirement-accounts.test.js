import { createAliasesService } from '../../server/admin/services/aliases.js';
import { emptyRetirementState, retirementVersion } from '../../server/security/retirement-store.js';
import { createRetirementRouting } from '../../server/admin/retirement-routing.js';
import { loadAdminConfig } from '../../server/admin/config.js';
import { createFakeProtocolNetlimitStore } from '../fixtures/protocol-netlimit.js';
import { createOtpAdminService } from '../../server/admin/services/otp.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountsService } from '../../server/admin/services/accounts.js';
import { createTeamsService } from '../../server/admin/services/teams.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';

const user = 'user@example.com', team = 'team@example.com', other = 'other@example.com', secret = 'synthetic-A07-sync-secret';
const source = `require ["copy"];\n# 원문 보존\nredirect :copy "${user}";\nredirect :copy "${other}";\nstop;\n`;
const context = { session: {}, actor: 'admin', ip: '198.51.100.23' };
const makeBox = username => ({ username, name: username, quota: 20 * 1024 ** 3, quota_used: 2048, messages: 12, active: 1, sender_acl: [], attributes: { imap_access: '1', pop3_access: '1', smtp_access: '1', sieve_access: '1', eas_access: '1', dav_access: '1' } });
async function fixture(t, populated = false) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a07-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const boxes = [user, team, other].map(makeBox), filters = [], aliases = [], jobs = [], acl = new Map(), calls = [], aclCalls = [], options = {};
  if (populated) {
    boxes[0].sender_acl = [team, 'archive@example.com']; boxes[2].sender_acl = [user, team];
    filters.push({ id: 10, username: team, filter_type: 'prefilter', active: 1, script_desc: '분배', script_data: source });
    aliases.push({ id: 1, address: 'only@example.com', goto: user, active: 1 }, { id: 2, address: 'multi@example.com', goto: `${user},${other}`, active: 1 });
    jobs.push({ id: 8, user2: user, active: 1, password1: secret, custom_params: '--synthetic' });
    acl.set(team, [{ user: team, id: user, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
    acl.set(user, [{ user, id: other, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
    // Individual mailbox sharing is included for deletion, beyond the normal detail scope.
    acl.set(other, [{ user: other, id: user, mailbox: 'INBOX', rights: ['lookup', 'read', 'write'] }]);
  }
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); options.onCall?.({ method, path, body });
    if (method === 'POST' && options.failPath === path) throw options.failure ?? new AppError(422, 'MAILCOW_REJECTED', secret);
    if (path === '/api/v1/edit/alias') await options.beforeAliasWrite?.();
    if (path === '/api/v1/get/global_filters/all') return {};
    if (path.startsWith('/api/v1/get/active-user-sieve/')) return options.userScript ? [options.userScript] : {};
    if (path === '/api/v1/get/domain/all') return [{ domain_name: 'example.com', active: 1 }];
    if (path === '/api/v1/get/alias-domain/all') return [];
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/mailbox/all') return structuredClone(boxes);
    if (path.startsWith('/api/v1/get/mailbox/')) return structuredClone(boxes.find(row => row.username === decodeURIComponent(path.split('/').at(-1))) ?? {});
    if (path === '/api/v1/get/filters/all') return structuredClone(filters);
    if (path === '/api/v1/get/alias/all') return structuredClone(aliases);
    if (path === '/api/v1/get/syncjobs/all/no_log') return structuredClone(jobs);
    if (path.startsWith('/api/v1/get/app-passwd/all/')) return [];
    if (options.ignoreWrites) return [{ type: 'success' }];
    if (path === '/api/v1/delete/alias') for (const id of body) aliases.splice(aliases.findIndex(row => String(row.id) === id), 1);
    else if (path === '/api/v1/add/alias') aliases.push({ id: 100 + aliases.length, ...body });
    else if (path === '/api/v1/edit/alias') for (const id of body.items) {
      const alias = aliases.find(row => String(row.id) === id); Object.assign(alias, body.attr);
      // mailcow deletes explicit alias grants for every supplied goto (functions.mailbox.inc.php:2752).
      if (Object.hasOwn(body.attr, 'goto')) for (const box of boxes) if (alias.goto.split(',').includes(box.username)) box.sender_acl = box.sender_acl.filter(value => value !== alias.address);
    } else if (path === '/api/v1/edit/filter') for (const id of body.items) Object.assign(filters.find(row => String(row.id) === id), body.attr);
    else if (path === '/api/v1/add/filter') filters.push({ id: 100 + filters.length, ...body });
    else if (path === '/api/v1/delete/filter') for (const id of body) filters.splice(filters.findIndex(row => String(row.id) === id), 1);
    else if (path === '/api/v1/add/mailbox') boxes.push({ ...makeBox(`${body.local_part}@${body.domain}`), name: body.name, quota: Number(body.quota) * 1024 ** 2 });
    else if (path === '/api/v1/edit/rename-mbox') {
      const old = body.items[0], next = `${body.attr.new_local_part}@${body.attr.domain}`;
      boxes.find(row => row.username === old).username = next;
      for (const filter of filters) if (filter.username === old) filter.username = next;
    }
    else if (path === '/api/v1/edit/mailbox') for (const addr of body.items) {
      const row = boxes.find(box => box.username === addr);
      for (const [key, value] of Object.entries(body.attr)) if (key !== 'sender_acl' || !options.ignoreSenderWrites) row[key] = key === 'active' ? Number(value) : structuredClone(value);
    } else if (path === '/api/v1/delete/syncjob') for (const id of body) jobs.splice(jobs.findIndex(row => String(row.id) === id), 1);
    else if (path === '/api/v1/delete/mailbox') for (const addr of body) {
      boxes.splice(boxes.findIndex(row => row.username === addr), 1);
      for (let i = filters.length - 1; i >= 0; i--) if (filters[i].username === addr) filters.splice(i, 1);
    } else assert.fail(path);
    return [{ type: 'success' }];
  } };
  const dockerapi = {
    async listSieve() { return options.userScript ? [{ name: 'personal', active: true }] : []; },
    async getAcl(owner) { aclCalls.push(owner); if (options.aclFailure === owner || String(boxes.find(row => row.username === owner)?.active) === '0') throw new Error(secret); return structuredClone([...acl.values()].flat().filter(row => row.user === owner || row.id === owner)); },
    async deleteAcl(owner, grantee, mailbox = 'INBOX') { calls.push({ method: 'POST', path: 'dockerapi/delete_acl', body: { owner, grantee, mailbox } }); if (!options.ignoreAclWrites) acl.set(owner, (acl.get(owner) ?? []).filter(row => row.mailbox !== mailbox || row.id !== grantee)); },
  };
  const audit = createAudit({ dir }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const aclFolders = {
    enabled: true,
    async readOwned(owner) { return (await dockerapi.getAcl(owner)).filter(row => row.user === owner && (aclFolders.enabled || row.mailbox === 'INBOX')); },
    async assertExist(owner, mailboxes) {
      calls.push({ method: 'CHECK', path: 'acl-folders/assert', body: { owner, mailboxes } });
      if (mailboxes.includes(options.missingFolder)) throw new AppError(409, 'CONFLICT', '폴더가 없어졌어요.');
    },
  };
  const otpRows = new Map([[user, { email: user, enabled: true, registeredAt: '2026-11-01T00:00:00.000Z', version: 'a'.repeat(32) }]]);
  const otpStore = {
    async readAccountStatus(email) { return otpRows.get(email) ?? { email, enabled: false, registeredAt: null, version: null }; },
    async cleanup({ email, version }) {
      if (options.otpFailure) throw new AppError(503, 'OTP_UNAVAILABLE', '합성 OTP 저장소 장애');
      const row = otpRows.get(email);
      if ((row?.version ?? null) !== version) throw new AppError(409, 'OTP_STATE_CHANGED', '합성 충돌');
      otpRows.delete(email); return { unchanged: !row };
    }, async close() {},
  };
  const otp = createOtpAdminService({ store: otpStore, mailcow, audit, lock });
  const netlimit = createFakeProtocolNetlimitStore();
  const states = new Map(), keyRows = new Map(), storeCalls = [];
  let lockDepth = 0;
  const store = {
    async read(addr) { if (options.dbFailure) throw new AppError(503, 'RETIREMENT_BLOCK_UNAVAILABLE', 'DB'); return structuredClone(states.get(addr) ?? emptyRetirementState()); },
    async keysForOwner(addr) { return [...(keyRows.get(addr) ?? [])]; },
    async blockedRecipients(addresses) { return [...new Set([...keyRows.values()].flat().filter(key => addresses.some(addr => addr === key || addr.replace(/\+[^@]+@/, '@') === key)))]; },
    async write(data) {
      storeCalls.push(structuredClone(data));
      if (options.failStore?.(data)) throw new AppError(503, 'RETIREMENT_BLOCK_UNAVAILABLE', 'DB');
      assert.equal(data.expected.version, states.get(data.email)?.version ?? null);
      const { email, keys, expected, ...row } = data; states.set(email, { ...row, updatedAt: '2026-11-10T00:00:00.000Z' }); keyRows.set(email, [...keys]);
      if (options.loseWrite?.(data)) throw new AppError(503, 'RETIREMENT_BLOCK_UNAVAILABLE', 'uncertain');
      return row;
    },
    async remove({ email, expected }) { assert.equal(expected.version, states.get(email)?.version ?? null); states.delete(email); keyRows.delete(email); },
    async withRoutingLock(operation) { if (options.lockFailure) throw new AppError(503, 'RETIREMENT_BLOCK_UNAVAILABLE', 'lock'); lockDepth++; try { return await operation(); } finally { lockDepth--; } },
  };
  const routing = createRetirementRouting({ mailcow, dockerapi, store });
  const retirement = { store, routing, featureEnabled: true, ready: true };
  const teams = createTeamsService({ mailcow, audit, lock, history, auditDir: dir, retirement: routing });
  const service = createAccountsService({ retirement, protocolNetlimit: netlimit, mailcow, dockerapi, audit, lock, history, teams, aclFolders, otp });
  return { states, keyRows, storeCalls, store, routing, retirement, lockDepth: () => lockDepth, netlimit, otpRows, otpStore, dir, boxes, filters, aliases, jobs, acl, calls, aclCalls, options, mailcow, dockerapi, aclFolders, audit, lock, history, service };
}
const writes = f => f.calls.filter(row => row.method === 'POST');
const preview = f => f.service.deletePreview({}, user);
const remove = (f, data) => f.service.remove({ ...context, addr: user, data });
const confirmed = etag => ({ etag, confirmAddress: user, cleanRefs: true });
const leave = (f, data) => f.service.leave({ ...context, data: { address: user, mode: 'disable', cleanRefs: false, ...data } });

function retired(f, { blocked = false, pending = null } = {}) {
  f.boxes[0].active = 2;
  const row = { ...emptyRetirementState(), retired: true, source: 'leave', recordedAt: '2026-11-01T00:00:00.000Z',
    sourceAuditId: 'a'.repeat(32), updatedBy: 'admin', updatedAt: '2026-11-01T00:00:00.000Z', version: retirementVersion(), receiveBlocked: blocked, pendingOperation: pending };
  f.states.set(user, row); f.keyRows.set(user, blocked ? [user] : []); return row;
}
const settingsPreview = (f, data) => f.service.retirementPreview({}, user, data);
const settingsRun = (f, data) => f.service.retirementUpdate({ ...context, addr: user, data });

test('retirement: active2 without metadata remains unclassified and list/detail keep the ordinary edit etag', async t => {
  const f = await fixture(t); f.boxes[0].active = 2;
  const before = await f.service.detail({}, user), list = await f.service.list({});
  assert.equal(before.retirement.retired, false); assert.equal(before.retirement.receiveBlocked, false);
  assert.equal(list.items.find(row => row.address === user).retirement.retired, false);
  await assert.rejects(settingsPreview(f, { receiveBlocked: true }), { statusCode: 409, code: 'RETIREMENT_STATE_CONFLICT' });
  const preview = await leave(f, { action: 'preview' }); assert.equal(preview.unclassifiedReceiveOnly, true);
  assert.equal(f.storeCalls.length, 0); assert.equal(f.lockDepth(), 0); assert.equal(writes(f).length, 0);
  const run = await leave(f, { action: 'run', etag: preview.etag });
  assert.equal(run.result, 'ok'); assert.equal(run.retirement.retired, true); assert.equal(run.retirement.receiveBlocked, false);
  assert.equal((await f.service.detail({}, user)).etag, before.etag);
});

for (const cleanRefs of [false, true]) for (const cleanShares of [false, true]) test(`retirement: cleanRefs=${cleanRefs} cleanShares=${cleanShares} have independent effects`, async t => {
  const f = await fixture(t, true); const initialShares = structuredClone([...f.acl]);
  const preview = await leave(f, { action: 'preview', cleanRefs, cleanShares });
  const result = await leave(f, { action: 'run', cleanRefs, cleanShares, etag: preview.etag });
  assert.equal(result.result, 'ok', JSON.stringify(result)); assert.equal(result.retirement.retired, true);
  assert.equal(f.boxes[0].active, 2); assert.equal(f.jobs.length, cleanRefs ? 0 : 1);
  if (cleanShares) assert.equal([...f.acl.values()].flat().length, 0); else assert.deepEqual([...f.acl], initialShares);
});

test('retirement: omitted cleanShares preserves shares even with legacy cleanRefs=true', async t => {
  const f = await fixture(t, true), initial = structuredClone([...f.acl]);
  const preview = await leave(f, { action: 'preview', cleanRefs: true }); assert.equal(preview.cleanShares, false);
  assert.ok(preview.refs.shares.every(row => row.effect === 'kept'));
  const result = await leave(f, { action: 'run', cleanRefs: true, etag: preview.etag });
  assert.equal(result.result, 'ok'); assert.deepEqual([...f.acl], initial);
});

test('retirement: committed duplicate leave is an unchanged settings guide with zero extra writes/audits', async t => {
  const f = await fixture(t); retired(f, { blocked: true });
  const count = (await f.audit.read()).rows.length;
  for (const action of ['preview', 'run']) {
    const result = await leave(f, { action }); assert.equal(result.alreadyRetired, true); assert.equal(result.unchanged, true);
    assert.equal(result.retirement.receiveBlocked, true); assert.equal(result.accountActive, 2); assert.ok(result.settingsPath.includes(encodeURIComponent(user)));
  }
  assert.equal(f.storeCalls.length, 0); assert.equal(writes(f).length, 0); assert.equal((await f.audit.read()).rows.length, count);
});

for (const value of [0, 1, 'true', null]) test(`retirement: receiveBlocked rejects ${JSON.stringify(value)}`, async t => {
  const f = await fixture(t); retired(f);
  await assert.rejects(settingsPreview(f, { receiveBlocked: value }), { statusCode: 422, code: 'INVALID_INPUT' }); assert.equal(writes(f).length, 0);
});

test('retirement: block and forwarding are exclusive before mutation', async t => {
  const f = await fixture(t); retired(f);
  await assert.rejects(settingsPreview(f, { receiveBlocked: true, forwardTo: other }), { statusCode: 409, code: 'RETIREMENT_FORWARD_CONFLICT' });
  await assert.rejects(leave(f, { action: 'preview', receiveBlocked: true, forwardTo: other }), { statusCode: 409, code: 'RETIREMENT_FORWARD_CONFLICT' });
  assert.equal(writes(f).length, 0);
});

for (const availability of ['flag', 'ready', 'db', 'lock']) test(`retirement: unavailable ${availability} fails before any business write`, async t => {
  const f = await fixture(t); retired(f);
  if (availability === 'flag') f.retirement.featureEnabled = false;
  if (availability === 'ready') f.retirement.ready = false;
  if (availability === 'db') f.options.dbFailure = true;
  if (availability === 'lock') {
    const p = await settingsPreview(f, { receiveBlocked: true }); f.options.lockFailure = true;
    await assert.rejects(settingsRun(f, { receiveBlocked: true, etag: p.etag }), { statusCode: 503, code: 'RETIREMENT_BLOCK_UNAVAILABLE' });
  } else await assert.rejects(settingsPreview(f, { receiveBlocked: true }), { statusCode: 503, code: 'RETIREMENT_BLOCK_UNAVAILABLE' });
  assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
});

test('retirement: named lock encloses all ON cleanup and keys commit only after active2 readback', async t => {
  const f = await fixture(t); const original = f.store.write;
  f.store.write = data => { assert.ok(f.lockDepth() > 0); if (data.receiveBlocked) assert.equal(f.boxes[0].active, 2); return original(data); };
  f.options.onCall = ({ method }) => { if (method === 'POST') assert.ok(f.lockDepth() > 0); };
  const p = await leave(f, { action: 'preview', receiveBlocked: true });
  const r = await leave(f, { action: 'run', receiveBlocked: true, etag: p.etag });
  assert.equal(r.result, 'ok', JSON.stringify(r)); assert.equal(r.retirement.receiveBlocked, true); assert.deepEqual(f.keyRows.get(user), [user]);
});

test('retirement: preview etag rejects account, routing or metadata drift before mutation', async t => {
  const f = await fixture(t); retired(f); const p = await settingsPreview(f, { receiveBlocked: true });
  f.aliases.push({ id: 3, address: 'new@example.com', goto: user, active: 1 });
  await assert.rejects(settingsRun(f, { receiveBlocked: true, etag: p.etag }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  assert.equal(f.storeCalls.length, 0); assert.equal(writes(f).length, 0);
});

test('retirement: pure owner forward removal is explicit, requires preview consent, and keeps backup', async t => {
  const f = await fixture(t); retired(f);
  const raw = `require ["copy"];\n# owner\nredirect :copy "${other}";\nstop;\n`;
  f.filters.push({ id: 11, username: user, active: 1, filter_type: 'prefilter', script_data: raw });
  const unchanged = await settingsPreview(f, { receiveBlocked: true }); assert.ok(unchanged.blockers.some(row => row.code === 'OWNER_FORWARD_ACTIVE'));
  const p = await settingsPreview(f, { receiveBlocked: true, forwardTo: null });
  assert.equal(p.changes[0].effect, 'filter_deleted_with_backup'); assert.deepEqual(p.blockers, []);
  await assert.rejects(settingsRun(f, { receiveBlocked: true, forwardTo: null, etag: p.etag }), { statusCode: 409, code: 'RETIREMENT_CLEANUP_CONFIRM_REQUIRED' });
  const r = await settingsRun(f, { receiveBlocked: true, forwardTo: null, cleanupConfirmed: true, etag: p.etag });
  assert.equal(r.result, 'ok', JSON.stringify(r)); assert.equal(f.filters.length, 0); assert.equal(r.retirement.receiveBlocked, true);
  const record = (await f.history.list()).items.find(row => row.action === 'mailbox.convert.filter.delete');
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${record.id}.before.sieve`), 'utf8'), raw);
  assert.ok(!JSON.stringify((await f.audit.read()).rows).includes('redirect'));
});

for (const kind of ['user', 'post', 'mixed']) test(`retirement: ${kind} forwarding remains an ON blocker and is never edited`, async t => {
  const f = await fixture(t); retired(f); const script = `require ["copy"];\nredirect :copy "${other}";\n`;
  if (kind === 'user') f.options.userScript = script;
  else f.filters.push({ id: 10, username: user, active: 1, filter_type: kind === 'post' ? 'postfilter' : 'prefilter', script_data: script + (kind === 'mixed' ? 'keep;\n' : '') });
  const p = await settingsPreview(f, { receiveBlocked: true, forwardTo: null }); assert.ok(p.blockers.length > 0);
  await assert.rejects(settingsRun(f, { receiveBlocked: true, forwardTo: null, cleanupConfirmed: true, etag: p.etag }), { statusCode: 409, code: 'RETIREMENT_ROUTES_REMAIN' });
  assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
});

test('retirement: mixed alias cleanup preserves healthy recipients then commits pure alias keys', async t => {
  const f = await fixture(t); retired(f);
  f.aliases.push({ id: 1, address: 'mixed@example.com', goto: `${user},${other}`, active: 1 }, { id: 2, address: 'pure@example.com', goto: `${user},null@localhost`, active: 1 });
  const p = await settingsPreview(f, { receiveBlocked: true });
  const r = await settingsRun(f, { receiveBlocked: true, cleanupConfirmed: true, etag: p.etag });
  assert.equal(r.result, 'ok', JSON.stringify(r)); assert.equal(f.aliases[0].goto, other); assert.equal(f.aliases[1].goto, `${user},null@localhost`);
  assert.deepEqual(f.keyRows.get(user), ['pure@example.com', user]);
});

test('retirement: managed team cleanup uses existing team audit and preserves other members', async t => {
  const f = await fixture(t); retired(f); f.filters.push({ id: 10, username: team, active: 1, filter_type: 'prefilter', script_data: source });
  const p = await settingsPreview(f, { receiveBlocked: true }); assert.ok(p.changes.some(row => row.kind === 'team'));
  const r = await settingsRun(f, { receiveBlocked: true, cleanupConfirmed: true, etag: p.etag });
  assert.equal(r.result, 'ok', JSON.stringify(r)); assert.ok(!f.filters[0].script_data.includes(user)); assert.ok(f.filters[0].script_data.includes(other));
});

test('retirement: OFF commits before forwarding and forwarding failure returns partial with OFF visible', async t => {
  const f = await fixture(t); retired(f, { blocked: true }); f.retirement.featureEnabled = false;
  const p = await settingsPreview(f, { receiveBlocked: false, forwardTo: other }); f.options.failPath = '/api/v1/add/filter';
  const r = await settingsRun(f, { receiveBlocked: false, forwardTo: other, etag: p.etag });
  assert.equal(r.result, 'partial'); assert.equal(r.retirement.receiveBlocked, false); assert.equal(r.retirement.pendingOperation.kind, 'settings'); assert.deepEqual(f.keyRows.get(user), []);
});

test('retirement: metadata failure after active write is partial and never claims completed retirement', async t => {
  const f = await fixture(t); const p = await leave(f, { action: 'preview' }); f.options.failStore = () => true;
  const r = await leave(f, { action: 'run', etag: p.etag });
  assert.equal(r.result, 'partial'); assert.equal(f.boxes[0].active, 2); assert.equal(r.retirement.retired, false); assert.equal(r.steps.at(-1).stage, 'retirement');
});

test('retirement: partial leave retries persisted ON request when old client omits receiveBlocked', async t => {
  const f = await fixture(t); f.options.failStore = data => data.receiveBlocked;
  const p = await leave(f, { action: 'preview', receiveBlocked: true });
  const r = await leave(f, { action: 'run', receiveBlocked: true, etag: p.etag });
  assert.equal(r.result, 'partial'); assert.equal(r.retirement.pendingOperation.request.receiveBlocked, true);
  f.options.failStore = null;
  const retry = await leave(f, { action: 'preview' }); assert.equal(retry.receiveBlocked, true);
  const done = await leave(f, { action: 'run', etag: retry.etag });
  assert.equal(done.result, 'ok', JSON.stringify(done)); assert.equal(done.retirement.receiveBlocked, true); assert.equal(done.retirement.pendingOperation, null);
  assert.equal(writes(f).filter(row => row.path === '/api/v1/edit/mailbox').length, 1);
});

test('retirement: uncertain ON commit is read back and partial retains its committed ON selection', async t => {
  const f = await fixture(t); retired(f); let lost = false;
  f.options.loseWrite = data => data.receiveBlocked && !lost && (lost = true);
  const p = await settingsPreview(f, { receiveBlocked: true }); const r = await settingsRun(f, { receiveBlocked: true, etag: p.etag });
  assert.equal(r.result, 'partial'); assert.equal(r.retirement.receiveBlocked, true); assert.deepEqual(f.keyRows.get(user), [user]);
});

for (const action of ['rename', 'convert']) test(`retirement: ON ${action} is a 409 and OFF preview is allowed`, async t => {
  const f = await fixture(t); retired(f, { blocked: true }); f.boxes[0].messages = 0;
  const run = () => action === 'rename' ? f.service.rename({ ...context, addr: user, data: { action: 'preview', newLocal: 'new', keepOldAsAlias: true } }) :
    f.service.convert({ ...context, direction: 'mailbox-to-alias', data: { action: 'preview', address: user, targets: [other] } });
  await assert.rejects(run(), { statusCode: 409, code: 'RETIREMENT_BLOCK_ACTIVE' });
  f.states.get(user).receiveBlocked = false; f.keyRows.set(user, []);
  assert.ok((await run()).etag); assert.equal(writes(f).length, 0);
});

test('retirement: OFF rename moves explicit record only after verified mailbox rename and clears old owner', async t => {
  const f = await fixture(t), before = retired(f); const data = { action: 'preview', newLocal: 'renamed', keepOldAsAlias: true };
  const p = await f.service.rename({ ...context, addr: user, data });
  const r = await f.service.rename({ ...context, addr: user, data: { ...data, action: 'run', etag: p.etag } });
  assert.equal(r.result, 'ok', JSON.stringify(r)); const next = 'renamed@example.com';
  assert.equal(f.states.has(user), false); assert.equal(f.states.get(next).recordedAt, before.recordedAt); assert.equal(f.states.get(next).receiveBlocked, false);
});

test('retirement: delete ON removes only the deleted owner metadata and keys', async t => {
  const f = await fixture(t); retired(f, { blocked: true }); f.keyRows.set(other, ['unrelated@example.com']);
  const p = await f.service.deletePreview({}, user); const r = await f.service.remove({ ...context, addr: user, data: confirmed(p.etag) });
  assert.equal(r.result, 'ok', JSON.stringify(r)); assert.equal(f.states.has(user), false); assert.equal(f.keyRows.has(user), false); assert.deepEqual(f.keyRows.get(other), ['unrelated@example.com']);
});

test('retirement: stale address metadata prevents new mailbox reuse before any mailbox creation', async t => {
  const f = await fixture(t); retired(f); f.boxes.shift();
  await assert.rejects(f.service.create({ ...context, data: { local: 'user', domain: 'example.com', name: 'New', kind: 'personal', password: 'synthetic' } }), { statusCode: 409, code: 'RETIREMENT_ADDRESS_STALE' });
  assert.equal(writes(f).length, 0); assert.equal(f.states.get(user).retired, true);
});

test('retirement: audit intent failure prevents active, metadata and routing mutation', async t => {
  const f = await fixture(t); const p = await leave(f, { action: 'preview' }); f.audit.run = async () => { throw new AppError(500, 'AUDIT_UNAVAILABLE', 'intent'); };
  await assert.rejects(leave(f, { action: 'run', etag: p.etag }), { code: 'AUDIT_UNAVAILABLE' }); assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
});

test('retirement HTTP: new routes retain 403 Origin/CSRF/auth protection and structured contract', async t => {
  const f = await fixture(t); retired(f);
  const app = await createAdminApp({ retirement: f.retirement, protocolNetlimit: { store: f.netlimit }, otp: { store: f.otpStore },
    config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: false,
    dockerapi: f.dockerapi, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  const url = `/api/admin/mailboxes/${user}/retirement`, origin = 'https://mailadmin.example.com';
  for (const [method, route] of [['POST', `${url}-preview`], ['PATCH', url]]) {
    const response = await app.inject({ method, url: route, headers: { origin }, payload: { receiveBlocked: false } });
    assert.equal(response.statusCode, 403); assert.equal(response.headers['www-authenticate'], undefined);
  }
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin, 'x-mailadmin-csrf': logged.json().csrf };
  const denied = await app.inject({ method: 'PATCH', url, headers: { ...headers, 'x-mailadmin-csrf': '' }, payload: { receiveBlocked: true } });
  assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
  const preview = await app.inject({ method: 'POST', url: `${url}-preview`, headers, payload: { receiveBlocked: true } });
  assert.equal(preview.statusCode, 200, preview.body); assert.equal(preview.json().after.receiveBlocked, true);
  const done = await app.inject({ method: 'PATCH', url, headers, payload: { receiveBlocked: true, etag: preview.json().etag } });
  assert.equal(done.statusCode, 200, done.body); assert.equal(done.json().retirement.receiveBlocked, true); assert.equal(done.headers['cache-control'], 'no-store');
  const invalid = await app.inject({ method: 'PATCH', url, headers, payload: { receiveBlocked: 'true' } });
  assert.equal(invalid.statusCode, 422); assert.equal(invalid.json().error.code, 'INVALID_INPUT'); assert.equal(invalid.headers['www-authenticate'], undefined);
});

test('retirement HTTP: production app always injects a real store and missing DB responds 503', async t => {
  const f = await fixture(t);
  const app = await createAdminApp({ protocolNetlimit: { store: f.netlimit }, otp: { store: f.otpStore },
    config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: false,
    dockerapi: f.dockerapi, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  const origin = 'https://mailadmin.example.com';
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin, 'x-mailadmin-csrf': logged.json().csrf };
  for (const url of [`/api/admin/mailboxes/${user}`, '/api/admin/mailboxes']) {
    const result = await app.inject({ method: 'GET', url, headers }); assert.equal(result.statusCode, 503, result.body);
    assert.equal(result.json().error.code, 'RETIREMENT_BLOCK_UNAVAILABLE');
  }
  assert.equal(writes(f).length, 0);
});

const adminEnv = {
  ADMIN_MODE: 'true', ADMIN_HOSTNAME: 'mailadmin.example.com', ADMIN_SESSION_IDLE_MIN: '60', ADMIN_SESSION_MAX_HOURS: '8',
  MAILCOW_UI_URL: 'https://nginx-mailcow:8443', MAILCOW_UI_SERVERNAME: 'mailcow.example.com', IMAP_HOST: 'dovecot-mailcow', SMTP_HOST: 'postfix-mailcow',
  MAIL_TLS_SERVERNAME: 'mail.example.com', MAIL_TLS_MODE: 'verify', MAIL_TLS_PIN_FILE: '', DOMAIN: 'example.com', TRUST_PROXY: '192.0.2.0/24',
  TRUSTED_SENDER_FILE: '', DOCKERAPI_URL: 'https://dockerapi:443', DOVEADM_URL: '', DOVEADM_KEY: '', RELAY_FILES: '', MAILCOW_IPV4_NETWORK: '192.0.2',
  MAILCOW_IPV6_NETWORK: '2001:db8::/64', AUTOEXPUNGE_DAYS: '30', LOGO_DIR: '/brand', AUDIT_DIR: '/data/audit', LOG_LEVEL: 'silent',
};
for (const flag of [undefined, '', 'false', 'true']) test(`retirement config: flag ${JSON.stringify(flag)} is strict and defaults OFF`, () => {
  const env = { ...adminEnv, ...(flag === undefined ? {} : { WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE: flag }) };
  assert.equal(loadAdminConfig(env).retirementReceiveBlockEnabled, flag === 'true');
});
for (const flag of [true, false, 'TRUE', '1', ' false ']) test(`retirement config: rejects flag ${JSON.stringify(flag)}`, () => {
  assert.throws(() => loadAdminConfig({ ...adminEnv, WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE: flag }), /WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE/);
});

test('retirement: OFF conversion cleans old metadata after confirmed mailbox absence', async t => {
  const f = await fixture(t); retired(f); f.boxes[0].messages = 0;
  const data = { action: 'preview', address: user, targets: [other] };
  const p = await f.service.convert({ ...context, direction: 'mailbox-to-alias', data });
  const r = await f.service.convert({ ...context, direction: 'mailbox-to-alias', data: { ...data, action: 'run', etag: p.etag } });
  assert.equal(r.result, 'ok', JSON.stringify(r)); assert.equal(f.states.has(user), false); assert.equal(f.keyRows.has(user), false);
  assert.equal(f.aliases.find(row => row.address === user).goto, other);
});

test('retirement: readback/keys errors after remove-forward preserve completed removal and leave ON pending', async t => {
  const f = await fixture(t); retired(f); f.filters.push({ id: 11, username: user, filter_type: 'prefilter', active: 1, script_data: `require ["copy"];\nredirect :copy "${other}";\n` });
  const p = await settingsPreview(f, { receiveBlocked: true, forwardTo: null }); f.options.failStore = data => data.receiveBlocked;
  const r = await settingsRun(f, { receiveBlocked: true, forwardTo: null, cleanupConfirmed: true, etag: p.etag });
  assert.equal(r.result, 'partial'); assert.equal(f.filters.length, 0); assert.equal(r.retirement.receiveBlocked, false);
  assert.ok(r.retirement.pendingOperation.completed.includes('remove-forward'));
  f.options.failStore = null; const retry = await settingsPreview(f, { receiveBlocked: true, forwardTo: null });
  const done = await settingsRun(f, { receiveBlocked: true, forwardTo: null, etag: retry.etag });
  assert.equal(done.result, 'ok'); assert.equal(writes(f).filter(row => row.path === '/api/v1/delete/filter').length, 1);
});

test('retirement: omitted forwarding preserves an existing managed forward and reports its current targets', async t => {
  const f = await fixture(t); const raw = `require ["copy"];\nredirect :copy "${other}";\n`;
  f.filters.push({ id: 11, username: user, filter_type: 'prefilter', active: 1, script_data: raw });
  const p = await leave(f, { action: 'preview' }); assert.deepEqual(p.forwarding[0].targets, [other]);
  assert.equal(p.receiveChanges.length, 0);
  const r = await leave(f, { action: 'run', etag: p.etag }); assert.equal(r.result, 'ok'); assert.equal(f.filters[0].script_data, raw);
  assert.ok(!writes(f).some(row => row.path === '/api/v1/delete/filter'));
});

test('retirement: mixed owner blocker includes safe location and targets without source text', async t => {
  const f = await fixture(t); retired(f);
  f.filters.push({ id: 11, username: user, filter_type: 'prefilter', active: 1, script_data: `require ["copy"];\nredirect :copy "${other}";\nkeep;\n` });
  const p = await settingsPreview(f, { receiveBlocked: true, forwardTo: null });
  const blocker = p.blockers.find(row => row.code === 'OWNER_FORWARD_UNEDITABLE');
  assert.equal(blocker.source, 'admin'); assert.equal(blocker.type, 'prefilter'); assert.equal(blocker.id, '11'); assert.deepEqual(blocker.targets, [other]);
  assert.ok(!JSON.stringify(p).includes('redirect'));
});

test('retirement: leave rechecks routing after durable intent and before the first mailbox write', async t => {
  const f = await fixture(t); const p = await leave(f, { action: 'preview', receiveBlocked: true });
  const run = f.audit.run;
  f.audit.run = (entry, operation, options) => run(entry, async intent => {
    if (entry.action === 'mailbox.leave') f.aliases.push({ id: 3, address: 'late@example.com', goto: user, active: 1 });
    return operation(intent);
  }, options);
  await assert.rejects(leave(f, { action: 'run', receiveBlocked: true, etag: p.etag }), { code: 'CHANGED_ELSEWHERE', statusCode: 409 });
  assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
});

test('retirement: new unpreviewed cleanup after active write is partial and does not modify that connection', async t => {
  const f = await fixture(t); const p = await leave(f, { action: 'preview', receiveBlocked: true });
  f.options.onCall = ({ path }) => { if (path === '/api/v1/edit/mailbox') f.aliases.push({ id: 3, address: 'late@example.com', goto: `${user},${other}`, active: 1 }); };
  const r = await leave(f, { action: 'run', receiveBlocked: true, cleanupConfirmed: true, etag: p.etag });
  assert.equal(r.result, 'partial'); assert.equal(r.retirement.retired, true); assert.equal(r.retirement.receiveBlocked, false);
  assert.equal(f.aliases[0].goto, `${user},${other}`); assert.ok(!writes(f).some(row => row.path === '/api/v1/edit/alias'));
});

test('retirement: retry skips a completed managed forwarding stage after later cleanup failure', async t => {
  const f = await fixture(t); f.jobs.push({ id: 8, user2: user, active: 1 });
  const p = await leave(f, { action: 'preview', cleanRefs: true, forwardTo: other }); f.options.failPath = '/api/v1/delete/syncjob';
  const partial = await leave(f, { action: 'run', cleanRefs: true, forwardTo: other, etag: p.etag });
  assert.equal(partial.result, 'partial'); assert.ok(partial.retirement.pendingOperation.lifecycleCompleted.some(row => row.stage === 'forward'));
  f.options.failPath = null;
  const retry = await leave(f, { action: 'preview', cleanRefs: true });
  const complete = await leave(f, { action: 'run', cleanRefs: true, etag: retry.etag });
  assert.equal(complete.result, 'ok', JSON.stringify(complete)); assert.equal(writes(f).filter(row => row.path === '/api/v1/add/filter').length, 1);
  assert.equal(complete.steps.filter(row => row.stage === 'forward').length, 0);
});

test('retirement: list and detail expose retired record versus active-state mismatch', async t => {
  const f = await fixture(t); retired(f); f.boxes[0].active = 1;
  assert.ok((await f.service.detail({}, user)).retirement.warnings.some(row => row.code === 'RETIREMENT_STATE_MISMATCH'));
  assert.ok((await f.service.list({})).items.find(row => row.address === user).retirement.warnings.some(row => row.code === 'RETIREMENT_STATE_MISMATCH'));
  await assert.rejects(settingsPreview(f, { receiveBlocked: false }), { statusCode: 409, code: 'RETIREMENT_STATE_CONFLICT' });
});

test('retirement: forwarding preview describes additive behavior and preserves existing destinations', async t => {
  const f = await fixture(t); retired(f); f.filters.push({ id: 10, username: user, filter_type: 'prefilter', active: 1, script_data: `require ["copy"];\nredirect :copy "${team}";\n` });
  const p = await settingsPreview(f, { receiveBlocked: false, forwardTo: other });
  assert.equal(p.forwardingChange.effect, 'add'); assert.deepEqual(p.forwardingChange.existingTargets, [team]); assert.ok(p.forwardingChange.message.includes('1개'));
  const r = await settingsRun(f, { receiveBlocked: false, forwardTo: other, etag: p.etag });
  assert.equal(r.result, 'ok'); assert.ok(f.filters[0].script_data.includes(team)); assert.ok(f.filters[0].script_data.includes(other));
});

test('retirement: leave ON removes a consented pure existing owner forward before committing keys', async t => {
  const f = await fixture(t); f.filters.push({ id: 10, username: user, filter_type: 'prefilter', active: 1, script_data: `require ["copy"];\nredirect :copy "${other}";\n` });
  const p = await leave(f, { action: 'preview', receiveBlocked: true });
  await assert.rejects(leave(f, { action: 'run', receiveBlocked: true, etag: p.etag }), { statusCode: 409, code: 'RETIREMENT_CLEANUP_CONFIRM_REQUIRED' });
  const r = await leave(f, { action: 'run', receiveBlocked: true, cleanupConfirmed: true, etag: p.etag });
  assert.equal(r.result, 'ok', JSON.stringify(r)); assert.equal(r.retirement.receiveBlocked, true); assert.equal(f.filters.length, 0);
  const audit = (await f.audit.read()).rows, intent = audit.find(row => row.phase === 'intent' && row.action === 'mailbox.leave');
  assert.equal(intent.after.receiveBlocked, true); const result = audit.find(row => row.phase === 'result' && row.id === intent.id);
  assert.ok(result.detail.steps.some(row => row.stage === 'receive-on'));
});

test('retirement: a last-member team stays blocked even if cleanup is approved', async t => {
  const f = await fixture(t); retired(f); f.filters.push({ id: 10, username: team, filter_type: 'prefilter', active: 1, script_data: `require ["copy"];\nredirect :copy "${user}";\n` });
  const p = await settingsPreview(f, { receiveBlocked: true }); assert.ok(p.blockers.some(row => row.code === 'LAST_TEAM_MEMBER'));
  await assert.rejects(settingsRun(f, { receiveBlocked: true, cleanupConfirmed: true, etag: p.etag }), { statusCode: 409, code: 'RETIREMENT_ROUTES_REMAIN' });
  assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
});

test('retirement: audit result failure reports an error while fresh detail shows the actual committed ON state', async t => {
  const f = await fixture(t); retired(f); const p = await settingsPreview(f, { receiveBlocked: true }), run = f.audit.run;
  f.audit.run = async (...args) => { await run(...args); throw new AppError(500, 'AUDIT_RESULT_UNAVAILABLE', 'result'); };
  await assert.rejects(settingsRun(f, { receiveBlocked: true, etag: p.etag }), { code: 'AUDIT_RESULT_UNAVAILABLE' });
  assert.equal((await f.service.detail({}, user)).retirement.receiveBlocked, true);
});

test('retirement: metadata/key removal failure after delete is partial and stale generation blocks reuse', async t => {
  const f = await fixture(t); retired(f); const p = await f.service.deletePreview({}, user);
  f.store.remove = async () => { throw new AppError(503, 'RETIREMENT_BLOCK_UNAVAILABLE', 'remove'); };
  const r = await f.service.remove({ ...context, addr: user, data: confirmed(p.etag) });
  assert.equal(r.result, 'partial'); assert.equal(r.steps.at(-1).stage, 'retirement'); assert.ok(!f.boxes.some(row => row.username === user));
  await assert.rejects(f.service.create({ ...context, data: { local: 'user', domain: 'example.com', name: 'New', kind: 'personal', password: 'synthetic' } }), { code: 'RETIREMENT_ADDRESS_STALE' });
});

test('retirement: unfinished leave cannot be overwritten by settings preview/PATCH', async t => {
  const f = await fixture(t); retired(f, { pending: { kind: 'leave', request: { cleanRefs: true, cleanShares: true, receiveBlocked: false }, lifecycleCompleted: [] } });
  await assert.rejects(settingsPreview(f, { receiveBlocked: false }), { statusCode: 409, code: 'RETIREMENT_OPERATION_PENDING' });
  await assert.rejects(settingsRun(f, { receiveBlocked: false, etag: 'stale' }), { statusCode: 409, code: 'RETIREMENT_OPERATION_PENDING' });
  assert.equal(f.states.get(user).pendingOperation.request.cleanShares, true); assert.equal(f.storeCalls.length, 0);
});

test('retirement: pending ON leave remains blocked with feature OFF and gives explicit recovery instruction', async t => {
  const f = await fixture(t); retired(f, { pending: { kind: 'leave', request: { cleanRefs: false, cleanShares: false, receiveBlocked: true, forwardTo: null }, lifecycleCompleted: [{ stage: 'active', target: user }] } });
  f.retirement.featureEnabled = false;
  await assert.rejects(leave(f, { action: 'preview' }), error => error.statusCode === 503 && error.code === 'RETIREMENT_BLOCK_UNAVAILABLE' && error.message.includes('서버 기능을 켜서 준비한 뒤'));
  assert.equal(f.storeCalls.length, 0); assert.equal(writes(f).length, 0); assert.equal(f.states.get(user).pendingOperation.request.receiveBlocked, true);
});

test('retirement: explicit OFF clears stale owner keys before an OFF rename may proceed', async t => {
  const f = await fixture(t); retired(f); f.keyRows.set(user, [user]);
  await assert.rejects(f.service.rename({ ...context, addr: user, data: { action: 'preview', newLocal: 'new', keepOldAsAlias: true } }), { code: 'RETIREMENT_KEYS_STALE', statusCode: 409 });
  const p = await settingsPreview(f, { receiveBlocked: false });
  const r = await settingsRun(f, { receiveBlocked: false, etag: p.etag });
  assert.equal(r.result, 'ok'); assert.deepEqual(f.keyRows.get(user), []);
  assert.ok((await f.service.rename({ ...context, addr: user, data: { action: 'preview', newLocal: 'new', keepOldAsAlias: true } })).etag);
});

test('retirement: bundled and direct members in one team are cleaned with successive verified revisions', async t => {
  const f = await fixture(t); retired(f);
  f.aliases.push({ id: 12, address: 'members@example.com', goto: `${user},${other}`, active: 1, private_comment: 'mailadmin:team-members' });
  f.filters.push({ id: 10, username: team, filter_type: 'prefilter', active: 1, script_data: `require ["copy"];\nredirect :copy "members@example.com";\nredirect :copy "${user}";\nredirect :copy "${other}";\n` });
  const p = await settingsPreview(f, { receiveBlocked: true });
  assert.deepEqual(p.changes.map(row => row.kind), ['team-member-alias', 'team']); assert.deepEqual(p.blockers, []);
  const r = await settingsRun(f, { receiveBlocked: true, cleanupConfirmed: true, etag: p.etag });
  assert.equal(r.result, 'ok', JSON.stringify(r)); assert.equal(f.aliases[0].goto, other); assert.ok(!f.filters[0].script_data.includes(user)); assert.equal(r.retirement.receiveBlocked, true);
});

test('retirement: page metadata reads respect the small fail-fast DB pool', async t => {
  const f = await fixture(t); for (let i = 0; i < 47; i++) f.boxes.push(makeBox(`page${i}@example.com`));
  const read = f.store.read; let concurrent = 0, max = 0;
  f.store.read = async addr => { concurrent++; max = Math.max(max, concurrent); try { assert.ok(concurrent <= 2); await Promise.resolve(); return await read(addr); } finally { concurrent--; } };
  const result = await f.service.list({}); assert.equal(result.items.length, 50); assert.ok(max <= 2); assert.equal(result.total, 50);
});

test('retirement: lost active-write response returns partial with current login state and original request', async t => {
  const f = await fixture(t); const p = await leave(f, { action: 'preview', receiveBlocked: true }), call = f.mailcow.call;
  f.mailcow.call = async (...args) => { const result = await call(...args); if (args[1] === 'POST' && args[2] === '/api/v1/edit/mailbox') throw new AppError(502, 'MAILCOW_REJECTED', 'lost response'); return result; };
  const r = await leave(f, { action: 'run', receiveBlocked: true, etag: p.etag });
  assert.equal(r.result, 'partial'); assert.equal(r.accountActive, 2); assert.equal(r.retirement.retired, false); assert.equal(r.requested.receiveBlocked, true);
  assert.equal(r.steps.at(-1).stage, 'active'); assert.deepEqual(f.keyRows.get(user) ?? [], []);
});

test('retirement admin writes: protected alias deletion is refused by alias API but ON mailbox permanent deletion cleans its own aliases', async t => {
  const f = await fixture(t); retired(f, { blocked: true }); const protectedAlias = 'protected@example.com';
  f.aliases.push({ id: 10, address: protectedAlias, goto: user, active: 1 }); f.keyRows.set(user, [protectedAlias, user]);
  const aliases = createAliasesService({ ...f, retirement: f.routing });
  const alias = (await aliases.list({})).items.find(row => row.address === protectedAlias);
  await assert.rejects(aliases.remove({ ...context, addr: protectedAlias, data: { etag: alias.etag, confirmAddress: protectedAlias } }), { code: 'RETIREMENT_ROUTE_PROTECTED' });
  assert.equal(writes(f).length, 0);
  const p = await f.service.deletePreview({}, user), r = await f.service.remove({ ...context, addr: user, data: confirmed(p.etag) });
  assert.equal(r.result, 'ok', JSON.stringify(r)); assert.equal(f.aliases.length, 0); assert.equal(f.states.has(user), false); assert.equal(f.keyRows.has(user), false);
});

test('retirement admin writes: ordinary active edit and history use the same current protection', async t => {
  const f = await fixture(t); retired(f, { blocked: true }); const p = await f.service.detail({}, user);
  await assert.rejects(f.service.edit({ ...context, addr: user, data: { etag: p.etag, active: true } }), { code: 'RETIREMENT_ROUTE_PROTECTED' }); assert.equal(writes(f).length, 0);
  f.states.get(user).receiveBlocked = false; f.keyRows.set(user, []);
  const edit = await f.service.edit({ ...context, addr: user, data: { etag: p.etag, active: true } });
  assert.equal(edit.result, 'ok'); const record = (await f.history.list()).items.find(row => row.action === 'mailbox.edit');
  f.keyRows.set(user, [user]); const count = writes(f).length;
  await assert.rejects(f.history.revert(record.id, { ...context, confirm: true }), { code: 'RETIREMENT_ROUTE_PROTECTED' }); assert.equal(writes(f).length, count);
});

test('retirement admin HTTP: production factory injects one guard into alias writes and returns 409 without side effects', async t => {
  const f = await fixture(t); retired(f, { blocked: true });
  const app = await createAdminApp({ retirement: { store: f.store, featureEnabled: true, ready: true }, protocolNetlimit: { store: f.netlimit }, otp: { store: f.otpStore },
    config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: false,
    dockerapi: f.dockerapi, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  const origin = 'https://mailadmin.example.com', logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin, 'x-mailadmin-csrf': logged.json().csrf };
  const response = await app.inject({ method: 'POST', url: '/api/admin/aliases', headers, payload: { address: 'new@example.com', targets: [user] } });
  assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().error.code, 'RETIREMENT_ROUTE_PROTECTED');
  assert.equal(response.headers['www-authenticate'], undefined); assert.equal(writes(f).length, 0); assert.equal(f.lockDepth(), 0);
});
