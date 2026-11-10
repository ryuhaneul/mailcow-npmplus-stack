import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

const secret = 'SyntheticUiCredential732!';
const rows = () => ['admin', 'other', 'off'].map((username, i) => ({ username, active: i < 2, tfaActive: i < 2, created: '2026-11-01 12:00:00', forceTfa: false, forcePwUpdate: false, etag: `opaque-${username}` }));
const response = (status, value) => ({ status, ok: status < 400, json: async () => value });
test('administrator UI follows the account contracts and protects credential input', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://admin.example.test/#overview' });
  const keys = ['window', 'document', 'location', 'fetch'], previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const root = document.querySelector('#root'), calls = []; let failure, pending, reloads = 0, resource, session, AdminAccounts;
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (pending) await pending.promise;
    if (failure instanceof Error) throw failure;
    if (failure?.invalidJson) return { status: 200, ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } };
    return failure ? response(failure.status, { error: failure }) : response(200, { ok: true });
  };
  const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom', logLevel: 'error' });
  const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const click = async node => { act(() => node.click()); await settle(); };
  const input = async (id, value) => { act(() => { const node = root.querySelector(id); node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); await settle(); };
  const submit = async () => { act(() => root.querySelector('dialog form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); await settle(); };
  const action = (label, name = 'other') => root.querySelector(`[aria-label="${name} ${label}"]`);
  const add = () => click([...root.querySelectorAll('button')].find(n => n.textContent === '관리자 추가'));
  const cancel = () => click([...root.querySelectorAll('dialog button')].find(n => n.textContent === '취소'));
  const fillPasswords = async (second = secret) => { await input('#admin-account-password', secret); await input('#admin-account-password2', second); };
  const mount = async (patch = {}) => {
    act(() => render(null, root)); failure = null; pending = null; calls.length = 0; reloads = 0;
    resource = { loading: false, error: null, data: { items: rows() }, reload() { reloads++; }, ...patch };
    session.value = { username: 'admin', step: 'done', csrf: 'synthetic-csrf' };
    act(() => render(h(AdminAccounts, { resource }), root)); await settle();
  };
  try {
    AdminAccounts = (await server.ssrLoadModule('/src/admin/components/AdminAccounts.jsx')).default;
    session = (await server.ssrLoadModule('/src/admin/state/session.js')).adminSession;
    await t.test('table preserves existing fields, identifies self without actions, and keeps readable scroll cells', async () => {
      await mount(); assert.equal(root.querySelectorAll('th').length, 6); assert.equal(root.querySelectorAll('[data-admin-name="admin"] button').length, 0);
      assert.match(root.querySelector('[data-admin-name="admin"]').textContent, /나.*본인 계정/); assert.equal(root.querySelector('table').style.minWidth, '760px');
      for (const cell of root.querySelectorAll('td,th')) assert.equal(cell.style.whiteSpace, 'nowrap');
      assert.equal(root.querySelector('.table-wrap').tabIndex, 0); assert.ok(action('켜기', 'off'));
      assert.equal(root.querySelectorAll('input[name*=force], input[name*=tfa]').length, 0);
    });
    await t.test('loading, empty and read failure stay distinct', async () => {
      await mount({ loading: true }); assert.equal(root.querySelector('table'), null);
      await mount({ data: { items: [] } }); assert.match(root.textContent, /관리자 정보가 없습니다/);
      await mount({ error: { code: 'FAILED', message: '합성 조회 실패' } }); assert.match(root.textContent, /불러오지 못했습니다/);
    });
    await t.test('create posts only approved fields and clears input before pending request and after success', async () => {
      await mount(); await add(); await input('#admin-account-name', 'new'); await fillPasswords(); assert.equal(root.querySelector('input[type=checkbox]').checked, true);
      await submit(); assert.deepEqual(JSON.parse(calls[0].options.body), { username: 'new', active: true, password: secret, password2: secret }); assert.equal(calls[0].path, '/api/admin/admins');
      assert.equal(root.querySelector('dialog'), null); assert.match(root.querySelector('[role=status]').textContent, /추가했습니다/); assert.equal(reloads, 1);
      assert.equal(root.innerHTML.includes(secret), false); assert.equal(dom.window.localStorage.length, 0); assert.equal(dom.window.sessionStorage.length, 0);
      await add(); assert.equal(root.querySelector('#admin-account-password').value, ''); assert.equal(root.querySelector('#admin-account-name').value, ''); await cancel();
    });
    await t.test('mismatch never posts; reset uses the existing target etag and clears passwords on rejection', async () => {
      await mount(); await click(action('암호 재설정')); await fillPasswords('mismatch'); await submit(); assert.equal(calls.length, 0); assert.match(root.textContent, /일치하지 않습니다/);
      await input('#admin-account-password2', secret); failure = { status: 422, code: 'INVALID_INPUT', message: '암호 정책을 충족하지 않습니다.' }; await submit();
      assert.deepEqual(JSON.parse(calls[0].options.body), { password: secret, password2: secret, etag: 'opaque-other' }); assert.equal(calls[0].path, '/api/admin/admins/other/password');
      assert.equal(root.querySelector('#admin-account-password').value, ''); assert.equal(root.querySelector('#admin-account-password2').value, ''); assert.match(root.textContent, /암호 정책/);
    });
    await t.test('typed deletion and activation send only the allowed contracts', async () => {
      await mount(); await click(action('삭제')); assert.equal(root.querySelector('dialog .dan').disabled, true);
      await input('#admin-account-confirm', 'other '); await submit(); assert.equal(calls.length, 0);
      await input('#admin-account-confirm', 'other'); await submit(); assert.equal(calls[0].options.method, 'DELETE'); assert.deepEqual(JSON.parse(calls[0].options.body), { confirm: 'other', etag: 'opaque-other' });
      await mount(); await click(action('끄기')); await submit(); assert.equal(calls[0].options.method, 'PATCH'); assert.deepEqual(JSON.parse(calls[0].options.body), { active: false, etag: 'opaque-other' });
      await mount(); await click(action('켜기', 'off')); await submit(); assert.deepEqual(JSON.parse(calls[0].options.body), { active: true, etag: 'opaque-off' });
    });
    for (const [status, code, message] of [[403, 'ADMIN_SELF_ACTION', '본인 계정은 끄거나 삭제할 수 없습니다.'], [409, 'LAST_ACTIVE_ADMIN', '마지막 활성 관리자는 끄거나 삭제할 수 없습니다.'], [409, 'CHANGED_ELSEWHERE', '다른 곳에서 값이 바뀌었습니다.'], [503, 'MAILCOW_UNAVAILABLE', '결과를 확인할 수 없습니다.']]) await t.test(`explicit ${code} errors never become optimistic success or automatic retry`, async () => {
      await mount(); await click(action('끄기')); failure = { status, code, message }; await submit(); assert.match(root.querySelector('[role=alert]').textContent, new RegExp(message));
      assert.equal(root.querySelector('[role=status]'), null); assert.equal(calls.length, 1); assert.equal(reloads, 0);
      if (status >= 500 || status === 409) { assert.equal(root.querySelector('button[type=submit]').disabled, true); await submit(); assert.equal(calls.length, 1); }
      if (status === 409) { await click([...root.querySelectorAll('dialog button')].find(n => n.textContent === '다시 읽기')); assert.equal(root.querySelector('dialog'), null); assert.equal(reloads, 1); }
    });
    for (const [name, failedResponse] of [['connection loss without status', new TypeError('Failed to fetch')], ['HTTP 200 with invalid JSON', { invalidJson: true }]]) await t.test(`${name} requires reloading before another write`, async () => {
      await mount(); await click(action('끄기')); failure = failedResponse; await submit();
      assert.match(root.querySelector('dialog').textContent, /적용 여부를 확인할 수 없습니다/);
      assert.equal(root.querySelector('[role=status]'), null); assert.equal(calls.length, 1); assert.equal(reloads, 0);
      assert.equal(root.querySelector('button[type=submit]').disabled, true);
      await submit(); await submit(); assert.equal(calls.length, 1);
      await click([...root.querySelectorAll('dialog button')].find(n => n.textContent === '목록 다시 읽기'));
      assert.equal(root.querySelector('dialog'), null); assert.equal(reloads, 1); assert.equal(calls.length, 1);
    });
    await t.test('cancel, Escape and unmount clear input and restore the calling control', async () => {
      await mount(); const trigger = action('암호 재설정'); await click(trigger); await fillPasswords(); const node = root.querySelector('#admin-account-password'); await cancel(); assert.equal(node.value, ''); assert.equal(document.activeElement, trigger);
      await add(); await fillPasswords(); const escaped = root.querySelector('#admin-account-password'); act(() => root.querySelector('dialog').dispatchEvent(new dom.window.Event('cancel', { cancelable: true }))); await settle(); assert.equal(root.querySelector('dialog'), null); assert.equal(escaped.value, '');
      await add(); await fillPasswords(); const removed = root.querySelector('#admin-account-password'); act(() => render(null, root)); await settle(); assert.equal(removed.value, '');
    });
    await t.test('pending blocks duplicate submits and closing; late result after unmount has no UI effect', async () => {
      await mount(); await add(); await input('#admin-account-name', 'new'); await fillPasswords(); let resolve; pending = { promise: new Promise(done => { resolve = done; }) };
      await submit(); await submit(); assert.equal(calls.length, 1); assert.equal(root.querySelector('#admin-account-password').value, '');
      const event = new dom.window.Event('cancel', { cancelable: true }); act(() => root.querySelector('dialog').dispatchEvent(event)); await settle(); assert.equal(event.defaultPrevented, true);
      assert.ok([...root.querySelectorAll('dialog button')].every(node => node.disabled)); act(() => render(null, root)); resolve(); await settle(); assert.equal(root.innerHTML, ''); assert.equal(reloads, 0);
    });
  } finally { act(() => render(null, root)); await server.close(); dom.window.close(); Object.assign(globalThis, previous); if (session) session.value = null; }
});
