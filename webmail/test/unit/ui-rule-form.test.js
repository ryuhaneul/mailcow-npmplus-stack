import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardStatus, personalFolder, ruleProblem, seededConditions } from '../../web/src/components/rule-form.js';
import { parseRoute } from '../../web/src/router.js';
const folder = {path:'Projects',name:'프로젝트'};
const rule = {id:'abcd1234',enabled:true,match:'all',conditions:[{field:'subject',op:'has',value:'회의'}],actions:{move:'Projects'},stop:false};
test('rule hash query decodes seed values without confusing slash or ampersand', () => {
  const route = parseRoute('#rule?from=sales%40example.com&subject=A%2FB%26C&attachment=has');
  assert.equal(route.name,'rule');assert.equal(route.value,'');
  assert.deepEqual(seededConditions(route.query),[{field:'from',op:'has',value:'sales@example.com'},{field:'subject',op:'has',value:'A/B&C'},{field:'attachment',op:'has',value:''}]);
  assert.equal(parseRoute('#rule/abcd1234').value,'abcd1234');
});
test('forward policy accepts internal and external domains and 1–3 valid addresses', () => {
  const domains=['example.com'];
  assert.equal(forwardStatus('user@EXAMPLE.com, team@example.com',domains).valid,true);
  for(const value of ['user@external.example.org','user@sub.example.com','user@example.com.evil.test'])assert.equal(forwardStatus(value,domains).external,true);
  for(const value of ['', 'a..b@example.com','a@example.com,','a@example.com,b@example.com,c@example.com,d@example.com','a@example.com\n','a@-example.com'])assert.equal(forwardStatus(value,domains).valid,false,value);
  assert.equal(forwardStatus('user@example.com',[]).valid,true);
  assert.equal(forwardStatus('user@outside.test',domains).valid,true);
});
test('move choices exclude shared, virtual, system and unsafe folders', () => {
  assert.equal(personalFolder(folder),true);
  for(const value of [{path:'INBOX'},{path:'Trash'},{path:'Junk'},{path:'Drafts'},{path:'Shared/a'},{path:'WebmailVirtual/AllMail'},{path:'Private',shared:true},{path:'Private',virtual:true},{path:'Private',personal:false},{path:'Other',specialUse:'\\Inbox'},{path:'bad\nfolder'},{path:'${folder}'}])assert.equal(personalFolder(value),false,JSON.stringify(value));
});
test('rule validation blocks unsafe conditions, missing folders, empty actions and move/trash', () => {
  assert.equal(ruleProblem(rule,[folder],[],''),null);
  assert.equal(ruleProblem({...rule,conditions:[{field:'subject',op:'has',value:'\u{1F4E7}'.repeat(200)}]},[folder],[],''),null);
  for(const value of ['', '${name}', 'x\n', 'x'.repeat(201)])assert.ok(ruleProblem({...rule,conditions:[{field:'from',op:'has',value}]},[folder],[],''));
  assert.ok(ruleProblem({...rule,conditions:Array(11).fill(rule.conditions[0])},[folder],[],''));
  assert.ok(ruleProblem(rule,[],[],''));
  assert.match(ruleProblem({...rule,actions:{move:''}},[folder],[],''),/옮길 개인 폴더를 선택/);
  assert.ok(ruleProblem({...rule,actions:{move:'Projects',trash:true}},[folder],[],''));
  assert.ok(ruleProblem({...rule,actions:{}},[folder],[],''));
  assert.equal(ruleProblem({...rule,actions:{forward:['user@external.example.org']}},[folder],['example.com'],'user@external.example.org'),null);
});

test('browser rule form accepts nested opposite joins and escaped literal question patterns', () => {
  const grouped = { ...rule, conditions: [rule.conditions[0], { match: 'any', conditions: [
    { field: 'from', op: 'matches', value: '*@example.com' },
    { field: 'subject', op: 'matches', value: 'question\\?' },
  ] }] };
  assert.equal(ruleProblem(grouped, [folder], [], ''), null);
  const invalid = structuredClone(grouped);
  invalid.conditions[1].conditions[1].value = 'question?';
  assert.ok(ruleProblem(invalid, [folder], [], ''));
  invalid.conditions[1].conditions[1].value = 'question\\?';
  invalid.conditions[1].match = 'all';
  assert.ok(ruleProblem(invalid, [folder], [], ''));
});

// Exercise the actual JSX screens with the shared API/session handling.
test('disabled Sieve shows existing filter notices and leaves composing and the session usable', async t => {
  const { registerHooks } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const { transformSync } = await import('@babel/core');
  const { default: jsx } = await import('@babel/plugin-transform-react-jsx');
  const { JSDOM } = await import('jsdom');
  const hooks = registerHooks({
    load(url, context, next) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      if (url.endsWith('.jsx')) return { format: 'module', source: transformSync(readFileSync(new URL(url), 'utf8'), {
        filename: new URL(url).pathname, configFile: false, babelrc: false,
        plugins: [[jsx, { runtime: 'automatic', importSource: 'preact' }]],
      }).code, shortCircuit: true };
      return next(url, context);
    },
  });
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://newmail.example.com/#filters', pretendToBeVisual: true });
  const names = ['window', 'document', 'location', 'getComputedStyle', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'EventSource'];
  const originals = new Map(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = typeof dom.window[name] === 'function' ? dom.window[name].bind(dom.window) : dom.window[name];
  globalThis.EventSource = class { addEventListener() {} close() {} };
  const oldFetch = globalThis.fetch;
  const { h, render } = await import('preact');
  const { act } = await import('preact/test-utils');
  const { session, verifiedSession } = await import('../../web/src/state/session.js');
  const { config } = await import('../../web/src/state/config.js');
  const { prefs } = await import('../../web/src/state/prefs.js');
  const { route } = await import('../../web/src/router.js');
  const { default: FiltersPage } = await import('../../web/src/components/FiltersPage.jsx');
  const { default: RuleBuilder } = await import('../../web/src/components/RuleBuilder.jsx');
  const { default: Composer } = await import('../../web/src/components/Composer.jsx');
  const { default: Shell } = await import('../../web/src/components/Shell.jsx');
  const { toast } = await import('../../web/src/state/toast.js');
  const { vacation } = await import('../../web/src/components/OooBadge.jsx');
  const root = document.querySelector('main'), requests = [];
  const owner = { user: { email: 'user@example.com' }, csrf: 'synthetic-csrf' };
  const message = '이 계정은 메일 필터 기능이 꺼져 있어요. 관리자에게 켜 달라고 요청해 주세요.';
  const previous = { session: session.value, verifiedSession: verifiedSession.value, config: config.value, prefs: prefs.value, route: route.value, toast: toast.value, vacation: vacation.value };
  t.after(() => {
    render(null, root); hooks.deregister(); dom.window.close(); globalThis.fetch = oldFetch;
    for (const [name, value] of originals) globalThis[name] = value;
    session.value = previous.session; verifiedSession.value = previous.verifiedSession; config.value = previous.config; prefs.value = previous.prefs; route.value = previous.route; toast.value = previous.toast; vacation.value = previous.vacation;
  });
  session.value = owner; verifiedSession.value = owner;
  config.value = { contactsEnabled: false, attachMaxMb: 25 };
  prefs.value = { signatures: {}, defaultFrom: 'user@example.com' };
  globalThis.fetch = async path => {
    requests.push(path);
    if (path === '/api/folders') return Response.json({ folders: [], virtualAllMail: null });
    if (path === '/api/storage?quotaOnly=1') return Response.json({ quota: null });
    if (path === '/api/rules') return Response.json({ error: { code: 'SIEVE_DISABLED', message } }, { status: 409 });
    if (path === '/api/compose/identities') return Response.json({ identities: [{ address: 'user@example.com', kind: 'self' }], defaultFrom: 'user@example.com', anyAtDomains: [], anyAddress: false });
    if (path === '/api/signatures') return Response.json({ revision: 'S'.repeat(32), items: [], defaults: {}, usedBytes: 0, maxBytes: 262144, notices: [] });
    if (path === '/api/signature-images') return Response.json({ revision: 'I'.repeat(32), images: [], usedBytes: 0, maxBytes: 1048576, maxFileBytes: 204800, maxCount: 20 });
    assert.fail(`unexpected API request: ${path}`);
  };
  for (const [name, Component] of [['filters', FiltersPage], ['rule', RuleBuilder], ['compose', Composer]]) {
    await act(async () => { render(null, root); route.value = { name, value: '' }; render(h(Component, {}), root); });
    await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(session.value, owner, name);
    if (name === 'compose') {
      assert.ok(root.querySelector('#compose-to'), 'recipient entry remains available');
      assert.ok(root.querySelector('#compose-subject'), 'subject entry remains available');
      assert.equal(root.querySelector('#compose-to').disabled, false);
      assert.equal(root.querySelector('#compose-to').placeholder, '이름이나 주소 · @example.com');
      assert.equal(root.querySelector('.compose-alert'), null);
    } else {
      assert.equal(root.querySelector('[role=alert]').textContent.includes(message), true, name);
      assert.equal(root.querySelector('a[href="#rule"]'), null);
      assert.equal(root.querySelector('form'), null);
    }
  }
  assert.equal(requests.filter(path => path === '/api/rules').length, 2);
  assert.equal(requests.some(path => path.includes('/auth/')), false);
  await t.test('Shell suppresses the disabled-Sieve toast and clears the vacation badge', async () => {
    prefs.value = { ...prefs.value, theme: 'ink', folderColors: {} };
    toast.value = null; vacation.value = { enabled: true };
    await act(async () => { render(null, root); route.value = { name: 'keys', value: '', title: '단축키' }; render(h(Shell, {}), root); });
    await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(session.value, owner);
    assert.equal(vacation.value, null);
    assert.equal(toast.value, null);
    assert.equal(root.querySelector('.toast'), null);
    assert.equal(requests.filter(path => path === '/api/rules').length, 3);
  });
});
