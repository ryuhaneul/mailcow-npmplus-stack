import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { JSDOM } from 'jsdom';
import { templateVariableValue, createTemplateVariables, updateTemplateVariables, refreshTemplateDefaults, prepareTemplateVariables, templateSendWarnings, beginTemplateVariableEdit, cancelTemplateVariableEdit, composeTemplateInsertion } from '../../web/src/templates/vars.js';

const dom = new JSDOM(''), previous = globalThis.document;
globalThis.document = dom.window.document;
after(() => { globalThis.document = previous; dom.window.close(); });
const context = (name, from, now = new Date('2026-10-27T15:00:00Z')) => ({ to: [{ name, address: `${name}@example.invalid` }], from, identities: [{ address: from, name: from.split('@')[0] }], now });

test('every To/From change refreshes defaults, retaining manual fields, edited sentences and insertion date', () => {
  let current = createTemplateVariables({ subject: '{{내이름}} {{오늘}}', html: '<p>{{받는사람이름}}</p><p>{{내주소}}</p><p>{{항목}}</p>' }, context('first', 'sender@example.invalid'));
  current = updateTemplateVariables(current, current.state, { 항목: '견적' });
  for (const [name, from] of [['second', 'alias@example.invalid'], ['third', 'other@example.invalid'], ['fourth', 'sender@example.invalid']]) {
    current = refreshTemplateDefaults(current, current.state, context(name, from, new Date('2026-10-29T15:00:00Z')));
    assert.equal(current.subject, `${from.split('@')[0]} 2026-10-28`);
    assert.equal(current.html, `<p>${name}</p><p>${from}</p><p>견적</p>`);
  }
  const edited = { subject: '직접 바꾼 제목', html: current.html.replace('<p>fourth</p>', '<p>직접 바꾼 문장</p>') };
  current = refreshTemplateDefaults(edited, current.state, context('fifth', 'final@example.invalid'));
  assert.equal(current.subject, edited.subject);
  assert.equal(current.html, '<p>직접 바꾼 문장</p><p>final@example.invalid</p><p>견적</p>');
  current = refreshTemplateDefaults(current, current.state, context('sixth', 'six@example.invalid'));
  assert.equal(current.subject, edited.subject);
  assert.equal(current.html, '<p>직접 바꾼 문장</p><p>six@example.invalid</p><p>견적</p>');
});

test('warnings share recognition boundaries and identify title, body and both locations accurately', () => {
  const warnings = templateSendWarnings({ subject: '{{제목}} {{둘다}} https://example.invalid/{{URL}}', html: '<style>p{color:{{STYLE}}}</style><p title="{{속성}}">{{본문}} {{둘다}} https://example.invalid/{{URL2}}</p><blockquote>{{인용}}</blockquote>' });
  assert.deepEqual(warnings, [{ name: '제목', location: '제목' }, { name: '둘다', location: '제목·본문' }, { name: '본문', location: '본문' }]);
  assert.deepEqual(templateSendWarnings({ subject: '완성', html: '<p>채운 글</p><blockquote>{{인용}}</blockquote>' }), []);
});

test('fill action can initialize directly typed variables while retaining literal edited prose', () => {
  const current = { subject: '직접 쓴 {{항목}}', html: '<p>직접 쓴 문장 {{내주소}}</p><blockquote>{{인용}}</blockquote>' };
  const prepared = prepareTemplateVariables(current, undefined, context('first', 'sender@example.invalid'));
  assert.equal(prepared.subject, current.subject);
  assert.equal(prepared.html, '<p>직접 쓴 문장 sender@example.invalid</p><blockquote>{{인용}}</blockquote>');
  const filled = updateTemplateVariables(prepared, prepared.state, { 항목: '견적' });
  assert.equal(filled.subject, '직접 쓴 견적');
  assert.deepEqual(templateSendWarnings(filled), []);
});

test('new placeholders added after template insertion become editable without reversing filled/edited content', () => {
  const initial = createTemplateVariables({ subject: '{{항목}}', html: '<p>{{받는사람이름}} {{항목}}</p><p>{{내주소}}</p>' }, context('first', 'sender@example.invalid'));
  const filled = updateTemplateVariables(initial, initial.state, { 항목: '견적' });
  const edited = { subject: '손으로 고친 {{새제목}}', html: filled.html.replace('first 견적', '손으로 고친 문장 {{새본문}}') };
  const prepared = prepareTemplateVariables(edited, filled.state, context('new', 'alias@example.invalid'));
  assert.ok(prepared.state.names.includes('새제목')); assert.ok(prepared.state.names.includes('새본문'));
  assert.equal(prepared.state.values.항목, '견적');
  const completed = updateTemplateVariables(prepared, prepared.state, { 새제목: '제목', 새본문: '내용' });
  assert.equal(completed.subject, '손으로 고친 제목');
  assert.equal(completed.html, '<p>손으로 고친 문장 내용</p><p>sender@example.invalid</p>');
  const refreshed = refreshTemplateDefaults(completed, completed.state, context('another', 'alias@example.invalid'));
  assert.equal(refreshed.subject, completed.subject);
  assert.equal(refreshed.html, '<p>손으로 고친 문장 내용</p><p>alias@example.invalid</p>');
  assert.deepEqual(templateSendWarnings(refreshed), []);
});

test('mobile close/reopen retains filled values; explicit cancel restores subject/body/state and subsequent updates still work', () => {
  const model = { kind: 'new', subject: '', html: '<p><br></p>', attachments: [] };
  const result = composeTemplateInsertion(model, { subject: '{{항목}} 안내', html: '<p>{{항목}}</p><p>{{내주소}}</p>' }, {}, context('first', 'sender@example.invalid')).patch;
  const current = { subject: result.subject, html: result.html }, snapshot = beginTemplateVariableEdit(current, result.templateState);
  const edited = updateTemplateVariables(current, result.templateState, { 항목: '모바일 입력' });
  const reopened = beginTemplateVariableEdit(edited, edited.state);
  assert.equal(reopened.state.values.항목, '모바일 입력');
  assert.equal(reopened.subject, '모바일 입력 안내');
  const restored = cancelTemplateVariableEdit(snapshot);
  assert.equal(restored.state.values.항목, undefined);
  assert.equal(restored.subject, '{{항목}} 안내');
  assert.equal(restored.html, current.html);
  const refreshed = refreshTemplateDefaults(restored, restored.state, context('new', 'alias@example.invalid'));
  assert.ok(refreshed.html.includes('<p>alias@example.invalid</p>'));
  assert.equal(refreshed.subject, '{{항목}} 안내');
  assert.notEqual(restored.state, snapshot.state);
});

test('all changed JSX parses without starting a browser or building assets', () => {
  parse(readFileSync(new URL('../ui/templates-compose.test.mjs', import.meta.url), 'utf8'), { sourceType: 'module' });
  for (const name of ['Composer', 'TemplateVarsBar', 'TemplateVarsDialog']) parse(readFileSync(new URL(`../../web/src/components/${name}.jsx`, import.meta.url), 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
});

test('prototype-shaped variable names have empty field values until the user enters literal text', () => {
  const initial = createTemplateVariables({ subject: '{{constructor}}', html: '<p>{{__proto__}} {{toString}}</p>' }, context('first', 'sender@example.invalid'));
  for (const name of ['constructor', '__proto__', 'toString']) assert.equal(templateVariableValue(initial.state, name), '');
  const filled = updateTemplateVariables(initial, initial.state, { ['__proto__']: '<b>문자</b>' });
  assert.equal(templateVariableValue(filled.state, '__proto__'), '<b>문자</b>');
  assert.equal(filled.html, '<p>&lt;b&gt;문자&lt;/b&gt; {{toString}}</p>');
});
