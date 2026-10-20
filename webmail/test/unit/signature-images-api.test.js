import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { MAX_SIGNATURE_IMAGE_BYTES, SIGNATURE_IMAGES_ENTRY } from '../../server/signature-images.js';
import { SIGNATURES_ENTRY } from '../../server/signatures.js';
import { PREFS_ENTRY } from '../../server/prefs.js';
import { withSignatureStoreLock } from '../../server/signature-store-lock.js';

const owner = 'sender@example.invalid';
const config = { publicHostnames: ['webmail.example.invalid'], trustProxy: ['127.0.0.0/8'], sessionIdleMin: 480, sessionMaxHours: 24, defaultTheme: 'olive', defaultMode: 'dark', attachMaxMb: 10 };
const canonical = id => `cid:wm-sig-v1.${id}@signature.invalid`;
function png(size = 33) {
  const bytes = Buffer.alloc(size);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(2, 16); bytes.writeUInt32BE(3, 20); bytes[24] = 8; bytes[25] = 6;
  return bytes;
}
function multipart(files = [{ bytes: png(), name: 'synthetic.png', type: 'text/html', field: 'file' }]) {
  const boundary = 'synthetic-boundary';
  const chunks = files.flatMap(file => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.name ?? 'synthetic.png'}"\r\nContent-Type: ${file.type ?? 'image/png'}\r\n\r\n`), file.bytes, Buffer.from('\r\n')]);
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
function status(response, expected, code) {
  assert.equal(response.statusCode, expected, response.body);
  assert.equal(response.headers['www-authenticate'], undefined);
  if (code) assert.equal(response.json().error.code, code, response.body);
}
async function fixture(t) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'signature-images-api-'));
  const app = await createApp({ config, logger: false, auth: { tempRoot, verifyLogin: async () => ({}) } });
  app.directory.mailboxName = async email => email;
  const identityCalls = [];
  app.directory.identities = async session => { identityCalls.push(session.email); return { identities: [{ address: session.email, kind: 'self' }, { address: 'alias@example.invalid', kind: 'alias' }] }; };
  const accounts = new Map(), commands = [];
  let active = 0, failure = false;
  app.imap.withMailbox = async (session, path, operation) => {
    assert.equal(path, 'INBOX'); assert.equal(active, 0); active++;
    if (!accounts.has(session.email)) accounts.set(session.email, new Map());
    const values = accounts.get(session.email);
    try { return await operation({ enabled: new Set(), capabilities: new Map(), async exec(command, args, { untagged }) {
      await assert.rejects(withSignatureStoreLock(session.email, () => {}), { code: 'SIGNATURE_STORE_REENTRANT' });
      commands.push({ email: session.email, command, args });
      if (failure) throw new Error('synthetic-private-failure');
      if (command === 'GETMETADATA') {
        const key = args[2].value;
        assert.deepEqual(args, [[{ type: 'ATOM', value: 'MAXSIZE' }, { type: 'ATOM', value: String(key === PREFS_ENTRY ? 65536 : key === SIGNATURES_ENTRY ? 262144 : 1572864) }], { type: 'STRING', value: '' }, { type: 'STRING', value: key }]);
        untagged.METADATA({ attributes: [{ value: '' }, [{ value: key }, { value: values.get(key) ?? null }]] });
      } else {
        assert.equal(command, 'SETMETADATA'); assert.deepEqual(args[0], { type: 'STRING', value: '' });
        for (let i = 0; i < args[1].length; i += 2) {
          assert.ok([PREFS_ENTRY, SIGNATURES_ENTRY, SIGNATURE_IMAGES_ENTRY].includes(args[1][i].value));
          assert.equal(args[1][i + 1].type, 'LITERAL'); assert.ok(Buffer.isBuffer(args[1][i + 1].value));
          values.set(args[1][i].value, args[1][i + 1].value.toString('utf8'));
        }
      }
      return { next() {} };
    } }); } finally { active--; }
  };
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  async function login(email = owner) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://webmail.example.invalid' }, payload: { email, password: 'synthetic-password' } });
    status(response, 200);
    return { cookie: `webmail_sid=${response.cookies[0].value}`, origin: 'https://webmail.example.invalid', 'x-webmail-csrf': response.json().csrf };
  }
  const headers = await login();
  const request = (method, url = '/api/signature-images', payload, extra = {}) => app.inject({ method, url, payload, headers: { ...headers, ...extra } });
  const upload = (revision = '0', files) => { const form = multipart(files); return request('POST', '/api/signature-images', form.payload, { ...form.headers, 'if-match': revision }); };
  return { app, accounts, commands, headers, identityCalls, request, upload, login, fail() { failure = true; } };
}

test('app wiring: image list, upload, dedup, validated content and delete exact HTTP/IMAP contract; health smoke', async t => {
  const f = await fixture(t);
  status(await f.app.inject('/healthz'), 200);
  const list = await f.request('GET'); status(list, 200);
  assert.deepEqual(list.json(), { revision: '0', images: [], usedBytes: 0, maxBytes: 1048576, maxFileBytes: 204800, maxCount: 20 });
  assert.equal(list.headers['cache-control'], 'no-store');
  const uploaded = await f.upload(); status(uploaded, 201);
  const result = uploaded.json(), { image } = result;
  assert.match(image.id, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(image, { id: image.id, name: 'synthetic.png', contentType: 'image/png', size: 33, width: 2, height: 3 });
  const values = f.accounts.get(owner), saved = JSON.parse(values.get(SIGNATURE_IMAGES_ENTRY));
  assert.deepEqual(Object.keys(saved), ['version', 'revision', 'images']);
  assert.equal(saved.revision, result.revision); assert.equal(saved.images[image.id].base64, png().toString('base64'));
  const before = new Map(values), writes = f.commands.filter(c => c.command === 'SETMETADATA').length;
  const duplicate = await f.upload(result.revision); status(duplicate, 201); assert.deepEqual(duplicate.json(), result);
  assert.deepEqual(values, before); assert.equal(f.commands.filter(c => c.command === 'SETMETADATA').length, writes);
  const content = await f.request('GET', `/api/signature-images/${image.id}/content`); status(content, 200);
  assert.deepEqual(content.rawPayload, png()); assert.equal(content.headers['content-type'], 'image/png');
  assert.equal(content.headers['x-content-type-options'], 'nosniff'); assert.equal(content.headers['cache-control'], 'private, no-store');
  const listing = (await f.request('GET')).json(); assert.deepEqual(listing.images, [image]); assert.doesNotMatch(JSON.stringify(listing), /base64|sha256/);
  const deleted = await f.request('DELETE', `/api/signature-images/${image.id}`, undefined, { 'if-match': result.revision }); status(deleted, 200);
  assert.equal(deleted.json().usedBytes, 0); assert.notEqual(deleted.json().revision, result.revision);
  assert.deepEqual(JSON.parse(values.get(SIGNATURE_IMAGES_ENTRY)).images, {});
  status(await f.request('GET', `/api/signature-images/${image.id}/content`), 404, 'SIGNATURE_IMAGE_NOT_FOUND');
  assert.equal(values.has(SIGNATURES_ENTRY), false, 'image deletion must not initiate migration');
});

test('multipart streaming byte boundary, count and shape reject without writing', async t => {
  const f = await fixture(t);
  for (const [files, expected, code] of [
    [[{ bytes: png(MAX_SIGNATURE_IMAGE_BYTES + 1) }], 413, 'SIGNATURE_IMAGE_TOO_LARGE'],
    [[{ bytes: png() }, { bytes: png() }], 413, 'SIGNATURE_IMAGE_TOO_LARGE'],
    [[{ bytes: png(), field: 'other' }], 422, 'SIGNATURE_IMAGE_INVALID'],
    [[{ bytes: Buffer.from('<svg>synthetic</svg>') }], 422, 'SIGNATURE_IMAGE_INVALID'],
    [[{ bytes: png().subarray(0, 25) }], 422, 'SIGNATURE_IMAGE_INVALID'],
    [[{ bytes: Buffer.alloc(0) }], 422, 'SIGNATURE_IMAGE_INVALID'],
  ]) {
    status(await f.upload('0', files), expected, code);
    assert.equal(f.commands.filter(c => c.command === 'SETMETADATA').length, 0);
  }
  const missing = multipart();
  status(await f.request('POST', '/api/signature-images', '--synthetic-boundary--\r\n', missing.headers), 422, 'SIGNATURE_IMAGE_INVALID');
  status(await f.request('POST', '/api/signature-images', { file: 'not multipart' }), 422, 'SIGNATURE_IMAGE_INVALID');
  for (const payload of [Buffer.from('--synthetic-boundary\r\ninvalid'), multipart().payload.subarray(0, -10)]) {
    status(await f.request('POST', '/api/signature-images', payload, { ...missing.headers, 'if-match': '0' }), 422, 'SIGNATURE_IMAGE_INVALID');
    assert.equal(f.commands.filter(c => c.command === 'SETMETADATA').length, 0);
  }
  const accepted = await f.upload('0', [{ bytes: png(MAX_SIGNATURE_IMAGE_BYTES) }]); status(accepted, 201);
  assert.equal(accepted.json().usedBytes, MAX_SIGNATURE_IMAGE_BYTES);
  assert.equal(f.commands.filter(c => c.command === 'SETMETADATA').length, 1);
});

test('image revision missing/stale and foreign IDs return exact errors and no writes', async t => {
  const f = await fixture(t), form = multipart();
  status(await f.request('POST', '/api/signature-images', form.payload, form.headers), 428, 'SIGNATURE_REVISION_REQUIRED');
  status(await f.upload('stale'), 409, 'SIGNATURE_CONFLICT');
  const result = (await f.upload()).json(); const before = new Map(f.accounts.get(owner));
  const path = `/api/signature-images/${result.image.id}`;
  status(await f.request('DELETE', path), 428, 'SIGNATURE_REVISION_REQUIRED');
  status(await f.request('DELETE', path, undefined, { 'if-match': 'stale' }), 409, 'SIGNATURE_CONFLICT');
  const otherHeaders = await f.login('other@example.invalid');
  status(await f.app.inject({ method: 'GET', url: `${path}/content`, headers: otherHeaders }), 404, 'SIGNATURE_IMAGE_NOT_FOUND');
  status(await f.app.inject({ method: 'DELETE', url: path, headers: { ...otherHeaders, 'if-match': '0' } }), 404, 'SIGNATURE_IMAGE_NOT_FOUND');
  status(await f.request('GET', '/api/signature-images/__proto__/content'), 404, 'SIGNATURE_IMAGE_NOT_FOUND');
  assert.deepEqual(f.accounts.get(owner), before); assert.equal(f.accounts.get('other@example.invalid').size, 0);
});

test('app shares normalizer, sender identity resolution and all-signature delete references', async t => {
  const f = await fixture(t), result = (await f.upload()).json(), asset = result.image.id;
  const list = (await f.request('GET', '/api/signatures')).json();
  const html = `<p onclick="bad()">합성<img src="${canonical(asset)}" data-extra="x"></p>`;
  const normalized = await f.request('POST', '/api/signatures/normalize', { html }); status(normalized, 200);
  const put = await f.request('PUT', '/api/signatures', { items: [{ id: 'client-new', name: '비기본 합성', html }], defaults: { 'alias@example.invalid': { newDefault: null, replyDefault: null } } }, { 'if-match': list.revision });
  status(put, 200); assert.equal(put.json().items[0].html, normalized.json().html); assert.deepEqual(f.identityCalls, [owner]);
  assert.equal(put.json().defaults['alias@example.invalid'].newDefault, null);
  const path = `/api/signature-images/${asset}`;
  const before = new Map(f.accounts.get(owner));
  const inUse = await f.request('DELETE', path, undefined, { 'if-match': result.revision }); status(inUse, 409, 'SIGNATURE_IMAGE_IN_USE');
  assert.match(inUse.json().error.message, /비기본 합성/); assert.deepEqual(f.accounts.get(owner), before);
  status(await f.request('PUT', '/api/signatures', { items: [], defaults: put.json().defaults }, { 'if-match': put.json().revision }), 200);
  status(await f.request('DELETE', path, undefined, { 'if-match': result.revision }), 200);
});

test('session, CSRF, origin and logout protect image routes without metadata access', async t => {
  const f = await fixture(t), form = multipart();
  for (const [method, url, payload, headers] of [
    ['GET', '/api/signature-images'], ['GET', '/api/signature-images/foreign/content'],
    ['POST', '/api/signature-images', form.payload, form.headers], ['DELETE', '/api/signature-images/foreign'],
  ]) {
    status(await f.app.inject({ method, url, payload, headers: { origin: f.headers.origin, ...headers } }), 403, 'NO_SESSION');
    if (['POST', 'DELETE'].includes(method)) {
      status(await f.request(method, url, payload, { ...headers, 'x-webmail-csrf': 'wrong' }), 403, 'CSRF');
      status(await f.request(method, url, payload, { ...headers, origin: 'https://other.example.invalid' }), 403, 'BAD_ORIGIN');
    }
  }
  status(await f.request('POST', '/api/auth/logout'), 204);
  status(await f.request('GET'), 403, 'SESSION_EXPIRED'); assert.equal(f.commands.length, 0);
});

test('IMAP error is 503 without leaking server text or changing image metadata', async t => {
  const f = await fixture(t); f.fail();
  for (const response of [await f.request('GET'), await f.upload(), await f.request('GET', '/api/signature-images/foreign/content'), await f.request('DELETE', '/api/signature-images/foreign', undefined, { 'if-match': '0' })]) {
    status(response, 503, 'MAIL_UNAVAILABLE'); assert.doesNotMatch(response.body, /synthetic-private-failure/);
  }
  assert.equal(f.accounts.get(owner).size, 0);
});


test('image delete checks the actual no-list legacy mirror and ignores stale prefs input', async t => {
  const f = await fixture(t), uploaded = (await f.upload()).json(), id = uploaded.image.id;
  const values = f.accounts.get(owner);
  const prefs = { theme: 'olive', mode: 'dark', accent: {}, layout: null, folderColors: {}, sharedView: {}, imageAllow: [], signatures: { [owner]: { html: `<img src="${canonical(id)}">`, auto: false } }, defaultFrom: null };
  values.set(PREFS_ENTRY, JSON.stringify(prefs));
  const before = new Map(values);
  status(await f.request('DELETE', `/api/signature-images/${id}`, undefined, { 'if-match': uploaded.revision }), 409, 'SIGNATURE_IMAGE_IN_USE');
  assert.deepEqual(values, before); assert.equal(values.has(SIGNATURES_ENTRY), false);
  values.set(PREFS_ENTRY, JSON.stringify({ ...prefs, signatures: {} }));
  status(await f.request('DELETE', `/api/signature-images/${id}`, undefined, { 'if-match': uploaded.revision }), 200);
  status(await f.request('PUT', '/api/prefs', prefs), 204);
  assert.deepEqual(JSON.parse(values.get(PREFS_ENTRY)).signatures, {});
  assert.equal(values.has(SIGNATURES_ENTRY), false);
});
