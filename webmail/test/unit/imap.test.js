import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setImmediate as immediate } from 'node:timers/promises';
import { ImapFlow } from 'imapflow';
import { createImapPool, mailTlsOptions } from '../../server/mail/imap-pool.js';
import { fetchOriginals, mailboxStatus, getMetadata, setMetadata } from '../../server/mail/imap-raw.js';
import { encodeRef, decodeRef, assertUidValidity, originalRefs } from '../../server/mail/ref.js';
import { createApp } from '../../server/app.js';

const config = { imapHost: '127.0.0.1', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com', mailTlsPinFile: '' };
const credentials = () => ({ email: 'user@example.com', password: Buffer.from('synthetic-imap-password'), ip: '198.51.100.9' });
let certDir, pem, key, otherPem, otherKey;
before(async () => {
  certDir = await mkdtemp(join(tmpdir(), 'webmail-w03-tls-'));
  for (const suffix of ['one', 'two']) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, `${suffix}.key`), '-out', join(certDir, `${suffix}.pem`), '-days', '1', '-subj', '/CN=mail.example.com', '-addext', 'subjectAltName=DNS:mail.example.com'], { stdio: 'ignore' });
  }
  [pem, key, otherPem, otherKey] = await Promise.all(['one.pem', 'one.key', 'two.pem', 'two.key'].map(name => readFile(join(certDir, name))));
});
after(async () => { await rm(certDir, { recursive: true, force: true }); });

async function serverFixture(t, { cert = pem, privateKey = key, rejectLogin = false } = {}) {
  const sockets = new Set();
  const commands = [];
  const server = tls.createServer({ cert, key: privateKey }, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    socket.write('* OK synthetic example.com IMAP\r\n');
    let input = Buffer.alloc(0);
    let literal = null;
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      while (true) {
        if (literal) {
          if (input.length < literal.length + 3) break;
          literal.command.value = input.subarray(0, literal.length).toString('utf8');
          input = input.subarray(literal.length + 3);
          socket.write(`${literal.tag} OK metadata stored\r\n`);
          literal = null;
          continue;
        }
        const end = input.indexOf('\r\n');
        if (end < 0) break;
        const line = input.subarray(0, end).toString('utf8'); input = input.subarray(end + 2);
        const [, tag, verb, rest = ''] = /^(\S+) (\S+)(?: (.*))?$/.exec(line) ?? [];
        if (!tag) continue;
        commands.push({ verb, rest });
        const ok = () => socket.write(`${tag} OK synthetic complete\r\n`);
        switch (verb.toUpperCase()) {
          case 'CAPABILITY': socket.write('* CAPABILITY IMAP4rev1 ID NAMESPACE\r\n'); ok(); break;
          case 'ID': socket.write('* ID ("name" "synthetic" "version" "1")\r\n'); ok(); break;
          case 'LOGIN': if (server.rejectLogin) socket.write(`${tag} NO [AUTHENTICATIONFAILED] synthetic rejection\r\n`); else ok(); break;
          case 'NAMESPACE': socket.write('* NAMESPACE (("" "/")) NIL NIL\r\n'); ok(); break;
          case 'LIST': case 'LSUB': {
            const path = /"([^"]*)"$/.exec(rest)?.[1] || 'INBOX';
            socket.write(`* ${verb} (\\HasNoChildren) "/" "${path}"\r\n`); ok(); break;
          }
          case 'SELECT': case 'EXAMINE': socket.write('* FLAGS (\\Seen)\r\n* 2 EXISTS\r\n* OK [UIDVALIDITY 123] valid\r\n'); ok(); break;
          case 'UID': socket.write('* 1 FETCH (UID 7 X-MAILBOX "INBOX" X-REAL-UID 42)\r\n'); ok(); break;
          case 'STATUS': {
            const box = /^"((?:[^"\\]|\\.)*)"/.exec(rest)?.[1] ?? 'INBOX';
            const values = [];
            if (rest.includes('MESSAGES')) values.push('MESSAGES 2');
            if (rest.includes('SIZE')) values.push('SIZE 4096');
            if (rest.includes('UIDVALIDITY')) values.push('UIDVALIDITY 123');
            socket.write(`* STATUS "${box}" (${values.join(' ')})\r\n`); ok(); break;
          }
          case 'GETMETADATA': {
            const json = '{"theme":"ink"}';
            socket.write(`* METADATA "" ("/private/vendor/mailstack-webmail/prefs" {${Buffer.byteLength(json)}}\r\n${json})\r\n`); ok(); break;
          }
          case 'SETMETADATA': {
            const match = /\{(\d+)(\+)?\}$/.exec(rest);
            if (match) {
              literal = { length: Number(match[1]), tag, command: commands.at(-1) };
              if (!match[2]) socket.write('+ synthetic literal ready\r\n');
            } else ok();
            break;
          }
          case 'LOGOUT': socket.end(`* BYE synthetic logout\r\n${tag} OK logout\r\n`); break;
          default: socket.write(`${tag} BAD unsupported synthetic command\r\n`);
        }
      }
    });
  });
  server.rejectLogin = rejectLogin;
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, commands, server, sockets };
}
function poolFor(configOverrides = {}, extra = {}) {
  return createImapPool({ config: { ...config, ...configOverrides }, destroySession: async session => { session.password.fill(0); await session.connection.logout(); session.connection = null; }, ...extra });
}

class FakeImap extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.usable = false; this.isClosed = false; this.opens = []; this.locks = 0; this.maxLocks = 0; this.tail = Promise.resolve();
  }
  async connect() { this.usable = true; }
  close() { if (this.isClosed) return; this.isClosed = true; this.usable = false; this.emit('close'); }
  async logout() { this.close(); }
  async mailboxOpen(path) { this.mailbox = { path, uidValidity: 123n }; this.opens.push(path); return this.mailbox; }
  async idle() { this.idling = true; return new Promise(() => {}); }
  async getMailboxLock(path, options) {
    this.lockOptions = options;
    const old = this.tail;
    let unlock; this.tail = new Promise(resolve => { unlock = resolve; });
    await old;
    await this.mailboxOpen(path);
    this.locks++; this.maxLocks = Math.max(this.maxLocks, this.locks);
    return { release: () => { this.locks--; unlock(); } };
  }
}
async function fakeFixture(t, configure = () => {}) {
  const clients = [];
  const pool = poolFor({}, { clientFactory: options => { const client = new FakeImap(options); clients.push(client); configure(client, clients.length); return client; } });
  const creds = credentials();
  const verified = await pool.verifyLogin(creds);
  const session = { ...creds, ...verified };
  t.after(async () => { await session.connection?.logout(); session.password.fill(0); });
  return { pool, session, clients };
}
const flush = async () => { for (let i = 0; i < 5; i++) await immediate(); };

test('TLS verify: default trust rejects self-signed server', async t => {
  const server = await serverFixture(t);
  const pool = poolFor({ imapPort: server.port });
  await assert.rejects(pool.verifyLogin(credentials()), error => /SELF_SIGNED|CERT/.test(error.code));
});
test('TLS pin: actual imapflow accepts pinned server, sends IP in ID before LOGIN, reuses login connection', async t => {
  const server = await serverFixture(t);
  const pool = poolFor({ imapPort: server.port, mailTlsMode: 'pin', mailTlsPinFile: join(certDir, 'one.pem') });
  const creds = credentials();
  const verified = await pool.verifyLogin(creds);
  const session = { ...creds, ...verified };
  t.after(() => verified.connection.logout());
  assert.ok(server.commands.find(command => command.verb === 'ID').rest.includes('198.51.100.9'));
  assert.ok(server.commands.find(command => command.verb === 'ID').rest.includes('mailstack-webmail'));
  assert.ok(server.commands.findIndex(command => command.verb === 'ID') < server.commands.findIndex(command => command.verb === 'LOGIN'));
  assert.equal(await pool.withMailbox(session, 'INBOX', client => client.mailbox.path), 'INBOX');
  assert.equal(server.commands.filter(command => command.verb === 'LOGIN').length, 1);
});
test('TLS pin: other certificate with same DNS name fails', async t => {
  const server = await serverFixture(t, { cert: otherPem, privateKey: otherKey });
  await assert.rejects(poolFor({ imapPort: server.port, mailTlsMode: 'pin', mailTlsPinFile: join(certDir, 'one.pem') }).verifyLogin(credentials()));
});
test('TLS pin: correct certificate with wrong server name still fails', async t => {
  const server = await serverFixture(t);
  await assert.rejects(poolFor({ imapPort: server.port, mailTlsServername: 'wrong.example.com', mailTlsMode: 'pin', mailTlsPinFile: join(certDir, 'one.pem') }).verifyLogin(credentials()), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
});
test('raw: real imapflow command path handles original refs, SIZE status and METADATA literal response', async t => {
  const server = await serverFixture(t);
  const client = new ImapFlow({ host: '127.0.0.1', port: server.port, secure: true, tls: mailTlsOptions({ ...config, mailTlsMode: 'pin', mailTlsPinFile: join(certDir, 'one.pem') }), servername: 'mail.example.com', logger: false, disableAutoIdle: true, auth: { user: 'user@example.com', pass: 'synthetic-imap-password' } });
  client.on('error', () => {});
  t.after(() => client.close());
  await client.connect();
  await client.mailboxOpen('WebmailVirtual/AllMail');
  assert.deepEqual(await fetchOriginals(client, '7'), [{ virtualUid: 7, path: 'INBOX', uid: 42 }]);
  assert.deepEqual(await mailboxStatus(client, 'INBOX'), { messages: 2, size: 4096 });
  assert.equal(await getMetadata(client, '', '/private/vendor/mailstack-webmail/prefs'), '{"theme":"ink"}');
  const metadata = '{\n"theme":"olive","signature":"안녕하세요"\n}';
  await setMetadata(client, '', '/private/vendor/mailstack-webmail/prefs', metadata);
  assert.equal(server.commands.find(command => command.verb === 'SETMETADATA').value, metadata);
  await setMetadata(client, '', '/private/vendor/mailstack-webmail/prefs', null);
  assert.ok(server.commands.some(command => command.verb === 'SETMETADATA' && command.rest.includes('NIL')));
});
test('raw: quoted paths use imapflow UTF-7 codec, sequence injection rejected, missing fields fail', async () => {
  const client = { enabled: new Set(), capabilities: new Map(), async exec(command, args, { untagged }) {
    if (command === 'STATUS') {
      assert.ok(!args[0].value.includes('보관'));
      untagged.STATUS({ attributes: [args[0], [{ value: 'MESSAGES' }, { value: '3' }, { value: 'SIZE' }, { value: '4' }]] });
    }
    return { next() {} };
  } };
  assert.deepEqual(await mailboxStatus(client, '보관/견적'), { messages: 3, size: 4 });
  await assert.rejects(fetchOriginals(client, '1\r\nLOGOUT'), { statusCode: 400 });
  await assert.rejects(mailboxStatus(client, 'INBOX', ['INVALID']), { statusCode: 400 });
  client.exec = async (_command, _args, { untagged }) => { untagged.STATUS({ attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '3' }]] }); return { next() {} }; };
  await assert.rejects(mailboxStatus(client, 'INBOX'), { statusCode: 502 });
});
test('ref: UTF-8 and BigInt UIDVALIDITY round trip; malformed and mutated references 400', () => {
  const encoded = encodeRef('보관/견적', 123n, 42);
  assert.deepEqual(decodeRef(encoded), { path: '보관/견적', uidValidity: 123, uid: 42 });
  for (const value of [null, '', encoded + '=', '!', Buffer.from('not-json').toString('base64url'), Buffer.from('["INBOX",0,42]').toString('base64url'), Buffer.from('["INBOX",123,-1]').toString('base64url'), Buffer.from('["INBOX",123,42,0]').toString('base64url'), Buffer.from('["INBOX","123",42]').toString('base64url')]) assert.throws(() => decodeRef(value), { statusCode: 400, code: 'INVALID_REF' });
});
test('ref: stale UIDVALIDITY 409; shared mailbox references remain readable', () => {
  const ref = decodeRef(encodeRef('Shared/team@example.com', 123, 42));
  assert.doesNotThrow(() => assertUidValidity({ mailbox: { path: ref.path, uidValidity: 123n } }, ref));
  assert.throws(() => assertUidValidity({ mailbox: { path: ref.path, uidValidity: 124n } }, ref), { statusCode: 409, code: 'STALE_REF' });
  assert.throws(() => assertUidValidity({ mailbox: { path: 'INBOX', uidValidity: 123n } }, ref), { statusCode: 409 });
});
test('ref: virtual lookup uses original mailbox and caches its UIDVALIDITY per session for 60 seconds', async () => {
  let time = 0, statuses = 0;
  const client = { enabled: new Set(), capabilities: new Map(), async exec(command, _args, { untagged }) {
    if (command === 'UID FETCH') for (const uid of ['7', '8']) untagged.FETCH({ attributes: [{ value: 'FETCH' }, [{ value: 'UID' }, { value: uid }, { value: 'X-MAILBOX' }, { value: 'INBOX' }, { value: 'X-REAL-UID' }, { value: String(Number(uid) + 35) }]] });
    if (command === 'STATUS') { statuses++; untagged.STATUS({ attributes: [{ value: 'INBOX' }, [{ value: 'UIDVALIDITY' }, { value: '123' }]] }); }
    return { next() {} };
  } };
  const session = {};
  const first = await originalRefs(client, session, '7:8', { now: () => time });
  assert.deepEqual(decodeRef(first[0].ref), { path: 'INBOX', uidValidity: 123, uid: 42 });
  assert.equal(statuses, 1);
  time = 59999; await originalRefs(client, session, '7', { now: () => time }); assert.equal(statuses, 1);
  time = 60000; await originalRefs(client, session, '7', { now: () => time }); assert.equal(statuses, 2);
  await originalRefs(client, {}, '7', { now: () => time }); assert.equal(statuses, 3);
});
test('pool: work connection reused and mailbox locks serialize concurrent operations', async t => {
  const f = await fakeFixture(t);
  let active = 0, max = 0;
  await Promise.all(['INBOX', 'Archive', 'Sent'].map(path => f.pool.withMailbox(f.session, path, async client => { active++; max = Math.max(max, active); await immediate(); assert.equal(client.mailbox.path, path); active--; })));
  assert.equal(max, 1); assert.equal(f.clients.length, 1); assert.equal(f.clients[0].maxLocks, 1);
  assert.equal(f.clients[0].options.auth.pass, '');
  assert.equal(f.clients[0].options.clientInfo['x-originating-ip'], f.session.ip);
  assert.equal(f.clients[0].options.tls.rejectUnauthorized, true);
  assert.equal(f.clients[0].options.connectionTimeout, 10000);
  assert.equal(f.clients[0].options.socketTimeout, 60000);
});
test('pool: one reconnect shared by concurrent requests after disconnect', async t => {
  const f = await fakeFixture(t);
  f.clients[0].close();
  await Promise.all([1, 2, 3].map(() => f.pool.withMailbox(f.session, 'INBOX', async () => true)));
  assert.equal(f.clients.length, 2);
  assert.equal(f.clients.filter(client => client.usable).length, 1);
});
test('pool: failed reconnect makes one attempt per request, no hidden retry loop', async t => {
  const f = await fakeFixture(t, (client, index) => { if (index > 1) client.connect = async () => { throw new Error('synthetic disconnect'); }; });
  f.clients[0].close();
  await assert.rejects(f.pool.withMailbox(f.session, 'INBOX', async () => true), { statusCode: 503 });
  assert.equal(f.clients.length, 2);
  await assert.rejects(f.pool.withMailbox(f.session, 'INBOX', async () => true), { statusCode: 503 });
  assert.equal(f.clients.length, 3);
});
test('pool: reauthentication rejection destroys session, wipes password and returns 403', async t => {
  const f = await fakeFixture(t, (client, index) => { if (index > 1) client.connect = async () => { throw Object.assign(new Error('synthetic changed password'), { authenticationFailed: true }); }; });
  f.clients[0].close();
  await assert.rejects(f.pool.withMailbox(f.session, 'INBOX', async () => true), { statusCode: 403, code: 'SESSION_EXPIRED' });
  assert.equal(f.session.connection, null); assert.ok(f.session.password.every(byte => byte === 0));
});
test('pool: watchers share a single INBOX monitor and closing last SSE stops it', async t => {
  const f = await fakeFixture(t);
  const events = [];
  const stopOne = f.pool.watch(f.session, event => events.push(event));
  const stopTwo = f.pool.watch(f.session, () => {});
  await flush();
  assert.equal(f.clients.length, 2); assert.equal(f.clients.filter(client => client.usable).length, 2);
  assert.deepEqual(f.clients[1].opens, ['INBOX']); assert.equal(f.clients[1].idling, true);
  f.clients[1].emit('exists', { count: 2 }); assert.equal(events[0].type, 'exists');
  stopOne(); assert.equal(f.clients[1].usable, true);
  stopTwo(); assert.equal(f.clients[1].usable, false); assert.equal(f.clients[0].usable, true);
});
test('pool: monitor reconnect delays are 5, 10, 30, 60 seconds and stop cancels retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fakeFixture(t, (client, index) => { if (index > 1) client.connect = async () => { throw new Error('synthetic monitor unavailable'); }; });
  const stop = f.pool.watch(f.session, () => {}); await flush(); assert.equal(f.clients.length, 2);
  for (const delay of [5000, 10000, 30000, 60000, 60000]) {
    const count = f.clients.length;
    t.mock.timers.tick(delay - 1); await flush(); assert.equal(f.clients.length, count);
    t.mock.timers.tick(1); await flush(); assert.equal(f.clients.length, count + 1);
    assert.ok(f.clients.filter(client => client.usable).length <= 2);
  }
  stop(); const count = f.clients.length; t.mock.timers.tick(60000); await flush(); assert.equal(f.clients.length, count);
});
test('pool: command timeout closes connection at 60 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fakeFixture(t);
  const operation = f.pool.withMailbox(f.session, 'INBOX', () => new Promise(() => {}));
  const rejected = assert.rejects(operation, { statusCode: 503, code: 'MAIL_UNAVAILABLE' });
  await flush(); t.mock.timers.tick(60000); await rejected;
  assert.equal(f.clients[0].usable, false);
});
test('pool: connection timeout closes pending connection at 10 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let client;
  const pool = poolFor({}, { clientFactory: options => { client = new FakeImap(options); client.connect = () => new Promise(() => {}); return client; } });
  const pending = assert.rejects(pool.verifyLogin(credentials()), { statusCode: 503 });
  await flush(); t.mock.timers.tick(10000); await pending; assert.equal(client.isClosed, true);
});


test('pool: withRef selects original mailbox and rejects stale UIDVALIDITY before operation', async t => {
  const f = await fakeFixture(t);
  const token = encodeRef('Shared/team@example.com', 123, 42);
  const result = await f.pool.withRef(f.session, token, (client, ref) => ({ path: client.mailbox.path, uid: ref.uid }));
  assert.deepEqual(result, { path: 'Shared/team@example.com', uid: 42 });
  let called = false;
  await assert.rejects(f.pool.withRef(f.session, encodeRef('INBOX', 124, 42), () => { called = true; }), { statusCode: 409 });
  assert.equal(called, false);
});
test('pool: monitor reconnects while work remains available and live connections stay at two', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fakeFixture(t);
  const stop = f.pool.watch(f.session, () => {}); await flush();
  f.clients[1].close(); t.mock.timers.tick(5000); await flush();
  assert.equal(f.clients.length, 3); assert.equal(f.clients.filter(client => client.usable).length, 2);
  f.clients[0].close(); await f.pool.withMailbox(f.session, 'INBOX', () => true);
  assert.equal(f.clients.length, 4); assert.equal(f.clients.filter(client => client.usable).length, 2);
  stop(); assert.equal(f.clients.filter(client => client.usable).length, 1);
});
test('pool: monitor authentication rejection also revokes session and closes work connection', async t => {
  const f = await fakeFixture(t, (client, index) => { if (index > 1) client.connect = async () => { throw Object.assign(new Error('synthetic rejection'), { authenticationFailed: true }); }; });
  f.pool.watch(f.session, () => {}); await flush();
  assert.equal(f.session.connection, null); assert.ok(f.session.password.every(byte => byte === 0));
  assert.ok(f.clients.every(client => !client.usable));
});
test('raw: tagged server rejection maps to 502 without exposing server text', async () => {
  const client = { enabled: new Set(), capabilities: new Map(), async exec() { throw Object.assign(new Error('synthetic private response'), { responseStatus: 'NO' }); } };
  await assert.rejects(setMetadata(client, '', '/private/vendor/mailstack-webmail/prefs', '{}'), error => error.statusCode === 502 && !error.message.includes('synthetic private'));
});
test('app: default verifier performs real TLS IMAP login and reconnect rejection destroys actual session', async t => {
  const fixture = await serverFixture(t);
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-w03-app-'));
  const appConfig = {
    ...config, imapPort: fixture.port, mailTlsMode: 'pin', mailTlsPinFile: join(certDir, 'one.pem'),
    publicHostnames: ['newmail.example.com'], trustProxy: ['127.0.0.0/8'], logLevel: 'silent',
    sessionIdleMin: 480, sessionMaxHours: 24, brandName: '메일', orgName: '', brandMark: '', defaultTheme: 'ink', defaultMode: 'system', attachMaxMb: 25, autoexpungeDays: 30,
  };
  const app = await createApp({ config: appConfig, logger: false, auth: { tempRoot } });
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  app.get('/api/test-work', async request => app.imap.withMailbox(request.session, 'INBOX', client => ({ path: client.mailbox.path })));
  const logged = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://newmail.example.com', 'x-forwarded-for': '198.51.100.9' }, payload: { email: 'user@example.com', password: 'synthetic-imap-password' } });
  assert.equal(logged.statusCode, 200, logged.body);
  const cookie = logged.headers['set-cookie'].split(';')[0];
  const session = await app.sessions.get(cookie.split('=')[1]);
  assert.ok(fixture.commands.find(command => command.verb === 'ID').rest.includes('198.51.100.9'));
  assert.equal((await app.inject({ url: '/api/test-work', headers: { cookie } })).statusCode, 200);
  fixture.server.rejectLogin = true;
  for (const socket of fixture.sockets) socket.destroy();
  await flush();
  const rejected = await app.inject({ url: '/api/test-work', headers: { cookie } });
  assert.equal(rejected.statusCode, 403); assert.equal(rejected.json().error.code, 'SESSION_EXPIRED');
  assert.ok(session.password.every(byte => byte === 0));
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode, 403);
});
