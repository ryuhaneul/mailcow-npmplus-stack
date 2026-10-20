import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createApp } from '../../server/app.js';
import { generateScript } from '../../server/sieve/generate.js';
import { parseScript } from '../../server/sieve/parse.js';
import { importScript } from '../../server/sieve/import.js';
import { canonicalJSON } from '../../server/sieve/model.js';
import { rulesServer } from '../fixtures/sieve/rules-server.js';

let temp, certificate, privateKey;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'webmail-w12-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temp, 'server.key'), '-out', join(temp, 'server.pem'), '-days', '1', '-subj', '/CN=mail.example.com', '-addext', 'subjectAltName=DNS:mail.example.com'], { stdio: 'ignore' });
  [certificate, privateKey] = await Promise.all(['server.pem', 'server.key'].map(name => readFile(join(temp, name))));
});
after(async () => { await rm(temp, { recursive: true, force: true }); });
const web = 'webmail-rules', prev = 'webmail-rules.prev';
const hash = value => createHash('sha256').update(value).digest('hex');
const policy = { internalDomains: ['example.com'], folders: ['Archive', 'Projects', 'Projects/Sub', 'Empty'].map(path => ({ path })), addresses: ['user@example.com', 'alias@example.com'] };
const document = (rev = 3) => ({ v: 1, rev, rules: [{ id: 'rule0001', enabled: true, match: 'all', conditions: [{ field: 'subject', op: 'has', value: '회의' }], actions: { move: 'Projects' }, stop: false }], blocked: [], vacation: { enabled: false, start: null, end: null, subject: '', body: '' } });
const legacy = await readFile(new URL('../fixtures/sieve/gmail-basic.sieve', import.meta.url), 'utf8');
const newerDoc = { ...parseScript(await readFile(new URL('../fixtures/sieve/webmail-v2.sieve', import.meta.url), 'utf8')).doc, v: 3 };
const newer = `${MAGIC}\n${Buffer.from(JSON.stringify(newerDoc)).toString('base64url').match(/.{1,120}/g).map(chunk => `# WEBMAIL-DATA ${chunk}\n`).join('')}# WEBMAIL-HASH ${hash('keep;\n')}\nkeep;\n`;
const legacyReport = importScript(legacy, { policy });
const legacyPlanHash = hash(canonicalJSON({ rules: legacyReport.rules.map(({ id, ...rule }) => rule), dropped: [], newFolders: [], mode: 'new' }));
const unknown = '# synthetic example.com\nif true { keep; }\n';
const mutating = commands => commands.filter(row => ['CHECKSCRIPT', 'PUTSCRIPT', 'SETACTIVE'].includes(row.command));
const useful = commands => commands.filter(row => !['STARTTLS', 'AUTHENTICATE', 'LOGOUT'].includes(row.command)).map(row => row.command + (row.name ? ` ${row.name}` : ''));

async function fixture(t, state = 'ok') {
  const good = generateScript(document(), policy), previous = generateScript(document(2), policy);
  const states = {
    ok: { scripts: [[web, good]], activeName: web }, none: {},
    import_pending: { scripts: [['legacy', legacy]], activeName: 'legacy' },
    import_blocked: { scripts: [['legacy', unknown]], activeName: 'legacy' },
    inactive_other: { scripts: [[web, good], ['legacy', unknown]], activeName: 'legacy' },
    modified_externally: { scripts: [[web, `${good}# external\n`]], activeName: web },
    newer_version: { scripts: [[web, newer], [prev, previous]], activeName: web },
    damaged: { scripts: [[web, '# damaged'], [prev, previous]], activeName: web },
  };
  const server = await rulesServer(t, { certificate, privateKey, ...states[state] });
  const tempRoot = await mkdtemp(join(temp, 'session-'));
  const app = await createApp({ config: { publicHostnames: ['newmail.example.com'], trustProxy: [], sessionIdleMin: 480, sessionMaxHours: 24,
    sieveHost: '127.0.0.1', sievePort: server.port, mailTlsMode: 'pin', mailTlsPinFile: join(temp, 'server.pem'), mailTlsServername: 'mail.example.com',
    dbHost: '127.0.0.1', dbName: 'mailcow', dbUser: 'webmail_ro', dbPassword: 'synthetic-db-password', internalDomains: [] }, logger: false,
    staticDir: '/nonexistent-webmail-rules-fixture', auth: { tempRoot }, rules: { now: () => Date.UTC(2026, 9, 15) } });
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  app.directory.internalDomains = async () => policy.internalDomains;
  app.directory.identities = async () => ({ identities: policy.addresses.map(address => ({ address })) });
  const imapCalls = [];
  const client = { enabled: new Set(), capabilities: new Map(), rows: ['INBOX', 'Sent', 'Trash', 'Junk', 'Drafts', ...policy.folders.map(row => row.path)].map(path => ({ path, name: path.split('/').at(-1), flags: new Set(), status: { messages: 0, unseen: 0 } })),
    list: async () => client.rows,
    exec: async (command, args, options) => {
      if (command === 'MYRIGHTS') options.untagged.MYRIGHTS({ attributes: [args[0], { value: 'lrswipkxte' }] });
      if (command === 'STATUS') options.untagged.STATUS({ attributes: [args[0], [{ value: 'MESSAGES' }, { value: '0' }, { value: 'SIZE' }, { value: '0' }]] });
      return { next() {} };
    },
    mailboxRename: async (from, to) => {
      imapCalls.push(['RENAME', from, to]);
      for (const row of client.rows) if (row.path === from || row.path.startsWith(`${from}/`)) { row.path = to + row.path.slice(from.length); row.name = row.path.split('/').at(-1); }
      return true;
    },
    mailboxDelete: async path => { imapCalls.push(['DELETE', path]); client.rows = client.rows.filter(row => row.path !== path); return true; },
  };
  const held = new AsyncLocalStorage(); let tail = Promise.resolve();
  app.imap.withMailbox = (_session, _path, operation) => {
    assert.equal(held.getStore(), undefined, 'no nested IMAP acquisition');
    const result = tail.then(() => held.run(true, () => operation(client))); tail = result.catch(() => {}); return result;
  };
  function login() {
    const created = app.sessions.create({ email: 'user@example.com', name: '합성 사용자', password: Buffer.from('synthetic-sieve-password'), connection: { logout: async () => {} }, ip: '198.51.100.9' });
    return { cookie: `webmail_sid=${created.token}`, origin: 'https://newmail.example.com', 'x-webmail-csrf': created.session.csrf };
  }
  const headers = login();
  const request = (method, url, payload, customHeaders = headers) => app.inject({ method, url, payload, headers: customHeaders });
  return { app, server, good, previous, request, headers, client, imapCalls, login };
}
function status(response, expected, code) {
  assert.equal(response.statusCode, expected, response.body);
  assert.equal(response.headers['www-authenticate'], undefined);
  if (code) assert.equal(response.json().error.code, code);
}
const actions = {
  save: ['PUT', '/api/rules', state => ({ baseRev: state === 'none' ? 0 : 3, doc: document() })],
  reactivate: ['POST', '/api/rules/reactivate', () => undefined],
  data: ['POST', '/api/rules/restore', () => ({ source: 'data' })],
  prev: ['POST', '/api/rules/restore', () => ({ source: 'prev' })],
  import: ['POST', '/api/rules/import', () => ({ confirm: true, sourceName: 'legacy', sourceSha256: hash(legacy), planSha256: legacyPlanHash })],
};
const allowed = { save: ['ok', 'none'], reactivate: ['inactive_other'], data: ['modified_externally'], prev: ['damaged'], import: ['import_pending'] };
for (const previous of ['absent', 'valid', 'damaged']) {
  test(`rules GET exposes previous availability (${previous}) and directory domains`, async t => {
    const f = await fixture(t);
    if (previous !== 'absent') f.server.scripts.set(prev, previous === 'valid' ? f.previous : '# damaged');
    const internalDomains = ['example.com', 'example.net'];
    f.app.directory.internalDomains = async () => internalDomains;
    const response = await f.request('GET', '/api/rules'); status(response, 200);
    assert.equal(response.json().prevAvailable, previous === 'valid');
    assert.deepEqual(response.json().internalDomains, internalDomains);
    assert.deepEqual(mutating(f.server.commands), []);
  });
}
test('rules GET screen fields require a session', async t => {
  const f = await fixture(t);
  const response = await f.request('GET', '/api/rules', undefined, {});
  status(response, 403, 'NO_SESSION');
  assert.equal(response.json().internalDomains, undefined);
  assert.deepEqual(f.server.commands, []);
});
for (const state of ['ok', 'none', 'import_pending', 'import_blocked', 'inactive_other', 'modified_externally', 'damaged', 'newer_version']) {
  test(`rules GET ${state} is read-only and preserves active script`, async t => {
    const f = await fixture(t, state); const active = f.server.activeName;
    const response = await f.request('GET', '/api/rules'); status(response, 200);
    const body = response.json(); assert.equal(body.state, state); assert.equal(body.activeScript, active); assert.equal(body.activeName, active);
    assert.equal(response.headers['cache-control'], 'no-store'); assert.deepEqual(mutating(f.server.commands), []);
    if (state === 'newer_version') { assert.equal(body.prevAvailable, false); assert.equal(body.doc.v, 3); assert.deepEqual(body.missingFolders, []); }
    if (state === 'none') { assert.equal(body.rev, 0); assert.deepEqual(body.doc.rules, []); assert.equal(body.doc.vacation.subject, '부재중입니다'); }
    if (state === 'import_pending') { assert.equal(body.importReport.sourceName, 'legacy'); assert.equal(body.importReport.sourceSha256, hash(legacy)); }
  });
  for (const [name, [method, url, body]] of Object.entries(actions)) {
    test(`rules ${state} × ${name} follows the approved state table`, async t => {
      const f = await fixture(t, state); const active = f.server.activeName;
      const response = await f.request(method, url, body(state));
      if (allowed[name].includes(state)) status(response, 200);
      else { status(response, 409, state === 'import_blocked' && name === 'import' ? 'IMPORT_PREVIEW_CHANGED' : 'RULES_STATE'); assert.deepEqual(mutating(f.server.commands), []); assert.equal(f.server.activeName, active); }
    });
  }
}

test('save order is GETSCRIPT, CHECKSCRIPT, previous PUT, new PUT; rev increments and active stays', async t => {
  const f = await fixture(t); const doc = document(); doc.rules[0].actions.read = true;
  const response = await f.request('PUT', '/api/rules', { baseRev: 3, doc }); status(response, 200); assert.equal(response.json().rev, 4);
  assert.deepEqual(useful(f.server.commands), ['LISTSCRIPTS', `GETSCRIPT ${web}`, 'CHECKSCRIPT', `PUTSCRIPT ${prev}`, `PUTSCRIPT ${web}`]);
  assert.equal(f.server.scripts.get(prev), f.good); assert.equal(parseScript(f.server.scripts.get(web)).doc.rev, 4); assert.equal(f.server.activeName, web);
});

test('first save uses baseRev zero and activates only after writing, without inventing a previous copy', async t => {
  const f = await fixture(t, 'none'); const response = await f.request('PUT', '/api/rules', { baseRev: 0, doc: document(0) }); status(response, 200);
  assert.deepEqual(useful(f.server.commands), ['LISTSCRIPTS', 'CHECKSCRIPT', `PUTSCRIPT ${web}`, `SETACTIVE ${web}`]);
  assert.equal(response.json().rev, 1); assert.equal(f.server.scripts.has(prev), false);
});

test('baseRev conflict and same-account simultaneous sessions cannot overwrite each other', async t => {
  const f = await fixture(t); status(await f.request('PUT', '/api/rules', { baseRev: 2, doc: document() }), 409, 'RULES_CONFLICT');
  assert.deepEqual(mutating(f.server.commands), []);
  const responses = await Promise.all([f.request('PUT', '/api/rules', { baseRev: 3, doc: document() }), f.request('PUT', '/api/rules', { baseRev: 3, doc: document() }, f.login())]);
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]); assert.equal(parseScript(f.server.scripts.get(web)).rev, 4);
});

test('CHECKSCRIPT and either PUT failure stop before the next storage step', async t => {
  for (const rejection of [{ command: 'CHECKSCRIPT' }, { command: 'PUTSCRIPT', name: prev }, { command: 'PUTSCRIPT', name: web }]) {
    const f = await fixture(t); f.server.reject = rejection;
    const response = await f.request('PUT', '/api/rules', { baseRev: 3, doc: document() }); status(response, 502, 'SIEVE_REJECTED');
    assert.equal(f.server.scripts.get(web), f.good); assert.equal(f.server.activeName, web);
    if (rejection.command === 'CHECKSCRIPT') assert.equal(f.server.commands.some(row => row.command === 'PUTSCRIPT'), false);
    if (rejection.name === prev) assert.equal(f.server.commands.some(row => row.command === 'PUTSCRIPT' && row.name === web), false);
  }
});

test('restore prev retains the valid backup, increments its rev, and rejects missing or damaged backups', async t => {
  const f = await fixture(t, 'damaged'); status(await f.request('POST', '/api/rules/restore', { source: 'prev' }), 200);
  assert.equal(f.server.scripts.get(prev), f.previous); assert.equal(parseScript(f.server.scripts.get(web)).rev, 3);
  assert.equal(f.server.commands.some(row => row.command === 'PUTSCRIPT' && row.name === prev), false);
  for (const value of [null, `${f.previous}# edited\n`]) {
    const broken = await fixture(t, 'damaged'); if (value === null) broken.server.scripts.delete(prev); else broken.server.scripts.set(prev, value);
    status(await broken.request('POST', '/api/rules/restore', { source: 'prev' }), 409, 'RULES_STATE'); assert.deepEqual(mutating(broken.server.commands), []);
  }
});

test('restore while another script is active leaves it active, then explicit reactivation switches it', async t => {
  const f = await fixture(t, 'modified_externally'); f.server.scripts.set('legacy', unknown); f.server.activeName = 'legacy';
  status(await f.request('POST', '/api/rules/restore', { source: 'data' }), 200); assert.equal(f.server.activeName, 'legacy');
  assert.equal(f.server.commands.some(row => row.command === 'SETACTIVE'), false);
  const read = await f.request('GET', '/api/rules'); assert.equal(read.json().state, 'inactive_other');
  const activated = await f.request('POST', '/api/rules/reactivate'); status(activated, 200); assert.equal(activated.json().previousActive, 'legacy'); assert.equal(f.server.activeName, web);
  assert.equal(f.server.scripts.get('legacy'), unknown);
});

test('reactivation supports no active script and reports previousActive null', async t => {
  const f = await fixture(t, 'inactive_other'); f.server.activeName = null;
  const response = await f.request('POST', '/api/rules/reactivate'); status(response, 200); assert.equal(response.json().previousActive, null);
});

test('import validates source identity, preserves the original and records import provenance', async t => {
  const f = await fixture(t, 'import_pending');
  status(await f.request('POST', '/api/rules/import', { confirm: true, sourceName: 'legacy', sourceSha256: '0'.repeat(64), planSha256: legacyPlanHash }), 409, 'IMPORT_PREVIEW_CHANGED');
  assert.deepEqual(mutating(f.server.commands), []);
  const response = await f.request('POST', '/api/rules/import', { confirm: true, sourceName: 'legacy', sourceSha256: hash(legacy), planSha256: legacyPlanHash }); status(response, 200);
  assert.equal(f.server.scripts.get('legacy'), legacy); assert.equal(f.server.activeName, web);
  const imported = parseScript(f.server.scripts.get(web)).doc;
  assert.equal(imported.rules.length, 2); assert.deepEqual(imported.importedFrom, { name: 'legacy', sha256: hash(legacy), at: '2026-10-15T00:00:00.000Z' });
  const writes = f.server.commands.filter(row => row.command === 'PUTSCRIPT').map(row => row.name);
  assert.deepEqual(writes, ['webmail-rules.undo-active', 'webmail-rules.import', web]);
  assert.deepEqual(useful(f.server.commands).slice(-3), ['CHECKSCRIPT', `PUTSCRIPT ${web}`, `SETACTIVE ${web}`]);
});

test('external forwarding is 422 with path and reason, before CHECKSCRIPT or writes', async t => {
  const f = await fixture(t); const doc = document(); doc.rules[0].actions = { forward: ['member@outside.example.com'] };
  const response = await f.request('PUT', '/api/rules', { baseRev: 3, doc }); status(response, 422, 'FORWARD_EXTERNAL');
  assert.ok(response.json().error.path.endsWith('forward[0]')); assert.equal(response.json().error.reason, 'external_domain'); assert.deepEqual(mutating(f.server.commands), []);
});

test('vacation and blocking are persisted in the document and generated under the spam guard', async t => {
  const f = await fixture(t); const doc = document(); doc.blocked = ['blocked@example.com', '@spam.example.com'];
  doc.vacation = { enabled: true, start: '2026-10-15', end: null, subject: '부재중', body: '나중에 답변하겠습니다.' };
  status(await f.request('PUT', '/api/rules', { baseRev: 3, doc }), 200);
  const script = f.server.scripts.get(web); assert.deepEqual(parseScript(script).doc.blocked, doc.blocked); assert.deepEqual(parseScript(script).doc.vacation, doc.vacation);
  assert.ok(script.indexOf('X-Spam-Flag') < script.indexOf('blocked@example.com')); assert.ok(script.indexOf('stop;') < script.indexOf('vacation :days 1'));
  assert.ok(script.includes(':addresses ["user@example.com", "alias@example.com"]'));
});

test('session, Origin and CSRF failures are 403 without reaching ManageSieve', async t => {
  const f = await fixture(t);
  status(await f.request('GET', '/api/rules', undefined, {}), 403, 'NO_SESSION');
  status(await f.request('PUT', '/api/rules', { baseRev: 3, doc: document() }, { cookie: f.headers.cookie, origin: f.headers.origin }), 403, 'CSRF');
  status(await f.request('POST', '/api/rules/reactivate', undefined, { ...f.headers, origin: 'https://outside.example.com' }), 403, 'BAD_ORIGIN');
  assert.deepEqual(f.server.commands, []);
});

test('folder rename updates disabled and descendant rule references using the current IMAP client', async t => {
  const f = await fixture(t); const doc = document(); doc.rules.push({ ...structuredClone(doc.rules[0]), id: 'rule0002', enabled: false, actions: { move: 'Projects/Sub' } });
  f.server.scripts.set(web, generateScript(doc, policy));
  const response = await f.request('PATCH', '/api/folders/Projects', { name: 'Renamed' }); status(response, 200);
  const updated = parseScript(f.server.scripts.get(web)).doc; assert.deepEqual(updated.rules.map(rule => rule.actions.move), ['Renamed', 'Renamed/Sub']); assert.equal(updated.rev, 4);
  assert.deepEqual(f.imapCalls, [['RENAME', 'Projects', 'Renamed']]);
});

test('failed rule update rolls the IMAP folder name back and preserves the previous script', async t => {
  const f = await fixture(t); f.server.reject = { command: 'CHECKSCRIPT' };
  status(await f.request('PATCH', '/api/folders/Projects', { name: 'Renamed' }), 502, 'SIEVE_REJECTED');
  assert.deepEqual(f.imapCalls, [['RENAME', 'Projects', 'Renamed'], ['RENAME', 'Renamed', 'Projects']]);
  assert.ok(f.client.rows.some(row => row.path === 'Projects')); assert.equal(f.server.scripts.get(web), f.good);
});

test('none permits folder rename without creating rules; damaged blocks folder deletion', async t => {
  const empty = await fixture(t, 'none'); status(await empty.request('PATCH', '/api/folders/Projects', { name: 'Renamed' }), 200); assert.deepEqual(mutating(empty.server.commands), []);
  const broken = await fixture(t, 'damaged'); status(await broken.request('DELETE', '/api/folders/Empty'), 409, 'RULES_STATE'); assert.deepEqual(broken.imapCalls, []);
});

test('folder use is checked from readable data in ok, inactive and externally modified states', async t => {
  for (const state of ['ok', 'inactive_other', 'modified_externally']) {
    const f = await fixture(t, state); const active = f.server.activeName;
    const response = await f.request('DELETE', '/api/folders/Projects'); status(response, 409, 'FOLDER_IN_RULES');
    assert.deepEqual(response.json().error.rules, ['rule0001']); assert.deepEqual(f.imapCalls, []);
    assert.deepEqual(mutating(f.server.commands), []); assert.equal(f.server.activeName, active);
  }
});

test('without webmail-rules, folder deletion is not blocked by import states', async t => {
  for (const state of ['none', 'import_pending', 'import_blocked']) {
    const f = await fixture(t, state); const active = f.server.activeName;
    status(await f.request('DELETE', '/api/folders/Empty'), 204);
    assert.deepEqual(f.imapCalls, [['DELETE', 'Empty']]); assert.deepEqual(mutating(f.server.commands), []); assert.equal(f.server.activeName, active);
  }
});

async function imapVerification(t, f, failure) {
  const { EventEmitter } = await import('node:events');
  const { createImapPool } = await import('../../server/mail/imap-pool.js');
  const clients = [];
  const pool = createImapPool({ config: { mailTlsMode: 'verify', mailTlsServername: 'mail.example.com' },
    clientFactory: options => {
      const fresh = clients.length > 0;
      const client = Object.assign(new EventEmitter(), f.client, {
        usable: true, checks: 0, acquisitions: 0, logins: 0, logouts: 0,
        async connect() {
          this.logins++;
          assert.equal(options.auth.user, 'user@example.com');
          assert.equal(options.auth.pass, 'synthetic-sieve-password');
          if (fresh && failure) throw failure;
        },
        close() { this.usable = false; },
        async logout() { this.logouts++; this.close(); },
        async noop() { this.checks++; }, // An old authenticated connection survives a password change.
        async getMailboxLock() {
          this.acquisitions++;
          const previous = this.tail ?? Promise.resolve();
          let release; this.tail = new Promise(resolve => { release = resolve; });
          await previous;
          return { release };
        },
      });
      clients.push(client);
      return client;
    }, destroySession: (session, code) => f.app.sessions.destroy(session, code) });
  const session = await f.app.sessions.get(f.headers.cookie.split('=')[1]);
  session.connection = (await pool.verifyLogin(session)).connection;
  f.app.imap.withMailbox = pool.withMailbox;
  f.app.imap.verifySessionLogin = pool.verifySessionLogin;
  return { client: clients[0], clients, session };
}

for (const mode of ['valid', 'rejected', 'unavailable', 'normal']) {
  test(`ManageSieve AUTHENTICATE NO rechecks session credentials with one fresh IMAP login (${mode})`, async t => {
    const f = await fixture(t, 'none');
    const failure = mode === 'rejected' ? Object.assign(new Error('synthetic IMAP rejection'), { authenticationFailed: true })
      : mode === 'unavailable' ? new Error('synthetic connection error') : null;
    const { client, clients, session } = await imapVerification(t, f, failure);
    if (mode === 'rejected') { await client.noop(); assert.equal(client.usable, true); }
    if (mode !== 'normal') f.server.reject = { command: 'AUTHENTICATE' };
    const response = await f.request('GET', '/api/rules');
    status(response, mode === 'normal' ? 200 : mode === 'valid' ? 409 : mode === 'rejected' ? 403 : 503,
      mode === 'normal' ? undefined : mode === 'valid' ? 'SIEVE_DISABLED' : mode === 'rejected' ? 'SESSION_EXPIRED' : 'MAIL_UNAVAILABLE');
    assert.equal(client.checks, mode === 'rejected' ? 1 : 0);
    assert.equal(clients.length, mode === 'normal' ? 1 : 2);
    if (mode !== 'normal') {
      assert.equal(clients[1].logins, 1);
      assert.equal(clients[1].usable, false);
      assert.equal(clients[1].logouts, mode === 'valid' ? 1 : 0);
    }
    assert.equal(f.server.commands.filter(row => row.command === 'AUTHENTICATE').length, 1);
    if (mode === 'valid') assert.equal(response.json().error.message, '이 계정은 메일 필터 기능이 꺼져 있어요. 관리자에게 켜 달라고 요청해 주세요.');
    status(await f.request('GET', '/api/auth/session'), mode === 'rejected' ? 403 : 200);
    assert.equal(session.connection === null, mode === 'rejected');
    assert.equal(session.password.every(byte => byte === 0), mode === 'rejected');
  });
}

test('Sieve rejection in a folder operation rechecks credentials without reacquiring its IMAP lock', async t => {
  const f = await fixture(t);
  const { client, clients } = await imapVerification(t, f);
  f.server.reject = { command: 'AUTHENTICATE' };
  status(await f.request('PATCH', '/api/folders/Projects', { name: 'Renamed' }), 409, 'SIEVE_DISABLED');
  assert.equal(client.checks, 0); assert.equal(client.acquisitions, 1);
  assert.equal(clients.length, 2); assert.equal(clients[1].logouts, 1);
  assert.deepEqual(f.imapCalls, []);
  status(await f.request('GET', '/api/auth/session'), 200);
});

test('overlapping rules and folder requests release Sieve before IMAP verification without deadlock', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const { client, clients } = await imapVerification(t, f);
  let connecting, release;
  const entered = new Promise(resolve => { connecting = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { createRulesService } = await import('../../server/sieve/service.js');
  const rejected = Object.assign(new Error('synthetic Sieve AUTHENTICATE NO'), { authenticationFailed: true });
  let connections = 0;
  const service = createRulesService({ config: {}, imap: f.app.imap, directory: f.app.directory,
    connect: async () => { if (++connections === 1) { connecting(); await gate; } throw rejected; } });
  const session = await f.app.sessions.get(f.headers.cookie.split('=')[1]);
  const rules = service.get(session);
  await entered;
  let held;
  const folderHeld = new Promise(resolve => { held = resolve; });
  const folder = f.app.imap.withMailbox(session, 'INBOX', current => { held(); return service.getState(session, current); });
  await folderHeld;
  release();
  const results = await Promise.allSettled([rules, folder]);
  assert.deepEqual(results.map(row => [row.status, row.reason.statusCode, row.reason.code]), [['rejected', 409, 'SIEVE_DISABLED'], ['rejected', 409, 'SIEVE_DISABLED']]);
  assert.equal(client.checks, 0); assert.equal(connections, 2);
  assert.equal(clients.length, 3);
  assert.ok(clients.slice(1).every(value => value.logins === 1 && value.logouts === 1 && !value.usable));
});

// Service-layer harness: the XML lane owns parsing/conversion. These stubs use
// its agreed contract and all storage assertions inspect the actual fake bytes.
import { createRulesService } from '../../server/sieve/service.js';
import { importName, undoWebmailName, undoActiveName, encodeImportRecord, parseImportRecord } from '../../server/sieve/import-store.js';
import { hashBody, MAGIC } from '../../server/sieve/generate.js';
import { AppError } from '../../server/errors.js';

function importFixture({ present = true, active = web, incoming = 2, dropped = 1, newFolders = [], folderFailure, sourceItems, transformRule = rule => rule } = {}) {
  const original = present ? generateScript(document(), policy) : null;
  const scripts = new Map([...(present ? [[web, original]] : []), ...(active && active !== web ? [[active, unknown]] : [])]);
  let activeName = active, liveConnections = 0;
  const commands = [], failures = [], folders = [...policy.folders];
  let onCreate;
  const exec = async (command, name, operation, script) => {
    commands.push({ command, name, ...(script === undefined ? {} : { script }) });
    const failure = failures.find(row => row.command === command && (row.name === undefined || row.name === name));
    if (failure?.skip) failure.skip--;
    else if (failure) {
      failures.splice(failures.indexOf(failure), 1);
      if (failure.after) operation();
      failure.effect?.();
      throw new Error('synthetic storage failure');
    }
    return operation();
  };
  const connect = async () => {
    liveConnections++;
    return {
      listScripts: () => exec('LISTSCRIPTS', undefined, () => [...scripts.keys()].map(name => ({ name, active: activeName === name }))),
      getScript: name => exec('GETSCRIPT', name, () => { assert.ok(scripts.has(name), `missing ${name}`); return scripts.get(name); }),
      putScript: (name, script) => exec('PUTSCRIPT', name, () => { scripts.set(name, script); }, script),
      checkScript: script => exec('CHECKSCRIPT', undefined, () => {}, script),
      setActive: name => exec('SETACTIVE', name, () => { assert.ok(!name || scripts.has(name)); activeName = name || null; }),
      deleteScript: name => exec('DELETESCRIPT', name, () => { assert.notEqual(activeName, name, 'cannot delete active script'); scripts.delete(name); }),
      logout: async () => { liveConnections--; }, close() {},
    };
  };
  const session = { email: 'user@example.com', password: Buffer.from('synthetic-password') };
  const service = createRulesService({ config: {}, connect, now: () => Date.UTC(2026, 9, 20),
    imap: { withMailbox: async (_session, _path, operation) => { assert.equal(liveConnections, 0, 'IMAP work precedes Sieve lock'); return operation({ list: async () => folders }); } },
    directory: { internalDomains: async () => policy.internalDomains, identities: async () => ({ identities: [{ address: 'user@example.com' }] }) },
    readGmailXml: xml => { assert.equal(xml, '<feed/>'); return { entries: [] }; },
    convertGmailEntries: (_entries, context) => {
      assert.equal(context.stage, 2);
      const rules = Array.from({ length: incoming }, (_, i) => ({ ...structuredClone(document().rules[0]), id: `new${String(i).padStart(5, '0')}`, ...(newFolders[i] ? { actions: { move: newFolders[i] } } : {}) })).map(transformRule);
      return { rules, items: sourceItems ?? [...rules.map((rule, i) => ({ n: i + 1, gmail: { conditions: [], actions: [] }, status: 'same', rule, changes: [] })),
        ...Array.from({ length: dropped }, (_, i) => ({ n: incoming + i + 1, gmail: { conditions: [], actions: [] }, status: 'no', changes: [], reason: '합성 미지원 조건' }))],
        newFolders: newFolders.filter(path => !context.folders.some(folder => folder.path === path)) };
    },
    folderService: { create: async (_session, body) => {
      assert.equal(liveConnections, 0, 'folder creation must not hold Sieve lock');
      const path = body.parent ? `${body.parent}/${body.name}` : body.name;
      if (folderFailure === path) throw new Error('synthetic folder failure');
      if (folders.some(folder => folder.path === path)) throw new AppError(409, 'EXISTS', 'synthetic race');
      folders.push({ path });
      await onCreate?.(path);
      return { folder: { path } };
    } },
  });
  const body = { xml: '<feed/>', fileName: 'synthetic.xml', ...(present ? { mode: 'append' } : {}) };
  const preview = () => service.previewXml(session, body);
  const apply = async () => service.importXml(session, { ...body, confirm: true, expect: (await preview()).expect });
  return { service, session, scripts, original, commands, failures, folders, preview, apply, body,
    get activeName() { return activeName; }, set activeName(value) { activeName = value; }, set onCreate(value) { onCreate = value; } };
}
const storageWrites = commands => commands.filter(row => ['CHECKSCRIPT', 'PUTSCRIPT', 'SETACTIVE', 'DELETESCRIPT'].includes(row.command));
const undoBody = async f => ({ at: (await f.service.get(f.session)).importInfo.at });

for (const [present, active] of [[true, web], [true, 'legacy'], [true, null], [false, 'legacy'], [false, null]]) {
  test(`XML import/undo preserves original bytes and active choice: present=${present}, active=${active}`, async () => {
    const f = importFixture({ present, active });
    const before = new Map(f.scripts);
    const preview = await f.preview();
    assert.equal(preview.plan.mode, present ? 'append' : 'new');
    assert.equal(preview.plan.applied, 2); assert.equal(preview.plan.total, present ? 3 : 2);
    assert.deepEqual(preview.counts, { same: 2, changed: 0, no: 1 });
    const result = await f.apply(); assert.equal(result.applied, 2); assert.equal(result.dropped, 1);
    assert.equal(f.activeName, web);
    const archive = parseImportRecord(f.scripts.get(importName));
    assert.equal(archive.undo.afterSha256, hash(f.scripts.get(web)));
    if (present) assert.equal(f.scripts.get(undoWebmailName), f.original);
    if (active && active !== web) assert.equal(f.scripts.get(undoActiveName), unknown);
    const writes = storageWrites(f.commands);
    const primaryIndex = writes.findIndex(row => row.command === 'PUTSCRIPT' && row.name === web);
    const archiveIndex = writes.findIndex(row => row.command === 'PUTSCRIPT' && row.name === importName);
    assert.ok(archiveIndex >= 0 && archiveIndex < primaryIndex);
    const imported = parseScript(f.scripts.get(web)).doc;
    assert.equal(new Set(imported.rules.map(rule => rule.id)).size, imported.rules.length);
    const info = (await f.service.get(f.session)).importInfo;
    assert.deepEqual(info.undo, { available: true, edited: false });
    const restored = await f.service.undoImport(f.session, { at: info.at });
    assert.equal(restored.restored, present ? 'webmail' : 'none');
    assert.equal(f.scripts.get(web) ?? null, f.original); assert.equal(f.activeName, active);
    for (const [name, script] of before) assert.equal(f.scripts.get(name), script);
    assert.ok(!f.scripts.has(importName) && !f.scripts.has(undoWebmailName) && !f.scripts.has(undoActiveName));
    assert.equal((await f.service.get(f.session)).importInfo, undefined);
  });
}

for (const key of ['xmlSha256', 'mode', 'rev', 'activeName', 'activeSha256', 'planSha256']) {
  test(`XML expect.${key} mismatch refuses every Sieve write`, async () => {
    const f = importFixture();
    const expect = (await f.preview()).expect;
    expect[key] = key === 'mode' ? 'replace' : key === 'rev' ? 99 : key === 'activeName' ? 'different' : '0'.repeat(64);
    await assert.rejects(f.service.importXml(f.session, { ...f.body, confirm: true, expect }), { code: 'IMPORT_PREVIEW_CHANGED', statusCode: 409 });
    assert.deepEqual(storageWrites(f.commands), []);
  });
}

test('XML import refuses zero convertible rules before every write and folder create', async () => {
  const f = importFixture({ incoming: 0 });
  const preview = await f.preview(); assert.equal(preview.plan.applied, 0);
  await assert.rejects(f.apply(), { statusCode: 409, code: 'IMPORT_NOTHING' });
  assert.deepEqual(storageWrites(f.commands), []);
});

test('replace keeps blocking/vacation; edits to either require explicit undo confirmation', async () => {
  for (const change of ['blocked', 'vacation', 'rules']) {
    const f = importFixture();
    const beforeDoc = document(); beforeDoc.blocked = ['before@example.com'];
    beforeDoc.vacation = { enabled: true, start: null, end: null, subject: '합성 부재중', body: '합성 본문' };
    const original = generateScript(beforeDoc, policy); f.scripts.set(web, original); f.body.mode = 'replace';
    await f.apply();
    const imported = parseScript(f.scripts.get(web)).doc;
    assert.equal(imported.rules.length, 2); assert.deepEqual(imported.blocked, beforeDoc.blocked); assert.deepEqual(imported.vacation, beforeDoc.vacation);
    if (change === 'blocked') imported.blocked.push('after@example.com');
    else if (change === 'vacation') imported.vacation.subject = '합성 수정';
    else imported.rules[0].actions.star = true;
    f.scripts.set(web, generateScript(imported, policy));
    const info = (await f.service.get(f.session)).importInfo;
    assert.deepEqual(info.undo, { available: true, edited: true });
    const body = { at: info.at }; const writes = storageWrites(f.commands).length;
    await assert.rejects(f.service.undoImport(f.session, body), { code: 'UNDO_EDITED' });
    assert.equal(storageWrites(f.commands).length, writes);
    await f.service.undoImport(f.session, { ...body, acceptEdits: true });
    assert.equal(f.scripts.get(web), original);
  }
});

test('undo rejects a changed original script and recreates a deleted original from its exact copy', async () => {
  const f = importFixture({ active: 'legacy' }); await f.apply();
  const body = await undoBody(f), imported = f.scripts.get(web);
  f.scripts.set('legacy', '# external change\n');
  await assert.rejects(f.service.undoImport(f.session, body), { code: 'UNDO_SOURCE_CHANGED' });
  assert.equal(f.scripts.get(web), imported);
  f.scripts.delete('legacy');
  await f.service.undoImport(f.session, body);
  assert.equal(f.scripts.get('legacy'), unknown); assert.equal(f.activeName, 'legacy');
});

test('a subsequent import replaces the undo target and the old at cannot undo it', async () => {
  const f = importFixture(); await f.apply();
  const firstBody = await undoBody(f), firstScript = f.scripts.get(web);
  assert.equal((await f.preview()).plan.replacesUndo, true);
  await f.apply(); const secondBody = await undoBody(f);
  assert.notEqual(firstBody.at, secondBody.at);
  await assert.rejects(f.service.undoImport(f.session, firstBody), { code: 'UNDO_UNAVAILABLE' });
  await f.service.undoImport(f.session, secondBody); assert.equal(f.scripts.get(web), firstScript);
});

for (const stage of [
  { command: 'PUTSCRIPT', name: undoWebmailName, archived: false },
  { command: 'PUTSCRIPT', name: undoActiveName, archived: false },
  { command: 'PUTSCRIPT', name: importName, archived: false },
  { command: 'CHECKSCRIPT', archived: true },
  { command: 'PUTSCRIPT', name: prev, archived: true },
  { command: 'PUTSCRIPT', name: web, archived: true },
  { command: 'SETACTIVE', name: web, archived: true },
]) {
  for (const after of [false, true]) {
    test(`import failure injection ${stage.command} ${stage.name ?? ''}, appliedBeforeError=${after}`, async () => {
      const f = importFixture({ active: 'legacy' });
      f.failures.push({ ...stage, after });
      await assert.rejects(f.apply(), error => {
        assert.equal(error.code, 'IMPORT_WRITE_FAILED'); assert.equal(error.statusCode, 502);
        assert.equal(error.detail.restored, stage.archived);
        assert.equal(error.message.includes('그대로'), stage.archived);
        return true;
      });
      assert.equal(f.scripts.get(web), f.original); assert.equal(f.activeName, 'legacy'); assert.equal(f.scripts.get('legacy'), unknown);
      const info = (await f.service.get(f.session)).importInfo;
      assert.equal(info?.undo.available ?? false, false);
      if (stage.archived) {
        assert.equal(f.scripts.get(undoWebmailName), f.original);
        assert.equal(f.scripts.get(undoActiveName), unknown);
        assert.equal(parseImportRecord(f.scripts.get(importName)).undo.webmail.sha256, hash(f.original));
      }
    });
  }
}

test('uncertain failed rollback reports restored:false and retains usable copies for undo', async () => {
  const f = importFixture({ active: 'legacy' });
  f.failures.push({ command: 'SETACTIVE', name: web, after: true }, { command: 'PUTSCRIPT', name: web, skip: 1 });
  await assert.rejects(f.apply(), error => error.code === 'IMPORT_WRITE_FAILED' && error.detail.restored === false && !error.message.includes('그대로'));
  assert.notEqual(f.scripts.get(web), f.original); assert.equal(f.activeName, web);
  assert.equal((await f.service.get(f.session)).importInfo.undo.available, true);
  await f.service.undoImport(f.session, await undoBody(f));
  assert.equal(f.scripts.get(web), f.original); assert.equal(f.activeName, 'legacy');
});

for (const stage of [
  { command: 'PUTSCRIPT', name: web }, { command: 'SETACTIVE', name: 'legacy' },
  { command: 'DELETESCRIPT', name: undoWebmailName }, { command: 'DELETESCRIPT', name: undoActiveName }, { command: 'DELETESCRIPT', name: importName },
]) {
  test(`undo retry completes after ${stage.command} ${stage.name} failure without acceptEdits`, async () => {
    const f = importFixture({ active: 'legacy' }); await f.apply(); const body = await undoBody(f);
    f.failures.push(stage);
    await assert.rejects(f.service.undoImport(f.session, body), { code: 'IMPORT_WRITE_FAILED' });
    assert.ok(f.scripts.has(importName));
    await f.service.undoImport(f.session, body);
    assert.equal(f.scripts.get(web), f.original); assert.equal(f.activeName, 'legacy'); assert.equal(f.scripts.has(importName), false);
  });
}

test('undo retry handles no prior webmail after active switch and deletion errors', async () => {
  for (const stage of [{ command: 'SETACTIVE', name: '' }, { command: 'DELETESCRIPT', name: web }]) {
    const f = importFixture({ present: false, active: null }); await f.apply(); const body = await undoBody(f);
    f.failures.push(stage); await assert.rejects(f.service.undoImport(f.session, body), { code: 'IMPORT_WRITE_FAILED' });
    await f.service.undoImport(f.session, body); assert.equal(f.activeName, null); assert.equal(f.scripts.has(web), false);
  }
});

test('XML folder creation fails before Sieve writes and returns the folders already created', async () => {
  const f = importFixture({ newFolders: ['NewOne', 'NewTwo'], folderFailure: 'NewTwo' });
  await assert.rejects(f.apply(), error => error.code === 'FOLDER_CREATE_FAILED' && error.detail.folder === 'NewTwo' && JSON.stringify(error.detail.created) === '["NewOne"]');
  assert.deepEqual(storageWrites(f.commands), []); assert.ok(f.folders.some(folder => folder.path === 'NewOne'));
});

test('XML folder creation happens outside the Sieve lock and undo leaves the new folders', async () => {
  const f = importFixture({ newFolders: ['NewOne', 'NewTwo'] });
  const result = await f.apply(); assert.deepEqual(result.createdFolders, ['NewOne', 'NewTwo']);
  assert.deepEqual(parseScript(f.scripts.get(web)).doc.rules.slice(1).map(rule => rule.actions.move), ['NewOne', 'NewTwo']);
  await f.service.undoImport(f.session, await undoBody(f));
  assert.ok(f.folders.some(folder => folder.path === 'NewOne')); assert.ok(f.folders.some(folder => folder.path === 'NewTwo'));
});

test('a concurrent save during folder creation changes the plan and prevents Sieve writes', async () => {
  const f = importFixture({ newFolders: ['NewOne'] });
  f.onCreate = () => { f.scripts.set(web, generateScript(document(4), policy)); };
  await assert.rejects(f.apply(), { code: 'IMPORT_PREVIEW_CHANGED' });
  assert.deepEqual(storageWrites(f.commands), []);
});

test('future-version get is read-only and suppresses prev/undo; save, restore and undo refuse it', async () => {
  const f = importFixture(); await f.apply(); const body = await undoBody(f);
  const future = { ...document(), v: 3 };
  const executable = 'require ["fileinto"];\n';
  const data = Buffer.from(JSON.stringify(future)).toString('base64url').match(/.{1,120}/g).map(chunk => `# WEBMAIL-DATA ${chunk}`).join('\n');
  f.scripts.set(web, `${MAGIC}\n${data}\n# WEBMAIL-HASH ${hashBody(executable)}\n${executable}`);
  const get = await f.service.get(f.session); assert.equal(get.state, 'newer_version'); assert.equal(get.prevAvailable, false); assert.equal(get.importInfo.undo.available, false);
  const count = storageWrites(f.commands).length;
  await assert.rejects(f.service.save(f.session, { baseRev: 3, doc: document() }), { code: 'RULES_STATE' });
  await assert.rejects(f.service.restore(f.session, { source: 'prev' }), { code: 'RULES_STATE' });
  await assert.rejects(f.service.undoImport(f.session, body), { code: 'RULES_STATE' });
  assert.equal(storageWrites(f.commands).length, count);
});

test('import record bounds dropped text/bytes and rejects malformed metadata without exposure', () => {
  const f = importFixture();
  const items = Array.from({ length: 1000 }, (_, n) => ({ n: n + 1, status: 'no', summary: '가'.repeat(500), reason: '나'.repeat(200) }));
  return import('../../server/sieve/import-store.js').then(({ importRecord }) => {
    const record = importRecord({ at: '2026-10-20T00:00:00Z', source: { kind: 'gmail-xml', name: 'synthetic.xml', sha256: hash('<feed/>') }, mode: 'append', items, webmailScript: f.original, activeName: web, activeScript: f.original, afterScript: '# synthetic\n' });
    assert.ok(Buffer.byteLength(JSON.stringify(record.dropped)) <= 256 * 1024);
    assert.ok(record.droppedTruncated > 0); assert.equal(record.dropped.length + record.droppedTruncated, 1000);
    assert.equal([...record.dropped[0].summary].length, 300); assert.equal([...record.dropped[0].reason].length, 120);
    const encoded = encodeImportRecord(record); assert.deepEqual(parseImportRecord(encoded), record);
    assert.equal(parseImportRecord(`${encoded}discard;\n`), null); assert.equal(parseImportRecord('# arbitrary\n'), null);
  });
});

test('nested Gmail label creates absent parents first and keeps them after undo', async () => {
  const f = importFixture({ newFolders: ['Parent/Child'], incoming: 1 });
  assert.deepEqual((await f.preview()).plan.newFolders, ['Parent', 'Parent/Child']);
  assert.deepEqual((await f.apply()).createdFolders, ['Parent', 'Parent/Child']);
  await f.service.undoImport(f.session, await undoBody(f));
  assert.ok(f.folders.some(folder => folder.path === 'Parent')); assert.ok(f.folders.some(folder => folder.path === 'Parent/Child'));
});

test('new-folder limit counts parents and omits trailing rules in the preview and apply', async () => {
  const f = importFixture({ present: false, active: null, incoming: 51,
    newFolders: Array.from({ length: 51 }, (_, n) => `Parent${n}/Child`) });
  const preview = await f.preview();
  assert.equal(preview.plan.applied, 50); assert.equal(preview.plan.newFolders.length, 100);
  assert.equal(preview.items[50].status, 'no'); assert.equal(preview.items[50].reason, '새 폴더 100개 한도');
  const result = await f.apply(); assert.equal(result.applied, 50); assert.equal(result.createdFolders.length, 100);
});

test('active-server import accepts mixed convertible items and uses the shared archive/undo engine', async () => {
  const f = importFixture({ present: false, active: 'legacy' });
  const mixed = await readFile(new URL('../fixtures/sieve/gmail-mixed.sieve', import.meta.url), 'utf8');
  f.scripts.set('legacy', mixed);
  const state = await f.service.get(f.session);
  assert.equal(state.state, 'import_pending'); assert.equal(state.importReport.rules.length, 2);
  assert.ok(state.importReport.items.some(item => item.status === 'unconvertible'));
  const result = await f.service.importRules(f.session, { confirm: true, sourceName: 'legacy', sourceSha256: state.importReport.sourceSha256, planSha256: state.importReport.planSha256 });
  assert.equal(result.applied, 2); assert.equal(result.dropped, 2); assert.equal(result.deactivated, 'legacy');
  const imported = parseScript(f.scripts.get(web));
  assert.equal(imported.state, 'ok'); assert.equal(imported.doc.v, 2);
  assert.deepEqual(imported.doc.rules.map(({ id, ...rule }) => rule), state.importReport.rules.map(({ id, ...rule }) => rule));
  assert.equal(f.scripts.get('legacy'), mixed); assert.equal(f.scripts.get(undoActiveName), mixed);
  await f.service.undoImport(f.session, await undoBody(f));
  assert.equal(f.activeName, 'legacy'); assert.equal(f.scripts.has(web), false); assert.equal(f.scripts.get('legacy'), mixed);
});

test('active-server import with zero rules is IMPORT_NOTHING and changed plan is write-free', async () => {
  const f = importFixture({ present: false, active: 'legacy' });
  const state = await f.service.get(f.session);
  const body = { confirm: true, sourceName: 'legacy', sourceSha256: state.importReport.sourceSha256, planSha256: state.importReport.planSha256 };
  await assert.rejects(f.service.importRules(f.session, body), { code: 'IMPORT_NOTHING' });
  await assert.rejects(f.service.importRules(f.session, { ...body, planSha256: '0'.repeat(64) }), { code: 'IMPORT_PREVIEW_CHANGED' });
  assert.deepEqual(storageWrites(f.commands), []);
});

for (const active of [null, 'legacy']) {
  for (const stage of [{ command: 'PUTSCRIPT', name: web }, { command: 'SETACTIVE', name: web }]) {
    for (const after of [false, true]) {
      test(`first import failure restores absence, active=${active}, ${stage.command}, appliedBeforeError=${after}`, async () => {
        const f = importFixture({ present: false, active }); f.failures.push({ ...stage, after });
        await assert.rejects(f.apply(), error => error.code === 'IMPORT_WRITE_FAILED' && error.detail.restored === true);
        assert.equal(f.scripts.has(web), false); assert.equal(f.activeName, active);
        assert.equal((await f.service.get(f.session)).importInfo.undo.available, false);
      });
    }
  }
}

test('missing or quota-incomplete copies never advertise undo availability', async () => {
  const f = importFixture({ active: 'legacy' }); await f.apply();
  f.scripts.delete(undoActiveName);
  assert.equal((await f.service.get(f.session)).importInfo.undo.available, false);
  // An explicit retry can still finish while the original itself exists.
  await f.service.undoImport(f.session, await undoBody(f));
  assert.equal(f.activeName, 'legacy');
  const missing = importFixture({ active: 'legacy' }); await missing.apply();
  const body = await undoBody(missing);
  missing.scripts.delete(undoActiveName); missing.scripts.delete('legacy');
  await assert.rejects(missing.service.undoImport(missing.session, body), { code: 'UNDO_UNAVAILABLE' });
  const g = importFixture({ active: 'legacy' }); await g.apply();
  g.scripts.delete(undoWebmailName);
  assert.equal((await g.service.get(g.session)).importInfo.undo.available, false);
  await assert.rejects(g.service.undoImport(g.session, await undoBody(g)), { code: 'UNDO_UNAVAILABLE' });
});

test('preview bounds the actual document including preserved blocking and vacation before folders or writes', async () => {
  const f = importFixture({ incoming: 100, transformRule: rule => ({ ...rule,
    conditions: Array.from({ length: 10 }, () => ({ field: 'subject', op: 'has', value: 's'.repeat(200) })) }) });
  const doc = document(); doc.blocked = Array.from({ length: 500 }, () => `${'b'.repeat(64)}@example.com`);
  doc.vacation.subject = 's'.repeat(400000);
  f.scripts.set(web, generateScript(doc, policy)); f.body.mode = 'replace';
  const preview = await f.preview();
  assert.ok(preview.plan.applied > 0 && preview.plan.applied < 100);
  assert.equal(preview.items[preview.plan.applied].reason, '반영 안 됨 — 한도 초과');
  assert.deepEqual(storageWrites(f.commands), []); assert.deepEqual(preview.plan.newFolders, []);
  const result = await f.apply(); assert.equal(result.applied, preview.plan.applied);
  const applied = f.scripts.get(web); assert.ok(Buffer.byteLength(applied) <= 1024 * 1024);
  assert.deepEqual(parseScript(applied).doc.blocked, doc.blocked); assert.equal(parseScript(applied).doc.vacation.subject, doc.vacation.subject);
});

test('recovery cannot claim unchanged filters if the original active script changed during failure', async () => {
  const f = importFixture({ active: 'legacy' });
  f.failures.push({ command: 'SETACTIVE', name: web, effect: () => f.scripts.set('legacy', '# external during failure\n') });
  await assert.rejects(f.apply(), error => error.code === 'IMPORT_WRITE_FAILED' && error.detail.restored === false && !error.message.includes('그대로'));
  assert.equal(f.scripts.get('legacy'), '# external during failure\n'); assert.equal(f.scripts.get(undoActiveName), unknown);
});

test('dropped XML records retain the Gmail condition/action summary for later review', async () => {
  const f = importFixture({ incoming: 1, sourceItems: [
    { n: 1, status: 'same', gmail: { conditions: [], actions: [] }, changes: [] },
    { n: 2, status: 'no', gmail: { conditions: [['hasTheWord', 'synthetic body']], actions: [['label', 'SyntheticLabel']] }, reason: '본문 검색 불가', changes: [] },
  ] });
  await f.apply();
  const dropped = (await f.service.get(f.session)).importInfo.dropped;
  assert.deepEqual(dropped, [{ n: 2, summary: 'hasTheWord=synthetic body · label=SyntheticLabel', reason: '본문 검색 불가' }]);
});

test('active-server preview includes provenance bytes in its final 1MB budget', async () => {
  const name = 'synthetic-'.repeat(5000);
  const f = importFixture({ present: false, active: name });
  const path = 'A'.repeat(400000); f.folders.push({ path });
  const basic = await readFile(new URL('../fixtures/sieve/gmail-basic.sieve', import.meta.url), 'utf8');
  f.scripts.set(name, basic.replace('fileinto :create :copy "Archive";', `fileinto :create :copy "${path}";`));
  const state = await f.service.get(f.session);
  assert.equal(state.state, 'import_blocked'); assert.equal(state.importReport.rules.length, 0);
  assert.ok(state.importReport.items.every(item => item.status === 'unconvertible' && item.reason === '반영 안 됨 — 한도 초과'));
  await assert.rejects(f.service.importRules(f.session, { confirm: true, sourceName: name, sourceSha256: state.importReport.sourceSha256, planSha256: state.importReport.planSha256 }), { code: 'IMPORT_NOTHING' });
  assert.deepEqual(storageWrites(f.commands), []);
});

test('quota failure while replacing an earlier archive never advertises mismatched copies as usable undo', async () => {
  const f = importFixture({ active: 'legacy' }); await f.apply();
  const previousRecord = f.scripts.get(importName);
  const doc = parseScript(f.scripts.get(web)).doc; doc.blocked.push('edited@example.com');
  await f.service.save(f.session, { baseRev: doc.rev, doc });
  const currentBytes = f.scripts.get(web), start = f.commands.length;
  f.failures.push({ command: 'PUTSCRIPT', name: importName });
  await assert.rejects(f.apply(), { code: 'IMPORT_WRITE_FAILED' });
  assert.equal(f.scripts.get(web), currentBytes); assert.equal(f.scripts.get(importName), previousRecord);
  assert.equal((await f.service.get(f.session)).importInfo.undo.available, false);
  assert.ok(!storageWrites(f.commands.slice(start)).some(row => row.name === web || row.command === 'SETACTIVE'));
});

for (const after of [false, true]) {
  test(`undo retries original-script recreation PUTSCRIPT, appliedBeforeError=${after}`, async () => {
    const f = importFixture({ active: 'legacy' }); await f.apply(); const body = await undoBody(f);
    f.scripts.delete('legacy'); f.failures.push({ command: 'PUTSCRIPT', name: 'legacy', after });
    await assert.rejects(f.service.undoImport(f.session, body), { code: 'IMPORT_WRITE_FAILED' });
    assert.ok(f.scripts.has(importName));
    await f.service.undoImport(f.session, body);
    assert.equal(f.scripts.get('legacy'), unknown); assert.equal(f.scripts.get(web), f.original); assert.equal(f.activeName, 'legacy');
  });
}

test('rollback SETACTIVE failure reports uncertainty even when webmail bytes were recovered', async () => {
  const f = importFixture({ active: 'legacy' });
  f.failures.push({ command: 'SETACTIVE', name: web, after: true }, { command: 'SETACTIVE', name: 'legacy' });
  await assert.rejects(f.apply(), error => error.code === 'IMPORT_WRITE_FAILED' && error.detail.restored === false && !error.message.includes('그대로'));
  assert.equal(f.scripts.get(web), f.original); assert.equal(f.activeName, web);
  await f.service.undoImport(f.session, await undoBody(f));
  assert.equal(f.activeName, 'legacy'); assert.equal(f.scripts.has(importName), false);
});

test('rollback verifies archive metadata as well as primary bytes and active selection', async () => {
  const f = importFixture({ active: 'legacy' });
  f.failures.push({ command: 'SETACTIVE', name: web, after: true, effect: () => f.scripts.set(importName, '# synthetic corrupted record\n') });
  await assert.rejects(f.apply(), error => error.code === 'IMPORT_WRITE_FAILED' && error.detail.restored === false && !error.message.includes('그대로'));
  assert.equal(f.scripts.get(web), f.original); assert.equal(f.activeName, 'legacy');
  assert.equal((await f.service.get(f.session)).importInfo, undefined);
});


for (const feature of ['group', 'matches']) {
  test(`v2 ${feature} document stays editable through save and restore`, async () => {
    const f = importFixture();
    const doc = document(); doc.v = 2;
    doc.rules[0].conditions = feature === 'matches'
      ? [{ field: 'from', op: 'matches', value: '*@example.com' }]
      : [{ field: 'subject', op: 'has', value: 'notice' }, { match: 'any', conditions: [
        { field: 'from', op: 'has', value: 'notice@example.com' },
        { field: 'subject', op: 'has', value: 'news' },
      ] }];
    const original = generateScript(doc, policy);
    f.scripts.set(web, original);
    const state = await f.service.get(f.session);
    assert.equal(state.state, 'ok'); assert.deepEqual(state.doc, doc);
    const edited = structuredClone(state.doc); edited.blocked = ['blocked@example.com'];
    await f.service.save(f.session, { baseRev: state.rev, doc: edited });
    const saved = parseScript(f.scripts.get(web));
    assert.equal(saved.state, 'ok'); assert.equal(saved.doc.v, 2);
    assert.deepEqual(saved.doc.rules, doc.rules); assert.deepEqual(saved.doc.blocked, edited.blocked);
    assert.equal(f.scripts.get(prev), original);
    f.scripts.set(web, '# damaged');
    await f.service.restore(f.session, { source: 'prev' });
    const restoredPrevious = await f.service.get(f.session);
    assert.equal(restoredPrevious.state, 'ok'); assert.equal(restoredPrevious.doc.v, 2);
    assert.deepEqual(restoredPrevious.doc.rules, doc.rules); assert.deepEqual(restoredPrevious.doc.blocked, []);
    f.scripts.set(web, `${f.scripts.get(web)}# external\n`);
    await f.service.restore(f.session, { source: 'data' });
    const restoredData = await f.service.get(f.session);
    assert.equal(restoredData.state, 'ok'); assert.equal(restoredData.doc.v, 2);
    assert.deepEqual(restoredData.doc.rules, doc.rules); assert.deepEqual(restoredData.doc.blocked, []);
  });
}
