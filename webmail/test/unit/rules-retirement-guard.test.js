import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRulesService } from '../../server/sieve/service.js';
import { createRetirementStore } from '../../server/security/retirement-store.js';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';
import { generateScript, hashBody } from '../../server/sieve/generate.js';
import { SCRIPT_NAME } from '../../server/sieve/model.js';
import { rulesDocument } from '../../server/sieve/import.js';
import { importName, undoActiveName } from '../../server/sieve/import-store.js';
import { otpConfig, otpEnv, createOtpFixture } from './helpers/otp-fixture.js';
import { AppError } from '../../server/errors.js';

const web = SCRIPT_NAME, prev = `${web}.prev`, target = 'retired@example.test', healthy = 'healthy@example.test', user = 'user@example.test';
const rule = forwards => ({ id: 'rule0001', enabled: true, match: 'all', conditions: [{ field: 'subject', op: 'has', value: 'Synthetic' }], actions: forwards.length ? { forward: forwards } : { read: true }, stop: false });
const doc = (forwards = [], rev = 3) => ({ ...rulesDocument([rule(forwards)]), rev });
const generated = forwards => generateScript(doc(forwards), { internalDomains: ['example.test'], folders: [{ path: 'INBOX' }, { path: 'Archive' }], addresses: [user] });
const rainloopBase = await readFile(new URL('../fixtures/sieve/rainloop-forward.sieve', import.meta.url), 'utf8');
function rainloop(address) {
  return rainloopBase.replace(/BEGIN:HEADER\n([\s\S]*?)END:HEADER/, (_match, base64) => {
    const value = JSON.parse(Buffer.from(base64.replace(/\s/g, ''), 'base64').toString()); value.ActionValue = address;
    return `BEGIN:HEADER\n${Buffer.from(JSON.stringify(value)).toString('base64')}\nEND:HEADER`;
  }).replaceAll('member@example.com', address);
}
const legacy = address => `# GMAIL:SIEVE\nrequire ["copy"];\nif header :contains "Subject" "Synthetic" { redirect :copy "${address}"; }\n`;
const mutations = f => f.events.filter(row => ['PUTSCRIPT', 'SETACTIVE', 'DELETESCRIPT', 'FOLDER'].includes(row.command));
function fixture({ present = true, active = web, current = [], incoming = [healthy], newFolder = false, enabled = true } = {}) {
  const scripts = new Map([...(present ? [[web, generated(current)]] : []), ...(active && active !== web ? [[active, legacy(healthy)]] : [])]);
  const events = [], selects = [], blocked = new Set(), failures = [], folders = [{ path: 'INBOX' }, { path: 'Archive' }];
  const options = {}; let activeName = active, live = 0;
  async function execute(command, name, action) {
    events.push({ command, name });
    const index = failures.findIndex(row => row.command === command && (row.name === undefined || row.name === name));
    if (index >= 0) { const [failure] = failures.splice(index, 1); if (failure.after) action(); failure.effect?.(); throw new AppError(503, 'SIEVE_UNAVAILABLE', 'synthetic'); }
    return action();
  }
  const connect = async () => { live++; return {
    listScripts: () => execute('LISTSCRIPTS', null, () => [...scripts.keys()].map(name => ({ name, active: name === activeName }))),
    getScript: name => execute('GETSCRIPT', name, () => { assert.ok(scripts.has(name), name); return scripts.get(name); }),
    checkScript: () => execute('CHECKSCRIPT', null, () => {}),
    putScript: (name, bytes) => execute('PUTSCRIPT', name, () => scripts.set(name, bytes)),
    setActive: name => execute('SETACTIVE', name, () => { assert.ok(!name || scripts.has(name)); activeName = name || null; }),
    deleteScript: name => execute('DELETESCRIPT', name, () => scripts.delete(name)),
    logout: async () => { live--; }, close() {},
  }; };
  const retirement = {
    async blockedRecipients(values) {
      if (!values.length) return [];
      selects.push([...values]); events.push({ command: 'SELECT' });
      if (options.dbError) throw new AppError(503, 'RETIREMENT_BLOCK_UNAVAILABLE', 'synthetic DB');
      return values.filter(value => blocked.has(value) || blocked.has(value.replace(/\+[^@]+@/, '@')));
    },
    get read() { assert.fail('public must not read retirement metadata'); },
    get write() { assert.fail('public must not write retirement metadata'); },
    get withRoutingLock() { assert.fail('public must not acquire a named lock'); },
  };
  const imap = { withMailbox: async (_session, _path, operation) => { assert.equal(live, 0); return operation({ list: async () => folders.map(row => ({ ...row, flags: new Set() })) }); } };
  const directory = { internalDomains: async () => ['example.test'], identities: async () => ({ identities: [{ address: user }] }) };
  const folderService = { create: async (_session, body) => {
    assert.equal(live, 0); const path = body.parent ? `${body.parent}/${body.name}` : body.name;
    events.push({ command: 'FOLDER', name: path }); folders.push({ path }); await options.onCreate?.(path);
  } };
  const serviceOptions = { config: {}, connect, imap, directory, folderService, now: () => Date.UTC(2026, 10, 10),
    readGmailXml: () => ({ entries: [] }),
    convertGmailEntries: () => {
      const rules = [rule(incoming)];
      if (newFolder) rules[0].actions.move = 'New';
      return { rules, items: rules.map((rule, i) => ({ n: i + 1, status: 'same', rule, changes: [], gmail: { conditions: [], actions: [] } })) };
    },
  };
  const service = createRulesService({ ...serviceOptions, retirement: enabled ? retirement : null });
  const session = { email: user, password: Buffer.from('synthetic-password') };
  const xmlBody = { xml: '<feed/>', fileName: 'synthetic.xml', ...(present ? { mode: 'append' } : {}) };
  const xmlPreview = () => service.previewXml(session, xmlBody);
  const xmlApply = async () => service.importXml(session, { ...xmlBody, confirm: true, expect: (await xmlPreview()).expect });
  return { scripts, events, selects, blocked, failures, folders, options, retirement, connect, imap, directory, folderService, serviceOptions, service, session, xmlPreview, xmlApply,
    get activeName() { return activeName; }, set activeName(value) { activeName = value; } };
}
const expectBlocked = operation => assert.rejects(operation, { statusCode: 409, code: 'RETIREMENT_RECIPIENT_BLOCKED' });

test('public retirement 1: save checks generated source before CHECKSCRIPT or backup; normalized plus target is blocked', async () => {
  const f = fixture(); f.blocked.add(target);
  await expectBlocked(f.service.save(f.session, { baseRev: 3, doc: doc(['RETIRED+tag@EXAMPLE.TEST']) }));
  assert.equal(f.selects.length, 1); assert.deepEqual(f.selects[0], ['retired+tag@example.test']); assert.equal(mutations(f).length, 0); assert.ok(!f.events.some(row => row.command === 'CHECKSCRIPT'));
});

test('public retirement 2: reactivate checks the stored source before SETACTIVE', async () => {
  const f = fixture({ active: 'legacy', current: [target] }); f.blocked.add(target);
  await expectBlocked(f.service.reactivate(f.session)); assert.equal(f.selects.length, 1); assert.equal(mutations(f).length, 0); assert.equal(f.activeName, 'legacy');
});

test('public retirement 3: restore data checks regenerated embedded data rather than altered executable bytes', async () => {
  const f = fixture({ current: [target] }); f.scripts.set(web, f.scripts.get(web) + '\n# external\n'); f.blocked.add(target);
  await expectBlocked(f.service.restore(f.session, { source: 'data' })); assert.equal(f.selects.length, 1); assert.equal(mutations(f).length, 0);
});

test('public retirement 4: restore prev checks its generated restored source before first backup/write', async () => {
  const f = fixture(); f.scripts.set(web, '# damaged'); f.scripts.set(prev, generated([target])); f.blocked.add(target);
  await expectBlocked(f.service.restore(f.session, { source: 'prev' })); assert.equal(f.selects.length, 1); assert.equal(mutations(f).length, 0);
});

test('public retirement 5: active-script import checks the converted source before archiving', async () => {
  const f = fixture({ present: false, active: 'rainloop.user' }); f.scripts.set('rainloop.user', rainloop(target)); f.blocked.add(target);
  const state = await f.service.get(f.session); assert.equal(state.state, 'import_pending');
  const report = state.importReport;
  await expectBlocked(f.service.importRules(f.session, { confirm: true, sourceName: report.sourceName, sourceSha256: report.sourceSha256, planSha256: report.planSha256 }));
  assert.equal(f.selects.length, 1); assert.equal(mutations(f).length, 0);
});

test('public retirement 6: XML import checks once before creating any IMAP folder or archive', async () => {
  const f = fixture({ incoming: [target], newFolder: true }); f.blocked.add(target);
  await f.xmlPreview(); assert.equal(f.selects.length, 0);
  await expectBlocked(f.xmlApply()); assert.equal(f.selects.length, 1); assert.equal(mutations(f).length, 0); assert.ok(!f.folders.some(row => row.path === 'New'));
});

test('public retirement 7: undo checks an existing non-webmail activation source without relying on a restore PUT', async () => {
  const f = fixture({ active: 'legacy' }); f.scripts.set('legacy', legacy(target));
  await f.xmlApply(); const info = await f.service.get(f.session); const count = mutations(f).length, queries = f.selects.length;
  f.blocked.add(target);
  await expectBlocked(f.service.undoImport(f.session, { at: info.importInfo.at }));
  assert.equal(mutations(f).length, count); assert.equal(f.selects.length, queries + 1); assert.equal(f.activeName, web); assert.ok(f.scripts.has(importName));
});

test('public retirement 8: recovery separately checks the prior active source before its first compensating write', async () => {
  const f = fixture({ active: 'legacy' }); f.scripts.set('legacy', legacy(target));
  f.failures.push({ command: 'SETACTIVE', name: web, after: true, effect: () => f.blocked.add(target) });
  await assert.rejects(f.xmlApply(), error => error.statusCode === 502 && error.code === 'IMPORT_WRITE_FAILED' && error.detail.recoveryBlocked === true && error.detail.recoveryCode === 'RETIREMENT_RECIPIENT_BLOCKED' && error.detail.restored === false);
  assert.equal(f.selects.length, 2); const afterFailure = f.events.slice(f.events.findIndex(row => row.command === 'SETACTIVE' && row.name === web) + 1);
  assert.equal(afterFailure.filter(row => ['PUTSCRIPT','SETACTIVE','DELETESCRIPT'].includes(row.command)).length, 0); assert.equal(f.activeName, web); assert.ok(f.scripts.has(importName));
});

test('public retirement: successful XML SELECT precedes folder creation and is not repeated during final plan', async () => {
  const f = fixture({ newFolder: true }); await f.xmlApply(); assert.equal(f.selects.length, 1);
  assert.ok(f.events.findIndex(row => row.command === 'SELECT') < f.events.findIndex(row => row.command === 'FOLDER'));
});

test('public retirement: XML final source target drift fails without a second SELECT or Sieve mutation', async () => {
  const f = fixture({ active: 'legacy', newFolder: true });
  f.options.onCreate = () => f.scripts.set(web, generated([target]));
  await assert.rejects(f.xmlApply(), { statusCode: 409, code: 'IMPORT_PREVIEW_CHANGED' });
  assert.equal(f.selects.length, 1); assert.equal(f.events.filter(row => ['PUTSCRIPT','SETACTIVE','DELETESCRIPT'].includes(row.command)).length, 0);
});

test('public retirement: safe save checks aliases as literal keys; unresolved nonprotected target keeps legacy permission', async () => {
  const f = fixture(); await f.service.save(f.session, { baseRev: 3, doc: doc(['not-created@example.test']) });
  assert.equal(f.selects.length, 1); assert.deepEqual(f.selects[0], ['not-created@example.test']);
});

for (const targetName of ['alias@example.test','retired@alias.test']) test(`public retirement: projected key ${targetName} is checked without admin graph/metadata access`, async () => {
  const f = fixture(); f.blocked.add(targetName);
  await expectBlocked(f.service.save(f.session, { baseRev: 3, doc: doc([targetName]) })); assert.equal(f.selects.length, 1); assert.equal(mutations(f).length, 0);
});

test('public retirement: DB outage stops forwarding before first write; zero-target removal remains allowed', async () => {
  const f = fixture(); f.options.dbError = true;
  await assert.rejects(f.service.save(f.session, { baseRev: 3, doc: doc([healthy]) }), { statusCode: 503, code: 'RETIREMENT_BLOCK_UNAVAILABLE' }); assert.equal(mutations(f).length, 0);
  await f.service.save(f.session, { baseRev: 3, doc: doc([]) }); assert.ok(mutations(f).length > 0); assert.equal(f.selects.length, 1);
});

test('public retirement: zero-target import can deactivate an unsafe legacy script without inspecting archived bytes', async () => {
  const f = fixture({ present: false, active: 'legacy', incoming: [] }); f.scripts.set('legacy', 'include "dynamic";'); f.options.dbError = true;
  const state = await f.service.get(f.session);
  await f.service.importRules(f.session, { confirm: true, sourceName: state.importReport.sourceName, sourceSha256: state.importReport.sourceSha256, planSha256: state.importReport.planSha256, startFresh: true });
  assert.equal(f.selects.length, 0); assert.equal(f.activeName, web); assert.ok(f.scripts.has(undoActiveName));
});

test('public retirement: unsafe non-webmail undo target is refused before all writes and archives remain', async () => {
  const f = fixture({ active: 'legacy' }); f.scripts.set('legacy', 'include "dynamic";'); await f.xmlApply();
  const info = await f.service.get(f.session), count = mutations(f).length;
  await assert.rejects(f.service.undoImport(f.session, { at: info.importInfo.at }), { statusCode: 422, code: 'FILTER_UNINSPECTABLE' }); assert.equal(mutations(f).length, count); assert.ok(f.scripts.has(importName));
});

function publicStore() {
  const queries = []; let closed = 0;
  const store = createRetirementStore({ mode: 'public', db: {
    getConnection: async () => ({ async execute(sql, values) { queries.push({ sql, values }); assert.ok(sql.startsWith('SELECT DISTINCT recipient FROM mailstack_webmail.retirement_recipient_keys WHERE recipient IN (')); return [values.includes(target) ? [{ recipient: target }] : []]; }, release() {}, destroy() {} }),
    async end() { closed++; },
  } });
  return { store, queries, get closed() { return closed; } };
}

test('public retirement: actual public-mode store batches normalized full/base keys in one table SELECT with no lock or metadata API', async () => {
  const f = publicStore();
  assert.deepEqual(Object.keys(f.store).sort(), ['blockedRecipients', 'close']);
  assert.deepEqual(await f.store.blockedRecipients(['RETIRED+tag@EXAMPLE.TEST','alias@example.test','alias@example.test']), [target]);
  assert.equal(f.queries.length, 1); assert.deepEqual(f.queries[0].values, ['alias@example.test','retired+tag@example.test',target]);
  await f.store.blockedRecipients([]); assert.equal(f.queries.length, 1); await f.store.close(); assert.equal(f.closed, 1);
});

for (const enabled of [false, true]) test(`public retirement app wiring: enabled=${enabled} controls key SELECT and store ownership`, async t => {
  const f = fixture(), db = publicStore(), tempRoot = await mkdtemp(join(tmpdir(), 'public-retirement-'));
  const app = await createApp({ logger: false, staticDir: '/nonexistent-retirement-fixture', config: { ...otpConfig, retirementReceiveBlockEnabled: enabled,
    publicHostnames: ['newmail.example.test'], trustProxy: [], sessionIdleMin: 60, sessionMaxHours: 8 }, otp: { store: createOtpFixture().store },
    auth: { tempRoot }, retirement: { store: db.store }, rules: f.serviceOptions });
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  app.imap.withMailbox = f.imap.withMailbox; app.directory.internalDomains = f.directory.internalDomains; app.directory.identities = f.directory.identities;
  const created = app.sessions.create({ email: user, name: 'Synthetic', password: Buffer.from('synthetic-password'), connection: { logout: async () => {} }, ip: '198.51.100.9' });
  const response = await app.inject({ method: 'PUT', url: '/api/rules', headers: { cookie: `webmail_sid=${created.token}`, origin: 'https://newmail.example.test', 'x-webmail-csrf': created.session.csrf }, payload: { baseRev: 3, doc: doc([target]) } });
  assert.equal(response.statusCode, enabled ? 409 : 200, response.body); assert.equal(response.headers['www-authenticate'], undefined);
  assert.equal(db.queries.length, enabled ? 1 : 0); assert.equal(mutations(f).length === 0, enabled);
  await app.close(); assert.equal(db.closed, enabled ? 1 : 0);
});

const publicEnv = { ...otpEnv, PUBLIC_HOSTNAMES: 'newmail.example.test', BRAND_NAME: 'Synthetic', ORG_NAME: '', BRAND_MARK: '', DEFAULT_THEME: 'ink', DEFAULT_MODE: 'light',
  INTERNAL_DOMAINS: 'example.test', ATTACH_MAX_MB: '25', SESSION_IDLE_MIN: '60', SESSION_MAX_HOURS: '8', AUTOEXPUNGE_DAYS: '', IMAP_HOST: 'dovecot-mailcow',
  SIEVE_HOST: 'dovecot-mailcow', SMTP_HOST: 'postfix-mailcow', MAIL_TLS_SERVERNAME: 'mail.example.test', MAIL_TLS_MODE: 'verify', MAIL_TLS_PIN_FILE: '',
  DB_HOST: 'mysql-mailcow', DB_NAME: 'mailcow', DB_USER: 'webmail_ro', DB_PASSWORD: 'synthetic-password', MAILCOW_UI_URL: 'https://nginx-mailcow:8443',
  MAILCOW_UI_SERVERNAME: 'mail.example.test', MAILCOW_PUBLIC_URL: 'https://mailcow.example.test', TRUST_PROXY: '127.0.0.1', LOG_LEVEL: 'silent' };
for (const flag of [undefined, '', 'false', 'true']) test(`public retirement config: strict flag ${JSON.stringify(flag)}`, () => {
  assert.equal(loadConfig({ ...publicEnv, ...(flag === undefined ? {} : { RETIREMENT_RECEIVE_BLOCK_ENABLE: flag }) }).retirementReceiveBlockEnabled, flag === 'true');
});
for (const flag of [true, false, 'TRUE', '1', ' false ']) test(`public retirement config: rejects ${JSON.stringify(flag)}`, () => {
  assert.throws(() => loadConfig({ ...publicEnv, RETIREMENT_RECEIVE_BLOCK_ENABLE: flag }), /RETIREMENT_RECEIVE_BLOCK_ENABLE/);
});

test('public retirement: undo checks regenerated activation bytes when they differ from the archived executable', async () => {
  const f = fixture({ active: 'legacy' }), intended = generated([target]);
  const archived = intended.slice(0, intended.indexOf('# WEBMAIL-HASH ')) + `# WEBMAIL-HASH ${hashBody('keep;\n')}\nkeep;\n`;
  f.scripts.set('legacy', archived); await f.xmlApply();
  const info = await f.service.get(f.session), count = mutations(f).length, queries = f.selects.length;
  assert.equal(f.scripts.get(undoActiveName), archived); assert.ok(!archived.includes(`redirect :copy "${target}"`)); f.blocked.add(target);
  await expectBlocked(f.service.undoImport(f.session, { at: info.importInfo.at }));
  assert.equal(mutations(f).length, count); assert.equal(f.selects.length, queries + 1); assert.equal(f.scripts.get('legacy'), archived); assert.equal(f.activeName, web);
});

test('public retirement: recovery DB failure is explicit and cannot reactivate an unchecked old source', async () => {
  const f = fixture({ active: 'legacy' });
  f.failures.push({ command: 'SETACTIVE', name: web, after: true, effect: () => { f.options.dbError = true; } });
  await assert.rejects(f.xmlApply(), error => error.code === 'IMPORT_WRITE_FAILED' && error.detail.recoveryCode === 'RETIREMENT_BLOCK_UNAVAILABLE' && error.detail.recoveryBlocked === true);
  assert.equal(f.selects.length, 2); assert.equal(f.activeName, web);
  const after = f.events.slice(f.events.findIndex(row => row.command === 'SETACTIVE' && row.name === web) + 1);
  assert.equal(after.filter(row => ['PUTSCRIPT','SETACTIVE','DELETESCRIPT'].includes(row.command)).length, 0);
});

test('public retirement: reactivate checks actual stored executable bytes even when its embedded document is safe', async () => {
  const f = fixture({ active: 'legacy' }), original = f.scripts.get(web), body = original.slice(original.indexOf('require [')) + `\nredirect :copy "${target}";\n`;
  f.scripts.set(web, original.slice(0, original.indexOf('# WEBMAIL-HASH ')) + `# WEBMAIL-HASH ${hashBody(body)}\n${body}`); f.blocked.add(target);
  await expectBlocked(f.service.reactivate(f.session)); assert.equal(f.selects.length, 1); assert.equal(mutations(f).length, 0); assert.equal(f.activeName, 'legacy');
});

for (const path of ['reactivate', 'restore-data', 'restore-prev', 'import', 'import-xml', 'undo']) test(`public retirement: ${path} DB failure refuses before its first mutation`, async () => {
  const f = fixture({ active: path === 'reactivate' || path === 'undo' ? 'legacy' : path === 'import' ? 'rainloop.user' : web, current: [healthy], newFolder: true });
  let operation;
  if (path === 'reactivate') operation = () => f.service.reactivate(f.session);
  if (path === 'restore-data') {
    f.scripts.set(web, f.scripts.get(web) + '\n# external\n');
    operation = () => f.service.restore(f.session, { source: 'data' });
  }
  if (path === 'restore-prev') {
    f.scripts.set(web, '# damaged'); f.scripts.set(prev, generated([healthy]));
    operation = () => f.service.restore(f.session, { source: 'prev' });
  }
  if (path === 'import') {
    f.scripts.delete(web); f.scripts.set('rainloop.user', rainloop(healthy));
    const { importReport: report } = await f.service.get(f.session);
    operation = () => f.service.importRules(f.session, { confirm: true, sourceName: report.sourceName, sourceSha256: report.sourceSha256, planSha256: report.planSha256 });
  }
  if (path === 'import-xml') operation = () => f.xmlApply();
  if (path === 'undo') {
    await f.xmlApply(); const info = await f.service.get(f.session);
    operation = () => f.service.undoImport(f.session, { at: info.importInfo.at });
  }
  const count = mutations(f).length, queries = f.selects.length;
  f.options.dbError = true;
  await assert.rejects(operation(), { statusCode: 503, code: 'RETIREMENT_BLOCK_UNAVAILABLE' });
  assert.equal(mutations(f).length, count); assert.equal(f.selects.length, queries + 1);
});
