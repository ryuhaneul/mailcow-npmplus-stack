import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComposeService } from '../../server/mail/compose.js';
import { encodeRef } from '../../server/mail/ref.js';
import { withSignatureStoreLock } from '../../server/signature-store-lock.js';
import { AppError } from '../../server/errors.js';

const a = 'A'.repeat(32), b = 'B'.repeat(32), insertion = 'I'.repeat(32);
const tokenFor = (assetId, stamp = insertion) => `cid:wm-compose-v1.${stamp}.${assetId}@signature.invalid`;
const manifest = (assetId, stamp) => ({ token: tokenFor(assetId, stamp), assetId });
const png = Buffer.alloc(33);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20); png[24] = 8; png[25] = 6;
const gif = Buffer.from('47494638396101000100000000', 'hex');
const image = (bytes, name, contentType) => ({ name, contentType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') });
const document = () => ({ version: 1, revision: 'R'.repeat(32), images: { [a]: image(png, 'synthetic.png', 'image/png'), [b]: image(gif, 'synthetic.gif', 'image/gif') } });
const body = (extra = {}) => ({ composeId: crypto.randomUUID(), from: 'sender@example.invalid', to: ['recipient@example.invalid'], subject: 'synthetic', html: `<p>signature<img src="${tokenFor(a)}"></p>`, signatureImages: [manifest(a)], ...extra });
const original = encodeRef('INBOX', 123, 9), previous = encodeRef('Drafts', 123, 10);

// Inspect the emitted wire structure, boundaries and decoded payloads, not composer options.
function mime(raw) {
  const source = raw.toString('utf8'), end = source.indexOf('\r\n\r\n');
  assert.ok(end > 0);
  const headers = Object.fromEntries(source.slice(0, end).replace(/\r\n[ \t]+/g, ' ').split('\r\n').map(line => {
    const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  const content = source.slice(end + 4), type = headers['content-type'].split(';')[0];
  const result = { headers, type, children: [] };
  if (type.startsWith('multipart/')) {
    const boundary = /boundary="([^"]+)"/.exec(headers['content-type'])?.[1];
    assert.ok(boundary, 'multipart has an explicit boundary');
    const chunks = content.split(`--${boundary}`);
    assert.equal(chunks.shift().trim(), '');
    assert.equal(chunks.pop().trim(), '--', 'multipart closing boundary');
    result.children = chunks.map(chunk => {
      assert.ok(chunk.startsWith('\r\n') && chunk.endsWith('\r\n'));
      return mime(Buffer.from(chunk.slice(2, -2)));
    });
  } else {
    const encoding = headers['content-transfer-encoding'];
    result.content = encoding === 'base64' ? Buffer.from(content.replace(/\s/g, ''), 'base64') : Buffer.from(encoding === 'quoted-printable' ? content.replace(/=\r\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))) : content, 'utf8');
  }
  return result;
}
const leaves = node => node.children.length ? node.children.flatMap(leaves) : [node];
function inlineParts(raw, expected = [png]) {
  const root = mime(raw), parts = leaves(root), html = parts.find(part => part.type === 'text/html').content.toString();
  const inline = parts.filter(part => part.headers['content-disposition']?.startsWith('inline;'));
  assert.equal(inline.length, expected.length);
  inline.forEach((part, index) => {
    assert.deepEqual(part.content, expected[index]);
    assert.match(part.headers['content-id'], /^<wm-inline-v1\.[A-Za-z0-9_-]{32}\.\d+@signature\.invalid>$/);
    assert.ok(html.includes(`src="cid:${part.headers['content-id'].slice(1, -1)}"`));
    assert.match(part.headers['content-disposition'], /filename=/);
  });
  assert.ok(!html.includes('cid:wm-compose-v1.'));
  return { root, parts, html, inline };
}
async function fixture(t, { attachMaxMb = 1, images, forwardCid, beforeAppend, appendFailure, deleteFailure, smtpError } = {}) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-signature-mime-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const session = { id: 'synthetic-session', email: 'sender@example.invalid', connection: {} }, calls = [];
  let stored = document(), uid = 30, locked = false;
  const client = {
    enabled: new Set(), capabilities: new Map(),
    async exec(command, args, { untagged }) {
      assert.equal(command, 'GETMETADATA');
      assert.equal(args[1].value, '');
      assert.equal(args[2].value, '/private/vendor/mailstack-webmail/signature-images-v1');
      assert.equal(locked, true);
      await assert.rejects(withSignatureStoreLock(session.email, () => assert.fail('reentrant queue')), { code: 'SIGNATURE_STORE_REENTRANT' });
      calls.push({ action: 'read-images' });
      untagged.METADATA({ attributes: [{ value: '' }, [{ value: args[2].value }, { value: JSON.stringify(stored) }]] });
      return { next() {} };
    },
    async list() { return [{ path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }]; },
    async fetchOne() { return { bodyStructure: { type: 'application/octet-stream', part: '2', id: forwardCid, disposition: 'attachment', dispositionParameters: { filename: 'forward.bin' } } }; },
    async download() { return { content: Readable.from([Buffer.from('forward-content')]) }; },
    async append(path, raw, flags) {
      await beforeAppend?.(raw);
      if (appendFailure?.()) throw new Error('synthetic APPEND failure');
      calls.push({ action: 'append', path, raw, flags });
      return { uid: ++uid, uidValidity: 123n };
    },
    async messageDelete(uid) { calls.push({ action: 'delete', uid }); if (deleteFailure) throw new Error('synthetic delete failure'); return true; },
  };
  const imap = {
    async withMailbox(_session, _path, operation) {
      assert.equal(locked, false, 'no nested mailbox lock'); locked = true;
      try { return await operation(client); } finally { locked = false; }
    },
    withRef(_session, _ref, operation) { return this.withMailbox(_session, 'INBOX', client => operation(client, { uid: 10 })); },
  };
  const service = createComposeService({ config: { attachMaxMb, publicHostnames: ['mail.example.invalid'] }, tempRoot, imap, ...(images ? { images } : {}),
    directory: { async assertFrom() {}, async identities() { return { identities: [] }; } },
    smtp: { async send(_session, raw, envelope) { calls.push({ action: 'smtp', raw, envelope }); if (smtpError) throw smtpError; } },
  });
  return { service, session, calls, client, imap, tempRoot, setStored(value) { stored = value; } };
}
async function upload(f, size) {
  return f.service.upload(f.session, (async function* () { yield { type: 'file', fieldname: 'file', filename: 'synthetic.txt', mimetype: 'text/plain', file: Readable.from([Buffer.alloc(size, 97)]) }; })());
}
const deliveryCalls = f => f.calls.filter(call => ['smtp', 'append'].includes(call.action));

for (const operation of ['send', 'draft']) test(`${operation}: actual related MIME shares one asset part across three references`, async t => {
  const f = await fixture(t), again = tokenFor(a, 'J'.repeat(32));
  const input = body({ html: `<p><img src="${tokenFor(a)}"><img src="${tokenFor(a)}"><img src="${again}"></p>`, signatureImages: [manifest(a), manifest(a, 'J'.repeat(32))] }), snapshot = structuredClone(input);
  await f.service[operation](f.session, input);
  assert.deepEqual(input, snapshot);
  const raw = deliveryCalls(f)[0].raw, { root, html, inline } = inlineParts(raw);
  assert.equal(root.type, 'multipart/related');
  assert.deepEqual(root.children.map(part => part.type), ['text/html', 'image/png']);
  assert.equal(html.split(`cid:${inline[0].headers['content-id'].slice(1, -1)}`).length - 1, 3);
  assert.equal(f.calls.filter(call => call.action === 'read-images').length, 1);
});

test('two assets: outer mixed keeps uploaded/forward files outside the HTML related subtree', async t => {
  const f = await fixture(t), attachment = await upload(f, 7);
  await f.service.send(f.session, body({ html: `<p><img src="${tokenFor(a)}"><img src="${tokenFor(b)}"></p>`, signatureImages: [manifest(a), manifest(b)], attachmentIds: [attachment.id], forwardParts: [{ ref: original, partId: '2' }], bcc: ['hidden@example.invalid'] }));
  const delivered = f.calls.find(call => call.action === 'smtp'), sent = f.calls.find(call => call.action === 'append');
  const { root, parts } = inlineParts(delivered.raw, [png, gif]);
  assert.equal(root.type, 'multipart/mixed');
  assert.deepEqual(root.children.map(part => part.type), ['multipart/related', 'text/plain', 'application/octet-stream']);
  assert.deepEqual(root.children[0].children.map(part => part.type), ['text/html', 'image/png', 'image/gif']);
  const attachments = parts.filter(part => part.headers['content-disposition']?.startsWith('attachment;'));
  assert.deepEqual(attachments.map(part => part.content), [Buffer.alloc(7, 97), Buffer.from('forward-content')]);
  assert.equal(mime(delivered.raw).headers.bcc, undefined);
  assert.equal(mime(sent.raw).headers.bcc, 'hidden@example.invalid');
  assert.deepEqual(delivered.envelope.to, ['recipient@example.invalid', 'hidden@example.invalid']);
  assert.deepEqual(inlineParts(sent.raw, [png, gif]).inline, inlineParts(delivered.raw, [png, gif]).inline);
  assert.deepEqual(await readdir(join(f.tempRoot, f.session.id)), []);
});

for (const operation of ['send', 'draft']) for (const over of [0, 1]) test(`${operation}: uploaded + forwarded + unique image bytes at cap${over ? '+1' : ''}`, async t => {
  const f = await fixture(t), attachment = await upload(f, 1024 * 1024 - png.length - 'forward-content'.length + over);
  const input = body({ html: `<img src="${tokenFor(a)}"><img src="${tokenFor(a)}"><img src="${tokenFor(a)}">`, attachmentIds: [attachment.id], forwardParts: [{ ref: original, partId: '2' }] });
  if (over) {
    await assert.rejects(f.service[operation](f.session, input), { statusCode: 413, code: 'ATTACH_TOO_LARGE' });
    assert.equal(deliveryCalls(f).length, 0);
  } else {
    await f.service[operation](f.session, input);
    inlineParts(deliveryCalls(f)[0].raw);
  }
  assert.deepEqual(await readdir(join(f.tempRoot, f.session.id)), over || operation === 'draft' ? [attachment.id] : []);
});

for (const operation of ['send', 'draft']) test(`${operation}: malformed/unmatched/foreign manifest refuses the whole MIME`, async t => {
  const f = await fixture(t);
  for (const extra of [
    { signatureImages: null }, { signatureImages: {} }, { signatureImages: [null] },
    { signatureImages: [manifest(a), manifest(a)] }, { signatureImages: [manifest(b)] },
    { html: `<blockquote><img src="${tokenFor(a)}"></blockquote>` },
    { html: `<img src="${tokenFor(a).replace('wm-compose', 'wm&#45;compose')}">` },
    { html: `<img src="${tokenFor(a).replace('wm-compose', 'wm%2Dcompose')}">` },
    { html: `<img src="${tokenFor(a).toUpperCase()}">` },
  ]) await assert.rejects(f.service[operation](f.session, body(extra)), { statusCode: 422, code: 'SIGNATURE_INVALID' });
  f.setStored({ ...document(), images: {} });
  await assert.rejects(f.service[operation](f.session, body()), { statusCode: 422, code: 'SIGNATURE_IMAGE_NOT_FOUND' });
  assert.equal(deliveryCalls(f).length, 0);
});

test('only current exact manifest images become parts; quoted CIDs and remote URLs stay untouched', async t => {
  const f = await fixture(t);
  await f.service.draft(f.session, body({ html: `<img src="${tokenFor(a)}"><blockquote><img src="cid:received@example.invalid"><img src="cid:wm-sig-v1.${b}@signature.invalid"></blockquote><img src="https://images.example.invalid/logo.png"><img src="/api/messages/old/parts/2?inline=1"><script>evil()</script>` }));
  const { html, inline } = inlineParts(deliveryCalls(f)[0].raw);
  assert.equal(inline.length, 1);
  assert.ok(html.includes('cid:received@example.invalid'));
  assert.ok(html.includes(`cid:wm-sig-v1.${b}@signature.invalid`));
  assert.ok(html.includes('https://images.example.invalid/logo.png'));
  assert.ok(!html.includes('/api/messages/') && !html.includes('<script>'));
});

test('forward CID participates in collision checks; generated CID uses the next sequence', async t => {
  t.mock.method(crypto, 'randomBytes', size => Buffer.alloc(size, 78));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const nonce = Buffer.alloc(24, 78).toString('base64url'), cid = `wm-inline-v1.${nonce}.1@signature.invalid`;
  const f = await fixture(t, { forwardCid: `<${cid}>` });
  await f.service.draft(f.session, body({ forwardParts: [{ ref: original, partId: '2' }] }));
  assert.equal(inlineParts(deliveryCalls(f)[0].raw).inline[0].headers['content-id'], `<wm-inline-v1.${nonce}.2@signature.invalid>`);
});

test('injected read service uses the account queue; secured bytes survive deletion after the snapshot', async t => {
  let f, readClient, entered, release;
  const reading = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }), stored = document();
  f = await fixture(t, { images: { async read(client) {
    readClient = client;
    await assert.rejects(withSignatureStoreLock(f.session.email, () => {}), { code: 'SIGNATURE_STORE_REENTRANT' });
    entered(); await gate;
    return stored;
  } } });
  const saved = f.service.draft(f.session, body());
  await reading;
  const deletion = withSignatureStoreLock(f.session.email, () => { delete stored.images[a]; });
  assert.ok(Object.hasOwn(stored.images, a));
  release(); await deletion; await saved;
  assert.equal(readClient, f.client);
  assert.equal(Object.hasOwn(stored.images, a), false);
  assert.equal(f.calls.filter(call => call.action === 'read-images').length, 0);
  inlineParts(deliveryCalls(f)[0].raw);
});

test('queued draft A then B captures each request before edits; B APPEND precedes A deletion', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let appends = 0;
  const f = await fixture(t, { beforeAppend: async () => { if (++appends === 1) { entered(); await gate; } } });
  const input = body(), first = f.service.draft(f.session, input);
  await waiting;
  input.html = `<p>B<img src="${tokenFor(b)}"></p>`; input.signatureImages = [manifest(b)]; input.draftRef = encodeRef('Drafts', 123, 31);
  const second = f.service.draft(f.session, input);
  input.html = '<p>later edit</p>'; input.signatureImages = [];
  release(); await first; await second;
  const saves = f.calls.filter(call => call.action === 'append');
  const aParts = inlineParts(saves[0].raw), bParts = inlineParts(saves[1].raw, [gif]);
  assert.ok(bParts.html.includes('<p>B'));
  assert.notEqual(aParts.inline[0].headers['content-id'], bParts.inline[0].headers['content-id']);
  assert.ok(f.calls.indexOf(saves[1]) < f.calls.findIndex(call => call.action === 'delete' && call.uid === 10));
  assert.equal(input.html, '<p>later edit</p>');
});

test('replacement with no signature drops the previous image bytes and needs no library read', async t => {
  const f = await fixture(t, { attachMaxMb: png.length / 1024 / 1024 });
  await f.service.draft(f.session, body());
  const old = deliveryCalls(f)[0].raw, attachment = await upload(f, png.length);
  f.setStored({ ...document(), images: {} });
  await f.service.draft(f.session, body({ html: '<p>without signature</p>', signatureImages: [], draftRef: previous, attachmentIds: [attachment.id] }));
  const current = mime(f.calls.filter(call => call.action === 'append')[1].raw);
  assert.equal(current.type, 'multipart/mixed');
  assert.equal(leaves(current).filter(part => part.headers['content-id']).length, 0);
  assert.equal(f.calls.filter(call => call.action === 'read-images').length, 1);
  inlineParts(old);
});

test('draft APPEND failure preserves the preceding draft; deletion failure happens after new independent MIME', async t => {
  const f = await fixture(t, { appendFailure: () => true });
  await assert.rejects(f.service.draft(f.session, body({ draftRef: previous })), { code: 'MAIL_UNAVAILABLE' });
  assert.equal(f.calls.filter(call => call.action === 'delete').length, 0);
  const g = await fixture(t, { deleteFailure: true });
  await assert.rejects(g.service.draft(g.session, body({ draftRef: previous })), { code: 'MAIL_UNAVAILABLE' });
  const append = g.calls.find(call => call.action === 'append');
  inlineParts(append.raw);
  assert.ok(g.calls.indexOf(append) < g.calls.findIndex(call => call.action === 'delete'));
});

test('remote size rejection retains the existing SMTP_REJECTED path and skips APPEND', async t => {
  const error = new AppError(502, 'SMTP_REJECTED', 'synthetic remote size rejection'); error.smtpMessage = '552 synthetic message too large';
  const f = await fixture(t, { smtpError: error });
  await assert.rejects(f.service.send(f.session, body()), caught => caught === error);
  assert.equal(f.calls.filter(call => call.action === 'append').length, 0);
  inlineParts(f.calls.find(call => call.action === 'smtp').raw);
});
