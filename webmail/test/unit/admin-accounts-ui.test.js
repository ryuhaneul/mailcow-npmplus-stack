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
  let fake, intercept = null;
  const requests = [];
  globalThis.fetch=async(path,options={})=>{
    requests.push({path,method:options.method||'GET',signal:options.signal});
    if(intercept){const response=await intercept(path,options);if(response)return response;}
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
  const setup=(retired=true,blocked=false)=>{intercept=null;requests.length=0;fake=createFakeAdminApi();const row=fake.state.accounts.items.find(row=>row.address===address);row.active=retired?2:1;row.retirement={retired,receiveBlocked:blocked,forwarding:[],recordedAt:'2026-11-01T00:00:00Z'};return {...row,retirement:{...row.retirement,featureEnabled:true,effectiveReceiveBlock:blocked?'on':'off',pendingOperation:null,warnings:[]}};};
  await t.test('allowed/blocked detail states distinguish retirement, login, receive and actual forwarding',async()=>{
    let row=setup();row.retirement.forwarding=['team@example.com'];await mount(RetirementSettings,{row,saved(){}});
    assert.match(root.textContent,/처리됨/);assert.match(root.textContent,/차단됨/);assert.match(root.textContent,/허용 중/);assert.match(root.textContent,/전달: team@example.com/);
    row=setup(true,true);await mount(RetirementSettings,{row,saved(){}});assert.match(root.textContent,/차단 중/);assert.equal(root.querySelector('#receive-block').checked,true);
  });
  await t.test('server OFF hides blocking and legacy hides its entire settings form',async()=>{
    let row=setup();row.retirement.featureEnabled=false;await mount(RetirementSettings,{row,saved(){}});assert.match(root.textContent,/서버 기능 꺼짐/);assert.equal(root.querySelector('#receive-block'),null);assert.equal(root.querySelector('.ac-notice.warn'),null);
    row=setup(false);row.active=2;let recorded=0;await mount(RetirementSettings,{row,saved(){},record(){recorded++;}});assert.match(root.textContent,/퇴사 확인 필요/);assert.equal(root.querySelector('form'),null);assert.equal(root.querySelector('#retirement-mail-mode'),null);await click('퇴사 기록 남기기');assert.equal(recorded,1);
  });
  await t.test('server OFF keeps forwarding editable without showing an unchanged preview',async()=>{
    const row=setup();fake.state.accounts.retirementFeatureEnabled=false;row.retirement.featureEnabled=false;
    await mount(RetirementSettings,{row,saved(){}});assert.equal(root.querySelector('#receive-block'),null);assert.equal(root.querySelector('#retirement-mail-mode').matches(':disabled'),false);assert.equal([...root.querySelectorAll('button')].some(node=>node.textContent==='변경 미리보기'),false);
    await change('#retirement-mail-mode','forward');assert.equal([...root.querySelectorAll('button')].some(node=>node.textContent==='변경 미리보기'),false);await change('#share-grantee','team@example.com');await click('변경 미리보기');assert.equal(fake.state.accounts.retirementBodies.at(-1).body.receiveBlocked,false);assert.equal(fake.state.accounts.retirementBodies.at(-1).body.forwardTo,'team@example.com');await change('dialog input[type=checkbox]',true);await click('수신 허용');
    assert.deepEqual(fake.state.accounts.items.find(row=>row.address===address).retirement.forwarding,['team@example.com']);
    row.retirement.forwarding=['team@example.com'];await mount(RetirementSettings,{row,saved(){}});await change('#retirement-mail-mode','remove');await click('변경 미리보기');await change('dialog input[type=checkbox]',true);await click('수신 허용');assert.deepEqual(fake.state.accounts.items.find(row=>row.address===address).retirement.forwarding,[]);
  });
  await t.test('OFF stored blocking hides forwarding and never silently clears the saved choice',async()=>{
    const row=setup(true,true);row.retirement.featureEnabled=false;row.retirement.warnings=[{code:'RECEIVE_BLOCK_UNVERIFIED',message:'저장된 차단 선택의 실제 적용을 확인해야 해요.'}];await mount(RetirementSettings,{row,saved(){}});assert.equal(root.querySelector('form'),null);assert.match(root.textContent,/차단 선택 저장됨.*서버 기능 꺼짐/);assert.equal(root.querySelector('#retirement-mail-mode'),null);assert.equal(root.querySelector('.ac-notice.warn'),null);assert.equal(fake.state.accounts.retirementBodies.length,0);
  });
  await t.test('preview appears only for changed blocking or forwarding; settings recovery is explicit',async()=>{
    const visible=()=>[...root.querySelectorAll('button')].some(node=>node.textContent==='변경 미리보기');
    let row=setup();await mount(RetirementSettings,{row,saved(){}});assert.equal(visible(),false);await change('#receive-block',true);assert.equal(visible(),true);await change('#receive-block',false);assert.equal(visible(),false);await change('#retirement-mail-mode','remove');assert.equal(visible(),false);
    row=setup();row.retirement.forwarding=['team@example.com'];await mount(RetirementSettings,{row,saved(){}});await change('#retirement-mail-mode','forward');await change('#share-grantee','team@example.com');assert.equal(visible(),false);await change('#retirement-mail-mode','remove');assert.equal(visible(),true);await change('#retirement-mail-mode','keep');assert.equal(visible(),false);
    row=setup();row.retirement.pendingOperation={kind:'settings'};await mount(RetirementSettings,{row,saved(){}});assert.equal(visible(),false);await click('남은 정리 미리보기');assert.equal(fake.state.accounts.retirementBodies.at(-1).body.receiveBlocked,false);
    row=setup();row.retirement.pendingOperation={kind:'leave'};await mount(RetirementSettings,{row,saved(){}});assert.equal(root.querySelector('form'),null);
  });
  await t.test('unclassified receive-only detail opens the existing explicit leave record dialog',async()=>{
    setup(false);const row=fake.state.accounts.items.find(row=>row.address===address);row.active=2;delete row.retirement;await mount(AccountDetail,{address,changed(){}});assert.equal(root.querySelector('#retirement-settings form'),null);await click('퇴사 기록 남기기');assert.match(root.querySelector('dialog').textContent,/실행하면 퇴사 기록을 남깁니다/);assert.equal(fake.state.accounts.retirementBodies.length,0);
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
    assert.equal(requests.filter(row=>row.path===`/api/admin/mailboxes/${encodeURIComponent(address)}?view=summary`&&row.method==='GET').length,2);
    assert.equal(requests.filter(row=>row.path===`/api/admin/mailboxes/${encodeURIComponent(address)}/refs`&&row.method==='GET').length,2);
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
  for(const phase of ['preview','run']) await t.test(`D4-1 alreadyRetired ${phase} response shows guidance, never normal success`,async()=>{
    const row=setup(false);let moved=0,closed=0;await mount(LeaveDialog,{row,close(){closed++;},settings(){moved++;}});
    if(phase==='run'){await click('변경 미리보기');await change('dialog input[type=checkbox]',true);}
    intercept=async(path,options)=>path==='/api/admin/flows/leave'?new Response(JSON.stringify({alreadyRetired:true,unchanged:true,result:'unchanged',etag:'optional-etag'}),{status:200,headers:{'Content-Type':'application/json'}}):null;
    await click(phase==='run'?'퇴사 처리 실행':'변경 미리보기');
    assert.match(root.textContent,/이미 퇴사 처리된 계정입니다/);assert.doesNotMatch(root.textContent,/변경 내용을 저장했습니다/);
    await click('계정 설정으로');assert.equal(moved,1);assert.equal(closed,1);
  });
  await t.test('D4-2 known partial steps and recovery survive follow-up GET 503 until successful reload',async()=>{
    setup(true,true);await mount(AccountDetail,{address,changed(){}});await change('#receive-block',false);await click('변경 미리보기');await change('dialog input[type=checkbox]',true);
    let partial=false;
    intercept=async(path,options)=>{
      if(path===`/api/admin/mailboxes/${encodeURIComponent(address)}/retirement`&&options.method==='PATCH'){
        partial=true;return new Response(JSON.stringify({result:'partial',retirement:null,reloadRequired:true,steps:[{stage:'receive-off',status:'ok'},{stage:'complete',status:'failed',code:'RETIREMENT_BLOCK_UNAVAILABLE'}],recovery:[{message:'현재 퇴사·수신 상태와 남은 연결을 다시 미리보기로 확인해 주세요.'}]}),{status:200,headers:{'Content-Type':'application/json'}});
      }
      if(partial&&path===`/api/admin/mailboxes/${encodeURIComponent(address)}?view=summary`)return new Response(JSON.stringify({error:{code:'RETIREMENT_BLOCK_UNAVAILABLE',message:'조회 실패'}}),{status:503,headers:{'Content-Type':'application/json'}});
    };
    await click('수신 허용');await tick();await tick();
    assert.equal(partial,true);assert.match(root.textContent,/일부 변경만 적용/);assert.match(root.textContent,/receive-off · 완료/);assert.match(root.textContent,/complete · 실패 RETIREMENT_BLOCK_UNAVAILABLE/);assert.match(root.textContent,/현재 퇴사·수신 상태와 남은 연결/);assert.match(root.textContent,/현재 계정 상태.*확인/);
    assert.equal(root.querySelector('#receive-block'),null);assert.doesNotMatch(root.textContent,/차단 중|허용 중/);
    intercept=null;await click('다시 시도');await tick();await tick();assert.ok(root.querySelector('#retirement-settings'));assert.match(root.textContent,/receive-off · 완료/);assert.match(root.textContent,/현재 퇴사·수신 상태와 남은 연결/);
  });

  const summaryPath=value=>`/api/admin/mailboxes/${encodeURIComponent(value)}?view=summary`;
  const refsPath=value=>`/api/admin/mailboxes/${encodeURIComponent(value)}/refs`;
  const countGet=path=>requests.filter(row=>row.path===path&&row.method==='GET').length;
  await t.test('summary and OTP display while refs remain pending, without duplicate standalone share reads',async()=>{
    setup(false);let release;const held=new Promise(resolve=>{release=resolve;});
    intercept=async path=>path===refsPath(address)?held:null;
    await mount(AccountDetail,{address,changed(){}});
    assert.ok(root.querySelector('.detail-head h2'));assert.ok(root.querySelector('[data-admin-otp="account"]'));assert.ok([...root.querySelectorAll('button')].some(node=>node.textContent==='수정'));
    assert.equal(root.querySelector('[aria-label="공유 및 연결"]').getAttribute('aria-busy'),'true');
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,320));});
    assert.match(root.querySelector('[aria-label="공유 및 연결"]').textContent,/공유와 연결을 불러오는 중/);
    assert.equal(countGet(summaryPath(address)),1);assert.equal(countGet(refsPath(address)),1);assert.equal(countGet(`/api/admin/shares/${encodeURIComponent(address)}`),0);
    release(null);await tick();await tick();
    assert.match(root.textContent,/이 메일함의 읽기 공유/);assert.equal(root.querySelector('[aria-label="공유 및 연결"]'),null);
    assert.equal(countGet(refsPath(address)),1);
  });
  await t.test('refs failure and retry leave summary and OTP untouched and never render an empty reference list',async()=>{
    setup(false);fake.state.accounts.refsError={status:503,code:'SYNTHETIC_REFS_UNAVAILABLE',message:'합성 조회 실패'};
    await mount(AccountDetail,{address,changed(){}});
    assert.match(root.textContent,/공유와 연결을 불러오지 못했습니다/);assert.ok(root.querySelector('.detail-head h2'));assert.ok(root.querySelector('[data-admin-otp="account"]'));
    assert.equal(root.querySelector('.account-refs table'),null);assert.doesNotMatch(root.querySelector('[aria-label="공유 및 연결"]').textContent,/연결된 항목이 없어요/);
    const otp=`/api/admin/otp/accounts/${encodeURIComponent(address)}`,before=countGet(otp);
    fake.state.accounts.refsError=null;await click('다시 시도');await tick();await tick();
    assert.match(root.textContent,/이 메일함의 읽기 공유/);assert.equal(countGet(refsPath(address)),2);assert.equal(countGet(summaryPath(address)),1);assert.equal(countGet(otp),before);
  });
  await t.test('own unavailable, inactive and partial other-owner results retain distinct warning and action states',async()=>{
    setup(false);fake.state.accounts.ownShareUnavailable=true;await mount(AccountDetail,{address,changed(){}});
    assert.match(root.textContent,/공유 정보 일부를 읽지 못했어요/);assert.match(root.textContent,/이 메일함의 공유를 불러오지 못했습니다/);assert.ok(![...root.querySelectorAll('button')].some(node=>node.textContent==='공유 추가'));
    fake.state.accounts.ownShareUnavailable=false;await click('다시 시도');await tick();assert.ok(button('공유 추가'));
    setup(false);fake.state.accounts.items.find(row=>row.address===address).active=0;await mount(AccountDetail,{address,changed(){}});
    assert.match(root.textContent,/꺼진 메일함의 공유는 확인하지 않았습니다/);assert.ok(![...root.querySelectorAll('button')].some(node=>node.textContent==='공유 추가'));assert.doesNotMatch(root.textContent,/아직 공유한 사람이 없습니다/);
    setup(false);fake.state.accounts.warnings=[{code:'SHARES_PARTIAL',message:'다른 계정의 공유를 확인하지 못했습니다.'}];await mount(AccountDetail,{address,changed(){}});
    assert.match(root.textContent,/다른 계정의 공유를 확인하지 못했습니다/);assert.ok(button('공유 추가'));
  });
  await t.test('share writes refresh refs alone and the next mutation uses the fresh shared card etag',async()=>{
    setup(false);const bodies=[];
    intercept=async(path,options)=>{if(path===`/api/admin/shares/${encodeURIComponent(address)}`&&['POST','DELETE'].includes(options.method))bodies.push(JSON.parse(options.body));return null;};
    await mount(AccountDetail,{address,changed(){}});
    const original=fake.state.shares.items.find(row=>row.owner===address).etag,otp=`/api/admin/otp/accounts/${encodeURIComponent(address)}`,otpReads=countGet(otp);
    await click('공유 추가');await change('#share-grantee','team@example.com');await click('읽기 공유 추가');await tick();await tick();
    assert.match(root.textContent,/읽기 공유를 저장했습니다/);assert.equal(bodies[0].etag,original);assert.equal(countGet(refsPath(address)),2);assert.equal(countGet(summaryPath(address)),1);assert.equal(countGet(otp),otpReads);
    const fresh=fake.state.shares.items.find(row=>row.owner===address).etag;assert.notEqual(fresh,original);
    const own=root.querySelector('[aria-label="이 메일함의 읽기 공유"]'),grant=[...own.querySelectorAll('.mini-row')].find(node=>node.textContent.includes('team@example.com'));
    await act(async()=>grant.querySelector('button').click());await tick();await click('공유 빼기');await tick();await tick();
    assert.equal(bodies[1].etag,fresh);assert.equal(countGet(refsPath(address)),3);assert.equal(countGet(summaryPath(address)),1);assert.equal(countGet(`/api/admin/shares/${encodeURIComponent(address)}`),0);
  });
  await t.test('failed refresh after a share mutation removes stale card controls until refs succeed again',async()=>{
    setup(false);intercept=async(path,options)=>{if(path===`/api/admin/shares/${encodeURIComponent(address)}`&&options.method==='POST')fake.state.accounts.refsError={status:503,code:'SYNTHETIC_REFS_UNAVAILABLE',message:'합성 조회 실패'};return null;};
    await mount(AccountDetail,{address,changed(){}});await click('공유 추가');await change('#share-grantee','team@example.com');await click('읽기 공유 추가');await tick();await tick();
    assert.match(root.textContent,/공유와 연결을 불러오지 못했습니다/);assert.ok(![...root.querySelectorAll('button')].some(node=>node.textContent==='공유 추가'));assert.equal(root.querySelector('dialog'),null);assert.equal(root.querySelector('.mini-row'),null);
    fake.state.accounts.refsError=null;await click('다시 시도');await tick();assert.ok(button('공유 추가'));assert.equal(countGet(summaryPath(address)),1);
  });
  await t.test('account edit reloads summary and refs once with the new account data',async()=>{
    setup(false);let changed=0;await mount(AccountDetail,{address,changed(){changed++;}});
    await click('수정');const input=root.querySelector('#edit-name');await act(async()=>{input.value='새 이름';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
    await click('변경 저장');await tick();await tick();await tick();
    assert.equal(changed,1);assert.equal(root.querySelector('.detail-head h2').textContent,'새 이름');assert.equal(countGet(summaryPath(address)),2);assert.equal(countGet(refsPath(address)),2);assert.equal(countGet(`/api/admin/shares/${encodeURIComponent(address)}`),0);
  });
  await t.test('switching accounts aborts delayed refs and ignores a late response even when fetch ignores its signal',async()=>{
    setup(false);const next='team@example.com';let release;const held=new Promise(resolve=>{release=resolve;});
    intercept=async path=>path===refsPath(address)?held:null;
    await mount(AccountDetail,{address,changed(){}});const first=requests.find(row=>row.path===refsPath(address));assert.equal(first.signal.aborted,false);
    await act(async()=>render(h(AccountDetail,{address:next,changed(){}}),root));await tick();await tick();await tick();
    assert.equal(first.signal.aborted,true);const expected=fake.state.accounts.items.find(row=>row.address===next).name;assert.equal(root.querySelector('.detail-head h2').textContent,expected);assert.ok(button('공유 추가'));
    release(new Response(JSON.stringify({address,refs:{aliases:[{address:'late-a@example.test',targets:[address],active:1}]},warnings:[],sharesScope:'teams+own',ownShare:{status:'unavailable',data:null}}),{status:200,headers:{'Content-Type':'application/json'}}));
    await tick();await tick();assert.equal(root.querySelector('.detail-head h2').textContent,expected);assert.doesNotMatch(root.textContent,/late-a@example.test/);assert.ok(button('공유 추가'));assert.equal(countGet(refsPath(next)),1);
  });

  const keptPath=value=>`/api/admin/mailboxes/${encodeURIComponent(value)}/refs?scope=all`;
  await t.test('keeping shares defers the list until clicked and does not change consent or the execution payload',async()=>{
    const row=setup(false);await mount(LeaveDialog,{row,close(){}});await click('변경 미리보기');
    assert.equal(fake.state.accounts.retirementBodies.at(-1).body.cleanShares,false);assert.match(root.textContent,/기존 읽기 공유는 변경하지 않습니다/);assert.ok(button('공유 목록 보기'));assert.equal(countGet(keptPath(address)),0);
    assert.equal(root.querySelector('table[aria-label="읽기 공유"]'),null);await change('dialog input[type=checkbox]',true);const expected=`synthetic-account-${fake.state.accounts.version}`;
    await click('공유 목록 보기');await tick();assert.equal(countGet(keptPath(address)),1);assert.ok(root.querySelector('table[aria-label="유지할 읽기 공유"]'));assert.match(root.textContent,/공유 유지/);assert.equal(button('퇴사 처리 실행').disabled,false);
    await click('퇴사 처리 실행');const body=fake.state.accounts.retirementBodies.at(-1).body;
    assert.deepEqual(Object.keys(body).sort(),['address','mode','cleanRefs','cleanShares','receiveBlocked','forwardTo','action','etag','cleanupConfirmed'].sort());assert.equal(body.etag,expected);assert.equal(body.cleanShares,false);assert.equal(body.cleanupConfirmed,true);
  });
  await t.test('kept share read failure retries independently and does not block consent or execution',async()=>{
    const row=setup(false);fake.state.accounts.refsError={status:503,code:'SYNTHETIC_REFS_UNAVAILABLE',message:'합성 공유 조회 실패'};
    await mount(LeaveDialog,{row,close(){}});await click('변경 미리보기');await click('공유 목록 보기');
    assert.match(root.textContent,/유지할 공유를 불러오지 못했습니다/);assert.equal(root.querySelector('table[aria-label="유지할 읽기 공유"]'),null);assert.equal(button('퇴사 처리 실행').disabled,true);
    await change('dialog input[type=checkbox]',true);assert.equal(button('퇴사 처리 실행').disabled,false);
    fake.state.accounts.refsError=null;await click('다시 시도');await tick();assert.ok(root.querySelector('table[aria-label="유지할 읽기 공유"]'));assert.equal(countGet(keptPath(address)),2);assert.equal(fake.state.accounts.retirementBodies.length,1);assert.equal(button('퇴사 처리 실행').disabled,false);
  });
  await t.test('changing share cleanup resets preview and consent, aborts old reads and discards late kept-share results',async()=>{
    const row=setup(false);let release;const held=new Promise(resolve=>{release=resolve;});intercept=async path=>path===keptPath(address)?held:null;
    await mount(LeaveDialog,{row,close(){}});await click('변경 미리보기');await change('dialog input[type=checkbox]',true);await click('공유 목록 보기');
    const old=requests.find(row=>row.path===keptPath(address));assert.equal(old.signal.aborted,false);
    await click('이전');await change('#leave-clean-shares',true);assert.equal(old.signal.aborted,true);assert.equal(root.querySelector('table[aria-label="유지할 읽기 공유"]'),null);await click('변경 미리보기');
    assert.equal(fake.state.accounts.retirementBodies.at(-1).body.cleanShares,true);assert.equal(button('퇴사 처리 실행').disabled,true);assert.equal(root.querySelector('dialog input[type=checkbox]').checked,false);assert.ok(root.querySelector('table[aria-label="읽기 공유"]'));
    release(new Response(JSON.stringify({address,refs:{shares:[{owner:'late-kept@example.test',grantee:address,mailbox:'INBOX',rights:['lookup','read']}]},warnings:[],sharesScope:'all'}),{status:200,headers:{'Content-Type':'application/json'}}));await tick();await tick();
    assert.doesNotMatch(root.textContent,/late-kept@example.test/);assert.equal(button('퇴사 처리 실행').disabled,true);
    await click('이전');await change('#leave-clean-shares',false);await click('변경 미리보기');assert.ok(button('공유 목록 보기'));assert.equal(countGet(keptPath(address)),1);assert.equal(button('퇴사 처리 실행').disabled,true);
  });
  await t.test('closing a leave dialog aborts a pending kept-share read and cannot revive its view',async()=>{
    const row=setup(false);let release,closed=0;const held=new Promise(resolve=>{release=resolve;});intercept=async path=>path===keptPath(address)?held:null;
    await mount(LeaveDialog,{row,close(){closed++;render(null,root);}});await click('변경 미리보기');await click('공유 목록 보기');const old=requests.find(row=>row.path===keptPath(address));
    await act(async()=>root.querySelector('dialog').dispatchEvent(new dom.window.Event('cancel',{cancelable:true})));await tick();assert.equal(closed,1);assert.equal(old.signal.aborted,true);
    release(new Response(JSON.stringify({address,refs:{shares:[]},warnings:[],sharesScope:'all'}),{status:200,headers:{'Content-Type':'application/json'}}));await tick();assert.equal(root.textContent,'');
  });
  await t.test('long execution errors retain a focusable footer and preserve 409 versus retryable failure policy',async()=>{
    for(const status of [503,409]){
      const row=setup(false);await mount(LeaveDialog,{row,close(){}});await click('변경 미리보기');await change('dialog input[type=checkbox]',true);
      intercept=async(path,options)=>path==='/api/admin/flows/leave'&&JSON.parse(options.body).action==='run'?new Response(JSON.stringify({error:{code:status===409?'CHANGED_ELSEWHERE':'SYNTHETIC_UNAVAILABLE',message:'긴 오류 안내 '.repeat(80)}}),{status,headers:{'Content-Type':'application/json'}}):null;
      await click('퇴사 처리 실행');const run=button('퇴사 처리 실행'),back=button('이전'),footer=run.closest('.footer-actions');
      assert.ok(footer);assert.equal(footer.parentElement.tagName,'FORM');assert.equal(footer.closest('fieldset'),null);assert.equal(footer.parentElement.lastElementChild,footer);assert.equal(run.disabled,status===409);assert.equal(back.disabled,false);
      back.focus();assert.equal(document.activeElement,back);if(status!==409){run.focus();assert.equal(document.activeElement,run);}
    }
  });

});
