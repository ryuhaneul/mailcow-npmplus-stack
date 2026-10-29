import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { templateSaveInput, composeTemplateInsertion, refreshTemplateDefaults } from '../../web/src/templates/vars.js';
import { templateUid, templateComposeImages } from '../../web/src/templates/api.js';
import { updateCompositionHtml, composePayload } from '../../web/src/compose.js';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const dom = new JSDOM('<button id="outside"></button><section class="composer"><button id="opener"></button><input><textarea></textarea><select></select><div contenteditable="true"></div></section>'), previousDocument = globalThis.document;
globalThis.document = dom.window.document;
after(() => { globalThis.document = previousDocument; dom.window.close(); });
const nonce = 'N'.repeat(32), signature = `<!--webmail-signature:${nonce}--><div class="sig">서명<img src="cid:wm-compose-v1.synthetic@signature.invalid"></div><!--/webmail-signature:${nonce}-->`;
const quote = '<blockquote>원문<img src="cid:quoted@example.invalid"></blockquote>';
const model = { kind: 'new', composeId: 'synthetic-compose', from: 'sender@example.invalid', to: [{ address: 'first@example.invalid', name: '첫 사람' }], cc: [], bcc: [], subject: '채운 제목 {{남은칸}}', html: '<p>채운 본문 {{남은칸}}</p>' + signature + quote, signatureNonce: nonce, selectedSignatureId: 'synthetic', signatureBaseline: '<div class="sig">서명<img src="cid:wm-compose-v1.synthetic@signature.invalid"></div>', signatureImages: [], signatureImageSizes: {}, signatureImageBytes: 0, attachments: [{ id: 'uploaded-a', filename: 'example.txt', size: 7 }], forwardFiles: [{ ref: 'original-ref', partId: '2', filename: 'original.pdf', size: 11 }], inReplyTo: 'synthetic-message-id', references: 'synthetic-refs' };

test('save snapshots include authored HTML and upload IDs, omitting signature, quotes, threading and original attachments', () => {
  const before = structuredClone(model), saved = templateSaveInput(model, { name: '새 템플릿' });
  assert.deepEqual(saved, { name: '새 템플릿', subject: model.subject, html: '<p>채운 본문 {{남은칸}}</p>', attachments: [{ uploadId: 'uploaded-a' }], shared: false });
  assert.deepEqual(model, before);
  model.attachments.push({ uploading: true, filename: 'unfinished.txt' });
  assert.deepEqual(templateSaveInput(model, { name: '이름' }).attachments, [{ uploadId: 'uploaded-a' }]);
  model.attachments.pop();
});

test('overwrite retains the chosen name/shared destination and never reverses filled values into variables', () => {
  const saved = templateSaveInput(model, { name: '기존 이름', existing: { inShared: true } });
  assert.equal(saved.shared, true);
  assert.equal(saved.name, '기존 이름');
  assert.equal(saved.subject, '채운 제목 {{남은칸}}');
  assert.equal(saved.html, '<p>채운 본문 {{남은칸}}</p>');
});

test('draft signatures without live comment markers and nested reply/forward quotes are omitted from saves', () => {
  const current = { ...model, html: '<div><p>작성한 내용</p><div class="sig">저장된 서명</div><blockquote>원문<blockquote>더 옛 원문</blockquote></blockquote><p>덧붙임</p></div>' };
  assert.equal(templateSaveInput(current, { name: '안내' }).html, '<div><p>작성한 내용</p><p>덧붙임</p></div>');
});

test('baseUid decodes Unicode Templates refs and invalid refs cannot become overwrite requests', () => {
  const ref = Buffer.from(JSON.stringify(['Templates/공유', 7, 42])).toString('base64url');
  assert.equal(templateUid(ref), 42);
  for (const tuple of [['Templates', 7, 0], ['Templates', 7, '1'], ['Templates', 7, 0x100000000], ['Templates', 7]]) assert.throws(() => templateUid(Buffer.from(JSON.stringify(tuple)).toString('base64url')), { code: 'INVALID_REF' });
  for (const invalid of ['%', '', 'not-json', Buffer.from([0xff]).toString('base64url')]) assert.throws(() => templateUid(invalid), { code: 'INVALID_REF' });
});

test('display mapping accepts only the selected source URLs and fresh template CIDs, deduplicating repeated images', () => {
  const source = '/api/messages/synthetic-ref/parts/2?inline=1';
  const template = { ref: 'synthetic-ref', html: `<p><img src="${source}"><img src="${source}"><img src="https://external.example.invalid/image.png"><img src="/api/messages/another/parts/2?inline=1"></p>` };
  const html = '<p><img src="cid:wm-template-v1.fresh@template.invalid"><img src="cid:wm-template-v1.fresh@template.invalid"><img src="cid:wm-template-v1.external@template.invalid"><img src="cid:wm-template-v1.other@template.invalid"></p>';
  assert.deepEqual([...templateComposeImages(template, html)], [['wm-template-v1.fresh@template.invalid', source]]);
});

test('compose integration inserts returned CID HTML, fills defaults, reconciles signature metadata and emits every uploaded ID', () => {
  const template = { subject: '{{받는사람이름}} 안내', html: '<p>reader html must not be inserted</p>' };
  const returned = { uploads: [{ id: 'copied-a', name: 'image.png', size: 17 }], html: '<p>{{받는사람이름}} {{항목}}</p><img src="cid:wm-template-v1.fresh@template.invalid">' };
  const patch = composeTemplateInsertion(model, template, { mode: 'replace', html: returned.html, uploads: returned.uploads.map(file => ({ ...file, filename: file.name })) }, { to: model.to, from: model.from }).patch;
  const reconciled = updateCompositionHtml(model, patch.html).patch;
  const next = { ...model, ...patch, ...reconciled };
  assert.equal(next.signatureDirty, false);
  assert.equal(next.html.slice(next.signatureRange.start, next.signatureRange.end), signature);
  assert.ok(next.html.startsWith('<div class="tplA-tbody"><p>첫 사람 {{항목}}</p><img src="cid:wm-template-v1.fresh@template.invalid"></div>'));
  assert.ok(next.html.endsWith(quote));
  assert.deepEqual(composePayload(next, true).attachmentIds, ['uploaded-a', 'copied-a']);
  assert.deepEqual(next.to, model.to);
  assert.equal(next.inReplyTo, model.inReplyTo);
  assert.equal(next.references, model.references);
});



test('changed JSX parses without a build or browser', () => {
  for (const name of ['Composer', 'TemplatePicker', 'TemplateSaveDialog']) parse(readFileSync(new URL(`../../web/src/components/${name}.jsx`, import.meta.url), 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
});

test('appending fills only the inserted region, preserving existing authored/subject/signature variables during default refresh', () => {
  const current = { ...model, subject: '{{받는사람이름}} 기존 제목', html: '<p>{{받는사람이름}} 기존 문장</p>' + signature.replace('서명', '{{받는사람이름}} 서명') + quote };
  const inserted = composeTemplateInsertion(current, { subject: '{{내이름}} 템플릿 제목', html: '<p>{{받는사람이름}} 새 내용</p>' }, { mode: 'append' }, { to: model.to });
  assert.equal(inserted.patch.subject, current.subject);
  assert.ok(inserted.patch.html.startsWith('<p>{{받는사람이름}} 기존 문장</p><div class="tplA-tbody"><p>첫 사람 새 내용</p></div>'));
  assert.ok(inserted.patch.html.includes('{{받는사람이름}} 서명'));
  const refreshed = refreshTemplateDefaults(inserted.patch, inserted.patch.templateState, { to: [{ name: '새 사람', address: 'new@example.invalid' }] });
  assert.equal(refreshed.subject, current.subject);
  assert.ok(refreshed.html.includes('<p>새 사람 새 내용</p>'));
  assert.ok(refreshed.html.includes('<p>{{받는사람이름}} 기존 문장</p>'));
  assert.ok(refreshed.html.includes('{{받는사람이름}} 서명'));
});

test('reply subject placeholders and quoted placeholders are preserved while the inserted body is filled', () => {
  const current = { ...model, kind: 'reply', subject: 'Re: {{받는사람이름}}', html: '<p><br></p>' + signature + quote };
  const result = composeTemplateInsertion(current, { subject: '다른 제목', html: '<p>{{받는사람이름}}</p>' }, {}, { to: model.to });
  assert.equal(result.patch.subject, current.subject);
  assert.ok(result.patch.html.startsWith('<div class="tplA-tbody"><p>첫 사람</p></div>'));
  assert.ok(result.patch.html.endsWith(quote));
});


test('company template insertion uses returned HTML and ordinary upload IDs without CID image downloads', () => {
  const company={owner:'public',id:'1',ref:btoa(JSON.stringify(['PublicTemplates/1',1,1])),name:'회사 공용',subject:'{{오늘}} 안내',html:'<p>{{받는사람이름}} 님께</p><img src="https://example.invalid/logo.png">',attachments:[{part:'11',name:'public.txt',size:3,type:'text/plain'}]};
  assert.deepEqual([...templateComposeImages(company,company.html)],[]);
  const current={...model,subject:'',html:'<p><br></p>'+signature,attachments:[]},before=structuredClone(current);
  const result=composeTemplateInsertion(current,company,{html:company.html,uploads:[{id:'copied-public',filename:'public.txt',size:3}]},{to:model.to});
  assert.equal(result.patch.attachments.at(-1).id,'copied-public');assert.ok(result.patch.html.includes('첫 사람 님께'));assert.ok(result.patch.html.includes('https://example.invalid/logo.png'));assert.ok(result.patch.html.indexOf('첫 사람')<result.patch.html.indexOf('합성 서명')||result.patch.html.indexOf('첫 사람')<result.patch.html.indexOf('서명'));
  assert.deepEqual(current,before);
});
