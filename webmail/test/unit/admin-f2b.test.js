import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createF2bService } from '../../server/admin/services/f2b.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';
const ctx = { session: {}, actor: 'admin', ip: '198.51.100.73' };
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a15b-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const value = { ban_time: 1800, ban_time_increment: true, max_ban_time: 86400, max_attempts: 10, retry_window: 600, netban_ipv4: 24, netban_ipv6: 64, manage_external: 1, whitelist: '192.0.2.10', blacklist: '203.0.113.10', regex: ['synthetic-regex-excluded'], banlist_id: 'synthetic-id', active_bans: [{ network: '198.51.100.0/24', ip: '198.51.100.0', queued_for_unban: 0, banned_until: '00h 10m 00s', private: 'excluded' }], perm_bans: [{ network: '203.0.113.10', ip: '203.0.113.10' }] };
  const calls = [], options = {}, logs = [];
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); await options.onCall?.({ method, path, body });
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (method === 'GET') { assert.equal(path, '/api/v1/get/fail2ban'); return structuredClone(value); }
    assert.equal(path, '/api/v1/edit/fail2ban'); if (options.ignoreWrites) return [{ type: 'success' }];
    const attr = body.attr;
    if (attr.action) for (const name of body.items) {
      if (['unban', 'whitelist'].includes(attr.action)) {
        if (options.immediate) value.active_bans = value.active_bans.filter(row => row.network !== name);
        else for (const row of value.active_bans) if (row.network === name) row.queued_for_unban = 1;
      }
      if (attr.action !== 'unban') { const other = attr.action === 'whitelist' ? 'blacklist' : 'whitelist'; value[attr.action] = [...new Set([...value[attr.action].split('\n').filter(Boolean), name])].sort().join('\n'); value[other] = value[other].split('\n').filter(item => item !== name).join('\n'); }
    }
    else {
      assert.deepEqual(body.items, []);
      for (const key of ['ban_time', 'max_ban_time', 'max_attempts', 'retry_window', 'netban_ipv4', 'netban_ipv6', 'ban_time_increment', 'manage_external', 'whitelist', 'blacklist']) assert.ok(Object.hasOwn(attr, key), key);
      Object.assign(value, attr, { ban_time_increment: attr.ban_time_increment === '1', manage_external: Number(attr.manage_external) });
    }
    return [{ type: 'success' }];
  } };
  const audit = createAudit({ dir: join(dir, 'audit'), logger: { info(data) { logs.push(data); } } }), lock = createResourceLock(), history = createHistoryService({ audit, lock }), service = createF2bService({ mailcow, audit, lock, history });
  return { dir, value, calls, options, logs, mailcow, audit, lock, history, service };
}
const writes = f => f.calls.filter(row => row.method === 'POST');
const action = (f, network, action) => f.service.action({ ...ctx, data: { network, action } });
const put = async (f, changes, tag) => f.service.put({ ...ctx, data: { etag: tag ?? (await f.service.get({}, ctx.ip)).etag, ...changes } });
const revert = (f, id) => f.history.revert(id, { ...ctx, confirm: true });

test('f2b GET projection: settings/lists/bans only, all ports notice and self', async t => {
  const f = await fixture(t), result = await f.service.get({}, ctx.ip); assert.deepEqual(Object.keys(result).sort(), ['settings', 'whitelist', 'blacklist', 'activeBans', 'permanentBans', 'etag'].sort()); assert.deepEqual(result.whitelist, ['192.0.2.10']); assert.equal(result.settings.manage_external, true);
  assert.equal(result.activeBans[0].self, true); assert.equal(result.activeBans[0].affectsAllPorts, true); assert.match(result.activeBans[0].notice, /웹메일·관리 화면.*모든 메일 포트/); assert.equal(result.permanentBans[0].self, false); assert.equal(result.activeBans[0].private, undefined); assert.ok(!JSON.stringify(result).includes('synthetic-'));
});
for (const [network, client, expected] of [['2001:db8:1::/64', '2001:db8:1::73', true], ['2001:db8:1::/64', '2001:db8:2::73', false], ['192.0.2.10', '192.0.2.73', true], ['192.0.2.10', '198.51.100.73', false], ['2001:db8:1::10', '2001:db8:1::73', true], ['198.51.100.0/24', '::ffff:198.51.100.73', true], ['192.0.2.0/32', '192.0.2.73', false]]) test(`f2b self ${network} ${client}`, async t => { const f = await fixture(t); f.value.active_bans = [{ network }]; assert.equal((await f.service.get({}, client)).activeBans[0].self, expected); });
test('f2b GET absent ban keys and empty lists', async t => { const f = await fixture(t); delete f.value.active_bans; delete f.value.perm_bans; f.value.whitelist = ''; const result = await f.service.get({}); assert.deepEqual(result.activeBans, []); assert.deepEqual(result.permanentBans, []); assert.deepEqual(result.whitelist, []); });
test('f2b unban exact body, queued readback, irreversible, already queued unchanged', async t => {
  const f = await fixture(t), result = await action(f, '198.51.100.0/24', 'unban'); assert.deepEqual(writes(f)[0].body, { items: ['198.51.100.0/24'], attr: { action: 'unban' } }); assert.equal(result.notice, '해제 요청됨 — 몇 초 안에 풀려요'); const record = await f.history.detail(result.auditId); assert.equal(record.kind, 'irreversible'); assert.equal(record.canRevert, false); await assert.rejects(revert(f, result.auditId), { statusCode: 409 }); assert.equal((await action(f, '198.51.100.0/24', 'unban')).unchanged, true); assert.equal(writes(f).length, 1);
});
test('f2b unban disappearing active entry succeeds', async t => { const f = await fixture(t); f.options.immediate = true; await action(f, '198.51.100.0/24', 'unban'); assert.deepEqual(f.value.active_bans, []); });
test('f2b unban absent404/permanent409 writes zero', async t => { const f = await fixture(t); await assert.rejects(action(f, '192.0.2.99', 'unban'), { statusCode: 404 }); await assert.rejects(action(f, '203.0.113.10', 'unban'), error => error.statusCode === 409 && error.code === 'PERM_BAN' && /blacklist/.test(error.message)); assert.equal(writes(f).length, 0); });
for (const operation of ['whitelist', 'blacklist']) test(`f2b ${operation} exact body, undo/redo restores opposite membership while preserving others/settings`, async t => {
  const f = await fixture(t), name = operation === 'whitelist' ? '203.0.113.10' : '192.0.2.10', result = await action(f, name, operation); assert.deepEqual(writes(f)[0].body, { items: [name], attr: { action: operation } }); const record = await f.history.detail(result.auditId); assert.equal(record.canRevert, true); assert.equal(record.before[operation], false); assert.equal(record.after[operation], true);
  if (operation === 'whitelist') { assert.equal(result.notice, '차단 해제 요청은 되돌리지 않음'); assert.equal(record.detail.notice, result.notice); }
  assert.equal((await action(f, name, operation)).unchanged, true); assert.equal(writes(f).length, 1); f.value.whitelist += '\n192.0.2.88'; f.value.blacklist += '\n203.0.113.88'; f.value.retry_window = 900; f.value.manage_external = 0;
  const undo = await revert(f, result.auditId); assert.equal(f.value.retry_window, 900); assert.equal(f.value.manage_external, 0); assert.ok(f.value.whitelist.includes('192.0.2.88')); assert.ok(f.value.blacklist.includes('203.0.113.88')); assert.equal(f.value[operation].split('\n').includes(name), false); assert.equal(f.value[operation === 'whitelist' ? 'blacklist' : 'whitelist'].split('\n').includes(name), true); assert.equal(writes(f).at(-1).body.attr.ban_time_increment, '1'); assert.equal(writes(f).at(-1).body.attr.manage_external, '0'); await revert(f, undo.id); assert.equal(f.value[operation].split('\n').includes(name), true);
});
test('f2b whitelist undo preserves unban queue', async t => { const f = await fixture(t), name = f.value.active_bans[0].network, result = await action(f, name, 'whitelist'); await revert(f, result.auditId); assert.equal(f.value.active_bans[0].queued_for_unban, 1); assert.ok(!f.value.whitelist.includes(name)); });
for (const network of ['192.0.2.24', '192.0.2.0/24', '2001:db8::73', '2001:db8::/32']) test(`f2b network ${network}`, async t => { const f = await fixture(t); await action(f, network, 'whitelist'); assert.deepEqual(writes(f)[0].body.items, [network]); });
for (const [network, operation] of [['192.0.2.1', 'reset-regex'], ['192.0.2.1', 'edit-regex'], ['invalid', 'unban'], ['192.0.2.0/33', 'blacklist'], ['2001:db8::/129', 'blacklist'], [['192.0.2.1'], 'whitelist'], ['192.0.2.1,192.0.2.2', 'whitelist'], ['2001:db8::%eth0', 'whitelist']]) test(`f2b action rejects ${network} ${operation}`, async t => { const f = await fixture(t); await assert.rejects(action(f, network, operation), { statusCode: 422 }); assert.equal(writes(f).length, 0); });
test('f2b PUT merged full body includes omitted increment/manage_external and lists; unchanged and undo swap', async t => {
  const f = await fixture(t), initial = await f.service.get({}, ctx.ip), result = await put(f, { max_attempts: 11 }); assert.deepEqual(writes(f)[0].body, { items: [], attr: { ...initial.settings, max_attempts: 11, ban_time_increment: '1', manage_external: '1', whitelist: '192.0.2.10', blacklist: '203.0.113.10' } }); assert.equal(result.settings.ban_time_increment, true); assert.equal((await put(f, { max_attempts: 11 })).unchanged, true); assert.equal(writes(f).length, 1); const undo = await revert(f, result.auditId); assert.equal(f.value.max_attempts, 10); await revert(f, undo.id); assert.equal(f.value.max_attempts, 11);
});
test('f2b false increment preserved during other edit, boolean switch works', async t => { const f = await fixture(t); f.value.ban_time_increment = false; await put(f, { retry_window: 900 }); assert.equal(writes(f)[0].body.attr.ban_time_increment, '0'); await put(f, { ban_time_increment: true }); assert.equal(f.value.ban_time_increment, true); });
for (const changes of [{ ban_time: 59 }, { max_ban_time: 59 }, { max_attempts: 0 }, { retry_window: 0 }, { netban_ipv4: 7 }, { netban_ipv4: 33 }, { netban_ipv6: 7 }, { netban_ipv6: 129 }, { ban_time: 60.1 }, { max_attempts: '10' }, { ban_time_increment: 1 }, { manage_external: true }, { whitelist: [] }, { blacklist: '' }, { regex: [] }, { retry_window: Number.MAX_SAFE_INTEGER + 1 }]) test(`f2b PUT rejects ${JSON.stringify(changes)}`, async t => { const f = await fixture(t); await assert.rejects(put(f, changes), { statusCode: 422 }); assert.equal(writes(f).length, 0); });
test('f2b minimum and prefix endpoints accepted', async t => { const f = await fixture(t); await put(f, { ban_time: 60, max_ban_time: 60, max_attempts: 1, retry_window: 1, netban_ipv4: 8, netban_ipv6: 8 }); await put(f, { netban_ipv4: 32, netban_ipv6: 128 }); assert.equal(f.value.netban_ipv6, 128); });
test('f2b etag409, settings undo preserves current lists and rejects changed settings', async t => { const f = await fixture(t), old = await f.service.get({}); f.value.retry_window = 900; await assert.rejects(put(f, { max_attempts: 11 }, old.etag), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 0); const result = await put(f, { max_attempts: 11 }); f.value.whitelist += '\n192.0.2.88'; await revert(f, result.auditId); assert.ok(f.value.whitelist.includes('192.0.2.88')); const again = await put(f, { max_attempts: 12 }); f.value.ban_time = 2400; await assert.rejects(revert(f, again.auditId), { statusCode: 409 }); });
test('f2b membership undo expected detects changed affected entry', async t => { const f = await fixture(t), result = await action(f, '192.0.2.24', 'whitelist'); f.value.whitelist = '192.0.2.10'; await assert.rejects(revert(f, result.auditId), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); });
for (const operation of ['settings', 'whitelist', 'unban']) test(`f2b ${operation} readback502`, async t => { const f = await fixture(t); f.options.ignoreWrites = true; await assert.rejects(operation === 'settings' ? put(f, { max_attempts: 11 }) : action(f, operation === 'unban' ? '198.51.100.0/24' : '192.0.2.24', operation), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' }); });
test('f2b locks serialize same-etag PUT and duplicate action', async t => { const f = await fixture(t), tag = (await f.service.get({})).etag, results = await Promise.allSettled([put(f, { max_attempts: 11 }, tag), put(f, { max_attempts: 12 }, tag)]); assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.statusCode, 409); const added = await Promise.all([action(f, '192.0.2.24', 'whitelist'), action(f, '192.0.2.24', 'whitelist')]); assert.equal(added.filter(row => row.unchanged).length, 1); });
test('f2b auth loss403 and audit failure prevents writes', async t => { const f = await fixture(t); f.options.onCall = () => { throw new MailcowAuthLost(); }; await assert.rejects(f.service.get({}), { statusCode: 403 }); f.options.onCall = undefined; const blocked = createF2bService({ mailcow: f.mailcow, lock: f.lock, history: { register() {} }, audit: { async run() { throw new Error('synthetic-audit-failure'); } } }); await assert.rejects(blocked.action({ ...ctx, data: { network: '192.0.2.24', action: 'whitelist' } }), /synthetic-audit-failure/); assert.equal(writes(f).length, 0); });
test('f2b HTTP: guard403, GET self, actions/PUT contracts and health smoke', async t => {
  const f = await fixture(t), logs = [], app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['198.51.100.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: join(f.dir, 'http-audit') }, logger: { level: 'info', stream: { write: line => logs.push(line) } }, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close()); assert.equal((await app.inject('/api/admin/fail2ban')).statusCode, 403);
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', remoteAddress: ctx.ip, headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic-f2b-password' } }); assert.equal(login.statusCode, 200, login.body); const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': login.json().csrf };
  const listed = await app.inject({ url: '/api/admin/fail2ban', remoteAddress: ctx.ip, headers }); assert.equal(listed.statusCode, 200); assert.equal(listed.json().activeBans[0].self, true); assert.equal((await app.inject({ method: 'POST', url: '/api/admin/fail2ban/actions', headers, payload: { network: '192.0.2.24', action: 'reset-regex' } })).statusCode, 422);
  for (const payload of [{ network: '192.0.2.24', action: 'whitelist' }, { network: '198.51.100.0/24', action: 'unban' }]) { const result = await app.inject({ method: 'POST', url: '/api/admin/fail2ban/actions', headers, payload }); assert.equal(result.statusCode, 200, result.body); }
  const changed = await app.inject({ method: 'PUT', url: '/api/admin/fail2ban/settings', headers, payload: { etag: listed.json().etag, max_attempts: 12 } }); assert.equal(changed.statusCode, 200, changed.body); assert.equal((await app.inject('/healthz')).json().ok, true); assert.ok(!logs.join('').includes('synthetic-f2b-password')); assert.ok(!JSON.stringify(await app.audit.read()).includes('synthetic-regex-excluded'));
});
