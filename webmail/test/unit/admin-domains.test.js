import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDomainsService } from '../../server/admin/services/domains.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createAdminApp } from '../../server/admin/app.js';

const ctx = { session: {}, actor: 'admin', ip: '198.51.100.32' };
const name = 'example.com', target = 'new.example.com';
const rawDkim = () => ({ pubkey: 'PUBLICEXAMPLE=', dkim_selector: 'mail2026', length: '2048', privkey: 'SYNTHETIC_PRIVATE_SENTINEL', private_key: { secret: 'SYNTHETIC_PRIVATE_SENTINEL' }, dkim_txt: 'unused' });
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'webmail-a10b-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const primary = [{ domain_name: name, active: '1' }, { domain_name: target, active: '1' }, { domain_name: 'off.example.com', active: '0' }];
  const aliases = [{ alias_domain: 'alias.example.com', target_domain: name, active: '1' }];
  const boxes = [{ username: 'first@example.com' }, { username: 'second@example.com' }];
  const addresses = [{ address: 'hello@example.com' }, { address: 'hello@alias.example.com' }];
  const bcc = [], keys = { [name]: rawDkim() }, calls = [], logs = [], options = {};
  const mailcow = { async call(session, method, path, body) {
    calls.push({ method, path, body: structuredClone(body) }); await options.onCall?.({ method, path, body });
    const reads = { 'domain/all': primary, 'alias-domain/all': aliases, 'mailbox/all': boxes, 'alias/all': addresses, 'bcc/all': bcc };
    if (path === '/api/v1/get/status/version') return { version: '2026-09a' };
    if (method === 'GET' && path.startsWith('/api/v1/get/dkim/')) return structuredClone(keys[path.split('/').at(-1)] ?? []);
    if (method === 'GET') return structuredClone(reads[path.slice('/api/v1/get/'.length)] ?? assert.fail(path));
    if (options.ignoreWrites) return [{ type: 'success' }];
    if (path === '/api/v1/edit/domain') primary.find(row => row.domain_name === body.items[0]).active = body.attr.active;
    else if (path === '/api/v1/add/domain') primary.push({ domain_name: body.domain, active: body.active, description: body.description,
      max_num_mboxes_for_domain: +body.mailboxes, max_num_aliases_for_domain: +body.aliases,
      def_quota_for_mbox: +body.defquota * 1048576, max_quota_for_mbox: +body.maxquota * 1048576, max_quota_for_domain: +body.quota * 1048576,
      relay_all_recipients: body.relay_all_recipients, backupmx: body.backupmx });
    else if (path === '/api/v1/add/alias-domain') aliases.push({ alias_domain: body.alias_domain, target_domain: body.target_domain, active: body.active });
    else if (path === '/api/v1/delete/alias-domain') aliases.splice(aliases.findIndex(row => row.alias_domain === body[0]), 1);
    else if (path === '/api/v1/add/dkim_duplicate') for (const to of body.to_domain) keys[to] = structuredClone(keys[body.from_domain]);
    else assert.fail(path);
    return [{ type: 'success' }];
  } };
  const audit = createAudit({ dir, logger: { info: (...args) => logs.push(args) } }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const service = createDomainsService({ mailcow, audit, lock, history });
  return { dir, primary, aliases, boxes, addresses, bcc, keys, calls, logs, options, mailcow, audit, history, service };
}
const edit = (f, data, domain = name) => f.service.edit({ ...ctx, name: domain, data });
const preview = f => edit(f, { action: 'preview', active: false });
const create = (f, data = {}) => f.service.create({ ...ctx, data: { domain: 'created.example.com', ...data } });
const aliasCreate = (f, data = {}) => f.service.createAlias({ ...ctx, data: { aliasDomain: 'extra.example.com', targetDomain: name, ...data } });
const writes = f => f.calls.filter(row => row.method === 'POST');
const revert = (f, id) => f.history.revert(id, { ...ctx, confirm: true });

test('domains: disable preview counts primary mailboxes and direct/alias-domain aliases', async t => {
  const f = await fixture(t), p = await preview(f);
  assert.equal(p.mailboxes, 2); assert.equal(p.aliases, 2); assert.equal(p.confirmDomain, name); assert.ok(p.warning.includes('거부')); assert.equal(writes(f).length, 0);
  const result = await edit(f, { action: 'run', active: false, etag: p.etag, confirmDomain: name });
  assert.equal(result.active, false); assert.deepEqual(writes(f)[0].body, { items: [name], attr: { active: '0' } });
  assert.equal((await f.history.detail(result.auditId)).canRevert, true);
  await revert(f, result.auditId); assert.equal(f.primary[0].active, '1');
});

test('domains: enabling needs no confirmation; equal state is unchanged without audit/write', async t => {
  const f = await fixture(t), p = await edit(f, { action: 'preview', active: true }, 'off.example.com');
  const result = await edit(f, { action: 'run', active: true, etag: p.etag }, 'off.example.com'); assert.equal(result.active, true);
  assert.equal((await edit(f, { action: 'run', active: true, etag: result.etag }, 'off.example.com')).unchanged, true); assert.equal(writes(f).length, 1);
});

for (const data of [{ action: 'bad', active: false }, { action: 'run', active: '0' }, { action: 'run', active: false, etag: 'stale' }]) test(`domains: bad mutation ${JSON.stringify(data)}`, async t => {
  const f = await fixture(t); await assert.rejects(edit(f, data), error => [409, 422].includes(error.statusCode)); assert.equal(writes(f).length, 0);
});

test('domains: changed impact invalidates preview; wrong confirmation rejected', async t => {
  const f = await fixture(t), p = await preview(f);
  await assert.rejects(edit(f, { action: 'run', active: false, etag: p.etag, confirmDomain: target }), { statusCode: 422 });
  f.addresses.push({ address: 'later@example.com' });
  await assert.rejects(edit(f, { action: 'run', active: false, etag: p.etag, confirmDomain: name }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 0);
});

test('domains: create uses policy defaults and does not offer destructive reversal', async t => {
  const f = await fixture(t), result = await create(f), body = writes(f)[0].body;
  assert.deepEqual(body, { domain: 'created.example.com', description: 'created.example.com', active: '1', mailboxes: '100', aliases: '400', defquota: '20480', maxquota: '51200', quota: '1048576', relay_all_recipients: '0', backupmx: '0' });
  assert.equal((await f.history.detail(result.auditId)).canRevert, false);
  await assert.rejects(create(f), { statusCode: 409 });
});

test('domains: validated overrides retain MiB units', async t => {
  const f = await fixture(t); await create(f, { description: '시험', mailboxes: 40, aliases: 90, defquota: 1024, maxquota: 2048, quota: 4096, relay_all_recipients: '1' });
  assert.equal(writes(f)[0].body.defquota, '1024'); assert.equal(writes(f)[0].body.backupmx, '1');
});
for (const data of [{ defquota: 0 }, { mailboxes: -1 }, { quota: 'nan' }, { defquota: 60000 }, { maxquota: 2000000 }, { backupmx: 2 }, { domain: 'bad/name' }, { unexpected: 1 }]) test(`domains: invalid defaults override ${JSON.stringify(data)}`, async t => {
  const f = await fixture(t); await assert.rejects(create(f, data), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});

test('alias domains: create/delete metadata and reversal by recreation', async t => {
  const f = await fixture(t), created = await aliasCreate(f);
  assert.deepEqual(writes(f)[0].body, { alias_domain: 'extra.example.com', target_domain: name, active: '1' });
  assert.equal((await f.service.listAliases({})).items.length, 2);
  const deleted = await f.service.removeAlias({ ...ctx, name: created.aliasDomain, data: { etag: created.etag, confirmDomain: created.aliasDomain } });
  assert.equal(deleted.deleted, true); await revert(f, deleted.auditId); assert.equal(f.aliases.length, 2);
  await assert.rejects(aliasCreate(f), { statusCode: 409 });
});
for (const data of [{ aliasDomain: name }, { aliasDomain: 'alias.example.com' }, { targetDomain: 'missing.example.com' }]) test(`alias domains: rejects conflict/inactive target ${JSON.stringify(data)}`, async t => {
  const f = await fixture(t); await assert.rejects(aliasCreate(f, data), error => [409, 422].includes(error.statusCode)); assert.equal(writes(f).length, 0);
});
test('alias domains: inactive primary allowed, backup relay target rejected', async t => {
  const f = await fixture(t); assert.equal((await aliasCreate(f, { targetDomain: 'off.example.com' })).targetDomain, 'off.example.com');
  f.primary[0].backupmx = '1'; await assert.rejects(aliasCreate(f, { aliasDomain: 'relay.example.com' }), { statusCode: 409, code: 'INVALID_TARGET_DOMAIN' });
});
test('alias domains: DELETE missing, changed etag and confirmation fail before write', async t => {
  const f = await fixture(t), item = (await f.service.listAliases({})).items[0];
  await assert.rejects(f.service.removeAlias({ ...ctx, name: target, data: { etag: 'bad', confirmDomain: target } }), { statusCode: 404 });
  await assert.rejects(f.service.removeAlias({ ...ctx, name: item.aliasDomain, data: { etag: 'bad', confirmDomain: item.aliasDomain } }), { statusCode: 409 });
  await assert.rejects(f.service.removeAlias({ ...ctx, name: item.aliasDomain, data: { etag: item.etag, confirmDomain: name } }), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});
for (const hasKey of [true, false]) test(`DNS: exact source script calculation with public DKIM ${hasKey}`, async t => {
  const f = await fixture(t); if (!hasKey) delete f.keys[name];
  const source = await fs.readFile(new URL('../../../scripts/dns-records.sh', import.meta.url), 'utf8');
  // Execute only the original printable record calculation; never load .env, Docker, dig or IP discovery.
  const block = source.slice(source.indexOf('# --- Copy-paste summary ---'));
  const output = execFileSync('bash', ['-c', block], { env: { PATH: process.env.PATH, DOMAIN: name, SERVER_IP: '192.0.2.10', DKIM_SELECTOR: hasKey ? 'mail2026' : 'dkim', DKIM_RECORD: hasKey ? 'PUBLICEXAMPLE=' : '' }, encoding: 'utf8' });
  const expected = output.split('\n').map(line => /^([^\s]+)\s+(A|CNAME|MX|TXT)\s+(.+)$/.exec(line)).filter(Boolean).map(match => ({ name: match[1], type: match[2], value: match[3] }));
  const result = await f.service.dns({}, { serverIp: '192.0.2.10' }); assert.equal(result.items.length, 3);
  assert.deepEqual(result.items[0].records, expected); assert.equal(expected.length, 9); assert.ok(output.includes(`PTR (optional): 192.0.2.10 → mail.${name}`));
  assert.deepEqual(result.items[0].ptr, { optional: true, address: '192.0.2.10', value: 'mail.example.com' });
});

test('DNS: no IP discovery; missing address placeholder and invalid IP rejected', async t => {
  const f = await fixture(t); assert.equal((await f.service.dns({})).items[0].records[0].value, '서버 공인 IP 를 넣어 주세요');
  for (const serverIp of ['bad', '192.0.2.1/24', '::1', ['192.0.2.1']]) await assert.rejects(f.service.dns({}, { serverIp }), { statusCode: 422 });
  assert.equal(writes(f).length, 0);
});

for (const operation of ['active', 'alias-create', 'domain-create']) test(`domains: ignored upstream ${operation} write is 502`, async t => {
  const f = await fixture(t); f.options.ignoreWrites = true;
  const run = operation === 'active' ? () => preview(f).then(p => edit(f, { action: 'run', active: false, etag: p.etag, confirmDomain: name })) : operation === 'alias-create' ? () => aliasCreate(f) : () => create(f);
  await assert.rejects(run(), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
});
for (const dependency of ['alias', 'bcc']) test(`alias domains: ${dependency} dependency blocks DELETE and invalidates undo`, async t => {
  const f = await fixture(t), created = await aliasCreate(f), addr = created.aliasDomain;
  if (dependency === 'alias') f.addresses.push({ address: `hello@${addr}`, goto: 'first@example.com', active: '1' });
  else f.bcc.push({ id: '1', local_dest: addr, bcc_dest: 'first@example.com', type: 'sender', active: '1' });
  const current = (await f.service.listAliases({})).items.find(row => row.aliasDomain === addr);
  await assert.rejects(f.service.removeAlias({ ...ctx, name: addr, data: { etag: current.etag, confirmDomain: addr } }), error => error.code === 'ALIAS_DOMAIN_IN_USE' && error.details[dependency === 'alias' ? 'aliases' : 'bcc'].length === 1);
  await assert.rejects(revert(f, created.auditId), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 1);
});

test('alias domains: undo creation deletes; restoring deletion preserves inactive flag and warns about temporary aliases', async t => {
  const f = await fixture(t), created = await aliasCreate(f); await revert(f, created.auditId); assert.equal(f.aliases.some(row => row.alias_domain === created.aliasDomain), false);
  // Use the newly created domain, with no dependencies, to exercise inactive restoration.
  const fresh = await aliasCreate(f, { aliasDomain: 'restore.example.com' }); f.aliases.find(row => row.alias_domain === fresh.aliasDomain).active = '0';
  const item = (await f.service.listAliases({})).items.find(row => row.aliasDomain === fresh.aliasDomain);
  const removed = await f.service.removeAlias({ ...ctx, name: item.aliasDomain, data: { etag: item.etag, confirmDomain: item.aliasDomain } });
  assert.equal(removed.warning, '임시 별칭은 되돌려도 돌아오지 않음'); assert.equal((await f.history.detail(removed.auditId)).detail.warning, removed.warning);
  await revert(f, removed.auditId); assert.equal(f.aliases.find(row => row.alias_domain === item.aliasDomain).active, '0');
});

const dkimPreview = f => f.service.dkim({}, name, { toDomains: target });
const duplicate = (f, etag, data = {}) => f.service.duplicate({ ...ctx, data: { fromDomain: name, toDomains: [target], etag, ...data } });
test('DKIM: safe projection includes no private names/values; missing target fields are null; etag excludes private changes', async t => {
  const f = await fixture(t), value = await dkimPreview(f);
  assert.deepEqual(Object.keys(value).sort(), ['domain', 'selector', 'publicKey', 'length', 'etag', 'targets'].sort());
  assert.deepEqual(value.targets, [{ domain: target, selector: null, publicKey: null, length: null }]);
  const serialized = JSON.stringify(value); assert.ok(!/privkey|private_key|SYNTHETIC_PRIVATE_SENTINEL/.test(serialized));
  f.keys[name].privkey = 'OTHER_SYNTHETIC_SECRET'; assert.equal((await dkimPreview(f)).etag, value.etag);
  assert.equal((await f.service.dkim({}, name)).targets, undefined);
  await assert.rejects(f.service.dkim({}, target), { statusCode: 404 });
});
test('DKIM: exact duplicate body, verification, config non-revertible and no private values in disk/logs', async t => {
  const f = await fixture(t), p = await dkimPreview(f), result = await duplicate(f, p.etag);
  assert.deepEqual(writes(f)[0].body, { from_domain: name, to_domain: [target] });
  const record = await f.history.detail(result.auditId); assert.equal(record.kind, 'config'); assert.equal(record.canRevert, false);
  await assert.rejects(revert(f, result.auditId), { statusCode: 409, code: 'NOT_REVERTIBLE' });
  const raw = (await Promise.all((await fs.readdir(f.dir)).map(file => fs.readFile(join(f.dir, file), 'utf8')))).join('') + JSON.stringify(f.logs);
  assert.ok(!/privkey|private_key|SYNTHETIC_PRIVATE_SENTINEL/.test(raw)); assert.equal((await f.service.dkim({}, target)).publicKey, 'PUBLICEXAMPLE=');
});
test('DKIM: existing keys require explicit overwrite; overwrite is irreversible', async t => {
  const f = await fixture(t); f.keys[target] = { ...rawDkim(), pubkey: 'OLDPUBLIC=' }; const p = await dkimPreview(f);
  await assert.rejects(duplicate(f, p.etag), error => error.code === 'DKIM_EXISTS' && error.details.domains[0] === target); assert.equal(writes(f).length, 0);
  const result = await duplicate(f, p.etag, { overwrite: true }); assert.equal((await f.history.detail(result.auditId)).kind, 'irreversible');
});
test('DKIM: target changed after GET invalidates etag; ignored write fails verification', async t => {
  const f = await fixture(t), p = await dkimPreview(f); f.keys[target] = rawDkim();
  await assert.rejects(duplicate(f, p.etag), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 0);
  delete f.keys[target]; f.options.ignoreWrites = true; await assert.rejects(duplicate(f, p.etag), { statusCode: 502, code: 'WRITE_VERIFY_FAILED' });
});
for (const data of [{ toDomains: [] }, { toDomains: [name] }, { overwrite: 'yes' }, { toDomains: ['bad/name'] }]) test(`DKIM: rejects invalid input ${JSON.stringify(data)}`, async t => {
  const f = await fixture(t); await assert.rejects(duplicate(f, (await dkimPreview(f)).etag, data), { statusCode: 422 }); assert.equal(writes(f).length, 0);
});
test('domains: stale concurrent PATCH serializes and only one mutation succeeds', async t => {
  const f = await fixture(t), p = await preview(f), data = { action: 'run', active: false, etag: p.etag, confirmDomain: name };
  const results = await Promise.allSettled([edit(f, data), edit(f, data)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.code, 'CHANGED_ELSEWHERE'); assert.equal(writes(f).length, 1);
});
test('domains: failed audit intent stops mailcow mutation', async t => {
  const f = await fixture(t), p = await preview(f); await fs.rm(f.dir, { recursive: true }); await fs.writeFile(f.dir, 'synthetic-blocker');
  await assert.rejects(edit(f, { action: 'run', active: false, etag: p.etag, confirmDomain: name }), { statusCode: 500, code: 'AUDIT_UNAVAILABLE' }); assert.equal(writes(f).length, 0);
});
test('alias domains: dependency appearing after preview changes etag and blocks deletion', async t => {
  const f = await fixture(t), initial = await aliasCreate(f);
  f.bcc.push({ id: 'late', local_dest: initial.aliasDomain, bcc_dest: 'first@example.com' });
  await assert.rejects(f.service.removeAlias({ ...ctx, name: initial.aliasDomain, data: { etag: initial.etag, confirmDomain: initial.aliasDomain } }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' }); assert.equal(writes(f).length, 1);
});
test('DKIM: malformed upstream public fields cannot carry nested secrets', async t => {
  const f = await fixture(t); f.keys[name].pubkey = { privkey: 'SYNTHETIC_PRIVATE_SENTINEL' };
  await assert.rejects(dkimPreview(f), { statusCode: 502 });
});
test('domains HTTP: registered APIs share guard; safe DKIM/DNS and dependency conflict bodies', async t => {
  const f = await fixture(t), logLines = [];
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: f.dir },
    logger: { level: 'info', stream: { write: line => logLines.push(line) } },
    auth: { client: { ...f.mailcow, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} } } }); t.after(() => app.close());
  const denied = await app.inject('/api/admin/domains'); assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
  const logged = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  const headers = { cookie: logged.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': logged.json().csrf };
  const responses = [];
  for (const url of ['/api/admin/domains', '/api/admin/alias-domains', `/api/admin/dkim/${name}?toDomains=${target}`, '/api/admin/dns?serverIp=192.0.2.10']) {
    const result = await app.inject({ url, headers }); assert.equal(result.statusCode, 200, result.body); assert.equal(result.headers['cache-control'], 'no-store'); responses.push(result.body);
  }
  const previewed = await app.inject({ method: 'PATCH', url: `/api/admin/domains/${name}`, headers, payload: { action: 'preview', active: false } }); assert.equal(previewed.statusCode, 200, previewed.body);
  const noCsrf = await app.inject({ method: 'PATCH', url: `/api/admin/domains/${name}`, headers: { ...headers, 'x-mailadmin-csrf': '' }, payload: { action: 'run', active: false } }); assert.equal(noCsrf.statusCode, 403); assert.equal(noCsrf.headers['www-authenticate'], undefined);
  const item = (await app.domains.listAliases({})).items[0];
  const inUse = await app.inject({ method: 'DELETE', url: `/api/admin/alias-domains/${item.aliasDomain}`, headers, payload: { etag: item.etag, confirmDomain: item.aliasDomain } });
  assert.equal(inUse.statusCode, 409, inUse.body); assert.equal(inUse.json().error.aliases[0].address, 'hello@alias.example.com');
  f.keys[target] = rawDkim(); const p = await app.domains.dkim({}, name, { toDomains: target });
  const exists = await app.inject({ method: 'POST', url: '/api/admin/dkim/duplicate', headers, payload: { fromDomain: name, toDomains: [target], etag: p.etag } });
  assert.equal(exists.statusCode, 409, exists.body); assert.deepEqual(exists.json().error.domains, [target]);
  assert.ok(!/privkey|private_key|SYNTHETIC_PRIVATE_SENTINEL/.test(responses.join('') + logLines.join('')));
  assert.equal((await app.inject('/healthz')).json().ok, true);
});
