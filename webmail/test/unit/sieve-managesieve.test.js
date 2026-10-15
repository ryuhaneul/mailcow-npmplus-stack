import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectManageSieve } from '../../server/sieve/managesieve.js';
import { MAX_SCRIPT_BYTES } from '../../server/sieve/model.js';

let certDir, certificate, privateKey, otherCertificate, otherPrivateKey;
before(async () => {
  certDir = await mkdtemp(join(tmpdir(), 'webmail-w11-tls-'));
  for (const name of ['server', 'other']) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, `${name}.key`), '-out', join(certDir, `${name}.pem`), '-days', '1', '-subj', '/CN=mail.example.com', '-addext', 'subjectAltName=DNS:mail.example.com'], { stdio: 'ignore' });
  }
  [certificate, privateKey, otherCertificate, otherPrivateKey] = await Promise.all(['server.pem', 'server.key', 'other.pem', 'other.key'].map(name => readFile(join(certDir, name))));
});
after(async () => { await rm(certDir, { recursive: true, force: true }); });
const credentials = () => ({ email: 'user@example.com', password: Buffer.from('synthetic-example-password') });
const q = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

async function fixture(t, options = {}) {
  const sockets = new Set();
  const commands = [];
  const scripts = new Map(options.scripts ?? []);
  const encryptedWrites = [];
  let activeName = options.activeName ?? null;
  let authenticated = false;
  const context = tls.createSecureContext({ cert: options.otherCert ? otherCertificate : certificate, key: options.otherCert ? otherPrivateKey : privateKey });
  const server = net.createServer(plain => {
    sockets.add(plain);
    plain.on('error', () => {});
    let socket = plain;
    let incoming = Buffer.alloc(0);
    function send(value) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      encryptedWrites.push(Boolean(socket.encrypted));
      if (options.fragment) {
        // A write per byte exercises UTF-8/literal boundaries, including CRLF.
        for (const byte of bytes) socket.write(Buffer.from([byte]));
      } else socket.write(bytes);
    }
    function capabilities(secure) {
      send(`"IMPLEMENTATION" "synthetic example.com"\r\n"SASL" "${secure && options.noPlain ? 'LOGIN' : 'PLAIN'}"\r\n"SIEVE" "${secure ? 'fileinto imap4flags variables copy vacation date relational' : 'untrusted-before-tls'}"\r\n${secure || options.noStarttls ? '' : '"STARTTLS"\r\n'}OK "ready"\r\n`);
    }
    function command(line, literal) {
      const verb = line.split(' ')[0].toUpperCase();
      const record = { command: verb, encrypted: Boolean(socket.encrypted) };
      commands.push(record);
      if (verb === 'STARTTLS') {
        if (options.rejectStarttls) { send('NO "TLS unavailable"\r\n'); return; }
        socket.off('data', consume);
        socket.write('OK "TLS now"\r\n', () => {
          socket = new tls.TLSSocket(plain, { isServer: true, secureContext: context });
          sockets.add(socket);
          socket.on('error', () => {});
          socket.on('data', consume);
          socket.once('secure', () => { if (!options.silentSecureGreeting) capabilities(true); });
        });
        return;
      }
      if (verb === 'AUTHENTICATE') {
        const encoded = /^AUTHENTICATE "PLAIN" "([A-Za-z0-9+/=]+)"$/.exec(line)?.[1];
        const auth = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
        record.validCredentials = auth === '\0user@example.com\0synthetic-example-password';
        if (options.rejectAuth) send('NO "synthetic-example-password user@example.com"\r\n');
        else { authenticated = record.validCredentials; send('OK\r\n'); }
        return;
      }
      assert.ok(authenticated, 'script commands require authentication');
      if (options.onCommand?.({ verb, send, socket, scripts })) return;
      const match = /^\w+ "((?:[^"\\]|\\["\\])*)"/.exec(line);
      const name = match?.[1].replace(/\\(["\\])/g, '$1');
      record.name = name;
      if (literal) { record.literalBytes = literal.length; record.script = literal.toString('utf8'); }
      switch (verb) {
        case 'LISTSCRIPTS':
          for (const scriptName of scripts.keys()) {
            if (options.literalNames) send(`{${Buffer.byteLength(scriptName)}}\r\n${scriptName}${scriptName === activeName ? ' ACTIVE' : ''}\r\n`);
            else send(`${q(scriptName)}${scriptName === activeName ? ' ACTIVE' : ''}\r\n`);
          }
          send('OK\r\n'); break;
        case 'GETSCRIPT': {
          if (!scripts.has(name)) { send('NO (NONEXISTENT) "script absent"\r\n'); break; }
          const script = scripts.get(name);
          send(options.quotedScript ? `${q(script)}\r\nOK\r\n` : Buffer.concat([Buffer.from(`{${Buffer.byteLength(script)}}\r\n`), Buffer.from(script), Buffer.from('\r\nOK\r\n')]));
          break;
        }
        case 'CHECKSCRIPT': send(options.rejectCheck ? 'NO (WARNINGS) "invalid synthetic script"\r\n' : 'OK\r\n'); break;
        case 'PUTSCRIPT': scripts.set(name, literal.toString('utf8')); send('OK\r\n'); break;
        case 'SETACTIVE': activeName = name || null; send('OK\r\n'); break;
        case 'DELETESCRIPT': scripts.delete(name); send('OK\r\n'); break;
        case 'LOGOUT': send('OK\r\n'); socket.end(); break;
        default: assert.fail(`unexpected command ${verb}`);
      }
    }
    function consume(chunk) {
      incoming = Buffer.concat([incoming, chunk]);
      for (;;) {
        const end = incoming.indexOf('\r\n');
        if (end < 0) return;
        const line = incoming.subarray(0, end).toString('utf8');
        const length = Number(/\{(\d+)\+\}$/.exec(line)?.[1]);
        if (Number.isFinite(length)) {
          if (incoming.length < end + 2 + length + 2) return;
          const literal = incoming.subarray(end + 2, end + 2 + length);
          assert.equal(incoming.subarray(end + 2 + length, end + 2 + length + 2).toString(), '\r\n');
          incoming = incoming.subarray(end + 2 + length + 2);
          command(line, literal);
        } else {
          incoming = incoming.subarray(end + 2);
          command(line);
        }
      }
    }
    plain.on('data', consume);
    if (!options.silentGreeting) capabilities(false);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const config = { sieveHost: '127.0.0.1', sievePort: server.address().port, mailTlsMode: 'pin', mailTlsPinFile: join(certDir, 'server.pem'), mailTlsServername: 'mail.example.com' };
  return { config, commands, scripts, encryptedWrites, activeName: () => activeName };
}

test('nine commands use verified STARTTLS, current capabilities and UTF-8 byte literals', async t => {
  const fake = await fixture(t);
  const creds = credentials(); const original = Buffer.from(creds.password);
  const client = await connectManageSieve(fake.config, creds);
  t.after(() => client.close());
  assert.equal(client.capabilities.SIEVE, 'fileinto imap4flags variables copy vacation date relational');
  assert.equal(Object.hasOwn(client.capabilities, 'STARTTLS'), false);
  assert.deepEqual(await client.listScripts(), []);
  const source = '# 한글 😀\r\nrequire ["fileinto"];\nfileinto "Archive";\n';
  await client.checkScript(source);
  const name = '규칙 "팀" \\';
  await client.putScript(name, source);
  assert.equal(await client.getScript(name), source);
  await client.setActive(name);
  assert.deepEqual(await client.listScripts(), [{ name, active: true }]);
  await client.setActive('');
  assert.equal(fake.activeName(), null);
  await client.deleteScript(name);
  await client.logout();
  assert.deepEqual([...new Set(fake.commands.map(c => c.command))].sort(), ['AUTHENTICATE', 'CHECKSCRIPT', 'DELETESCRIPT', 'GETSCRIPT', 'LISTSCRIPTS', 'LOGOUT', 'PUTSCRIPT', 'SETACTIVE', 'STARTTLS']);
  assert.equal(fake.commands[0].encrypted, false);
  assert.ok(fake.commands.slice(1).every(c => c.encrypted));
  assert.ok(fake.commands.find(c => c.command === 'AUTHENTICATE').validCredentials);
  assert.equal(fake.commands.find(c => c.command === 'PUTSCRIPT').literalBytes, Buffer.byteLength(source));
  assert.deepEqual(creds.password, original);
  assert.equal(Object.hasOwn(client, 'password'), false);
});

test('fragmented records preserve literal script data including status-looking lines', async t => {
  const source = 'OK\r\nNO (NONEXISTENT) "data"\r\n한글 😀\r\n';
  const fake = await fixture(t, { fragment: true, literalNames: true, scripts: [['팀 규칙', source]], activeName: '팀 규칙' });
  const client = await connectManageSieve(fake.config, credentials()); t.after(() => client.close());
  assert.deepEqual(await client.listScripts(), [{ name: '팀 규칙', active: true }]);
  assert.equal(await client.getScript('팀 규칙'), source);
  await client.logout();
});

test('quoted strings and zero length literals are accepted as script data', async t => {
  const fake = await fixture(t, { scripts: [['quoted', 'OK'], ['empty', '']], quotedScript: true });
  const client = await connectManageSieve(fake.config, credentials()); t.after(() => client.close());
  assert.equal(await client.getScript('quoted'), 'OK');
  assert.equal(await client.getScript('empty'), '');
  await client.logout();
  const literalFake = await fixture(t, { scripts: [['empty', '']] });
  const literalClient = await connectManageSieve(literalFake.config, credentials()); t.after(() => literalClient.close());
  assert.equal(await literalClient.getScript('empty'), '');
  await literalClient.logout();
});

test('NO errors are sanitized and a rejected command does not desynchronize the next command', async t => {
  const fake = await fixture(t, { rejectCheck: true });
  const client = await connectManageSieve(fake.config, credentials()); t.after(() => client.close());
  await assert.rejects(client.checkScript('synthetic secret body'), error => {
    assert.equal(error.statusCode, 502); assert.equal(error.code, 'SIEVE_REJECTED');
    assert.equal(error.command, 'CHECKSCRIPT'); assert.equal(error.responseCode, 'WARNINGS');
    assert.equal(JSON.stringify(error).includes('synthetic secret body'), false);
    return true;
  });
  await assert.rejects(client.getScript('absent'), { code: 'SIEVE_REJECTED', responseCode: 'NONEXISTENT' });
  assert.deepEqual(await client.listScripts(), []);
  assert.equal(fake.commands.some(c => c.command === 'PUTSCRIPT'), false);
  await client.logout();
});

test('simultaneous callers serialize commands and pair each response with its caller', async t => {
  let pending = 0; let maxPending = 0;
  const fake = await fixture(t, { onCommand: ({ verb, send }) => {
    if (verb !== 'LISTSCRIPTS') return false;
    maxPending = Math.max(maxPending, ++pending);
    setImmediate(() => { pending--; send('"example"\r\nOK\r\n'); });
    return true;
  } });
  const client = await connectManageSieve(fake.config, credentials()); t.after(() => client.close());
  const results = await Promise.all(Array.from({ length: 5 }, () => client.listScripts()));
  assert.ok(results.every(result => result[0].name === 'example'));
  assert.equal(maxPending, 1);
  await client.logout();
});

test('authentication rejection returns 403 and never exposes credentials or server text', async t => {
  const fake = await fixture(t, { rejectAuth: true });
  await assert.rejects(connectManageSieve(fake.config, credentials()), error => {
    assert.equal(error.statusCode, 403); assert.equal(error.code, 'SESSION_EXPIRED'); assert.equal(error.authenticationFailed, true);
    assert.equal(JSON.stringify(error).includes('synthetic-example-password'), false);
    assert.equal(error.message.includes('user@example.com'), false);
    return true;
  });
});

for (const [label, options, configChange] of [
  ['missing STARTTLS', { noStarttls: true }, {}],
  ['rejected STARTTLS', { rejectStarttls: true }, {}],
  ['untrusted certificate in verify mode', {}, { mailTlsMode: 'verify' }],
  ['changed pinned certificate', { otherCert: true }, {}],
  ['wrong certificate name', {}, { mailTlsServername: 'wrong.example.com' }],
  ['no PLAIN after TLS', { noPlain: true }, {}],
]) {
  test(`${label} prevents sending credentials`, async t => {
    const fake = await fixture(t, options);
    await assert.rejects(connectManageSieve({ ...fake.config, ...configChange }, credentials()));
    assert.equal(fake.commands.some(c => c.command === 'AUTHENTICATE'), false);
  });
}

test('connect deadline closes a server that never greets', async t => {
  const fake = await fixture(t, { silentGreeting: true });
  await assert.rejects(connectManageSieve(fake.config, credentials(), { connectTimeoutMs: 30 }), { code: 'SIEVE_UNAVAILABLE', statusCode: 503 });
  assert.deepEqual(fake.commands, []);
});

test('connect deadline also covers the greeting after STARTTLS', async t => {
  const fake = await fixture(t, { silentSecureGreeting: true });
  await assert.rejects(connectManageSieve(fake.config, credentials(), { connectTimeoutMs: 100 }), { code: 'SIEVE_UNAVAILABLE' });
  assert.equal(fake.commands.some(c => c.command === 'AUTHENTICATE'), false);
});

test('command timeout closes the connection and rejects queued callers', async t => {
  const fake = await fixture(t, { onCommand: ({ verb }) => verb === 'LISTSCRIPTS' });
  const client = await connectManageSieve(fake.config, credentials(), { commandTimeoutMs: 30 }); t.after(() => client.close());
  const results = await Promise.allSettled([client.listScripts(), client.listScripts()]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'SIEVE_UNAVAILABLE'));
  assert.equal(fake.commands.filter(c => c.command === 'LISTSCRIPTS').length, 1);
});

test('BYE and truncated literals fail without exposing response data', async t => {
  for (const response of ['BYE (TRYLATER) "synthetic private response"\r\n', '{100}\r\nshort']) {
    const fake = await fixture(t, { onCommand: ({ send, socket }) => { send(response); socket.end(); return true; } });
    const client = await connectManageSieve(fake.config, credentials()); t.after(() => client.close());
    await assert.rejects(client.getScript('example'), error => error.code === 'SIEVE_UNAVAILABLE' && !error.message.includes('private'));
  }
});

test('malformed, invalid UTF-8, oversized literals and unexpected result shapes fail safely', async t => {
  for (const response of ['{99999999999}\r\n', '"unterminated\r\n', '{3+}\r\nabc\r\nOK\r\n', '"a" "b" "c"\r\nOK\r\n', Buffer.from([0xff, 13, 10])]) {
    const fake = await fixture(t, { onCommand: ({ send }) => { send(response); return true; } });
    const client = await connectManageSieve(fake.config, credentials()); t.after(() => client.close());
    await assert.rejects(client.listScripts(), { code: 'SIEVE_PROTOCOL', statusCode: 502 });
  }
});

test('argument injection and oversized upload are rejected before any command is sent', async t => {
  const fake = await fixture(t);
  const client = await connectManageSieve(fake.config, credentials()); t.after(() => client.close());
  const before = fake.commands.length;
  for (const name of ['x\r\nLOGOUT', 'x\0', '\ud800', '']) assert.throws(() => client.getScript(name), { code: 'RULES_INVALID' });
  await assert.rejects(client.putScript('example', 'x'.repeat(MAX_SCRIPT_BYTES + 1)), { code: 'RULES_INVALID', statusCode: 422 });
  await assert.rejects(client.checkScript('\ud800'), { code: 'RULES_INVALID' });
  assert.equal(fake.commands.length, before);
  await client.logout();
});

test('explicit close rejects further operations without reconnecting', async t => {
  const fake = await fixture(t);
  const client = await connectManageSieve(fake.config, credentials());
  client.close(); client.close();
  await assert.rejects(client.listScripts(), { code: 'SIEVE_UNAVAILABLE' });
});
