import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { installAuth } from '../../server/routes/auth.js';
import { installErrors, AppError } from '../../server/errors.js';
import healthRoutes from '../../server/routes/health.js';
import signaturesRoutes, { createSignatureNormalizer } from '../../server/routes/signatures.js';
import { createSignaturesService, SIGNATURES_ENTRY, MAX_SIGNATURES_BYTES } from '../../server/signatures.js';
import { createSignatureImagesService, SIGNATURE_IMAGES_ENTRY } from '../../server/signature-images.js';
import { PREFS_ENTRY } from '../../server/prefs.js';
import { withSignatureStoreLock } from '../../server/signature-store-lock.js';

const config = { publicHostnames: ['webmail.example.invalid'], trustProxy: ['127.0.0.0/8'], sessionIdleMin: 480, sessionMaxHours: 24 };
const owner = 'sender@example.invalid';
const asset = 'a'.repeat(32), otherAsset = 'b'.repeat(32);
const canonical = id => `cid:wm-sig-v1.${id}@signature.invalid`;
const snapshot = result => ({ items: result.items.map(({ id, name, html }) => ({ id, name, html })), defaults: result.defaults });
function status(response, expected, code) {
  assert.equal(response.statusCode, expected, response.body);
  assert.equal(response.headers['www-authenticate'], undefined);
  if (code) assert.equal(response.json().error.code, code, response.body);
}
async function fixture(t, { injectedService, injectedNormalizer } = {}) {
  const app = Fastify({ logger: false });
  installErrors(app);
  app.decorate('directory', { mailboxName: async email => email });
  const tempRoot = await mkdtemp(join(tmpdir(), 'signature-api-'));
  await installAuth(app, { config, tempRoot, verifyLogin: async () => ({}) });
  const values = new Map(), commands = [];
  let active = 0, fail = false;
  const client = { enabled: new Set(), capabilities: new Map(), async exec(command, args, { untagged }) {
    assert.equal(active, 1, 'metadata access requires mailbox lock');
    await assert.rejects(withSignatureStoreLock(owner, () => {}), { code: 'SIGNATURE_STORE_REENTRANT' });
    commands.push({ command, args });
    if (fail) throw new Error('synthetic-private-server-failure');
    if (command === 'GETMETADATA') {
      const key = args[2].value;
      assert.deepEqual(args, [[{ type: 'ATOM', value: 'MAXSIZE' }, { type: 'ATOM', value: String(key === PREFS_ENTRY ? 65536 : key === SIGNATURES_ENTRY ? 262144 : 1572864) }], { type: 'STRING', value: '' }, { type: 'STRING', value: key }]);
      untagged.METADATA({ attributes: [{ value: '' }, [{ value: key }, { value: values.get(key) ?? null }]] });
    } else {
      assert.equal(command, 'SETMETADATA');
      assert.deepEqual(args[0], { type: 'STRING', value: '' });
      for (let i = 0; i < args[1].length; i += 2) values.set(args[1][i].value, args[1][i + 1].value.toString('utf8'));
    }
    return { next() {} };
  } };
  app.imap.withMailbox = async (session, path, operation) => {
    assert.equal(session.email, owner); assert.equal(path, 'INBOX'); assert.equal(active, 0);
    active++;
    try { return await operation(client); } finally { active--; }
  };
  const images = createSignatureImagesService({ imap: app.imap });
  const normalizeHtml = injectedNormalizer ?? createSignatureNormalizer({ config, images });
  const service = injectedService ?? createSignaturesService({ imap: app.imap, normalizeHtml, getIdentities: async session => {
    assert.equal(session.email, owner); return [owner];
  } });
  await app.register(signaturesRoutes, { service, normalizeHtml, imap: app.imap });
  await app.register(healthRoutes);
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://webmail.example.invalid' }, payload: { email: owner, password: 'synthetic-password' } });
  status(login, 200);
  const headers = { cookie: `webmail_sid=${login.cookies[0].value}`, origin: 'https://webmail.example.invalid', 'x-webmail-csrf': login.json().csrf };
  const request = (method, payload, extra = {}, url = '/api/signatures') => app.inject({ method, url, payload, headers: { ...headers, ...extra } });
  function seedImage() {
    const bytes = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(2, 16); bytes.writeUInt32BE(3, 20); bytes[24] = 8; bytes[25] = 6;
    values.set(SIGNATURE_IMAGES_ENTRY, JSON.stringify({ version: 1, revision: 'i'.repeat(32), images: { [asset]: { name: 'synthetic.png', contentType: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') } } }));
  }
  return { app, values, commands, request, headers, seedImage, setFail() { fail = true; } };
}

test('HTTP list and PUT preserve exact service arguments, raw If-Match and returned idMap', async t => {
  let receivedSession;
  const input = { items: [{ id: 'client-new', name: ' 합성 ', html: '<p>raw & text</p>' }], defaults: { [owner]: { newDefault: 'client-new', replyDefault: null } } };
  const result = { revision: 'r'.repeat(32), items: [], defaults: {}, usedBytes: 0, maxBytes: 262144, notices: [], idMap: { 'client-new': asset } };
  const calls = [];
  const f = await fixture(t, { injectedService: {
    async get(session) { assert.equal(session.email, owner); receivedSession = session; calls.push('get'); return result; },
    async put(session, body, revision) { assert.strictEqual(session, receivedSession); assert.deepEqual(body, input); assert.equal(revision, '"raw-revision"'); calls.push('put'); return result; },
  } });
  const get = await f.request('GET'); status(get, 200); assert.deepEqual(get.json(), result);
  const put = await f.request('PUT', input, { 'if-match': '"raw-revision"' }); status(put, 200); assert.deepEqual(put.json(), result);
  assert.deepEqual(calls, ['get', 'put']); assert.equal(put.headers['cache-control'], 'no-store');
  status(await f.app.inject('/healthz'), 200);
});

test('real service HTTP create, rename, copy, delete and defaults round trip', async t => {
  const f = await fixture(t); f.seedImage();
  let response = await f.request('GET'); status(response, 200);
  let result = response.json(); assert.deepEqual(result.items, []); assert.deepEqual(result.defaults, {});
  const html = `<p onclick="bad()">합성<script>bad()</script><img src="${canonical(asset)}" data-extra="x" width="160"></p>`;
  response = await f.request('PUT', { items: [{ id: 'client-new', name: ' 업무 ', html }], defaults: { [owner]: { newDefault: 'client-new', replyDefault: null } } }, { 'if-match': result.revision });
  status(response, 200); result = response.json();
  const id = result.idMap['client-new']; assert.match(id, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(result.items[0].name, '업무'); assert.equal(result.items[0].html, `<p>합성<img src="${canonical(asset)}" width="160"></p>`);
  assert.equal(result.defaults[owner].newDefault, id); assert.equal(result.defaults[owner].replyDefault, null);
  assert.deepEqual(JSON.parse(f.values.get(PREFS_ENTRY)).signatures[owner], { html: result.items[0].html, auto: true });
  assert.equal(result.usedBytes, Buffer.byteLength(f.values.get(SIGNATURES_ENTRY))); assert.equal(result.maxBytes, MAX_SIGNATURES_BYTES);
  assert.equal(result.migration, undefined); assert.equal(result.mirror, undefined);
  const edit = snapshot(result); edit.items[0].name = '외부'; edit.items.push({ id: 'client-copy', name: '외부', html: edit.items[0].html });
  edit.defaults[owner].replyDefault = 'client-copy';
  response = await f.request('PUT', edit, { 'if-match': result.revision }); status(response, 200); result = response.json();
  assert.equal(result.items[0].id, id); assert.notEqual(result.idMap['client-copy'], id);
  assert.equal(result.defaults[owner].replyDefault, result.idMap['client-copy']);
  response = await f.request('PUT', { items: [], defaults: result.defaults }, { 'if-match': result.revision }); status(response, 200);
  assert.deepEqual(response.json().defaults[owner], { newDefault: null, replyDefault: null });
  response = await f.request('GET'); status(response, 200); assert.deepEqual(response.json().items, []);
});

test('HTTP revision missing/stale and foreign ID reject with exact errors and no writes', async t => {
  const f = await fixture(t); const result = (await f.request('GET')).json(); const before = new Map(f.values);
  const input = { items: [], defaults: {} };
  status(await f.request('PUT', input), 428, 'SIGNATURE_REVISION_REQUIRED');
  status(await f.request('PUT', input, { 'if-match': 'stale' }), 409, 'SIGNATURE_CONFLICT');
  status(await f.request('PUT', { items: [{ id: asset, name: '타인', html: '' }], defaults: {} }, { 'if-match': result.revision }), 404, 'SIGNATURE_NOT_FOUND');
  assert.deepEqual(f.values, before);
});

test('normalize passes exact session/client/html under account and mailbox locks', async t => {
  const input = '<p> 합성 & raw </p>';
  let calls = 0;
  const f = await fixture(t, { injectedNormalizer: async ({ session, client, html }) => {
    assert.equal(session.email, owner); assert.equal(typeof client.exec, 'function'); assert.equal(html, input);
    await assert.rejects(withSignatureStoreLock(owner, () => {}), { code: 'SIGNATURE_STORE_REENTRANT' });
    calls++; return '<p>정리</p>';
  } });
  const response = await f.request('POST', { html: input }, {}, '/api/signatures/normalize');
  status(response, 200); assert.deepEqual(response.json(), { html: '<p>정리</p>' }); assert.equal(calls, 1); assert.equal(f.values.size, 0);
});

test('normalize sanitizes unsafe HTML/CSS, arbitrary data, blob and internal API URLs without storing', async t => {
  const f = await fixture(t); f.seedImage(); const before = new Map(f.values);
  const html = `<p data-foreign="x" onclick="bad()" style="color:red;background-image:url(https://tracker.example.invalid)">합성<script>bad()</script><img src="${canonical(asset)}" alt="로고"><img src="https://images.example.invalid/logo.png"><img src="/api/messages/x"><img src="https://webmail.example.invalid/api/messages/x"><img src="blob:private"><img data-wm-blocked="https://webmail.example.invalid/api/messages/x"><a href="javascript:bad()">연락</a></p>`;
  const response = await f.request('POST', { html }, {}, '/api/signatures/normalize'); status(response, 200);
  assert.equal(response.json().html, `<p style="color: red;">합성<img src="${canonical(asset)}" alt="로고"><img src="https://images.example.invalid/logo.png"><img><img><a>연락</a></p>`);
  assert.deepEqual(f.values, before); assert.equal(f.commands.filter(c => c.command === 'SETMETADATA').length, 0);
});

for (const src of ['data:image/png;base64,YQ==', 'DaTa:image/png;base64,YQ==', '&#100;ata&#58;image/png;base64,YQ==', ' \tD&#x41;T&#x61;:\nimage/png;base64,YQ==', 'd a t a :image/png;base64,YQ==']) {
  test(`data image source rejects normalize and list PUT: ${src}`, async t => {
    const f = await fixture(t), result = (await f.request('GET')).json(), before = new Map(f.values), html = `<p>원문<img src="${src}"></p>`;
    for (const [method, body, url, headers] of [
      ['POST', { html }, '/api/signatures/normalize', {}],
      ['PUT', { items: [{ id: 'client-data', name: '원문', html }], defaults: {} }, '/api/signatures', { 'if-match': result.revision }],
    ]) {
      const response = await f.request(method, body, headers, url); status(response, 422, 'SIGNATURE_DATA_IMAGE');
      assert.deepEqual(response.json(), { error: { code: 'SIGNATURE_DATA_IMAGE', message: '이미지는 보관함에서 넣어 주세요.' } });
      assert.deepEqual(f.values, before);
    }
  });
}

for (const [src, code] of [
  [canonical(otherAsset), 'SIGNATURE_IMAGE_NOT_FOUND'], ['CID:wm-sig-v1.' + asset + '@signature.invalid', 'SIGNATURE_IMAGE_INVALID'],
  ['cid:wm-sig-v1%2E' + asset + '@signature.invalid', 'SIGNATURE_IMAGE_INVALID'], ['cid:wm-compose-v1.token.' + asset + '@signature.invalid', 'SIGNATURE_IMAGE_INVALID'],
  ['cid:received@example.invalid', 'SIGNATURE_IMAGE_INVALID'], ['cid%3Awm-sig-v1.' + asset + '@signature.invalid', 'SIGNATURE_IMAGE_INVALID'],
]) test(`invalid/missing CID rejects normalize and PUT: ${src}`, async t => {
  const f = await fixture(t); f.seedImage(); const result = (await f.request('GET')).json(), before = new Map(f.values), html = `<img src="${src}">`;
  status(await f.request('POST', { html }, {}, '/api/signatures/normalize'), 422, code);
  status(await f.request('PUT', { items: [{ id: 'client-image', name: '이미지', html }], defaults: {} }, { 'if-match': result.revision }), 422, code);
  assert.deepEqual(f.values, before);
});

test('normalize validates JSON shape and parse errors without metadata access', async t => {
  const f = await fixture(t);
  for (const payload of ['{broken', '', 'null', '[]', '{}', '{"html":1}', '{"html":"x","extra":true}']) {
    status(await f.request('POST', payload, { 'content-type': 'application/json' }, '/api/signatures/normalize'), 422, 'SIGNATURE_INVALID');
  }
  status(await f.request('PUT', '{broken', { 'content-type': 'application/json' }), 422, 'SIGNATURE_INVALID');
  assert.equal(f.commands.length, 0);
});

test('256KiB HTTP request boundary uses UTF-8 bytes for normalize and PUT', async t => {
  const f = await fixture(t, { injectedService: {
    async get() { return {}; },
    async put(session, body, revision) { assert.equal(session.email, owner); assert.equal(revision, 'raw'); assert.equal(Buffer.byteLength(JSON.stringify(body)), MAX_SIGNATURES_BYTES); return { accepted: true }; },
  } });
  for (const [method, url, base] of [['POST', '/api/signatures/normalize', { html: '' }], ['PUT', '/api/signatures', { items: [{ id: 'client-boundary', name: '합성', html: '' }], defaults: {} }]]) {
    const room = MAX_SIGNATURES_BYTES - Buffer.byteLength(JSON.stringify(base));
    const value = '가'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3);
    if (method === 'POST') base.html = value; else base.items[0].html = value;
    const payload = JSON.stringify(base); assert.equal(Buffer.byteLength(payload), MAX_SIGNATURES_BYTES);
    const response = await f.request(method, payload, { 'content-type': 'application/json', 'if-match': 'raw' }, url);
    status(response, 200); assert.deepEqual(response.json(), method === 'POST' ? { html: value } : { accepted: true });
    status(await f.request(method, payload + ' ', { 'content-type': 'application/json', 'if-match': 'raw' }, url), 413, 'BAD_REQUEST');
  }
  assert.equal(f.values.size, 0);
});

test('normalizer checks raw and expanded canonical UTF-8 lengths', async () => {
  const normalize = createSignatureNormalizer({ config, images: { async read() { assert.fail('no image references'); } } });
  assert.equal(await normalize({ html: 'x'.repeat(MAX_SIGNATURES_BYTES) }), 'x'.repeat(MAX_SIGNATURES_BYTES));
  await assert.rejects(normalize({ html: 'x'.repeat(MAX_SIGNATURES_BYTES + 1) }), { statusCode: 413, code: 'SIGNATURES_TOO_LARGE' });
  await assert.rejects(normalize({ html: '&'.repeat(60000) }), { statusCode: 413, code: 'SIGNATURES_TOO_LARGE' });
});

test('normalizer reads only the supplied client and checks all referenced assets', async () => {
  const client = {}, calls = [];
  const normalize = createSignatureNormalizer({ config, images: { async read(value) { assert.strictEqual(value, client); calls.push(value); return { images: { [asset]: {} } }; } } });
  const html = `<img src="${canonical(asset)}"><img src="${canonical(asset)}">`;
  assert.equal(await normalize({ client, html }), html); assert.equal(calls.length, 1);
  await assert.rejects(normalize({ client, html: html + `<img src="${canonical(otherAsset)}">` }), { statusCode: 422, code: 'SIGNATURE_IMAGE_NOT_FOUND' });
});

test('session, origin, CSRF and logout guards protect every signature route', async t => {
  const f = await fixture(t);
  for (const [method, url, payload] of [['GET', '/api/signatures', undefined], ['PUT', '/api/signatures', { items: [], defaults: {} }], ['POST', '/api/signatures/normalize', { html: '<p>x</p>' }]]) {
    const anonymous = await f.app.inject({ method, url, payload, headers: { origin: f.headers.origin } });
    status(anonymous, 403, 'NO_SESSION');
    assert.deepEqual(anonymous.json(), { error: { code: 'NO_SESSION', message: '로그인이 필요해요.' } });
    if (method !== 'GET') {
      status(await f.request(method, payload, { origin: 'https://other.example.invalid' }, url), 403, 'BAD_ORIGIN');
      status(await f.request(method, payload, { 'x-webmail-csrf': 'wrong' }, url), 403, 'CSRF');
    }
  }
  status(await f.request('POST', undefined, {}, '/api/auth/logout'), 204);
  status(await f.request('GET'), 403, 'SESSION_EXPIRED');
  assert.equal(f.commands.length, 0); assert.equal(f.values.size, 0);
});

test('IMAP failures return 503 without leaking server text or changing storage', async t => {
  const f = await fixture(t); f.seedImage(); f.setFail(); const before = new Map(f.values);
  for (const [method, payload, url] of [['GET', undefined, '/api/signatures'], ['PUT', { items: [], defaults: {} }, '/api/signatures'], ['POST', { html: `<img src="${canonical(asset)}">` }, '/api/signatures/normalize']]) {
    const response = await f.request(method, payload, { 'if-match': 'r'.repeat(32) }, url);
    status(response, 503, 'MAIL_UNAVAILABLE'); assert.doesNotMatch(response.body, /synthetic-private-server-failure/);
  }
  assert.deepEqual(f.values, before);
});

test('normalizer unavailable fails closed for image references', async () => {
  const normalize = createSignatureNormalizer({ config });
  await assert.rejects(normalize({ html: `<img src="${canonical(asset)}">` }), { statusCode: 503, code: 'SIGNATURE_SERVICE_UNAVAILABLE' });
});


test('entity-encoded canonical image reference is preserved as canonical, with no library writes', async t => {
  const f = await fixture(t); f.seedImage(); const before = new Map(f.values);
  const html = `<img src="&#99;id&#58;wm-sig-v1.${asset}&#64;signature.invalid">`;
  const response = await f.request('POST', { html }, {}, '/api/signatures/normalize'); status(response, 200);
  assert.deepEqual(response.json(), { html: `<img src="${canonical(asset)}">` });
  assert.deepEqual(f.values, before);
});

test('data images in inert template content are rejected before sanitization', async t => {
  const f = await fixture(t);
  const response = await f.request('POST', { html: '<template><img src="d&#97;ta:image/png;base64,YQ=="></template>' }, {}, '/api/signatures/normalize');
  status(response, 422, 'SIGNATURE_DATA_IMAGE'); assert.equal(f.values.size, 0); assert.equal(f.commands.length, 0);
});
