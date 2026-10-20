import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { session } from '../../web/src/state/session.js';
import { createSignatureImageMap, signatureImageCid, deleteSignatureImage } from '../../web/src/signature-images.js';

const id = 'a'.repeat(32), other = 'b'.repeat(32);
function setup(t, handler) {
  const dom = new JSDOM(''), previous = { document: globalThis.document, fetch: globalThis.fetch, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const created = [], revoked = [], requests = [];
  globalThis.document = dom.window.document;
  session.value = { user: { email: 'sender@example.invalid' }, csrf: 'synthetic-csrf' };
  globalThis.fetch = async (path, options) => { requests.push([path, options]); return handler ? handler(path, options) : new Response('synthetic-image', { headers: { 'Content-Type': 'image/png' } }); };
  URL.createObjectURL = blob => { const url = `blob:synthetic-${created.length}`; created.push({ url, blob }); return url; };
  URL.revokeObjectURL = url => revoked.push(url);
  const map = createSignatureImageMap();
  t.after(() => { map.dispose(); session.value = null; globalThis.document = previous.document; globalThis.fetch = previous.fetch; URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke; dom.window.close(); });
  return { map, created, revoked, requests };
}
function sources(html) {
  const root = document.createElement('template'); root.innerHTML = html;
  return [...root.content.querySelectorAll('img')].map(img => img.getAttribute('src'));
}

test('canonical CID round trip maps only img src and deduplicates same asset requests', async t => {
  const { map, created, requests } = setup(t);
  const cid = signatureImageCid(id), input = `<p>${cid}</p><a href="${cid}">예시</a><img src="${cid}" width="160" alt="예시"><img src="${cid}"><img src="${signatureImageCid(other)}">`;
  const display = await map.displayHtml(input);
  assert.deepEqual(sources(display), ['blob:synthetic-0', 'blob:synthetic-0', 'blob:synthetic-1']);
  assert.equal(created.length, 2); assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(([path]) => path), [`/api/signature-images/${id}/content`, `/api/signature-images/${other}/content`]);
  assert.deepEqual(sources(map.canonicalHtml(display)), [cid, cid, signatureImageCid(other)]);
  assert.ok(display.includes(`<a href="${cid}">`)); assert.ok(display.includes('width="160" alt="예시"'));
  assert.equal(await map.urlFor(id), 'blob:synthetic-0'); assert.equal(requests.length, 2);
});

test('external, received CID and API URLs are not inferred as library images; unknown blobs reject', async t => {
  const { map, requests } = setup(t);
  const srcs = ['https://example.invalid/logo.png', 'cid:received@example.invalid', '/api/messages/123/image/1', 'cid:wm-sig-v1.bad@signature.invalid', 'CID:wm-sig-v1.' + id + '@signature.invalid'];
  const html = srcs.map(src => `<img src="${src}">`).join('');
  assert.deepEqual(sources(await map.displayHtml(html)), srcs);
  assert.deepEqual(sources(map.canonicalHtml(html)), srcs); assert.equal(requests.length, 0);
  assert.throws(() => map.canonicalHtml('<img src="blob:unregistered">'), { code: 'SIGNATURE_IMAGE_INVALID' });
  assert.throws(() => signatureImageCid('../synthetic'), { code: 'SIGNATURE_IMAGE_INVALID' });
});

test('HTML entities are parsed before exact CID matching; template images round trip', async t => {
  const { map, requests } = setup(t);
  const html = `<img src="cid&#58;wm-sig-v1.${id}@signature.invalid"><template><img src="${signatureImageCid(id)}"></template>`;
  const display = await map.displayHtml(html);
  assert.equal(requests.length, 1);
  assert.equal((display.match(/blob:synthetic-0/g) || []).length, 2);
  const canonical = map.canonicalHtml(display);
  assert.equal((canonical.match(/cid:wm-sig-v1\./g) || []).length, 2);
});

test('release and dispose revoke each blob once; disposed map rejects new projection', async t => {
  const { map, revoked } = setup(t);
  await map.urlFor(id); await map.urlFor(other);
  map.release(id); map.release(id); assert.deepEqual(revoked, ['blob:synthetic-0']);
  map.dispose(); map.dispose(); assert.deepEqual(revoked, ['blob:synthetic-0', 'blob:synthetic-1']);
  await assert.rejects(map.urlFor(id), { code: 'SIGNATURE_SESSION_CHANGED' });
  assert.throws(() => map.canonicalHtml(''), { code: 'SIGNATURE_SESSION_CHANGED' });
});

test('successful delete revokes maps; failed in-use delete keeps existing blob', async t => {
  let inUse = true;
  const { map, revoked } = setup(t, (_path, options) => options.method === 'DELETE'
    ? (inUse ? Response.json({ error: { code: 'SIGNATURE_IMAGE_IN_USE' } }, { status: 409 }) : Response.json({ revision: 'next', usedBytes: 0 }))
    : new Response('synthetic'));
  await map.urlFor(id);
  await assert.rejects(deleteSignatureImage(id, 'revision'), { code: 'SIGNATURE_IMAGE_IN_USE' });
  assert.deepEqual(revoked, []);
  inUse = false; await deleteSignatureImage(id, 'revision');
  assert.deepEqual(revoked, ['blob:synthetic-0']);
});

test('logout and account replacement revoke all blobs and remove reverse mappings', async t => {
  const { map, revoked, requests } = setup(t);
  await map.urlFor(id); session.value = null;
  assert.deepEqual(revoked, ['blob:synthetic-0']);
  assert.throws(() => map.canonicalHtml('<img src="blob:synthetic-0">'), { code: 'SIGNATURE_IMAGE_INVALID' });
  session.value = { user: { email: 'other@example.invalid' }, csrf: 'synthetic-other' };
  await map.urlFor(id); assert.equal(requests.length, 2);
  session.value = { user: { email: 'third@example.invalid' } };
  assert.deepEqual(revoked, ['blob:synthetic-0', 'blob:synthetic-1']);
});

for (const action of ['dispose', 'release', 'session']) {
  test(`late bytes after ${action} cannot create a blob or return stale display HTML`, async t => {
    let resolve;
    const { map, created } = setup(t, () => new Promise(done => { resolve = done; }));
    const pending = map.displayHtml(`<img src="${signatureImageCid(id)}">`);
    if (action === 'dispose') map.dispose();
    if (action === 'release') map.release(id);
    if (action === 'session') session.value = null;
    resolve(new Response('synthetic'));
    await assert.rejects(pending, { code: 'SIGNATURE_SESSION_CHANGED' });
    assert.equal(created.length, 0);
  });
}

test('failed content does not create a URL and next explicit attempt may retry', async t => {
  let missing = true;
  const { map, created, requests } = setup(t, () => missing ? Response.json({ error: { code: 'SIGNATURE_IMAGE_NOT_FOUND' } }, { status: 404 }) : new Response('synthetic'));
  await assert.rejects(map.urlFor(id), { code: 'SIGNATURE_IMAGE_NOT_FOUND' });
  assert.equal(created.length, 0); missing = false;
  assert.equal(await map.urlFor(id), 'blob:synthetic-0'); assert.equal(requests.length, 2);
});
