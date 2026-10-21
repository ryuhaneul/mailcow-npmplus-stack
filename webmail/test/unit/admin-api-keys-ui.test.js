import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { adminNav, visibleAdminNav } from '../../web/src/admin/state/nav.js';
import { parseAdminRoute } from '../../web/src/admin/router.js';

const item = { id: '1'.repeat(32), name: '합성 연결', permission: 'read', allowedIps: ['192.0.2.0/24'], expiresAt: null, createdBy: 'synthetic-admin', createdAt: '2026-10-21T06:00:00.000Z', lastUsedAt: null, lastUsedIp: null, status: 'active' };
const plaintext = 'mak_v1_SYNTHETIC_ONLY_NEVER_A_REAL_KEY';
const response = (status, value) => ({ status, ok: status < 400, json: async () => value });

test('API key navigation stays in settings and remains visible when disabled', () => {
  const index = adminNav.findIndex(row => row[0] === 'api-keys');
  assert.deepEqual(adminNav[index], ['api-keys', 'API 키', 'shield']);
  assert.equal(adminNav[index - 1][0], 'settings');
  assert.ok(visibleAdminNav({ apiKeys: false }).some(entry => entry.row[0] === 'api-keys'));
  assert.equal(parseAdminRoute('#api-keys').name, 'api-keys');
});

test('API key UI protects one-time token and matches the management contract', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://admin.example.test/#api-keys' });
  const keys = ['window', 'document', 'location', 'fetch'];
  const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
  let copied, copyFails = false;
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { if (copyFails) throw new Error('synthetic'); copied = value; } } });
  const root = document.getElementById('root'), calls = [];
  let rows, enabled, failure, pending, listFailure;
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (path.startsWith('/api/admin/history/')) return response(200, { revertible: false });
    if (options.method === 'GET') return listFailure ? response(503, { error: { code: 'READ_FAILED', message: '합성 조회 실패' } }) : response(200, { items: rows, total: rows.length, page: 1, pageSize: 50, enabled });
    if (pending) await pending.promise;
    if (failure) return response(failure.status, { error: failure });
    if (options.method === 'POST') { rows = [...rows, { ...item, id: '2'.repeat(32), name: JSON.parse(options.body).name }]; return response(201, { item: rows.at(-1), token: plaintext, auditId: '3'.repeat(32) }); }
    rows = rows.map(row => ({ ...row, status: 'revoked' })); return response(200, { item: rows[0], auditId: '4'.repeat(32) });
  };
  const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom', logLevel: 'error' });
  const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const click = async node => { act(() => node.click()); await settle(); };
  const input = async (selector, value, type = 'input') => { act(() => { const node = root.querySelector(selector); if (typeof value === 'boolean') node.checked = value; else node.value = value; node.dispatchEvent(new dom.window.Event(type, { bubbles: true })); }); await settle(); };
  const submit = async () => { act(() => root.querySelector('dialog form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); await settle(); };
  let ApiKeys, session;
  async function mount({ off = false, empty = false, failed = false } = {}) {
    act(() => render(null, root)); rows = empty ? [] : [{ ...item }]; enabled = !off; failure = null; pending = null; listFailure = failed; calls.length = 0; copyFails = false;
    session.value = { step: 'done', features: { apiKeys: !off }, csrf: 'synthetic' };
    act(() => render(h(ApiKeys), root)); await settle();
  }
  const issue = async () => { await click(root.querySelector('.page-head button')); await input('#api-key-name', '새 합성 키'); };
  try {
    const module = await server.ssrLoadModule('/src/admin/pages/ApiKeys.jsx'); ApiKeys = module.default; session = (await server.ssrLoadModule('/src/admin/state/session.js')).adminSession;
    await t.test('date ends in KST and empty IP lines are omitted', () => {
      assert.deepEqual(module.issueBody({ name: ' 연결 ', permission: 'read', ips: '192.0.2.1\r\n\n2001:db8::/32 ', date: '2026-12-31', unlimited: false }), { name: '연결', permission: 'read', allowedIps: ['192.0.2.1', '2001:db8::/32'], expiresAt: '2026-12-31T14:59:59.999Z' });
      assert.equal(module.issueBody({ name: '연결', permission: 'full', ips: '', unlimited: true }).expiresAt, null);
    });
    await t.test('list has all metadata, IP detail, expired and revoked states', async () => {
      await mount(); assert.equal(root.querySelectorAll('thead th').length, 9); assert.match(root.textContent, /읽기 전용/); assert.match(root.textContent, /synthetic-admin/); assert.match(root.textContent, /192.0.2.0\/24/); assert.match(root.textContent, /사용 기록 없음/); assert.match(root.textContent, /무기한/);
      assert.equal(module.statusLabel('expired'), '만료'); assert.equal(module.statusLabel('revoked'), '폐기됨'); assert.equal(module.permissionLabel('full'), '전체');
    });
    await t.test('disabled feature prevents issuing but preserves menu and reason', async () => {
      await mount({ off: true }); assert.match(root.textContent, /서버 연결 설정 필요/); assert.equal(root.querySelector('.page-head button').disabled, true); assert.equal(root.querySelector('dialog'), null);
    });
    await t.test('empty and load failure are distinct and retry is available', async () => {
      await mount({ empty: true }); assert.match(root.textContent, /발급한 API 키가 없습니다/);
      await mount({ failed: true }); assert.match(root.textContent, /항목을 불러오지 못했습니다/); assert.ok([...root.querySelectorAll('button')].some(node => node.textContent.includes('다시')));
    });
    await t.test('read is default; successful token is shown once, copied and cleared', async () => {
      await mount(); await issue(); assert.equal(root.querySelector('#api-key-permission').value, 'read'); await submit();
      assert.equal(root.querySelector('#api-key-token').value, plaintext); assert.match(root.querySelector('dialog').textContent, /지금 한 번만 표시됩니다/);
      assert.equal(root.querySelector('.content').textContent.includes(plaintext), false);
      const post = calls.find(call => call.options.method === 'POST'); assert.deepEqual(JSON.parse(post.options.body), { name: '새 합성 키', permission: 'read', allowedIps: [], expiresAt: null });
      assert.equal(location.href, 'https://admin.example.test/#api-keys'); assert.equal(dom.window.localStorage.length, 0); assert.equal(dom.window.sessionStorage.length, 0); assert.equal(JSON.stringify(session.value).includes(plaintext), false);
      await click([...root.querySelectorAll('dialog button')].find(node => node.textContent === '복사')); assert.equal(copied, plaintext);
      copyFails = true; await click([...root.querySelectorAll('dialog button')].find(node => node.textContent === '복사')); assert.match(root.querySelector('dialog').textContent, /직접 선택/);
      await click([...root.querySelectorAll('dialog button')].find(node => node.textContent === '닫기')); assert.equal(root.querySelector('#api-key-token'), null); assert.equal(root.innerHTML.includes(plaintext), false);
      await issue(); assert.equal(root.querySelector('#api-key-token'), null); assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
    });
    await t.test('422 preserves input and shows field error; explicit correction can submit', async () => {
      await mount(); await issue(); await input('#api-key-ips', 'bad-ip'); failure = { status: 422, code: 'INVALID_INPUT', message: '합성 IP 오류' }; await submit();
      assert.equal(root.querySelector('#api-key-name').value, '새 합성 키'); assert.equal(root.querySelector('#api-key-ips').value, 'bad-ip'); assert.ok(root.querySelector('dialog [role=alert]')); assert.equal(root.querySelector('#api-key-token'), null);
      failure = null; await input('#api-key-ips', '192.0.2.1'); await submit(); assert.equal(root.querySelector('#api-key-token').value, plaintext);
    });
    await t.test('pending issuance blocks duplicate submit and Escape; unmount discards late response', async () => {
      await mount(); await issue(); let resolve; pending = { promise: new Promise(done => { resolve = done; }) }; await submit(); await submit();
      assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
      const event = new dom.window.Event('cancel', { cancelable: true }); root.querySelector('dialog').dispatchEvent(event); assert.equal(event.defaultPrevented, true);
      act(() => render(null, root)); resolve(); await settle(); assert.equal(root.innerHTML, '');
    });
    await t.test('Escape clears successful token and remount cannot recover it', async () => {
      await mount(); await issue(); await submit(); act(() => root.querySelector('dialog').dispatchEvent(new dom.window.Event('cancel', { cancelable: true }))); await settle(); assert.equal(root.querySelector('dialog'), null);
      await issue(); assert.equal(root.querySelector('#api-key-token'), null);
    });
    await t.test('revocation requires exact name and preserves audit-only success', async () => {
      await mount(); await click(root.querySelector('tbody button')); assert.equal(root.querySelector('dialog .btn.dan').disabled, true);
      await input('#confirm-api-key-name', `${item.name} `); assert.equal(root.querySelector('dialog .btn.dan').disabled, true); await submit(); assert.equal(calls.filter(call => call.options.method === 'DELETE').length, 0);
      await input('#confirm-api-key-name', item.name); assert.equal(root.querySelector('dialog .btn.dan').disabled, false); await submit();
      assert.deepEqual(JSON.parse(calls.find(call => call.options.method === 'DELETE').options.body), { confirm: item.name }); assert.equal(root.querySelector('dialog'), null); assert.equal(root.querySelector('tbody button').disabled, true); assert.match(root.textContent, /폐기됨/);
    });
    await t.test('search and pagination use only metadata query', async () => {
      await mount(); await input('#api-key-search', '합성'); act(() => root.querySelector('.api-key-search').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); await settle(); assert.ok(calls.some(call => call.path === `/api/admin/api-keys?q=${encodeURIComponent('합성')}&page=1`));
    });
  } finally {
    act(() => render(null, root)); await server.close(); dom.window.close(); Object.assign(globalThis, previous);
    if (originalClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', originalClipboard); else delete globalThis.navigator.clipboard;
    if (session) session.value = null;
  }
});
