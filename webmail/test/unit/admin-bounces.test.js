import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createMonitorStore, emptyBounces } from '../../server/admin/mail-monitor-state.js';
import { createBouncesService, bounceEvent, bounceSenderEvent } from '../../server/admin/services/bounces.js';
import { createBouncePolicy } from '../../server/admin/bounce-policy.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createMonitorService } from '../../server/admin/services/mail-monitor.js';
import { installAdminGuard } from '../../server/admin/guard.js';
import { AppError, installErrors } from '../../server/errors.js';
import bouncesRoutes from '../../server/admin/routes/bounces.js';
const T=Date.parse('2026-11-05T10:00:00.000Z'), iso=n=>new Date(n).toISOString();
function row(id, recipient='Missing@example.net', dsn='5.1.1', at=T-60000) {return {id,time:iso(at),program:'postfix/smtp',message:`Q${id}: to=<${recipient}>, relay=mx.example.net[192.0.2.10]:25, dsn=${dsn}, status=bounced (host said: 550 private arbitrary text)`,truncated:false,unknownTime:false};}
async function fixture(t, options={}) {
  const dir=await fs.mkdtemp(join(tmpdir(),'bounces-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let time=T, rows=[], failure=null, calls=0;
  const store=createMonitorStore({dir});const settings=await store.readSettings();settings.bounceAuto.enabled=true;await store.saveSettings(settings);
  const policy=createBouncePolicy({now:()=>time});
  const mailcow={createApiContext:()=>({permission:'read'}),call:async(_ctx,_method,path)=>{calls++;if(failure==='domains')throw Error('synthetic');return path.endsWith('alias-domain/all')?[{alias_domain:'alias.example.com',active:0}]:[{domain_name:'example.com',active:0,backupmx:1}];}};
  const archive={enabled:true,status:async()=>({sources:{postfix:{lastSuccessfulCollectionAt:iso(time)}}}),search:async query=>{if(failure==='archive')throw Error('synthetic');return {lines:rows.filter(r=>Date.parse(r.time)>=Date.parse(query.start)&&Date.parse(r.time)<Date.parse(query.end)),nextCursor:null,partialReason:null,incomplete:false,scannedBytes:100,coverage:{source:'postfix',oldest:null,newest:null,gaps:[]}};}};
  const audit={run:async(_event,fn)=>fn()};const lock=createResourceLock();
  const service=createBouncesService({store,policy,mailcow,logArchive:archive,audit,lock,now:()=>time,...options});await service.initialize();
  return {dir,store,policy,service,mailcow,archive,audit,lock,time:v=>{time=v;},rows:v=>{rows=v;},failure:v=>{failure=v;},calls:()=>calls};
}
const fields=recipient=>({request:'smtpd_access_policy',protocol_state:'RCPT',policy_context:'mailstack-bounce',recipient});
const args=(r,extra={})=>({id:r.id,actor:'admin',ip:'192.0.2.20',data:{etag:r.etag,...extra}});
test('persistent bounce state has strict schema, size and permissions; corruption never becomes empty',async t=>{
  const f=await fixture(t);await f.store.saveBounces(emptyBounces());assert.equal((await fs.stat(join(f.dir,'bounces.json'))).mode&0o777,0o600);
  await fs.writeFile(join(f.dir,'bounces.json'),'{}');await assert.rejects(f.store.readBounces(),{statusCode:503});
  await fs.unlink(join(f.dir,'bounces.json'));await fs.symlink(join(f.dir,'settings.json'),join(f.dir,'bounces.json'));await assert.rejects(f.store.readBounces(),{statusCode:503});
  await fs.unlink(join(f.dir,'bounces.json'));await f.store.saveBounces(emptyBounces());await fs.chmod(join(f.dir,'bounces.json'),0o644);await assert.rejects(f.store.readBounces(),{statusCode:503});
  const many=emptyBounces();many.seen=Array.from({length:200000},(_,i)=>({key:i.toString(16).padStart(64,'0'),at:iso(T)}));await assert.rejects(f.store.saveBounces(many),{statusCode:503});
});
test('collects only permanent terminal failures; automatic codes, internal aliases, exact address normalization',async t=>{
  const f=await fixture(t);f.rows([row('1'),row('2','null@example.net','5.1.10'),row('3','moved@example.net','5.1.6'),row('4','full@example.net','5.2.2'),row('5','policy@example.net','5.7.1'),row('6','a@example.com'),row('7','a@alias.example.com'),row('8','User+Tag@EXAMPLE.NET'),row('9','이름@example.net'),row('10','a@example.net','4.1.1'),{...row('11'),message:row('11').message.replace('status=bounced','status=deferred')}]);
  assert.equal((await f.service.runOnce()).complete,true);const list=await f.service.list();assert.equal(list.total,9);
  for(const recipient of ['Missing@example.net','null@example.net','User+Tag@example.net'])assert.match(f.policy.action(fields(recipient)),/^450 4\.7\.1/);
  for(const recipient of ['moved@example.net','full@example.net','policy@example.net','a@example.com','a@alias.example.com','이름@example.net'])assert.equal(f.policy.action(fields(recipient)),'DUNNO');
  assert.ok(list.items.every(r=>!r.lastReason.includes('private')));assert.equal((await f.service.list({state:'internal'})).total,2);
  assert.equal(bounceEvent({...row('test'),message:row('test').message.replace('dsn=5.1.1, ','')}),null);
});
test('same terminal event survives archive row-id replacement, no rescan TTL extension; new event extends',async t=>{
  const f=await fixture(t);f.rows([row('1')]);await f.service.runOnce();const before=(await f.service.list()).items[0];
  f.rows([{...row('1'),id:'repacked'}]);await f.service.runOnce();assert.equal((await f.service.list()).items[0].bounceCount,1);assert.equal((await f.service.list()).items[0].autoUntil,before.autoUntil);
  f.time(T+300000);f.rows([row('1'),row('2','Missing@example.net','5.1.1',T+60000)]);await f.service.runOnce();const after=(await f.service.list()).items[0];assert.equal(after.bounceCount,2);assert.ok(after.autoUntil>before.autoUntil);
  const count=f.calls();f.policy.action(fields(before.recipient));assert.equal(f.calls(),count);
});
test('first tick after an archived bounce collects and suppresses it without five-minute alignment',async t=>{
  const f=await fixture(t);await f.service.runOnce();
  const bounceAt=T+48000, tick=T+299000, collectedAt=T+298000;
  f.time(tick);f.rows([row('firsttick','first@example.net','5.1.1',bounceAt)]);
  let statusCalls=0;f.archive.status=async()=>{statusCalls++;return {sources:{postfix:{lastSuccessfulCollectionAt:iso(collectedAt)}}};};
  const requests=[],search=f.archive.search;f.archive.search=async q=>{requests.push(q);return search(q);};
  assert.deepEqual(await f.service.runOnce(),{complete:true,end:iso(collectedAt)});
  assert.equal(statusCalls,1);assert.equal(requests[0].start,iso(T-300000));assert.equal(requests[0].end,iso(collectedAt));
  const item=(await f.service.list()).items[0];assert.equal(item.bounceCount,1);assert.equal(item.autoUntil,iso(bounceAt+3600000));
  assert.match(f.policy.action(fields(item.recipient)),/^450 4\.7\.1/);
});
test('archive success bounds the exclusive end; next tick resumes with overlap and no duplicate events',async t=>{
  const f=await fixture(t);await f.service.runOnce();f.time(T+299000);
  f.rows([row('before','same@example.net','5.1.1',T+48000),row('boundary','same@example.net','5.1.1',T+120000)]);
  let successAt=iso(T+120000);f.archive.status=async()=>({sources:{postfix:{lastSuccessfulCollectionAt:successAt}}});
  assert.equal((await f.service.runOnce()).end,iso(T+120000));
  let item=(await f.service.list()).items[0];assert.equal(item.bounceCount,1);assert.equal(item.autoUntil,iso(T+48000+3600000));
  f.time(T+599000);successAt=iso(T+700000); // A future observation must still be capped by now.
  assert.equal((await f.service.runOnce()).end,iso(T+599000));
  item=(await f.service.list()).items[0];assert.equal(item.bounceCount,2);assert.equal(item.autoUntil,iso(T+120000+3600000));
  assert.equal((await f.store.readBounces()).seen.length,2);
  await f.service.runOnce();assert.equal((await f.service.list()).items[0].bounceCount,2);
});
test('unconfirmed or reversed collection clocks preserve the last complete watermark and suppression',async t=>{
  const f=await fixture(t);f.rows([row('confirmed')]);await f.service.runOnce();const before=await f.store.readBounces();
  f.time(T+299000);
  for(const success of [null,'invalid']){
    f.archive.status=async()=>({sources:{postfix:{lastSuccessfulCollectionAt:success}}});
    assert.equal((await f.service.runOnce()).reason,'COLLECTION_UNCONFIRMED');
  }
  f.archive.status=async()=>{throw Error('synthetic status unavailable');};assert.equal((await f.service.runOnce()).reason,'COLLECTION_UNAVAILABLE');
  f.archive.status=async()=>({sources:{postfix:{lastSuccessfulCollectionAt:iso(T-1)}}});
  assert.equal((await f.service.runOnce()).reason,'CLOCK_REVERSED');
  f.archive.status=async()=>({sources:{postfix:{lastSuccessfulCollectionAt:iso(T+299000)}}});f.time(T-1);
  assert.equal((await f.service.runOnce()).reason,'CLOCK_REVERSED');
  const after=await f.store.readBounces();assert.equal(after.completedEnd,before.completedEnd);assert.deepEqual(after.recipients,before.recipients);assert.deepEqual(after.seen,before.seen);
  assert.match(f.policy.action(fields('Missing@example.net')),/^450 /);
});
test('manual suppression, etags, release watermark, active deletion conflict and tombstones',async t=>{
  const f=await fixture(t);f.rows([row('1')]);await f.service.runOnce();let r=(await f.service.list()).items[0];
  await assert.rejects(f.service.remove(args(r)),{statusCode:409});r=await f.service.suppress(args(r,{mode:'manual'}));assert.match(f.policy.action(fields(r.recipient)),/^550 5\.7\.1/);
  await assert.rejects(f.service.release({...args(r),data:{etag:'stale'}}),{statusCode:409});r=await f.service.release(args(r));assert.equal(f.policy.action(fields(r.recipient)),'DUNNO');
  await f.service.runOnce();assert.equal(f.policy.action(fields(r.recipient)),'DUNNO');r=(await f.service.list()).items[0];await f.service.remove(args(r));await f.service.runOnce();assert.equal((await f.service.list()).total,0);
  f.time(T+300000);f.rows([row('new','Missing@example.net','5.1.1',T+60000)]);await f.service.runOnce();assert.equal((await f.service.list()).total,1);assert.match(f.policy.action(fields(r.recipient)),/^450 /);
});
test('automatic off is immediate, manual remains independent; turning on does not replay old events',async t=>{
  const f=await fixture(t);f.rows([row('1')]);await f.service.runOnce();let r=(await f.service.list()).items[0];r=await f.service.suppress(args(r,{mode:'duration',minutes:10}));
  const settings=await f.store.readSettings();settings.bounceAuto.enabled=false;await f.store.saveSettings(settings);await f.service.settingsChanged();assert.match(f.policy.action(fields(r.recipient)),/^550 /);
  r=await f.service.release(args(r));settings.bounceAuto.enabled=true;await f.store.saveSettings(settings);await f.service.settingsChanged();await f.service.runOnce();assert.equal(f.policy.action(fields(r.recipient)),'DUNNO');
  f.rows([row('internal','a@example.com')]);await f.service.runOnce();const inside=(await f.service.list({state:'internal'})).items[0];await assert.rejects(f.service.suppress(args(inside,{mode:'manual'})),{statusCode:422});
});
test('failed chunks do not advance watermark; initial retry anchor and bounded catch-up are durable',async t=>{
  const f=await fixture(t);f.failure('archive');await f.service.runOnce();const failed=await f.store.readBounces();assert.equal(failed.completedEnd,null);assert.equal(failed.startedAt,iso(T-300000));
  f.time(T+7200000);f.failure(null);const requests=[];const original=f.archive.search;f.archive.search=async q=>{requests.push(q);return original(q);};await f.service.runOnce();const state=await f.store.readBounces();assert.equal(state.completedEnd,iso(T+7200000));assert.equal(requests.length,25);assert.ok(requests.every(q=>Date.parse(q.end)-Date.parse(q.start)===300000));
  f.archive.search=async()=>{throw Object.assign(Error(),{statusCode:429});};await f.service.runOnce();assert.equal((await f.store.readBounces()).completedEnd,state.completedEnd);
});
test('one-hour backlog commits twelve consecutive five-minute advances with overlap only in the first window',async t=>{
  const f=await fixture(t);f.rows([row('prior')]);await f.service.runOnce();
  const requests=[],saved=[],search=f.archive.search,save=f.store.saveBounces;
  f.time(T+3600000);f.rows([row('prior'),...Array.from({length:12},(_,i)=>row('catch'+i,'same@example.net','5.1.1',T+i*300000+60000))]);
  f.archive.search=async q=>{requests.push(q);return search(q);};
  f.store.saveBounces=async state=>{await save(state);saved.push(state.completedEnd);};
  assert.deepEqual(await f.service.runOnce(),{complete:true,end:iso(T+3600000)});
  assert.equal(requests.length,12);
  assert.deepEqual(saved,Array.from({length:12},(_,i)=>iso(T+(i+1)*300000)));
  for(let i=0;i<12;i++){
    assert.equal(requests[i].start,iso(i===0?T-300000:T+i*300000));
    assert.equal(requests[i].end,iso(T+(i+1)*300000));
  }
  const state=await f.store.readBounces();assert.equal(state.seen.length,13);assert.equal(state.recipients.find(r=>r.recipient==='same@example.net').bounceCount,12);
  await f.service.runOnce();assert.equal((await f.store.readBounces()).seen.length,13);
});
test('failure in a later window preserves earlier commits and the next tick resumes without duplicate bounces',async t=>{
  const f=await fixture(t);await f.service.runOnce();f.time(T+3600000);
  f.rows(Array.from({length:12},(_,i)=>row('resume'+i,'same@example.net','5.1.1',T+i*300000+60000)));
  const search=f.archive.search;let calls=0;
  f.archive.search=async q=>{if(++calls===4)throw Object.assign(Error(),{code:'LOG_ARCHIVE_UNAVAILABLE'});return search(q);};
  assert.deepEqual(await f.service.runOnce(),{complete:false,reason:'LOG_ARCHIVE_UNAVAILABLE'});
  const failed=await f.store.readBounces();assert.equal(failed.completedEnd,iso(T+900000));assert.equal(failed.seen.length,3);assert.equal(failed.recipients[0].bounceCount,3);
  assert.match(f.policy.action(fields('same@example.net')),/^450 /);
  const requests=[];f.archive.search=async q=>{requests.push(q);return search(q);};
  assert.equal((await f.service.runOnce()).end,iso(T+3600000));assert.equal(requests.length,9);assert.equal(requests[0].start,iso(T+600000));assert.equal(requests[0].end,iso(T+1200000));
  const resumed=await f.store.readBounces();assert.equal(resumed.seen.length,12);assert.equal(resumed.recipients[0].bounceCount,12);assert.equal(resumed.collection.reason,null);
});
test('all catch-up windows share the tick time budget and retain the last completed window at the deadline',async t=>{
  let clock=0;const f=await fixture(t,{monotonicNow:()=>clock});await f.service.runOnce();f.time(T+3600000);
  const search=f.archive.search;let requests=0;
  f.archive.search=async q=>{requests++;const result=await search(q);clock+=50000;return result;};
  assert.equal((await f.service.runOnce()).reason,'COLLECTION_LIMIT');assert.equal(requests,3);
  assert.equal((await f.store.readBounces()).completedEnd,iso(T+600000));
  f.archive.search=search;assert.equal((await f.service.runOnce()).end,iso(T+3600000));
});
test('partial page failure and store commit failure never publish partial suppression',async t=>{
  const f=await fixture(t);f.archive.search=async q=>q.cursor?Promise.reject(Error('synthetic')):{lines:[row('1')],nextCursor:'next',partialReason:'limit',incomplete:true,scannedBytes:100,coverage:{source:'postfix',oldest:null,newest:null,gaps:[]}};
  assert.equal((await f.service.runOnce()).complete,false);assert.equal((await f.service.list()).total,0);assert.equal((await f.store.readBounces()).completedEnd,null);
  f.archive.search=async()=>({lines:[row('1')],nextCursor:null,partialReason:null,incomplete:false,scannedBytes:100,coverage:{source:'postfix',oldest:null,newest:null,gaps:[]}});
  const original=f.store.saveBounces;f.store.saveBounces=async()=>{throw new AppError(503,'MONITOR_STORE_UNAVAILABLE','synthetic');};await f.service.runOnce();assert.equal(f.policy.action(fields('Missing@example.net')),'DUNNO');f.store.saveBounces=original;assert.equal((await f.store.readBounces()).completedEnd,null);
});
test('collector merges latest manual release during network wait and audit failure prevents writes',async t=>{
  const f=await fixture(t);f.rows([row('1')]);await f.service.runOnce();let r=(await f.service.list()).items[0];
  const original=f.archive.search;f.archive.search=async q=>{r=await f.service.release(args(r));return original(q);};await f.service.runOnce();assert.equal(f.policy.action(fields(r.recipient)),'DUNNO');
  const before=await f.store.readBounces();f.audit.run=async()=>{throw Error('audit unavailable');};await assert.rejects(f.service.suppress(args(r,{mode:'manual'})));assert.deepEqual(await f.store.readBounces(),before);
});
test('pagination, filtering and strict input limits; domain failures disable stale policy until refresh',async t=>{
  const f=await fixture(t);f.rows(Array.from({length:60},(_,i)=>row(String(i),'u'+i+'@example.net')));await f.service.runOnce();const first=await f.service.list();assert.equal(first.items.length,50);const second=await f.service.list({before:first.nextBefore});assert.equal(second.items.length,10);assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,60);
  assert.equal((await f.service.list({q:'u0@',state:'suppressed'})).total,1);
  for(const query of [{limit:'101'},{state:'bad'},{before:'bad'},{q:'x'.repeat(201)},{unknown:'value'}])await assert.rejects(f.service.list(query),{statusCode:422});
  f.failure('domains');await f.service.runOnce();assert.equal(f.policy.action(fields('u0@example.net')),'DUNNO');await f.service.settingsChanged();assert.equal(f.policy.action(fields('u0@example.net')),'DUNNO');
  f.failure(null);await f.service.runOnce();assert.match(f.policy.action(fields('u0@example.net')),/^450 /);
});
const headers={cookie:'mailadmin_sid=synthetic-session',origin:'https://admin.example.com','x-mailadmin-csrf':'synthetic-csrf'};
test('bounce APIs enforce actual admin guard, CSRF, read-key permissions and roundtrip mutations',async t=>{
  const f=await fixture(t);f.rows([row('1')]);await f.service.runOnce();const r=(await f.service.list()).items[0];
  const app=Fastify({logger:false});t.after(()=>app.close());installErrors(app);await app.register(cookie);
  installAdminGuard(app,{config:{adminHostname:'admin.example.com',mailcowApiKey:'synthetic',sessionMaxHours:8},sessions:{get:async token=>{if(token!=='synthetic-session')throw new AppError(403,'NO_SESSION','synthetic');return {state:'ready',username:'admin',csrf:'synthetic-csrf',mailcow:{}};},destroy:async()=>{}},client:{call:async()=>({version:'synthetic'}),createApiContext:()=>({})},apiKeys:{authenticate:async()=>({ok:true,item:{id:'synthetic',name:'synthetic',permission:'read'}}),recordUse:async()=>{}}});await app.register(bouncesRoutes,{service:f.service});
  const denied=await app.inject({url:'/api/admin/bounces'});assert.equal(denied.statusCode,403);assert.equal(denied.headers['www-authenticate'],undefined);
  const url='/api/admin/bounces/'+r.id+'/suppression';for(const badHeaders of [{'x-mailadmin-api-key':'mak_v1_'+'a'.repeat(43)},{cookie:headers.cookie,origin:headers.origin},{...headers,origin:'https://foreign.example.net'}])assert.equal((await app.inject({method:'PUT',url,headers:badHeaders,payload:{mode:'manual',etag:r.etag}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/admin/bounces',headers:{'x-mailadmin-api-key':'mak_v1_'+'a'.repeat(43)}})).statusCode,200);
  const saved=await app.inject({method:'PUT',url,headers,payload:{mode:'manual',etag:r.etag}});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().state,'manual');
  const resolutionUrl='/api/admin/bounces/'+r.id+'/resolution';
  for(const badHeaders of [{'x-mailadmin-api-key':'mak_v1_'+'a'.repeat(43)},{cookie:headers.cookie,origin:headers.origin},{...headers,origin:'https://foreign.example.net'},{'x-mailadmin-api-key':['mak_v1_'+'a'.repeat(43),'mak_v1_'+'b'.repeat(43)]}])assert.equal((await app.inject({method:'PUT',url:resolutionUrl,headers:badHeaders,payload:{resolved:true,etag:saved.json().etag}})).statusCode,403);
  const resolved=await app.inject({method:'PUT',url:resolutionUrl,headers,payload:{resolved:true,etag:saved.json().etag}});assert.equal(resolved.statusCode,200,resolved.body);assert.equal(resolved.json().resolvedAt,iso(T));assert.deepEqual(resolved.json().manual,saved.json().manual);assert.equal(resolved.headers['www-authenticate'],undefined);
  const conflict=await app.inject({method:'PUT',url:resolutionUrl,headers,payload:{resolved:false,etag:saved.json().etag}});assert.equal(conflict.statusCode,409);
  const invalid=await app.inject({method:'PUT',url:resolutionUrl,headers,payload:{resolved:'false',etag:resolved.json().etag}});assert.equal(invalid.statusCode,422);
  const unresolved=await app.inject({method:'PUT',url:resolutionUrl,headers,payload:{resolved:false,etag:resolved.json().etag}});assert.equal(unresolved.statusCode,200,unresolved.body);assert.equal(unresolved.json().resolvedAt,null);
  const saveBounce=f.store.saveBounces;f.store.saveBounces=async()=>{throw new AppError(503,'MONITOR_STORE_UNAVAILABLE','synthetic');};const unavailable=await app.inject({method:'PUT',url:resolutionUrl,headers,payload:{resolved:true,etag:unresolved.json().etag}});assert.equal(unavailable.statusCode,503);f.store.saveBounces=saveBounce;
  const released=await app.inject({method:'DELETE',url,headers,payload:{etag:saved.json().etag}});assert.equal(released.statusCode,200,released.body);const removed=await app.inject({method:'DELETE',url:'/api/admin/bounces/'+r.id,headers,payload:{etag:released.json().etag}});assert.equal(removed.statusCode,200);assert.equal((await f.service.list()).total,0);
  assert.equal((await app.inject({method:'PUT',url,headers:{...headers,'content-type':'text/plain'},payload:'bad'})).statusCode,415);
});
test('monitor settings publish automatic policy changes immediately after durable save',async t=>{
  const f=await fixture(t);f.rows([row('1')]);await f.service.runOnce();const monitor=createMonitorService({store:f.store,collector:{},config:{},mailcow:f.mailcow,audit:f.audit,lock:f.lock,onSettingsSaved:f.service.settingsChanged,policyStatus:f.policy.status,send:async()=>{}});
  const view=await monitor.view();await monitor.save({actor:'admin',ip:'192.0.2.20',data:{...view.settings,bounceAuto:{enabled:false,durationMinutes:60},etag:view.etag}});assert.equal(f.policy.action(fields('Missing@example.net')),'DUNNO');assert.equal((await monitor.status()).policy.available,true);
});
test('1001 archive rows, one snapshot restart, nanosecond dedup and catch-up restart are bounded',async t=>{
  const f=await fixture(t);const source=Array.from({length:1001},(_,i)=>row(String(i),'bulk@example.net'));
  let requests=0,restarted=false;
  f.archive.search=async query=>{
    requests++;
    if(query.cursor && !restarted){restarted=true;throw Object.assign(Error(),{statusCode:410});}
    return {lines:query.cursor?source.slice(1000):source.slice(0,1000),nextCursor:query.cursor?null:'page-2',partialReason:query.cursor?null:'response_bytes',incomplete:!query.cursor,scannedBytes:100,coverage:{source:'postfix',oldest:null,newest:null,gaps:[]}};
  };
  assert.equal((await f.service.runOnce()).complete,true);assert.equal(requests,4);assert.equal((await f.service.list()).items[0].bounceCount,1001);
  const precise={...row('nanos'),time:'2026-11-05T09:59:00.000000001Z'};assert.notEqual(bounceEvent(precise).key,bounceEvent({...precise,time:'2026-11-05T09:59:00.000000002Z'}).key);
  const service=createBouncesService({store:f.store,policy:f.policy,mailcow:f.mailcow,logArchive:f.archive,audit:f.audit,lock:f.lock,now:()=>T});await service.initialize();await service.runOnce();assert.equal((await service.list()).items[0].bounceCount,1001);
});
test('gaps, missing observation, cursor loops and collection caps preserve the last complete end',async t=>{
  const f=await fixture(t);await f.service.runOnce();const end=(await f.store.readBounces()).completedEnd;
  const normal=f.archive.search;f.archive.search=async q=>{const value=await normal(q);value.coverage.gaps=[{from:iso(T-300000),to:iso(T),reason:'synthetic gap'}];return value;};assert.equal((await f.service.runOnce()).reason,'ARCHIVE_GAP');
  f.archive.status=async()=>({sources:{postfix:{lastSuccessfulCollectionAt:null}}});assert.equal((await f.service.runOnce()).reason,'COLLECTION_UNCONFIRMED');
  f.archive.status=async()=>({sources:{postfix:{lastSuccessfulCollectionAt:iso(T)}}});f.archive.search=async q=>({...await normal(q),nextCursor:'same',partialReason:'limit'});assert.equal((await f.service.runOnce()).reason,'ARCHIVE_CURSOR_LOOP');
  const limited=createBouncesService({store:f.store,policy:f.policy,mailcow:f.mailcow,logArchive:f.archive,audit:f.audit,lock:f.lock,now:()=>T,limits:{pages:1}});assert.equal((await limited.runOnce()).reason,'COLLECTION_LIMIT');assert.equal((await f.store.readBounces()).completedEnd,end);
});
test('durable state capacity rejects the whole commit and old active manual entries are retained',async t=>{
  const f=await fixture(t);f.rows([row('old')]);await f.service.runOnce();let current=(await f.service.list()).items[0];current=await f.service.suppress(args(current,{mode:'manual'}));
  const state=await f.store.readBounces(), template=state.recipients[0];
  state.recipients=Array.from({length:10000},(_,i)=>({...template,id:'id-'+i,recipient:'old'+i+'@example.net'}));await f.store.saveBounces(state);await f.service.settingsChanged();
  f.rows([row('new','new@example.net')]);assert.equal((await f.service.runOnce()).complete,false);assert.equal((await f.store.readBounces()).recipients.length,10000);assert.equal((await f.store.readBounces()).completedEnd,state.completedEnd);
  f.time(T+31*86400000);f.archive.status=async()=>({sources:{postfix:{lastSuccessfulCollectionAt:iso(T+31*86400000)}}});f.rows([]);await f.service.runOnce();assert.equal((await f.store.readBounces()).recipients.length,10000);
});
test('actual admin app mounts bounce APIs and reports disabled listener without leaking raw diagnostics',async t=>{
  const {createAdminApp}=await import('../../server/admin/app.js');const dir=await fs.mkdtemp(join(tmpdir(),'bounces-app-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const client={login:async({username})=>({username,state:'ready'}),logout:async()=>{},call:async(_ctx,_method,path)=>path.includes('domain/all')?[]:{version:'synthetic'},createApiContext:()=>({})};
  const config={adminHostname:'admin.example.com',sessionIdleMin:60,sessionMaxHours:8,trustProxy:[],mailcowApiKey:'synthetic',apiKeyDir:join(dir,'keys'),auditDir:join(dir,'audit'),logoDir:'',relayFiles:[],logLevel:'info',domain:'example.com',ftsNightly:{enabled:false,start:'03:00',end:'06:00',stateDir:join(dir,'fts')}};
  const app=await createAdminApp({config,logger:false,staticDir:'/nonexistent-synthetic-admin',auth:{client}});t.after(()=>app.close());
  assert.equal((await app.inject({url:'/healthz'})).statusCode,200);
  const login=await app.inject({method:'POST',url:'/api/admin/auth/login',headers:{origin:'https://admin.example.com'},payload:{username:'admin',password:'synthetic-password'}});assert.equal(login.statusCode,200);
  const h={cookie:login.headers['set-cookie'].split(';')[0]};const response=await app.inject({url:'/api/admin/bounces',headers:h});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().total,0);assert.equal(response.json().policy.reason,'LISTENER_DISABLED');
  assert.equal((await app.inject({url:'/api/admin/monitor/status',headers:h})).json().policy.listenerEnabled,false);
});
test('past bounce does not restart its TTL during catch-up and observed corruption fails open',async t=>{
  const f=await fixture(t);f.failure('archive');await f.service.runOnce();f.failure(null);f.time(T+7200000);f.rows([row('past')]);assert.equal((await f.service.runOnce()).complete,true);const item=(await f.service.list()).items[0];assert.equal(item.autoUntil,null);assert.equal(f.policy.action(fields(item.recipient)),'DUNNO');
  await f.service.suppress(args(item,{mode:'manual'}));assert.match(f.policy.action(fields(item.recipient)),/^550 /);
  await fs.writeFile(join(f.dir,'bounces.json'),'broken');await assert.rejects(f.service.list(),{statusCode:503});assert.equal(f.policy.action(fields(item.recipient)),'DUNNO');
});

test('legacy v1 rows normalize without eager disk writes; next save persists the new fields',async t=>{
 const f=await fixture(t);f.rows([row('legacy')]);await f.service.runOnce();const state=await f.store.readBounces();delete state.recipients[0].sender;delete state.recipients[0].resolvedAt;
 const file=join(f.dir,'bounces.json'),original=JSON.stringify(state);await fs.writeFile(file,original);const normalized=await f.store.readBounces();assert.equal(normalized.recipients[0].sender,null);assert.equal(normalized.recipients[0].resolvedAt,null);assert.equal(await fs.readFile(file,'utf8'),original);
 await f.store.saveBounces(normalized);const saved=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(saved.v,1);assert.ok(Object.hasOwn(saved.recipients[0],'sender'));assert.ok(Object.hasOwn(saved.recipients[0],'resolvedAt'));assert.equal(saved.recipients[0].bounceCount,1);
 for(const patch of [{sender:123},{resolvedAt:false},{sender:'not-an-address'},{unexpected:true}]){const invalid=structuredClone(saved);Object.assign(invalid.recipients[0],patch);await fs.writeFile(file,JSON.stringify(invalid));await assert.rejects(f.store.readBounces(),{statusCode:503});}
});
const qmgr=(id,qid,body,at)=>({id,time:iso(at),program:'postfix/qmgr',message:`${qid}: ${body}`,truncated:false,unknownTime:false});
test('sender correlation is window-local, timestamp ordered and respects queue removal/reuse',async t=>{
 const f=await fixture(t);
 assert.equal(bounceSenderEvent({...row('spoof'),message:'Qspoof: status=bounced (remote says postfix/qmgr: Qspoof: from=<spoof@example.org>)'}),null);
 assert.equal(bounceSenderEvent({program:'postfix',message:'Nov  5 10:00:00 mx.example.org postfix/qmgr[123]: Qtest: from=<valid@example.org>, size=10',time:iso(T)}).sender,'valid@example.org');
 f.rows([
  row('1','first@example.net','5.1.1',T-240000),
  qmgr('from1','Q1','from=<User+tag@EXAMPLE.ORG>, size=10, nrcpt=2 (queue active)',T-250000),
  qmgr('remove1','Q1','removed',T-230000),
  {...row('2','unknown@example.net','5.1.1',T-220000),message:row('2','unknown@example.net').message.replace('Q2:','Q1:')},
  qmgr('from2','Q1','from=<second@example.org>, size=10, nrcpt=1 (queue active)',T-210000),
  {...row('3','second@example.net','5.1.1',T-200000),message:row('3','second@example.net').message.replace('Q3:','Q1:')},
  qmgr('null','Q4','from=<>, size=10, nrcpt=1 (queue active)',T-190000),row('4','null@example.net','5.1.1',T-180000),
  qmgr('masked','Q5','from=<****@mailcow.local>, size=10, nrcpt=1 (queue active)',T-170000),row('5','masked@example.net','5.1.1',T-160000),
  qmgr('outside','Q6','from=<outside@example.org>, size=10',T-600000),row('6','outside@example.net','5.1.1',T-60000),
 ]);
 assert.equal((await f.service.runOnce()).complete,true);const items=(await f.service.list()).items;
 assert.equal(items.find(r=>r.recipient==='first@example.net').sender,'User+tag@example.org');assert.equal(items.find(r=>r.recipient==='second@example.net').sender,'second@example.org');
 for(const name of ['unknown','null','masked','outside'])assert.equal(items.find(r=>r.recipient===name+'@example.net').sender,null);
 assert.equal((await f.service.list({q:'User+tag@EXAMPLE.ORG'})).total,1);
});
test('sender facts span pages but are discarded together with an expired snapshot',async t=>{
 const f=await fixture(t);let attempt=0,calls=0;
 f.archive.search=async query=>{
  calls++;if(query.cursor&&attempt===0){attempt++;throw Object.assign(Error(),{statusCode:410});}
  return {lines:query.cursor?[row('1')]:[qmgr('sender','Q1',`from=<${attempt?'right':'wrong'}@example.org>, size=10`,attempt?T-120000:T-70000)],nextCursor:query.cursor?null:'next',partialReason:query.cursor?null:'limit',incomplete:!query.cursor,scannedBytes:100,coverage:{source:'postfix',oldest:null,newest:null,gaps:[]}};
 };
 assert.equal((await f.service.runOnce()).complete,true);assert.equal(calls,4);assert.equal((await f.service.list()).items[0].sender,'right@example.org');assert.equal((await f.service.list()).items[0].bounceCount,1);
});
test('resolution is audited and durable without changing suppression; errors preserve durable state',async t=>{
 const f=await fixture(t);f.rows([row('1')]);await f.service.runOnce();let r=(await f.service.list()).items[0];r=await f.service.suppress(args(r,{mode:'manual'}));const before=structuredClone(r),records=[];
 f.audit.run=async(event,fn)=>{records.push(event);return fn();};r=await f.service.resolve(args(r,{resolved:true}));assert.equal(r.resolvedAt,iso(T));assert.notEqual(r.etag,before.etag);assert.deepEqual(r.manual,before.manual);assert.equal(r.autoUntil,before.autoUntil);assert.match(f.policy.action(fields(r.recipient)),/^550 /);assert.equal(records.at(-1).action,'bounce.resolution');assert.equal(records.at(-1).before.resolvedAt,null);
 await assert.rejects(f.service.resolve(args(before,{resolved:false})),{statusCode:409});
 for(const data of [{etag:r.etag,resolved:'true'},{etag:r.etag,resolved:true,extra:true},{resolved:true}])await assert.rejects(f.service.resolve({...args(r),data}),{statusCode:422});
 await assert.rejects(f.service.resolve({...args(r,{resolved:false}),id:'missing'}),{statusCode:404});
 const state=await f.store.readBounces();f.audit.run=async()=>{throw Error('synthetic audit unavailable');};await assert.rejects(f.service.resolve(args(r,{resolved:false})));assert.deepEqual(await f.store.readBounces(),state);
 f.audit.run=async(_event,fn)=>fn();const save=f.store.saveBounces;f.store.saveBounces=async()=>{throw new AppError(503,'MONITOR_STORE_UNAVAILABLE','synthetic');};await assert.rejects(f.service.resolve(args(r,{resolved:false})),{statusCode:503});f.store.saveBounces=save;assert.deepEqual(await f.store.readBounces(),state);
 r=await f.service.resolve(args(r,{resolved:false}));assert.equal(r.resolvedAt,null);assert.deepEqual(r.manual,before.manual);
});
test('duplicate, earlier and equal-time events preserve resolution; later events reset it',async t=>{
 const f=await fixture(t);f.rows([row('original')]);await f.service.runOnce();let r=(await f.service.list()).items[0];r=await f.service.resolve(args(r,{resolved:true}));await f.service.runOnce();assert.equal((await f.service.list()).items[0].resolvedAt,iso(T));
 f.time(T+300000);f.rows([row('original'),row('earlier','Missing@example.net','5.1.1',T-1000),row('same','Missing@example.net','5.1.1',T)]);await f.service.runOnce();r=(await f.service.list()).items[0];assert.equal(r.resolvedAt,iso(T));assert.equal(r.bounceCount,3);
 f.time(T+600000);f.rows([row('later','Missing@example.net','5.1.1',T+1000)]);await f.service.runOnce();r=(await f.service.list()).items[0];assert.equal(r.resolvedAt,null);assert.equal(r.bounceCount,4);
});
test('unknown-time chunk leaves resolution, counters and watermark untouched',async t=>{
 const f=await fixture(t);f.rows([row('original')]);await f.service.runOnce();let r=(await f.service.list()).items[0];r=await f.service.resolve(args(r,{resolved:true}));const before=await f.store.readBounces();
 f.archive.search=async()=>({lines:[{...row('unknown'),time:null,unknownTime:true}],nextCursor:null,partialReason:null,incomplete:true,scannedBytes:100,coverage:{source:'postfix',oldest:null,newest:null,gaps:[]}});
 assert.equal((await f.service.runOnce()).complete,false);const after=await f.store.readBounces();assert.deepEqual(after.recipients,before.recipients);assert.equal(after.completedEnd,before.completedEnd);
});
test('resolution made while collecting protects earlier independent events at commit',async t=>{
 const f=await fixture(t);f.rows([row('original')]);await f.service.runOnce();let r=(await f.service.list()).items[0];f.time(T+300000);f.rows([row('new','Missing@example.net','5.1.1',T+60000)]);const original=f.archive.search;f.archive.search=async q=>{r=await f.service.resolve(args(r,{resolved:true}));return original(q);};
 await f.service.runOnce();r=(await f.service.list()).items[0];assert.equal(r.resolvedAt,iso(T+300000));assert.equal(r.bounceCount,2);
});
test('effective auto/manual/resolved filters retain the previous enum and priority rules',async t=>{
 const f=await fixture(t);f.rows([row('1','auto@example.net'),row('2','manual@example.net'),row('3','clear@example.net','5.2.2'),row('4','inside@example.com')]);await f.service.runOnce();let r=(await f.service.list({q:'manual@'})).items[0];r=await f.service.suppress(args(r,{mode:'manual'}));await f.service.resolve(args(r,{resolved:true}));
 for(const [state,count] of [['all',4],['auto',1],['manual',1],['resolved',1],['suppressed',2],['unsuppressed',1],['internal',1]])assert.equal((await f.service.list({state})).total,count,state);
 const settings=await f.store.readSettings();settings.bounceAuto.enabled=false;await f.store.saveSettings(settings);await f.service.settingsChanged();assert.equal((await f.service.list({state:'auto'})).total,0);assert.equal((await f.service.list({state:'manual'})).total,1);assert.equal((await f.service.list({state:'resolved'})).total,1);
});
