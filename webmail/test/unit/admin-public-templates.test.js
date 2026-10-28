import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdminApp, adminCsp } from '../../server/admin/app.js';
import { createPublicTemplatesService } from '../../server/admin/services/public-templates.js';
import { sanitizeComposeHtml } from '../../server/mail/sanitize.js';
import { AppError } from '../../server/errors.js';
import { publicTemplateAttachmentLimit } from '../../server/templates/public-store.js';

const root = '/api/admin/public-templates', origin = 'https://mailadmin.example.test';
const draft = extra => ({ name: '합성 이름', subject: '{{오늘}} 안내', html: '<p>{{이름}}</p>', audienceAll: true, domains: [], keepFileIds: [], newFiles: [], ...extra });
const encoded = (text = 'synthetic bytes') => ({ name: 'synthetic.txt', type: 'text/plain', dataBase64: Buffer.from(text).toString('base64') });
const rejected = (status, code) => error => error.statusCode === status && (!code || error.code === code);
function fixture() {
  const items = new Map(), calls = [], auditRows = [];
  let next = 1, nextFile = 1, tick = 0, unavailable = false;
  const version = () => `2026-10-28T07:00:00.${String(++tick).padStart(6, '0')}Z`;
  const missing = () => new AppError(404, 'NOT_FOUND', '없어요.');
  function check() { if (unavailable) throw new AppError(503, 'PUBLIC_TEMPLATES_UNAVAILABLE', '준비되지 않았어요.'); }
  const store = {
    async adminList() { check(); return { items: [...items.values()].map(({ html, attachments, ...item }) => item) }; },
    async adminGet(id) { check(); const value = items.get(id); if (!value) throw missing(); return structuredClone(value); },
    async change(args) {
      check(); calls.push(args);
      const { id, updatedAt, data, action } = args, current = id === undefined ? null : items.get(id);
      if (id !== undefined && !current) throw missing();
      if (current && current.updatedAt !== updatedAt) throw new AppError(409, 'CONFLICT', '다른 곳에서 바뀌었어요.');
      if (action === 'delete') { items.delete(id); return { ok: true }; }
      const files = current?.attachments ?? [], kept = files.filter(f => data.keepFileIds.includes(f.id));
      if (data.keepFileIds.some(id => !files.some(f => f.id === id))) throw new AppError(422, 'INVALID_INPUT', '첨부를 확인해 주세요.');
      const attachments = [...kept, ...data.newFiles.map(f => ({ id: nextFile++, name: f.name, type: f.type, size: f.data.length }))];
      const size = attachments.reduce((sum, f) => sum + f.size, 0);
      if (size > publicTemplateAttachmentLimit) throw new AppError(422, 'ATTACH_TOO_LARGE', '10MB까지');
      const key = current?.id ?? next++, row = { id: key, name: data.name, subject: data.subject, html: data.html, audienceAll: data.audienceAll, domains: data.domains, updatedAt: version(), hasAttachments: attachments.length > 0, size, attachments };
      items.set(key, row); return structuredClone(row);
    },
    async close() {},
  };
  const domains = { async list() { return { items: [{ domain: 'example.test', active: true }, { domain: 'inactive.test', active: false }] }; } };
  const audit = { async run(record, operation) { const result = await operation(); auditRows.push(record); return result; } };
  const service = createPublicTemplatesService({ store, domains, audit });
  return { store, service, calls, auditRows, items, setUnavailable(value) { unavailable = value; }, save: data => service.save({ session: {}, actor: 'admin', ip: '192.0.2.1', data: draft(data) }) };
}
async function httpFixture(t) {
  const f = fixture(), dir = await mkdtemp(join(tmpdir(), 'public-templates-admin-'));
  const client = { async login({ username }) { return { state: 'ready', username }; }, async logout() {}, async call(_session, _method, path) {
    if (path === '/api/v1/get/status/version') return { version: 'synthetic' };
    if (path === '/api/v1/get/domain/all') return [{ domain_name: 'example.test', active: 1 }, { domain_name: 'inactive.test', active: 0 }];
    if (['/api/v1/get/alias-domain/all', '/api/v1/get/mailbox/all', '/api/v1/get/alias/all'].includes(path)) return [];
    throw new Error(`Unexpected synthetic mailcow path ${path}`);
  } };
  const app = await createAdminApp({ config: { adminHostname: 'mailadmin.example.test', publicHostnames: ['newmail.example.test'], sessionIdleMin: 60, sessionMaxHours: 8, trustProxy: ['127.0.0.0/8'], logLevel: 'silent', auditDir: join(dir, 'audit') },
    logger: false, staticDir: '/nonexistent-public-templates-static', auth: { client }, publicTemplates: { store: f.store } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin }, payload: { username: 'admin', password: 'synthetic' } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { origin, cookie: login.headers['set-cookie'].split(';')[0], 'x-mailadmin-csrf': login.json().csrf };
  const request = (method, url = root, payload, overrides = {}) => app.inject({ method, url, headers: { ...headers, ...overrides }, ...(payload === undefined ? {} : { payload }) });
  return { ...f, app, request, headers };
}
function failure(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code, response.body);
  assert.equal(response.headers['www-authenticate'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(response.json().error).sort(), ['code', 'message']);
}

test('public templates admin HTTP: every route requires session and mutations require CSRF/origin', async t => {
  const f = await httpFixture(t);
  for (const [method, url] of [['GET', root], ['GET', `${root}/1`], ['POST', root], ['PUT', `${root}/1`], ['DELETE', `${root}/1`]]) {
    const payload = method === 'GET' ? undefined : {};
    failure(await f.app.inject({ method, url, headers: { origin, authorization: 'Basic synthetic' }, ...(payload === undefined ? {} : { payload }) }), 403, 'NO_SESSION');
    if (method !== 'GET') {
      failure(await f.request(method, url, payload, { 'x-mailadmin-csrf': '' }), 403, 'CSRF');
      failure(await f.request(method, url, payload, { origin: 'https://foreign.test' }), 403, 'BAD_ORIGIN');
    }
  }
  assert.equal(f.calls.length, 0);
});

test('public templates admin HTTP: CRUD, retained attachments, microsecond 409 and exact metadata audit', async t => {
  const f = await httpFixture(t);
  const created = await f.request('POST', root, draft({ audienceAll: false, domains: ['EXAMPLE.TEST'], newFiles: [encoded()], html: '<p onclick="bad()">{{이름}}</p><script>bad()</script>' }));
  assert.equal(created.statusCode, 200, created.body); const original = created.json();
  assert.equal(original.html, '<p>{{이름}}</p>'); assert.deepEqual(original.domains, ['example.test']);
  assert.match(original.updatedAt, /\.\d{6}Z$/);
  assert.equal(f.calls[0].data.newFiles[0].data.toString(), 'synthetic bytes');
  let response = await f.request('GET', root, undefined, { authorization: 'Bearer ignored' });
  assert.equal(response.json().items[0].html, undefined); assert.equal(response.json().items[0].attachments, undefined);
  response = await f.request('GET', `${root}/${original.id}`); assert.equal(response.json().attachments[0].name, 'synthetic.txt');
  const modified = await f.request('PUT', `${root}/${original.id}`, draft({ updatedAt: original.updatedAt, keepFileIds: [original.attachments[0].id], name: '수정', newFiles: [encoded('next')] }));
  assert.equal(modified.statusCode, 200, modified.body); const current = modified.json(); assert.equal(current.attachments.length, 2);
  failure(await f.request('PUT', `${root}/${original.id}`, draft({ updatedAt: original.updatedAt })), 409, 'CONFLICT');
  failure(await f.request('DELETE', `${root}/${original.id}`, { updatedAt: original.updatedAt }), 409, 'CONFLICT');
  assert.equal((await f.request('GET', `${root}/${original.id}`)).json().name, '수정');
  assert.deepEqual((await f.request('DELETE', `${root}/${original.id}`, { updatedAt: current.updatedAt })).json(), { ok: true });
  failure(await f.request('GET', `${root}/${original.id}`), 404, 'NOT_FOUND');
  const history = await f.app.audit.read(), serialized = JSON.stringify(history);
  for (const action of ['create', 'edit', 'delete']) assert.ok(history.rows.some(row => row.action === `public-template.${action}`));
  for (const secret of ['합성 이름', 'synthetic.txt', 'synthetic bytes', 'dataBase64', '<p>', 'bodyHtml', '"html"', '"subject"', '"name"']) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(current.html.includes('{{이름}}'), true); assert.equal(current.size > 0, true);
  assert.equal(created.headers['content-security-policy'], adminCsp);
});

for (const [label, src] of [['http', 'http://example.test/a.png'], ['relative protocol', '//example.test/a.png'], ['data', 'data:image/png;base64,AAAA']]) test(`public templates admin: ${label} image rejected with specific reason`, async () => {
  const f = fixture();
  await assert.rejects(f.save({ html: `<img src="${src}">` }), error => rejected(422, 'PUBLIC_TEMPLATE_IMAGE_URL')(error) && error.message.includes('https'));
  assert.equal(f.calls.length, 0);
});

for (const src of ['cid:secret', 'CID:secret', 'c&#105;d:secret', 'c%69d%3Asecret', 'c\ti\nd:secret']) test(`public templates admin: CID ${JSON.stringify(src)} rejected even if sanitization removes image src`, async () => {
  const f = fixture();
  await assert.rejects(f.save({ html: `<img src="${src}">` }), error => rejected(422, 'PUBLIC_TEMPLATE_CID')(error) && error.message.includes('붙인 이미지'));
  assert.equal(f.calls.length, 0);
});

test('public templates admin: sanitized-away CID rejected; HTTPS image and normal links/variables survive', async () => {
  const f = fixture();
  const removedCid = '<img src="c%69d%3Asecret">';
  assert.equal(sanitizeComposeHtml(removedCid), '<img>');
  await assert.rejects(f.save({ html: removedCid }), rejected(422, 'PUBLIC_TEMPLATE_CID'));
  await assert.rejects(f.save({ html: '<a href="cid:secret">x</a>' }), rejected(422, 'PUBLIC_TEMPLATE_CID'));
  const row = await f.save({ html: '<p>{{이름}}</p><img src="https://example.test/a.png"><a href="mailto:r@example.test">메일</a><a href="http://example.test">링크</a>' });
  assert.ok(row.html.includes('src="https://example.test/a.png"')); assert.ok(row.html.includes('href="mailto:')); assert.ok(row.html.includes('href="http:')); assert.ok(row.html.includes('{{이름}}'));
});

test('public templates admin: unknown fields, audience, name, subject, version and attachment manifests rejected', async () => {
  const f = fixture();
  for (const value of [{ name: '' }, { name: 'x'.repeat(101) }, { subject: 'header\ninjection' }, { name: '\ud800' }, { html: 1 }, { audienceAll: 'true' }, { audienceAll: false, domains: [] }, { audienceAll: false, domains: ['inactive.test'] }, { audienceAll: false, domains: ['foreign.test'] }, { audienceAll: false, domains: ['example.test; DROP'] }, { keepFileIds: [1] }, { keepFileIds: [1, 1] }, { keepFileIds: ['1'] }, { newFiles: [{ ...encoded(), name: ' ' }] }, { newFiles: [{ ...encoded(), type: 'text/plain\ninvalid' }] }, { newFiles: [{ ...encoded(), dataBase64: 'bad===' }] }, { newFiles: [{ ...encoded(), dataBase64: 'eA==' + '\n' }] }, { newFiles: [{ ...encoded(), dataBase64: 'Zh==' }] }, { newFiles: [{ ...encoded(), cid: 'forged' }] }, { owner: 'forged' }, { updatedAt: 'unexpected-create-version' }]) {
    await assert.rejects(f.save(value), rejected(422), JSON.stringify(value));
  }
  const row = await f.save();
  await assert.rejects(f.service.save({ id: String(row.id), data: draft({ updatedAt: '2026-10-28T07:00:00.000Z' }) }), rejected(422));
  await assert.rejects(f.service.get({ id: '1 OR 1=1' }), rejected(422));
  await assert.rejects(f.service.remove({ id: '1', data: { updatedAt: row.updatedAt, owner: 'forged' } }), rejected(422));
});

test('public templates admin: decoded byte boundary and aggregate limit, original survives rejected edit', async () => {
  const f = fixture(), data = Buffer.alloc(publicTemplateAttachmentLimit).toString('base64');
  const row = await f.save({ newFiles: [{ name: 'boundary', type: 'application/octet-stream', dataBase64: data }] });
  assert.equal(row.size, publicTemplateAttachmentLimit);
  await assert.rejects(f.service.save({ id: String(row.id), data: draft({ updatedAt: row.updatedAt, keepFileIds: [row.attachments[0].id], newFiles: [encoded('x')] }) }), rejected(422, 'ATTACH_TOO_LARGE'));
  assert.equal((await f.store.adminGet(row.id)).updatedAt, row.updatedAt);
  await assert.rejects(f.save({ newFiles: [{ name: 'over', type: 'application/octet-stream', dataBase64: Buffer.alloc(publicTemplateAttachmentLimit + 1).toString('base64') }] }), rejected(422, 'ATTACH_TOO_LARGE'));
  await assert.rejects(f.save({ newFiles: [{ name: 'boundary', type: 'application/octet-stream', dataBase64: data }, encoded('x')] }), rejected(422, 'ATTACH_TOO_LARGE'));
});

test('public templates admin HTTP: only create/update lift JSON default body limit', async t => {
  const f = await httpFixture(t), payload = draft({ html: `<p>${'x'.repeat(70 * 1024)}</p>` });
  const created = await f.request('POST', root, payload); assert.equal(created.statusCode, 200, created.body);
  const row = created.json();
  assert.equal((await f.request('PUT', `${root}/${row.id}`, { ...payload, updatedAt: row.updatedAt })).statusCode, 200);
  failure(await f.request('DELETE', `${root}/${row.id}`, { updatedAt: row.updatedAt, padding: 'x'.repeat(70 * 1024) }), 413, 'BAD_REQUEST');
  assert.equal(f.app.initialConfig.bodyLimit, 64 * 1024);
});

test('public templates admin HTTP: unavailable storage leaves health/session working with safe 503', async t => {
  const f = await httpFixture(t); f.setUnavailable(true);
  assert.equal((await f.app.inject('/healthz')).statusCode, 200);
  assert.equal((await f.request('GET', '/api/admin/auth/session')).statusCode, 200);
  failure(await f.request('GET'), 503, 'PUBLIC_TEMPLATES_UNAVAILABLE');
  failure(await f.request('POST', root, draft()), 503, 'PUBLIC_TEMPLATES_UNAVAILABLE');
});
