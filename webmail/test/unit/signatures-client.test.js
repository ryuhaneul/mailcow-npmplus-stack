import { test } from 'node:test';
import assert from 'node:assert/strict';
import { session } from '../../web/src/state/session.js';
import { logout } from '../../web/src/api.js';
import { getSignatures, putSignatures, normalizeSignature, signatureError } from '../../web/src/signatures.js';
import { getSignatureImages, uploadSignatureImage, deleteSignatureImage, getSignatureImageContent } from '../../web/src/signature-images.js';
import { signatures, signatureImages, selectedSignatureId, loadSignatures, saveSignatures, loadSignatureImages, addSignatureImage, removeSignatureImage } from '../../web/src/state/signatures.js';

const id = 'a'.repeat(32);
const owner = () => ({ user: { email: 'sender@example.invalid' }, csrf: 'synthetic-csrf' });
const doc = (revision = 'list-1') => ({ revision, items: [{ id: 'client-one', name: '예시', html: '<p>예시</p>', createdAt: '2026-10-20T00:00:00.000Z' }], defaults: { 'sender@example.invalid': { newDefault: 'client-one', replyDefault: null } }, usedBytes: 100, maxBytes: 262144, notices: [] });
const library = () => ({ revision: 'images-1', images: [], usedBytes: 0, maxBytes: 1048576, maxFileBytes: 204800, maxCount: 20 });
function setup(t, handler) {
  const previous = globalThis.fetch;
  session.value = owner();
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = previous; session.value = null; });
}
function request(options, method, revision, body) {
  assert.equal(options.method, method);
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers.get('If-Match'), revision);
  assert.equal(options.headers.get('X-Webmail-CSRF'), method === 'GET' ? null : 'synthetic-csrf');
  assert.equal(options.headers.get('Authorization'), null);
  if (body) {
    assert.equal(options.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(options.body), body);
  }
}

test('list GET and PUT send exact contract; timestamps are excluded and input is preserved', async t => {
  const draft = doc(), before = structuredClone(draft), calls = [];
  setup(t, async (path, options) => { calls.push(path); request(options, calls.length === 1 ? 'GET' : 'PUT', calls.length === 1 ? null : 'list-1', calls.length === 1 ? null : { items: [{ id: 'client-one', name: '예시', html: '<p>예시</p>' }], defaults: draft.defaults }); return Response.json(doc()); });
  assert.deepEqual(await getSignatures(), doc());
  assert.deepEqual(await putSignatures(draft, 'list-1'), doc());
  assert.deepEqual(calls, ['/api/signatures', '/api/signatures']);
  assert.deepEqual(draft, before);
});

test('normalize POST sends only html, uses CSRF and returns canonical response', async t => {
  setup(t, async (path, options) => {
    assert.equal(path, '/api/signatures/normalize');
    request(options, 'POST', null, { html: '<p>원문</p>' });
    return Response.json({ html: '<p>정리</p>' });
  });
  assert.deepEqual(await normalizeSignature('<p>원문</p>'), { html: '<p>정리</p>' });
});

test('image GET, multipart POST and DELETE use separate revision and exact payload', async t => {
  const file = new File(['synthetic-image'], 'example.png', { type: 'image/png' });
  const calls = [];
  setup(t, async (path, options) => {
    calls.push(path);
    if (options.method === 'GET') { request(options, 'GET', null); return Response.json(library()); }
    request(options, options.method, options.method === 'POST' ? 'images-1' : 'images-2');
    if (options.method === 'POST') {
      assert.equal(options.headers.get('Content-Type'), null);
      assert.ok(options.body instanceof FormData);
      assert.deepEqual([...options.body.keys()], ['file']);
      const uploaded = options.body.get('file');
      assert.equal(uploaded.name, 'example.png'); assert.equal(uploaded.type, 'image/png');
      assert.equal(await uploaded.text(), 'synthetic-image');
      return Response.json({ revision: 'images-2', image: { id }, usedBytes: 15 }, { status: 201 });
    }
    assert.equal(options.body, undefined);
    return Response.json({ revision: 'images-3', usedBytes: 0 });
  });
  await getSignatureImages(); await uploadSignatureImage(file, 'images-1'); await deleteSignatureImage(id, 'images-2');
  assert.deepEqual(calls, ['/api/signature-images', '/api/signature-images', `/api/signature-images/${id}`]);
});

test('image bytes GET uses authenticated same-origin path and returns actual blob', async t => {
  setup(t, async (path, options) => {
    assert.equal(path, `/api/signature-images/${id}/content`);
    assert.deepEqual(options, { method: 'GET', credentials: 'same-origin' });
    return new Response('synthetic-bytes', { headers: { 'Content-Type': 'image/png' } });
  });
  const blob = await getSignatureImageContent(id);
  assert.equal(blob.type, 'image/png'); assert.equal(await blob.text(), 'synthetic-bytes');
});

test('saved response replaces canonical state and remaps selection/defaults without mutating draft', async t => {
  const draft = doc(), before = structuredClone(draft);
  const saved = { ...doc('list-2'), items: [{ id, name: '예시', html: '<p>정리됨</p>' }], defaults: { 'sender@example.invalid': { newDefault: id, replyDefault: null } }, idMap: { 'client-one': id } };
  setup(t, async (_path, options) => Response.json(options.method === 'GET' ? doc() : saved));
  await loadSignatures(); selectedSignatureId.value = 'client-one';
  assert.deepEqual(await saveSignatures(draft), saved);
  assert.deepEqual(signatures.value, saved); assert.equal(selectedSignatureId.value, id);
  assert.equal(signatures.value.defaults['sender@example.invalid'].newDefault, id);
  assert.deepEqual(draft, before);
});

test('image state retains limits, advances revision and deduplicates upload by returned ID', async t => {
  const seen = [], image = { id, name: 'example.png', size: 3 };
  setup(t, async (path, options) => {
    seen.push([path, options.method, options.headers.get('If-Match')]);
    if (options.method === 'GET') return Response.json({ ...library(), images: [image], usedBytes: 3 });
    return Response.json(options.method === 'POST' ? { revision: 'images-2', image, usedBytes: 3 } : { revision: 'images-3', usedBytes: 0 });
  });
  signatures.value = doc();
  await loadSignatureImages(); await addSignatureImage(new File(['abc'], 'example.png'));
  assert.deepEqual(signatureImages.value, { ...library(), revision: 'images-2', images: [image], usedBytes: 3 });
  await removeSignatureImage(id);
  assert.deepEqual(signatureImages.value, { ...library(), revision: 'images-3' });
  assert.equal(signatures.value.revision, 'list-1');
  assert.deepEqual(seen, [['/api/signature-images', 'GET', null], ['/api/signature-images', 'POST', 'images-1'], [`/api/signature-images/${id}`, 'DELETE', 'images-2']]);
});

for (const [status, code] of [[409, 'SIGNATURE_CONFLICT'], [428, 'SIGNATURE_REVISION_REQUIRED'], [422, 'SIGNATURE_DATA_IMAGE'], [503, 'SIGNATURE_SYNC_FAILED']]) {
  test(`${status} ${code} preserves canonical state, selected ID and unsaved input without retry`, async t => {
    let count = 0;
    setup(t, async () => { count++; return Response.json({ error: { code, message: 'synthetic server text' } }, { status }); });
    signatures.value = doc(); selectedSignatureId.value = 'client-one';
    const draft = doc(), before = structuredClone(draft);
    await assert.rejects(saveSignatures(draft), error => {
      assert.equal(error.code, code); assert.equal(error.reloadRequired, [409, 428].includes(status));
      assert.match(error.message, /[가-힣]/); return true;
    });
    assert.equal(count, 1); assert.deepEqual(signatures.value, doc());
    assert.equal(selectedSignatureId.value, 'client-one'); assert.deepEqual(draft, before);
  });
}

test('missing revision is omitted so server 428 is surfaced; image-in-use keeps library', async t => {
  let count = 0;
  setup(t, async (_path, options) => {
    count++;
    if (count === 1) { assert.equal(options.headers.get('If-Match'), null); return Response.json({ error: { code: 'SIGNATURE_REVISION_REQUIRED' } }, { status: 428 }); }
    return Response.json({ error: { code: 'SIGNATURE_IMAGE_IN_USE', message: 'synthetic usage' } }, { status: 409 });
  });
  await assert.rejects(putSignatures(doc()), { code: 'SIGNATURE_REVISION_REQUIRED', reloadRequired: true });
  signatureImages.value = library();
  await assert.rejects(removeSignatureImage(id), { code: 'SIGNATURE_IMAGE_IN_USE', reloadRequired: false });
  assert.deepEqual(signatureImages.value, library());
});

test('known errors have Korean action messages, unknown errors retain server message', () => {
  for (const code of ['SIGNATURE_INVALID', 'SIGNATURE_IMAGE_INVALID', 'SIGNATURE_IMAGE_NOT_FOUND', 'SIGNATURE_IMAGE_TOO_LARGE', 'SIGNATURE_MIRROR_TOO_LARGE', 'SIGNATURE_MIGRATION_TOO_LARGE']) assert.match(signatureError({ code }).message, /[가-힣]/);
  assert.equal(signatureError({ code: 'SIGNATURE_DATA_IMAGE' }).message, '이미지는 보관함에서 넣어 주세요.');
  assert.equal(signatureError({ code: 'OTHER', message: '예시 오류' }).message, '예시 오류');
});

test('session end clears list, library and selection; late list success cannot restore old account', async t => {
  let resolve;
  setup(t, () => new Promise(done => { resolve = done; }));
  signatures.value = doc(); signatureImages.value = library(); selectedSignatureId.value = 'client-one';
  const pending = loadSignatures(); session.value = owner();
  assert.equal(signatures.value, null); assert.equal(signatureImages.value, null); assert.equal(selectedSignatureId.value, null);
  resolve(Response.json(doc()));
  await assert.rejects(pending, { code: 'SIGNATURE_SESSION_CHANGED' });
  assert.equal(signatures.value, null);
});

test('logout clears canonical snapshots through existing session lifecycle', async t => {
  setup(t, async () => new Response(null, { status: 204 }));
  signatures.value = doc(); signatureImages.value = library(); selectedSignatureId.value = 'client-one';
  await logout();
  assert.equal(signatures.value, null); assert.equal(signatureImages.value, null); assert.equal(selectedSignatureId.value, null);
});

test('binary session expiry clears session and reports the original error code', async t => {
  setup(t, async () => Response.json({ error: { code: 'SESSION_EXPIRED', message: '로그인이 만료됐어요.' } }, { status: 403 }));
  await assert.rejects(getSignatureImageContent(id), { code: 'SESSION_EXPIRED' });
  assert.equal(session.value, null);
});

test('late auth error from old session cannot log out the replacement account', async t => {
  let resolve;
  setup(t, () => new Promise(done => { resolve = done; }));
  const pending = loadSignatures(), next = owner(); session.value = next;
  resolve(Response.json({ error: { code: 'SESSION_EXPIRED', message: '예전 세션 만료' } }, { status: 403 }));
  await assert.rejects(pending, { code: 'SIGNATURE_SESSION_CHANGED' });
  assert.equal(session.value, next);
});

test('current JSON session expiry clears canonical snapshots and preserves status/code', async t => {
  setup(t, async () => Response.json({ error: { code: 'NO_SESSION', message: '로그인이 필요해요.' } }, { status: 403 }));
  signatures.value = doc(); signatureImages.value = library();
  await assert.rejects(loadSignatures(), { code: 'NO_SESSION', status: 403 });
  assert.equal(session.value, null); assert.equal(signatures.value, null); assert.equal(signatureImages.value, null);
});


test('background refresh retains the editing draft revision and 409 preserves unsaved input',async t=>{
  const sent=[];
  setup(t,async(_path,options)=>{sent.push(options.headers.get('If-Match'));return Response.json({error:{code:'SIGNATURE_CONFLICT',message:'synthetic'}},{status:409});});
  signatures.value=doc('refreshed-revision');selectedSignatureId.value='client-one';
  const draft=doc('editing-revision'),before=structuredClone(draft);
  await assert.rejects(saveSignatures(draft),{code:'SIGNATURE_CONFLICT',reloadRequired:true});
  assert.deepEqual(draft,before);assert.equal(signatures.value.revision,'refreshed-revision');assert.equal(selectedSignatureId.value,'client-one');
  delete draft.revision;
  await assert.rejects(saveSignatures(draft),{code:'SIGNATURE_CONFLICT'});
  assert.deepEqual(sent,['editing-revision','refreshed-revision']);
});
