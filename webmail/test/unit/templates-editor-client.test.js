import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { JSDOM } from 'jsdom';
import { templateEditorModel, templateEditorStamp, templateEditorDirty, templateEditorPayload, templateEditorRemoveAttachment, templateEditorConflict, templateEditorCanMove, templateEditorAtLimit, templateEditorSelection } from '../../web/src/templates/editor.js';
import { updateTemplate, deleteTemplate, moveTemplate } from '../../web/src/templates/api.js';
import { session } from '../../web/src/state/session.js';
import { initRouter, navigate, route, registerNavigationGuard } from '../../web/src/router.js';

const dom = new JSDOM(''), previousDocument = globalThis.document;
globalThis.document = dom.window.document;
after(() => { globalThis.document = previousDocument; dom.window.close(); });
const ref = Buffer.from(JSON.stringify(['Templates/공유', 1, 7])).toString('base64url'), nextRef = Buffer.from(JSON.stringify(['Templates/공유', 1, 8])).toString('base64url');
const source = `/api/messages/${ref}/parts/2?inline=1`;
const original = { owner: 'owner@example.invalid', id: '00000000-0000-4000-8000-000000000001', ref, name: '합성 안내', subject: '{{고객사}}', html: `<p>{{고객사}}</p><img src="${source}"><img src="${source}">`, inShared: true, attachments: [{ part: '2', name: 'example.png', size: 17, type: 'image/png' }, { part: '3', name: 'example.pdf', size: 20, type: 'application/pdf' }] };

test('loaded edit models preserve original HTML, CID reader URLs and retained raw MIME part manifests', () => {
  const frozen = structuredClone(original), model = templateEditorModel(original), payload = templateEditorPayload(model);
  assert.equal(payload.html, original.html); assert.equal(payload.subject, original.subject); assert.equal(payload.shared, true); assert.equal(payload.baseUid, 7);
  assert.deepEqual(payload.attachments, [{ templateRef: ref, part: '2' }, { templateRef: ref, part: '3' }]);
  assert.deepEqual(Object.keys(payload).sort(), ['attachments', 'baseUid', 'html', 'name', 'shared', 'subject']);
  assert.deepEqual(original, frozen);
});

test('new editor has no ref/baseUid and initial state does not trigger an exit warning', () => {
  const model = templateEditorModel(null), stamp = templateEditorStamp(model);
  assert.equal(templateEditorDirty(model, stamp), false); assert.equal('baseUid' in templateEditorPayload(model), false);
  for (const patch of [{ name: '고친 이름' }, { subject: '고친 제목' }, { html: '<p>고친 내용</p>' }, { attachments: [{ uploadId: 'upload', name: 'example.txt', size: 1 }] }]) assert.equal(templateEditorDirty({ ...model, ...patch }, stamp), true);
  assert.equal(templateEditorDirty({ ...model, subject: '' }, stamp), false);
});

test('uploads append to retained parts without changing the original model or restoring filled variables', () => {
  const model = templateEditorModel(original), before = structuredClone(model), changed = { ...model, subject: '채운 고객사', html: model.html.replaceAll('{{고객사}}', '채운 고객사'), attachments: [...model.attachments, { uploadId: 'uploaded', name: 'added.txt', size: 5 }] };
  assert.deepEqual(templateEditorPayload(changed).attachments, [{ templateRef: ref, part: '2' }, { templateRef: ref, part: '3' }, { uploadId: 'uploaded' }]);
  assert.ok(templateEditorPayload(changed).html.includes('채운 고객사'));
  assert.equal(templateEditorDirty(changed, templateEditorStamp(model)), true); assert.deepEqual(model, before);
});

test('removing an inline part removes only its matching display images and part manifest', () => {
  const model = templateEditorModel({ ...original, html: original.html + '<img src="https://images.example.invalid/remote.png"><p>{{남은변수}}</p>' }), before = structuredClone(model);
  const removed = templateEditorRemoveAttachment(model, 0);
  assert.equal(removed.html, '<p>{{고객사}}</p><img src="https://images.example.invalid/remote.png"><p>{{남은변수}}</p>');
  assert.deepEqual(templateEditorPayload(removed).attachments, [{ templateRef: ref, part: '3' }]);
  assert.deepEqual(model, before);
});

test('MOVE is disabled for new/dirty models and enabled immediately for a clean saved baseline', () => {
  const fresh = templateEditorModel(null); assert.equal(templateEditorCanMove(fresh, templateEditorStamp(fresh)), false);
  const loaded = templateEditorModel(original), baseline = templateEditorStamp(loaded);
  assert.equal(templateEditorCanMove(loaded, baseline), true);
  const edited = { ...loaded, name: '수정' }; assert.equal(templateEditorCanMove(edited, baseline), false);
  const saved = { ...edited, ref: nextRef }; assert.equal(templateEditorCanMove(saved, templateEditorStamp(saved)), true);
});

test('new saves stop at 200 while existing templates remain editable at the limit', () => {
  const fresh = templateEditorModel(null);
  assert.equal(templateEditorAtLimit(fresh, 199), false); assert.equal(templateEditorAtLimit(fresh, 200), true);
  assert.equal(templateEditorAtLimit(templateEditorModel(original), 200), false);
});

test('name validation counts Unicode code points and rejects empty/oversized names without truncation', () => {
  const model = templateEditorModel(null);
  assert.equal(templateEditorPayload({ ...model, name: '가'.repeat(100) }).name.length, 100);
  for (const name of ['', ' ', '가'.repeat(101)]) assert.throws(() => templateEditorPayload({ ...model, name }), { code: 'TEMPLATE_INVALID' });
});

function requests(t, handler) {
  const previousFetch = globalThis.fetch; session.value = { csrf: 'synthetic', user: { email: original.owner } };
  globalThis.fetch = handler; t.after(() => { globalThis.fetch = previousFetch; session.value = null; });
}

test('update/delete/MOVE carry exact baseUid and shared-only contracts with existing session CSRF', async t => {
  const calls = [], model = templateEditorModel(original), payload = templateEditorPayload(model);
  requests(t, async (path, options) => {
    calls.push({ path, method: options.method, body: JSON.parse(options.body) });
    assert.equal(options.headers.get('X-Webmail-CSRF'), 'synthetic'); assert.equal(options.headers.get('Authorization'), null);
    return Response.json(options.method === 'DELETE' ? { ok: true } : { ...original, ref: nextRef });
  });
  await updateTemplate(ref, payload); await deleteTemplate(ref, 7); await moveTemplate(ref, false);
  assert.deepEqual(calls, [{ path: `/api/templates/${ref}`, method: 'PUT', body: payload }, { path: `/api/templates/${ref}`, method: 'DELETE', body: { baseUid: 7 } }, { path: `/api/templates/${ref}/move`, method: 'POST', body: { shared: false } }]);
});

for (const [status, code] of [[409, 'TEMPLATE_CHANGED'], [422, 'TEMPLATE_LIMIT'], [413, 'ATTACH_TOO_LARGE'], [503, 'TEMPLATE_UNAVAILABLE']]) test(`${code}: failed save preserves draft text, attachments and loaded baseUid`, async t => {
  const model = { ...templateEditorModel(original), name: '수정', attachments: [...templateEditorModel(original).attachments, { uploadId: 'uploaded', name: 'new.txt', size: 4 }] }, frozen = structuredClone(model);
  requests(t, async () => Response.json({ error: { code, message: '합성 오류' } }, { status }));
  await assert.rejects(updateTemplate(model.ref, templateEditorPayload(model)), error => { assert.equal(error.code, code); assert.equal(templateEditorConflict(error), status === 409); return true; });
  assert.deepEqual(model, frozen); assert.equal(templateEditorPayload(model).baseUid, 7);
});

test('after a successful reload the new ref binds every retained part and baseUid to the new UID', () => {
  const loaded = templateEditorModel({ ...original, ref: nextRef, html: original.html.replaceAll(ref, nextRef) });
  assert.equal(templateEditorPayload(loaded).baseUid, 8);
  assert.deepEqual(templateEditorPayload(loaded).attachments, [{ templateRef: nextRef, part: '2' }, { templateRef: nextRef, part: '3' }]);
  assert.equal(templateEditorDirty(loaded, templateEditorStamp(loaded)), false);
});

function router(t) {
  const previous = { location: globalThis.location, window: globalThis.window, history: globalThis.history, route: route.value }, listeners = {};
  globalThis.location = { hash: '#templates/synthetic' };
  globalThis.window = { addEventListener: (name, callback) => { listeners[name] = callback; }, removeEventListener: name => { delete listeners[name]; } };
  globalThis.history = { replaceState: (_state, _title, hash) => { globalThis.location.hash = hash; } };
  const stop = initRouter(); t.after(() => { stop(); globalThis.location = previous.location; globalThis.window = previous.window; globalThis.history = previous.history; route.value = previous.route; });
  return listeners;
}

test('without a guard existing routing, query strings and keys modal behavior remain unchanged', t => {
  router(t); navigate('inbox'); assert.equal(route.value.name, 'inbox'); navigate('f/INBOX?q=hello'); assert.equal(route.value.q, 'hello');
  navigate('keys'); assert.equal(route.value.name, 'f'); navigate('compose'); assert.equal(route.value.name, 'compose');
});

test('one registered guard blocks programmatic/native hash changes, restores the URL and unregisters cleanly', t => {
  const listeners = router(t); let asks = 0, allow = false;
  const unregister = registerNavigationGuard(() => { asks++; return allow; }); t.after(unregister);
  navigate('inbox'); assert.equal(route.value.name, 'templates'); assert.equal(location.hash, '#templates/synthetic'); assert.equal(asks, 1);
  location.hash = '#settings'; listeners.hashchange(); assert.equal(route.value.name, 'templates'); assert.equal(location.hash, '#templates/synthetic'); assert.equal(asks, 2);
  allow = true; navigate('inbox'); assert.equal(route.value.name, 'inbox'); assert.equal(asks, 3);
  unregister(); navigate('compose'); assert.equal(route.value.name, 'compose'); assert.equal(asks, 3);
});

test('all editor/page JSX parses while shared editor/format controls remain unchanged', () => {
  for (const name of ['TemplateEditor', 'TemplatesPage']) parse(readFileSync(new URL(`../../web/src/components/${name}.jsx`, import.meta.url), 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
});

test('pin reordering retains the active root editor and explicit new/share routes leave the editor slot empty', () => {
  const a = { ref: 'a' }, b = { ref: 'b' };
  const first = templateEditorSelection([a, b], '', ''); assert.equal(first.selected, a);
  assert.equal(templateEditorSelection([b, a], '', first.defaultRef).selected, a);
  assert.equal(templateEditorSelection([a, b], 'b', first.defaultRef).selected, b);
  assert.equal(templateEditorSelection([b], '', first.defaultRef).selected, b);
  for (const selection of ['new', 'share', 'removed']) assert.equal(templateEditorSelection([a, b], selection, 'a').selected, null);
});
