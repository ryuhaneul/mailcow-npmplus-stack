import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { transformSync } from '@babel/core';
import jsx from '@babel/plugin-transform-react-jsx';
import { JSDOM } from 'jsdom';

const id = 'a'.repeat(32), secondId = 'b'.repeat(32);
const cid = `cid:wm-sig-v1.${id}@signature.invalid`;
const image = { id, name: 'example-logo.png', contentType: 'image/png', size: 1024, width: 320, height: 80 };
const fixture = () => ({ revision: 'images-1', images: [image], usedBytes: 4096, maxBytes: 1048576, maxFileBytes: 204800, maxCount: 20 });

test('signature image library renders and operates through the S5 client', async t => {
  const hooks = registerHooks({ load(url, context, next) {
    if (url.endsWith('.jsx')) return { format: 'module', source: transformSync(readFileSync(new URL(url), 'utf8'), {
      filename: new URL(url).pathname, configFile: false, babelrc: false,
      plugins: [[jsx, { runtime: 'automatic', importSource: 'preact' }]],
    }).code, shortCircuit: true };
    return next(url, context);
  } });
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://mail.example.com', pretendToBeVisual: true });
  const originals = new Map(['window', 'document', 'fetch'].map(name => [name, globalThis[name]]));
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, revoked = [];
  let blobs = 0;
  URL.createObjectURL = () => `blob:synthetic-${++blobs}`;
  URL.revokeObjectURL = value => revoked.push(value);
  const { h, render } = await import('preact');
  const { act } = await import('preact/test-utils');
  const { session } = await import('../../web/src/state/session.js');
  const { signatureImages } = await import('../../web/src/state/signatures.js');
  const { default: Library } = await import('../../web/src/components/SignatureImageLibrary.jsx');
  const root = document.querySelector('main');
  let requests, inserted, props, handler;
  const settle = () => act(async () => { await new Promise(resolve => setImmediate(resolve)); });
  async function mount(overrides = {}, initial = fixture()) {
    await act(() => render(null, root));
    session.value = { user: { email: 'synthetic@example.com' }, csrf: 'synthetic-csrf' };
    signatureImages.value = initial;
    requests = []; inserted = []; handler = null;
    props = { targetId: 'signature-a', targetName: '회사 소개', items: [], onInsert: (...args) => inserted.push(args), ...overrides };
    globalThis.fetch = async (path, options = {}) => {
      requests.push({ path, options });
      if (handler) { const result = await handler(path, options); if (result) return result; }
      if (path.endsWith('/content')) return new Response(new Blob(['synthetic'], { type: 'image/png' }));
      if (options.method === 'POST') return Response.json({ revision: 'images-2', image: { ...image, id: secondId, name: 'new.png' }, usedBytes: 5120 }, { status: 201 });
      if (options.method === 'DELETE') return Response.json({ revision: 'images-2', usedBytes: 0 });
      return Response.json(fixture());
    };
    await act(() => render(h(Library, props), root)); await settle();
  }
  const button = text => [...root.querySelectorAll('button')].find(node => node.textContent === text);
  const click = async text => { await act(() => button(text).click()); await settle(); };
  async function choose(file) {
    const input = root.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(() => input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))); await settle();
  }
  async function address(value) {
    const input = root.querySelector('input[type=url]'); input.value = value;
    await act(() => input.dispatchEvent(new dom.window.Event('input', { bubbles: true })));
  }
  t.after(() => {
    render(null, root); session.value = null; hooks.deregister(); dom.window.close();
    URL.createObjectURL = create; URL.revokeObjectURL = revoke;
    for (const [name, value] of originals) globalThis[name] = value;
  });
  await t.test('D classes, target, thumbnail and server-calculated usage are rendered exactly', async () => {
    await mount({ items: [{ id: 'one', html: `<img src="${cid}"><img src="${cid}">` }, { id: 'two', html: `<img src="${cid}">` }] });
    assert.equal(root.querySelector('.insert-target').textContent, '넣을 곳: 회사 소개');
    assert.equal(root.querySelector('h3').textContent, '내 이미지 보관함');
    assert.equal(root.querySelector('.asset small').textContent, '1KB · 2개 서명에서 사용 중');
    assert.equal(root.querySelector('.asset img').alt, image.name);
    assert.match(root.querySelector('.asset img').src, /^blob:synthetic-/);
    assert.equal(root.querySelector('.usage').textContent, '4KB / 1MB1 / 20개');
    assert.equal(root.querySelector('.limits').textContent, '이미지당 200KB · 전체 1MB · 20개');
    assert.equal(root.querySelector('[role=progressbar]').getAttribute('aria-valuenow'), '4096');
    assert.equal(root.querySelector('.library-meter span').style.width, '0.390625%');
    assert.equal(requests.filter(request => request.path.endsWith('/content')).length, 1);
  });
  await t.test('inserts canonical asset metadata with the selected signature ID', async () => {
    await mount(); await click('서명에 넣기');
    assert.deepEqual(inserted, [[{ src: cid, alt: image.name, width: 160, assetId: id }, 'signature-a']]);
    assert.equal(root.querySelector('[role=status]').textContent, '서명에 넣었어요');
    props = { ...props, targetId: 'signature-b', targetName: '새 이름' };
    await act(() => render(h(Library, props), root)); await click('서명에 넣기');
    assert.equal(inserted[1][1], 'signature-b');
    assert.equal(root.querySelector('.insert-target-address').textContent, '새 이름');
  });
  await t.test('all unsaved drafts block deletion before making a server request', async () => {
    await mount({ items: [{ id: 'other', html: `<template><img src="${cid.replaceAll('@', '&#64;')}"></template>` }] });
    await click('삭제');
    assert.equal(root.querySelector('[role=alert] p').textContent, '1개 서명에서 사용 중이에요. 모든 서명에서 먼저 빼 주세요.');
    assert.equal(requests.some(request => request.options.method === 'DELETE'), false);
  });
  await t.test('server in-use 409 retains the asset and the server-provided names', async () => {
    await mount();
    handler = (_path, options) => options.method === 'DELETE' && Response.json({ error: { code: 'SIGNATURE_IMAGE_IN_USE', message: '회사 소개, 간단한 인사에서 사용 중이에요.' } }, { status: 409 });
    await click('삭제');
    assert.equal(root.querySelector('[role=alert] p').textContent, '회사 소개, 간단한 인사에서 사용 중이에요.');
    assert.equal(root.querySelectorAll('.asset').length, 1);
    assert.equal(button('다시 불러오기'), undefined);
  });
  await t.test('successful deletion uses the image revision and revokes the thumbnail', async () => {
    await mount(); const src = root.querySelector('.asset img').src; await click('삭제');
    const request = requests.find(request => request.options.method === 'DELETE');
    assert.equal(request.path, `/api/signature-images/${id}`);
    assert.equal(request.options.headers.get('If-Match'), 'images-1');
    assert.equal(root.querySelectorAll('.asset').length, 0); assert.ok(revoked.includes(src));
    assert.equal(root.querySelector('[role=status]').textContent, '이미지를 삭제했어요');
  });
  await t.test('upload uses multipart and shared state without inserting into a signature', async () => {
    await mount(); await click('이미지 올리기');
    await choose(new File(['synthetic'], 'new.png', { type: 'image/png' }));
    const request = requests.find(request => request.options.method === 'POST');
    assert.equal(request.path, '/api/signature-images'); assert.equal(request.options.body.get('file').name, 'new.png');
    assert.equal(request.options.headers.get('If-Match'), 'images-1');
    assert.equal(inserted.length, 0); assert.equal(root.querySelectorAll('.asset').length, 2);
    assert.equal(root.querySelector('[role=status]').textContent, '이미지를 보관함에 추가했어요');
  });
  await t.test('uploads performed by another editor immediately appear in the panel', async () => {
    await mount();
    await act(() => { signatureImages.value = { ...fixture(), revision: 'external', images: [image, { ...image, id: secondId, name: 'pasted.png' }], usedBytes: 8192 }; }); await settle();
    assert.equal(root.querySelectorAll('.asset').length, 2); assert.ok(root.textContent.includes('pasted.png'));
    assert.equal(root.querySelector('[role=progressbar]').getAttribute('aria-valuenow'), '8192');
  });
  await t.test('unsupported and oversized files show exact S5 messages and never upload', async () => {
    await mount(); await click('이미지 올리기'); await choose(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    assert.equal(root.querySelector('[role=alert] p').textContent, '보관함 이미지 또는 PNG, JPEG, GIF, WebP 파일을 확인해 주세요.');
    await choose(new File([new Uint8Array(204801)], 'large.png', { type: 'image/png' }));
    assert.equal(root.querySelector('[role=alert] p').textContent, '이미지는 한 개 200KiB, 보관함 전체 1MiB, 20개까지 올릴 수 있어요. 이미지 크기와 개수를 줄여 주세요.');
    assert.equal(requests.some(request => request.options.method === 'POST'), false);
  });
  await t.test('URL insertion validates scheme, preserves rejected input and never downloads the URL', async () => {
    await mount(); await click('주소(URL)로 넣기');
    for (const value of ['data:image/png;base64,AA==', 'javascript:alert(1)', 'not a URL', 'ftp://example.com/a.png']) {
      await address(value); await click('이미지 넣기');
      assert.equal(root.querySelector('[role=alert] p').textContent, 'http 또는 https로 시작하는 주소를 넣어 주세요.');
      assert.equal(root.querySelector('input[type=url]').value, value);
    }
    await address('https://example.com/logo.png'); await click('이미지 넣기');
    assert.deepEqual(inserted, [[{ src: 'https://example.com/logo.png', alt: '', width: 160 }, 'signature-a']]);
    assert.equal(requests.some(request => request.path.startsWith('http')), false);
    await address('http://example.com/logo.png');
    assert.equal(root.querySelector('.sig-notice').textContent, '받는 사람 화면에서 안 보일 수 있어요. 보안 연결(HTTPS)에서는 HTTP 이미지 미리보기를 표시하지 않아요.');
    assert.equal(root.querySelector('.url-form img'), null);
    await click('이미지 넣기'); assert.equal(inserted[1][0].src, 'http://example.com/logo.png');
  });
  await t.test('409 and 428 offer explicit reload while preserving URL, drafts and assets', async () => {
    for (const [code, status] of [['SIGNATURE_CONFLICT', 409], ['SIGNATURE_REVISION_REQUIRED', 428]]) {
      const items = [{ id: 'draft', html: '<p>keep original</p>' }];
      await mount({ items }); await click('주소(URL)로 넣기'); await address('https://example.com/keep.png');
      handler = (_path, options) => options.method === 'DELETE' && Response.json({ error: { code } }, { status });
      await click('삭제');
      assert.equal(root.querySelector('[role=alert] p').textContent, code === 'SIGNATURE_CONFLICT' ? '다른 곳에서 서명을 바꿨어요. 입력을 보관하고 최신 정보를 다시 불러와 주세요.' : '최신 서명 정보를 먼저 불러와 주세요.');
      assert.equal(root.querySelectorAll('.asset').length, 1); assert.equal(items[0].html, '<p>keep original</p>');
      assert.equal(root.querySelector('input[type=url]').value, 'https://example.com/keep.png');
      assert.equal(requests.some(request => request.path === '/api/signature-images' && !request.options.method), false);
      await click('다시 불러오기');
      assert.equal(root.querySelector('[role=alert]'), null);
      assert.equal(root.querySelector('input[type=url]').value, 'https://example.com/keep.png');
    }
  });
  await t.test('loading failure has retry; retry loads server usage and limits', async () => {
    await mount(); await act(() => render(null, root)); signatureImages.value = null;
    handler = path => path === '/api/signature-images' && Response.json({ error: { code: 'MAIL_UNAVAILABLE', message: '보관함을 읽을 수 없어요.' } }, { status: 503 });
    await act(() => render(h(Library, props), root)); await settle();
    assert.equal(root.querySelector('[role=alert] p').textContent, '보관함을 읽을 수 없어요.');
    handler = null; await click('다시 불러오기');
    assert.equal(root.querySelector('[role=alert]'), null); assert.equal(root.querySelectorAll('.asset').length, 1);
  });
  await t.test('pending upload announces progress and blocks duplicate actions', async () => {
    await mount(); await click('이미지 올리기'); let finish;
    handler = (_path, options) => options.method === 'POST' && new Promise(resolve => { finish = resolve; });
    await choose(new File(['synthetic'], 'new.png', { type: 'image/png' }));
    assert.equal(root.querySelector('[role=status]').textContent, '이미지를 보관함에 올리는 중…');
    assert.equal(root.querySelector('aside').getAttribute('aria-busy'), 'true'); assert.equal(button('서명에 넣기').disabled, true);
    assert.equal(button('파일 고르기').disabled, true);
    finish(Response.json({ revision: 'images-2', image: { ...image, id: secondId }, usedBytes: 5120 }, { status: 201 })); await settle();
    assert.equal(inserted.length, 0); assert.equal(root.querySelectorAll('.asset').length, 2);
  });
  await t.test('disabled state and missing target prevent insertion; unmount revokes blobs', async () => {
    await mount({ disabled: true }); assert.equal(button('서명에 넣기').disabled, true); assert.equal(button('삭제').disabled, true);
    await mount({ targetId: null, targetName: '' }); assert.equal(button('서명에 넣기').disabled, true);
    assert.equal(root.querySelector('.insert-target-address').textContent, '서명을 선택해 주세요');
    const src = root.querySelector('.asset img').src; await act(() => render(null, root)); assert.ok(revoked.includes(src));
  });
  await t.test('session replacement discards pending upload and its UI result', async () => {
    await mount(); await click('이미지 올리기'); let finish;
    handler = (_path, options) => options.method === 'POST' && new Promise(resolve => { finish = resolve; });
    await choose(new File(['synthetic'], 'new.png', { type: 'image/png' }));
    handler = null;
    await act(() => { session.value = { user: { email: 'another@example.com' }, csrf: 'another' }; }); await settle();
    finish(Response.json({ revision: 'old-account', image: { ...image, id: secondId, name: 'old-account.png' }, usedBytes: 5120 }, { status: 201 })); await settle();
    assert.equal(signatureImages.value.revision, 'images-1'); assert.equal(root.textContent.includes('old-account.png'), false);
    assert.equal(root.querySelector('[role=alert]'), null); assert.equal(inserted.length, 0);
  });
});
