import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, rm, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { SMTPServer } from 'smtp-server';
import { JSDOM } from 'jsdom';
import { createApp } from '../../server/app.js';
import { createDirectoryService } from '../../server/directory/index.js';
import { createComposeService } from '../../server/mail/compose.js';
import { createSmtpService } from '../../server/mail/smtp.js';
import { sanitizeComposeHtml } from '../../server/mail/sanitize.js';
import { encodeRef, decodeRef } from '../../server/mail/ref.js';
import { installAuth } from '../../server/routes/auth.js';
import composeRoutes from '../../server/routes/compose.js';
import { installErrors } from '../../server/errors.js';
import { logOptions } from '../../server/log.js';

const password = 'synthetic-compose-password';
const config = { publicHostnames: ['newmail.example.com'], sessionIdleMin: 1, sessionMaxHours: 1, attachMaxMb: 1, trustProxy: [], smtpHost: '127.0.0.1', smtpPort: 587, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com', mailTlsPinFile: '', internalDomains: [] };
const original = encodeRef('INBOX', 123, 9), draft = encodeRef('Drafts', 123, 10);
let tlsDir, cert, key, otherCert, otherKey;
before(async () => {
  tlsDir = await mkdtemp(join(tmpdir(), 'webmail-w09-tls-'));
  for (const suffix of ['one', 'two']) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tlsDir, `${suffix}.key`), '-out', join(tlsDir, `${suffix}.pem`), '-days', '1', '-subj', '/CN=mail.example.com', '-addext', 'subjectAltName=DNS:mail.example.com'], { stdio: 'ignore' });
  [cert, key, otherCert, otherKey] = await Promise.all(['one.pem', 'one.key', 'two.pem', 'two.key'].map(name => readFile(join(tlsDir, name))));
});
after(async () => { await rm(tlsDir, { recursive: true, force: true }); });
async function smtpFixture(t, { reject = false, partial = false, differentCert = false } = {}) {
  const messages = [], auth = []; let connections = 0;
  const server = new SMTPServer({ key: differentCert ? otherKey : key, cert: differentCert ? otherCert : cert, logger: false,
    onConnect(_session, callback) { connections++; callback(); },
    onAuth(credentials, session, callback) { auth.push({ ...credentials, secure: session.secure }); callback(null, { user: credentials.username }); },
    onRcptTo(address, _session, callback) { callback((reject || (partial && address.address === 'rejected@example.com')) ? Object.assign(new Error('synthetic recipient rejected'), { responseCode: 550 }) : null); },
    onData(stream, session, callback) { const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('end', () => { messages.push({ raw: Buffer.concat(chunks), envelope: session.envelope }); callback(); }); },
  });
  server.on('error', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { messages, auth, get connections() { return connections; }, options: { smtpPort: server.server.address().port, mailTlsMode: 'pin', mailTlsPinFile: join(tlsDir, 'one.pem') } };
}
class FakeImap extends EventEmitter {
  constructor(options, calls) { super(); this.options = options; this.calls = calls; this.usable = false; this.tail = Promise.resolve(); this.uid = 30; }
  async connect() { this.usable = true; }
  close() { this.usable = false; }
  async logout() { this.close(); }
  async getMailboxLock(path) { const previous = this.tail; let unlock; this.tail = new Promise(resolve => { unlock = resolve; }); await previous; this.mailbox = { path, uidValidity: 123n }; return { release: unlock }; }
  async list() { return [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }]; }
  async fetchOne(uid) { this.calls.push({ action: 'fetch', path: this.mailbox.path, uid }); return { uid, bodyStructure: { type: 'multipart/mixed', childNodes: [{ part: '2', type: 'application/octet-stream', disposition: 'attachment', dispositionParameters: { filename: 'forward.bin' }, size: 4 }] } }; }
  async download(uid, partId, options) { this.calls.push({ action: 'download', path: this.mailbox.path, uid, partId, options }); return { content: Readable.from([Buffer.from('forward-'), Buffer.from('content')]) }; }
  async append(path, raw, flags) { this.calls.push({ action: 'append', path, raw, flags }); return { uid: ++this.uid, uidValidity: 123n }; }
  async messageDelete(uid, options) { this.calls.push({ action: 'delete', path: this.mailbox.path, uid, options }); return true; }
  async messageFlagsAdd(uid, flags, options) { this.calls.push({ action: 'flags', path: this.mailbox.path, uid, flags, options }); return true; }
}
async function fixture(t, { smtp, overrides = {}, clientSetup } = {}) {
  let time = Date.UTC(2026, 0, 1), logs = ''; const calls = [], clients = [], attempts = [];
  const actualConfig = { ...config, ...smtp?.options, ...overrides }, tempRoot = await mkdtemp(join(tmpdir(), 'webmail-w09-'));
  const stream = new Writable({ write(chunk, _encoding, callback) { logs += chunk.toString(); callback(); } });
  const app = Fastify({ logger: { ...logOptions('info'), stream } }); installErrors(app);
  await installAuth(app, { config: actualConfig, tempRoot, now: () => time, clientFactory: options => { const client = new FakeImap(options, calls); clients.push(client); clientSetup?.(client); return client; } });
  const directory = createDirectoryService({ config: actualConfig, imap: app.imap, db: { async execute(sql) { return [sql.endsWith('FROM mailbox') ? [{ username: 'user@example.com', name: '서버 표시 이름', domain: 'example.com', active: 1 }] : []]; }, async end() {} } });
  const transport = smtp ? createSmtpService({ config: actualConfig }) : { async send(...args) { attempts.push(args); } };
  const service = createComposeService({ config: actualConfig, imap: app.imap, directory, smtp: transport, logger: app.log, tempRoot });
  await app.register(composeRoutes, { config: actualConfig, service });
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  async function login() {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://newmail.example.com' }, payload: { email: 'user@example.com', password } });
    assert.equal(response.statusCode, 200, response.body);
    return { cookie: response.headers['set-cookie'].split(';')[0], 'x-webmail-csrf': response.json().csrf, origin: 'https://newmail.example.com' };
  }
  const headers = await login(), session = await app.sessions.get(headers.cookie.split('=')[1]);
  return { app, calls, clients, service, attempts, headers, session, login, tempRoot, dir: join(tempRoot, session.id), get logs() { return logs; }, advance(ms) { time += ms; } };
}
const body = extra => ({ from: 'user@example.com', to: ['recipient@example.com'], cc: [], bcc: [], subject: 'synthetic subject', html: '<p>synthetic private body</p>', attachmentIds: [], ...extra });
function upload(f, content, headers = f.headers, filename = 'example.txt') {
  const boundary = 'synthetic-compose-boundary';
  return f.app.inject({ method: 'POST', url: '/api/attachments', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`), Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]) });
}
function request(f, method, url, payload, headers = f.headers) { return f.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) }); }
function failure(response, status, code) { assert.equal(response.statusCode, status, response.body); assert.equal(response.json().error.code, code); assert.equal(response.headers['www-authenticate'], undefined); }
for (const max of [1, 2]) test(`attachments: ATTACH_MAX_MB=${max}, exact limit succeeds and aggregate/single overflow give 413`, async t => {
  const f = await fixture(t, { overrides: { attachMaxMb: max } }), size = max * 1024 * 1024;
  const accepted = await upload(f, Buffer.alloc(size, 97)); assert.equal(accepted.statusCode, 201, accepted.body); assert.equal(accepted.json().size, size);
  assert.equal((await readFile(join(f.dir, accepted.json().id))).length, size);
  failure(await upload(f, 'x'), 413, 'ATTACH_TOO_LARGE'); assert.deepEqual(await readdir(f.dir), [accepted.json().id]);
  assert.equal((await request(f, 'DELETE', `/api/attachments/${accepted.json().id}`)).statusCode, 204);
  failure(await upload(f, Buffer.alloc(size + 1)), 413, 'ATTACH_TOO_LARGE'); assert.deepEqual(await readdir(f.dir), []);
});
test('attachments: concurrent uploads enforce aggregate cap', async t => {
  const f = await fixture(t), responses = await Promise.all([upload(f, Buffer.alloc(700000)), upload(f, Buffer.alloc(700000))]);
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [201, 413]); assert.equal((await readdir(f.dir)).length, 1);
});
test('attachments: another session cannot delete or send an attachment ID', async t => {
  const f = await fixture(t), attachment = (await upload(f, 'private attachment')).json(), other = await f.login();
  failure(await request(f, 'DELETE', `/api/attachments/${attachment.id}`, undefined, other), 404, 'ATTACHMENT_NOT_FOUND');
  failure(await request(f, 'POST', '/api/send', body({ attachmentIds: [attachment.id] }), other), 404, 'ATTACHMENT_NOT_FOUND'); assert.equal(f.attempts.length, 0); await access(join(f.dir, attachment.id));
});
for (const operation of ['logout', 'idle expiry', 'maximum expiry']) test(`attachments: ${operation} removes entire session directory`, async t => {
  const f = await fixture(t, { overrides: { sessionIdleMin: operation === 'maximum expiry' ? 120 : 1 } }); await upload(f, 'temporary content'); await access(f.dir);
  if (operation === 'logout') assert.equal((await request(f, 'POST', '/api/auth/logout')).statusCode, 204);
  else { f.advance(operation === 'idle expiry' ? 60000 : 3600000); await f.app.sessions.sweep(); failure(await request(f, 'GET', '/api/auth/session'), 403, 'SESSION_EXPIRED'); }
  await assert.rejects(access(f.dir), { code: 'ENOENT' }); assert.ok(f.session.password.every(byte => byte === 0));
});
test('attachments: protected API requires session and CSRF; missing file and traversal ID rejected', async t => {
  const f = await fixture(t);
  failure(await request(f, 'POST', '/api/send', body(), { cookie: f.headers.cookie, origin: f.headers.origin }), 403, 'CSRF'); failure(await request(f, 'POST', '/api/send', body(), {}), 403, 'NO_SESSION');
  failure(await f.app.inject({ method: 'POST', url: '/api/attachments', headers: { ...f.headers, 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--\r\n' }), 422, 'BAD_REQUEST');
  failure(await request(f, 'DELETE', '/api/attachments/..%2F..%2Fexample'), 404, 'ATTACHMENT_NOT_FOUND');
});
for (const [extra, status, code] of [
  [{ from: 'other@example.com' }, 403, 'FROM_NOT_ALLOWED'], [{ to: [] }, 422, 'NO_RECIPIENT'],
  [{ to: Array.from({ length: 101 }, (_, index) => `user${index}@example.com`) }, 422, 'TOO_MANY_RECIPIENTS'],
  [{ to: ['invalid-address'] }, 422, 'BAD_ADDRESS'], [{ to: ['recipient@example.com,hidden@example.com'] }, 422, 'BAD_ADDRESS'],
  [{ to: ['recipient@example.com\r\nBcc: hidden@example.com'] }, 422, 'BAD_ADDRESS'], [{ subject: 'subject\r\nBcc: hidden@example.com' }, 422, 'BAD_REQUEST'],
]) test(`send validation: ${code}, SMTP call count zero`, async t => {
  const smtp = await smtpFixture(t), f = await fixture(t, { smtp }); failure(await request(f, 'POST', '/api/send', body(extra)), status, code); assert.equal(smtp.connections, 0); assert.equal(f.calls.filter(call => call.action === 'append').length, 0);
});
test('send: real STARTTLS user auth, attachment streams, Sent Seen APPEND, draft delete and original Answered', async t => {
  const smtp = await smtpFixture(t), f = await fixture(t, { smtp }), attachment = (await upload(f, 'uploaded-content')).json();
  const response = await request(f, 'POST', '/api/send', body({ bcc: ['hidden@example.com'], attachmentIds: [attachment.id], draftRef: draft, replyToRef: original, forwardParts: [{ ref: original, partId: '2' }], inReplyTo: '<original@example.com>', references: '<parent@example.com>', html: '<p style="color:red" onclick="evil()">hello</p><script>evil()</script>' }));
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { ok: true }); assert.equal(smtp.auth.length, 1); assert.equal(smtp.auth[0].secure, true); assert.equal(smtp.auth[0].username, 'user@example.com'); assert.equal(smtp.auth[0].password, password);
  assert.equal(smtp.messages.length, 1); const sent = smtp.messages[0], text = sent.raw.toString();
  assert.deepEqual(sent.envelope.rcptTo.map(item => item.address), ['recipient@example.com', 'hidden@example.com']); assert.ok(!/^Bcc:/im.test(text)); assert.ok(!text.includes('onclick')); assert.ok(!text.includes('<script>'));
  for (const value of ['uploaded-content', 'forward-content']) assert.ok(text.includes(Buffer.from(value).toString('base64')));
  assert.ok(text.includes('In-Reply-To: <original@example.com>')); assert.ok(text.includes('References: <parent@example.com>'));
  const append = f.calls.find(call => call.action === 'append'); assert.equal(append.path, 'Sent'); assert.deepEqual(append.flags, ['\\Seen']); assert.ok(append.raw.toString().includes('Bcc: hidden@example.com')); assert.ok(append.raw.toString().includes(Buffer.from('서버 표시 이름').toString('base64')));
  assert.deepEqual(f.calls.find(call => call.action === 'delete'), { action: 'delete', path: 'Drafts', uid: 10, options: { uid: true } });
  assert.deepEqual(f.calls.find(call => call.action === 'flags'), { action: 'flags', path: 'INBOX', uid: 9, flags: ['\\Answered'], options: { uid: true } });
  assert.equal(f.calls.filter(call => call.action === 'download').length, 1); assert.ok(f.calls.indexOf(append) < f.calls.findIndex(call => call.action === 'delete')); assert.deepEqual(await readdir(f.dir), []);
  for (const value of [password, 'synthetic private body', 'uploaded-content']) assert.ok(!f.logs.includes(value));
});
test('draft: empty recipients allowed, Draft Seen APPEND before old delete, Bcc preserved and HTML sanitized', async t => {
  const f = await fixture(t), attachment = (await upload(f, 'draft attachment')).json();
  const response = await request(f, 'PUT', '/api/drafts', body({ to: [], bcc: ['hidden@example.com'], draftRef: draft, attachmentIds: [attachment.id], html: '<script>evil()</script><p onclick="evil()" style="color:red">draft</p>' }));
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(decodeRef(response.json().draftRef), { path: 'Drafts', uidValidity: 123, uid: 31 }); const append = f.calls.find(call => call.action === 'append'); assert.deepEqual(append.flags, ['\\Draft', '\\Seen']);
  assert.ok(!append.raw.toString().includes('onclick')); assert.ok(!append.raw.toString().includes('<script>')); assert.ok(append.raw.toString().includes('Bcc: hidden@example.com')); assert.ok(f.calls.indexOf(append) < f.calls.findIndex(call => call.action === 'delete')); assert.equal(f.attempts.length, 0); assert.deepEqual(await readdir(f.dir), []);
});
test('draft: failed append preserves old draft and temporary attachment', async t => {
  const f = await fixture(t, { clientSetup(client) { client.append = async () => false; } }), attachment = (await upload(f, 'draft attachment')).json();
  failure(await request(f, 'PUT', '/api/drafts', body({ draftRef: draft, attachmentIds: [attachment.id] })), 503, 'MAIL_UNAVAILABLE'); assert.equal(f.calls.filter(call => call.action === 'delete').length, 0); await access(join(f.dir, attachment.id));
});
test('send: arbitrary message cannot be passed as draft for deletion', async t => { const f = await fixture(t); failure(await request(f, 'POST', '/api/send', body({ draftRef: original })), 422, 'BAD_REQUEST'); assert.equal(f.attempts.length, 0); });
test('send: stale reply ref fails before SMTP', async t => { const f = await fixture(t); failure(await request(f, 'POST', '/api/send', body({ replyToRef: encodeRef('INBOX', 999, 9) })), 409, 'STALE_REF'); assert.equal(f.attempts.length, 0); });
test('send: SMTP rejection gives 502 SMTP_REJECTED, smtpMessage, and preserves draft and attachment', async t => {
  const smtp = await smtpFixture(t, { reject: true }), f = await fixture(t, { smtp }), attachment = (await upload(f, 'retry attachment')).json();
  const response = await request(f, 'POST', '/api/send', body({ draftRef: draft, replyToRef: original, attachmentIds: [attachment.id] })); failure(response, 502, 'SMTP_REJECTED'); assert.match(response.json().error.smtpMessage, /synthetic recipient rejected/);
  assert.equal(f.calls.filter(call => ['append', 'delete', 'flags'].includes(call.action)).length, 0); await access(join(f.dir, attachment.id)); assert.ok(!f.logs.includes(password)); assert.ok(!f.logs.includes('synthetic private body'));
});
for (const mode of ['verify', 'wrong pin', 'wrong name']) test(`SMTP TLS: ${mode} rejects before auth`, async t => {
  const smtp = await smtpFixture(t, { differentCert: mode === 'wrong pin' }), overrides = mode === 'verify' ? { mailTlsMode: 'verify', mailTlsPinFile: '' } : mode === 'wrong name' ? { mailTlsServername: 'wrong.example.com' } : {}, f = await fixture(t, { smtp, overrides });
  failure(await request(f, 'POST', '/api/send', body()), 503, 'MAIL_UNAVAILABLE'); assert.equal(smtp.auth.length, 0); assert.equal(f.calls.filter(call => call.action === 'append').length, 0);
});
test('SMTP: STARTTLS required, shared TLS checks, deadlines and credentials cleared after send', async () => {
  let options, closed = 0; const service = createSmtpService({ config, transportFactory(value) { options = value; return { async sendMail() { return { accepted: ['recipient@example.com'], rejected: [] }; }, close() { closed++; } }; } });
  await service.send({ email: 'user@example.com', password: Buffer.from(password) }, Buffer.from('synthetic'), { from: 'user@example.com', to: ['recipient@example.com'] });
  assert.equal(options.secure, false); assert.equal(options.requireTLS, true); assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.tls.servername, 'mail.example.com'); assert.equal(options.auth.user, 'user@example.com'); assert.equal(options.auth.pass, ''); assert.equal(options.connectionTimeout, 10000); assert.equal(options.socketTimeout, 60000); assert.equal(options.logger, false); assert.equal(options.debug, false); assert.equal(closed, 1);
});
test('compose HTML: strips dangerous content, restores blocked images, removes internal images, keeps styles/CID', () => {
  const html = sanitizeComposeHtml('<script>evil()</script><p style="color:red;background:url(https://example.com/a)" onclick="evil()">hello</p><a href="javascript:evil()">link</a><a href="data:text/html,evil">data</a><style>@import "https://example.com/a";p{color:blue}div{background:url(https://example.com/a)}</style><img data-wm-blocked="https://images.example.com/a.png"><img src="/api/messages/ref/parts/2?inline=1"><img src="https://newmail.example.com/api/messages/ref/parts/2"><img src="https://images.example.com/api/photo.png"><img src="cid:part@example.com"><img src="data:image/png;base64,YQ==">', { publicHostnames: config.publicHostnames }), doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelector('script'), null); assert.equal(doc.querySelector('[onclick]'), null); assert.equal(doc.querySelector('[data-wm-blocked]'), null); assert.equal(doc.querySelector('p').style.color, 'red'); assert.ok(!html.includes('url(')); assert.ok(!html.includes('@import')); assert.ok(doc.querySelector('style').textContent.includes('color: blue'));
  for (const link of doc.querySelectorAll('a')) assert.equal(link.hasAttribute('href'), false);
  assert.deepEqual([...doc.querySelectorAll('img')].map(img => img.getAttribute('src')), ['https://images.example.com/a.png', 'https://images.example.com/api/photo.png', 'cid:part@example.com', 'data:image/png;base64,YQ==']);
});
test('app: compose endpoints registered behind existing authentication hooks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'webmail-w09-app-')), app = await createApp({ config: { ...config, dbHost: '127.0.0.1', dbName: 'example', dbUser: 'example', dbPassword: 'synthetic-db-password' }, logger: false, staticDir: '/nonexistent-compose-static', auth: { tempRoot: root } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  for (const [method, url] of [['POST', '/api/send'], ['PUT', '/api/drafts'], ['POST', '/api/attachments'], ['DELETE', '/api/attachments/example']]) failure(await app.inject({ method, url }), 403, 'NO_SESSION');
});
for (const endpoint of ['/api/send', '/api/drafts']) test(`attachment aggregate: uploaded plus forwarded bytes exceed cap at ${endpoint}`, async t => {
  const f = await fixture(t), attachment = (await upload(f, Buffer.alloc(1024 * 1024 - 5))).json();
  failure(await request(f, endpoint === '/api/send' ? 'POST' : 'PUT', endpoint, body({ attachmentIds: [attachment.id], forwardParts: [{ ref: original, partId: '2' }] })), 413, 'ATTACH_TOO_LARGE');
  assert.equal(f.attempts.length, 0); assert.equal(f.calls.filter(call => call.action === 'append').length, 0); assert.deepEqual(await readdir(f.dir), [attachment.id]);
});
test('HTTP smoke: multipart upload and send over an actual listener', async t => {
  const smtp = await smtpFixture(t), f = await fixture(t, { smtp });
  await f.app.listen({ host: '127.0.0.1', port: 0 }); const base = `http://127.0.0.1:${f.app.server.address().port}`;
  const form = new FormData(); form.append('file', new Blob(['http-upload-content'], { type: 'text/plain' }), 'example.txt');
  const uploaded = await fetch(base + '/api/attachments', { method: 'POST', headers: f.headers, body: form }); assert.equal(uploaded.status, 201); const attachment = await uploaded.json();
  const response = await fetch(base + '/api/send', { method: 'POST', headers: { ...f.headers, 'content-type': 'application/json' }, body: JSON.stringify(body({ attachmentIds: [attachment.id] })) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true }); assert.equal(smtp.messages.length, 1); await assert.rejects(access(join(f.dir, attachment.id)), { code: 'ENOENT' });
});
test('upload multipart: second file rejected and no temporary file retained', async t => {
  const f = await fixture(t), boundary = 'synthetic-multi-file';
  const part = name => `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\nsynthetic\r\n`;
  const response = await f.app.inject({ method: 'POST', url: '/api/attachments', headers: { ...f.headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: part('one.txt') + part('two.txt') + `--${boundary}--\r\n` });
  assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body); assert.deepEqual(await readdir(f.dir), []);
});
test('send partial rejection: 200 ok with rejected recipient detail and normal postprocessing', async t => {
  const smtp = await smtpFixture(t, { partial: true }), f = await fixture(t, { smtp });
  const response = await request(f, 'POST', '/api/send', body({ to: ['recipient@example.com', 'rejected@example.com'], draftRef: draft, replyToRef: original }));
  assert.equal(response.statusCode, 200, response.body); const result = response.json(); assert.equal(result.ok, true); assert.equal(result.rejected.length, 1); assert.equal(result.rejected[0].address, 'rejected@example.com'); assert.match(result.rejected[0].smtpMessage, /synthetic recipient rejected/);
  assert.equal(smtp.messages.length, 1); assert.equal(f.calls.filter(call => call.action === 'append').length, 1); assert.equal(f.calls.filter(call => call.action === 'delete').length, 1); assert.equal(f.calls.filter(call => call.action === 'flags').length, 1);
});
test('send postprocessing failure: Sent APPEND failure returns 200 warning, continues draft/Answered, always removes uploads', async t => {
  const smtp = await smtpFixture(t), f = await fixture(t, { smtp, clientSetup(client) { client.append = async () => { throw new Error(password + ' synthetic private body'); }; } }), attachment = (await upload(f, 'temporary')).json();
  const response = await request(f, 'POST', '/api/send', body({ attachmentIds: [attachment.id], draftRef: draft, replyToRef: original }));
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { ok: true, warnings: ['SENT_COPY_FAILED'] }); assert.equal(smtp.messages.length, 1); assert.equal(f.calls.filter(call => call.action === 'delete').length, 1); assert.equal(f.calls.filter(call => call.action === 'flags').length, 1); assert.deepEqual(await readdir(f.dir), []);
  assert.match(f.logs, /SENT_COPY_FAILED/); assert.ok(!f.logs.includes(password)); assert.ok(!f.logs.includes('synthetic private body'));
});
test('send postprocessing: independent failures produce exactly their warning codes and preserve 200', async t => {
  const f = await fixture(t, { clientSetup(client) { client.messageDelete = async () => false; client.messageFlagsAdd = async () => false; } });
  const response = await request(f, 'POST', '/api/send', body({ draftRef: draft, replyToRef: original }));
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { ok: true, warnings: ['DRAFT_DELETE_FAILED', 'ANSWERED_FAILED'] }); assert.equal(f.calls.filter(call => call.action === 'append').length, 1); assert.match(f.logs, /DRAFT_DELETE_FAILED/); assert.match(f.logs, /ANSWERED_FAILED/);
});
