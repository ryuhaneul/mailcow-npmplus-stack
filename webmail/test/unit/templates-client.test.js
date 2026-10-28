import { test } from 'node:test';
import assert from 'node:assert/strict';
import { session } from '../../web/src/state/session.js';
import { getTemplates, getTemplate, createTemplate, updateTemplate, templateAttachmentsToCompose, searchTemplates } from '../../web/src/templates/api.js';

function setup(t, handler) {
  const previous = globalThis.fetch;
  session.value = { user: { email: 'sender@example.invalid' }, csrf: 'synthetic-csrf' };
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = previous; session.value = null; });
}
function check(options, method, body) {
  assert.equal(options.method, method);
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers.get('X-Webmail-CSRF'), method === 'GET' ? null : 'synthetic-csrf');
  assert.equal(options.headers.get('Authorization'), null);
  assert.equal(options.headers.get('Content-Type'), body === undefined ? null : 'application/json');
  if (body === undefined) assert.equal(options.body, undefined);
  else assert.deepEqual(JSON.parse(options.body), body);
}

test('list and read use the session API and encode the ref as a single path segment', async t => {
  const list = { mine: [], shared: [], public: [], pins: [], limits: { max: 200 } }, item = { ref: 'ref/with?reserved#chars', subject: '안내', html: '<p>내용</p>' };
  let calls = 0;
  setup(t, async (path, options) => {
    check(options, 'GET');
    assert.equal(path, ++calls === 1 ? '/api/templates' : '/api/templates/ref%2Fwith%3Freserved%23chars');
    return Response.json(calls === 1 ? list : item);
  });
  assert.deepEqual(await getTemplates(), list);
  assert.deepEqual(await getTemplate(item.ref), item);
});

for (const update of [false, true]) test(`${update ? 'update' : 'create'} sends the template MIME manifest and preserves its input`, async t => {
  const body = { name: '예시', subject: '{{항목}} 안내', html: '<p>채운 값 {{남은칸}}</p>', attachments: [{ uploadId: 'upload-a' }, { templateRef: 'source', part: '2' }], shared: false, ...(update ? { baseUid: 7 } : {}) };
  const before = structuredClone(body), response = { id: 'synthetic-id', ref: 'new-ref', name: body.name };
  setup(t, async (path, options) => {
    assert.equal(path, update ? '/api/templates/old-ref' : '/api/templates');
    check(options, update ? 'PUT' : 'POST', body);
    return Response.json(response, { status: update ? 200 : 201 });
  });
  assert.deepEqual(await (update ? updateTemplate('old-ref', body) : createTemplate(body)), response);
  assert.deepEqual(body, before);
});

test('attachment copy returns the fresh CID html unchanged with its uploads', async t => {
  const response = { uploads: [{ id: 'fresh-upload', name: 'image.png', size: 17 }], html: '<p>{{항목}}</p><img src="cid:new-image@example.invalid">' };
  setup(t, async (path, options) => {
    assert.equal(path, '/api/templates/source%2Fref/attachments-to-compose');
    check(options, 'POST', { composeId: 'synthetic-compose' });
    return Response.json(response);
  });
  assert.deepEqual(await templateAttachmentsToCompose('source/ref', 'synthetic-compose'), response);
});

for (const [status, code] of [[409, 'TEMPLATE_CONFLICT'], [403, 'TEMPLATE_FORBIDDEN'], [413, 'ATTACH_TOO_LARGE']]) test(`API error ${status} remains available to the dialog without a retry or partial success`, async t => {
  let calls = 0;
  const error = { code, message: '합성 오류' };
  setup(t, async () => { calls++; return Response.json({ error }, { status }); });
  await assert.rejects(updateTemplate('old', { baseUid: 7 }), value => { assert.deepEqual(value, error); return true; });
  assert.equal(calls, 1);
});

test('search matches name/subject case-insensitively and preserves ordering without mutating the list', () => {
  const items = [{ name: '견적 회신', subject: 'Re: Project A' }, { name: 'Welcome', subject: '입사 안내' }, { name: 'Project B', subject: '다음 일정' }];
  const before = structuredClone(items);
  assert.deepEqual(searchTemplates(items, ' project '), [items[0], items[2]]);
  assert.deepEqual(searchTemplates(items, 'WELCOME'), [items[1]]);
  assert.deepEqual(searchTemplates(items, '안내'), [items[1]]);
  assert.deepEqual(searchTemplates(items, '없는 말'), []);
  assert.deepEqual(searchTemplates(items), items);
  assert.deepEqual(items, before);
});
