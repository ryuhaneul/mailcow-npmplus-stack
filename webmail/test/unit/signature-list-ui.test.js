import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { transformSync } from '@babel/core';
import jsx from '@babel/plugin-transform-react-jsx';
import { JSDOM } from 'jsdom';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: transformSync(readFileSync(new URL(url), 'utf8'), { filename: new URL(url).pathname, configFile: false, babelrc: false, plugins: [[jsx, { runtime: 'automatic', importSource: 'preact' }]] }).code };
  return next(url, context);
} });
const { default: SignatureList } = await import('../../web/src/components/SignatureList.jsx');
const { default: SignatureDefaults } = await import('../../web/src/components/SignatureDefaults.jsx');
const { default: SignatureDialog } = await import('../../web/src/components/SignatureDialog.jsx');
const items = [{ id: 'one', name: '회사 소개', html: '<p>합성</p>' }, { id: 'two', name: '간단한 인사', html: '' }];
const identities = [{ address: 'user@example.com' }, { address: 'team@example.com' }];
const defaults = { 'user@example.com': { newDefault: 'one', replyDefault: 'one' }, 'team@example.com': { newDefault: 'two', replyDefault: 'one' } };
let dom, root, savedGlobals;
before(() => {
  dom = new JSDOM('<!doctype html><body><button id="opener">호출</button><main></main><button id="fallback">서명 목록</button></body>', { pretendToBeVisual: true });
  savedGlobals = new Map(['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(name => [name, globalThis[name]]));
  for (const name of savedGlobals.keys()) globalThis[name] = typeof dom.window[name] === 'function' ? dom.window[name].bind(dom.window) : dom.window[name];
  // jsdom has no modal top layer. Real Chromium focus trapping is checked separately.
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  root = document.querySelector('main');
});
beforeEach(() => document.querySelector('#opener').focus());
afterEach(() => act(() => render(null, root)));
after(() => { hooks.deregister(); dom.window.close(); for (const [name, value] of savedGlobals) globalThis[name] = value; });
const mount = (Component, props) => act(() => render(h(Component, props), root));
const click = node => act(() => node.click());
const button = label => [...root.querySelectorAll('button')].find(node => node.textContent === label);
const key = (node, value, extra = {}) => act(() => node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra })));
const input = value => act(() => { const node = root.querySelector('input'); node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });

test('list renders D labels, count and selected state without changing input', () => {
  const snapshot = structuredClone(items);
  mount(SignatureList, { items, selectedId: 'two' });
  assert.equal(root.querySelector('h3').textContent, '내 서명 2');
  assert.deepEqual([...root.querySelectorAll('.signature-items button')].map(node => node.getAttribute('aria-pressed')), ['false', 'true']);
  assert.equal(root.querySelector('.signature-actions').firstChild.textContent, '선택한 서명 · 간단한 인사');
  assert.deepEqual(items, snapshot);
});
test('list callbacks carry the selected ID and create carries no arguments', () => {
  const calls = [];
  mount(SignatureList, { items, selectedId: 'two', onSelect: (...args) => calls.push(['select', ...args]), onCreate: (...args) => calls.push(['new', ...args]), onRename: id => calls.push(['rename', id]), onCopy: id => calls.push(['copy', id]), onDelete: id => calls.push(['delete', id]) });
  click(root.querySelector('.signature-items button')); for (const label of ['새 서명', '이름 바꾸기', '복제', '삭제']) click(button(label));
  assert.deepEqual(calls, [['select', 'one'], ['new'], ['rename', 'two'], ['copy', 'two'], ['delete', 'two']]);
});
test('empty list keeps new action and exact empty copy; stale selection has no actions', () => {
  mount(SignatureList, { items: [], selectedId: null });
  assert.equal(root.querySelector('.signature-items p').textContent, '아직 서명이 없어요. 새 서명을 만들어 주세요.');
  assert.ok(button('새 서명')); assert.equal(root.querySelector('.signature-actions'), null);
  mount(SignatureList, { items, selectedId: 'deleted' }); assert.equal(root.querySelector('.signature-actions'), null);
});
test('busy list disables every action', () => { mount(SignatureList, { items, selectedId: 'one', busy: true }); assert.ok([...root.querySelectorAll('button')].every(node => node.disabled)); });
test('defaults render both fields per address, including null and no signatures', () => {
  mount(SignatureDefaults, { identities, items, defaults });
  assert.deepEqual([...root.querySelectorAll('select')].map(node => node.value), ['one', 'one', 'two', 'one']);
  assert.deepEqual([...root.querySelectorAll('select')].map(node => node.getAttribute('aria-label')), ['user@example.com 새 메일 기본 서명', 'user@example.com 답장·전달 기본 서명', 'team@example.com 새 메일 기본 서명', 'team@example.com 답장·전달 기본 서명']);
  assert.equal(root.querySelector('option').textContent, '없음');
  mount(SignatureDefaults, { identities, items: [], defaults: {} }); assert.ok([...root.querySelectorAll('select')].every(node => node.value === '' && node.options.length === 1));
});
test('defaults callbacks preserve field/address/null and leave source unchanged', () => {
  const calls = [], snapshot = structuredClone(defaults);
  mount(SignatureDefaults, { identities, items, defaults, onChange: (...args) => calls.push(args), onEdit: () => calls.push(['edit']) });
  const selects = root.querySelectorAll('select');
  act(() => { selects[0].value = ''; selects[0].dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  act(() => { selects[3].value = 'two'; selects[3].dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  click(root.querySelector('a'));
  assert.deepEqual(calls, [['user@example.com', 'newDefault', null], ['team@example.com', 'replyDefault', 'two'], ['edit']]); assert.deepEqual(defaults, snapshot);
});
test('busy defaults disable both fields for every address', () => { mount(SignatureDefaults, { identities, items, defaults, busy: true }); assert.ok([...root.querySelectorAll('select')].every(node => node.disabled)); });
for (const [type, title, initial, label] of [['new', '새 서명 만들기', '', '만들기'], ['rename', '서명 이름 바꾸기', '회사 소개', '바꾸기'], ['copy', '서명 복제', '회사 소개 (복사)', '복제']]) {
  test(`${type} dialog focuses input, labels it and submits trimmed name`, () => {
    const calls = []; mount(SignatureDialog, { type, signature: items[0], onConfirm: value => calls.push(value) });
    const field = root.querySelector('input'); assert.equal(document.activeElement, field); assert.equal(field.value, initial);
    assert.equal(root.querySelector('h2').textContent, title); assert.equal(root.querySelector('label').htmlFor, field.id);
    assert.match(root.textContent, /이름은 서명을 고를 때 보여요\./); assert.match(root.textContent, /200바이트/);
    input('  새 이름  '); click(button(label)); assert.deepEqual(calls, ['새 이름']);
  });
}
test('name validation rejects empty, UTF-8 over 200 bytes and control characters, preserves raw input', () => {
  const calls = []; mount(SignatureDialog, { type: 'new', onConfirm: value => calls.push(value) });
  for (const [value, message] of [['   ', '서명 이름을 입력해 주세요.'], ['한'.repeat(67), '서명 이름은 200바이트 이하로 입력해 주세요.'], ['bad\u0001name', '서명 이름에 제어 문자를 넣을 수 없어요.']]) {
    input(value); click(button('만들기')); assert.equal(root.querySelector('[role=alert]').textContent, message); assert.equal(root.querySelector('input').value, value); assert.equal(root.querySelector('input').getAttribute('aria-invalid'), 'true');
  }
  input('한'.repeat(66) + 'ab'); key(root.querySelector('input'), 'Enter'); assert.deepEqual(calls, ['한'.repeat(66) + 'ab']);
});
test('IME Enter does not submit a name', () => { let calls = 0; mount(SignatureDialog, { type: 'new', onConfirm: () => calls++ }); input('입력'); key(root.querySelector('input'), 'Enter', { isComposing: true }); assert.equal(calls, 0); });
test('delete dialog lists all affected addresses and types once, keeps exact D copy', () => {
  let calls; mount(SignatureDialog, { type: 'delete', signature: items[0], defaults, onConfirm: (...args) => { calls = args; } });
  assert.equal(root.querySelector('h2').textContent, '‘회사 소개’ 서명을 지울까요?');
  assert.equal(root.querySelector('.delete-default-warning').textContent, '2개 주소의 기본 서명이에요.지우면 그 주소의 해당 기본값은 ‘없음’이 돼요.');
  assert.deepEqual([...root.querySelectorAll('li')].map(node => node.textContent), ['user@example.com새 메일 · 답장·전달', 'team@example.com답장·전달']);
  assert.equal(root.querySelector('.dialog-note').textContent, '이미 작성한 메일의 서명과 보관함 이미지는 그대로예요.');
  assert.equal(document.activeElement, button('취소')); click(button('서명 삭제')); assert.deepEqual(calls, []);
});
test('unused delete has no impact list; text stays escaped', () => {
  mount(SignatureDialog, { type: 'delete', signature: { id: 'unused', name: '<img src=x>' }, defaults });
  assert.equal(root.querySelector('h2').textContent, '‘<img src=x>’ 서명을 지울까요?'); assert.equal(root.querySelector('img'), null);
  assert.match(root.textContent, /어떤 주소의 기본값으로도 쓰지 않는 서명이에요\./); assert.equal(root.querySelector('ul'), null);
});
test('replace confirmation distinguishes no signature from a signature named 없음', () => {
  mount(SignatureDialog, { type: 'replace' }); assert.match(root.textContent, /지금 메일에서 고친 서명 내용이 ‘없음’으로 바뀌어요\./);
  mount(SignatureDialog, { type: 'replace', nextSignature: { id: 'one', name: '없음' } }); assert.match(root.textContent, /‘없음’ 서명으로 바뀌어요\./); assert.match(root.textContent, /메일 본문은 그대로예요\./);
});
test('dialog traps Tab both ways, Escape cancels once, cleanup restores opener', () => {
  let cancelled = 0; mount(SignatureDialog, { type: 'new', onCancel: () => cancelled++ });
  const field = root.querySelector('input'), last = button('만들기'); key(field, 'Tab', { shiftKey: true }); assert.equal(document.activeElement, last);
  key(last, 'Tab'); assert.equal(document.activeElement, field); key(field, 'Escape'); assert.equal(cancelled, 1);
  act(() => render(null, root)); assert.equal(document.activeElement.id, 'opener');
});
test('native cancel and button cancel call parent; fallback ref receives restored focus', () => {
  let cancelled = 0; mount(SignatureDialog, { type: 'delete', signature: items[0], onCancel: () => cancelled++, returnFocusRef: { current: document.querySelector('#fallback') } });
  click(button('취소')); act(() => root.querySelector('dialog').dispatchEvent(new dom.window.Event('cancel', { cancelable: true }))); assert.equal(cancelled, 2);
  act(() => render(null, root)); assert.equal(document.activeElement.id, 'fallback');
});
test('server error preserves entered name; busy blocks confirm and cancellation', () => {
  let calls = 0; const props = { type: 'rename', signature: items[0], onConfirm: () => calls++, onCancel: () => calls++ };
  mount(SignatureDialog, props); input('보존할 이름'); mount(SignatureDialog, { ...props, error: { message: '다시 불러와 주세요.' } });
  assert.equal(root.querySelector('input').value, '보존할 이름'); assert.equal(root.querySelector('[role=alert]').textContent, '다시 불러와 주세요.');
  mount(SignatureDialog, { ...props, busy: true }); assert.ok([...root.querySelectorAll('button,input')].every(node => node.disabled));
  key(root.querySelector('dialog'), 'Escape'); act(() => root.querySelector('dialog').dispatchEvent(new dom.window.Event('cancel', { cancelable: true }))); assert.equal(calls, 0);
});
