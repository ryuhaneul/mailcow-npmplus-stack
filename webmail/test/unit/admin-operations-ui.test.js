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
