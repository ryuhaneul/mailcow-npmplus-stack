import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import nodemailer from 'nodemailer';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, rm, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { SMTPServer } from 'smtp-server';
import libmime from 'libmime';
import imapParser from 'imapflow/lib/handler/imap-parser.js';
import imapCompiler from 'imapflow/lib/handler/imap-compiler.js';
import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';
import { downloadMessage } from 'imapflow/lib/download.js';
import { bodyParts } from '../../server/mail/read.js';
import { JSDOM } from 'jsdom';
import { createApp } from '../../server/app.js';
import { createDirectoryService } from '../../server/directory/index.js';
import { createComposeService } from '../../server/mail/compose.js';
import { createSmtpService } from '../../server/mail/smtp.js';
import { sanitizeComposeHtml } from '../../server/mail/sanitize.js';
import { encodeRef, decodeRef } from '../../server/mail/ref.js';
import { installAuth } from '../../server/routes/auth.js';
import composeRoutes from '../../server/routes/compose.js';
import { installErrors, AppError } from '../../server/errors.js';
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
async function smtpFixture(t, { reject = false, partial = false, differentCert = false, dropAfterData = false } = {}) {
  const messages = [], auth = []; let connections = 0;
  const server = new SMTPServer({ key: differentCert ? otherKey : key, cert: differentCert ? otherCert : cert, logger: false,
    onConnect(_session, callback) { connections++; callback(); },
    onAuth(credentials, session, callback) { auth.push({ ...credentials, secure: session.secure }); callback(null, { user: credentials.username }); },
    onRcptTo(address, _session, callback) { callback((reject || (partial && address.address === 'rejected@example.com')) ? Object.assign(new Error('synthetic recipient rejected'), { responseCode: 550 }) : null); },
    onData(stream, session, callback) { const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('end', () => { messages.push({ raw: Buffer.concat(chunks), envelope: session.envelope }); if (dropAfterData) { for (const connection of server.connections) connection.close(); } else callback(); }); },
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
async function fixture(t, { smtp, overrides = {}, clientSetup, directoryTables, images, smtpSend } = {}) {
  let time = Date.UTC(2026, 0, 1), logs = ''; const calls = [], clients = [], attempts = [];
  const actualConfig = { ...config, ...smtp?.options, ...overrides }, tempRoot = await mkdtemp(join(tmpdir(), 'webmail-w09-'));
  const stream = new Writable({ write(chunk, _encoding, callback) { logs += chunk.toString(); callback(); } });
  const app = Fastify({ logger: { ...logOptions('info'), stream } }); installErrors(app);
  await installAuth(app, { config: actualConfig, tempRoot, now: () => time, clientFactory: options => { const client = new FakeImap(options, calls); clients.push(client); clientSetup?.(client); return client; } });
  const directory = createDirectoryService({ config: actualConfig, imap: app.imap, db: { async execute(sql) { return [directoryTables ? directoryTables[Object.keys(directoryTables).find(table => sql.endsWith('FROM ' + table))] || [] : sql.endsWith('FROM mailbox') ? [{ username: 'user@example.com', name: '서버 표시 이름', domain: 'example.com', active: 1 }] : []]; }, async end() {} } });
  const transport = smtp ? createSmtpService({ config: actualConfig }) : { async send(...args) { attempts.push(args); return smtpSend?.(...args); } };
  const service = createComposeService({ config: actualConfig, imap: app.imap, directory, smtp: transport, logger: app.log, tempRoot, now: () => time, ...(images ? { images } : {}) });
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
const body = extra => ({ composeId: randomUUID(), from: 'user@example.com', to: ['recipient@example.com'], cc: [], bcc: [], subject: 'synthetic subject', html: '<p>synthetic private body</p>', attachmentIds: [], ...extra });
function upload(f, content, headers = f.headers, filename = 'example.txt', composeId) {
  const boundary = 'synthetic-compose-boundary';
  const field = composeId === undefined ? '' : `--${boundary}\r\nContent-Disposition: form-data; name="composeId"\r\n\r\n${composeId}\r\n`;
  return f.app.inject({ method: 'POST', url: '/api/attachments', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(field), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`), Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]) });
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
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { status: 'sent', ok: true, sentCopySavedTo: 'sent', sentCopyRef: encodeRef('Sent', 123, 31) }); assert.equal(smtp.auth.length, 1); assert.equal(smtp.auth[0].secure, true); assert.equal(smtp.auth[0].username, 'user@example.com'); assert.equal(smtp.auth[0].password, password);
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
for (const [label, ownName, delegatedName, from, expected] of [
  ['real name', 'Example, User', undefined, 'user@example.com', '"Example, User" <user@example.com>'],
  ['empty name', '', undefined, 'user@example.com', 'user@example.com'],
  ['address as name', 'user@example.com', undefined, 'user@example.com', 'user@example.com'],
  ['delegated own name', '', 'Example, Team', 'team@example.com', '"Example, Team" <team@example.com>'],
  ['delegated login fallback', 'Example, User', '', 'team@example.com', '"Example, User" <team@example.com>'],
  ['delegated unnamed', '', 'team@example.com', 'team@example.com', 'team@example.com'],
]) test(`From header: ${label} in draft, SMTP and Sent copy`, async t => {
  const smtp = await smtpFixture(t);
  const directoryTables = { mailbox: [{ username: 'user@example.com', name: ownName, active: 1 }, ...(delegatedName === undefined ? [] : [{ username: 'team@example.com', name: delegatedName, active: 1 }])], sender_acl: [{ logged_in_as: 'user@example.com', send_as: 'team@example.com' }] };
  const f = await fixture(t, { smtp, directoryTables });
  assert.equal(f.session.name, 'user@example.com');
  const content = body({ from, replyToRef: original, inReplyTo: '<original@example.com>', forwardParts: [{ ref: original, partId: '2' }] });
  const saved = await request(f, 'PUT', '/api/drafts', content); assert.equal(saved.statusCode, 200, saved.body);
  const sent = await request(f, 'POST', '/api/send', content); assert.equal(sent.statusCode, 200, sent.body);
  const header = raw => /^From: (.+)$/im.exec(raw.toString().replace(/\r\n[ \t]+/g, ' '))[1].trim();
  assert.equal(smtp.messages.length, 1);
  assert.equal(header(smtp.messages[0].raw), expected);
  const copies = f.calls.filter(call => call.action === 'append'); assert.equal(copies.length, 2);
  for (const copy of copies) assert.equal(header(copy.raw), expected);
  t.diagnostic('SMTP From: ' + header(smtp.messages[0].raw));
});

test('draft: empty recipients allowed, Draft Seen APPEND before old delete, Bcc preserved and HTML sanitized', async t => {
  const f = await fixture(t), attachment = (await upload(f, 'draft attachment')).json();
  const response = await request(f, 'PUT', '/api/drafts', body({ to: [], bcc: ['hidden@example.com'], draftRef: draft, attachmentIds: [attachment.id], html: '<script>evil()</script><p onclick="evil()" style="color:red">draft</p>' }));
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(decodeRef(response.json().draftRef), { path: 'Drafts', uidValidity: 123, uid: 31 }); const append = f.calls.find(call => call.action === 'append'); assert.deepEqual(append.flags, ['\\Draft', '\\Seen']);
  assert.ok(!append.raw.toString().includes('onclick')); assert.ok(!append.raw.toString().includes('<script>')); assert.ok(append.raw.toString().includes('Bcc: hidden@example.com')); assert.ok(f.calls.indexOf(append) < f.calls.findIndex(call => call.action === 'delete')); assert.equal(f.attempts.length, 0); assert.deepEqual(await readdir(f.dir), [attachment.id]);
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
  let options, closed = 0; const service = createSmtpService({ config, transportFactory(value) { options = value; return { use() {}, async sendMail() { return { accepted: ['recipient@example.com'], rejected: [] }; }, close() { closed++; } }; } });
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
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'sent', ok: true, sentCopySavedTo: 'sent', sentCopyRef: encodeRef('Sent', 123, 31) }); assert.equal(smtp.messages.length, 1); await assert.rejects(access(join(f.dir, attachment.id)), { code: 'ENOENT' });
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
test('send postprocessing failure: all copy APPEND failures return 200 warning, preserve draft and uploads, and continue Answered', async t => {
  const smtp = await smtpFixture(t), f = await fixture(t, { smtp, clientSetup(client) { client.append = async () => { throw new Error(password + ' synthetic private body'); }; } }), attachment = (await upload(f, 'temporary')).json();
  const response = await request(f, 'POST', '/api/send', body({ attachmentIds: [attachment.id], draftRef: draft, replyToRef: original }));
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { status: 'sent', ok: true, warnings: ['SENT_COPY_FAILED'], sentCopySavedTo: null }); assert.equal(smtp.messages.length, 1); assert.equal(f.calls.filter(call => call.action === 'delete').length, 0); assert.equal(f.calls.filter(call => call.action === 'flags').length, 1); await access(join(f.dir, attachment.id));
  assert.match(f.logs, /SENT_COPY_FAILED/); assert.ok(!f.logs.includes(password)); assert.ok(!f.logs.includes('synthetic private body'));
});
test('send postprocessing: independent failures produce exactly their warning codes and preserve 200', async t => {
  const f = await fixture(t, { clientSetup(client) { client.messageDelete = async () => false; client.messageFlagsAdd = async () => false; } });
  const response = await request(f, 'POST', '/api/send', body({ draftRef: draft, replyToRef: original }));
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { status: 'sent', ok: true, warnings: ['DRAFT_DELETE_FAILED', 'ANSWERED_FAILED'], sentCopySavedTo: 'sent', sentCopyRef: encodeRef('Sent', 123, 31) }); assert.equal(f.calls.filter(call => call.action === 'append').length, 1); assert.match(f.logs, /DRAFT_DELETE_FAILED/); assert.match(f.logs, /ANSWERED_FAILED/);
});


test('draft attachments: two saves keep the same ID usable for send, success removes it', async t => {
  const f = await fixture(t), attachment = (await upload(f, 'retained draft attachment', f.headers, 'draft.txt', 'compose-draft')).json();
  let draftRef;
  for (let index = 0; index < 2; index++) {
    const response = await request(f, 'PUT', '/api/drafts', body({ attachmentIds: [attachment.id], ...(draftRef ? { draftRef } : {}) }));
    assert.equal(response.statusCode, 200, response.body);
    draftRef = response.json().draftRef;
    await access(join(f.dir, attachment.id));
  }
  const sent = await request(f, 'POST', '/api/send', body({ draftRef, attachmentIds: [attachment.id] }));
  assert.equal(sent.statusCode, 200, sent.body); assert.equal(f.attempts.length, 1);
  await assert.rejects(access(join(f.dir, attachment.id)), { code: 'ENOENT' });
});

test('compose upload quotas are independent, but combining IDs in send or draft still gives 413', async t => {
  const f = await fixture(t);
  const a = await upload(f, Buffer.alloc(800000), f.headers, 'a.txt', 'compose-a');
  const b = await upload(f, Buffer.alloc(800000), f.headers, 'b.txt', 'compose-b');
  assert.equal(a.statusCode, 201, a.body); assert.equal(b.statusCode, 201, b.body);
  failure(await upload(f, Buffer.alloc(300000), f.headers, 'over.txt', 'compose-a'), 413, 'ATTACH_TOO_LARGE');
  // Missing composeId retains the legacy session-wide upload limit.
  failure(await upload(f, 'x'), 413, 'ATTACH_TOO_LARGE');
  const attachmentIds = [a.json().id, b.json().id];
  for (const [method, endpoint] of [['POST', '/api/send'], ['PUT', '/api/drafts']]) {
    failure(await request(f, method, endpoint, body({ attachmentIds })), 413, 'ATTACH_TOO_LARGE');
  }
  assert.equal(f.attempts.length, 0);
  assert.equal((await request(f, 'POST', '/api/send', body({ attachmentIds: [a.json().id] }))).statusCode, 200);
  await assert.rejects(access(join(f.dir, a.json().id)), { code: 'ENOENT' });
  await access(join(f.dir, b.json().id));
});

test('same compose concurrent uploads cannot exceed the per-message cap', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([upload(f, Buffer.alloc(700000), f.headers, 'a.txt', 'compose-one'), upload(f, Buffer.alloc(700000), f.headers, 'b.txt', 'compose-one')]);
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [201, 413]);
  assert.equal((await readdir(f.dir)).length, 1);
});

test('composeId is validated and may follow the multipart file', async t => {
  const f = await fixture(t);
  for (const composeId of ['', '../example', 'a'.repeat(129)]) {
    failure(await upload(f, 'synthetic', f.headers, 'example.txt', composeId), 422, 'BAD_REQUEST');
  }
  const boundary = 'synthetic-field-after-file';
  const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="example.txt"\r\nContent-Type: text/plain\r\n\r\nsynthetic\r\n--${boundary}\r\nContent-Disposition: form-data; name="composeId"\r\n\r\ncompose-after\r\n--${boundary}--\r\n`;
  const response = await f.app.inject({ method: 'POST', url: '/api/attachments', headers: { ...f.headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal((await readdir(f.dir)).length, 1);
});

for (const [method, endpoint] of [['POST', '/api/send'], ['PUT', '/api/drafts']]) test(`signature manifest HTTP contract: ${endpoint} rejects malformed/missing and includes inline MIME`, async t => {
  const assetId = 'A'.repeat(32), token = `cid:wm-compose-v1.${'I'.repeat(32)}.${assetId}@signature.invalid`;
  const bytes = Buffer.from('47494638396101000100000000', 'hex');
  let stored = { images: { [assetId]: { name: 'synthetic.gif', contentType: 'image/gif', base64: bytes.toString('base64') } } };
  const f = await fixture(t, { images: { async read() { return stored; } } });
  const signature = { html: `<p><img src="${token}"></p>`, signatureImages: [{ token, assetId }] };
  failure(await request(f, method, endpoint, body({ ...signature, signatureImages: null })), 422, 'SIGNATURE_INVALID');
  failure(await request(f, method, endpoint, body({ ...signature, signatureImages: [{ token, assetId: 'B'.repeat(32) }] })), 422, 'SIGNATURE_INVALID');
  stored = { images: {} };
  failure(await request(f, method, endpoint, body(signature)), 422, 'SIGNATURE_IMAGE_NOT_FOUND');
  assert.equal(f.attempts.length, 0); assert.equal(f.calls.filter(call => call.action === 'append').length, 0);
  stored = { images: { [assetId]: { name: 'synthetic.gif', contentType: 'image/gif', base64: bytes.toString('base64') } } };
  const over = (await upload(f, Buffer.alloc(1024 * 1024 - bytes.length + 1))).json();
  failure(await request(f, method, endpoint, body({ ...signature, attachmentIds: [over.id] })), 413, 'ATTACH_TOO_LARGE');
  assert.equal(f.attempts.length, 0); assert.equal(f.calls.filter(call => call.action === 'append').length, 0);
  assert.equal((await request(f, 'DELETE', `/api/attachments/${over.id}`)).statusCode, 204);
  const result = await request(f, method, endpoint, body(signature));
  assert.equal(result.statusCode, 200, result.body);
  const raw = f.calls.find(call => call.action === 'append').raw.toString().replace(/\r\n[ \t]+/g, ' ');
  assert.match(raw, /Content-Type: multipart\/related;/);
  assert.match(raw, /Content-ID: <wm-inline-v1\.[A-Za-z0-9_-]{32}\.1@signature\.invalid>/);
  assert.match(raw, /Content-Disposition: inline;/);
  assert.ok(raw.includes(bytes.toString('base64')));
});


for (const cleanup of ['send', 'delete']) test(`session upload quota: changing composeId cannot bypass byte cap; ${cleanup} releases it`, async t => {
  const f = await fixture(t), size = 1024 * 1024;
  const a = await upload(f, Buffer.alloc(size), f.headers, 'a.txt', 'compose-a');
  const b = await upload(f, Buffer.alloc(size), f.headers, 'b.txt', 'compose-b');
  assert.equal(a.statusCode, 201, a.body); assert.equal(b.statusCode, 201, b.body);
  failure(await upload(f, 'x', f.headers, 'over.txt', 'compose-c'), 413, 'ATTACH_TOO_LARGE');
  assert.equal((await readdir(f.dir)).length, 2);
  const response = cleanup === 'send'
    ? await request(f, 'POST', '/api/send', body({ attachmentIds: [a.json().id] }))
    : await request(f, 'DELETE', `/api/attachments/${a.json().id}`);
  assert.equal(response.statusCode, cleanup === 'send' ? 200 : 204, response.body);
  assert.equal((await upload(f, Buffer.alloc(size), f.headers, 'c.txt', 'compose-c')).statusCode, 201);
});

test('session upload quota: 200 zero-byte files fill the count cap across compose IDs, deletion releases it', async t => {
  const f = await fixture(t); let attachment;
  for (let i = 0; i < 200; i++) {
    const response = await upload(f, '', f.headers, 'empty.txt', `compose-${i}`);
    assert.equal(response.statusCode, 201, response.body); attachment = response.json();
  }
  failure(await upload(f, '', f.headers, 'over.txt', 'compose-extra'), 413, 'ATTACH_TOO_LARGE');
  assert.equal((await readdir(f.dir)).length, 200);
  assert.equal((await request(f, 'DELETE', `/api/attachments/${attachment.id}`)).statusCode, 204);
  assert.equal((await upload(f, '', f.headers, 'again.txt', 'compose-extra')).statusCode, 201);
});

test('session upload quota: concurrent different compose IDs share the byte budget', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([0, 1, 2].map(i => upload(f, Buffer.alloc(800000), f.headers, 'synthetic.txt', `compose-${i}`)));
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [201, 201, 413]);
  assert.equal((await readdir(f.dir)).length, 2);
});

test('upload expiry: periodic session sweep removes unused uploads after 24h, draft use refreshes expiry', async t => {
  const f = await fixture(t, { overrides: { sessionIdleMin: 3 * 24 * 60, sessionMaxHours: 72 } });
  const a = (await upload(f, Buffer.alloc(1024 * 1024), f.headers, 'a.txt', 'compose-a')).json();
  const b = (await upload(f, Buffer.alloc(1024 * 1024), f.headers, 'b.txt', 'compose-b')).json();
  f.advance(23 * 60 * 60 * 1000);
  const saved = await request(f, 'PUT', '/api/drafts', body({ attachmentIds: [a.id] }));
  assert.equal(saved.statusCode, 200, saved.body);
  failure(await upload(f, 'x', f.headers, 'over.txt', 'compose-c'), 413, 'ATTACH_TOO_LARGE');
  f.advance(60 * 60 * 1000); await f.app.sessions.sweep();
  await access(join(f.dir, a.id)); await assert.rejects(access(join(f.dir, b.id)), { code: 'ENOENT' });
  failure(await request(f, 'DELETE', `/api/attachments/${b.id}`), 404, 'ATTACHMENT_NOT_FOUND');
  assert.equal((await upload(f, Buffer.alloc(1024 * 1024), f.headers, 'c.txt', 'compose-c')).statusCode, 201);
  f.advance(24 * 60 * 60 * 1000);
  // Request-triggered cleanup also works before the next periodic sweep.
  assert.equal((await upload(f, Buffer.alloc(1024 * 1024), f.headers, 'd.txt', 'compose-d')).statusCode, 201);
  await assert.rejects(access(join(f.dir, a.id)), { code: 'ENOENT' });
  assert.equal((await readdir(f.dir)).length, 1);
  assert.equal((await request(f, 'POST', '/api/auth/logout')).statusCode, 204);
  await assert.rejects(access(f.dir), { code: 'ENOENT' });
  assert.equal(f.session.sweepAttachments, undefined);
});

// Parse only the synthetic MIME emitted by MailComposer, so the IMAP fake reflects
// real multipart/related reordering and the bytes a subsequent download returns.
function storedDraft(raw) {
  const downloads = new Map(), wireParts = new Map(), mimeHeaders = new Map();
  function parse(source, part = '') {
    const split = source.indexOf('\r\n\r\n'), headers = libmime.decodeHeaders(source.slice(0, split));
    const text = source.slice(split + 4), type = libmime.parseHeaderValue(headers['content-type']?.[0] || 'text/plain');
    const disposition = libmime.parseHeaderValue(headers['content-disposition']?.[0] || '');
    const node = { part: part || '1', type: type.value, parameters: type.params, disposition: disposition.value, dispositionParameters: disposition.params, size: Buffer.byteLength(text, 'latin1'), encoding: headers['content-transfer-encoding']?.[0] || '7bit', ...(headers['content-id'] ? { id: headers['content-id'][0] } : {}) };
    if (type.params.boundary) {
      const chunks = text.split('--' + type.params.boundary).slice(1, -1);
      node.childNodes = chunks.map((chunk, index) => parse(chunk.replace(/^\r\n/, '').replace(/\r\n$/, ''), part ? `${part}.${index + 1}` : `${index + 1}`));
    } else {
      const encoding = headers['content-transfer-encoding']?.[0];
      const content = encoding === 'base64' ? Buffer.from(text, 'base64') : Buffer.from(encoding === 'quoted-printable' ? text.replace(/=\r\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))) : text, 'latin1');
      downloads.set(node.part, content); wireParts.set(node.part, Buffer.from(text,'latin1')); mimeHeaders.set(node.part,Buffer.from(source.slice(0,split+4),'latin1'));
    }
    return node;
  }
  const source = raw.toString('latin1'), headers = libmime.decodeHeaders(source.slice(0, source.indexOf('\r\n\r\n')));
  const envelope = { subject: headers.subject?.[0], inReplyTo: headers['in-reply-to']?.[0] };
  for (const key of ['from', 'to', 'cc', 'bcc']) envelope[key] = addressparser(headers[key]?.join(', ') || '');
  return { row: { envelope, bodyStructure: parse(source), headers: Buffer.from(source.slice(0, source.indexOf('\r\n\r\n')), 'latin1') }, downloads, wireParts, mimeHeaders };
}
async function resumeFixture(t, { textOnly = false, mismatch = false, from = 'user@example.com', directoryTables, draftRaw, attachmentOptions, mutateSaved, realDownload = false } = {}) {
  const cid = 'logo@synthetic.invalid';
  const content = {
    from, to: 'Recipient <recipient@example.com>', cc: 'copy@example.com', bcc: 'hidden@example.com', subject: 'synthetic resume',
    inReplyTo: '<reply@synthetic.invalid>', references: '<parent@synthetic.invalid> <reply@synthetic.invalid>',
    ...(textOnly ? { text: 'draft <text> & preserved\nsecond line' } : { html: `<p>synthetic body</p><script>evil()</script><img src="cid:${cid}" onerror="evil()"><div class="sig">existing signature</div>` }),
    attachments: textOnly ? [] : [{ filename: 'same.txt', content: Buffer.from('first-content'), contentType: 'text/plain' }, { filename: 'logo.png', content: Buffer.from('synthetic-image'), contentType: 'image/png', cid, contentDisposition: 'inline' }, { filename: 'same.txt', content: Buffer.from('second-content'), contentType: 'text/plain' }],
  };
  if (attachmentOptions) content.attachments = attachmentOptions;
  const compiled = new MailComposer(content).compile(); compiled.keepBcc = true;
  const messages = new Map([[10, storedDraft(draftRaw || await compiled.build())]]), originalUids = [];
  const f = await fixture(t, { directoryTables, clientSetup(client) {
    const append = client.append.bind(client), remove = client.messageDelete.bind(client);
    client.fetchOne = async (uid, query) => {
      client.calls.push({ action: 'fetch', path: client.mailbox.path, uid }); const stored = messages.get(uid); if (!stored) return false;
      if (!query.bodyParts) return {uid,...stored.row};
      const bodyParts = new Map();
      for (const request of query.bodyParts) {
        const key=typeof request==='string'?request:request.key;
        const bytes=key.endsWith('.mime')?stored.mimeHeaders.get(key.slice(0,-5)):stored.wireParts.get(key);
        if(bytes)bodyParts.set(key,typeof request==='string'?bytes:bytes.subarray(request.start,request.start+request.maxLength));
      }
      return {uid,bodyParts,partialOrigins:new Map(query.bodyParts.filter(item=>typeof item!=='string').map(item=>[item.key,item.start]))};
    };
    client.download = async (uid, partId, options) => {
      const stored=messages.get(uid);
      if(realDownload&&partId!=='1.1'){
        const connection={mailbox:{},usable:true,_openDownloads:0,autoidle(){},log:{warn(){},error(){}},fetchOne:async(_uid,query)=>{
          const bodyParts=new Map();for(const entry of query.bodyParts||[]){if(typeof entry==='string')bodyParts.set(entry,stored.mimeHeaders.get(partId));else bodyParts.set(entry.key,stored.wireParts.get(partId).subarray(entry.start,entry.start+entry.maxLength));}
          return {uid,bodyStructure:stored.row.bodyStructure,bodyParts};
        }};
        return downloadMessage(connection,uid,partId,options);
      }
      return {content:stored?.downloads.has(partId)?Readable.from([stored.downloads.get(partId)]):null};
    };
    client.append = async (path, raw, flags) => {
      const result = await append(path, raw, flags);
      if (path === 'Drafts') {
        const stored = storedDraft(raw);
        if (mismatch) bodyParts(stored.row.bodyStructure).find(part => part.disposition === 'attachment').dispositionParameters.filename = 'wrong.txt';
        mutateSaved?.(stored); messages.set(result.uid, stored); originalUids.push(result.uid);
      }
      return result;
    };
    client.messageDelete = async (uid, options) => { messages.delete(uid); return remove(uid, options); };
  } });
  return { ...f, messages, originalUids, cid };
}
function resumedBody(loaded) {
  return body({ from: loaded.composeFrom || loaded.from[0].address, to: loaded.to, cc: loaded.cc, bcc: loaded.bcc, subject: loaded.subject, html: loaded.html, inReplyTo: loaded.inReplyTo, references: loaded.references, draftRef: loaded.draftRef, forwardParts: loaded.attachments.map(({ ref, partId }) => ({ ref, partId })) });
}
test('load draft restores recipients including stored Bcc, sanitized HTML, attachment refs, CID and reply headers', async t => {
  const f = await resumeFixture(t), response = await request(f, 'GET', `/api/drafts/${draft}`);
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers['cache-control'], 'no-store');
  const loaded = response.json();
  assert.equal(loaded.draftRef, draft); assert.equal(loaded.from[0].address, 'user@example.com'); assert.equal(loaded.to[0].address, 'recipient@example.com'); assert.equal(loaded.cc[0].address, 'copy@example.com'); assert.equal(loaded.bcc[0].address, 'hidden@example.com'); assert.equal(loaded.subject, 'synthetic resume');
  assert.match(loaded.html, /synthetic body/); assert.match(loaded.html, /cid:logo@synthetic.invalid/); assert.doesNotMatch(loaded.html, /script|onerror/); assert.match(loaded.html, /existing signature/);
  assert.equal(loaded.attachments.length, 3); assert.deepEqual(loaded.attachments.map(part=>part.size), [15,13,14]); assert.ok(loaded.attachments.every(part => part.ref === draft && part.partId)); assert.equal(loaded.attachments.find(part => part.cid).cid, f.cid);
  assert.equal(loaded.inReplyTo, '<reply@synthetic.invalid>'); assert.equal(loaded.references, '<parent@synthetic.invalid> <reply@synthetic.invalid>'); await assert.rejects(access(f.dir), { code: 'ENOENT' });
});
test('load draft rejects absent session, non-draft, shared and virtual refs before opening the source', async t => {
  const f = await resumeFixture(t);
  failure(await request(f, 'GET', `/api/drafts/${draft}`, undefined, {}), 403, 'NO_SESSION');
  for (const path of ['INBOX', 'Shared/other@example.com/Drafts', 'WebmailVirtual/AllMail', 'OtherUser/Drafts']) {
    const count = f.calls.length;
    failure(await request(f, 'GET', `/api/drafts/${encodeRef(path, 123, 10)}`), 403, 'DRAFT_NOT_ALLOWED');
    assert.equal(f.calls.slice(count).some(call => call.action === 'fetch'), false);
  }
  failure(await request(f, 'GET', `/api/drafts/${encodeRef('Drafts', 123, 999)}`), 404, 'MESSAGE_NOT_FOUND');
  failure(await request(f, 'GET', `/api/drafts/${encodeRef('Drafts', 999, 10)}`), 409, 'STALE_REF');
});
test('load draft uses the authenticated account IMAP connection, never a foreign mailbox', async t => {
  const f = await resumeFixture(t);
  const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://newmail.example.com' }, payload: { email: 'other@example.com', password } });
  assert.equal(login.statusCode, 200, login.body);
  const other = f.clients.at(-1); assert.equal(other.options.auth.user, 'other@example.com'); other.fetchOne = async () => false;
  failure(await request(f, 'GET', `/api/drafts/${draft}`, undefined, { cookie: login.headers['set-cookie'].split(';')[0] }), 404, 'MESSAGE_NOT_FOUND');
});
test('load text-only draft escapes text into HTML without silently changing the body', async t => {
  const f = await resumeFixture(t, { textOnly: true }), response = await request(f, 'GET', `/api/drafts/${draft}`);
  assert.equal(response.statusCode, 200, response.body); assert.match(response.json().html, /^<pre style="font-family: inherit;">draft &lt;text&gt; &amp; preserved\nsecond line\n<\/pre>$/); assert.deepEqual(response.json().attachments, []);
});
test('resumed draft saves twice, remaps duplicate filenames and inline parts, then sends with bytes and headers intact', async t => {
  const f = await resumeFixture(t); let loaded = (await request(f, 'GET', `/api/drafts/${draft}`)).json();
  for (let index = 0; index < 2; index++) {
    const previous = loaded.draftRef, response = await request(f, 'PUT', '/api/drafts', resumedBody(loaded));
    assert.equal(response.statusCode, 200, response.body); const saved = response.json(); assert.equal(saved.forwardParts.length, 3); assert.deepEqual(saved.forwardParts.map(part=>part.size), loaded.attachments.map(part=>part.size));
    assert.ok(saved.forwardParts.every(part => part.previousRef === previous && part.ref === saved.draftRef)); assert.equal(new Set(saved.forwardParts.map(part => part.partId)).size, 3);
    assert.equal(f.messages.size, 1); assert.equal(f.messages.has(decodeRef(previous).uid), false);
    loaded = (await request(f, 'GET', `/api/drafts/${saved.draftRef}`)).json();
    const state = f.messages.get(decodeRef(saved.draftRef).uid), duplicateParts = loaded.attachments.filter(part => part.filename === 'same.txt');
    assert.deepEqual(duplicateParts.map(part => state.downloads.get(part.partId).toString()), ['first-content', 'second-content']);
    assert.match(loaded.html, /cid:logo@synthetic.invalid/); assert.equal(loaded.bcc[0].address, 'hidden@example.com');
  }
  const response = await request(f, 'POST', '/api/send', resumedBody(loaded)); assert.equal(response.statusCode, 200, response.body); assert.equal(f.messages.size, 0); assert.equal(f.attempts.length, 1);
  const sent = storedDraft(f.attempts[0][1]), parts = bodyParts(sent.row.bodyStructure);
  assert.deepEqual(parts.filter(part => part.disposition === 'attachment').map(part => sent.downloads.get(part.part).toString()), ['first-content', 'second-content']);
  const inline = parts.find(part => part.id); assert.equal(inline.id, '<logo@synthetic.invalid>'); assert.equal(inline.disposition, 'inline'); assert.equal((sent.mimeHeaders.get(inline.part).toString().match(/^Content-ID:/gim)||[]).length,1); assert.equal(sent.downloads.get(inline.part).toString(), 'synthetic-image');
  assert.equal(parts.filter(part => part.disposition === 'attachment').some(part => part.id), false);
  assert.equal(sent.row.envelope.inReplyTo, '<reply@synthetic.invalid>'); assert.match(sent.row.headers.toString(), /References: <parent@synthetic.invalid> <reply@synthetic.invalid>/); assert.equal(sent.row.envelope.bcc.length, 0);
  assert.deepEqual(f.attempts[0][2].to, ['recipient@example.com', 'copy@example.com', 'hidden@example.com']);
  assert.deepEqual(await readdir(f.dir), []);
});
test('resumed draft mapping failure removes only the new copy and keeps old draft and attachments', async t => {
  const f = await resumeFixture(t, { mismatch: true }), loaded = (await request(f, 'GET', `/api/drafts/${draft}`)).json();
  const response = await request(f, 'PUT', '/api/drafts', resumedBody(loaded)); failure(response, 503, 'DRAFT_ATTACHMENTS_UNVERIFIED'); assert.match(response.json().error.message, /첨부.*저장하지 않았어요/);
  assert.deepEqual([...f.messages.keys()], [10]); assert.equal(f.messages.get(10).downloads.size, 4);
  assert.deepEqual(f.calls.filter(call => call.action === 'delete').map(call => call.uid), [31]); assert.equal(f.attempts.length, 0);
});
for (const endpoint of ['/api/drafts', '/api/send']) test(`resumed draft stale ref at ${endpoint} fails before append or SMTP`, async t => {
  const f = await resumeFixture(t), loaded = (await request(f, 'GET', `/api/drafts/${draft}`)).json(); f.messages.delete(10);
  failure(await request(f, endpoint === '/api/send' ? 'POST' : 'PUT', endpoint, resumedBody(loaded)), 404, 'MESSAGE_NOT_FOUND'); assert.equal(f.attempts.length, 0); assert.equal(f.calls.some(call => call.action === 'append'), false);
});

for (const [label, grant, from, expected, changed] of [
  ['listed identity', 'alias@example.com', 'alias@example.com', 'alias@example.com', false],
  ['any address', '*', 'manual@synthetic.invalid', 'manual@synthetic.invalid', false],
  ['any domain address', '@synthetic.invalid', 'manual@synthetic.invalid', 'manual@synthetic.invalid', false],
  ['revoked address', null, 'revoked@synthetic.invalid', 'user@example.com', true],
]) test(`load draft sender: ${label} uses send authorization and reports fallback`, async t => {
  const directoryTables = { mailbox: [{ username: 'user@example.com', active: 1 }], sender_acl: grant ? [{ logged_in_as: 'user@example.com', send_as: grant }] : [] };
  const f = await resumeFixture(t, { from, directoryTables }), response = await request(f, 'GET', `/api/drafts/${draft}`);
  assert.equal(response.statusCode, 200, response.body); const loaded = response.json(); assert.equal(loaded.composeFrom, expected); assert.equal(loaded.fromChanged, changed); assert.equal(loaded.from[0].address, from);
  const identities = await createDirectoryService({ config, imap: {}, db: { async execute(sql) { return [directoryTables[Object.keys(directoryTables).find(table => sql.endsWith('FROM ' + table))] || []]; } } }).identities(f.session);
  assert.equal(identities.identities.some(item => item.address === from), label === 'listed identity');
  assert.equal((await request(f, 'POST', '/api/send', resumedBody(loaded))).statusCode, 200);
  assert.equal(f.attempts[0][2].from, expected);
});

test('draft attachment size uses BINARY.SIZE with real IMAP tokens and no attachment download', async t => {
  const f = await resumeFixture(t), client = f.clients[0], downloads = [], commands = [];
  const download = client.download.bind(client);
  client.capabilities = new Set(['BINARY']);
  client.download = async (...args) => { downloads.push(args[1]); return download(...args); };
  client.exec = async (command, attributes, options) => {
    commands.push((await imapCompiler({ tag: 'A1', command, attributes })).toString());
    const uid = Number(attributes[0].value), partId = attributes[1][1].section[0].value;
    const size = f.messages.get(uid).downloads.get(partId).length;
    options.untagged.FETCH(await imapParser(Buffer.from(`* 1 FETCH (UID ${uid} BINARY.SIZE[${partId}] ${size})`)));
    return { next() {} };
  };
  const response = await request(f, 'GET', `/api/drafts/${draft}`); assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().attachments.map(part => part.size), [15,13,14]); assert.ok(response.json().attachments.every(part => part.sizeKnown !== false));
  assert.deepEqual(downloads, ['1.1']); assert.deepEqual(commands, ['A1 UID FETCH 10 (UID BINARY.SIZE[1.2])','A1 UID FETCH 10 (UID BINARY.SIZE[2])','A1 UID FETCH 10 (UID BINARY.SIZE[3])']);
});
for (const mode of ['rejected', 'invalid response']) test(`draft attachment size streams decoded bytes after BINARY.SIZE ${mode}`, async t => {
  const f = await resumeFixture(t), client = f.clients[0], downloads = [];
  const download = client.download.bind(client); client.capabilities = new Set(['BINARY']);
  client.download = async (...args) => { downloads.push(args[1]); return download(...args); };
  client.exec = async (_command, _attributes, options) => {
    if (mode === 'rejected') throw Object.assign(new Error('synthetic BINARY rejection'), { responseStatus: 'BAD' });
    options.untagged.FETCH(await imapParser(Buffer.from('* 1 FETCH (UID 999 BINARY.SIZE[2] 1)'))); return { next() {} };
  };
  const response = await request(f, 'GET', `/api/drafts/${draft}`); assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().attachments.map(part => part.size), [15,13,14]); assert.deepEqual(downloads, ['1.1']);
});
test('draft still opens with explicitly unknown attachment sizes when size lookup and streaming fail', async t => {
  const f = await resumeFixture(t), client = f.clients[0], download = client.download.bind(client); client.capabilities = new Set(['BINARY']);
  client.exec = async () => { throw new Error('synthetic size failure'); };
  client.download = async (uid, partId, ...args) => { if (partId !== '1.1') throw new Error('synthetic download failure'); return download(uid, partId, ...args); };
  const fetchOne=client.fetchOne.bind(client);client.fetchOne=async(uid,query,...args)=>{if(query.bodyParts)throw new Error('synthetic raw size failure');return fetchOne(uid,query,...args);};
  const response = await request(f, 'GET', `/api/drafts/${draft}`); assert.equal(response.statusCode, 200, response.body);
  const loaded = response.json(), encoded = bodyParts(f.messages.get(10).row.bodyStructure).filter(part => part.part !== '1.1');
  assert.match(loaded.html, /synthetic body/); assert.deepEqual(loaded.attachments.map(part => part.size), encoded.map(part => part.size)); assert.ok(loaded.attachments.every(part => part.sizeKnown === false));
});

for(const kind of ['unnamed inline text CID','mixed independent bodies'])test(`unsupported draft keeps every original part: ${kind}`,async t=>{
  const draftRaw=kind==='unnamed inline text CID'?await new MailComposer({from:'user@example.com',to:'recipient@example.com',html:'<p>body</p>',attachments:[{filename:false,content:'independent inline note',contentType:'text/plain',contentDisposition:'inline',cid:'note@synthetic.invalid'}]}).compile().build():Buffer.from('From: user@example.com\r\nTo: recipient@example.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="synthetic"\r\n\r\n--synthetic\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nindependent first body\r\n--synthetic\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>independent second body</p>\r\n--synthetic--\r\n');
  const f=await resumeFixture(t,{draftRaw}),before=f.messages.get(10);failure(await request(f,'GET',`/api/drafts/${draft}`),422,'DRAFT_UNSUPPORTED');assert.equal(f.messages.get(10),before);assert.equal(f.calls.some(call=>['append','delete'].includes(call.action)),false);
});
for(const kind of ['flowed','EUC-KR'])test(`resumed attachment preserves raw bytes and all MIME parameters through save and send: ${kind}`,async t=>{
  const bytes=kind==='flowed'?Buffer.from('original first line \r\ncontinued on next line\r\n'):Buffer.from([0xbe,0xc8,0xb3,0xe7]);
  const contentType=kind==='flowed'?'text/plain; charset=utf-8; format=flowed; delsp=yes':'text/plain; charset=euc-kr';
  const f=await resumeFixture(t,{realDownload:true,attachmentOptions:[{filename:'original.txt',content:bytes,contentType,contentDisposition:kind==='flowed'?'inline':'attachment'}]});
  const originalPart=bodyParts(f.messages.get(10).row.bodyStructure).find(part=>part.attachment);let loaded=(await request(f,'GET',`/api/drafts/${draft}`)).json();
  for(let index=0;index<2;index++){
    const response=await request(f,'PUT','/api/drafts',resumedBody(loaded));assert.equal(response.statusCode,200,response.body);
    const stored=f.messages.get(decodeRef(response.json().draftRef).uid),part=bodyParts(stored.row.bodyStructure).find(part=>part.attachment);
    assert.deepEqual(stored.downloads.get(part.part),bytes);assert.deepEqual(part.parameters,originalPart.parameters);assert.deepEqual(part.dispositionParameters,originalPart.dispositionParameters);assert.equal(part.disposition,originalPart.disposition);
    loaded=(await request(f,'GET',`/api/drafts/${response.json().draftRef}`)).json();
  }
  const response=await request(f,'POST','/api/send',resumedBody(loaded));assert.equal(response.statusCode,200,response.body);
  const stored=storedDraft(f.attempts[0][1]),part=bodyParts(stored.row.bodyStructure).find(part=>part.attachment);assert.deepEqual(stored.downloads.get(part.part),bytes);assert.deepEqual(part.parameters,originalPart.parameters);assert.deepEqual(part.dispositionParameters,originalPart.dispositionParameters);
  const headers=stored.mimeHeaders.get(part.part).toString('latin1');for(const name of ['Content-Type','Content-Disposition','Content-Transfer-Encoding'])assert.equal((headers.match(new RegExp('^'+name+':','gim'))||[]).length,1,headers);
});
for(const mismatch of ['same-size bytes','MIME parameters'])test(`resumed attachment verification rolls back on ${mismatch}`,async t=>{
  const f=await resumeFixture(t,{attachmentOptions:[{filename:'original.txt',content:Buffer.from('keep original bytes'),contentType:'text/plain; charset=euc-kr'}],mutateSaved(stored){
    const part=bodyParts(stored.row.bodyStructure).find(part=>part.attachment);
    if(mismatch==='MIME parameters')part.parameters.charset='utf-8';
    else {const bytes=Buffer.from(stored.downloads.get(part.part));bytes[0]^=1;stored.downloads.set(part.part,bytes);stored.wireParts.set(part.part,Buffer.from(bytes.toString('base64')));part.size=stored.wireParts.get(part.part).length;}
  }}),loaded=(await request(f,'GET',`/api/drafts/${draft}`)).json();
  failure(await request(f,'PUT','/api/drafts',resumedBody(loaded)),503,'DRAFT_ATTACHMENTS_UNVERIFIED');assert.deepEqual([...f.messages.keys()],[10]);assert.deepEqual(f.calls.filter(call=>call.action==='delete').map(call=>call.uid),[31]);
});
test('webmail-saved draft remains resumable, including alternative with related HTML and CID image',async t=>{
  const f=await resumeFixture(t),saved=await request(f,'PUT','/api/drafts',body());assert.equal(saved.statusCode,200,saved.body);assert.equal((await request(f,'GET',`/api/drafts/${saved.json().draftRef}`)).statusCode,200);
  const raw=await new MailComposer({from:'user@example.com',to:'recipient@example.com',text:'automatic plain alternative',html:'<p>HTML alternative</p><img src="cid:logo@synthetic.invalid">',attachments:[{filename:'logo.png',content:Buffer.from('image'),cid:'logo@synthetic.invalid',contentType:'image/png'}]}).compile().build();
  const g=await resumeFixture(t,{draftRaw:raw}),loaded=(await request(g,'GET',`/api/drafts/${draft}`)).json();assert.match(loaded.html,/HTML alternative/);assert.equal(loaded.attachments.length,1);
  const next=await request(g,'PUT','/api/drafts',resumedBody(loaded));assert.equal(next.statusCode,200,next.body);const stored=g.messages.get(decodeRef(next.json().draftRef).uid);assert.ok(bodyParts(stored.row.bodyStructure).some(part=>part.type==='text/plain'&&!part.attachment));assert.equal((await request(g,'GET',`/api/drafts/${next.json().draftRef}`)).statusCode,200);
});

for(const resumed of [true,false]) {
  test(`Sent failure saves identical latest raw in Drafts after one retry: ${resumed?'resumed':'new'} mail`,async t=>{
    const f=await resumeFixture(t),loaded=(await request(f,'GET',`/api/drafts/${draft}`)).json();
    if(!resumed)f.messages.clear();
    const attachment=(await upload(f,'new unsaved attachment',f.headers,'new.txt')).json(),client=f.clients[0],append=client.append.bind(client),sent=[];
    client.append=async(path,raw,...args)=>{if(path==='Sent'){sent.push(raw);throw new Error('synthetic Sent failure');}return append(path,raw,...args);};
    const payload=resumed?resumedBody(loaded):body({bcc:['hidden@example.com']}),html='<p>latest body before autosave</p>';
    const response=await request(f,'POST','/api/send',{...payload,html,attachmentIds:[attachment.id]});
    assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{status:'sent',ok:true,warnings:['SENT_COPY_FAILED'],sentCopySavedTo:'drafts',sentCopyRef:encodeRef('Drafts',123,31)});assert.equal(f.attempts.length,1);assert.equal(sent.length,2);
    const copies=f.calls.filter(call=>call.action==='append');assert.equal(copies.length,1);assert.equal(copies[0].path,'Drafts');assert.deepEqual(copies[0].flags,['\\Draft','\\Seen']);assert.deepEqual(copies[0].raw,sent[0]);assert.deepEqual(sent[0],sent[1]);
    assert.equal(f.messages.size,1);assert.equal(f.messages.has(10),false);assert.equal(f.calls.filter(call=>call.action==='delete').length,resumed?1:0);
    const stored=[...f.messages.values()][0],parts=bodyParts(stored.row.bodyStructure);assert.match([...stored.downloads.values()].map(bytes=>bytes.toString()).join(''),/latest body before autosave/);assert.equal(stored.row.envelope.bcc[0].address,'hidden@example.com');
    const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),actual=parts.filter(part=>part.attachment).map(part=>hash(stored.downloads.get(part.part))).sort();
    const expected=(resumed?['first-content','synthetic-image','second-content']:[]).concat('new unsaved attachment').map(value=>hash(Buffer.from(value))).sort();assert.deepEqual(actual,expected);
    await assert.rejects(access(join(f.dir,attachment.id)),{code:'ENOENT'});
  });
  test(`all copy failures retain original and uploaded bytes for recovery: ${resumed?'resumed':'new'} mail`,async t=>{
    const f=await resumeFixture(t),loaded=(await request(f,'GET',`/api/drafts/${draft}`)).json(),original=f.messages.get(10);if(!resumed)f.messages.clear();
    const attachment=(await upload(f,'retained recovery bytes')).json(),paths=[];
    f.clients[0].append=async path=>{paths.push(path);throw new Error('synthetic account copy failure');};
    const response=await request(f,'POST','/api/send',{...(resumed?resumedBody(loaded):body()),html:'<p>unsaved latest body</p>',attachmentIds:[attachment.id]});
    assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{status:'sent',ok:true,warnings:['SENT_COPY_FAILED'],sentCopySavedTo:null});assert.deepEqual(paths,['Sent','Sent','Drafts']);assert.equal(f.attempts.length,1);
    assert.equal(f.messages.size,resumed?1:0);if(resumed)assert.equal(f.messages.get(10),original);assert.equal(f.calls.filter(call=>call.action==='delete').length,0);assert.equal((await readFile(join(f.dir,attachment.id))).toString(),'retained recovery bytes');
    // Once the account recovers, the retained upload can be saved without another SMTP send.
    f.clients[0].append=async(path,raw,flags)=>{const uid=99;f.messages.set(uid,storedDraft(raw));return {uid,uidValidity:123n};};
    const saved=await request(f,'PUT','/api/drafts',{...(resumed?resumedBody(loaded):body()),html:'<p>unsaved latest body</p>',attachmentIds:[attachment.id]});assert.equal(saved.statusCode,200,saved.body);assert.equal(f.messages.size,1);assert.equal(f.attempts.length,1);
  });
  test(`Sent retry success creates one Sent copy with normal response: ${resumed?'resumed':'new'} mail`,async t=>{
    const f=await resumeFixture(t),loaded=(await request(f,'GET',`/api/drafts/${draft}`)).json();if(!resumed)f.messages.clear();
    const attachment=(await upload(f,'retry attachment')).json(),client=f.clients[0],append=client.append.bind(client);let attempts=0;
    client.append=async(path,...args)=>{assert.equal(path,'Sent');if(++attempts===1)throw new Error('synthetic first APPEND failure');return append(path,...args);};
    const response=await request(f,'POST','/api/send',{...(resumed?resumedBody(loaded):body()),attachmentIds:[attachment.id]});assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{status:'sent',ok:true,sentCopySavedTo:'sent',sentCopyRef:encodeRef('Sent',123,31)});assert.equal(attempts,2);assert.equal(f.attempts.length,1);assert.equal(f.calls.filter(call=>call.action==='append').length,1);assert.equal(f.messages.size,0);await assert.rejects(access(join(f.dir,attachment.id)),{code:'ENOENT'});
  });
}

for (const copy of ['sent', 'drafts', null]) test(`send receipts: lost response recovers SMTP success and ${copy} copy location without resending`, async t => {
  const f = await fixture(t, { clientSetup(client) {
    const append = client.append.bind(client);
    client.append = async (path, ...args) => {
      if (copy === null || copy === 'drafts' && path === 'Sent') throw new Error('synthetic copy failure');
      return append(path, ...args);
    };
  } });
  const payload = body(), response = await request(f, 'POST', '/api/send', payload);
  assert.equal(response.statusCode, 200);
  // Treat the POST response as lost; GET is the user's authoritative result.
  const status = await request(f, 'GET', `/api/send/${payload.composeId}`), receipt = status.json();
  assert.equal(status.statusCode, 200); assert.equal(status.headers['cache-control'], 'no-store');
  assert.equal(receipt.status, 'sent'); assert.equal(receipt.sentCopySavedTo, copy);
  assert.equal(receipt.startedAt, Date.UTC(2026, 0, 1)); assert.equal(receipt.updatedAt, receipt.startedAt);
  if (copy) assert.deepEqual(decodeRef(receipt.sentCopyRef), { path: copy === 'sent' ? 'Sent' : 'Drafts', uidValidity: 123, uid: 31 });
  else assert.equal(receipt.sentCopyRef, undefined);
  const duplicate = await request(f, 'POST', '/api/send', { ...payload, from: 'changed-invalid-address', attachmentIds: ['already-cleaned'] });
  assert.deepEqual(duplicate.json(), response.json()); assert.equal(f.attempts.length, 1);
});

test('send receipts: simultaneous same-key request reports checking; SMTP runs once', async t => {
  let release, started; const gate = new Promise(resolve => release = resolve), began = new Promise(resolve => started = resolve);
  t.after(() => release());
  const f = await fixture(t, { smtpSend: async () => { started(); await gate; } }), payload = body();
  const first = request(f, 'POST', '/api/send', payload).then(value => value);
  await began;
  assert.equal((await request(f, 'GET', `/api/send/${payload.composeId}`)).json().status, 'checking');
  assert.deepEqual((await request(f, 'POST', '/api/send', payload)).json(), { status: 'checking' });
  assert.equal(f.attempts.length, 1);
  release(); assert.equal((await first).json().status, 'sent');
});

test('send receipts: SMTP acceptance is visible while the Sent copy is still pending', async t => {
  let release, started; const gate = new Promise(resolve => release = resolve), began = new Promise(resolve => started = resolve);
  t.after(() => release());
  const f = await fixture(t, { clientSetup(client) {
    const append = client.append.bind(client);
    client.append = async (...args) => { started(); await gate; return append(...args); };
  } }), payload = body(), first = request(f, 'POST', '/api/send', payload).then(value => value);
  await began;
  const receipt = (await request(f, 'GET', `/api/send/${payload.composeId}`)).json();
  assert.equal(receipt.status, 'sent'); assert.equal(receipt.copyPending, true);
  assert.equal((await request(f, 'POST', '/api/send', payload)).json().status, 'sent');
  assert.equal(f.attempts.length, 1); release(); await first;
  assert.equal((await request(f, 'GET', `/api/send/${payload.composeId}`)).json().sentCopySavedTo, 'sent');
});

test('send receipts: pre-send validation and SMTP rejection permit a same-key retry only after not_sent', async t => {
  let reject = true;
  const f = await fixture(t, { smtpSend: async () => { if (reject) throw Object.assign(new Error('synthetic rejection'), { code: 'SMTP_REJECTED', statusCode: 502 }); } });
  const payload = body({ to: [] });
  failure(await request(f, 'POST', '/api/send', payload), 422, 'NO_RECIPIENT');
  assert.equal((await request(f, 'GET', `/api/send/${payload.composeId}`)).json().status, 'not_sent');
  payload.to = ['recipient@example.com'];
  await request(f, 'POST', '/api/send', payload);
  const failed = (await request(f, 'GET', `/api/send/${payload.composeId}`)).json();
  assert.equal(failed.status, 'not_sent'); assert.equal(f.attempts.length, 1);
  reject = false; assert.equal((await request(f, 'POST', '/api/send', payload)).json().status, 'sent');
  assert.equal(f.attempts.length, 2);
});

test('send receipts: unknown SMTP outcome stays locked; only a different key can deliver again', async t => {
  const f = await fixture(t, { smtpSend: async () => { throw new AppError(503, 'SMTP_OUTCOME_UNKNOWN', '발송 여부 확인 필요'); } });
  const payload = body();
  assert.equal((await request(f, 'POST', '/api/send', payload)).json().status, 'unknown');
  assert.equal((await request(f, 'GET', `/api/send/${payload.composeId}`)).json().reason, 'SMTP_OUTCOME_UNKNOWN');
  assert.equal((await request(f, 'POST', '/api/send', payload)).json().status, 'unknown'); assert.equal(f.attempts.length, 1);
  await request(f, 'POST', '/api/send', { ...payload, composeId: randomUUID() }); assert.equal(f.attempts.length, 2);
});

test('send receipts: key validation, session isolation, expiry and sweep', async t => {
  const f = await fixture(t), payload = body();
  failure(await request(f, 'POST', '/api/send', { ...payload, composeId: undefined }), 422, 'BAD_REQUEST');
  failure(await request(f, 'POST', '/api/send', { ...payload, composeId: 'bad key' }), 422, 'BAD_REQUEST');
  failure(await request(f, 'GET', '/api/send/bad%20key'), 422, 'BAD_REQUEST');
  assert.equal((await request(f, 'GET', `/api/send/${payload.composeId}`)).json().reason, 'NOT_FOUND');
  await request(f, 'POST', '/api/send', payload);
  const other = await f.login();
  assert.deepEqual((await request(f, 'GET', `/api/send/${payload.composeId}`, undefined, other)).json(), { status: 'unknown', reason: 'NOT_FOUND' });
  failure(await request(f, 'GET', `/api/send/${payload.composeId}`, undefined, {}), 403, 'NO_SESSION');
  f.advance(60_001); await f.app.sessions.sweep();
  failure(await request(f, 'GET', `/api/send/${payload.composeId}`), 403, 'SESSION_EXPIRED');
  const fresh = await f.login();
  assert.equal((await request(f, 'GET', `/api/send/${payload.composeId}`, undefined, fresh)).json().reason, 'NOT_FOUND');
});

test('SMTP real connection refusal is not_sent and has no IMAP copy', async t => {
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const smtpPort = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const f = await fixture(t, { smtp: { options: { smtpPort } } }), payload = body();
  failure(await request(f, 'POST', '/api/send', payload), 503, 'MAIL_UNAVAILABLE');
  assert.equal((await request(f, 'GET', `/api/send/${payload.composeId}`)).json().status, 'not_sent');
  assert.equal(f.calls.some(call => call.action === 'append'), false);
});

test('SMTP real RCPT rejection is not_sent, and DATA loss after the final dot is unknown even with CONN errors', async t => {
  const rejecting = await smtpFixture(t, { reject: true }), f = await fixture(t, { smtp: rejecting }), payload = body();
  failure(await request(f, 'POST', '/api/send', payload), 502, 'SMTP_REJECTED');
  assert.equal((await request(f, 'GET', `/api/send/${payload.composeId}`)).json().status, 'not_sent'); assert.equal(rejecting.messages.length, 0);
  const dropping = await smtpFixture(t, { dropAfterData: true }), g = await fixture(t, { smtp: dropping }), uncertain = body();
  const response = await request(g, 'POST', '/api/send', uncertain);
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().status, 'unknown');
  assert.equal(dropping.messages.length, 1); assert.equal(g.calls.some(call => call.action === 'append'), false);
  assert.equal((await request(g, 'GET', `/api/send/${uncertain.composeId}`)).json().status, 'unknown');
  await request(g, 'POST', '/api/send', uncertain); assert.equal(dropping.messages.length, 1);
});

test('SMTP lazy stream preserves the exact wire bytes and SHA-256 of the previous Buffer path', async t => {
  const smtp = await smtpFixture(t), actualConfig = { ...config, ...smtp.options };
  const raw = Buffer.from('From: user@example.com\r\nTo: recipient@example.com\r\nSubject: synthetic bytes\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n한글 원문\r\n.leading dot\r\n..two dots\r\n');
  const envelope = { from: 'user@example.com', to: ['recipient@example.com'] }, session = { email: 'user@example.com', password: Buffer.from(password) };
  // Baseline is precisely the old sendMail({raw: Buffer, envelope}) path.
  const baseline = nodemailer.createTransport({ host: actualConfig.smtpHost, port: actualConfig.smtpPort, secure: false, requireTLS: true, tls: { rejectUnauthorized: true, servername: actualConfig.mailTlsServername, ca: cert }, auth: { user: session.email, pass: password }, logger: false, debug: false });
  try { await baseline.sendMail({ raw, envelope }); } finally { baseline.close(); }
  await createSmtpService({ config: actualConfig }).send(session, raw, envelope);
  assert.equal(smtp.messages.length, 2);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(smtp.messages[0].raw), hash(raw)); assert.equal(hash(smtp.messages[1].raw), hash(smtp.messages[0].raw));
  assert.deepEqual(smtp.messages[1].raw, raw);
});

for (const [command, code, consume, expected] of [
  ['CONN', 'ETIMEDOUT', false, 'MAIL_UNAVAILABLE'],
  ['EHLO', 'ESOCKET', false, 'MAIL_UNAVAILABLE'],
  ['STARTTLS', 'ETLS', false, 'MAIL_UNAVAILABLE'],
  ['AUTH PLAIN', 'EAUTH', false, 'MAIL_UNAVAILABLE'],
  ['MAIL FROM', 'ETIMEDOUT', false, 'MAIL_UNAVAILABLE'],
  ['RCPT TO', 'ESOCKET', false, 'MAIL_UNAVAILABLE'],
  ['CONN', 'ECONNECTION', true, 'SMTP_OUTCOME_UNKNOWN'],
  ['CONN', 'ESOCKET', true, 'SMTP_OUTCOME_UNKNOWN'],
  ['CONN', 'ETIMEDOUT', true, 'SMTP_OUTCOME_UNKNOWN'],
  ['DATA', 'ETIMEDOUT', true, 'SMTP_OUTCOME_UNKNOWN'],
  [undefined, undefined, false, 'SMTP_OUTCOME_UNKNOWN'],
]) test(`SMTP phase classification: ${command || 'unknown phase'} ${code || 'unknown error'} bodyStarted=${consume}`, async () => {
  let plugin;
  const service = createSmtpService({ config, transportFactory: () => ({
    use(stage, callback) { assert.equal(stage, 'stream'); plugin = callback; },
    async sendMail() {
      const mail = { message: { createReadStream: () => Readable.from([Buffer.from('synthetic')]) } };
      await new Promise((resolve, reject) => plugin(mail, error => error ? reject(error) : resolve()));
      if (consume) for await (const _chunk of mail.message.createReadStream()) { /* Trigger the same lazy DATA boundary. */ }
      throw Object.assign(new Error('synthetic failure'), { command, code });
    },
    close() {},
  }) });
  await assert.rejects(service.send({ email: 'user@example.com', password: Buffer.from(password) }, Buffer.from('synthetic'), { from: 'user@example.com', to: ['recipient@example.com'] }), { code: expected });
});

test('send receipts: manual recovery updates only the sent/no-copy receipt location and keeps SMTP locked', async t => {
  let failing = true;
  const f = await fixture(t, { clientSetup(client) {
    const append = client.append.bind(client); client.append = async (...args) => { if (failing) throw new Error('synthetic copy failure'); return append(...args); };
  } }), payload = body();
  await request(f, 'POST', '/api/send', payload);
  const before = (await request(f, 'GET', `/api/send/${payload.composeId}`)).json(); assert.equal(before.sentCopySavedTo, null);
  failing = false;
  const saved = await request(f, 'PUT', '/api/drafts', { ...payload, html: '<p>edited manual recovery</p>' }); assert.equal(saved.statusCode, 200, saved.body);
  const receipt = (await request(f, 'GET', `/api/send/${payload.composeId}`)).json();
  assert.deepEqual(receipt, { ...before, sentCopySavedTo: 'drafts', sentCopyRef: saved.json().draftRef, manualRecovery: true });
  const second = await request(f, 'PUT', '/api/drafts', { ...payload, draftRef: saved.json().draftRef, html: '<p>second manual recovery</p>' });
  assert.equal(second.statusCode, 200, second.body); assert.notEqual(second.json().draftRef, saved.json().draftRef);
  const latest = (await request(f, 'GET', `/api/send/${payload.composeId}`)).json();
  assert.equal(latest.sentCopyRef, second.json().draftRef); assert.equal(latest.manualRecovery, true);
  assert.deepEqual(f.calls.filter(call => call.action === 'delete').map(call => call.uid), [31]);
  const copies = f.calls.filter(call => call.action === 'append'); assert.match(copies.at(-1).raw.toString(), /second manual recovery/);
  assert.equal((await request(f, 'POST', '/api/send', payload)).json().manualRecovery, true); assert.equal(f.attempts.length, 1);
});

test('send receipts: manual saving with another key or session never changes the original receipt', async t => {
  let failing = true;
  const f = await fixture(t, { clientSetup(client) {
    const append = client.append.bind(client); client.append = async (...args) => { if (failing) throw new Error('synthetic copy failure'); return append(...args); };
  } }), payload = body();
  await request(f, 'POST', '/api/send', payload); failing = false;
  const before = (await request(f, 'GET', `/api/send/${payload.composeId}`)).json(), different = body();
  assert.equal((await request(f, 'PUT', '/api/drafts', different)).statusCode, 200);
  assert.deepEqual((await request(f, 'GET', `/api/send/${payload.composeId}`)).json(), before);
  assert.equal((await request(f, 'GET', `/api/send/${different.composeId}`)).json().reason, 'NOT_FOUND');
  const other = await f.login();
  assert.equal((await request(f, 'PUT', '/api/drafts', payload, other)).statusCode, 200);
  assert.deepEqual((await request(f, 'GET', `/api/send/${payload.composeId}`)).json(), before);
  assert.equal((await request(f, 'GET', `/api/send/${payload.composeId}`, undefined, other)).json().reason, 'NOT_FOUND');
});

test('send receipts: failed manual recovery leaves the sent/no-copy receipt untouched', async t => {
  const f = await fixture(t, { clientSetup(client) { client.append = async () => { throw new Error('synthetic copy failure'); }; } }), payload = body();
  await request(f, 'POST', '/api/send', payload);
  const before = (await request(f, 'GET', `/api/send/${payload.composeId}`)).json();
  failure(await request(f, 'PUT', '/api/drafts', payload), 503, 'MAIL_UNAVAILABLE');
  assert.deepEqual((await request(f, 'GET', `/api/send/${payload.composeId}`)).json(), before); assert.equal(f.attempts.length, 1);
});

for (const status of ['not_sent', 'unknown', 'sent']) test(`send receipts: manual save cannot reclassify ${status} or replace an existing Sent copy`, async t => {
  const f = await fixture(t, { smtpSend: async () => { if (status === 'unknown') throw new AppError(503, 'SMTP_OUTCOME_UNKNOWN', '합성 불명'); } }), payload = body({ ...(status === 'not_sent' ? { to: [] } : {}) });
  await request(f, 'POST', '/api/send', payload);
  const before = (await request(f, 'GET', `/api/send/${payload.composeId}`)).json(); assert.equal(before.status, status);
  assert.equal((await request(f, 'PUT', '/api/drafts', payload)).statusCode, 200);
  assert.deepEqual((await request(f, 'GET', `/api/send/${payload.composeId}`)).json(), before);
});

for (const [from, name] of [['user@example.com', '직접 정한 이름'], ['alias@example.com', '별칭, 담당자'], ['delegated@example.com', '권한 이름'], ['manual@example.com', '서버 이름']]) test(`From prefs: ${from} in draft, SMTP and Sent copy`, async t => {
  const directoryTables = { mailbox: [{ username: 'user@example.com', name: '서버 이름', active: 1 }], domain: [{ domain: 'example.com', active: 1 }], alias: [{ address: 'alias@example.com', goto: 'user@example.com', domain: 'example.com', active: 1, sender_allowed: 1 }], sender_acl: [{ logged_in_as: 'user@example.com', send_as: 'delegated@example.com' }, { logged_in_as: 'user@example.com', send_as: '@example.com' }] };
  const f = await fixture(t, { directoryTables });
  f.session.prefs = { fromNames: { 'user@example.com': '직접 정한 이름', 'alias@example.com': '별칭, 담당자', 'delegated@example.com': '권한 이름', 'manual@example.com': '무시할 이름' } };
  const content = body({ from });
  assert.equal((await request(f, 'PUT', '/api/drafts', content)).statusCode, 200);
  assert.equal((await request(f, 'POST', '/api/send', content)).statusCode, 200);
  assert.equal(f.attempts.length, 1);
  for (const raw of [...f.calls.filter(call => call.action === 'append').map(call => call.raw), f.attempts[0][1]]) {
    const headers = libmime.decodeHeaders(raw.toString().split('\r\n\r\n')[0]);
    const parsed = addressparser(headers.from[0])[0];
    assert.equal(libmime.decodeWords(parsed.name), name); assert.equal(parsed.address, from);
    assert.equal(headers.bcc, undefined);
  }
});
test('draft resume preserves stored From name and uses current setting on next save', async t => {
  const f = await resumeFixture(t, { from: 'Stored Name <user@example.com>' });
  f.session.prefs = { fromNames: { 'user@example.com': 'Current Name' } };
  const response = await request(f, 'GET', `/api/drafts/${draft}`); assert.equal(response.statusCode, 200, response.body);
  const loaded = response.json(); assert.equal(loaded.from[0].name, 'Stored Name');
  const saved = await request(f, 'PUT', '/api/drafts', resumedBody(loaded)); assert.equal(saved.statusCode, 200, saved.body);
  const append = f.calls.find(call => call.action === 'append');
  assert.match(append.raw.toString(), /From: Current Name <user@example.com>/);
});
