import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowsService } from '../../server/admin/services/flows.js';
import { createTeamsService } from '../../server/admin/services/teams.js';
import { createAliasesService } from '../../server/admin/services/aliases.js';
import { createSendersService } from '../../server/admin/services/senders.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';

const member = 'member@example.com', other = 'other@example.com', oldTeam = 'old@example.com', newTeam = 'new@example.com', keep = 'keep@example.com', alias = 'alias@example.com';
const ctx = { session: {}, actor: 'admin', ip: '198.51.100.37' };
const script = members => 'require ["copy"];\n' + members.map(addr => `redirect :copy "${addr}";\n`).join('');
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a11b-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const boxes = [member, other, oldTeam, newTeam, keep].map(username => ({ username, name: username, active: '1', sender_acl: username === member ? [oldTeam, 'unrelated@example.com'] : ['existing@example.com'] }));
  const filters = [{ id: '1', username: oldTeam, active: '1', filter_type: 'prefilter', script_data: script([member, keep]), script_desc: '이전 팀' }, { id: '2', username: newTeam, active: '1', filter_type: 'prefilter', script_data: script([other, keep]), script_desc: '새 팀' }];
  const aliases = [{ id: '7', address: alias, goto: member, active: '1', sender_allowed: '0', sogo_visible: '0', internal: '0', public_comment: '', private_comment: '' }];
  const primary = [{ domain_name: 'example.com', active: '1' }], calls = [], options = {};
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); await options.onCall?.({ method, path, body });
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/mailbox/all') return structuredClone(boxes);
    if (path.startsWith('/api/v1/get/mailbox/')) return structuredClone(boxes.find(row => row.username === decodeURIComponent(path.split('/').at(-1))) ?? {});
    if (path === '/api/v1/get/filters/all') return structuredClone(filters);
    if (path === '/api/v1/get/alias/all') return structuredClone(aliases);
    if (path === '/api/v1/get/domain/all') return structuredClone(primary);
    if (path === '/api/v1/get/alias-domain/all') return {};
    if (path === '/api/v1/edit/filter') Object.assign(filters.find(row => row.id === body.items[0]), body.attr);
    else if (path === '/api/v1/edit/alias') {
      const row = aliases.find(row => row.id === body.items[0]); Object.assign(row, body.attr);
      for (const box of boxes) if (row.goto.split(',').includes(box.username)) box.sender_acl = box.sender_acl.filter(value => value !== row.address);
    } else if (path === '/api/v1/edit/mailbox') {
      const owner = boxes.find(row => row.username === body.items[0]), fixed = aliases.filter(row => !row.address.startsWith('@') && row.sender_allowed === '1' && row.goto.split(',').includes(owner.username)).map(row => row.address);
      owner.sender_acl = body.attr.sender_acl.includes('*') ? ['*'] : body.attr.sender_acl.filter(value => value !== owner.username && !fixed.includes(value));
    } else assert.fail(path);
    return [{ type: 'success' }];
  } };
  const audit = createAudit({ dir }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const teams = createTeamsService({ mailcow, audit, lock, history, auditDir: dir });
  const aliasService = createAliasesService({ mailcow, audit, lock, history });
  const senders = createSendersService({ mailcow, audit, lock, history });
  const flows = createFlowsService({ mailcow, teams, aliases: aliasService, senders, audit, lock });
  return { dir, boxes, filters, aliases, primary, calls, options, mailcow, audit, lock, history, teams, aliasService, senders, flows };
}
const teamData = { member, fromTeam: oldTeam, toTeam: newTeam, mode: 'move', distribution: true, sendGrant: true };
const aliasData = { alias, target: newTeam, grantSendTo: [member, other] };
const teamPreview = (f, data = teamData) => f.flows.teamMove({ ...ctx, data: { ...data, action: 'preview' } });
const teamRun = (f, preview, data = teamData) => f.flows.teamMove({ ...ctx, data: { ...data, action: 'run', etags: preview.etags } });
const aliasPreview = (f, data = aliasData) => f.flows.alias({ ...ctx, data: { ...data, action: 'preview' } });
const aliasRun = (f, preview, data = aliasData) => f.flows.alias({ ...ctx, data: { ...data, action: 'run', etags: preview.etags } });
const writes = f => f.calls.filter(row => row.method === 'POST');
const acl = (f, addr = member) => f.boxes.find(row => row.username === addr).sender_acl;

for (const mode of ['move', 'add', 'remove']) for (const [distribution, sendGrant] of [[true, true], [true, false], [false, true]]) test(`team flow: ${mode}, distribution=${distribution}, sendGrant=${sendGrant}`, async t => {
  const f = await fixture(t), data = { member, mode, distribution, sendGrant, ...(mode !== 'add' ? { fromTeam: oldTeam } : {}), ...(mode !== 'remove' ? { toTeam: newTeam } : {}) };
  const p = await teamPreview(f, data); assert.equal(writes(f).length, 0); assert.equal(p.changes.member, member); assert.equal(p.changes.otherMembersAndPermissions, '모두 유지');
  for (const change of p.changes.distribution) if (!distribution) assert.deepEqual(change.before, change.after);
  const result = await teamRun(f, p, data); assert.equal(result.result, 'ok');
  const old = (await f.teams.list({})).items.find(row => row.mailbox === oldTeam).members.map(row => row.address), next = (await f.teams.list({})).items.find(row => row.mailbox === newTeam).members.map(row => row.address);
  assert.equal(old.includes(member), !distribution || mode === 'add'); assert.equal(next.includes(member), distribution && mode !== 'remove'); assert.ok(old.includes(keep)); assert.ok(next.includes(other));
  assert.ok(acl(f).includes('unrelated@example.com')); assert.equal(acl(f).includes(oldTeam), !sendGrant || mode === 'add'); assert.equal(acl(f).includes(newTeam), sendGrant && mode !== 'remove');
  for (const step of result.steps.filter(step => step.status === 'ok')) assert.equal((await f.history.detail(step.auditId)).canRevert, true);
});

test('team flow: second filter fails after first reversible stage; flow is partial', async t => {
  const f = await fixture(t), p = await teamPreview(f);
  f.options.onCall = ({ path, body }) => { if (path === '/api/v1/edit/filter' && body.items[0] === '2') throw new AppError(502, 'MAILCOW_REJECTED', '합성 실패'); };
  const result = await teamRun(f, p); assert.equal(result.result, 'partial'); assert.deepEqual(result.steps.map(row => row.status), ['ok', 'failed']); assert.equal(result.steps[1].code, 'MAILCOW_REJECTED'); assert.ok(result.steps[1].recovery.includes(newTeam));
  const first = await f.history.detail(result.steps[0].auditId); assert.equal(first.canRevert, true); assert.equal((await f.history.detail(result.auditId)).result, 'partial');
  await f.history.revert(first.id, { ...ctx, confirm: true }); assert.ok(f.filters[0].script_data.includes(member)); assert.deepEqual(acl(f), [oldTeam, 'unrelated@example.com']);
});
test('team flow: first stage failure preserves original error and changes nothing', async t => {
  const f = await fixture(t), p = await teamPreview(f), original = structuredClone(f.filters);
  f.options.onCall = ({ path }) => { if (path === '/api/v1/edit/filter') throw new AppError(422, 'MAILCOW_REJECTED', '합성 실패'); };
  await assert.rejects(teamRun(f, p), { statusCode: 422, code: 'MAILCOW_REJECTED' }); assert.deepEqual(f.filters, original); assert.deepEqual(acl(f), [oldTeam, 'unrelated@example.com']);
});
for (const resource of ['filter', 'sender', 'options']) test(`team flow: changed ${resource} after preview is 409 before writes`, async t => {
  const f = await fixture(t), p = await teamPreview(f); let data = teamData;
  if (resource === 'filter') f.filters[1].script_data += '# 다른 곳에서 변경\n';
  if (resource === 'sender') acl(f).push('later@example.com');
  if (resource === 'options') data = { ...teamData, distribution: false };
  await assert.rejects(teamRun(f, p, data), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 0);
});
for (const data of [{ ...teamData, distribution: false, sendGrant: false }, { ...teamData, mode: 'bad' }, { ...teamData, fromTeam: newTeam }, { ...teamData, mode: 'add' }, { ...teamData, mode: 'remove' }, { ...teamData, member: 'missing@example.com' }]) test(`team flow: invalid ${JSON.stringify(data)}`, async t => {
  const f = await fixture(t); await assert.rejects(teamPreview(f, data), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});
test('team flow: default distribution true and last-member/read-only checks precede all writes', async t => {
  const f = await fixture(t); const data = { ...teamData }; delete data.distribution; assert.equal((await teamPreview(f, data)).distribution, true);
  f.filters[0].script_data = script([member]); await assert.rejects(teamPreview(f), { statusCode: 409, code: 'LAST_MEMBER' });
  f.filters[0].script_data = 'stop;\n' + script([member, keep]); await assert.rejects(teamPreview(f), { statusCode: 409 }); assert.equal(writes(f).length, 0);
});
test('team flow: absent old membership and already-present new membership are no-ops; missing old permission is no-op', async t => {
  const f = await fixture(t); f.filters[0].script_data = script([keep]); f.filters[1].script_data = script([other, member]); f.boxes[0].sender_acl = ['unrelated@example.com', newTeam];
  const p = await teamPreview(f), result = await teamRun(f, p); assert.equal(result.unchanged, true); assert.ok(result.steps.every(row => row.status === 'unchanged')); assert.equal(writes(f).length, 0);
});
test('alias flow: changes recipient then grants two people in sorted order and preserves their other permissions', async t => {
  const f = await fixture(t), p = await aliasPreview(f); assert.equal(p.changes.existingPermissionsDeleted, '없음'); assert.equal(writes(f).length, 0);
  const result = await aliasRun(f, p); assert.equal(result.result, 'ok'); assert.equal(f.aliases[0].goto, newTeam);
  assert.deepEqual(writes(f).map(row => row.path), ['/api/v1/edit/alias', '/api/v1/edit/mailbox', '/api/v1/edit/mailbox']);
  assert.deepEqual(writes(f).slice(1).map(row => row.body.items[0]), [member, other]); assert.ok(acl(f).includes(alias)); assert.ok(acl(f).includes('unrelated@example.com')); assert.ok(acl(f, other).includes('existing@example.com'));
});
for (const [data, status] of [[{ ...aliasData, target: 'outside@example.net' }, 422], [{ ...aliasData, alias: 'missing@example.com' }, 404], [{ ...aliasData, grantSendTo: ['missing@example.com'] }, 422], [{ ...aliasData, grantSendTo: [member, member] }, 422]]) test(`alias flow: invalid ${JSON.stringify(data)}`, async t => {
  const f = await fixture(t); await assert.rejects(aliasPreview(f, data), { statusCode: status }); assert.equal(writes(f).length, 0);
});
test('alias flow: second person fails after alias and first grant, returns partial with stage records', async t => {
  const f = await fixture(t), p = await aliasPreview(f);
  f.options.onCall = ({ path, body }) => { if (path === '/api/v1/edit/mailbox' && body.items[0] === other) throw new AppError(502, 'MAILCOW_REJECTED', '합성 실패'); };
  const result = await aliasRun(f, p); assert.equal(result.result, 'partial'); assert.deepEqual(result.steps.map(row => row.status), ['ok', 'ok', 'failed']); assert.equal(f.aliases[0].goto, newTeam); assert.ok(acl(f).includes(alias)); assert.equal(acl(f, other).includes(alias), false);
  assert.ok(result.recovery.length); assert.equal((await f.history.detail(result.steps[1].auditId)).canRevert, true);
});
test('alias flow: new recipient already allowed by alias is marked and not stored; former recipient gets explicit grant', async t => {
  const f = await fixture(t); f.aliases[0].sender_allowed = '1'; const data = { ...aliasData, target: other }, p = await aliasPreview(f, data);
  assert.deepEqual(p.changes.senders.find(row => row.address === other).alreadyAllowedByAlias, [alias]); assert.equal(p.changes.senders.find(row => row.address === other).after.includes(alias), false);
  assert.equal(p.changes.senders.find(row => row.address === member).after.includes(alias), true);
  const result = await aliasRun(f, p, data); assert.deepEqual(result.steps.map(row => row.status), ['ok', 'ok', 'unchanged']); assert.ok(acl(f).includes(alias)); assert.equal(acl(f, other).includes(alias), false);
});
for (const resource of ['alias', 'person']) test(`alias flow: preview ${resource} changes fail before mutation`, async t => {
  const f = await fixture(t), p = await aliasPreview(f);
  if (resource === 'alias') f.aliases[0].goto = keep; else acl(f, other).push('later@example.com');
  await assert.rejects(aliasRun(f, p), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 0);
});
test('alias flow: concurrent ACL edit after alias stage is not overwritten and yields partial', async t => {
  const f = await fixture(t), p = await aliasPreview(f); let updated = false;
  f.options.onCall = ({ method, path }) => {
    if (method === 'POST' && path === '/api/v1/edit/alias') updated = true;
    else if (updated && path === `/api/v1/get/mailbox/${encodeURIComponent(member)}`) { updated = false; acl(f).push('concurrent@example.com'); }
  };
  const result = await aliasRun(f, p); assert.equal(result.result, 'partial'); assert.equal(result.steps[1].code, 'CHANGED_ELSEWHERE'); assert.ok(acl(f).includes('concurrent@example.com')); assert.equal(writes(f).length, 1);
});
test('alias flow: empty grants only edits alias; unchanged alias before failing first grant returns original error', async t => {
  const f = await fixture(t), data = { ...aliasData, grantSendTo: [] }, p = await aliasPreview(f, data);
  assert.equal((await aliasRun(f, p, data)).steps.length, 1); assert.equal(writes(f).length, 1);
  const next = await aliasPreview(f);
  f.options.onCall = ({ path }) => { if (path === '/api/v1/edit/mailbox') throw new AppError(422, 'MAILCOW_REJECTED', '합성 실패'); };
  await assert.rejects(aliasRun(f, next), { statusCode: 422, code: 'MAILCOW_REJECTED' }); assert.equal(acl(f).includes(alias), false);
});
test('team flow: no-op read-only distribution stays unchanged; zero actual changes before failure preserve original error', async t => {
  const f = await fixture(t); f.filters[0].script_data = 'stop;\n' + script([keep]); f.filters[1].script_data = 'stop;\n' + script([member, other]);
  const data = { ...teamData, sendGrant: false }, p = await teamPreview(f, data); assert.equal((await teamRun(f, p, data)).unchanged, true); assert.equal(writes(f).length, 0);
  const second = { ...teamData, mode: 'remove' }; delete second.toTeam; const prepared = await teamPreview(f, second);
  f.options.onCall = ({ path }) => { if (path === '/api/v1/edit/mailbox') throw new AppError(422, 'MAILCOW_REJECTED', '합성 실패'); };
  await assert.rejects(teamRun(f, prepared, second), { statusCode: 422, code: 'MAILCOW_REJECTED' });
});
test('team flow: stage etag catches second filter change after preflight and keeps first-stage record', async t => {
  const f = await fixture(t), p = await teamPreview(f);
  f.options.onCall = ({ path, body }) => { if (path === '/api/v1/edit/filter' && body.items[0] === '1') f.filters[1].script_data += '# 동시 변경\n'; };
  const result = await teamRun(f, p); assert.equal(result.result, 'partial'); assert.equal(result.steps[1].code, 'CHANGED_ELSEWHERE'); assert.equal(result.steps[0].status, 'ok'); assert.equal(writes(f).length, 1);
});
test('flow locks: simultaneous identical team moves serialize; second stops before mutation', async t => {
  const f = await fixture(t), p = await teamPreview(f), results = await Promise.allSettled([teamRun(f, p), teamRun(f, p)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.code, 'CHANGED_ELSEWHERE'); assert.equal(writes(f).length, 3);
});
test('flow audit: intent failure stops every child service write', async t => {
  const f = await fixture(t), p = await teamPreview(f); await fs.rm(f.dir, { recursive: true }); await fs.writeFile(f.dir, 'synthetic-blocker');
  await assert.rejects(teamRun(f, p), { statusCode: 500, code: 'AUDIT_UNAVAILABLE' }); assert.equal(writes(f).length, 0);
});
test('alias flow: inactive actual grantee mailbox is accepted and explicit sender ACL of old recipients remains', async t => {
  const f = await fixture(t); f.boxes.find(row => row.username === other).active = '0'; acl(f).push(alias);
  const p = await aliasPreview(f); const result = await aliasRun(f, p); assert.equal(result.result, 'ok'); assert.ok(acl(f).includes(alias)); assert.ok(acl(f, other).includes(alias));
});

async function httpFixture(t, f) {
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: false,
    auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  return { app, headers };
}
test('flow HTTP: shared guards, preview payload and 200 partial contract', async t => {
  const f = await fixture(t), { app, headers } = await httpFixture(t, f), url = '/api/admin/flows/team-move';
  const denied = await app.inject({ method: 'POST', url, payload: { ...teamData, action: 'preview' } }); assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
  const noCsrf = await app.inject({ method: 'POST', url, headers: { ...headers, 'x-mailadmin-csrf': '' }, payload: { ...teamData, action: 'preview' } }); assert.equal(noCsrf.statusCode, 403);
  const p = await app.inject({ method: 'POST', url, headers, payload: { ...teamData, action: 'preview' } }); assert.equal(p.statusCode, 200, p.body); assert.equal(p.headers['cache-control'], 'no-store');
  const aliasP = await app.inject({ method: 'POST', url: '/api/admin/flows/alias', headers, payload: { ...aliasData, action: 'preview' } }); assert.equal(aliasP.statusCode, 200, aliasP.body);
  f.options.onCall = ({ path, body }) => { if (path === '/api/v1/edit/filter' && body.items[0] === '2') throw new AppError(502, 'MAILCOW_REJECTED', '합성 실패'); };
  const result = await app.inject({ method: 'POST', url, headers, payload: { ...teamData, action: 'run', etags: p.json().etags } }); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().result, 'partial'); assert.equal(result.json().steps[1].code, 'MAILCOW_REJECTED');
  assert.equal((await app.inject('/healthz')).json().ok, true);
});
test('flow HTTP: authentication loss after success records partial then returns 403 and discards session', async t => {
  const f = await fixture(t), { app, headers } = await httpFixture(t, f), url = '/api/admin/flows/team-move';
  const p = await app.inject({ method: 'POST', url, headers, payload: { ...teamData, action: 'preview' } });
  f.options.onCall = ({ path, body }) => { if (path === '/api/v1/edit/filter' && body.items[0] === '2') throw new MailcowAuthLost(); };
  const result = await app.inject({ method: 'POST', url, headers, payload: { ...teamData, action: 'run', etags: p.json().etags } }); assert.equal(result.statusCode, 403, result.body); assert.equal(result.json().error.code, 'MAILCOW_SESSION_LOST'); assert.equal(result.headers['www-authenticate'], undefined);
  const history = await app.adminHistory.list(); assert.equal(history.items.find(row => row.action === 'flow.team-move').result, 'partial'); assert.equal((await app.inject({ url: '/api/admin/auth/session', headers })).statusCode, 403);
});
for (const reason of ['multiple_prefilters', 'unparseable']) test(`team flow: unknown distribution ${reason} blocks distribution but allows permissions only`, async t => {
  const f = await fixture(t);
  if (reason === 'multiple_prefilters') f.filters.push({ ...f.filters[0], id: '3' }); else f.filters[0].script_data = 'redirect :copy "unterminated';
  await assert.rejects(teamPreview(f), { statusCode: 409, code: reason === 'multiple_prefilters' ? 'MULTIPLE_PREFILTERS' : 'UNPARSEABLE' }); assert.equal(writes(f).length, 0);
  const data = { ...teamData, distribution: false }, p = await teamPreview(f, data), result = await teamRun(f, p, data); assert.equal(result.result, 'ok'); assert.ok(writes(f).every(row => row.path === '/api/v1/edit/mailbox'));
});
test('team flow: disabled selected team is rejected before any distribution or grant is written', async t => {
  const f = await fixture(t); f.boxes.find(row => row.username === newTeam).active = '0'; await assert.rejects(teamPreview(f), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});


test('alias flow: empty mailbox object preserves 422 for a requested send grantee', async t => {
  const f = await fixture(t), call = f.mailcow.call;
  f.mailcow.call = (...args) => args[2] === '/api/v1/get/mailbox/all' ? {} : call(...args);
  // Isolate the mailbox-list validation after the alias preview succeeds.
  const flows = createFlowsService({ mailcow: f.mailcow, aliases: { async previewEdit() { return {}; } } });
  await assert.rejects(flows.alias({ ...ctx, data: { ...aliasData, action: 'preview' } }), { statusCode: 422, code: 'INVALID_INPUT' });
  assert.equal(writes(f).length, 0);
});
