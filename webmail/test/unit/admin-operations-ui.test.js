import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';
import { syncBoolean,syncOptions,syncOptionRows,selectedSyncIds } from '../../web/src/admin/pages/sync-options.js';
test('sync string flags become JSON booleans',()=>{for(const value of[true,1,'1'])assert.equal(syncBoolean(value),true);for(const value of[false,0,'0',null,undefined,'false'])assert.equal(syncBoolean(value),false);});
test('sync editable options are projected without log or source credential fields',()=>{const options=syncOptions({maxage:'0',mins_interval:'20',delete1:'0',delete2:'1',delete2duplicates:'1',custom_params:'--useuid',log:'***',password1:'synthetic'});assert.deepEqual(options,{maxage:0,mins_interval:20,delete2duplicates:true,delete1:false,delete2:true,custom_params:'--useuid'});});
test('sync options before/after comparison covers every selected job',()=>{const jobs=[{user2:'a@example.com',maxage:0,mins_interval:20},{user2:'b@example.com',maxage:30,mins_interval:40}];const rows=syncOptionRows(jobs,syncOptions(jobs[0]));assert.equal(rows.length,12);assert.equal(rows[6][1],'30');assert.equal(rows[6][2],'0');assert.ok(rows.every(row=>row.length===3));});
test('sync raw custom arguments remain visible in comparison',()=>{const row={user2:'a@example.com',maxage:0,mins_interval:20,custom_params:'--showpasswords'};assert.deepEqual(syncOptionRows([row],{...syncOptions(row),custom_params:''}).at(-1).slice(1),['--showpasswords','없음']);});

test('sync selection intersects refreshed jobs after deletion, including no remaining selection',()=>{
 const selected=['1','2','gone'];
 assert.deepEqual(selectedSyncIds(selected,[{id:2},{id:3}]),['2']);
 assert.deepEqual(selectedSyncIds(['1'],[{id:2}]),[]);
 assert.deepEqual(selectedSyncIds(selected,[]),[]);
 assert.deepEqual(selected,['1','2','gone']);
});


test('overview administrator rows, automatic emptying copy and independent load errors follow the contract', async () => {
 const { createServer } = await import('vite');
 const { fileURLToPath } = await import('node:url');
 const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), server: { middlewareMode: true, watch: null }, appType: 'custom' });
 try {
  const { administratorRow, autoexpungeMessage, Result } = await server.ssrLoadModule('/src/admin/pages/Overview.jsx');
  const created = '2026-10-16 03:04:05';
  for (const active of [false, true]) for (const tfaActive of [false, true]) for (const forceTfa of [false, true]) for (const forcePwUpdate of [false, true]) {
   assert.deepEqual(administratorRow({ username: 'admin-example', active, tfaActive, forceTfa, forcePwUpdate, created }), ['admin-example', active ? '사용' : '꺼짐', tfaActive ? '사용' : '안 씀', [forceTfa && '2단계 등록 필요', forcePwUpdate && '암호 변경 필요'].filter(Boolean).join(' · ') || '없음', created]);
  }
  for (const days of [1, 30, 365]) assert.equal(autoexpungeMessage(days), `스팸·휴지통에서 ${days}일 지난 메일을 자동으로 지웁니다`);
  assert.equal(autoexpungeMessage(null), '꺼져 있습니다');
  for (const code of ['ADMINS_FAILED', 'AUTOEXPUNGE_FAILED']) {
   const error = { code }, reload = () => {};
   const result = Result({ resource: { loading: false, error, reload }, children: '성공' });
   assert.equal(result.type.name, 'LoadError');
   assert.equal(result.props.error, error);
   assert.equal(result.props.retry, reload);
  }
  assert.equal(Result({ resource: { loading: false, error: null }, children: '성공' }), '성공');
  assert.equal(Result({ resource: { loading: true } }).type.name, 'Loading');
 } finally { await server.close(); }
});
for (const blacklisted of [false,true]) test(`fail2ban unwhitelist fixture removes selected entry and preserves other data (blacklisted=${blacklisted})`,async()=>{
 const fake=createFakeAdminApi(),data=fake.state.fail2ban,name=data.whitelist[0];
 data.whitelist.push('2001:db8::/32');if(blacklisted)data.blacklist.push(name);
 const initial=structuredClone(data);let result;
 await fake.middleware({url:'/api/admin/fail2ban/actions',method:'POST',headers:{},async *[Symbol.asyncIterator](){yield JSON.stringify({network:name,action:'unwhitelist'});}}, {setHeader(){},end(body){result=JSON.parse(body);}},()=>assert.fail('unexpected next'));
 assert.deepEqual(result,{network:name,whitelist:false,blacklist:blacklisted,auditId:'77777777777777777777777777777777'});
 assert.deepEqual(data,{...initial,whitelist:['2001:db8::/32']});
});
test('fail2ban unwhitelist fixture returns404 for absent entry without mutation',async()=>{
 const fake=createFakeAdminApi(),initial=structuredClone(fake.state.fail2ban);let result;
 const response={setHeader(){},end(body){result=JSON.parse(body);}};
 await fake.middleware({url:'/api/admin/fail2ban/actions',method:'POST',headers:{},async *[Symbol.asyncIterator](){yield JSON.stringify({network:'192.0.2.99',action:'unwhitelist'});}},response,()=>assert.fail('unexpected next'));
 assert.equal(response.statusCode,404);assert.deepEqual(result.error,{status:404,code:'NOT_FOUND',message:'차단 안 함 목록에 없는 주소예요.'});assert.deepEqual(fake.state.fail2ban,initial);
});

async function monitorFakeRequest(fake,path,{method='GET',body}={}) {
 let result;const response={setHeader(){},end(value){result=JSON.parse(value);}};
 await fake.middleware({url:path,method,headers:{'x-mailadmin-csrf':fake.state.session.csrf},async *[Symbol.asyncIterator](){if(body)yield JSON.stringify(body);}},response,()=>assert.fail('unexpected next'));
 return {status:response.statusCode??200,body:result};
}
test('monitor draft validation, numeric payload and window-only changes preserve bounce settings',async()=>{
 const {defaultMonitorSettings}=await import('../../server/admin/mail-monitor-state.js');const {monitorSettingsValid,numericMonitorSettings,monitorChanges}=await import('../../web/src/admin/pages/monitor.js');
 const before=defaultMonitorSettings(),after=structuredClone(before);assert.equal(monitorSettingsValid(before),true);after.rules.relayReceived.windowMinutes=15;assert.equal(monitorChanges(before,after).length,1);
 after.enabled=true;assert.equal(monitorSettingsValid(after),false);after.recipients=['ops@example.com'];after.repeatMinutes='60';after.rules.account[0].threshold='51';assert.equal(monitorSettingsValid(after),true);assert.equal(numericMonitorSettings(after).rules.account[0].threshold,51);assert.deepEqual(numericMonitorSettings(after).bounceAuto,before.bounceAuto);
 for(const value of ['',0,-1,1.5,'NaN']){after.repeatMinutes=value;assert.equal(Boolean(monitorSettingsValid(after)),false);}
});
test('monitor fixture has two independent account windows, unknown/disabled states and shared-etag conflicts',async()=>{
 const fake=createFakeAdminApi();const view=(await monitorFakeRequest(fake,'/api/admin/monitor')).body;
 const status=(await monitorFakeRequest(fake,'/api/admin/monitor/status')).body;assert.equal(status.metrics.length,5);assert.notEqual(status.metrics[0].windows[0].target,status.metrics[0].windows[1].target);
 fake.state.monitor.mode='partial';const partial=(await monitorFakeRequest(fake,'/api/admin/monitor/status')).body.metrics.find(m=>m.item==='total').windows[1];assert.equal(partial.value,null);assert.equal(partial.complete,false);assert.equal(partial.reason,'ARCHIVE_GAP');assert.ok(partial.previous);
 fake.state.monitor.mode='warmup';assert.equal((await monitorFakeRequest(fake,'/api/admin/monitor/status')).body.metrics[0].windows[0].reason,'WARMING_UP');
 const saved=await monitorFakeRequest(fake,'/api/admin/monitor',{method:'PUT',body:{...view.settings,enabled:false,etag:view.etag}});assert.equal(saved.status,200);assert.equal((await monitorFakeRequest(fake,'/api/admin/monitor/status')).body.enabled,false);
 assert.equal((await monitorFakeRequest(fake,'/api/admin/monitor',{method:'PUT',body:{...view.settings,etag:view.etag}})).status,409);
});
test('bounce fixture resolution is independent of suppression; old server fields remain optional',async()=>{
 const fake=createFakeAdminApi(),list=(await monitorFakeRequest(fake,'/api/admin/bounces?limit=50')).body,row=list.items.find(r=>r.id==='bounce-2');const before=structuredClone(row.manual);
 const result=await monitorFakeRequest(fake,'/api/admin/bounces/'+row.id+'/resolution',{method:'PUT',body:{resolved:true,etag:row.etag}});assert.equal(result.status,200);assert.ok(result.body.resolvedAt);assert.deepEqual(result.body.manual,before);assert.equal(result.body.state,'manual');
 const filtered=(await monitorFakeRequest(fake,'/api/admin/bounces?state=resolved')).body;assert.ok(filtered.items.some(r=>r.id===row.id));
 const unresolved=await monitorFakeRequest(fake,'/api/admin/bounces/'+row.id+'/resolution',{method:'PUT',body:{resolved:false,etag:result.body.etag}});assert.equal(unresolved.body.resolvedAt,null);assert.deepEqual(unresolved.body.manual,before);
 const {bounceStatus}=await import('../../web/src/admin/pages/bounces.js');assert.equal(bounceStatus({...row,internalExcluded:true}).state,'internal');assert.equal(bounceStatus({...row,manual:{until:'2000-01-01T00:00:00.000Z'},state:'none'}).state,'none');
});
test('CSV export drains all filtered pages, includes BOM/KST/sender and escapes formulas',async()=>{
 const {exportBouncesCsv}=await import('../../web/src/admin/pages/bounces.js');const fake=createFakeAdminApi(),template=fake.state.bounces.items[3];fake.state.bounces.items=Array.from({length:71},(_,i)=>({...template,id:'csv-'+i,recipient:(i?'csv'+i:'=FORMULA')+'@example.net',sender:'account@example.com',lastSeenAt:'2026-11-05T00:00:00.000Z'}));
 const csv=await exportBouncesCsv(async path=>(await monitorFakeRequest(fake,path)).body,{q:'example.net',state:'resolved'});assert.ok(csv.startsWith('\ufeff'));assert.equal(csv.split('\r\n').filter(Boolean).length,72);assert.ok(csv.includes("'=FORMULA@example.net"));assert.ok(csv.includes('account@example.com'));assert.ok(csv.includes('09:00'));assert.equal(fake.state.bounces.queries.length,2);assert.ok(fake.state.bounces.queries.every(q=>q.includes('state=resolved')&&q.includes('q=example.net')));
 await assert.rejects(exportBouncesCsv(async()=>({items:[],total:1,nextBefore:null})),/목록이 바뀌었습니다/);
});
test('settings and approved monitoring pages compile with existing admin components; overview keeps its sections',async()=>{
 const {createServer}=await import('vite');const {fileURLToPath}=await import('node:url');const {readFile}=await import('node:fs/promises');
 const server=await createServer({root:fileURLToPath(new URL('../../web',import.meta.url)),configFile:fileURLToPath(new URL('../../web/vite.admin.config.js',import.meta.url)),server:{middlewareMode:true,watch:null},appType:'custom'});
 try{
  for(const name of ['Settings','Monitor','Bounces'])assert.equal(typeof(await server.ssrLoadModule('/src/admin/pages/'+name+'.jsx')).default,'function');
  const {monitorAlertItemCount}=await server.ssrLoadModule('/src/admin/pages/Monitor.jsx');
  assert.equal(monitorAlertItemCount([{windows:[{complete:true,status:'warning'},{complete:true,status:'exceeded'}]},{windows:[{complete:true,status:'exceeded'}]},{windows:[{complete:true,status:'normal'}]},{windows:[{complete:false,status:'warning'}]}]),2);assert.equal(monitorAlertItemCount(),0);
  const Cards=(await server.ssrLoadModule('/src/admin/components/MonitoringStatusCards.jsx')).default;assert.equal(Cards({resource:{loading:true}}).props['aria-label'],'감시 상태');const disabled=Cards({resource:{data:{enabled:false}}});assert.ok(disabled);
  const settings=(await server.ssrLoadModule('/src/admin/pages/Settings.jsx')).default({parts:['bounces']});assert.equal(settings.props.children.at(-1).type.name,'Bounces');
  const overview=await readFile(new URL('../../web/src/admin/pages/Overview.jsx',import.meta.url),'utf8');assert.equal((overview.match(/<MonitoringStatusCards /g)||[]).length,1);assert.ok(overview.indexOf('<StatusCards ')<overview.indexOf('<MonitoringStatusCards '));assert.ok(overview.indexOf('<MonitoringStatusCards ')<overview.indexOf('<h2>인증서'));
  for(const section of ['메일 큐','메일 저장소','호환 사용량','메일 자동 비움'])assert.ok(overview.includes(section));
  assert.ok(overview.includes('<AdminAccounts resource={admins}/>'));
  const admins=await readFile(new URL('../../web/src/admin/components/AdminAccounts.jsx',import.meta.url),'utf8');assert.ok(admins.includes('mailcow 관리자'));
  assert.ok(overview.indexOf('<AdminAccounts ')>overview.indexOf('호환 사용량'));assert.ok(overview.indexOf('<AdminAccounts ')<overview.indexOf('메일 자동 비움'));
  const css=await readFile(new URL('../../web/src/admin/pages/monitor.css',import.meta.url),'utf8');assert.ok(css.includes('white-space:normal'));assert.ok(css.includes('border:1px solid var(--line-2)'));assert.ok(!css.includes('border-color:var(--ink-3)'));
 }finally{await server.close();}
});

test('bounce auto/manual/resolved filters and sender search are wired to the new server contract',async()=>{
 const fake=createFakeAdminApi();for(const [state,expected] of [['auto','bounce-1'],['manual','bounce-2'],['resolved','bounce-4']]){const result=(await monitorFakeRequest(fake,'/api/admin/bounces?state='+state)).body;assert.equal(result.items.length,1);assert.equal(result.items[0].id,expected);}
 assert.equal((await monitorFakeRequest(fake,'/api/admin/bounces?q=bulk%40example.com')).body.items[0].id,'bounce-4');
 const {readFile}=await import('node:fs/promises');const page=await readFile(new URL('../../web/src/admin/pages/Bounces.jsx',import.meta.url),'utf8');
 for(const [state,label] of [['auto','자동 억제'],['manual','수동 억제'],['resolved','정리 완료']])assert.ok(page.includes("['"+state+"','"+label+"']"));assert.ok(page.includes("Object.hasOwn(row,'resolvedAt')"));assert.ok(page.includes("row.sender||'확인 불가'"));
});


test('bounce collection gap warning supports legacy responses and shows retained gap count',async()=>{
 const {bounceGapWarning}=await import('../../web/src/admin/pages/bounces.js');
 assert.equal(bounceGapWarning(undefined),'');assert.equal(bounceGapWarning({completedEnd:null}),'');assert.equal(bounceGapWarning({gapCount:0}),'');
 assert.equal(bounceGapWarning({gapCount:1}),'보관 로그 빈 구간 1개 — 그 사이 반송은 빠졌을 수 있음');
 assert.equal(bounceGapWarning({gapCount:20}),'보관 로그 빈 구간 20개 — 그 사이 반송은 빠졌을 수 있음');
 const {readFile}=await import('node:fs/promises');const page=await readFile(new URL('../../web/src/admin/pages/Bounces.jsx',import.meta.url),'utf8');
 assert.ok(page.includes('bounceGapWarning(resource.data?.collection)'));assert.ok(page.includes('{gapWarning&&<span>{gapWarning}</span>}'));
});
