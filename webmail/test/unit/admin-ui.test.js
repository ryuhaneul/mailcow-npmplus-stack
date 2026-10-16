import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { adminNav, navGroups } from '../../web/src/admin/state/nav.js';
import { parseAdminRoute } from '../../web/src/admin/router.js';
import { createAdminApi } from '../../web/src/admin/api.js';
import { adminMode, resolvedAdminMode, initAdminTheme } from '../../web/src/admin/theme.js';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/admin-nav.json', import.meta.url), 'utf8'));
const response = (status, value) => ({ status, ok: status < 400, json: async () => value });
test('admin nav IDs/titles/icons/order and three groups match approved fixture', () => {
 assert.deepEqual(adminNav, fixture.nav);
 assert.deepEqual(navGroups, fixture.groups);
 assert.equal(adminNav.length, 12);
});
for (const hash of ['#home','#logs','#accounts/person%40example.com','#teams/team%40example.com','#aliases/a%40example.com','#permissions/p%40example.com','#sync/12','#history/abcd','#flow/team-move']) test(`admin route ${hash}`, () => { const value = parseAdminRoute(hash); assert.equal(value.name, hash.slice(1).split('/')[0]); assert.ok(!value.parts.join('').includes('%40')); });
test('admin invalid routes default home', () => { assert.equal(parseAdminRoute('#accounts/%GG').name, 'home'); assert.equal(parseAdminRoute('#missing').name, 'home'); });
test('admin API gets server csrf and sends same-origin JSON custom header', async () => { const calls = []; let current; const api = createAdminApi({ fetchImpl: async (path, options) => { calls.push({ path, options }); return response(200, path.endsWith('/session') ? { user: { username: 'synthetic' }, csrf: 'synthetic-csrf', step: 'done' } : { ok: true }); }, getCsrf: () => current?.csrf, onSession: value => { current = value; } }); await api('/api/admin/auth/session'); await api('/api/admin/aliases', { method: 'PATCH', body: { active: false } }); assert.equal(calls[1].options.headers['X-Mailadmin-CSRF'], 'synthetic-csrf'); assert.equal(calls[1].options.headers['Content-Type'], 'application/json'); assert.equal(calls[1].options.credentials, 'same-origin'); assert.equal(calls[1].options.body, '{"active":false}'); assert.deepEqual(calls[0].options.headers, {}); });
for (const code of ['SESSION_EXPIRED','ADMIN_PENDING_ACTION','MAILCOW_UNAVAILABLE']) test(`admin 403 preserves ${code}`, async () => { let seen; const api = createAdminApi({ fetchImpl: async () => response(403, { error: { code, message: '합성 오류', restart: true } }), onForbidden: error => { seen = error; } }); await assert.rejects(api('/api/admin/status'), { status: 403, code, restart: true }); assert.equal(seen.code, code); });
test('admin invalid JSON403 forwards forbidden; other errors stay with caller', async () => { let count = 0; const api = createAdminApi({ fetchImpl: async () => ({ status: 403, ok: false, json: async () => { throw new Error(); } }), onForbidden: () => count++ }); await assert.rejects(api('/api/admin/status'), { status: 403 }); const failed = createAdminApi({ fetchImpl: async () => response(502, { error: { code: 'SYNTHETIC_FAILED' } }), onForbidden: () => count++ }); await assert.rejects(failed('/api/admin/status'), { code: 'SYNTHETIC_FAILED' }); assert.equal(count, 1); });
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
test('admin menu feature flags hide cleanup/relay while retaining operation group heading',async()=>{const{visibleAdminNav}=await import('../../web/src/admin/state/nav.js');const off=visibleAdminNav();assert.equal(off.length,10);assert.ok(!off.some(item=>['cleanup','relay'].includes(item.row[0])));assert.equal(off.find(item=>item.row[0]==='fail2ban').heading,'운영 · 보안');assert.equal(visibleAdminNav({cleanup:true,relay:true}).length,12);});
