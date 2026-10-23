import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { adminNav, navGroups } from '../../web/src/admin/state/nav.js';
import { parseAdminRoute } from '../../web/src/admin/router.js';
import { adminSession, authFailure, returnTo } from '../../web/src/admin/state/session.js';
import { createAdminApi } from '../../web/src/admin/api.js';
import { adminMode, resolvedAdminMode, initAdminTheme } from '../../web/src/admin/theme.js';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/admin-nav.json', import.meta.url), 'utf8'));
const response = (status, value) => ({ status, ok: status < 400, json: async () => value });
test('admin nav IDs/titles/icons/order and three groups match approved fixture', () => {
 assert.deepEqual(adminNav, fixture.nav);
 assert.deepEqual(navGroups, fixture.groups);
 assert.equal(adminNav.length, 22);
 assert.deepEqual(adminNav[0], ['home', '처음 화면', 'home']);
});
for (const hash of ['#trusted','#trusted/cdpmanager%40example.com','#home','#logs','#accounts/person%40example.com','#teams/team%40example.com','#aliases/a%40example.com','#permissions/p%40example.com','#sync/12','#history/abcd','#flow/team-move']) test(`admin route ${hash}`, () => { const value = parseAdminRoute(hash); assert.equal(value.name, hash.slice(1).split('/')[0]); assert.ok(!value.parts.join('').includes('%40')); });
test('admin invalid routes default home', () => { assert.equal(parseAdminRoute('#accounts/%GG').name, 'home'); assert.equal(parseAdminRoute('#missing').name, 'home'); });
test('admin API gets server csrf and sends same-origin JSON custom header', async () => { const calls = []; let current; const api = createAdminApi({ fetchImpl: async (path, options) => { calls.push({ path, options }); return response(200, path.endsWith('/session') ? { user: { username: 'synthetic' }, csrf: 'synthetic-csrf', step: 'done' } : { ok: true }); }, getCsrf: () => current?.csrf, onSession: value => { current = value; } }); await api('/api/admin/auth/session'); await api('/api/admin/aliases', { method: 'PATCH', body: { active: false } }); assert.equal(calls[1].options.headers['X-Mailadmin-CSRF'], 'synthetic-csrf'); assert.equal(calls[1].options.headers['Content-Type'], 'application/json'); assert.equal(calls[1].options.credentials, 'same-origin'); assert.equal(calls[1].options.body, '{"active":false}'); assert.deepEqual(calls[0].options.headers, {}); });
for (const code of ['NO_SESSION', 'SESSION_EXPIRED', 'MAILCOW_SESSION_LOST', 'BAD_ORIGIN', 'CSRF', 'FORBIDDEN', 'INVALID_RESPONSE']) test(`admin forbidden ${code} only ends a lost session`, async () => {
 const dom = new JSDOM('', { url: 'https://admin.example.com/#domains' }), previous = globalThis.location;
 const session = { step: 'done', csrf: 'synthetic-csrf', user: { username: 'synthetic' } };
 globalThis.location = dom.window.location; adminSession.value = session; authFailure.value = null; returnTo.value = 'home';
 const api = createAdminApi({ fetchImpl: async () => code === 'INVALID_RESPONSE' ? { status: 403, ok: false, json: async () => { throw new SyntaxError('HTML response'); } } : response(403, { error: { code, message: '합성 오류' } }) });
 try {
  await assert.rejects(api('/api/admin/domains'), { status: 403, code });
  if (['NO_SESSION', 'SESSION_EXPIRED', 'MAILCOW_SESSION_LOST'].includes(code)) {
   assert.equal(adminSession.value, null); assert.equal(location.hash, '#login'); assert.equal(authFailure.value.code, code); assert.equal(returnTo.value, 'domains');
  } else {
   assert.equal(adminSession.value, session); assert.equal(location.hash, '#domains'); assert.equal(authFailure.value, null); assert.equal(returnTo.value, 'home');
  }
 } finally { globalThis.location = previous; adminSession.value = null; authFailure.value = null; returnTo.value = 'home'; dom.window.close(); }
});
for (const code of ['AUTH_FAILED', 'ADMIN_PENDING_ACTION']) test(`admin login ${code} remains available to the login caller`, async () => {
 let count = 0;
 const api = createAdminApi({ fetchImpl: async () => response(403, { error: { code, message: '합성 오류', restart: true } }), onForbidden: () => count++ });
 await assert.rejects(api('/api/admin/auth/login', { method: 'POST', body: { username: 'synthetic', password: 'synthetic-only' } }), { status: 403, code, restart: true });
 assert.equal(count, 0);
});
test('admin other errors stay with caller', async () => {
 let count = 0;
 const api = createAdminApi({ fetchImpl: async () => response(502, { error: { code: 'SYNTHETIC_FAILED' } }), onForbidden: () => count++ });
 await assert.rejects(api('/api/admin/status'), { code: 'SYNTHETIC_FAILED' }); assert.equal(count, 0);
});
test('admin rejects public API paths and handles204', async () => { const api = createAdminApi({ fetchImpl: async () => response(204) }); await assert.rejects(api('/api/config')); assert.equal(await api('/api/admin/auth/logout', { method: 'POST' }), null); });
test('admin theme is independent, follows system and manual mode', () => { const dom = new JSDOM('<html/>'), previous = { document: globalThis.document, matchMedia: globalThis.matchMedia }; let changed; const media = { matches: false, addEventListener(_event, fn) { changed = fn; }, removeEventListener() {} }; globalThis.document = dom.window.document; globalThis.matchMedia = () => media; adminMode.value = 'system'; const theme = initAdminTheme(); try { assert.equal(resolvedAdminMode.value, 'light'); media.matches = true; changed(); assert.equal(resolvedAdminMode.value, 'dark'); theme.toggle(); assert.equal(resolvedAdminMode.value, 'light'); assert.equal(adminMode.value, 'light'); } finally { theme.stop(); dom.window.close(); Object.assign(globalThis, previous); } });

test('auth copy matches approved login fixture', async () => {
 const { authMessages } = await import('../../web/src/admin/auth.js');
 assert.deepEqual(authMessages, JSON.parse(readFileSync(new URL('../fixtures/admin-auth.json', import.meta.url), 'utf8')));
});
for (const [input, expected] of [['https://mailcow.example.com/', 'https://mailcow.example.com/'], ['http://mailcow.example.com', 'http://mailcow.example.com/'], ['javascript:alert(1)', null], ['/admin', null], ['https://user:password@example.com/', null], [undefined, null]]) test(`auth fallback URL ${String(input)} is checked`, async () => { const { safeFallbackUrl } = await import('../../web/src/admin/auth.js'); assert.equal(safeFallbackUrl(input), expected); });
test('auth countdown formats server retry seconds', async () => { const { remainingTime } = await import('../../web/src/admin/auth.js'); assert.equal(remainingTime(298), '04:58'); assert.equal(remainingTime(0), '00:00'); });

test('home six task types/order/copy match approved fixture', async () => { const { homeTasks } = await import('../../web/src/admin/pages/status.js'); assert.deepEqual(homeTasks, JSON.parse(readFileSync(new URL('../fixtures/admin-home.json', import.meta.url), 'utf8')).tasks); });
test('home task features default off and independently enable cleanup/relay', async () => { const { visibleTasks } = await import('../../web/src/admin/pages/status.js'); assert.deepEqual(visibleTasks().map(row => row[1]), ['join','leave','team','logo']); assert.equal(visibleTasks({cleanup:true}).length,5); assert.equal(visibleTasks({relay:true}).length,5); assert.equal(visibleTasks({cleanup:true,relay:true}).length,6); });
test('status cards use nearest TLS expiry; a failed port only errors certificate card', async () => {
 const {statusCards}=await import('../../web/src/admin/pages/status.js'); const data={queue:{count:9,longestDelaySeconds:240},blocked:{count:4},certificates:[{port:993,daysRemaining:42},{port:465,daysRemaining:18}],storage:{vmail:{usedPercent:'62%',used:'26G',total:'42G'}}};
 assert.deepEqual(statusCards(data).map(card=>card.value),[9,4,18,'62%']);data.certificates[1]={port:465,error:'TLS_FAILED'};assert.equal(statusCards(data)[2].error,'TLS_FAILED');assert.equal(statusCards(data)[0].error,undefined);
});
test('status partial failure detection includes nested mailbox errors', async () => { const {hasStatusError}=await import('../../web/src/admin/pages/status.js');assert.equal(hasStatusError({storage:{mailboxes:{error:'READ_FAILED'}}}),true);assert.equal(hasStatusError({checks:[],certificates:[{valid:true}]}),false); });
test('status timestamps are KST and byte/delay values preserve server units', async () => { const {kst,bytes,duration}=await import('../../web/src/admin/pages/status.js');assert.match(kst('2026-10-16T00:00:00Z'),/09:00/);assert.equal(bytes(2147483648),'2.0 GB');assert.equal(duration(240),'4분');assert.equal(duration(12),'12초');assert.equal(kst(null),'—'); });

test('flow initial password uses cryptographic randomness and all four permitted character classes', async () => {
 const { initialPassword } = await import('../../web/src/admin/flows/helpers.js');
 for (let index=0; index<100; index++) { const value=initialPassword(); assert.equal(value.length,20);assert.match(value,/^[a-zA-Z0-9!@#%^*_=+\-]+$/);for(const pattern of [/[a-z]/,/[A-Z]/,/[0-9]/,/[!@#%^*_=+\-]/])assert.match(value,pattern); }
 assert.ok(!initialPassword.toString().includes('Math.random'));
});
test('CSV chunks contain at most50 and retry selects only failed, not partial/unknown rows', async () => {const{chunks,failedLines}=await import('../../web/src/admin/flows/helpers.js');const lines=Array.from({length:60},(_,i)=>i+2);assert.deepEqual(chunks(lines).map(rows=>rows.length),[50,10]);assert.deepEqual(chunks(lines).flat(),lines);assert.deepEqual(failedLines([{line:2,result:'ok'},{line:3,result:'failed'},{line:4,result:'partial'},{line:5,result:'unknown'}]),[3]);});
test('flow memory strips passwords after auth interruption and clears on leaving normally', async () => {const{saveFlow,readFlow,leaveFlow}=await import('../../web/src/admin/flows/memory.js');const value={draft:{csv:'synthetic csv'},results:[{line:2,password:'synthetic-only-secret',result:'ok'}]};saveFlow('csv',value);leaveFlow('csv',true);assert.equal(readFlow('csv').draft.csv,'synthetic csv');assert.equal(JSON.stringify(readFlow('csv')).includes('synthetic-only-secret'),false);assert.equal(value.results[0].password,undefined);leaveFlow('csv',false);assert.equal(readFlow('csv').draft.csv,'');assert.equal(readFlow('csv').results.length,0);});
test('admin menu feature flags hide cleanup/relay/trusted while retaining operation group heading',async()=>{const{visibleAdminNav}=await import('../../web/src/admin/state/nav.js');const off=visibleAdminNav();assert.equal(off.length,19);assert.ok(!off.some(item=>['cleanup','relay','trusted'].includes(item.row[0])));assert.equal(off.find(item=>item.row[0]==='quarantine').heading,'운영 · 보안');assert.equal(visibleAdminNav({cleanup:true,relay:true}).length,21);assert.equal(visibleAdminNav({cleanup:true,relay:true,trusted:true}).length,22);assert.equal(visibleAdminNav({trusted:true}).find(item=>item.row[0]==='trusted').row[2],'shield');});

test('KST display accepts epoch seconds, milliseconds and ISO with identical approved format',async()=>{
 const {kst}=await import('../../web/src/admin/pages/status.js');
 const iso='2026-10-16T05:58:00Z',milliseconds=Date.parse(iso),expected='10월 16일 금요일 · 14:58';
 for(const value of [iso,milliseconds,String(milliseconds),milliseconds/1000,String(milliseconds/1000)])assert.equal(kst(value),expected);
 assert.equal(kst('2026-10-16T15:00:00Z'),'10월 17일 토요일 · 00:00');
 assert.equal(kst('2026-10-16T14:58:00+09:00'),expected);
 assert.equal(kst('invalid'),'invalid');assert.equal(kst(undefined),'—');assert.equal(kst(''),'—');
});

test('shared ACL loading guidance follows pending detail, preview and run requests', async t => {
 const { createServer } = await import('vite'), { fileURLToPath } = await import('node:url');
 const { h, render } = await import('preact'), { act } = await import('preact/test-utils');
 const dom = new JSDOM('<div id="root"></div>', { url: 'https://admin.example.com/' });
 const keys = ['window', 'document', 'location', 'addEventListener', 'removeEventListener', 'fetch'];
 const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
 const root = dom.window.document.getElementById('root');
 const message = '공유 정보를 모든 메일함에서 확인하고 있어요. 메일함 수에 따라 몇 분 걸릴 수 있어요.';
 const address = 'person@example.com', other = 'other@example.com';
 const items = [{ address, name: '시험 계정', active: 1, messages: 0 }, { address: other, active: 1 }];
 const list = { items, total: items.length, pageSize: 50, mailboxes: items };
 let pending = [], delayList = false, delayDetail = false;
 Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, addEventListener: dom.window.addEventListener.bind(dom.window), removeEventListener: dom.window.removeEventListener.bind(dom.window), fetch: (path, options) => {
  if (options.method !== 'GET' || delayList && path.startsWith('/api/admin/shares?') || delayDetail && path.startsWith('/api/admin/shares/')) return new Promise(resolve => pending.push({ path, options, resolve: value => resolve(response(200, value)) }));
  return Promise.resolve(response(200, path.startsWith('/api/admin/shares/') ? { owner: address, name: '시험 계정', grants: [], etag: 'synthetic' } : path.startsWith('/api/admin/shares?') ? { ...list, items: [{ owner: address, name: '시험 계정' }] } : path.startsWith('/api/admin/mailboxes/') ? items[0] : list));
 } });
 const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), server: { middlewareMode: true, watch: null }, appType: 'custom' });
 const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
 const waitLoading = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
 const mount = async (Component, props = {}) => { act(() => render(null, root)); act(() => render(h(Component, props), root)); await settle(); };
 const submit = async () => { act(() => root.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); await settle(); };
 const input = async (selector, value) => { act(() => { const node = root.querySelector(selector); node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); await settle(); };
 const finish = async value => { assert.equal(pending.length, 1); act(() => pending.shift().resolve(value)); await settle(); assert.ok(!root.textContent.includes(message)); };
 try {
  const { default: Loading } = await server.ssrLoadModule('/src/admin/components/Loading.jsx');
  const { default: Shares } = await server.ssrLoadModule('/src/admin/pages/Shares.jsx');
  const { default: Leave } = await server.ssrLoadModule('/src/admin/flows/Leave.jsx');
  const { default: DeleteMailbox } = await server.ssrLoadModule('/src/admin/flows/DeleteMailbox.jsx');
  const { default: AccountTransition } = await server.ssrLoadModule('/src/admin/flows/AccountTransition.jsx');
  await t.test('Loading retains its default copy', async () => {
   await mount(Loading); await waitLoading(); assert.equal(root.querySelector('[role="status"]').textContent, '불러오는 중…');
  });
  await t.test('shares list uses ordinary loading and detail has selected mailbox guidance', async () => {
   delayList = true; await mount(Shares); await waitLoading(); assert.equal(root.querySelector('[role="status"]').textContent, '불러오는 중…');
   await finish({ items: [], total: 0, pageSize: 50 }); delayList = false;
   delayDetail = true; await mount(Shares); await waitLoading();
   assert.equal(root.querySelector('[role="status"]').textContent, '선택한 메일함의 공유 정보를 확인하고 있어요.');
   assert.ok(root.querySelector('.list-pane').textContent.includes(address));
   assert.equal(pending[0].path, `/api/admin/shares/${encodeURIComponent(address)}`);
   await finish({ owner: address, name: '시험 계정', grants: [], etag: 'synthetic' }); delayDetail = false;
  });
  for (const mode of ['leave', 'delete', 'rename', 'toAlias', 'toMailbox']) await t.test(`${mode} guidance appears during both preview and run`, async () => {
   const lifecycle = mode === 'leave' || mode === 'delete';
   await mount(mode === 'leave' ? Leave : mode === 'delete' ? DeleteMailbox : AccountTransition, { address, mode });
   if (mode === 'rename') await input('#transition-new-address', 'new@example.com');
   if (mode === 'toAlias') {
    act(() => { const select = root.querySelector('#transition-targets'); select.options[0].selected = true; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); await settle();
   }
   assert.equal(root.querySelector('button[type="submit"]').disabled, false);
   assert.ok(!root.textContent.includes(message));
   await submit(); await waitLoading(); assert.equal(root.querySelector('[role="status"]').textContent, message);
   assert.equal(pending[0].options.method, 'POST');
   const refs = { aliases: [], teams: [], senders: [], shares: [], syncjobs: [] };
   const plan = lifecycle ? { address, mode: mode === 'delete' ? 'delete' : 'disable', cleanRefs: true, refs, etag: 'synthetic', confirmAddress: address, confirmation: '합성 확인', messages: 0, usedBytes: 0 } : {
    address, newAddress: 'new@example.com', etag: 'synthetic', direction: mode === 'toMailbox' ? 'alias-to-mailbox' : 'mailbox-to-alias', changes: mode === 'rename' ? { mailbox: [], teamFilters: [], aliases: [], senderAs: [], senderGrants: [], shares: [], syncjobs: [], oldAlias: [] } : {
     mailbox: { address, messages: 0, kind: 'personal', quotaGb: 20 }, alias: { address, targets: [other], goto: other }, refs, aliasesRestored: [], filtersRemoved: [], syncjobsRemoved: [], senderRestore: []
    }
   };
   await finish(plan);
   await submit(); assert.equal(pending.length, 0); assert.ok(!root.textContent.includes(message));
   if (mode !== 'leave') await input('#confirm-address', address);
   act(() => { const checkbox = root.querySelector('input[type="checkbox"]:not([disabled])'); checkbox.checked = true; checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); await settle();
   assert.equal(root.querySelector('button[type="submit"]').disabled, false);
   await submit(); await waitLoading(); assert.equal(root.querySelector('[role="status"]').textContent, message);
   assert.equal(pending[0].options.method, mode === 'delete' ? 'DELETE' : 'POST');
   await finish({ address, result: 'ok', steps: [], warnings: [] });
  });
 } finally {
  act(() => render(null, root)); await server.close(); dom.window.close(); Object.assign(globalThis, previous);
 }
});

test('shares subfolder warning matches the account service warning text', async () => {
 const { subfolderAclWarning } = await import('../../web/src/admin/pages/accounts.js');
 const source = readFileSync(new URL('../../server/admin/services/accounts.js', import.meta.url), 'utf8');
 const [, message] = source.match(/code: 'SUBFOLDER_ACL_UNCHECKED', message: '([^']+)'/);
 assert.equal(subfolderAclWarning, message);
});
