import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBatchService, parseCsv } from '../../server/admin/services/batch.js';
import { createAccountsService } from '../../server/admin/services/accounts.js';
import { createDomainsService } from '../../server/admin/services/domains.js';
import { createTeamsService } from '../../server/admin/services/teams.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';
import { MailcowAuthLost } from '../../server/admin/mailcow-client.js';

const GB = 1024 ** 3, ctx = { session: {}, actor: 'admin', ip: '198.51.100.9' };
const makeBox = (username, name = username.split('@')[0], quota = 20) => ({ username, name, quota: quota * GB, active: 1, quota_used: 0, messages: 0, sender_acl: [], attributes: {} });
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a09a-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const boxes = [makeBox('existing@example.com'), makeBox('plan@example.com', '기획팀', 50), makeBox('ops@example.com', '운영팀', 50)];
  const filters = ['plan@example.com', 'ops@example.com'].map((username, i) => ({ id: i + 1, username, filter_type: 'prefilter', active: '1', script_data: 'require ["copy"];\nredirect :copy "existing@example.com";\n' }));
  const primary = [{ domain_name: 'example.com', active: '1' }, { domain_name: 'off.example.com', active: '0' }], aliasDomains = [{ alias_domain: 'alias.example.com', target_domain: 'example.com', active: '1' }];
  const aliases = [{ address: 'alias@example.com', goto: 'existing@example.com', active: '1' }], calls = [], logs = [], options = {};
  const mailcow = { async call(_session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); await options.onCall?.({ method, path, body });
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    const tables = { 'mailbox/all': boxes, 'filters/all': filters, 'alias/all': aliases, 'domain/all': primary, 'alias-domain/all': aliasDomains, 'syncjobs/all/no_log': [] };
    if (path.startsWith('/api/v1/get/')) {
      const key = path.slice('/api/v1/get/'.length);
      if (tables[key]) return structuredClone(tables[key]);
      if (key.startsWith('mailbox/')) return structuredClone(boxes.find(box => box.username === decodeURIComponent(key.slice(8))) ?? {});
      if (key.startsWith('app-passwd/all/')) return [];
      assert.fail(path);
    }
    if (path === '/api/v1/add/mailbox') { if (!options.ignoreWrites) boxes.push(makeBox(`${body.local_part}@${body.domain}`, body.name, +body.quota / 1024)); }
    else if (path === '/api/v1/edit/filter') Object.assign(filters.find(row => String(row.id) === body.items[0]), body.attr);
    else if (path === '/api/v1/edit/mailbox') {
      if (!options.ignoreWrites) for (const addr of body.items) { const box = boxes.find(row => row.username === addr); if (body.attr.quota !== undefined) box.quota = +body.attr.quota * 1024 ** 2; }
    } else if (path === '/api/v1/add/domain') primary.push({ domain_name: body.domain, description: body.description, active: 1, max_num_mboxes_for_domain: +body.mailboxes, max_num_aliases_for_domain: +body.aliases, def_quota_for_mbox: +body.defquota * 1048576, max_quota_for_mbox: +body.maxquota * 1048576, max_quota_for_domain: +body.quota * 1048576, relay_all_recipients: +body.relay_all_recipients, backupmx: +body.backupmx });
    else assert.fail(path);
    return [{ type: 'success' }];
  } };
  const audit = createAudit({ dir, logger: { info(data) { logs.push(data); } } }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const dockerapi = { async getAcl() { return []; } };
  const teams = createTeamsService({ mailcow, audit, lock, history, auditDir: dir }), accounts = createAccountsService({ mailcow, dockerapi, audit, lock, history, teams }), domains = createDomainsService({ mailcow, audit, lock, history });
  const service = createBatchService({ mailcow, audit, accounts, domains, teams });
  return { dir, boxes, filters, primary, aliasDomains, aliases, calls, logs, options, mailcow, audit, lock, history, dockerapi, service };
}
const mailCsv = 'email,name,type,team\nfirst@example.com,첫째,개인,\nsecond@example.com,둘째,팀,기획팀\nthird@example.com,,관리,';
const run = (f, data = {}, kind = 'mailboxes') => f.service.run({ ...ctx, kind, data: { action: 'parse', csv: mailCsv, ...data } });
const writes = f => f.calls.filter(call => call.method === 'POST');

for (const [label, csv, expected] of [
  ['BOM reordered headers', '\uFEFF name , email\r\n 이름 , Person@EXAMPLE.COM\r\n', [{ line: 2, fields: ['이름', 'Person@EXAMPLE.COM'] }]],
  ['quoted comma/doubled quote', 'email,name\na@example.com,"Last, ""First"""', [{ line: 2, fields: ['a@example.com', 'Last, "First"'] }]],
  ['blank lines physical numbers', 'email\n\n  \na@example.com\n', [{ line: 4, fields: ['a@example.com'] }]],
  ['quoted multiline numbers', 'email,name\na@example.com,"first\nsecond"\nb@example.com,B', [{ line: 2, fields: ['a@example.com', 'first\nsecond'] }, { line: 4, fields: ['b@example.com', 'B'] }]],
  ['bare CR', 'email\ra@example.com\r', [{ line: 2, fields: ['a@example.com'] }]],
]) test(`batch CSV parser: ${label}`, () => assert.deepEqual(parseCsv(csv).slice(1), expected));
for (const csv of ['email,name\na@example.com,"unclosed', 'email\na"b@example.com', 'email,name\na@example.com,"name"extra']) test(`batch CSV malformed: ${JSON.stringify(csv)}`, () => assert.throws(() => parseCsv(csv), { statusCode: 422, code: 'CSV_SYNTAX', line: 2 }));

test('batch parse: real twelve-plus row cases include defaults, duplicate, existing aliases, domains and teams', async t => {
  const f = await fixture(t), csv = ['email,name,type,team', 'valid@example.com,정상,개인,기획팀', 'bad-address,오류,개인,', 'VALID@example.com,중복,개인,', 'existing@example.com,있음,개인,', 'alias@example.com,별칭,개인,', 'no@example.com,,개인,없는팀', 'new@missing.example.com,,개인,', 'off@off.example.com,,개인,', 'kind@example.com,,잘못된종류,', 'short@example.com', 'default@example.com,,,', 'admin-new@example.com,,관리,', 'alias@alias.example.com,,개인,', 'named@example.com,,팀,ops@example.com'].join('\n');
  const result = await run(f, { csv }); assert.equal(result.rows.length, 14); assert.equal(result.normal, 4); assert.equal(result.errors, 10);
  const byLine = line => result.rows.find(row => row.line === line);
  assert.equal(byLine(2).teamAddress, 'plan@example.com'); assert.equal(byLine(3).code, 'INVALID_ADDRESS'); assert.equal(byLine(4).code, 'DUPLICATE_ADDRESS'); assert.match(byLine(4).error, /2번/);
  assert.equal(byLine(5).code, 'ADDRESS_EXISTS'); assert.equal(byLine(6).code, 'ADDRESS_EXISTS'); assert.equal(byLine(7).code, 'NOT_TEAM'); assert.equal(byLine(8).code, 'DOMAIN_NOT_FOUND'); assert.equal(byLine(9).code, 'DOMAIN_NOT_ACTIVE'); assert.equal(byLine(10).code, 'INVALID_KIND'); assert.equal(byLine(11).code, 'CSV_COLUMNS'); assert.equal(byLine(12).name, 'default'); assert.equal(byLine(12).type, '개인'); assert.equal(byLine(13).valid, true); assert.equal(byLine(14).code, 'DOMAIN_NOT_PRIMARY'); assert.equal(byLine(15).teamAddress, 'ops@example.com');
  assert.equal(writes(f).length, 0); assert.equal((await f.audit.read()).rows.length, 0);
});
test('batch parse: unique exact team name, ambiguous name error, explicit address resolves ambiguity', async t => {
  const f = await fixture(t); f.boxes[2].name = '기획팀';
  const result = await run(f, { csv: 'email,team\na@example.com,기획팀\nb@example.com,plan@example.com' }); assert.equal(result.rows[0].code, 'TEAM_AMBIGUOUS'); assert.match(result.rows[0].error, /주소로/); assert.equal(result.rows[1].teamAddress, 'plan@example.com');
});
for (const csv of ['email,unknown\na@example.com,x', 'name\nName', 'email,email\na@example.com,b@example.com', '\nemail\na@example.com']) test(`batch: unknown/missing/duplicate/header first line rejected ${JSON.stringify(csv)}`, async t => { const f = await fixture(t); await assert.rejects(run(f, { csv }), { statusCode: 422 }); assert.equal(writes(f).length, 0); });

test('batch mailboxes: A06 defaults and team assignment; generated passwords response once, disk/logger zero', async t => {
  const f = await fixture(t), result = await run(f, { action: 'run', lines: [2, 3, 4] }); assert.equal(result.result, 'ok'); assert.equal(result.results.length, 3);
  for (const [i, size] of [20, 50, 3].entries()) assert.equal(f.boxes.find(box => box.username === result.results[i].email).quota, size * GB);
  assert.match(f.filters[0].script_data, /redirect :copy "second@example.com"/);
  const records = JSON.stringify(await f.audit.read()), disk = (await Promise.all((await fs.readdir(f.dir)).filter(name => name.endsWith('.jsonl')).map(name => fs.readFile(join(f.dir, name), 'utf8')))).join('');
  for (const row of result.results) {
    assert.equal(row.password.length, 20); assert.match(row.password, /[a-z]/); assert.match(row.password, /[A-Z]/); assert.match(row.password, /\d/); assert.match(row.password, /[!@#%^*_=+\-]/); assert.match(row.password, /^[A-Za-z0-9!@#%^*_=+\-]+$/);
    assert.equal(JSON.stringify(result).split(row.password).length - 1, 1); assert.ok(!records.includes(row.password)); assert.ok(!disk.includes(row.password)); assert.ok(!JSON.stringify(f.logs).includes(row.password));
  }
  const preview = await run(f); assert.ok(preview.rows.every(row => row.code === 'ADDRESS_EXISTS')); assert.ok(!JSON.stringify(preview).includes(result.results[0].password));
  await assert.rejects(run(f, { action: 'retry', lines: [2] }), { statusCode: 422 }); assert.equal(f.boxes.filter(box => box.username === 'first@example.com').length, 1);
});
test('batch: selection containing any error/missing/header line rejects entire request before mutations', async t => {
  const f = await fixture(t), csv = 'email\nnew@example.com\nwrong';
  for (const lines of [[2, 3], [2, 99], [1, 2]]) await assert.rejects(run(f, { action: 'run', csv, lines }), { statusCode: 422 }); assert.equal(writes(f).length, 0); assert.equal((await f.audit.read()).rows.length, 0);
});
for (const lines of [[], [2, 2], [2.5], ['2'], Array.from({ length: 51 }, (_, i) => i + 2)]) test(`batch: bad/over50 selection ${lines.length}`, async t => { const f = await fixture(t); await assert.rejects(run(f, { action: 'run', lines }), { statusCode: 422 }); assert.equal(writes(f).length, 0); });
test('batch: single row failure continues; retry resubmits failed row only, no successful row replay', async t => {
  const f = await fixture(t), csv = 'email\nfirst@example.com\nsecond@example.com\nthird@example.com'; let failed = true;
  f.options.onCall = ({ path, body }) => { if (path === '/api/v1/add/mailbox' && body.local_part === 'second' && failed) throw new AppError(422, 'MAILCOW_REJECTED', `암호 정책 실패 ${body.password}`); };
  const result = await run(f, { csv, action: 'run', lines: [2, 3, 4] }); assert.deepEqual(result.results.map(row => row.result), ['ok', 'failed', 'ok']); assert.equal(result.result, 'partial');
  const rejectedSecret = writes(f).find(call => call.path === '/api/v1/add/mailbox' && call.body.local_part === 'second').body.password; assert.ok(!JSON.stringify(result).includes(rejectedSecret)); assert.match(result.results[1].error, /암호 정책 실패 \*\*\*/);
  failed = false; const retried = await run(f, { csv, action: 'retry', lines: [3] }); assert.equal(retried.results.length, 1); assert.equal(retried.results[0].line, 3); assert.equal(retried.result, 'ok');
  assert.equal(writes(f).filter(call => call.path === '/api/v1/add/mailbox' && call.body.local_part === 'first').length, 1);
});
test('batch: team assignment failure preserves mailbox, partial and exact recovery; retry cannot recreate', async t => {
  const f = await fixture(t); f.options.onCall = ({ path }) => { if (path === '/api/v1/edit/filter') throw new AppError(502, 'WRITE_VERIFY_FAILED', '합성 팀 실패'); };
  const result = await run(f, { action: 'run', lines: [3] }); assert.equal(result.results[0].result, 'partial'); assert.deepEqual(result.results[0].recovery, ['메일함은 만들어졌고 팀 배정만 실패 — 계정 화면이나 팀 화면에서 마저 하기']); assert.ok(f.boxes.some(box => box.username === 'second@example.com'));
  const count = writes(f).length; await assert.rejects(run(f, { action: 'retry', lines: [3] }), { statusCode: 422 }); assert.equal(writes(f).length, count);
});
test('batch: domain creation opt-in uses A10b defaults once, stages before A06 mailbox creation', async t => {
  const f = await fixture(t), csv = 'email\na@new.example.com\nb@new.example.com';
  assert.equal((await run(f, { csv })).rows[0].code, 'DOMAIN_NOT_FOUND'); const preview = await run(f, { csv, options: { createDomains: true } }); assert.ok(preview.rows.every(row => row.createDomain));
  const result = await run(f, { csv, options: { createDomains: true }, action: 'run', lines: [2, 3] }); assert.equal(result.result, 'ok'); assert.equal(writes(f)[0].path, '/api/v1/add/domain'); assert.equal(writes(f)[0].body.maxquota, '51200'); assert.equal(writes(f).filter(row => row.path === '/api/v1/add/domain').length, 1); assert.equal(result.results[0].steps[0].stage, 'domain'); assert.equal(result.results[1].steps[0].stage, 'mailbox');
});
test('batch: new domain remains when mailbox stage fails, row partial includes domain audit', async t => {
  const f = await fixture(t); f.options.onCall = ({ path }) => { if (path === '/api/v1/add/mailbox') throw new AppError(422, 'MAILCOW_REJECTED', '합성 실패'); };
  const result = await run(f, { csv: 'email\na@new.example.com', options: { createDomains: true }, action: 'run', lines: [2] }); assert.equal(result.results[0].result, 'partial'); assert.equal(result.results[0].steps[0].stage, 'domain'); assert.ok(result.results[0].recovery.length); assert.ok(f.primary.some(row => row.domain_name === 'new.example.com'));
});
test('batch: quotas rejects unlimited, noninteger and missing mailbox; reuses A06 edit/unchanged', async t => {
  const f = await fixture(t), csv = 'quota_gb,email\n0,existing@example.com\n1.5,plan@example.com\n10,missing@example.com\n20,ops@example.com';
  const preview = await run(f, { csv }, 'quotas'); assert.deepEqual(preview.rows.map(row => row.code), ['INVALID_QUOTA', 'INVALID_QUOTA', 'NOT_FOUND', null]);
  const result = await run(f, { csv, action: 'run', lines: [5] }, 'quotas'); assert.equal(result.result, 'ok'); assert.equal(f.boxes[2].quota, 20 * GB);
  const second = await run(f, { csv, action: 'retry', lines: [5] }, 'quotas'); assert.equal(second.results[0].unchanged, true); assert.equal(writes(f).filter(row => row.path === '/api/v1/edit/mailbox').length, 1);
});
test('batch: authentication lost stops subsequent rows, records prior results and parent partial, then403', async t => {
  const f = await fixture(t); f.options.onCall = ({ path, body }) => { if (path === '/api/v1/add/mailbox' && body.local_part === 'second') throw new MailcowAuthLost(); };
  await assert.rejects(run(f, { action: 'run', lines: [2, 3, 4] }), { statusCode: 403 }); assert.equal(writes(f).filter(row => row.path === '/api/v1/add/mailbox').length, 2); assert.ok(!f.boxes.some(box => box.username === 'third@example.com'));
  const records = (await f.history.list()).items, batch = records.find(row => row.action === 'batch.mailboxes'); assert.equal(batch.result, 'partial'); assert.equal(batch.detail.stopped, true); assert.deepEqual(batch.detail.results.map(row => row.result), ['ok', 'failed']);
});
test('batch: 1000 physical lines and1MB boundaries, quoted multiline contributes actual line count', () => {
  assert.equal(parseCsv('email\n' + Array(999).fill('a@example.com').join('\n') + '\n').length, 1000);
  assert.throws(() => parseCsv('email\n' + Array(1000).fill('a@example.com').join('\n')), { statusCode: 422 });
  assert.throws(() => parseCsv('email\n' + '가'.repeat(350000)), { statusCode: 422 });
  assert.throws(() => parseCsv('email,name\na@example.com,"' + '\n'.repeat(999) + '"'), { statusCode: 422 });
});
test('batch HTTP: guarded single action endpoint, syntax line422, >64KB valid CSV accepted, no CSV/password logs', async t => {
  const f = await fixture(t), logs = []; const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir }, dockerapi: f.dockerapi, logger: { level: 'info', stream: { write: line => logs.push(line) } }, auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/batch/mailboxes', headers: { origin: 'https://mailadmin.example.com' }, payload: { action: 'parse', csv: mailCsv } })).statusCode, 403);
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } }); const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  const post = payload => app.inject({ method: 'POST', url: '/api/admin/batch/mailboxes', headers, payload });
  const bad = await post({ action: 'parse', csv: 'email,name\na@example.com,"bad' }); assert.equal(bad.statusCode, 422); assert.equal(bad.json().error.line, 2);
  const large = await post({ action: 'parse', csv: 'email,name\n' + Array.from({ length: 500 }, (_, i) => `p${i}@example.com,${'x'.repeat(150)}`).join('\n') }); assert.equal(large.statusCode, 200, large.body); assert.equal(large.json().normal, 500);
  const done = await post({ action: 'run', csv: 'email,name\ncreated@example.com,synthetic-csv-marker', lines: [2] }); assert.equal(done.statusCode, 200, done.body); const secret = done.json().results[0].password; assert.ok(secret); assert.ok(!logs.join('').includes(secret)); assert.ok(!logs.join('').includes('synthetic-csv-marker'));
  assert.equal((await app.inject('/healthz')).json().ok, true); assert.equal((await app.inject({ method: 'POST', url: '/api/admin/batch/aliases', headers, payload: { action: 'parse', csv: 'email' } })).statusCode, 404);
});

test('batch: fifty selected rows execute; response/results match original source lines', async t => {
  const f = await fixture(t), csv = 'email\n' + Array.from({ length: 50 }, (_, i) => `person${i}@example.com`).join('\n');
  const result = await run(f, { csv, action: 'run', lines: Array.from({ length: 50 }, (_, i) => i + 2) });
  assert.equal(result.results.length, 50); assert.equal(result.result, 'ok'); assert.deepEqual(result.results.map(row => row.line), Array.from({ length: 50 }, (_, i) => i + 2));
  assert.equal(writes(f).filter(row => row.path === '/api/v1/add/mailbox').length, 50);
});
test('batch: team name resolution includes teams beyond first page', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 55; i++) { const addr = `extra${i}@example.com`; f.boxes.push(makeBox(addr, `팀${i}`, 50)); f.filters.push({ id: i + 3, username: addr, filter_type: 'prefilter', active: 1, script_data: 'redirect :copy "existing@example.com";\n' }); }
  const result = await run(f, { csv: 'email,team\nnew@example.com,팀54' }); assert.equal(result.rows[0].valid, true); assert.equal(result.rows[0].teamAddress, 'extra54@example.com');
});
test('batch: malformed request options/actions and quota negative value execute nothing', async t => {
  const f = await fixture(t);
  for (const data of [{ action: 'unknown' }, { options: { createDomains: 'true' } }, { options: { unexpected: true } }, { unexpected: true }, { lines: [2] }]) await assert.rejects(run(f, data), { statusCode: 422 });
  const result = await run(f, { csv: 'email,quota_gb\nexisting@example.com,-1' }, 'quotas'); assert.equal(result.rows[0].code, 'INVALID_QUOTA'); assert.equal(writes(f).length, 0);
});
