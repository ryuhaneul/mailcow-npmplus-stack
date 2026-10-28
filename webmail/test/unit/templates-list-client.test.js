import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { availableTemplatePins, templateListGroups, toggleTemplatePin, getTemplates } from '../../web/src/templates/api.js';
import { parseRoute } from '../../web/src/router.js';
import { prefs, applyServerPrefs, updatePrefs } from '../../web/src/state/prefs.js';
import { session, sessionReady } from '../../web/src/state/session.js';
import { toast } from '../../web/src/state/toast.js';

const pin = (id, owner = 'owner@example.invalid') => ({ owner, id });
const item = (id, patch = {}) => ({ ...pin(id), ref: `synthetic-${id}`, name: `템플릿 ${id}`, subject: `Subject ${id}`, updatedAt: '2026-10-28T00:00:00.000Z', hasAttachments: false, size: 10, inShared: false, ...patch });
const data = { mine: [item('a'), item('b', { name: '견적', subject: 'PROJECT 안내', inShared: true })], shared: [item('c', { owner: 'shared@example.invalid', name: '공유 안내' })], public: [], pins: [pin('b')], limits: { max: 200 } };

test('management lists keep source groups, pin-first stable order and metadata without fetching any body', async t => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (path, options) => { calls.push([path, options.method]); return Response.json(data); };
  t.after(() => { globalThis.fetch = previous; });
  const list = await getTemplates(), frozen = structuredClone(list), groups = templateListGroups(list);
  assert.deepEqual(groups.map(group => [group.kind, group.label, group.items.map(item => item.id)]), [['mine', '내 템플릿', ['b', 'a']], ['shared', '공유받은 템플릿', ['c']], ['public', '회사 공용', []]]);
  assert.equal(groups[0].items[0].pinned, true);
  assert.equal(groups[1].items[0].kind, 'shared');
  assert.equal(groups[0].items[0].inShared, true);
  assert.equal('html' in groups[0].items[0], false);
  assert.deepEqual(calls, [['/api/templates', 'GET']]);
  assert.deepEqual(list, frozen);
});

test('search matches name/subject case-insensitively, preserves groups and returns explicit empty results', () => {
  assert.deepEqual(templateListGroups(data, ' project ').flatMap(group => group.items.map(item => item.id)), ['b']);
  assert.deepEqual(templateListGroups(data, '공유').flatMap(group => group.items.map(item => item.id)), ['c']);
  assert.deepEqual(templateListGroups(data, '없는 템플릿').flatMap(group => group.items), []);
  const empty = { mine: [], shared: [], public: [], pins: [], limits: { max: 200 } };
  assert.deepEqual(templateListGroups(empty).map(group => group.items), [[], [], []]);
});

test('pins use owner and UUID together, deduplicate and ignore disappeared pins without changing the stored array', () => {
  const pins = [pin('a'), pin('c', 'shared@example.invalid'), pin('c', 'wrong@example.invalid'), pin('gone'), pin('a')], original = structuredClone(pins);
  assert.deepEqual(availableTemplatePins(data, pins), [pin('a'), pin('c', 'shared@example.invalid')]);
  assert.deepEqual(pins, original);
  assert.deepEqual(templateListGroups(data, '', pins)[1].items.map(item => item.pinned), [true]);
});

test('explicit pin changes prune missing pins only after complete mine/shared list success', () => {
  const pins = [pin('gone'), pin('a'), pin('c', 'shared@example.invalid')], original = structuredClone(pins);
  assert.deepEqual(toggleTemplatePin(data, pins, item('b')), [pin('a'), pin('c', 'shared@example.invalid'), pin('b')]);
  assert.deepEqual(toggleTemplatePin({ mine: data.mine }, pins, item('b')), [...pins, pin('b')]);
  assert.deepEqual(toggleTemplatePin(data, pins, item('b'), { complete: false }), [...pins, pin('b')]);
  assert.deepEqual(toggleTemplatePin(null, pins, item('a')), [pin('gone'), pin('c', 'shared@example.invalid')]);
  assert.deepEqual(pins, original);
});

test('20-pin bound rejects additions while allowing removal, including incomplete-list preservation', () => {
  const items = Array.from({ length: 21 }, (_, index) => item(String(index))), pins = items.slice(0, 20).map(({ owner, id }) => ({ owner, id }));
  const complete = { mine: items, shared: [], public: [], pins };
  assert.equal(toggleTemplatePin(complete, pins, items[20]), null);
  assert.equal(toggleTemplatePin(null, pins, items[20]), null);
  assert.equal(toggleTemplatePin(complete, pins, items[0]).length, 19);
  assert.deepEqual(toggleTemplatePin(complete, pins.slice(0, 19), items[20]).at(-1), pin('20'));
});

test('template routes decode selected refs and reserve new/share slots without changing other routing', () => {
  for (const value of ['', '/new', '/share', '/synthetic-ref']) assert.deepEqual(parseRoute(`#templates${value}`), { name: 'templates', value: value.slice(1), title: '템플릿' });
  assert.equal(parseRoute('#templates/synthetic%2Fref%3Fvalue').value, 'synthetic/ref?value');
  assert.equal(parseRoute('#inbox').name, 'inbox'); assert.equal(parseRoute('#unknown').name, 'inbox');
});

const flush = () => new Promise(resolve => setImmediate(resolve));
function setupPrefs(t) {
  const previousFetch = globalThis.fetch, previousStorage = globalThis.localStorage;
  globalThis.localStorage = { setItem() {} };
  session.value = { user: { email: 'owner@example.invalid' }, csrf: 'synthetic' }; sessionReady.value = true;
  applyServerPrefs({ theme: 'ink', mode: 'light', templatePins: [pin('a')], pinnedFolders: ['INBOX'] });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { globalThis.fetch = previousFetch; globalThis.localStorage = previousStorage; session.value = null; sessionReady.value = false; toast.value = null; });
}

test('existing prefs saver coalesces template pin changes, sending only templatePins with session CSRF', async t => {
  setupPrefs(t); const calls = []; let stored = structuredClone(prefs.value);
  globalThis.fetch = async (path, options) => {
    calls.push([path, options.method]);
    if (options.method === 'PUT') {
      assert.equal(options.headers.get('X-Webmail-CSRF'), 'synthetic'); assert.equal(options.headers.get('Authorization'), null);
      const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body), ['templatePins']); stored = { ...stored, ...body };
      return new Response(null, { status: 204 });
    }
    return Response.json(stored);
  };
  updatePrefs({ templatePins: toggleTemplatePin(data, prefs.value.templatePins, item('b')) });
  updatePrefs({ templatePins: toggleTemplatePin(data, prefs.value.templatePins, item('a')) });
  assert.deepEqual(prefs.value.templatePins, [pin('b')]);
  t.mock.timers.tick(500); await flush(); await flush();
  assert.deepEqual(calls, [['/api/prefs', 'PUT'], ['/api/prefs', 'GET']]);
  assert.deepEqual(prefs.value.templatePins, [pin('b')]); assert.deepEqual(prefs.value.pinnedFolders, ['INBOX']);
});

test('failed pin preference writes restore the confirmed pin order and unrelated prefs', async t => {
  setupPrefs(t); const before = structuredClone(prefs.value);
  globalThis.fetch = async () => Response.json({ error: { code: 'MAIL_UNAVAILABLE', message: '합성 저장 실패' } }, { status: 503 });
  updatePrefs({ templatePins: toggleTemplatePin(data, prefs.value.templatePins, item('b')) });
  t.mock.timers.tick(500); await flush(); await flush();
  assert.deepEqual(prefs.value, before); assert.equal(toast.value.message, '합성 저장 실패');
});

test('new/changed screen components parse without a browser or asset build', () => {
  for (const name of ['TemplatesPage', 'Sidebar', 'Shell', 'Icon', 'TemplatePicker']) parse(readFileSync(new URL(`../../web/src/components/${name}.jsx`, import.meta.url), 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
});


test('company templates keep the public source group, search and numeric owner/id pins distinct from mailbox templates', () => {
  const company = item('1', {owner:'public',name:'회사 합성',subject:'PUBLIC Offer'}), list = {...data,public:[company]}, pins = [pin('1','public'),pin('1','reader@example.invalid')];
  const group = templateListGroups(list,'public offer',pins).find(group=>group.kind==='public');
  assert.equal(group.label,'회사 공용');assert.equal(group.items[0].pinned,true);assert.equal(group.items[0].kind,'public');assert.equal(group.items[0].id,'1');
  assert.deepEqual(availableTemplatePins(list,pins),[pin('1','public')]);assert.deepEqual(toggleTemplatePin(list,pins,company),[]);
});
test('publicUnavailable is a partial load: explicit personal pin changes retain missing company pins even with complete override', () => {
  const pins=[pin('1','public'),pin('a'),pin('gone')],partial={...data,publicUnavailable:true,public:[]};
  assert.deepEqual(toggleTemplatePin(partial,pins,item('b')),[...pins,pin('b')]);
  assert.deepEqual(toggleTemplatePin(partial,pins,item('a'),{complete:true}),[pin('1','public'),pin('gone')]);
  assert.deepEqual(toggleTemplatePin({...partial,publicUnavailable:false},pins,item('b')),[pin('a'),pin('b')]);
  const twenty=[pin('1','public'),...Array.from({length:19},(_,i)=>pin('missing-'+i))];assert.equal(toggleTemplatePin(partial,twenty,item('b')),null);
});
test('company UI warnings use existing retry states and read-only viewer without exposing a writer', () => {
  const page=readFileSync(new URL('../../web/src/components/TemplatesPage.jsx',import.meta.url),'utf8'),picker=readFileSync(new URL('../../web/src/components/TemplatePicker.jsx',import.meta.url),'utf8');
  for(const source of [page,picker])assert.match(source,/회사 공용 템플릿을 불러오지 못했어요/);
  assert.match(page,/selected\?\.kind === 'public'\) && <SharedTemplateView/);assert.match(page,/회사 공용 템플릿 본문/);
  for(const name of ['templates-page','templates-compose'])parse(readFileSync(new URL(`../ui/${name}.test.mjs`,import.meta.url),'utf8'),{sourceType:'module'});
});
