import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createAccountsService } from '../../server/admin/services/accounts.js';
import { createTeamsService } from '../../server/admin/services/teams.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';
import { logOptions } from '../../server/log.js';

const GB = 1024 ** 3, user = 'user@example.com', team = 'team@example.com', next = 'next@example.com';
const secret = 'Synthetic-Password-For-A06!';
const keys = ['imap', 'pop3', 'smtp', 'sieve', 'eas', 'dav'];
const makeBox = (username, extra = {}) => ({ username, name: username.split('@')[0], quota: 20 * GB, quota_used: 1024, messages: 2, active: 1,
  attributes: Object.fromEntries(keys.map(key => [`${key}_access`, '1'])), sender_acl: [], ...extra });
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a06-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const boxes = [makeBox(user), makeBox(team, { quota: 50 * GB }), makeBox('admin@example.com', { quota: 3 * GB }), makeBox('off@example.com', { active: 0 }), makeBox('left@example.com', { active: 2 })];
  const filters = [{ id: 1, username: team, filter_type: 'prefilter', active: 1, script_data: `require ["copy"];\nredirect :copy "${user}";\n` }];
  const domains = [{ domain_name: 'example.com', active: 1 }], aliases = [], jobs = [], appPasswords = [], calls = [], aclCalls = [], options = {};
  const acl = new Map(), logs = [];
  const mailcow = { async call(_session, method, path, body) {
    options.onCall?.({ method, path, body, boxes });
    calls.push({ method, path, body: structuredClone(body) });
    if (method === 'POST' && options.failPath === path) throw options.failure ?? new AppError(422, 'MAILCOW_REJECTED', secret);
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/mailbox/all') return structuredClone(boxes);
    if (path.startsWith('/api/v1/get/mailbox/')) return structuredClone(boxes.find(row => row.username === decodeURIComponent(path.split('/').at(-1))) ?? {});
    if (path === '/api/v1/get/filters/all') return structuredClone(filters.length ? filters : {});
    if (path === '/api/v1/get/alias-domain/all') return [];
    if (path === '/api/v1/get/domain/all') return structuredClone(domains);
    if (path === '/api/v1/get/alias/all') return structuredClone(aliases);
    if (path === '/api/v1/get/syncjobs/all/no_log') return structuredClone(jobs);
    if (path.startsWith('/api/v1/get/app-passwd/all/')) return structuredClone(appPasswords);
    if (path === '/api/v1/add/mailbox') {
      if (!options.ignoreWrites) boxes.push(makeBox(`${body.local_part}@${body.domain}`, { name: body.name, quota: Number(body.quota) * 1024 ** 2, ...options.created }));
    } else if (path === '/api/v1/edit/mailbox') {
      if (body.attr.password && options.passwordFailure) throw options.passwordFailure;
      if (!options.ignoreWrites) for (const addr of body.items) {
        const row = boxes.find(box => box.username === addr);
        for (const [key, value] of Object.entries(body.attr)) {
          if (key === 'quota') row.quota = Number(value) * 1024 ** 2;
          else if (key === 'active') row.active = Number(value);
          else if (key.endsWith('_access')) row.attributes[key] = value;
          else if (!['password', 'password2'].includes(key)) row[key] = structuredClone(value);
        }
      }
    } else if (path === '/api/v1/edit/filter') Object.assign(filters.find(row => String(row.id) === body.items[0]), body.attr);
    else if (path === '/api/v1/add/filter') filters.push({ id: filters.length + 1, ...body });
    else if (path === '/api/v1/add/alias') aliases.push({ id: aliases.length + 1, ...body });
    else if (path === '/api/v1/edit/alias') Object.assign(aliases.find(row => String(row.id) === body.items[0]), body.attr);
    else assert.fail(path);
    return [{ type: 'success' }];
  } };
  const dockerapi = { async getAcl(owner) { aclCalls.push(owner); if (options.aclFailure === owner) throw new Error(secret); return structuredClone(acl.get(owner) ?? []); } };
  const audit = createAudit({ dir, logger: { info(data) { logs.push(data); } } }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const teams = createTeamsService({ mailcow, audit, lock, history, auditDir: dir });
  const service = createAccountsService({ mailcow, dockerapi, audit, lock, history, teams });
  return { dir, boxes, filters, domains, aliases, jobs, appPasswords, calls, acl, aclCalls, options, logs, mailcow, dockerapi, audit, history, teams, service };
}
const context = { session: {}, actor: 'admin', ip: '198.51.100.17' };
const writes = f => f.calls.filter(call => call.method === 'POST');
const create = (f, data = {}) => f.service.create({ ...context, data: { local: 'next', domain: 'example.com', name: '새 계정', kind: 'personal', password: secret, ...data } });
const read = f => f.service.detail({}, user);
const patch = (f, expected, data) => f.service.edit({ ...context, addr: user, data: { etag: expected, ...data } });

for (const [kind, size] of [['personal', 20], ['team', 50], ['admin', 3]]) test(`accounts: ${kind} default quota is ${size}GB and initial password is response-only`, async t => {
  const f = await fixture(t), response = await create(f, { kind });
  assert.equal(response.result, 'ok'); assert.equal(response.password, secret);
  assert.equal(JSON.stringify(response).split(secret).length - 1, 1);
  const body = writes(f).find(call => call.path.endsWith('/add/mailbox')).body;
  assert.equal(body.quota, String(size * 1024)); assert.equal(body.password, secret); assert.equal(body.password2, secret);
  const records = (await f.history.list()).items; assert.equal(records.length, 2);
  assert.ok(records.every(row => row.canRevert === false)); assert.ok(!JSON.stringify(records).includes(secret));
  assert.ok(!JSON.stringify(f.logs).includes(secret));
  const flow = records.find(row => row.action === 'mailbox.create.flow');
  assert.equal(flow.detail.steps[0].auditId, response.steps[0].auditId);
  assert.equal(records.find(row => row.action === 'mailbox/create').after.password, 'set');
  assert.ok(!JSON.stringify(await f.service.detail({}, next)).includes(secret));
});

test('accounts: list searches, pages and distinguishes team/admin/off including active=2', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 55; i++) f.boxes.push(makeBox(`person${i}@example.com`));
  assert.equal((await f.service.list({})).items.length, 50); assert.equal((await f.service.list({}, { page: '2' })).items.length, 10);
  assert.deepEqual((await f.service.list({}, { kind: 'team' })).items.map(row => row.address), [team]);
  assert.equal((await f.service.list({}, { kind: 'admin' })).items[0].address, 'admin@example.com');
  assert.equal((await f.service.list({}, { kind: 'off' })).total, 2);
  f.boxes[0].name = '합성 이름'; assert.equal((await f.service.list({}, { q: '합성' })).total, 1);
  f.boxes[1].quota = 3 * GB; assert.equal((await f.service.list({}, { kind: 'team' })).total, 1);
});

for (const query of [{ page: '0' }, { kind: 'unknown' }, { q: [] }]) test(`accounts: invalid list ${JSON.stringify(query)}`, async t => {
  const f = await fixture(t); await assert.rejects(f.service.list({}, query), { statusCode: 422 });
});

test('accounts: detail projects all five references and excludes app password/sync secrets and scripts', async t => {
  const f = await fixture(t); f.boxes[0].sender_acl = [team]; f.boxes[2].sender_acl = [user];
  f.aliases.push({ address: 'alias@example.com', goto: `${user},${team}`, active: 1, sender_allowed: 1 });
  f.jobs.push({ id: 4, user2: user, active: 1, password1: secret, log: secret });
  f.appPasswords.push({ id: 1, password: secret }, { id: 2, password: secret });
  f.acl.set(team, [{ user: team, id: user, mailbox: 'INBOX', rights: ['lookup', 'read'] }, { user: team, id: user, mailbox: 'Sent', rights: ['write'] }]);
  f.acl.set(user, [{ user, id: team, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
  const result = await read(f);
  assert.equal(result.appPasswordCount, 2); assert.equal(result.sharesScope, 'teams+own');
  assert.deepEqual(result.refs.aliases, [{ address: 'alias@example.com', targets: [user, team], active: 1, senderAllowed: true }]);
  assert.deepEqual(result.refs.teams, [{ mailbox: team, filterId: 1, members: [user] }]);
  assert.deepEqual(result.refs.senders, [{ mailbox: user, sendAs: team, direction: 'received' }, { mailbox: 'admin@example.com', sendAs: user, direction: 'granted' }]);
  assert.equal(result.refs.shares.length, 2); assert.deepEqual(result.refs.syncjobs, [{ id: 4, target: user, active: 1 }]);
  assert.deepEqual(f.aclCalls.sort(), [team, user].sort());
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('redirect'));
  const revision = result.etag; f.boxes[0].messages++; f.boxes[0].quota_used++;
  assert.equal((await read(f)).etag, revision);
});

test('accounts: ACL reads have max four workers, restricted scope and partial warning', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) f.filters.push({ ...f.filters[0], username: `team${i}@example.com` });
  let inFlight = 0, maximum = 0;
  f.dockerapi.getAcl = async owner => { inFlight++; maximum = Math.max(maximum, inFlight); await new Promise(resolve => setImmediate(resolve)); inFlight--; if (owner === team) throw new Error(secret); return []; };
  const result = await read(f); assert.equal(maximum, 4); assert.equal(result.warnings[0].code, 'SHARES_PARTIAL'); assert.ok(!JSON.stringify(result).includes(secret));
});

test('accounts: missing optional team leaves mailbox and stops later stages with safe partial result', async t => {
  const f = await fixture(t), response = await create(f, { team: 'missing@example.com', alias: 'newalias@example.com', addSendForTeam: true });
  assert.equal(response.result, 'partial'); assert.equal(response.password, secret);
  assert.deepEqual(response.steps.map(row => [row.stage, row.status]), [['mailbox', 'ok'], ['team', 'failed']]);
  assert.equal(response.steps[1].code, 'NOT_TEAM'); assert.ok(f.boxes.some(row => row.username === next)); assert.equal(f.aliases.length, 0);
  const flow = (await f.history.list()).items.find(row => row.action === 'mailbox.create.flow'); assert.equal(flow.result, 'partial');
  assert.equal(flow.detail.steps.length, 2); assert.ok(!JSON.stringify(flow).includes(secret));
});

test('accounts: creation uses team backup/record, adds alias, unions existing sender ACL, and links stage records', async t => {
  const f = await fixture(t); f.options.created = { sender_acl: ['old@example.com'] };
  const result = await create(f, { team, alias: 'newalias@example.com', addSendForTeam: true });
  assert.equal(result.result, 'ok'); assert.deepEqual(result.steps.map(row => row.stage), ['mailbox', 'team', 'alias', 'permissions']);
  for (const step of result.steps) assert.match(step.auditId, /^[a-f0-9]{32}$/);
  assert.ok(f.filters[0].script_data.includes(`redirect :copy "${next}";`));
  assert.equal(f.aliases[0].goto, next);
  assert.deepEqual(f.boxes.find(row => row.username === next).sender_acl, ['old@example.com', team]);
  const records = (await f.history.list()).items;
  const permission = records.find(row => row.action === 'mailbox.sender');
  await f.history.revert(permission.id, { ...context, confirm: true }); assert.deepEqual(f.boxes.find(row => row.username === next).sender_acl, ['old@example.com']);
  const teamRecord = records.find(row => row.action === 'team.member.add');
  await f.history.revert(teamRecord.id, { ...context, confirm: true }); assert.ok(!f.filters[0].script_data.includes(next));
  assert.ok((await fs.readdir(join(f.dir, 'filter-backups'))).length >= 2);
});

test('accounts: duplicate alias stops after team without overwrite or permissions', async t => {
  const f = await fixture(t); f.aliases.push({ address: 'taken@example.com', goto: user, active: 1 });
  const result = await create(f, { team, alias: 'taken@example.com', addSendForTeam: true });
  assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'ALIAS_EXISTS'); assert.equal(f.aliases[0].goto, user);
  assert.ok(f.filters[0].script_data.includes(next)); assert.deepEqual(f.boxes.find(row => row.username === next).sender_acl, []);
});

for (const data of [{ quotaGb: 0 }, { password: '' }, { kind: 'invalid' }, { domain: 'bad/example.com' }, { addSendForTeam: true }, { local: 'bad@local' }]) test(`accounts: invalid create fields ${Object.keys(data)}`, async t => {
  const f = await fixture(t); await assert.rejects(create(f, data), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});

test('accounts: inactive domain fails initially, missing alias domain fails only at its stage', async t => {
  const f = await fixture(t); f.domains[0].active = 0; await assert.rejects(create(f), { code: 'DOMAIN_NOT_ACTIVE' }); assert.equal(writes(f).length, 0);
  f.domains[0].active = 1; const result = await create(f, { alias: 'alias@missing.example.com' });
  assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'DOMAIN_NOT_ACTIVE');
});

test('accounts: stale PATCH etag rejects before mutation; quota zero and unsupported active rejected', async t => {
  const f = await fixture(t); await assert.rejects(patch(f, 'stale', { name: '다른 이름' }), { statusCode: 409 });
  for (const data of [{ quotaGb: 0 }, { active: 2 }, { protocols: { sieve: 'no' } }, { protocols: { unknown: true } }, { password: '' }, { unknown: true }]) {
    await assert.rejects(patch(f, (await read(f)).etag, data), { statusCode: 422 });
  }
  assert.equal(writes(f).length, 0);
});

test('accounts: PATCH maps all protocol flags, warns for Sieve and is reversible with unchanged sender permissions', async t => {
  const f = await fixture(t); f.boxes[0].sender_acl = [team];
  const result = await patch(f, (await read(f)).etag, { name: '수정', quotaGb: 25, active: false, protocols: Object.fromEntries(keys.map(key => [key, false])) });
  const attr = writes(f)[0].body.attr;
  assert.equal(attr.quota, '25600'); assert.equal(attr.active, '0'); for (const key of keys) assert.equal(attr[`${key}_access`], '0');
  assert.equal(attr.sender_acl, undefined); assert.deepEqual(f.boxes[0].sender_acl, [team]); assert.equal(result.warnings[0].code, 'SIEVE_DISABLED');
  const record = (await f.history.list()).items[0]; assert.equal(record.canRevert, true);
  await f.history.revert(record.id, { ...context, confirm: true }); assert.equal(f.boxes[0].name, 'user'); assert.equal(f.boxes[0].active, 1);
});

test('accounts: concurrent external update after audit intent is rejected before POST', async t => {
  const f = await fixture(t); const revision = (await read(f)).etag; let reads = 0;
  f.options.onCall = ({ path }) => { if (path === `/api/v1/get/mailbox/${encodeURIComponent(user)}` && ++reads === 2) f.boxes[0].name = 'outside'; };
  await assert.rejects(patch(f, revision, { quotaGb: 25 }), { statusCode: 409 }); assert.equal(writes(f).length, 0);
});

test('accounts: post-write mismatch is 502 and failed record; create mismatch is also 502', async t => {
  const f = await fixture(t); f.options.ignoreWrites = true;
  await assert.rejects(patch(f, (await read(f)).etag, { name: '수정' }), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
  assert.equal((await f.history.list()).items[0].result, 'failed');
  f.options.ignoreWrites = false; f.options.created = { name: 'different' };
  await assert.rejects(create(f), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
});

test('accounts: combined PATCH records reversible settings then nonrevertible password without secret', async t => {
  const f = await fixture(t), revision = (await read(f)).etag;
  const data = { etag: revision, name: '수정', password: secret };
  const result = await f.service.edit({ ...context, addr: user, data }); assert.equal(Object.hasOwn(data, 'password'), false);
  assert.equal(result.result, 'ok'); assert.deepEqual(result.steps.map(row => row.stage), ['settings', 'password']);
  const records = (await f.audit.read()).rows.filter(row => row.phase === 'intent');
  assert.deepEqual(records.map(row => row.action), ['mailbox.edit', 'mailbox.password']); assert.equal(records[1].after.password, 'changed');
  assert.ok(!JSON.stringify(records).includes(secret)); assert.ok(!JSON.stringify(result).includes(secret));
  const settings = (await f.history.list()).items.find(row => row.action === 'mailbox.edit');
  await f.history.revert(settings.id, { ...context, confirm: true }); assert.equal(f.boxes[0].name, 'user');
});

test('accounts: later password failure returns partial; password-only failure retains original status', async t => {
  const f = await fixture(t); f.options.passwordFailure = new AppError(422, 'MAILCOW_REJECTED', secret);
  const result = await patch(f, (await read(f)).etag, { name: '수정', password: secret });
  assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'MAILCOW_REJECTED'); assert.equal(f.boxes[0].name, '수정');
  assert.ok(!JSON.stringify(result).includes(secret));
  await assert.rejects(patch(f, result.etag, { password: secret }), { statusCode: 422 });
});

test('accounts: missing audit directory permissions prevent mailcow mutation', async t => {
  const f = await fixture(t); await fs.rm(f.dir, { recursive: true }); await fs.writeFile(f.dir, 'synthetic blocker');
  await assert.rejects(create(f), { statusCode: 500, code: 'AUDIT_UNAVAILABLE' }); assert.equal(writes(f).length, 0);
});

async function http(t, f) {
  const lines = []; const stream = new Writable({ write(chunk, _encoding, done) { lines.push(chunk.toString()); done(); } });
  const client = { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} };
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', sessionIdleMin: 60, sessionMaxHours: 8, trustProxy: ['192.0.2.0/24'], auditDir: f.dir, logLevel: 'info' },
    logger: { ...logOptions('info'), stream }, auth: { client }, dockerapi: f.dockerapi }); t.after(() => app.close());
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: secret } });
  assert.equal(logged.statusCode, 200, logged.body);
  return { app, lines, headers: { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf } };
}

test('accounts HTTP: protected routes, origin/JSON/CSRF, create response once, detail and PATCH', async t => {
  const f = await fixture(t), { app, lines, headers } = await http(t, f);
  assert.equal((await app.inject('/api/admin/mailboxes')).statusCode, 403);
  for (const [extra, expected] of [[{ origin: 'https://other.example.com' }, 403], [{ 'x-mailadmin-csrf': '' }, 403]]) {
    const response = await app.inject({ method: 'POST', url: '/api/admin/mailboxes', headers: { ...headers, ...extra }, payload: {} });
    assert.equal(response.statusCode, expected); assert.equal(response.headers['www-authenticate'], undefined);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/mailboxes', headers: { ...headers, 'content-type': 'text/plain' }, payload: '{}' })).statusCode, 415);
  const created = await app.inject({ method: 'POST', url: '/api/admin/mailboxes', headers, payload: { local: 'next', domain: 'example.com', name: '새 계정', kind: 'personal', password: secret } });
  assert.equal(created.statusCode, 200, created.body); assert.equal(created.body.split(secret).length - 1, 1);
  const detail = await app.inject({ url: `/api/admin/mailboxes/${next}`, headers }); assert.equal(detail.statusCode, 200, detail.body); assert.ok(!detail.body.includes(secret));
  const edited = await app.inject({ method: 'PATCH', url: `/api/admin/mailboxes/${next}`, headers, payload: { etag: detail.json().etag, protocols: { sieve: false } } });
  assert.equal(edited.statusCode, 200, edited.body); assert.equal(edited.json().warnings[0].code, 'SIEVE_DISABLED');
  assert.equal(edited.headers['cache-control'], 'no-store'); assert.ok(!lines.join('').includes(secret));
});

test('accounts: server protocol defaults are preserved with a warning and actual safe snapshot', async t => {
  const f = await fixture(t); f.options.created = { attributes: { imap_access: '1', pop3_access: '0', smtp_access: '1', sieve_access: '0', eas_access: '1', dav_access: '1' } };
  const result = await create(f);
  assert.deepEqual(result.warnings, [{ code: 'PROTOCOL_DEFAULT_OFF', protocols: ['pop3', 'sieve'] }]);
  assert.equal(result.mailbox.protocols.pop3, false);
  const intent = (await f.audit.read()).rows.find(row => row.action === 'mailbox/create');
  assert.equal(intent.after.protocols, undefined); assert.equal(intent.after.senderAcl, undefined);
});

test('accounts: team call losing session records partial flow and rethrows original auth loss', async t => {
  const f = await fixture(t); const failure = new MailcowAuthLost(); f.options.failPath = '/api/v1/edit/filter'; f.options.failure = failure;
  await assert.rejects(create(f, { team }), error => error === failure);
  assert.ok(f.boxes.some(row => row.username === next));
  const flow = (await f.history.list()).items.find(row => row.action === 'mailbox.create.flow');
  assert.equal(flow.result, 'partial'); assert.equal(flow.detail.steps[0].status, 'ok'); assert.equal(flow.detail.steps[1].status, 'failed');
  assert.ok(!JSON.stringify(flow).includes(secret));
});

test('accounts: password auth loss after settings retains 403 and reversible setting record', async t => {
  const f = await fixture(t); const failure = new MailcowAuthLost(); f.options.passwordFailure = failure;
  await assert.rejects(patch(f, (await read(f)).etag, { name: '적용된 이름', password: secret }), error => error === failure);
  assert.equal(f.boxes[0].name, '적용된 이름');
  assert.equal((await f.history.list()).items.find(row => row.action === 'mailbox.edit').canRevert, true);
});

test('accounts: alias and permission business failures expose only safe codes and preserve earlier stages', async t => {
  for (const failPath of ['/api/v1/add/alias', '/api/v1/edit/mailbox']) {
    const f = await fixture(t); f.options.failPath = failPath;
    const result = await create(f, { team, alias: 'newalias@example.com', addSendForTeam: true });
    assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'MAILCOW_REJECTED');
    assert.equal(result.steps.at(-1).stage, failPath.endsWith('/alias') ? 'alias' : 'permissions');
    assert.ok(f.filters[0].script_data.includes(next));
    const publicWithoutPassword = { ...result }; delete publicWithoutPassword.password;
    assert.ok(!JSON.stringify(publicWithoutPassword).includes(secret));
    assert.ok(!JSON.stringify((await f.audit.read()).rows).includes(secret));
  }
});

test('accounts: duplicate creation serializes mailbox target with one POST and no overwrites', async t => {
  const f = await fixture(t), result = await Promise.allSettled([create(f), create(f)]);
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(result.find(row => row.status === 'rejected').reason.code, 'MAILBOX_EXISTS');
  assert.equal(writes(f).filter(row => row.path.endsWith('/add/mailbox')).length, 1);
});

test('accounts: concurrent PATCH shares target lock and rejects the second stale revision', async t => {
  const f = await fixture(t), revision = (await read(f)).etag;
  const result = await Promise.allSettled([patch(f, revision, { name: '첫째' }), patch(f, revision, { name: '둘째' })]);
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(result.find(row => row.status === 'rejected').reason.code, 'CHANGED_ELSEWHERE'); assert.equal(writes(f).length, 1);
});

test('accounts HTTP: auth loss in later create stage clears local session, returns 403 and retains partial history', async t => {
  const f = await fixture(t), { app, headers, lines } = await http(t, f);
  f.options.failPath = '/api/v1/edit/filter'; f.options.failure = new MailcowAuthLost();
  const result = await app.inject({ method: 'POST', url: '/api/admin/mailboxes', headers, payload: { local: 'next', domain: 'example.com', name: '합성', kind: 'personal', password: secret, team } });
  assert.equal(result.statusCode, 403, result.body); assert.equal(result.json().error.code, 'MAILCOW_SESSION_LOST');
  assert.equal(result.headers['www-authenticate'], undefined); assert.match(result.headers['set-cookie'], /Max-Age=0/);
  assert.equal((await app.inject({ url: '/api/admin/auth/session', headers })).statusCode, 403);
  const flow = (await app.adminHistory.list()).items.find(row => row.action === 'mailbox.create.flow'); assert.equal(flow.result, 'partial');
  assert.ok(!result.body.includes(secret)); assert.ok(!lines.join('').includes(secret));
});


test('accounts: join team stage succeeds after creating the first team on an empty-filter server', async t => {
  const f = await fixture(t); f.filters.length = 0;
  await f.teams.create({ ...context, teamAddress: team, members: [user] });
  const response = await create(f, { team });
  assert.equal(response.result, 'ok');
  assert.deepEqual(response.steps.map(row => [row.stage, row.status]), [['mailbox', 'ok'], ['team', 'ok']]);
});

test('quota accounts: entire 500-account projection is compact and etag matches existing PATCH snapshot', async t => {
  const f = await fixture(t);
  for (let i = f.boxes.length; i < 500; i++) f.boxes.push(makeBox(`person${i}@example.com`));
  f.boxes[0].quota = 0;
  const result = await f.service.quotaList({});
  assert.equal(result.items.length, 500);
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['address','etag','kind','name','quotaGb','usedBytes']);
  assert.equal(result.items[0].quotaGb, 0); assert.equal(result.items[1].kind, 'team'); assert.equal(result.items[2].kind, 'admin');
  assert.equal(result.items[0].etag, (await read(f)).etag);
  const size = Buffer.byteLength(JSON.stringify(result)); t.diagnostic(`quota projection: 500 accounts ${size} bytes; 95 accounts ${Buffer.byteLength(JSON.stringify({ items: result.items.slice(0, 95) }))} bytes`); assert.ok(size < 150_000, `500 rows: ${size} bytes`);
  const saved = await patch(f, result.items[0].etag, { quotaGb: 25 });
  assert.equal(saved.mailbox.quotaGb, 25);
  await assert.rejects(patch(f, result.items[0].etag, { quotaGb: 30 }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
});
test('quota HTTP: list is protected and exposes the mailcow usage with no-store', async t => {
  const f = await fixture(t), { app, headers } = await http(t, f);
  assert.equal((await app.inject('/api/admin/quota')).statusCode, 403);
  const response = await app.inject({ url: '/api/admin/quota', headers });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.json().items[0].usedBytes, f.boxes[0].quota_used);
  assert.ok(!response.body.includes(secret));
});
