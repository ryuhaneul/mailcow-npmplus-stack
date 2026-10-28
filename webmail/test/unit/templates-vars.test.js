import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { templateVariables, unfilledTemplateVariables, templateDefaults, fillTemplate, createTemplateVariables, updateTemplateVariables, refreshTemplateDefaults, beginTemplateVariableEdit, cancelTemplateVariableEdit, insertTemplate } from '../../web/src/templates/vars.js';
import { sanitizeComposeHtml } from '../../server/mail/sanitize.js';
import { updateCompositionHtml } from '../../web/src/compose.js';

const dom = new JSDOM(''), previousDocument = globalThis.document;
globalThis.document = dom.window.document;
after(() => { globalThis.document = previousDocument; dom.window.close(); });
const context = { to: [{ name: '첫 사람', address: 'first@example.invalid' }, { name: '두 번째', address: 'second@example.invalid' }], from: 'sender@example.invalid', identities: [{ name: '보내는 이', address: 'sender@example.invalid' }], now: new Date('2026-10-27T15:00:00Z') };
const nextContext = { ...context, to: [{ name: '새 사람', address: 'new@example.invalid' }], from: 'other@example.invalid', identities: [{ name: '다른 이름', address: 'other@example.invalid' }] };
const nonce = 'N'.repeat(32);
const signature = `<!--webmail-signature:${nonce}--><div class="sig"><p>내 서명</p><img src="cid:signature@example.invalid"></div><!--/webmail-signature:${nonce}-->`;
const quote = '<blockquote><p>원문 {{인용}}</p><img src="cid:quoted@example.invalid"></blockquote>';
const model = (patch = {}) => ({ kind: 'new', subject: '', html: '<p><br></p>' + signature, signatureNonce: nonce, attachments: [{ id: 'old-file', name: 'old.txt' }], from: 'sender@example.invalid', to: context.to, inReplyTo: 'message-id', references: 'refs', ...patch });
const template = { subject: '{{오늘}} 안내', html: '<p>{{받는사람이름}} 님, {{항목}} 안내입니다.</p>' };

test('valid names use Korean, English, numbers, spaces and underscore, with exact 1–30 bounds', () => {
  assert.deepEqual(templateVariables({ subject: '{{이름}} {{A_1 name}} {{ 이름 }} {{}} {{a-b}} {{a.b}} {{' + 'a'.repeat(30) + '}} {{' + 'b'.repeat(31) + '}}', html: '<p>{{이름}}</p>' }), ['이름', 'A_1 name', ' 이름 ', 'a'.repeat(30)]);
});
for (const html of [
  '<p title="{{속성}}" style="color:{{스타일}}">{{본문}}</p>',
  '<a href="https://example.invalid/{{주소}}">{{본문}}</a><img alt="{{이미지}}" src="cid:{{CID}}">',
  '<style>p{color:{{CSS}}}</style><script>{{스크립트}}</script><p>{{본문}}</p>',
  '<blockquote>{{인용}}<p>{{인용2}}</p></blockquote><p>{{본문}}</p>',
  '<p>https://example.invalid/{{URL}} www.example.invalid/{{URL2}} //example.invalid/{{URL3}} mailto:{{메일}} {{본문}}</p>',
  '<p>https://example.invalid/{{URL with spaces}} {{본문}}</p>',
]) test(`recognition and warning ignore protected contexts: ${html}`, () => {
  const current = { subject: '제목 {{제목}} https://example.invalid/{{제목URL}}', html };
  assert.deepEqual(templateVariables(current), ['제목', '본문']);
  assert.deepEqual(unfilledTemplateVariables(current), ['제목', '본문']);
  const filled = fillTemplate(current, { 제목: '채움', 본문: '내용' });
  assert.deepEqual(unfilledTemplateVariables(filled), []);
});

test('text replacement escapes markup, preserves attributes/styles/quotes/CID, and never recursively expands values', () => {
  const value = '<img src=x onerror="bad()"> & {{또다른변수}}';
  const current = { subject: '{{이름}}', html: '<style>p{color:{{색}}}</style><p title="{{이름}}">{{이름}}</p><blockquote>{{이름}}</blockquote><img src="cid:old@example.invalid">' };
  const filled = fillTemplate(current, { 이름: value, 색: 'red' });
  const root = document.createElement('div'); root.innerHTML = filled.html;
  assert.equal(root.querySelector('p').textContent, value);
  assert.equal(root.querySelector('p').getAttribute('title'), '{{이름}}');
  assert.equal(root.querySelectorAll('img').length, 1);
  assert.equal(root.querySelector('blockquote').textContent, '{{이름}}');
  assert.equal(root.querySelector('style').textContent, 'p{color:{{색}}}');
  assert.equal(filled.subject, value);
});

test('prototype-shaped variable names stay unresolved unless explicitly supplied', () => {
  const current = { subject: '{{constructor}} {{__proto__}} {{toString}}', html: '<p>{{__proto__}}</p>' };
  assert.deepEqual(fillTemplate(current, {}), current);
  const initialized = createTemplateVariables(current, context);
  const changed = updateTemplateVariables(initialized, initialized.state, { ['__proto__']: '직접 입력' });
  assert.equal(changed.html, '<p>직접 입력</p>');
  assert.equal(changed.subject, '{{constructor}} 직접 입력 {{toString}}');
});

test('KST date boundary and selected identity/first recipient defaults are exact', () => {
  assert.deepEqual(templateDefaults(context), { 받는사람이름: '첫 사람', 오늘: '2026-10-28', 내이름: '보내는 이', 내주소: 'sender@example.invalid' });
  assert.equal(templateDefaults({ ...context, now: new Date('2026-10-27T14:59:59Z') }).오늘, '2026-10-27');
  assert.equal(templateDefaults({ ...context, to: [{ address: 'local@example.invalid' }] }).받는사람이름, 'local');
  assert.equal(templateDefaults({ ...context, from: 'SENDER@EXAMPLE.INVALID' }).내이름, '보내는 이');
  assert.deepEqual(templateDefaults({ now: context.now }), { 받는사람이름: '', 오늘: '2026-10-28', 내이름: '', 내주소: '' });
});

test('default refresh changes unedited builtins only, preserving manually set empty and nonempty values', () => {
  const current = { subject: '{{오늘}} {{내이름}}', html: '<p>{{받는사람이름}} {{내주소}}</p><p>{{항목}}</p>' };
  const initial = createTemplateVariables(current, context);
  const manual = updateTemplateVariables(initial, initial.state, { 받는사람이름: '수동 이름', 내주소: '', 항목: '수동 항목' });
  const before = structuredClone(manual);
  const refreshed = refreshTemplateDefaults(manual, manual.state, nextContext);
  assert.equal(refreshed.subject, '2026-10-28 다른 이름');
  assert.equal(refreshed.html, '<p>수동 이름 {{내주소}}</p><p>수동 항목</p>');
  assert.deepEqual(manual, before);
  assert.deepEqual(refreshed.state.manual, ['받는사람이름', '내주소', '항목']);
});

test('edited sentences and subject detach permanently; unedited text nodes continue updating', () => {
  const initial = createTemplateVariables({ subject: '{{내이름}} 안내', html: '<p>{{받는사람이름}} 님 안녕</p><p>{{내이름}}</p>' }, context);
  const edited = { subject: '직접 수정 제목', html: initial.html.replace('첫 사람 님 안녕', '내가 고친 문장') };
  const refreshed = refreshTemplateDefaults(edited, initial.state, nextContext);
  assert.equal(refreshed.subject, edited.subject);
  assert.equal(refreshed.html, '<p>내가 고친 문장</p><p>다른 이름</p>');
  const again = refreshTemplateDefaults(refreshed, refreshed.state, context);
  assert.equal(again.html, '<p>내가 고친 문장</p><p>보내는 이</p>');
  assert.equal(again.subject, edited.subject);
});

test('removed nodes and nodes moved into quotes are not regenerated', () => {
  const initial = createTemplateVariables({ subject: '', html: '<p>{{내이름}}</p><p>{{내주소}}</p>' }, context);
  for (const html of ['<p>다른 내용</p>', '<blockquote><p>보내는 이</p></blockquote><p>다른 내용</p>']) {
    assert.equal(refreshTemplateDefaults({ subject: '', html }, initial.state, nextContext).html, html);
  }
});

test('dialog close/reopen keeps live values; cancellation restores a deep snapshot without leaking edits', () => {
  const initial = createTemplateVariables(template, context);
  const snapshot = beginTemplateVariableEdit(initial, initial.state);
  const draft = updateTemplateVariables(initial, initial.state, { 항목: '취소할 값', 받는사람이름: '임시 이름' });
  const reopened = beginTemplateVariableEdit(draft, draft.state);
  assert.equal(reopened.state.values.항목, '취소할 값');
  const restored = cancelTemplateVariableEdit(snapshot);
  assert.deepEqual(restored, initial);
  restored.state.values.항목 = '또 바꿈';
  assert.equal(snapshot.state.values.항목, undefined);
  assert.deepEqual(cancelTemplateVariableEdit(snapshot), initial);
});

test('editor/HTML normalization round trip keeps unresolved tokens; saving uses filled content without inverse restoration', () => {
  const initial = createTemplateVariables({ subject: '{{항목}}', html: '<p>{{받는사람이름}} {{항목}}</p>' }, context);
  const normalized = sanitizeComposeHtml(initial.html);
  assert.equal(normalized, '<p>첫 사람 {{항목}}</p>');
  const switched = refreshTemplateDefaults({ ...initial, html: normalized }, initial.state, nextContext);
  assert.equal(switched.html, '<p>새 사람 {{항목}}</p>');
  const saved = fillTemplate(switched, { 항목: '견적' });
  assert.equal(saved.html, '<p>새 사람 견적</p>');
  assert.deepEqual(templateVariables(saved), []);
});

for (const kind of ['new', 'draft', 'reply', 'replyall', 'forward']) {
  test(`${kind}: insertion requests confirmation for authored content and cancellation leaves the entire model unchanged`, () => {
    const current = model({ kind, html: '<p>작성 내용</p>' + signature + quote }), frozen = structuredClone(current);
    assert.deepEqual(insertTemplate(current, template), { confirmationRequired: true, patch: null });
    assert.deepEqual(current, frozen);
  });
  for (const mode of ['replace', 'append']) test(`${kind}: ${mode} stays before signature/quote, adds attachments and preserves address/thread fields`, () => {
    const current = model({ kind, subject: '기존 제목', html: '<p>작성 내용</p>' + signature + quote }), frozen = structuredClone(current);
    const uploadedHtml = '<p>새 내용</p><img src="cid:new-copy@example.invalid">';
    const result = insertTemplate(current, template, { mode, html: uploadedHtml, uploads: [{ id: 'new-file', name: 'new.png' }] });
    assert.equal(result.confirmationRequired, false);
    assert.equal(result.patch.html, (mode === 'append' ? '<p>작성 내용</p>' : '') + uploadedHtml + signature + quote);
    assert.equal(result.patch.subject, mode === 'replace' && kind === 'new' ? template.subject : '기존 제목');
    assert.deepEqual(result.patch.attachments, [...current.attachments, { id: 'new-file', name: 'new.png' }]);
    assert.deepEqual(Object.keys(result.patch).sort(), ['attachments', 'html', 'subject']);
    assert.deepEqual(current, frozen);
  });
}

test('empty editor inserts at top without confirmation and reply/forward keep even an empty subject', () => {
  for (const kind of ['new', 'draft', 'reply', 'replyall', 'forward']) {
    const result = insertTemplate(model({ kind, html: '<p><br></p>' + signature + quote }), template);
    assert.equal(result.confirmationRequired, false);
    assert.equal(result.patch.html, template.html + signature + quote);
    assert.equal(result.patch.subject, ['new', 'draft'].includes(kind) ? template.subject : '');
  }
});

test('contentful image/table requires confirmation, while signature-only legacy content does not', () => {
  for (const html of ['<img src="cid:authored@example.invalid">', '<table><tbody><tr><td></td></tr></tbody></table>']) assert.equal(insertTemplate(model({ html }), template).confirmationRequired, true);
  const legacy = '<!--webmail-signature--><div class="sig">옛 서명</div><!--/webmail-signature-->';
  assert.equal(insertTemplate(model({ signatureNonce: undefined, html: legacy }), template).patch.html, template.html + legacy);
});

test('replace preserves nested signature/quote and clears all authored content around them', () => {
  const current = model({ html: '<div><p>작성</p>' + signature + '<p>서명 뒤 작성</p>' + quote + '</div><p>끝 작성</p>' });
  const result = insertTemplate(current, template, { mode: 'replace' });
  assert.equal(result.patch.html, '<div>' + template.html + signature + quote + '</div>');
});

test('signature metadata can be reconciled by the existing compose helper without changing signature content', () => {
  const current = model({ selectedSignatureId: 'synthetic', signatureBaseline: '<div class="sig"><p>내 서명</p><img src="cid:signature@example.invalid"></div>', signatureImages: [], signatureImageSizes: {} });
  const inserted = insertTemplate(current, template).patch;
  const reconciled = updateCompositionHtml(current, inserted.html).patch;
  assert.equal(reconciled.signatureDirty, false);
  assert.equal(reconciled.html.slice(reconciled.signatureRange.start, reconciled.signatureRange.end), signature);
});

test('unknown insertion mode is rejected without model mutation', () => {
  assert.throws(() => insertTemplate(model(), template, { mode: 'unexpected' }), TypeError);
});

for (const kind of ['new', 'draft', 'reply', 'replyall', 'forward']) test(`${kind}: append fills only eligible empty subjects and keeps nonempty subjects`, () => {
  for (const subject of ['', '작성한 제목']) {
    const result = insertTemplate(model({ kind, subject }), template, { mode: 'append' });
    assert.equal(result.patch.subject, !subject && ['new', 'draft'].includes(kind) ? template.subject : subject);
  }
});
