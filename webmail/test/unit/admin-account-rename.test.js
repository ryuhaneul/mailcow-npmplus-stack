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
import { renameMember, Refused } from '../../server/admin/sieve-team.js';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';

const old = 'old@example.com', next = 'new@example.com', team = 'team@example.com', other = 'other@example.com';
const secret = 'synthetic-rename-source-password';
const source = `require ["copy"];\r\n# ${old} 📨 보존\r\n  redirect :copy "OLD@EXAMPLE.COM"; # 보존\r\nredirect :copy "${other}";\r\nstop;\r\n`;
const context = { session: {}, actor: 'admin', ip: '198.51.100.25' };
const makeBox = username => ({ username, name: '합성', quota: 20 * 1024 ** 3, quota_used: 2000, messages: 3, active: 1, sender_acl: [], attributes: { imap_access: '1', pop3_access: '1', smtp_access: '1', sieve_access: '1', eas_access: '1', dav_access: '1' } });
async function fixture(t, populated = true) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a08a-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const boxes = [old, team, other].map(makeBox), filters = [], aliases = [], jobs = [], passwords = [{ id: 1, password: secret }], calls = [], acl = new Map(), options = {};
  if (populated) {
    boxes[0].sender_acl = [team]; boxes[2].sender_acl = [old, team];
    filters.push({ id: 1, username: team, filter_type: 'prefilter', active: 1, script_desc: '원문', script_data: source },
      { id: 2, username: old, filter_type: 'postfilter', active: 0, script_data: 'keep;\n' },
      { id: 3, username: other, filter_type: 'postfilter', active: 0, script_data: `redirect :copy "${old}";\n` });
    aliases.push({ id: 1, address: 'one@example.com', goto: old, active: 1 }, { id: 2, address: 'many@example.com', goto: `${old},${other}`, active: 1 });
    jobs.push({ id: 8, user2: old, active: 1, password1: secret, custom_params: '--synthetic' });
    acl.set(team, [{ user: team, id: old, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
    acl.set(old, [{ user: old, id: other, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
  }
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); options.onCall?.({ method, path, body });
    if (options.failPath === path && method === 'POST') throw options.failure ?? new AppError(422, 'MAILCOW_REJECTED', secret);
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/mailbox/all') return structuredClone(boxes);
    if (path.startsWith('/api/v1/get/mailbox/')) return structuredClone(boxes.find(row => row.username === decodeURIComponent(path.split('/').at(-1))) ?? {});
    if (path === '/api/v1/get/alias/all') return structuredClone(aliases);
    if (path === '/api/v1/get/filters/all') return structuredClone(filters);
    if (path === '/api/v1/get/syncjobs/all/no_log') return structuredClone(jobs);
    if (path.startsWith('/api/v1/get/app-passwd/all/')) return structuredClone(passwords);
    if (path === '/api/v1/edit/rename-mbox') {
      const row = boxes.find(item => item.username === old); row.username = next;
      if (options.dropMail) row.messages--;
      if (!options.keepOwner) for (const filter of filters) if (filter.username === old) filter.username = next;
      for (const alias of aliases) if (alias.goto === old) alias.goto = next;
      if (!options.keepSenders) for (const box of boxes) box.sender_acl = box.sender_acl.map(addr => addr === old ? next : addr);
      if (!options.keepSync) for (const job of jobs) if (job.user2 === old) job.user2 = next;
      const own = acl.get(old); if (own) { acl.delete(old); acl.set(next, own.map(row => ({ ...row, user: next, id: row.id === old ? next : row.id }))); }
    } else if (path === '/api/v1/edit/filter') {
      if (!options.ignoreFilter) Object.assign(filters.find(row => String(row.id) === body.items[0]), body.attr);
    } else if (path === '/api/v1/edit/alias') {
      const alias = aliases.find(row => String(row.id) === body.items[0]); Object.assign(alias, body.attr);
      // mailcow removes explicit grants to the supplied goto targets, even with sender_allowed=0.
      if (Object.hasOwn(body.attr, 'goto')) for (const box of boxes) if (alias.goto.split(',').includes(box.username)) box.sender_acl = box.sender_acl.filter(value => value !== alias.address);
    } else if (path === '/api/v1/edit/mailbox') {
      for (const addr of body.items) if (!options.ignoreSenderWrites) Object.assign(boxes.find(row => row.username === addr), body.attr);
    } else if (path === '/api/v1/add/alias') aliases.push({ id: 100 + aliases.length, ...body });
    else assert.fail(path);
    return [{ type: 'success' }];
  } };
  const dockerapi = {
    async getAcl(owner) { if (options.aclFailure === owner) throw new Error(secret); return structuredClone([...acl.values()].flat().filter(row => row.user === owner || row.id === owner)); },
    async setAcl(owner, grantee, mailbox = 'INBOX') { calls.push({ method: 'POST', path: 'dockerapi/set_acl', body: { owner, grantee, mailbox } }); acl.set(owner, [...(acl.get(owner) ?? []), { user: owner, id: grantee, mailbox, rights: ['lookup', 'read'] }]); },
    async deleteAcl(owner, grantee, mailbox = 'INBOX') { calls.push({ method: 'POST', path: 'dockerapi/delete_acl', body: { owner, grantee, mailbox } }); acl.set(owner, (acl.get(owner) ?? []).filter(row => row.id !== grantee || row.mailbox !== mailbox)); },
  };
  const audit = createAudit({ dir }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const teams = createTeamsService({ mailcow, audit, lock, history, auditDir: dir });
  const aclFolders = {
    enabled: true,
    async readOwned(owner) { return (await dockerapi.getAcl(owner)).filter(row => row.user === owner && (aclFolders.enabled || row.mailbox === 'INBOX')); },
    async assertExist(owner, mailboxes) {
      calls.push({ method: 'CHECK', path: 'acl-folders/assert', body: { owner, mailboxes } });
      if (mailboxes.includes(options.missingFolder)) throw new AppError(409, 'CONFLICT', '폴더가 없어졌어요.');
    },
  };
  const service = createAccountsService({ mailcow, dockerapi, audit, lock, history, teams, aclFolders });
  return { dir, boxes, filters, aliases, jobs, passwords, calls, acl, options, mailcow, dockerapi, aclFolders, service, audit, history };
}
const rename = (f, data) => f.service.rename({ ...context, addr: old, data: { newLocal: 'new', keepOldAsAlias: true, ...data } });
const preview = f => rename(f, { action: 'preview' });
const run = (f, etag) => rename(f, { action: 'run', etag });
const writes = f => f.calls.filter(call => call.method === 'POST');

test('rename sieve: replaces only address tokens, preserving comments, CRLF, Unicode and byte content outside hits', () => {
  const result = renameMember(source, old, next); assert.equal(result.script, source.replace('"OLD@EXAMPLE.COM"', `"${next}"`));
  assert.equal(renameMember(`# ${old}\nkeep;\n`, old, next).changed, false);
  assert.equal(renameMember('keep;\n', old, next).changed, false);
});
for (const script of [`redirect "${old}";\n`, `if true { redirect :copy "${old}"; }\n`, `redirect :copy "${old}"`, `redirect :copy "prefix ${old}";\n`]) test('rename sieve: refuses unsupported or ambiguous address tokens', () => {
  assert.throws(() => renameMember(script, old, next), Refused);
});

test('rename: preview describes exactly eight categories with safe app/mail counts and notices', async t => {
  const f = await fixture(t), result = await preview(f);
  assert.deepEqual(Object.keys(result.changes), ['mailbox', 'teamFilters', 'aliases', 'senderAs', 'senderGrants', 'shares', 'syncjobs', 'oldAlias']);
  assert.equal(result.changes.mailbox[0].messages, 3); assert.equal(result.changes.mailbox[0].appPasswordCount, 1);
  assert.equal(result.changes.teamFilters.length, 3); assert.equal(result.changes.aliases.length, 2); assert.equal(result.changes.senderGrants.length, 1);
  assert.equal(result.changes.shares.length, 2); assert.equal(result.sharesScope, 'all'); assert.equal(result.notices.length, 2);
  assert.match(result.notices[1], /BCC/); assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('redirect'));
  assert.equal(writes(f).length, 0);
});

test('rename: cascade matches MA1 body, retains mail, preserves filter bytes and makes old alias last', async t => {
  const f = await fixture(t), result = await run(f, (await preview(f)).etag);
  assert.equal(result.result, 'ok'); assert.deepEqual(result.recovery, []);
  assert.deepEqual(writes(f)[0], { method: 'POST', path: '/api/v1/edit/rename-mbox', body: { items: [old], attr: { domain: 'example.com', old_local_part: 'old', new_local_part: 'new', create_alias: '0' } } });
  assert.equal(writes(f).at(-1).path, '/api/v1/add/alias'); assert.equal(f.boxes[0].username, next); assert.equal(f.boxes[0].messages, 3);
  assert.equal(f.filters[0].script_data, source.replace('"OLD@EXAMPLE.COM"', `"${next}"`));
  assert.equal(f.filters[1].username, next); assert.equal(f.filters[1].active, 0); assert.equal(f.filters[2].active, '0');
  assert.ok(!f.filters[2].script_data.includes(`"${old}"`));
  assert.deepEqual(f.aliases.filter(row => row.address === old).map(row => row.goto), [next]);
  assert.equal(f.aliases.find(row => row.id === 1).goto, next); assert.deepEqual(f.aliases.find(row => row.id === 2).goto.split(',').sort(), [next, other].sort());
  assert.deepEqual(f.boxes[2].sender_acl, [next, team]); assert.equal(f.jobs[0].user2, next);
  assert.equal(writes(f).filter(call => call.path === '/api/v1/edit/alias').length, 1);
  assert.equal(writes(f).filter(call => call.path === '/api/v1/edit/mailbox').length, 0);
  assert.equal(writes(f).filter(call => call.path === '/api/v1/edit/filter').length, 2);
  assert.ok(f.acl.get(team).some(row => row.id === next)); assert.ok(!f.acl.get(team).some(row => row.id === old)); assert.equal(f.acl.get(next)[0].id, other);
  const records = (await f.history.list()).items; assert.equal(records.filter(row => row.action === 'mailbox.rename').length, 1); assert.ok(records.every(row => !row.canRevert));
  assert.ok(!JSON.stringify(records).includes(secret)); assert.ok(!JSON.stringify(records).includes('redirect'));
  for (const step of result.steps) assert.match(step.auditId, /^[a-f0-9]{32}$/);
  const filterRecord = records.find(row => row.action === 'mailbox.rename.filter' && row.target === team);
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${filterRecord.id}.before.sieve`), 'utf8'), source);
  await assert.rejects(f.history.revert(filterRecord.id, { ...context, confirm: true }), { statusCode: 409 });
});

for (const [label, mutate] of [
  ['mailbox', f => { f.boxes[0].name = 'changed'; }], ['alias', f => { f.aliases[0].goto += `,${other}`; }],
  ['filter', f => { f.filters[0].script_data += '# changed\n'; }], ['sender', f => { f.boxes[2].sender_acl.push('extra@example.com'); }],
  ['ACL', f => { f.acl.get(team)[0].rights.push('write'); }], ['sync', f => { f.jobs[0].password1 = 'changed-synthetic'; }],
]) test(`rename: preview conflict in ${label} prevents all writes`, async t => {
  const f = await fixture(t), initial = await preview(f); mutate(f);
  await assert.rejects(run(f, initial.etag), error => error.statusCode === 409); assert.equal(writes(f).length, 0);
});

test('rename: counts are excluded from etag; mail arrival preserves preview validity', async t => {
  const f = await fixture(t), initial = await preview(f); f.boxes[0].messages++; f.boxes[0].quota_used++; f.passwords.push({ id: 2, password: secret });
  assert.equal((await preview(f)).etag, initial.etag); assert.equal((await run(f, initial.etag)).result, 'ok');
});

for (const data of [{ action: 'invalid' }, { keepOldAsAlias: false }, { newLocal: 'new@outside.example.com' }, { newLocal: 'old' }, { newLocal: 'bad/local' }]) test(`rename: invalid request ${JSON.stringify(data)} does not mutate`, async t => {
  const f = await fixture(t); await assert.rejects(rename(f, { action: 'preview', ...data }), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});

test('rename: existing address and inactive mailbox are blocked before mutation; active=2 is allowed', async t => {
  const f = await fixture(t, false); f.boxes.push(makeBox(next)); await assert.rejects(preview(f), { code: 'ADDRESS_IN_USE' });
  f.boxes.pop(); f.aliases.push({ id: 1, address: next, goto: other }); await assert.rejects(preview(f), { code: 'ADDRESS_IN_USE' });
  f.aliases.length = 0; f.boxes[0].active = 0; await assert.rejects(preview(f), { code: 'MAILBOX_INACTIVE' });
  f.boxes[0].active = 2; assert.equal((await run(f, (await preview(f)).etag)).result, 'ok');
});

for (const [script, type, active] of [[`redirect "${old}";\n`, 'prefilter', 1], [`if true { redirect :copy "${old}"; }\n`, 'postfilter', 0], [`redirect :copy "${old}"`, 'prefilter', 0]]) test('rename: unsafe filter is rejected in preview with owner and no source contents', async t => {
  const f = await fixture(t, false); f.filters.push({ id: 1, username: team, filter_type: type, active, script_data: script });
  await assert.rejects(preview(f), error => error.statusCode === 409 && error.message.includes(team) && !error.message.includes('redirect')); assert.equal(writes(f).length, 0);
});

for (const extra of [{ rights: ['lookup', 'read', 'write'] }, { mailbox: 'Sent', rights: ['lookup', 'write'] }]) test('rename: unsupported related ACL prevents any rename', async t => {
  const f = await fixture(t); Object.assign(f.acl.get(team)[0], extra);
  await assert.rejects(preview(f), { code: 'ACL_UNSUPPORTED', statusCode: 409 }); assert.equal(writes(f).length, 0);
});

test('rename: partial ACL inspection fails before mutation', async t => {
  const f = await fixture(t); f.options.aclFailure = other; await assert.rejects(preview(f), { statusCode: 502 }); assert.equal(writes(f).length, 0);
});

test('rename: first API failure keeps original error and address; later failure supplies per-stage recovery and linked records', async t => {
  const f = await fixture(t); f.options.failPath = '/api/v1/edit/rename-mbox';
  await assert.rejects(run(f, (await preview(f)).etag), { statusCode: 422 }); assert.equal(f.boxes[0].username, old);
  f.options.failPath = '/api/v1/edit/alias';
  const result = await run(f, (await preview(f)).etag);
  assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'MAILCOW_REJECTED'); assert.equal(result.steps.at(-1).stage, 'aliases');
  assert.ok(result.steps.at(-1).recovery.includes(next)); assert.equal(f.boxes[0].username, next); assert.ok(!f.aliases.some(row => row.address === old));
  const record = (await f.history.list()).items.find(row => row.action === 'mailbox.rename' && row.result === 'partial');
  assert.equal(record.detail.steps.at(-1).recovery, result.steps.at(-1).recovery); assert.ok(!JSON.stringify(record).includes(secret));
});

for (const [option, stage] of [['keepSync', 'syncjobs'], ['dropMail', 'mailbox'], ['keepOwner', 'mailbox'], ['ignoreFilter', 'teamFilters']]) test(`rename: ${option} mismatch returns partial and stops later stages`, async t => {
  const f = await fixture(t); f.options[option] = true;
  const result = await run(f, (await preview(f)).etag);
  assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).stage, stage); assert.equal(result.steps.at(-1).code, 'WRITE_VERIFY_FAILED');
  assert.equal(writes(f).filter(call => call.path === '/api/v1/add/alias').length, 0);
  if (option === 'dropMail') assert.equal(result.warnings[0].code, 'MAIL_COUNT_DECREASED');
  if (option === 'keepSync') assert.match(result.steps.at(-1).recovery, /지우고 새 주소로 다시/);
});

test('rename: sender fallback unions and preserves old unrelated permissions instead of replacing lists blindly', async t => {
  const f = await fixture(t); f.options.keepSenders = true;
  const result = await run(f, (await preview(f)).etag); assert.equal(result.result, 'ok'); assert.deepEqual(f.boxes[2].sender_acl, [next, team]);
  assert.deepEqual(writes(f).find(call => call.path === '/api/v1/edit/mailbox').body.attr.sender_acl, [next, team]);
});

test('rename: auth loss after rename records partial then rethrows original 403', async t => {
  const f = await fixture(t), failure = new MailcowAuthLost(); f.options.failPath = '/api/v1/edit/alias'; f.options.failure = failure;
  await assert.rejects(run(f, (await preview(f)).etag), error => error === failure);
  assert.equal((await f.history.list()).items.find(row => row.action === 'mailbox.rename').result, 'partial');
});

test('rename: stale etag, missing etag and concurrent duplicate flows produce no second rename', async t => {
  const f = await fixture(t), initial = await preview(f);
  for (const etag of ['stale', undefined]) await assert.rejects(run(f, etag), { statusCode: 409 }); assert.equal(writes(f).length, 0);
  const results = await Promise.allSettled([run(f, initial.etag), run(f, initial.etag)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(writes(f).filter(call => call.path === '/api/v1/edit/rename-mbox').length, 1);
});

test('rename HTTP: guard protects preview/run and permits successful rename without challenge headers', async t => {
  const f = await fixture(t, false); const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: false,
    dockerapi: f.dockerapi, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  const url = `/api/admin/mailboxes/${old}/rename`, payload = { action: 'preview', newLocal: 'new', keepOldAsAlias: true };
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  const denied = await app.inject({ method: 'POST', url, headers: { ...headers, 'x-mailadmin-csrf': '' }, payload }); assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
  const initial = await app.inject({ method: 'POST', url, headers, payload }); assert.equal(initial.statusCode, 200, initial.body);
  const done = await app.inject({ method: 'POST', url, headers, payload: { ...payload, action: 'run', etag: initial.json().etag } }); assert.equal(done.statusCode, 200, done.body); assert.equal(done.json().result, 'ok'); assert.equal(done.headers['cache-control'], 'no-store');
});

for (const ignoreSenderWrites of [false, true]) test(`rename regression: alias goto preserves unrelated explicit sender ACL; restore ignored=${ignoreSenderWrites}`, async t => {
  const f = await fixture(t, false), alias = 'many@example.com';
  f.aliases.push({ id: 2, address: alias, goto: `${old},${other}`, active: 1, sender_allowed: '0' });
  f.boxes[2].sender_acl = [alias, team]; const initial = await preview(f); f.options.ignoreSenderWrites = ignoreSenderWrites;
  const result = await run(f, initial.etag);
  if (ignoreSenderWrites) {
    assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'WRITE_VERIFY_FAILED');
    assert.equal(result.steps.at(-1).stage, 'aliases'); assert.ok(result.steps.at(-1).recovery);
  } else {
    assert.equal(result.result, 'ok'); assert.deepEqual(f.boxes[2].sender_acl, [alias, team]);
  }
});

test('rename regression: mixed owned/received ACL responses use the real owner and deduplicate shares', async t => {
  const f = await fixture(t, false);
  const grant = { user: other, id: old, mailbox: 'INBOX', rights: ['lookup', 'read'] };
  f.acl.set(other, [grant, structuredClone(grant)]);
  const initial = await preview(f);
  assert.deepEqual(initial.changes.shares, [{ owner: other, grantee: old, mailbox: 'INBOX', rights: ['lookup', 'read'], newOwner: other, newGrantee: next }]);
  const result = await run(f, initial.etag); assert.equal(result.result, 'ok');
  assert.deepEqual(writes(f).filter(row => row.path === 'dockerapi/set_acl').map(row => row.body), [{ owner: other, grantee: next, mailbox: 'INBOX' }]);
  assert.ok(!f.acl.has(next));
});

for (const direction of ['grantee', 'owner']) test(`account folder ACL: rename ${direction} preserves every original folder`, async t => {
  const f = await fixture(t, false), owner = direction === 'owner' ? old : team, grantee = direction === 'owner' ? other : old;
  const folders = ['INBOX', 'Sent', '거래처 "봄"/2026'];
  f.acl.set(owner, folders.map(mailbox => ({ user: owner, id: grantee, mailbox, rights: ['lookup', 'read'] })));
  const initial = await preview(f);
  assert.equal(initial.changes.shares.length, 3);
  const result = await run(f, initial.etag); assert.equal(result.result, 'ok');
  const newOwner = direction === 'owner' ? next : owner, newGrantee = direction === 'owner' ? grantee : next;
  assert.deepEqual(f.acl.get(newOwner).map(row => ({ ...row })).sort((a, b) => a.mailbox.localeCompare(b.mailbox)),
    folders.map(mailbox => ({ user: newOwner, id: newGrantee, mailbox, rights: ['lookup', 'read'] })).sort((a, b) => a.mailbox.localeCompare(b.mailbox)));
  assert.ok(![...f.acl.values()].flat().some(row => row.user === old || row.id === old));
  const check = f.calls.find(call => call.path === 'acl-folders/assert');
  assert.deepEqual(new Set(check.body.mailboxes), new Set(folders)); assert.equal(check.body.owner, newOwner);
  if (direction === 'grantee') for (const mailbox of folders) {
    const set = f.calls.findIndex(call => call.path === 'dockerapi/set_acl' && call.body.mailbox === mailbox);
    const del = f.calls.findIndex(call => call.path === 'dockerapi/delete_acl' && call.body.mailbox === mailbox);
    assert.ok(f.calls.indexOf(check) < set && set < del);
  }
});

test('account folder ACL: rename validates every folder before first ACL write', async t => {
  const f = await fixture(t, false);
  f.acl.set(team, ['INBOX', 'Sent'].map(mailbox => ({ user: team, id: old, mailbox, rights: ['lookup', 'read'] })));
  const initial = await preview(f); f.options.missingFolder = 'Sent';
  const result = await run(f, initial.etag);
  assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'CONFLICT'); assert.equal(result.steps.at(-1).stage, 'shares');
  assert.ok(!writes(f).some(call => call.path.startsWith('dockerapi/')));
});

test('account folder ACL: another folder cannot mask a failed folder grant on rename', async t => {
  const f = await fixture(t, false);
  f.acl.set(team, ['INBOX', 'Sent'].map(mailbox => ({ user: team, id: old, mailbox, rights: ['lookup', 'read'] })));
  const originalSet = f.dockerapi.setAcl;
  f.dockerapi.setAcl = async (owner, grantee, mailbox) => { if (mailbox !== 'Sent') await originalSet(owner, grantee, mailbox); };
  const result = await run(f, (await preview(f)).etag);
  assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'WRITE_VERIFY_FAILED');
  assert.ok(!writes(f).some(call => call.path === '/api/v1/add/alias'));
});

test('account folder ACL: rename disabled doveadm warns and only migrates INBOX', async t => {
  const f = await fixture(t, false); f.aclFolders.enabled = false;
  f.acl.set(team, ['INBOX', 'Sent'].map(mailbox => ({ user: team, id: old, mailbox, rights: ['lookup', 'read'] })));
  const initial = await preview(f); assert.deepEqual(initial.changes.shares.map(row => row.mailbox), ['INBOX']);
  assert.ok(initial.warnings.some(row => row.code === 'SUBFOLDER_ACL_UNCHECKED'));
  const result = await run(f, initial.etag); assert.equal(result.result, 'ok');
  assert.ok(result.warnings.some(row => row.code === 'SUBFOLDER_ACL_UNCHECKED'));
  assert.ok(f.acl.get(team).some(row => row.mailbox === 'Sent' && row.id === old));
});

test('rename: updates bundled team alias targets through the existing alias path', async t => {
  const f = await fixture(t, false), bundle = 'team-members@example.com';
  const script = `redirect :copy "${bundle}";\n`;
  f.filters.push({ id: 1, username: team, filter_type: 'prefilter', active: 1, script_data: script });
  f.aliases.push({ id: 1, address: bundle, goto: `${old},${other}`, active: 1, internal: '1', private_comment: 'mailadmin:team-members' });
  const result = await run(f, (await preview(f)).etag);
  assert.equal(result.result, 'ok'); assert.deepEqual(f.aliases[0].goto.split(','), [next, other]);
  assert.equal(f.aliases[0].private_comment, 'mailadmin:team-members'); assert.equal(f.aliases[0].internal, '1');
  assert.equal(f.filters[0].script_data, script);
});
