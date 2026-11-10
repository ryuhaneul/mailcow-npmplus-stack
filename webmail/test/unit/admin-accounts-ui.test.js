import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountFilters,accountState,referenceRow} from '../../web/src/admin/pages/accounts.js';
import {sieveDisabledWarning} from '../../server/admin/messages.js';
test('AF05 approved account filters retain their order and API values',()=>assert.deepEqual(accountFilters,[['all','전체'],['personal','개인'],['team','팀'],['off','비활성']]));
test('AF05 receiving-only active=2 is never labelled login enabled',()=>{assert.equal(accountState(2),'받기 전용');assert.equal(accountState(1),'사용 중');assert.equal(accountState(0),'비활성');});
test('AF05 alias reference preview distinguishes deleting, removing a target, and keeping',()=>{const row={address:'alias@example.com',targets:['person@example.com']};assert.equal(referenceRow('aliases',{...row,effect:'deleted'})[2],'대상이 비어 함께 삭제');assert.equal(referenceRow('aliases',{...row,effect:'target_removed'})[2],'대상에서 제외');assert.equal(referenceRow('aliases',{...row,effect:'kept'})[2],'유지');});
test('AF05 one shared Sieve warning preserves the server contract',()=>assert.deepEqual(sieveDisabledWarning,{code:'SIEVE_DISABLED',message:'Sieve를 끄면 필터를 저장할 수 없어요.'}));

// Verify the approved insertion uses the existing account dialog rather than a new flow.
test('netlimit account UI keeps one flag, empty-list warning and detail line', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../web/src/admin/pages/AccountDetail.jsx', import.meta.url), 'utf8');
  assert.equal(source.split('IMAP·POP3·SMTP를 사내 IP에서만 허용').length - 1, 1);
  assert.ok(source.includes('draft.protocolInternalOnly && row.protocolInternalAllowlistEmpty'));
  assert.ok(source.includes('<dt>사내 IP 제한</dt>')); assert.ok(source.includes('protocolInternalOnly: draft.protocolInternalOnly'));
});

test('retirement approved UI states and existing share APIs operate through actual JSX and fake API', async t => {
  const { registerHooks } = await import('node:module'), { readFileSync } = await import('node:fs');
  const { transformSync } = await import('@babel/core'), { default: jsx } = await import('@babel/plugin-transform-react-jsx'), { JSDOM } = await import('jsdom');
  const hooks = registerHooks({ load(url, context, next) {
    if (url.endsWith('.css')) return {format:'module',source:'',shortCircuit:true};
    if (url.endsWith('.jsx')) return {format:'module',source:transformSync(readFileSync(new URL(url),'utf8'),{configFile:false,babelrc:false,plugins:[[jsx,{runtime:'automatic',importSource:'preact'}]]}).code,shortCircuit:true};
    return next(url,context);
  }});
  const dom = new JSDOM('<!doctype html><main></main>', {url:'https://mailadmin.example.com/#accounts',pretendToBeVisual:true});
  const names=['window','document','location','matchMedia'], prior=new Map(names.map(name=>[name,globalThis[name]])), oldFetch=globalThis.fetch;
  for(const name of names) globalThis[name]=name==='matchMedia'?()=>({matches:false}):dom.window[name];
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const {createFakeAdminApi}=await import('../../web/dev/fake-admin-api.js');
  let fake;
  globalThis.fetch=async(path,options={})=>{
    let body='',status=200;const headers={};
    const response={setHeader(name,value){headers[name]=value;},set statusCode(value){status=value;},get statusCode(){return status;},end(value){body=value||'';}};
    await fake.middleware({url:path,method:options.method||'GET',headers:options.headers||{},async *[Symbol.asyncIterator](){if(options.body)yield options.body;}},response,()=>assert.fail('unexpected fake path '+path));
    return new Response(body,{status,headers});
  };
  const {h,render}=await import('preact'),{act}=await import('preact/test-utils');
  const {LeaveDialog,RetirementSettings}=await import('../../web/src/admin/flows/Leave.jsx');
  const {default:AccountDetail}=await import('../../web/src/admin/pages/AccountDetail.jsx');
  const {default:Shares}=await import('../../web/src/admin/pages/Shares.jsx');
  const root=document.querySelector('main'), address='person@example.com';
  t.after(()=>{render(null,root);dom.window.close();hooks.deregister();globalThis.fetch=oldFetch;for(const[name,value]of prior)value===undefined?delete globalThis[name]:globalThis[name]=value;});
  const tick=async()=>{await act(async()=>{await new Promise(resolve=>setImmediate(resolve));});};
  async function mount(Component,props={}){await act(async()=>render(null,root));await act(async()=>render(h(Component,props),root));await tick();await tick();}
  const button=text=>{const value=[...root.querySelectorAll('button')].find(node=>node.textContent===text);assert.ok(value,'button '+text);return value;};
  const click=async text=>{await act(async()=>button(text).click());await tick();};
  const change=async(selector,value)=>{const node=root.querySelector(selector);assert.ok(node,selector);await act(async()=>{if(node.type==='checkbox')node.checked=value;else node.value=value;node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});await tick();};
  const setup=(retired=true,blocked=false)=>{fake=createFakeAdminApi();const row=fake.state.accounts.items.find(row=>row.address===address);row.active=retired?2:1;row.retirement={retired,receiveBlocked:blocked,forwarding:[],recordedAt:'2026-11-01T00:00:00Z'};return {...row,retirement:{...row.retirement,featureEnabled:true,effectiveReceiveBlock:blocked?'on':'off',pendingOperation:null,warnings:[]}};};
  await t.test('allowed/blocked detail states distinguish retirement, login, receive and actual forwarding',async()=>{
    let row=setup();row.retirement.forwarding=['team@example.com'];await mount(RetirementSettings,{row,saved(){}});
    assert.match(root.textContent,/처리됨/);assert.match(root.textContent,/차단됨/);assert.match(root.textContent,/허용 중/);assert.match(root.textContent,/전달: team@example.com/);
    row=setup(true,true);await mount(RetirementSettings,{row,saved(){}});assert.match(root.textContent,/차단 중/);assert.equal(root.querySelector('#receive-block').checked,true);
  });
  await t.test('server OFF and legacy disable blocking and show separate facts',async()=>{
    let row=setup();row.retirement.featureEnabled=false;await mount(RetirementSettings,{row,saved(){}});assert.match(root.textContent,/서버 수신 차단 기능 꺼짐/);assert.ok(root.querySelector('#receive-block').matches(':disabled'));
    row=setup(false);row.active=2;await mount(RetirementSettings,{row,saved(){}});assert.match(root.textContent,/퇴사 확인 필요/);assert.match(root.textContent,/받기 전용/);assert.ok(root.querySelector('#receive-block').matches(':disabled'));
  });
  await t.test('server OFF disables only blocking; permitted receive forwarding remains editable',async()=>{
    const row=setup();fake.state.accounts.retirementFeatureEnabled=false;row.retirement.featureEnabled=false;
    await mount(RetirementSettings,{row,saved(){}});assert.ok(root.querySelector('#receive-block').disabled);assert.equal(root.querySelector('#retirement-mail-mode').matches(':disabled'),false);assert.equal(button('변경 미리보기').disabled,true);
    await change('#retirement-mail-mode','forward');await change('#share-grantee','team@example.com');await click('변경 미리보기');assert.equal(fake.state.accounts.retirementBodies.at(-1).body.receiveBlocked,false);assert.equal(fake.state.accounts.retirementBodies.at(-1).body.forwardTo,'team@example.com');await change('dialog input[type=checkbox]',true);await click('수신 허용');
    assert.deepEqual(fake.state.accounts.items.find(row=>row.address===address).retirement.forwarding,['team@example.com']);
    await change('#retirement-mail-mode','remove');await click('변경 미리보기');await change('dialog input[type=checkbox]',true);await click('수신 허용');assert.deepEqual(fake.state.accounts.items.find(row=>row.address===address).retirement.forwarding,[]);
  });
  await t.test('leave defaults keep shares; exclusive mode and preview-back preserve all selections',async()=>{
    const row=setup(false);await mount(LeaveDialog,{row,close(){}});
    const inputs=root.querySelectorAll('input[type=checkbox]');assert.equal(inputs[0].checked,true);assert.equal(inputs[1].checked,false);
    await change('#leave-mail-mode','forward');await change('#share-grantee','team@example.com');await change('input[type=checkbox]',false);await change('label.checkline + label.checkline input',true);
    await click('변경 미리보기');assert.match(root.textContent,/공유 정리/);assert.equal(button('퇴사 처리 실행').disabled,true);await click('이전');
    assert.equal(root.querySelector('#leave-mail-mode').value,'forward');assert.equal(root.querySelector('#share-grantee').value,'team@example.com');assert.equal(root.querySelector('input[type=checkbox]').checked,false);assert.equal(root.querySelector('label.checkline + label.checkline input').checked,true);
    await change('label.checkline + label.checkline input',false);await change('#leave-mail-mode','block');await click('변경 미리보기');const body=fake.state.accounts.retirementBodies.at(-1).body;
    assert.equal(body.receiveBlocked,true);assert.equal(body.forwardTo,null);assert.equal(body.cleanShares,false);
  });
  await t.test('preview shows actual mixed alias cleanup and blocks unresolved personal filters',async()=>{
    const row=setup(false);fake.state.accounts.retirementChanges=[{kind:'alias',address:'mixed@example.com',remove:[address],keep:['team@example.com']}];fake.state.accounts.retirementBlockers=[{code:'FILTER_TARGET_REMAINS',source:'user',type:'active-user',address:'admin@example.com'}];
    await mount(LeaveDialog,{row,close(){}});await change('#leave-mail-mode','block');await click('변경 미리보기');assert.match(root.textContent,/mixed@example.com/);assert.match(root.textContent,/team@example.com 유지/);assert.match(root.textContent,/개인 활성 필터/);
    await change('input[type=checkbox]',true);assert.equal(button('퇴사 처리 실행').disabled,true);
  });
  await t.test('already retired dialog does not call leave and moves focus to settings',async()=>{
    setup();await mount(AccountDetail,{address,changed(){}});await click('퇴사 처리');assert.match(root.textContent,/이미 퇴사 처리된 계정입니다/);await click('계정 설정으로');await new Promise(resolve=>dom.window.requestAnimationFrame(resolve));await tick();assert.equal(root.querySelector('dialog'),null);assert.equal(document.activeElement.id,'retirement-settings');assert.equal(fake.state.accounts.retirementBodies.length,0);
  });
  await t.test('block OFF confirmation warns about refs and actual PATCH immediately refreshes current state',async()=>{
    setup(true,true);await mount(AccountDetail,{address,changed(){}});await change('#receive-block',false);await click('변경 미리보기');assert.match(root.textContent,/자동 복원되지 않습니다/);await change('dialog input[type=checkbox]',true);await click('수신 허용');await tick();assert.match(root.querySelector('#retirement-settings').textContent,/허용 중/);assert.equal(fake.state.accounts.retirementBodies.at(-1).method,'PATCH');assert.equal(fake.state.accounts.retirementBodies.at(-1).body.receiveBlocked,false);
  });
  await t.test('block ON explicitly removes existing managed forwarding before cleanup consent',async()=>{
    const row=setup();row.retirement.forwarding=['team@example.com'];await mount(RetirementSettings,{row,saved(){}});await change('#receive-block',true);assert.ok(root.querySelector('#retirement-mail-mode').disabled);await click('변경 미리보기');const body=fake.state.accounts.retirementBodies.at(-1).body;assert.equal(body.forwardTo,null);assert.equal(body.receiveBlocked,true);
  });
  await t.test('partial leave locks the saved request and retries with a fresh preview',async()=>{
    const row=setup();row.retirement.pendingOperation={kind:'leave',request:{receiveBlocked:true,forwardTo:null,cleanRefs:false,cleanShares:true}};
    await mount(LeaveDialog,{row,close(){}});assert.equal(root.querySelector('#leave-mail-mode').disabled,true);assert.equal(root.querySelector('#leave-mail-mode').value,'block');await click('변경 미리보기');const body=fake.state.accounts.retirementBodies.at(-1).body;assert.equal(body.cleanRefs,false);assert.equal(body.cleanShares,true);assert.equal(body.receiveBlocked,true);
  });
  await t.test('leave execution keeps sharing by default and preserves existing operational warnings',async()=>{
    const row=setup(false);await mount(LeaveDialog,{row,close(){}});await click('변경 미리보기');await change('dialog input[type=checkbox]',true);await click('퇴사 처리 실행');
    const body=fake.state.accounts.retirementBodies.at(-1).body;assert.equal(body.action,'run');assert.equal(body.cleanShares,false);assert.equal(body.cleanupConfirmed,true);assert.equal(body.forwardTo,null);
    assert.match(root.textContent,/변경 내용을 저장/);assert.match(root.textContent,/최대 5분/);assert.match(root.textContent,/기기의 메일 계정/);assert.match(root.textContent,/사내 전체/);
    assert.equal(fake.state.accounts.items.find(row=>row.address===address).active,2);
  });
  await t.test('partial result offers a fresh preview with locked original request and permits remaining cleanup retry',async()=>{
    const row=setup(false);fake.state.accounts.result='partial';await mount(LeaveDialog,{row,close(){}});await change('#leave-mail-mode','block');await click('변경 미리보기');await change('dialog input[type=checkbox]',true);await click('퇴사 처리 실행');
    assert.match(root.textContent,/일부 작업만 완료/);await click('남은 정리 미리보기');assert.equal(root.querySelector('#leave-mail-mode').value,'block');assert.equal(root.querySelector('#leave-mail-mode').disabled,true);
    await click('변경 미리보기');assert.equal(fake.state.accounts.retirementBodies.at(-1).body.receiveBlocked,true);fake.state.accounts.result='ok';await change('dialog input[type=checkbox]',true);await click('퇴사 처리 실행');assert.match(root.textContent,/변경 내용을 저장/);
  });
  await t.test('account detail shares use existing POST and DELETE with etag and active grantee choices',async()=>{
    setup();await mount(AccountDetail,{address,changed(){}});assert.match(root.textContent,/이 메일함의 읽기 공유/);await click('공유 추가');const candidates=[...root.querySelector('#share-grantee').options].map(row=>row.value);assert.ok(!candidates.includes('admin@example.com'));assert.ok(!candidates.includes('off@example.com'));assert.ok(!candidates.includes(address));await change('#share-grantee','team@example.com');await click('읽기 공유 추가');await tick();
    const section=[...root.querySelectorAll('section')].find(node=>node.textContent.includes('이 메일함의 읽기 공유'));const grant=[...section.querySelectorAll('.mini-row')].find(node=>node.textContent.includes('team@example.com'));assert.ok(grant);await act(async()=>grant.querySelector('button').click());await tick();await click('공유 빼기');
    const calls=fake.state.requests.filter(row=>row.path===`/api/admin/shares/${encodeURIComponent(address)}`);assert.ok(calls.some(row=>row.method==='POST'));assert.ok(calls.some(row=>row.method==='DELETE'));
  });
  await t.test('shares owner list and detail display retired owner while preserving active-only grantees',async()=>{
    setup();await mount(Shares,{address});assert.ok([...root.querySelectorAll('.list-pane .chip')].some(node=>node.textContent==='퇴사'));assert.match(root.querySelector('.account-detail').textContent,/퇴사 ·/);
  });
  await t.test('stale preview prevents execution until explicitly reloaded',async()=>{
    const row=setup();await mount(RetirementSettings,{row,saved(){}});await change('#receive-block',true);await click('변경 미리보기');fake.state.accounts.version++;await change('dialog input[type=checkbox]',true);await click('수신 차단');assert.match(root.textContent,/현재 값으로 다시 미리보기/);assert.equal(button('수신 차단').disabled,true);
  });
});
