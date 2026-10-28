import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { getTemplateShare, putTemplateShare, addTemplateShareUser, templateShareSummary, copyTemplate, getTemplate, templateUnavailable } from '../../web/src/templates/api.js';
import { initialComposition } from '../../web/src/compose.js';
import { session } from '../../web/src/state/session.js';

const share = { domainAll: false, domain: 'example.invalid', users: ['person@example.invalid'], inboxReaders: ['inbox-reader@example.invalid'] };
function setup(t, handler) {
  const previous = globalThis.fetch; session.value = { user: { email: 'owner@example.invalid' }, csrf: 'synthetic' }; globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = previous; session.value = null; });
}

test('people accept names/addresses, normalize addresses, reject malformed syntax and leave account authority to the server', () => {
  assert.deepEqual(addTemplateShareUser([], '합성 이름 <Person@Example.Invalid>'), ['person@example.invalid']);
  assert.deepEqual(addTemplateShareUser(['person@example.invalid'], 'person@example.invalid'), ['person@example.invalid']);
  assert.deepEqual(addTemplateShareUser([], 'unknown@example.invalid'), ['unknown@example.invalid']);
  assert.deepEqual(addTemplateShareUser([], 'owner@example.invalid'), ['owner@example.invalid']);
  for (const value of ['', 'someone', 'anyone', 'authenticated', 'bad@example.invalid/other', 'Name <bad@example.invalid> trailing']) assert.throws(() => addTemplateShareUser([], value), { code: 'TEMPLATE_SHARE_INVALID' });
});

test('50-person limit never modifies the existing chosen array', () => {
  const users = Array.from({ length: 49 }, (_, i) => `person${i}@example.invalid`), original = [...users];
  const next = addTemplateShareUser(users, 'fiftieth@example.invalid'); assert.equal(next.length, 50);
  assert.throws(() => addTemplateShareUser(next, 'more@example.invalid'), { code: 'TEMPLATE_SHARE_INVALID' });
  assert.deepEqual(users, original);
});

test('share GET and PUT use exact fixed-folder contracts; inherited readers/domain/rights are never submitted', async t => {
  const input = { ...share, domainAll: true, rights: 'lrw', path: 'INBOX' }, original = structuredClone(input), calls = [];
  setup(t, async (path, options) => {
    calls.push(options.method); assert.equal(path, '/api/templates/share');
    assert.equal(options.headers.get('Authorization'), null);
    assert.equal(options.headers.get('X-Webmail-CSRF'), options.method === 'GET' ? null : 'synthetic');
    if (options.method === 'PUT') assert.deepEqual(JSON.parse(options.body), { domainAll: true, users: share.users });
    return Response.json(share);
  });
  assert.deepEqual(await getTemplateShare(), share); assert.deepEqual(await putTemplateShare(input), share);
  assert.deepEqual(input, original); assert.deepEqual(calls, ['GET', 'PUT']);
});

for (const [code, message] of [['TEMPLATE_SHARE_INVALID', '공유할 활성 메일 계정을 확인해 주세요.'], ['TEMPLATE_SHARE_CONFLICT', '기존 수동 공유 권한과 겹쳐요: user=person@example.invalid, group=example.invalid']]) test(`${code}: server reason/subjects are preserved and rejected saves retain the chosen list`, async t => {
  const input = { domainAll: true, users: ['alias@example.invalid', 'person@example.invalid'] }, before = structuredClone(input);
  setup(t, async () => Response.json({ error: { code, message } }, { status: 422 }));
  await assert.rejects(putTemplateShare(input), error => { assert.equal(error.code, code); assert.equal(error.message, message); return true; });
  assert.deepEqual(input, before);
});

test('share summary distinguishes chosen users/domain from inherited whole-mailbox readers', () => {
  assert.equal(templateShareSummary(share), '1명 지정 · 메일함 전체 공유 1명');
  assert.equal(templateShareSummary({ ...share, domainAll: true }), 'example.invalid 전체 · 1명 지정 · 메일함 전체 공유 1명');
  assert.equal(templateShareSummary({ ...share, users: [], inboxReaders: [] }), '아직 아무에게도 공유하지 않았어요');
});

test('shared read and copy provide only GET plus a copy request, without any source edit/delete/MOVE', async t => {
  const ref = Buffer.from(JSON.stringify(['Shared/other@example.invalid/Templates/공유', 1, 7])).toString('base64url');
  const detail = { owner: 'other@example.invalid', id: 'source', ref, name: '합성 공유본', subject: '{{고객사}}', html: '<p>{{고객사}}</p>', attachments: [] }, before = structuredClone(detail), calls = [];
  setup(t, async (path, options) => { calls.push({ path, method: options.method, body: options.body }); return Response.json(options.method === 'GET' ? detail : { owner: 'owner@example.invalid', id: 'new-id', ref: 'new-ref', name: detail.name }); });
  assert.deepEqual(await getTemplate(ref), detail);
  const copied = await copyTemplate(ref); assert.equal(copied.owner, 'owner@example.invalid'); assert.notEqual(copied.id, detail.id);
  assert.deepEqual(calls, [{ path: `/api/templates/${ref}`, method: 'GET', body: undefined }, { path: `/api/templates/${ref}/copy`, method: 'POST', body: undefined }]);
  assert.deepEqual(detail, before);
});

test('copy failure remains visible and cannot mutate the source template', async t => {
  setup(t, async () => Response.json({ error: { code: 'TEMPLATE_LIMIT', message: '내 템플릿은 200개까지 저장할 수 있어요.' } }, { status: 422 }));
  await assert.rejects(copyTemplate('synthetic-ref'), error => error.code === 'TEMPLATE_LIMIT');
});

test('withdrawn access is distinguishable from temporary errors for read-only views', () => {
  for (const code of ['TEMPLATE_NOT_FOUND', 'MESSAGE_NOT_FOUND', 'STALE_REF', 'TEMPLATE_FORBIDDEN', 'MAIL_FORBIDDEN']) assert.equal(templateUnavailable({ code }), true);
  assert.equal(templateUnavailable({ code: 'MAIL_UNAVAILABLE' }), false);
  assert.equal(templateUnavailable(null), false);
});

test('template compose seeds preserve normal initialization and existing reply/forward/draft seed behavior', () => {
  const identities = { defaultFrom: 'owner@example.invalid', identities: [{ address: 'owner@example.invalid' }] }, preferences = {}, email = 'owner@example.invalid';
  const message = { from: [{ address: 'sender@example.invalid' }], to: [{ address: email }], subject: '원문', html: '<p>원문</p>', messageId: '<original@example.invalid>', attachments: [], draftRef: 'draft-ref' };
  const fresh = initialComposition({ kind: 'new', templateRef: 'synthetic-template' }, identities, preferences, email);
  assert.equal(fresh.kind, 'new'); assert.equal(fresh.subject, ''); assert.deepEqual(fresh.to, []); assert.equal(fresh.html, '<p><br></p>');
  for (const kind of ['reply', 'replyall', 'forward', 'draft']) {
    const original = initialComposition({ kind, message }, identities, preferences, email);
    const seeded = initialComposition({ kind, message, templateRef: undefined }, identities, preferences, email);
    const { composeId: _a, ...a } = original, { composeId: _b, ...b } = seeded; assert.deepEqual(a, b);
    assert.equal(seeded.kind, kind); assert.ok(kind === 'draft' || seeded.html.includes('<blockquote>'));
    if (['reply', 'replyall'].includes(kind)) assert.equal(seeded.inReplyTo, message.messageId);
  }
});

test('sharing, read-only and composer JSX parse without a browser/build', () => {
  parse(readFileSync(new URL('../ui/templates-page.test.mjs', import.meta.url), 'utf8'), { sourceType: 'module' });
  for (const name of ['TemplateShareDialog', 'TemplatesPage', 'Composer', 'Icon']) parse(readFileSync(new URL(`../../web/src/components/${name}.jsx`, import.meta.url), 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
});
