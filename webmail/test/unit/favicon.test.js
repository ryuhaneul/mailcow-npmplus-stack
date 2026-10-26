import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.js';
import { createAdminApp } from '../../server/admin/app.js';
import { readFaviconState, resolveFaviconFile, faviconHash, faviconCsp } from '../../server/favicon-store.js';
const source = name => fileURLToPath(new URL(`../../web/${name}.html`, import.meta.url));
async function fixture(t, auditFs = fs) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'synthetic-favicon-http-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { publicHostnames: ['mail.example.com'], adminHostname: 'mailadmin.example.com', trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: join(dir, 'audit'), logoDir: dir };
  const client = { async call() { return { version: 'synthetic' }; }, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} };
  const staticPath = name => process.env.FAVICON_BUILT_STATIC === '1' ? fileURLToPath(new URL(`../../web/${name === 'admin' ? 'dist-admin' : 'dist'}/`, import.meta.url)) : dir;
  for (const name of ['index','admin']) await fs.copyFile(source(name), join(dir, `${name}.html`));
  const web = await createApp({ config, staticDir: staticPath('index'), logger: false }), admin = await createAdminApp({ config, staticDir: staticPath('admin'), logger: false, auth: { client }, audit: { fs: auditFs } });
  t.after(() => web.close()); t.after(() => admin.close());
  const login = async () => {
    const result = await admin.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'synthetic-admin', password: 'synthetic-only' } });
    assert.equal(result.statusCode, 200, result.body); return { cookie: result.headers['set-cookie'].split(';')[0], origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': result.json().csrf };
  };
  return { dir, web, admin, login };
}
for (const [mime, ext] of [['image/png','png'],['image/svg+xml','svg'],['image/vnd.microsoft.icon','ico']]) test(`both servers public favicon ${mime}: final headers, exact bytes, HEAD, ETag304`, async t => {
  const f = await fixture(t), bytes = Buffer.from(ext === 'svg' ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>' : `synthetic-${ext}`), version = faviconHash(bytes), entry = { version, file: `favicon-${version}.${ext}`, mime, size: bytes.length, savedAt: '2026-10-26T00:00:00Z' };
  await fs.writeFile(join(f.dir, entry.file), bytes); await fs.writeFile(join(f.dir, 'favicon.json'), JSON.stringify(entry));
  for (const app of [f.web, f.admin]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await app.inject({ method, url: '/favicon.ico' }); assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['content-type'], mime); assert.equal(response.headers['content-security-policy'], faviconCsp); assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.headers['cache-control'], 'no-cache'); assert.equal(response.headers['etag'], `"${version}"`); assert.equal(response.headers['content-disposition'], 'inline');
      assert.deepEqual(response.rawPayload, method === 'HEAD' ? Buffer.alloc(0) : bytes);
      const cached = await app.inject({ method, url: '/favicon.ico', headers: { 'if-none-match': response.headers.etag } }); assert.equal(cached.statusCode, 304); assert.equal(cached.body, ''); assert.equal(cached.headers['content-security-policy'], faviconCsp); assert.equal(cached.headers['cache-control'], 'no-cache'); assert.equal(cached.headers['x-content-type-options'], 'nosniff'); assert.equal(cached.headers.etag, `"${version}"`);
    }
    assert.equal((await app.inject({ url: '/favicon.ico', headers: { 'if-none-match': '"stale"' } })).statusCode, 200);
  }
});
test('both servers favicon unregistered404 JSON with static SPA; fixed HTML links and health', async t => {
  const f = await fixture(t);
  for (const [app, name] of [[f.web, 'index'], [f.admin, 'admin']]) {
    for (const method of ['GET','HEAD','POST','PUT','DELETE','OPTIONS']) {
      const response = await app.inject({ method, url: '/favicon.ico' }); assert.equal(response.statusCode, 404, `${method}: ${response.body}`); assert.match(response.headers['content-type'], /^application\/json/); if (method !== 'HEAD') assert.equal(response.json().error.code, 'NOT_FOUND');
    }
    const html = await app.inject(`/${name}.html`); assert.equal(html.statusCode, 200); assert.match(html.body, /<link rel="icon" href="\/favicon.ico"\s*\/?\s*>/);
    assert.equal((await app.inject('/healthz')).json().ok, true);
  }
});
test('favicon-store validates state, path, extension, MIME, size, hash and missing asset', async t => {
  const f = await fixture(t); assert.equal(await readFaviconState(''), null);
  const valid = { version: '0123456789abcdef', file: 'favicon-0123456789abcdef.svg', mime: 'image/svg+xml', size: 4 };
  for (const entry of [{ ...valid, file: '../private.svg' }, { ...valid, file: 'light-0123456789abcdef.svg' }, { ...valid, mime: 'text/html' }, { ...valid, size: 262145 }, { ...valid, size: 0 }, { ...valid, version: 'fedcba9876543210' }]) {
    await fs.writeFile(join(f.dir, 'favicon.json'), JSON.stringify(entry)); for (const app of [f.web, f.admin]) assert.equal((await app.inject('/favicon.ico')).statusCode, 503);
  }
  assert.throws(() => resolveFaviconFile(f.dir, { ...valid, file: '../private' }), { statusCode: 503 });
  await fs.writeFile(join(f.dir, 'favicon.json'), JSON.stringify(valid)); assert.equal((await f.web.inject('/favicon.ico')).statusCode, 503);
  await fs.writeFile(join(f.dir, valid.file), 'fake'); assert.equal((await f.web.inject('/favicon.ico')).statusCode, 503);
  await fs.writeFile(join(f.dir, 'favicon.json'), '{corrupt'); await assert.rejects(readFaviconState(f.dir), { statusCode: 503 });
});
test('favicon admin guard403/Origin/CSRF, preview isolation/headers, save/delete/revert contracts', async t => {
  const f = await fixture(t);
  assert.equal((await f.admin.inject('/api/admin/favicon')).statusCode, 403);
  const headers = await f.login(), bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" onload="synthetic()"><script>synthetic()</script></svg>'), payload = { mime: 'image/svg+xml', dataBase64: bytes.toString('base64') };
  for (const [method, url, body] of [['POST','/api/admin/favicon/preview',payload], ['PUT','/api/admin/favicon',{}], ['PUT','/api/admin/favicon/revert',{}], ['DELETE','/api/admin/favicon',{}]]) {
    for (const badHeaders of [{ ...headers, origin: 'https://outside.example.test' }, { ...headers, 'x-mailadmin-csrf': 'wrong' }]) {
      const response = await f.admin.inject({ method, url, headers: badHeaders, payload: body }); assert.equal(response.statusCode, 403); assert.equal(response.headers['www-authenticate'], undefined);
    }
  }
  const pre = await f.admin.inject({ method: 'POST', url: '/api/admin/favicon/preview', headers, payload }); assert.equal(pre.statusCode, 200, pre.body);
  const p = pre.json(), image = await f.admin.inject({ url: p.url, headers }); assert.equal(image.headers['content-security-policy'], faviconCsp); assert.equal(image.headers['x-content-type-options'], 'nosniff'); assert.equal(image.headers['cache-control'], 'no-store'); assert.deepEqual(image.rawPayload, bytes);
  const other = await f.login(); assert.equal((await f.admin.inject({ url: p.url, headers: other })).statusCode, 404);
  const get = async () => (await f.admin.inject({ url: '/api/admin/favicon', headers })).json();
  const wrongOwner = await f.admin.inject({ method: 'PUT', url: '/api/admin/favicon', headers: other, payload: { etag: (await get()).etag, previewId: p.id } }); assert.equal(wrongOwner.statusCode, 404);
  const saved = await f.admin.inject({ method: 'PUT', url: '/api/admin/favicon', headers, payload: { etag: (await get()).etag, previewId: p.id } }); assert.equal(saved.statusCode, 200, saved.body);
  for (const app of [f.web, f.admin]) assert.deepEqual((await app.inject('/favicon.ico')).rawPayload, bytes);
  const removed = await f.admin.inject({ method: 'DELETE', url: '/api/admin/favicon', headers, payload: { etag: (await get()).etag } }); assert.equal(removed.statusCode, 200); assert.equal(removed.json().current, null);
  for (const app of [f.web, f.admin]) assert.equal((await app.inject('/favicon.ico')).statusCode, 404);
  const reverted = await f.admin.inject({ method: 'PUT', url: '/api/admin/favicon/revert', headers, payload: { etag: (await get()).etag } }); assert.equal(reverted.statusCode, 200); assert.equal(reverted.json().current.version, saved.json().current.version);
  const invalid = await f.admin.inject({ method: 'POST', url: '/api/admin/favicon/preview', headers, payload: { mime: 'image/png', dataBase64: 'YQ==' } }); assert.equal(invalid.statusCode, 422);
  const oversized = await f.admin.inject({ method: 'POST', url: '/api/admin/favicon/preview', headers, payload: { mime: 'image/png', dataBase64: 'a'.repeat(410000) } }); assert.equal(oversized.statusCode, 413);
});

test('favicon audit result append failure returns500 AUDIT_RESULT_UNAVAILABLE and retains applied icon', async t => {
  const auditFs = { ...fs, async open(...args) {
    const handle = await fs.open(...args), writeFile = handle.writeFile.bind(handle);
    handle.writeFile = async data => { if (String(data).includes('"phase":"result"')) throw new Error('synthetic-audit-result-failure'); return writeFile(data); };
    return handle;
  } };
  const f = await fixture(t, auditFs), headers = await f.login(), bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>');
  const before = (await f.admin.inject({ url: '/api/admin/favicon', headers })).json();
  const pre = await f.admin.inject({ method: 'POST', url: '/api/admin/favicon/preview', headers, payload: { mime: 'image/svg+xml', dataBase64: bytes.toString('base64') } }); assert.equal(pre.statusCode, 200);
  const response = await f.admin.inject({ method: 'PUT', url: '/api/admin/favicon', headers, payload: { etag: before.etag, previewId: pre.json().id } });
  assert.equal(response.statusCode, 500); assert.equal(response.json().error.code, 'AUDIT_RESULT_UNAVAILABLE');
  for (const app of [f.web, f.admin]) { const icon = await app.inject('/favicon.ico'); assert.equal(icon.statusCode, 200); assert.deepEqual(icon.rawPayload, bytes); }
  assert.equal((await readFaviconState(f.dir)).version, faviconHash(bytes));
});

for (const [name, mime, dataBase64] of [
  ['SVG no namespace', 'image/svg+xml', 'PHN2ZyB2aWV3Qm94PSIwIDAgMzIgMzIiPjxyZWN0IHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgZmlsbD0icmVkIi8+PC9zdmc+'],
  ['PNG unknown critical chunk', 'image/png', 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAA0FBQUFiYWSARdYyAAAAGklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAO8GECAAARlDNO4AAAAASUVORK5CYII='],
]) test(`favicon evaluator ${name}: preview422 preserves state and public bytes`, async t => {
  const f = await fixture(t), headers = await f.login();
  for (const marker of ['A','B']) {
    const data = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text>${marker}</text></svg>`), pre = await f.admin.inject({ method: 'POST', url: '/api/admin/favicon/preview', headers, payload: { mime: 'image/svg+xml', dataBase64: data.toString('base64') } });
    assert.equal(pre.statusCode, 200);
    const current = (await f.admin.inject({ url: '/api/admin/favicon', headers })).json();
    assert.equal((await f.admin.inject({ method: 'PUT', url: '/api/admin/favicon', headers, payload: { etag: current.etag, previewId: pre.json().id } })).statusCode, 200);
  }
  const paths = ['favicon.json','favicon.previous.json'].map(name => join(f.dir, name)), before = await Promise.all(paths.map(path => fs.readFile(path))), bytes = (await f.web.inject('/favicon.ico')).rawPayload;
  const response = await f.admin.inject({ method: 'POST', url: '/api/admin/favicon/preview', headers, payload: { mime, dataBase64 } });
  assert.equal(response.statusCode, 422); assert.equal(response.json().error.code, 'FAVICON_TYPE');
  assert.deepEqual(await Promise.all(paths.map(path => fs.readFile(path))), before);
  for (const app of [f.web, f.admin]) assert.deepEqual((await app.inject('/favicon.ico')).rawPayload, bytes);
});
