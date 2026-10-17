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
  import: ['POST', '/api/rules/import', () => ({ confirm: true, sourceName: 'legacy', sourceSha256: hash(legacy) })],
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
for (const state of ['ok', 'none', 'import_pending', 'import_blocked', 'inactive_other', 'modified_externally', 'damaged']) {
  test(`rules GET ${state} is read-only and preserves active script`, async t => {
    const f = await fixture(t, state); const active = f.server.activeName;
    const response = await f.request('GET', '/api/rules'); status(response, 200);
    const body = response.json(); assert.equal(body.state, state); assert.equal(body.activeScript, active); assert.equal(body.activeName, active);
    assert.equal(response.headers['cache-control'], 'no-store'); assert.deepEqual(mutating(f.server.commands), []);
    if (state === 'none') { assert.equal(body.rev, 0); assert.deepEqual(body.doc.rules, []); assert.equal(body.doc.vacation.subject, '부재중입니다'); }
    if (state === 'import_pending') { assert.equal(body.importReport.sourceName, 'legacy'); assert.equal(body.importReport.sourceSha256, hash(legacy)); }
  });
  for (const [name, [method, url, body]] of Object.entries(actions)) {
    test(`rules ${state} × ${name} follows the approved state table`, async t => {
      const f = await fixture(t, state); const active = f.server.activeName;
      const response = await f.request(method, url, body(state));
      if (allowed[name].includes(state)) status(response, 200);
      else { status(response, 409, 'RULES_STATE'); assert.deepEqual(mutating(f.server.commands), []); assert.equal(f.server.activeName, active); }
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
  status(await f.request('POST', '/api/rules/import', { confirm: true, sourceName: 'legacy', sourceSha256: '0'.repeat(64) }), 409, 'IMPORT_SOURCE_CHANGED');
  assert.deepEqual(mutating(f.server.commands), []);
  const response = await f.request('POST', '/api/rules/import', { confirm: true, sourceName: 'legacy', sourceSha256: hash(legacy) }); status(response, 200);
  assert.equal(f.server.scripts.get('legacy'), legacy); assert.equal(f.server.activeName, web);
  const imported = parseScript(f.server.scripts.get(web)).doc;
  assert.equal(imported.rules.length, 2); assert.deepEqual(imported.importedFrom, { name: 'legacy', sha256: hash(legacy), at: '2026-10-15T00:00:00.000Z' });
  assert.deepEqual(useful(f.server.commands).slice(-5), ['LISTSCRIPTS', 'GETSCRIPT legacy', 'CHECKSCRIPT', `PUTSCRIPT ${web}`, `SETACTIVE ${web}`]);
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
