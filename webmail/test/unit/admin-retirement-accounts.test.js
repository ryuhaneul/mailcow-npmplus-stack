import { createHash } from 'node:crypto';
import { createRetirementReadiness } from '../../server/admin/retirement-readiness.js';
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
    if (path.startsWith('/api/v1/get/active-user-sieve/')) return options.userScript && (!options.userScriptOwner || options.userScriptOwner === decodeURIComponent(path.split('/').at(-1))) ? [options.userScript] : {};
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
    async listSieve(address) { return options.userScript && (!options.userScriptOwner || options.userScriptOwner === address) ? [{ name: 'personal', active: true }] : []; },
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
  return { teams, states, keyRows, storeCalls, store, routing, retirement, lockDepth: () => lockDepth, netlimit, otpRows, otpStore, dir, boxes, filters, aliases, jobs, acl, calls, aclCalls, options, mailcow, dockerapi, aclFolders, audit, lock, history, service };
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
  assert.equal(preview.refs.shares, null); assert.equal(preview.sharesState, 'deferred-kept'); assert.equal(preview.sharesScope, 'not-loaded');
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


test('retirement detail exposes current forwarding targets using preview inspection without extra filter fetches', async t => {
  const f = await fixture(t); retired(f);
  assert.deepEqual((await f.service.detail({}, user)).retirement.forwarding, []);
  f.filters.push({ id: 91, username: user, filter_type: 'prefilter', active: 1, script_data: `require ["copy"]; redirect :copy "${other}";` });
  const reads = f.calls.filter(row => row.path === '/api/v1/get/filters/all').length;
  assert.deepEqual((await f.service.detail({}, user)).retirement.forwarding, [other]);
  assert.equal(f.calls.filter(row => row.path === '/api/v1/get/filters/all').length, reads + 1);
  const preview = await settingsPreview(f, { receiveBlocked: false });
  assert.deepEqual(preview.forwarding.flatMap(row => row.targets), [other]);
  f.filters.push({ id: 92, username: user, filter_type: 'prefilter', active: 1, script_data: 'include "opaque";' });
  assert.equal((await f.service.detail({}, user)).retirement.forwarding, null);
});


test('deployment readiness: strict JSON, 300-second future bound, no TTL, dynamic file replacement and OFF', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'retirement-ready-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json'), now = Date.parse('2026-11-10T00:00:00.000Z');
  const read = createRetirementReadiness({ enabled: true, file, now: () => now });
  const valid = { ready: true, checkedAt: new Date(now).toISOString(), hookHash: 'a'.repeat(64) };
  assert.equal(read(), false);
  for (const value of [null, [], {}, { ...valid, ready: 'true' }, { ...valid, hookHash: 'invalid' }, { ...valid, checkedAt: '2026-02-30T00:00:00.000Z' }, { ...valid, checkedAt: '2026-11-10' }, { ...valid, extra: 'not allowed' }, { ...valid, checkedAt: new Date(now + 300_001).toISOString() }]) {
    await fs.writeFile(file, JSON.stringify(value)); assert.equal(read(), false, JSON.stringify(value));
  }
  await fs.writeFile(file, '{invalid'); assert.equal(read(), false);
  await fs.writeFile(file, 'x'.repeat(1025)); assert.equal(read(), false);
  await fs.writeFile(file, JSON.stringify({ ...valid, checkedAt: new Date(now + 300_000).toISOString() })); assert.equal(read(), true);
  await fs.writeFile(file, JSON.stringify({ ...valid, checkedAt: '2000-01-01T00:00:00.000Z' })); assert.equal(read(), true, 'no TTL');
  const off = createRetirementReadiness({ enabled: false, file, now: () => now }); assert.equal(off(), false);
  const replacement = join(dir, 'next.json'); await fs.writeFile(replacement, JSON.stringify({ ...valid, ready: false })); await fs.rename(replacement, file); assert.equal(read(), false);
  await fs.unlink(file); await fs.writeFile(replacement, JSON.stringify(valid)); await fs.symlink(replacement, file); assert.equal(read(), false);
});

test('admin deployment readiness: successive account requests reflect publication without restarting', async t => {
  const f = await fixture(t); retired(f, { blocked: true });
  const file = join(f.dir, 'ready.json');
  const app = await createAdminApp({ retirement: { store: f.store, routing: f.routing }, protocolNetlimit: { store: f.netlimit }, otp: { store: f.otpStore },
    config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir,
      retirementReceiveBlockEnabled: true, retirementReadinessFile: file }, logger: false,
    dockerapi: f.dockerapi, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } });
  t.after(() => app.close());
  const origin = 'https://mailadmin.example.com', login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin, 'x-mailadmin-csrf': login.json().csrf };
  const get = async () => { const response = await app.inject({ url: `/api/admin/mailboxes/${user}`, headers }); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  const publication = { ready: true, checkedAt: new Date().toISOString(), hookHash: 'b'.repeat(64) };
  assert.equal((await get()).retirement.effectiveReceiveBlock, 'unverified');
  await fs.writeFile(file, JSON.stringify(publication)); assert.equal((await get()).retirement.effectiveReceiveBlock, 'on');
  await fs.writeFile(file, JSON.stringify({ ...publication, ready: false })); assert.equal((await get()).retirement.effectiveReceiveBlock, 'unverified');
  const denied = await app.inject({ method: 'PATCH', url: `/api/admin/mailboxes/${user}/retirement`, headers, payload: { receiveBlocked: true } });
  assert.equal(denied.statusCode, 503, denied.body); assert.equal(denied.json().error.code, 'RETIREMENT_BLOCK_UNAVAILABLE'); assert.equal(denied.headers['www-authenticate'], undefined);
  await fs.rm(file); assert.equal((await get()).retirement.effectiveReceiveBlock, 'unverified');
  assert.equal(writes(f).length, 0);
});


test('D2-01 dormant Sieve activation and mailbox history guard all three layers before writes', async t => {
  for (const mode of ['edit', 'history']) for (const layer of ['prefilter', 'postfilter', 'user']) {
    await t.test(`${mode} ${layer}: protected redirect 409, unavailable 503, safe activation allowed`, async t => {
      const f = await fixture(t);
      let record;
      if (mode === 'history') {
        const p = await f.service.detail({}, other);
        await f.service.edit({ ...context, addr: other, data: { etag: p.etag, active: false } });
        record = (await f.history.list()).items.find(row => row.action === 'mailbox.edit');
      } else f.boxes.find(row => row.username === other).active = 0;
      f.boxes.find(row => row.username === user).active = 2;
      const script = `redirect :copy "${user}";`;
      if (layer === 'user') { f.options.userScript = script; f.options.userScriptOwner = other; }
      else f.filters.push({ id: 99, username: other, filter_type: layer, active: 1, script_data: script });
      // ON may exclude dormant owners, but activation must guard what will become executable.
      assert.equal((await f.routing.inspect({}, user)).ready, true);
      f.keyRows.set(user, [user]);
      const editEtag = (await f.service.detail({}, other)).etag;
      const activate = async () => mode === 'history'
        ? f.history.revert(record.id, { ...context, confirm: true })
        : f.service.edit({ ...context, addr: other, data: { etag: editEtag, active: true } });
      const baseline = writes(f).length;
      await assert.rejects(activate(), { statusCode: 409 });
      assert.equal(writes(f).length, baseline); assert.equal(f.boxes.find(row => row.username === other).active, 0);
      f.options.onCall = ({ path }) => { if (path === (layer === 'user' ? `/api/v1/get/active-user-sieve/${encodeURIComponent(other)}` : '/api/v1/get/filters/all')) throw new Error('synthetic lookup failure'); };
      await assert.rejects(activate(), { statusCode: 503 });
      assert.equal(writes(f).length, baseline); assert.equal(f.boxes.find(row => row.username === other).active, 0);
      f.options.onCall = null;
      if (layer === 'user') f.options.userScript = 'redirect "healthy@external.test";';
      else f.filters.at(-1).script_data = 'redirect "healthy@external.test";';
      await activate(); assert.equal(f.boxes.find(row => row.username === other).active, 1);
      assert.equal(writes(f).length, baseline + 1);
    });
  }
});


test('F6 settings ON requires explicit removal of a pure owner prefilter with an unresolved literal', async t => {
  const f = await fixture(t); retired(f);
  f.filters.push({ id: 10, username: user, filter_type: 'prefilter', active: 1,
    script_data: 'require ["copy"]; redirect :copy "missing@example.com";' });
  const kept = await settingsPreview(f, { receiveBlocked: true });
  assert.ok(kept.blockers.some(row => ['OWNER_FORWARD_ACTIVE', 'FILTER_ROUTE_UNKNOWN'].includes(row.code)));
  await assert.rejects(settingsRun(f, { receiveBlocked: true, etag: kept.etag }), { statusCode: 409, code: 'RETIREMENT_ROUTES_REMAIN' });
  assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
  const removed = await settingsPreview(f, { receiveBlocked: true, forwardTo: null });
  assert.deepEqual(removed.blockers, []); assert.equal(removed.changes[0].kind, 'owner-forward');
  await assert.rejects(settingsRun(f, { receiveBlocked: true, forwardTo: null, etag: removed.etag }), { statusCode: 409, code: 'RETIREMENT_CLEANUP_CONFIRM_REQUIRED' });
  assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
  const result = await settingsRun(f, { receiveBlocked: true, forwardTo: null, cleanupConfirmed: true, etag: removed.etag });
  assert.equal(result.result, 'ok'); assert.equal(result.retirement.receiveBlocked, true); assert.equal(f.filters.length, 0);
});

for (const phase of ['after-preview', 'after-intent']) test(`retirement: sharing-only changes ${phase} do not conflict when keeping shares; run still reads every owner`, async t => {
  const f = await fixture(t, true);
  const p = await leave(f, { action: 'preview', cleanRefs: true, cleanShares: false });
  assert.equal(p.sharesScope, 'not-loaded'); assert.equal(p.sharesState, 'deferred-kept'); assert.equal(p.refs.shares, null);
  assert.deepEqual(f.aclCalls, []);
  const mutate = () => f.acl.set(other, [{ user: other, id: user, mailbox: 'INBOX', rights: ['lookup'] }]);
  if (phase === 'after-preview') mutate();
  else {
    const run = f.audit.run;
    f.audit.run = (entry, operation, options) => run(entry, async intent => { if (entry.action === 'mailbox.leave') mutate(); return operation(intent); }, options);
  }
  const result = await leave(f, { action: 'run', cleanRefs: true, cleanShares: false, etag: p.etag });
  assert.equal(result.result, 'ok', JSON.stringify(result));
  assert.equal(f.aclCalls.length, 9, 'prepare, locked snapshot and durable-intent recheck all retain full ACL reads');
  for (const owner of [user, team, other]) assert.equal(f.aclCalls.filter(value => value === owner).length, 3);
  assert.deepEqual(f.acl.get(other), [{ user: other, id: user, mailbox: 'INBOX', rights: ['lookup'] }]);
});

const deferredMutations = {
  account: f => { f.boxes[0].name = 'changed'; },
  netlimit: f => { f.netlimit.rows.set(user, { enabled: true, version: 'b'.repeat(32) }); },
  retirement: f => { f.states.set(user, { ...emptyRetirementState(), updatedBy: 'other-admin' }); },
  alias: f => { f.aliases[0].goto = other; },
  team: f => { f.filters[0].script_data += '# changed\n'; },
  sender: f => { f.boxes[2].sender_acl.push('changed@example.com'); },
  syncjob: f => { f.jobs[0].active = 0; },
  ownFilter: f => { f.filters.push({ id: 99, username: user, filter_type: 'prefilter', active: 1, script_desc: 'changed', script_data: 'keep;' }); },
};
for (const [kind, mutate] of Object.entries(deferredMutations)) test(`retirement: keeping shares still rejects changed ${kind} before writes`, async t => {
  const f = await fixture(t, true), p = await leave(f, { action: 'preview', cleanRefs: true, cleanShares: false });
  assert.deepEqual(f.aclCalls, []); mutate(f);
  await assert.rejects(leave(f, { action: 'run', cleanRefs: true, cleanShares: false, etag: p.etag }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
});

test('retirement: cleaning shares keeps complete preview and conflicts on a changed ACL', async t => {
  const f = await fixture(t, true), p = await leave(f, { action: 'preview', cleanRefs: true, cleanShares: true });
  assert.equal(p.sharesScope, 'all'); assert.equal(p.sharesState, undefined); assert.ok(Array.isArray(p.refs.shares)); assert.equal(f.aclCalls.length, 3);
  f.acl.set(other, [{ user: other, id: user, mailbox: 'INBOX', rights: ['lookup'] }]);
  await assert.rejects(leave(f, { action: 'run', cleanRefs: true, cleanShares: true, etag: p.etag }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
});

test('retirement: display-only preview skips failing ACL readers but execution keeps their existing reads and warnings', async t => {
  const f = await fixture(t, true); f.options.aclFailure = other;
  const p = await leave(f, { action: 'preview', cleanRefs: true, cleanShares: false });
  assert.deepEqual(f.aclCalls, []); assert.equal(p.refs.shares, null); assert.ok(!p.warnings.some(row => row.code === 'SHARES_PARTIAL'));
  const result = await leave(f, { action: 'run', cleanRefs: true, cleanShares: false, etag: p.etag });
  assert.equal(result.result, 'ok', JSON.stringify(result)); assert.equal(f.aclCalls.length, 9);
  assert.ok(result.warnings.some(row => row.code === 'SHARES_PARTIAL'));
});

// Complete preview DTO digests captured from the unchanged stage-3 fixture.
const snapshotCases = [
  { options: {"mode":"disable","cleanRefs":true,"cleanShares":false}, digest: "50d026461148344030449c57a3ef4994960d3c12cda1b933e1cbff9552ae5e30", aclReads: 0, counts: {"/api/v1/get/mailbox/user%40example.com": 1, "/api/v1/get/filters/all": 1, "/api/v1/get/alias/all": 1, "/api/v1/get/mailbox/all": 1, "/api/v1/get/app-passwd/all/user%40example.com": 1, "/api/v1/get/syncjobs/all/no_log": 1} },
  { options: {"mode":"disable","cleanRefs":true,"cleanShares":true}, digest: "4f59d4a2e7b6c60bc956a6875abf29114299643b039c292bdc97e71ff4cfcbb1", aclReads: 3, counts: {"/api/v1/get/mailbox/user%40example.com": 1, "/api/v1/get/filters/all": 1, "/api/v1/get/alias/all": 1, "/api/v1/get/mailbox/all": 1, "/api/v1/get/app-passwd/all/user%40example.com": 1, "/api/v1/get/syncjobs/all/no_log": 1} },
  { options: {"mode":"delete","cleanRefs":true,"cleanShares":true}, digest: "baf28236a381ad0314519bee9e70256c162da8470b894125ad22fd9cd49d64e6", aclReads: 3, counts: {"/api/v1/get/mailbox/user%40example.com": 1, "/api/v1/get/filters/all": 1, "/api/v1/get/alias/all": 1, "/api/v1/get/mailbox/all": 1, "/api/v1/get/app-passwd/all/user%40example.com": 1, "/api/v1/get/syncjobs/all/no_log": 1} },
  { options: {"mode":"disable","cleanRefs":false,"cleanShares":false}, digest: "d37fae03c7bdf10ca552032c4fd1ccea51dded72da412e77763382a91e4a0bce", aclReads: 0, counts: {"/api/v1/get/mailbox/user%40example.com": 1, "/api/v1/get/filters/all": 1} },
  { options: {"mode":"disable","cleanRefs":true,"cleanShares":false,"forwardTo":"other@example.com"}, digest: "8b4f05981ce766847044b0fc2a686c317dc908527e3cfec2124f70f2bef9d89f", aclReads: 0, counts: {"/api/v1/get/mailbox/user%40example.com": 1, "/api/v1/get/filters/all": 2, "/api/v1/get/mailbox/all": 2, "/api/v1/get/alias/all": 1, "/api/v1/get/app-passwd/all/user%40example.com": 1, "/api/v1/get/syncjobs/all/no_log": 1} },
];
for (const { options, digest, aclReads, counts } of snapshotCases) test(`snapshot: preview reuses one calculation ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, true);
  let retirementReads = 0, forwardPlans = 0;
  const read = f.store.read, forward = f.teams.previewForward;
  f.store.read = async (...args) => { retirementReads++; return read(...args); };
  f.teams.previewForward = async (...args) => { forwardPlans++; return forward(...args); };
  const result = await leave(f, { action: 'preview', ...options });
  assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), digest, 'complete DTO and etag match the stage-3 baseline');
  const actual = {};
  for (const row of f.calls.filter(row => row.method === 'GET')) actual[row.path] = (actual[row.path] ?? 0) + 1;
  assert.deepEqual(actual, counts);
  assert.equal(f.aclCalls.length, aclReads);
  assert.equal(writes(f).length, 0);
  if (options.mode === 'disable') {
    assert.equal(retirementReads, 1);
    assert.equal(forwardPlans, options.forwardTo ? 1 : 0);
  }
});

for (const phase of ['before-locked-snapshot', 'after-intent']) for (const [kind, mutate] of Object.entries(deferredMutations)) test(`snapshot: ${kind} changes ${phase} are freshly checked before writes`, async t => {
  const f = await fixture(t, true), options = { cleanRefs: true, cleanShares: false };
  const preview = await leave(f, { action: 'preview', ...options });
  if (phase === 'before-locked-snapshot') {
    const run = f.lock.run;
    let changed = false;
    f.lock.run = (key, operation) => {
      if (key === `flow:${user}` && !changed) { changed = true; mutate(f); }
      return run(key, operation);
    };
  } else {
    const run = f.audit.run;
    f.audit.run = (entry, operation, options) => run(entry, async intent => {
      if (entry.action === 'mailbox.leave') mutate(f);
      return operation(intent);
    }, options);
  }
  await assert.rejects(leave(f, { action: 'run', ...options, etag: preview.etag }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  assert.equal(writes(f).length, 0);
  assert.equal(f.storeCalls.length, 0);
});

for (const kind of ['account', 'retirement', 'ownFilter']) test(`snapshot: first-write settings check reloads ${kind} after the lifecycle recheck`, async t => {
  const f = await fixture(t, true), options = { cleanRefs: true, cleanShares: false };
  const preview = await leave(f, { action: 'preview', ...options });
  const read = f.store.read;
  let reads = 0;
  f.store.read = async (...args) => {
    // Prepare, locked lifecycle, durable-intent lifecycle, then first-write settings.
    if (++reads === 4) deferredMutations[kind](f);
    return read(...args);
  };
  await assert.rejects(leave(f, { action: 'run', ...options, etag: preview.etag }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  assert.equal(reads, 4);
  assert.equal(writes(f).length, 0);
  assert.equal(f.storeCalls.length, 0);
});

test('snapshot: a shared forward preview preserves recipient guards and fresh execution validation', async t => {
  const f = await fixture(t), options = { cleanRefs: true, cleanShares: false, forwardTo: other };
  let guards = 0, plans = 0;
  const recipients = f.routing.assertRecipients, forward = f.teams.previewForward;
  f.routing.assertRecipients = async (...args) => { guards++; return recipients(...args); };
  f.teams.previewForward = async (...args) => { plans++; return forward(...args); };
  const p = await leave(f, { action: 'preview', ...options });
  assert.equal(plans, 1); assert.equal(guards, 1);
  // The recipient becomes protected after preview; prepare must check it again.
  f.keyRows.set(other, [other]);
  await assert.rejects(leave(f, { action: 'run', ...options, etag: p.etag }), { statusCode: 409 });
  assert.equal(plans, 2); assert.equal(guards, 2);
  assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
});

test('snapshot: later previews use new datasets and forwarding plans', async t => {
  const f = await fixture(t), options = { cleanRefs: true, cleanShares: false, forwardTo: other };
  let plans = 0;
  const forward = f.teams.previewForward;
  f.teams.previewForward = async (...args) => { plans++; return forward(...args); };
  const first = await leave(f, { action: 'preview', ...options });
  f.filters.push({ id: 99, username: user, filter_type: 'prefilter', active: 1, script_data: `require ["copy"]; redirect :copy "${other}";` });
  const second = await leave(f, { action: 'preview', ...options });
  assert.equal(plans, 2); assert.notEqual(first.etag, second.etag);
  assert.equal(second.forwardingChange.effect, 'unchanged');
  assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
});

// Error contracts captured from the pre-snapshot-reuse implementation.
const forwardErrorCases = {
  "missing": {
    "statusCode": 422,
    "code": "INVALID_ADDRESS",
    "message": "활성 내부 메일함과 구성원을 확인해 주세요."
  },
  "inactive": {
    "statusCode": 422,
    "code": "INVALID_ADDRESS",
    "message": "활성 내부 메일함과 구성원을 확인해 주세요."
  },
  "self": {
    "statusCode": 422,
    "code": "INVALID_ADDRESS",
    "message": "활성 내부 메일함과 구성원을 확인해 주세요."
  },
  "malformed": {
    "statusCode": 422,
    "code": "INVALID_INPUT",
    "message": "계정 입력값을 확인해 주세요."
  },
  "blocked": {
    "statusCode": 409,
    "code": "RETIREMENT_RECIPIENT_BLOCKED",
    "message": "수신 차단된 계정으로 전달할 수 없어요."
  },
  "blocked-missing": {
    "statusCode": 422,
    "code": "INVALID_ADDRESS",
    "message": "활성 내부 메일함과 구성원을 확인해 주세요."
  },
  "multiple": {
    "statusCode": 409,
    "code": "MULTIPLE_PREFILTERS",
    "message": "사전 필터가 여러 개예요. 필터 화면에서 먼저 정리해 주세요."
  },
  "blocked-multiple": {
    "statusCode": 409,
    "code": "MULTIPLE_PREFILTERS",
    "message": "사전 필터가 여러 개예요. 필터 화면에서 먼저 정리해 주세요."
  }
};
for (const [kind, expected] of Object.entries(forwardErrorCases)) test(`snapshot: invalid forwarding preserves the original error for ${kind}`, async t => {
  const f = await fixture(t); let target = other;
  if (kind.includes('missing')) target = 'missing@example.com';
  if (kind === 'inactive') f.boxes[2].active = 0;
  if (kind === 'self') target = user;
  if (kind === 'malformed') target = 'invalid';
  if (kind.includes('blocked')) f.keyRows.set(target, [target]);
  if (kind.includes('multiple')) f.filters.push(...[1, 2].map(id => ({ id, username: user, filter_type: 'prefilter', active: 1, script_data: 'keep;' })));
  await assert.rejects(leave(f, { action: 'preview', cleanRefs: true, forwardTo: target }), expected);
  assert.equal(writes(f).length, 0); assert.equal(f.storeCalls.length, 0);
});
