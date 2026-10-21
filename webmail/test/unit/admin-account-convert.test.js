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
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';

const addr = 'service@example.com', team = 'team@example.com', other = 'other@example.com';
const secret = 'Synthetic-Initial-A08b!', syncSecret = 'synthetic-source-secret';
const ownScript = `require ["copy"];\r\n# 보존 📨\r\nredirect :copy "${team}";\r\n`;
const context = { session: {}, actor: 'admin', ip: '198.51.100.27' };
const makeBox = username => ({ username, name: username.split('@')[0], quota: 20 * 1024 ** 3, quota_used: 0, messages: 0, active: 1, sender_acl: [], attributes: { imap_access: '1', pop3_access: '1', smtp_access: '1', sieve_access: '1', eas_access: '1', dav_access: '1' } });
const makeAlias = (id, address, goto) => ({ id, address, goto, active: '1', sogo_visible: '1', sender_allowed: '0', public_comment: '공개 설명', private_comment: '내부 설명' });
async function fixture(t, direction = 'mailbox-to-alias') {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a08b-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const boxes = [team, other].map(makeBox), aliases = [], filters = [], jobs = [], acl = new Map(), calls = [], options = {};
  boxes[0].sender_acl = [other]; boxes[1].sender_acl = [addr, team];
  if (direction === 'mailbox-to-alias') {
    boxes.unshift({ ...makeBox(addr), sender_acl: [team] });
    aliases.push(makeAlias(1, 'only@example.com', addr), { ...makeAlias(2, 'multi@example.com', `${addr},${other}`), active: '0', sender_allowed: '1' });
    filters.push({ id: 10, username: addr, filter_type: 'prefilter', active: 1, script_data: ownScript },
      { id: 11, username: addr, filter_type: 'postfilter', active: 0, script_data: 'keep;\n' },
      { id: 12, username: team, filter_type: 'prefilter', active: 1, script_data: `redirect :copy "${addr}";\n` });
    jobs.push({ id: 8, user2: addr, active: 1, password1: syncSecret });
    acl.set(addr, [{ user: addr, id: other, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
    acl.set(team, [{ user: team, id: addr, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
  } else aliases.push(makeAlias(3, addr, team));
  let sequence = 100;
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); options.onCall?.({ method, path, body });
    if (method === 'POST' && options.failPath === path) throw options.failure ?? new AppError(422, 'MAILCOW_REJECTED', syncSecret);
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (path === '/api/v1/get/alias-domain/all') return [];
    if (path === '/api/v1/get/domain/all') return [{ domain_name: 'example.com', active: 1 }];
    if (path === '/api/v1/get/mailbox/all') return structuredClone(boxes);
    if (path.startsWith('/api/v1/get/mailbox/')) return structuredClone(boxes.find(row => row.username === decodeURIComponent(path.split('/').at(-1))) ?? {});
    if (path === '/api/v1/get/filters/all') return structuredClone(filters);
    if (path === '/api/v1/get/alias/all') return structuredClone(aliases);
    if (path === '/api/v1/get/syncjobs/all/no_log') return structuredClone(jobs);
    if (path.startsWith('/api/v1/get/app-passwd/all/')) return [];
    if (path === '/api/v1/delete/syncjob') for (const id of body) jobs.splice(jobs.findIndex(row => String(row.id) === id), 1);
    else if (path === '/api/v1/delete/filter') for (const id of body) filters.splice(filters.findIndex(row => String(row.id) === id), 1);
    else if (path === '/api/v1/delete/mailbox') for (const target of body) {
      boxes.splice(boxes.findIndex(row => row.username === target), 1);
      for (let i = aliases.length - 1; i >= 0; i--) {
        const left = aliases[i].goto.split(',').filter(value => value !== target); if (!left.length) aliases.splice(i, 1); else aliases[i].goto = left.join(',');
      }
      for (const box of boxes) box.sender_acl = box.sender_acl.filter(value => value !== target);
      acl.delete(target);
    } else if (path === '/api/v1/add/alias') aliases.push({ id: sequence++, ...body });
    else if (path === '/api/v1/edit/alias') {
      const alias = aliases.find(row => String(row.id) === body.items[0]); Object.assign(alias, body.attr);
      // mailcow drops explicit alias grants before storing goto.
      if (Object.hasOwn(body.attr, 'goto')) for (const box of boxes) if (alias.goto.split(',').includes(box.username)) box.sender_acl = box.sender_acl.filter(value => value !== alias.address);
    } else if (path === '/api/v1/delete/alias') for (const id of body) {
      const index = aliases.findIndex(row => String(row.id) === id), target = aliases[index].address; aliases.splice(index, 1);
      for (const box of boxes) box.sender_acl = box.sender_acl.filter(value => value !== target);
    } else if (path === '/api/v1/add/mailbox') boxes.push({ ...makeBox(`${body.local_part}@${body.domain}`), name: body.name, quota: Number(body.quota) * 1024 ** 2, ...options.created });
    else if (path === '/api/v1/edit/mailbox') {
      for (const target of body.items) if (!options.ignoreSenderWrites) {
        const box = boxes.find(row => row.username === target); Object.assign(box, body.attr);
        if (body.attr.sender_acl) {
          const implicit = aliases.filter(row => !row.address.startsWith('@') && row.sender_allowed === '1' && row.goto.split(',').includes(target)).map(row => row.address);
          box.sender_acl = box.sender_acl.filter(value => !implicit.includes(value));
        }
      }
    } else if (path === '/api/v1/add/filter') filters.push({ id: sequence++, ...body });
    else assert.fail(path);
    return [{ type: 'success' }];
  } };
  const dockerapi = { async getAcl(owner) { if (options.aclFailure === owner) throw new Error(syncSecret); return structuredClone([...acl.values()].flat().filter(row => row.user === owner || row.id === owner)); } };
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
  return { dir, boxes, aliases, filters, jobs, acl, calls, options, mailcow, dockerapi, aclFolders, audit, history, service, direction };
}
const convert = (f, data) => f.service.convert({ ...context, direction: f.direction, data: { address: addr, ...(f.direction === 'mailbox-to-alias' ? { targets: [team] } : {}), ...data } });
const preview = (f, data = {}) => convert(f, { action: 'preview', ...data });
const run = (f, etag, data = {}) => convert(f, { action: 'run', etag, ...(f.direction === 'alias-to-mailbox' ? { password: secret } : {}), ...data });
const writes = f => f.calls.filter(row => row.method === 'POST');

test('convert mailbox: preview preserves last-member team and reports own permission/share loss and unused incoming ACL', async t => {
  const f = await fixture(t), result = await preview(f, { targets: [team, team] });
  assert.deepEqual(result.changes.alias.targets, [team]); assert.equal(result.changes.mailbox.messages, 0);
  assert.equal(result.changes.aliasesRestored.length, 2); assert.equal(result.changes.filtersRemoved.length, 2); assert.equal(result.changes.senderRestore.length, 1);
  assert.ok(result.warnings.some(row => row.message === '이 메일함이 다른 주소로 보내던 권한 1개는 없어져요'));
  assert.ok(result.warnings.some(row => row.message === '이 메일함을 다른 사람에게 공유한 1건은 없어져요'));
  assert.ok(result.warnings.some(row => row.message === '다른 함에서 이 주소에 준 공유 1건은 남지만 로그인할 수 없어 쓰이지 않아요'));
  assert.ok(result.warnings.some(row => row.message.includes('계속 이 주소로 보낼 수 있어요'))); assert.equal(writes(f).length, 0);
});

test('convert mailbox: ordered removal fills automatic unique-alias deletion trap and restores original metadata and sender union', async t => {
  const f = await fixture(t), originals = structuredClone(f.aliases), result = await run(f, (await preview(f)).etag);
  assert.equal(result.result, 'ok'); assert.ok(!f.boxes.some(row => row.username === addr));
  const paths = writes(f).map(row => row.path);
  assert.deepEqual(paths.slice(0, 5), ['/api/v1/delete/syncjob', '/api/v1/delete/filter', '/api/v1/delete/filter', '/api/v1/delete/mailbox', '/api/v1/add/alias']);
  for (const original of originals) {
    const checked = f.aliases.find(row => row.address === original.address); assert.ok(checked);
    for (const key of ['goto', 'active', 'sogo_visible', 'sender_allowed', 'public_comment', 'private_comment']) assert.equal(checked[key], original[key]);
  }
  assert.equal(f.aliases.find(row => row.address === addr).goto, team);
  assert.deepEqual(f.boxes.find(row => row.username === other).sender_acl, [addr, team]);
  assert.equal(f.jobs.length, 0); assert.equal(f.filters.length, 1); assert.ok(f.filters[0].script_data.includes(addr));
  assert.equal(f.acl.has(addr), false); assert.equal(f.acl.get(team)[0].id, addr);
  const records = (await f.history.list()).items; const flow = records.find(row => row.action === 'mailbox.convert.mailbox-to-alias');
  assert.equal(flow.kind, 'irreversible'); assert.equal(flow.canRevert, false); assert.ok(records.every(row => !row.canRevert));
  const deletedFilter = records.find(row => row.action === 'mailbox.convert.filter.delete' && row.before.sha256);
  const backups = await fs.readdir(join(f.dir, 'filter-backups')); assert.equal(backups.length, 4);
  const raw = await fs.readFile(join(f.dir, 'filter-backups', `${deletedFilter.id}.before.sieve`), 'utf8'); assert.ok([ownScript, 'keep;\n'].includes(raw));
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${deletedFilter.id}.after.sieve`), 'utf8'), '');
  assert.ok(!JSON.stringify(records).includes(syncSecret)); assert.ok(!JSON.stringify(records).includes('redirect'));
  await assert.rejects(f.history.revert(flow.id, { ...context, confirm: true }), { statusCode: 409 });
});

test('convert mailbox: nonempty preview and run are rejected before mutation', async t => {
  const f = await fixture(t), initial = await preview(f); f.boxes[0].messages = 1;
  await assert.rejects(preview(f), { statusCode: 409, code: 'MAILBOX_NOT_EMPTY' });
  await assert.rejects(run(f, initial.etag), { statusCode: 409, code: 'MAILBOX_NOT_EMPTY' }); assert.equal(writes(f).length, 0);
});

test('convert mailbox: newly arrived mail after preparatory deletion stops before mailbox delete with exact recovery', async t => {
  const f = await fixture(t), initial = await preview(f);
  f.options.onCall = ({ path }) => { if (path === '/api/v1/delete/syncjob') f.boxes[0].messages = 1; };
  const result = await run(f, initial.etag); assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'MAILBOX_NOT_EMPTY');
  assert.equal(result.steps.at(-1).recovery, '새로 도착한 메일이 있어 전환을 멈췄어요. 메일을 옮기거나 지운 뒤 다시 전환하세요. 이미 지운 동기화·필터는 변경 기록에서 확인하세요.');
  assert.ok(!writes(f).some(row => row.path === '/api/v1/delete/mailbox')); assert.ok(f.boxes.some(row => row.username === addr));
});

for (const [label, change] of [
  ['targets', () => ({ targets: [other] })], ['alias metadata', f => { f.aliases[0].private_comment = '외부 변경'; }],
  ['team bytes', f => { f.filters[2].script_data += '# 외부\n'; }], ['sender ACL', f => { f.boxes[2].sender_acl.push('new@example.com'); }],
  ['sync secret', f => { f.jobs[0].password1 = 'changed-synthetic'; }],
]) test(`convert mailbox: ${label} change invalidates preview with zero writes`, async t => {
  const f = await fixture(t), initial = await preview(f), changed = change(f) ?? {};
  await assert.rejects(run(f, initial.etag, changed), { statusCode: 409 }); assert.equal(writes(f).length, 0);
});

test('convert mailbox: pre-delete snapshot catches references added after filter cleanup', async t => {
  const f = await fixture(t), initial = await preview(f);
  f.options.onCall = ({ path, body }) => { if (path === '/api/v1/delete/filter' && body[0] === '11') f.aliases.push(makeAlias(5, 'late@example.com', addr)); };
  const result = await run(f, initial.etag); assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'CHANGED_ELSEWHERE');
  assert.ok(!writes(f).some(row => row.path === '/api/v1/delete/mailbox'));
});

test('convert mailbox: failure during address gap leaves partial with metadata-backed manual recovery', async t => {
  const f = await fixture(t), initial = await preview(f); f.options.failPath = '/api/v1/add/alias';
  const result = await run(f, initial.etag); assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).stage, 'alias');
  assert.match(result.steps.at(-1).recovery, /수신을 복구/); assert.ok(!f.boxes.some(row => row.username === addr)); assert.ok(!f.aliases.some(row => row.address === addr));
  const flow = (await f.history.list()).items.find(row => row.action === 'mailbox.convert.mailbox-to-alias');
  assert.equal(flow.result, 'partial'); assert.equal(flow.before.aliasesRestored[0].private_comment, '내부 설명'); assert.ok(!JSON.stringify(flow).includes(syncSecret));
});

test('convert mailbox: unsupported redirect and ACL are rejected before changes', async t => {
  const f = await fixture(t); f.filters[2].script_data = `redirect "${addr}";\n`;
  await assert.rejects(preview(f), { statusCode: 409 }); f.filters[2].script_data = `redirect :copy "${addr}";\n`;
  f.acl.get(team)[0].rights.push('write'); await assert.rejects(preview(f), { code: 'ACL_UNSUPPORTED' }); assert.equal(writes(f).length, 0);
});

for (const target of [addr, 'external@example.net', 'bad-address']) test(`convert mailbox: invalid internal target ${target} rejected before writes`, async t => {
  const f = await fixture(t); await assert.rejects(preview(f, { targets: [target] }), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});

test('convert alias: preview requires no password, preserves original metadata and lists sender restoration', async t => {
  const f = await fixture(t, 'alias-to-mailbox'), result = await preview(f, { copyTo: team, sendGrantTo: team });
  assert.equal(result.passwordRequired, true); assert.equal(result.passwordNotice, '실행할 때 초기 암호가 필요해요');
  assert.equal(result.changes.mailbox.name, 'service'); assert.equal(result.changes.mailbox.quotaGb, 20); assert.equal(result.changes.alias.private_comment, '내부 설명');
  assert.deepEqual(result.changes.senderRestore, [{ mailbox: other, senderAcl: [addr, team] }]); assert.equal(writes(f).length, 0);
  await assert.rejects(preview(f, { password: secret }), { statusCode: 422 }); await assert.rejects(run(f, result.etag, { password: '' }), { statusCode: 422 });
});

test('convert alias: deletes alias before mailbox, copies with backup, restores senders and grants separately, returns password once', async t => {
  const f = await fixture(t, 'alias-to-mailbox'), args = { copyTo: team, sendGrantTo: team }, initial = await preview(f, args);
  const result = await run(f, initial.etag, args); assert.equal(result.result, 'ok'); assert.equal(result.password, secret);
  assert.equal(JSON.stringify(result).split(secret).length - 1, 1);
  assert.deepEqual(writes(f).map(row => row.path), ['/api/v1/delete/alias', '/api/v1/add/mailbox', '/api/v1/add/filter', '/api/v1/edit/mailbox', '/api/v1/edit/mailbox']);
  assert.equal(f.filters[0].script_data, `require ["copy"];\nredirect :copy "${team}";\n`);
  assert.deepEqual(f.boxes.find(row => row.username === other).sender_acl, [addr, team]);
  assert.deepEqual(f.boxes.find(row => row.username === team).sender_acl, [addr, other].sort());
  assert.deepEqual(result.steps.map(row => row.stage), ['alias', 'mailbox', 'copy', 'senders', 'grant']);
  const records = (await f.history.list()).items; assert.ok(records.every(row => !row.canRevert)); assert.ok(!JSON.stringify(records).includes(secret));
  assert.equal(records.find(row => row.action === 'mailbox.convert.alias-to-mailbox').kind, 'config');
  assert.equal(records.find(row => row.action === 'mailbox.convert.mailbox').after.password, 'set');
  const filterRecord = records.find(row => row.action === 'team.forward');
  assert.equal(await fs.readFile(join(f.dir, 'filter-backups', `${filterRecord.id}.after.sieve`), 'utf8'), f.filters[0].script_data);
  assert.equal((await f.service.detail({}, addr)).address, addr); assert.ok(!JSON.stringify(await f.service.detail({}, addr)).includes(secret));
});

for (const [kind, expected] of [['personal', 20], ['team', 50], ['admin', 3]]) test(`convert alias: default ${kind} quota is ${expected}GB`, async t => {
  const f = await fixture(t, 'alias-to-mailbox'), initial = await preview(f, { kind }); await run(f, initial.etag, { kind });
  assert.equal(writes(f).find(row => row.path === '/api/v1/add/mailbox').body.quota, String(expected * 1024));
});

for (const [label, previewOptions, runOptions] of [
  ['kind', {}, { kind: 'team' }], ['quota', {}, { quotaGb: 30 }], ['copy', {}, { copyTo: team }], ['grant', {}, { sendGrantTo: team }],
]) test(`convert alias: changed ${label} request invalidates etag before delete`, async t => {
  const f = await fixture(t, 'alias-to-mailbox'), initial = await preview(f, previewOptions);
  await assert.rejects(run(f, initial.etag, runOptions), { statusCode: 409 }); assert.equal(writes(f).length, 0);
});

test('convert alias: changing original metadata or sender ACL invalidates preview', async t => {
  const f = await fixture(t, 'alias-to-mailbox'), initial = await preview(f); f.aliases[0].goto = other;
  await assert.rejects(run(f, initial.etag), { statusCode: 409 }); assert.equal(writes(f).length, 0);
});

test('convert alias: first delete failure returns original error, gap create failure returns partial without password', async t => {
  const f = await fixture(t, 'alias-to-mailbox'); f.options.failPath = '/api/v1/delete/alias';
  await assert.rejects(run(f, (await preview(f)).etag), { statusCode: 422 }); assert.ok(f.aliases.some(row => row.address === addr));
  f.options.failPath = '/api/v1/add/mailbox'; const result = await run(f, (await preview(f)).etag);
  assert.equal(result.result, 'partial'); assert.equal(result.password, undefined); assert.match(result.steps.at(-1).recovery, /별칭/);
  assert.ok(!f.boxes.some(row => row.username === addr)); assert.ok(!f.aliases.some(row => row.address === addr));
});

test('convert alias: later copy failure retains mailbox and returns one-time password and recovery', async t => {
  const f = await fixture(t, 'alias-to-mailbox'), args = { copyTo: team }, initial = await preview(f, args); f.options.failPath = '/api/v1/add/filter';
  const result = await run(f, initial.etag, args); assert.equal(result.result, 'partial'); assert.equal(result.password, secret); assert.equal(result.steps.at(-1).stage, 'copy');
  assert.match(result.steps.at(-1).recovery, /redirect :copy/); assert.ok(f.boxes.some(row => row.username === addr));
  assert.ok(!JSON.stringify((await f.audit.read()).rows).includes(secret));
});

for (const args of [{ copyTo: 'external@example.net' }, { sendGrantTo: addr }, { quotaGb: 0 }]) test('convert alias: invalid settings are rejected before alias deletion', async t => {
  const f = await fixture(t, 'alias-to-mailbox'); await assert.rejects(preview(f, args), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});

test('convert alias: auth loss after removal records partial and rethrows original 403', async t => {
  const f = await fixture(t, 'alias-to-mailbox'), failure = new MailcowAuthLost(); f.options.failPath = '/api/v1/add/mailbox'; f.options.failure = failure;
  await assert.rejects(run(f, (await preview(f)).etag), error => error === failure);
  assert.equal((await f.history.list()).items.find(row => row.action === 'mailbox.convert.alias-to-mailbox').result, 'partial');
});

test('convert: missing etag and concurrent duplicate flows cannot issue two destructive first stages', async t => {
  const f = await fixture(t, 'alias-to-mailbox'), initial = await preview(f);
  await assert.rejects(run(f, undefined), { statusCode: 409 }); assert.equal(writes(f).length, 0);
  const results = await Promise.allSettled([run(f, initial.etag), run(f, initial.etag)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(writes(f).filter(row => row.path === '/api/v1/delete/alias').length, 1);
});

test('convert HTTP: both routes use existing authentication/CSRF guard and JSON partial contract', async t => {
  const f = await fixture(t, 'alias-to-mailbox'); const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, logger: false,
    dockerapi: f.dockerapi, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  const url = '/api/admin/convert/alias-to-mailbox';
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  for (const route of ['alias-to-mailbox', 'mailbox-to-alias']) assert.equal((await app.inject({ method: 'POST', url: `/api/admin/convert/${route}`, headers: { ...headers, 'x-mailadmin-csrf': '' }, payload: {} })).statusCode, 403);
  const initial = await app.inject({ method: 'POST', url, headers, payload: { action: 'preview', address: addr } }); assert.equal(initial.statusCode, 200, initial.body);
  f.options.failPath = '/api/v1/add/mailbox';
  const result = await app.inject({ method: 'POST', url, headers, payload: { action: 'run', address: addr, etag: initial.json().etag, password: secret } });
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().result, 'partial'); assert.equal(result.headers['www-authenticate'], undefined); assert.equal(result.headers['cache-control'], 'no-store'); assert.ok(!result.body.includes(secret));
});

for (const ignoreSenderWrites of [false, true]) test(`convert regression: restoring alias goto preserves unrelated explicit sender ACL; restore ignored=${ignoreSenderWrites}`, async t => {
  const f = await fixture(t), alias = f.aliases.find(row => row.id === 2);
  alias.sender_allowed = '0'; f.boxes.find(row => row.username === other).sender_acl = [alias.address, team];
  const initial = await preview(f); f.options.ignoreSenderWrites = ignoreSenderWrites;
  const result = await run(f, initial.etag);
  if (ignoreSenderWrites) {
    assert.equal(result.result, 'partial'); assert.equal(result.steps.at(-1).code, 'WRITE_VERIFY_FAILED');
    assert.equal(result.steps.at(-1).stage, 'references'); assert.ok(result.steps.at(-1).recovery);
  } else {
    assert.equal(result.result, 'ok'); assert.deepEqual(f.boxes.find(row => row.username === other).sender_acl, [alias.address, team]);
  }
});

test('convert regression: fixed sender aliases retain effective permission when mailcow omits explicit ACL', async t => {
  const f = await fixture(t), alias = f.aliases.find(row => row.id === 2);
  f.boxes.find(row => row.username === other).sender_acl = [alias.address, team];
  const result = await run(f, (await preview(f)).etag); assert.equal(result.result, 'ok');
  assert.equal(alias.sender_allowed, '1'); assert.ok(alias.goto.split(',').includes(other));
  assert.deepEqual(f.boxes.find(row => row.username === other).sender_acl, [team]);
});

test('convert regression: a received share is counted once as incoming and never as owned', async t => {
  const f = await fixture(t); f.acl.delete(addr);
  const grant = { user: team, id: addr, mailbox: 'INBOX', rights: ['lookup', 'read'] };
  f.acl.set(team, [grant, structuredClone(grant)]);
  const result = await preview(f);
  assert.equal(result.changes.refs.shares.length, 1);
  assert.equal(result.warnings.find(row => row.code === 'OWN_SHARES_REMOVED').message, '이 메일함을 다른 사람에게 공유한 0건은 없어져요');
  assert.equal(result.warnings.find(row => row.code === 'INCOMING_SHARES_UNUSED').message, '다른 함에서 이 주소에 준 공유 1건은 남지만 로그인할 수 없어 쓰이지 않아요');
});

test('account folder ACL: mailbox conversion previews all folders and retains incoming permissions', async t => {
  const f = await fixture(t), folders = ['Sent', 'INBOX/거래처 "봄"'];
  for (const mailbox of folders) {
    f.acl.get(addr).push({ user: addr, id: other, mailbox, rights: ['lookup', 'read'] });
    f.acl.get(team).push({ user: team, id: addr, mailbox, rights: ['lookup', 'read'] });
  }
  const initial = await preview(f);
  assert.equal(initial.changes.refs.shares.length, 6);
  assert.ok(initial.warnings.find(row => row.code === 'INCOMING_SHARES_UNUSED').message.includes('3건'));
  const incoming = structuredClone(f.acl.get(team));
  const result = await run(f, initial.etag); assert.equal(result.result, 'ok');
  assert.deepEqual(f.acl.get(team), incoming);
});

test('account folder ACL: mailbox conversion refuses write rights on a subfolder', async t => {
  const f = await fixture(t);
  f.acl.get(team).push({ user: team, id: addr, mailbox: 'Sent', rights: ['lookup', 'read', 'write'] });
  await assert.rejects(preview(f), { statusCode: 409, code: 'ACL_UNSUPPORTED' });
  assert.equal(writes(f).length, 0);
});

for (const direction of ['mailbox-to-alias', 'alias-to-mailbox']) test(`account folder ACL: ${direction} warns when doveadm is disabled`, async t => {
  const f = await fixture(t, direction); f.aclFolders.enabled = false;
  if (direction === 'mailbox-to-alias') f.acl.get(team).push({ user: team, id: addr, mailbox: 'Sent', rights: ['lookup', 'read'] });
  const initial = await preview(f);
  assert.ok(initial.warnings.some(row => row.code === 'SUBFOLDER_ACL_UNCHECKED'));
  if (direction === 'mailbox-to-alias') assert.ok(initial.changes.refs.shares.every(row => row.mailbox === 'INBOX'));
  const result = await run(f, initial.etag); assert.equal(result.result, 'ok');
  assert.ok(result.warnings.some(row => row.code === 'SUBFOLDER_ACL_UNCHECKED'));
});
