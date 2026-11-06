import {test} from 'node:test';import assert from 'node:assert/strict';
import {createMonitorCollector,monitorEvent,monitorTimestamp} from '../../server/admin/mail-monitor-collector.js';import {defaultMonitorSettings} from '../../server/admin/mail-monitor-state.js';
const base=Date.parse('2026-11-05T00:00:00Z'),iso=n=>new Date(n).toISOString();
function fixture(options={}){let time=base,success,lines=[],gap=[],failure=null,queries=[],queue=[];const archive={enabled:true,status:async()=>({sources:{postfix:{lastSuccessfulCollectionAt:success===undefined?iso(time):success}}}),search:async q=>{queries.push(q);if(failure)throw failure;const selected=lines.filter(r=>r.time===null||monitorTimestamp(r.time)>=monitorTimestamp(q.start)&&monitorTimestamp(r.time)<monitorTimestamp(q.end));const offset=Number(q.cursor??0),page=selected.slice(offset,offset+1000);return {lines:page,nextCursor:offset+1000<selected.length?String(offset+1000):null,partialReason:offset+1000<selected.length?'limit':null,incomplete:true,complete:offset+1000>=selected.length,scannedBytes:100,coverage:{source:'postfix',oldest:null,newest:null,gaps:gap}};}};const relay=options.relay??{ips:['192.0.2.0/24'],consistent:true,etag:'relay-v1'};const collector=createMonitorCollector({config:{},mailcow:{createApiContext:()=>({}),call:async()=>queue},logArchive:archive,relayReader:async()=>{if(relay instanceof Error)throw relay;return relay;},now:()=>time,...options});return {collector,archive,queries,advance:n=>time+=n,setSuccess:v=>success=v,setLines:v=>lines=v,setGap:v=>gap=v,setFailure:v=>failure=v,setQueue:v=>queue=v,now:()=>time};}
function row(id,time,body,program='postfix/smtpd[42]'){return {id:String(id),time,program,message:body,priority:''};}function submit(id,time,account='user@example.com',ip='192.0.2.24',qid='Q'+id){return row(id,time,`${qid}: client=client.example[${ip}]${account?', sasl_username='+account:''}`);}
const window=(result,item,minutes=5)=>result.metrics.find(m=>m.item===item).windows.find(w=>w.windowMinutes===minutes);
test('monitor counts submissions once, BCC/retries zero extra, relay union and per-host rejects',async()=>{const f=fixture();await f.collector.collect(defaultMonitorSettings());f.advance(65*60000);const at=iso(f.now()-60000);f.setLines([submit(1,at),submit(2,at,'user@example.com','192.0.2.24','Q1'),submit(3,at,null),submit(4,at,null,'203.0.113.9'),row(5,at,'Q1: to=<other@example.com>, status=sent','postfix/smtp[4]'),row(6,at,'NOQUEUE: reject: RCPT from client.example[192.0.2.24]: 550 rejected'),row(7,at,'NOQUEUE: reject: RCPT from client.example[192.0.2.24]: 550 rejected'),row(8,at,'Q1: milter-reject: END-OF-MESSAGE from client.example[192.0.2.24]: 550 rejected'),row(9,at,'Q1: milter-reject: END-OF-MESSAGE from client.example[192.0.2.24]: 550 rejected')]);const r=await f.collector.collect(defaultMonitorSettings());assert.equal(window(r,'total').value,2);assert.equal(window(r,'account').value,1);assert.equal(window(r,'relayReceived').value,2);assert.equal(window(r,'relayRejected').value,3);assert.equal(window(r,'total',60).complete,true);});
test('monitor reads all 1001 rows over cursor pages and snapshot retry does not double counts',async()=>{const f=fixture();await f.collector.collect(defaultMonitorSettings());f.advance(65*60000);f.setLines(Array.from({length:1001},(_,i)=>submit(i,iso(f.now()-1000))));const original=f.archive.search;let expired=false;f.archive.search=async q=>{if(q.cursor&&!expired){expired=true;throw {statusCode:410};}return original(q);};const r=await f.collector.collect(defaultMonitorSettings());assert.equal(window(r,'total').value,1001);assert.equal(f.queries.filter(q=>!q.cursor&&q.start===iso(f.now()-300000)).length,2);assert.ok(f.queries.every(q=>Date.parse(q.end)-Date.parse(q.start)===300000));});
test('monitor half-open nanosecond window includes start and excludes end',async()=>{const f=fixture();await f.collector.collect(defaultMonitorSettings());f.advance(65*60000);const T=f.now();f.setLines([submit(1,iso(T-300000)),submit(2,iso(T-300000-1).replace('.999Z','.999999999Z')),submit(3,iso(T)),submit(4,iso(T-1).replace('.999Z','.999999999Z'))]);const r=await f.collector.collect(defaultMonitorSettings());assert.equal(window(r,'total').value,2);assert.equal(window(r,'total',60).value,3);assert.equal(monitorTimestamp('bad'),null);assert.equal(monitorTimestamp('2026-02-30T00:00:00Z'),null);assert.equal(monitorTimestamp('2026-11-05T00:00:00.000000001Z')-monitorTimestamp('2026-11-05T00:00:00Z'),1n);});
test('monitor null and backwards success restart warm-up, increasing observations do not',async()=>{const f=fixture();await f.collector.collect(defaultMonitorSettings());f.advance(65*60000);assert.equal(window(await f.collector.collect(defaultMonitorSettings()),'total',60).complete,true);f.setSuccess(null);assert.equal(window(await f.collector.collect(defaultMonitorSettings()),'total').complete,false);f.advance(5*60000);f.setSuccess(undefined);let r=await f.collector.collect(defaultMonitorSettings());assert.equal(window(r,'total').complete,true);assert.equal(window(r,'total',60).reason,'WARMING_UP');f.advance(5*60000);f.setSuccess(iso(base));r=await f.collector.collect(defaultMonitorSettings());assert.equal(window(r,'total').complete,false);f.advance(5*60000);f.setSuccess(undefined);assert.equal(window(await f.collector.collect(defaultMonitorSettings()),'total').complete,true);f.advance(55*60000);assert.equal(window(await f.collector.collect(defaultMonitorSettings()),'total',60).complete,true);});
test('monitor gaps affect related windows, masked identities pause account only, no quiet newest requirement',async()=>{const f=fixture();await f.collector.collect(defaultMonitorSettings());f.advance(65*60000);f.setGap([{from:iso(f.now()-50*60000),to:iso(f.now()-40*60000),reason:'source gap'}]);let r=await f.collector.collect(defaultMonitorSettings());assert.equal(window(r,'total').value,0);assert.equal(window(r,'total',60).reason,'ARCHIVE_GAP');const g=fixture();await g.collector.collect(defaultMonitorSettings());g.advance(65*60000);g.setLines([submit(1,iso(g.now()-30*60000),'****@mailcow.local')]);r=await g.collector.collect(defaultMonitorSettings());assert.equal(window(r,'account').complete,true);assert.equal(window(r,'account',60).reason,'ACCOUNT_UNKNOWN');assert.equal(window(r,'total',60).value,1);});
test('monitor archive failures and row limits remain unknown while queue deduplicates complete data',async()=>{for(const failure of [{statusCode:429},new Error('synthetic secret')]){const f=fixture();await f.collector.collect(defaultMonitorSettings());f.advance(65*60000);f.setFailure(failure);f.setQueue([1,1,2].map(id=>({queue_id:String(id),queue_name:'active',arrival_time:f.now()/1000,message_size:1,recipients:['person@example.com']})));const r=await f.collector.collect(defaultMonitorSettings());assert.equal(window(r,'total').complete,false);assert.equal(window(r,'queue',0).value,2);assert.ok(!JSON.stringify(r).includes('synthetic secret'));}const f=fixture({limits:{rows:1}});await f.collector.collect(defaultMonitorSettings());f.advance(65*60000);f.setLines([submit(1,iso(f.now()-1000)),submit(2,iso(f.now()-1000))]);assert.equal(window(await f.collector.collect(defaultMonitorSettings()),'total').reason,'COLLECTION_LIMIT');});
test('monitor relay disabled isolates relay cards and malformed/duplicate archive rows never become zero',async()=>{const f=fixture({relay:Object.assign(new Error(),{code:'RELAY_DISABLED'})});await f.collector.collect(defaultMonitorSettings());f.advance(65*60000);f.setLines([submit(1,iso(f.now()-1000))]);let r=await f.collector.collect(defaultMonitorSettings());assert.equal(window(r,'account').value,1);assert.equal(window(r,'total').value,1);assert.equal(window(r,'relayReceived').reason,'RELAY_DISABLED');f.advance(300000);f.setLines([row(1,null,'broken')]);assert.equal(window(await f.collector.collect(defaultMonitorSettings()),'total').complete,false);assert.equal(monitorEvent(row(1,iso(f.now()),'Qx: client=unknown[bad]')).kind,'unparseable');f.advance(300000);f.setLines([row(2,iso(f.now()-1000),'[민감 정보가 포함된 로그]')]);assert.equal(window(await f.collector.collect(defaultMonitorSettings()),'total').reason,'ARCHIVE_LOSS');});

// Reference: the previous collector scans one hour, deduplicates queue lifecycles,
// then attributes each accepted fact to its 5/15/60-minute windows.
function hourReference(lines,T,minutes,item){
 const submissions=new Set(),rejections=new Set(),counts=new Map();
 const add=key=>counts.set(key,(counts.get(key)??0)+1);
 for(const r of lines.filter(r=>Date.parse(r.time)>=T-3600000&&Date.parse(r.time)<T)){
  const e=monitorEvent(r);if(!e)continue;
  if(e.kind==='removed'){for(const set of [submissions,rejections])for(const k of set)if(k.startsWith(e.qid+'|'))set.delete(k);continue;}
  if(e.kind==='submission'){const k=[e.qid,e.pid,e.client,e.account].join('|');if(submissions.has(k))continue;submissions.add(k);}
  if(e.kind==='rejection'&&e.qid){const k=[e.qid,e.pid,e.stage].join('|');if(rejections.has(k))continue;rejections.add(k);}
  if(Date.parse(r.time)<T-minutes*60000)continue;
  const relay=e.client?.startsWith('192.0.2.');
  if(e.kind==='submission'){
   if(item==='account'&&e.authenticated&&e.account)add(e.account);
   if(item==='total'&&(e.authenticated||relay))add('all');
   if(item==='relayReceived'&&relay)add(e.client);
  }else if(item==='relayRejected'&&relay)add(e.client);
 }
 if(item==='total'&&!counts.size)counts.set('all',0);
 return [...counts].map(([target,value])=>({target,value})).sort((a,b)=>b.value-a.value||a.target.localeCompare(b.target));
}
function durable(f){let collection=null;const checkpoints=[];return {get collection(){return collection;},checkpoints,collect:(collector=f.collector)=>collector.collect(defaultMonitorSettings(),{collection,saveCollection:async c=>{collection=structuredClone(c);checkpoints.push(structuredClone(c));}})};}
test('twelve five-minute increments equal one old hourly scan including boundary QID duplicates, removed, BCC and rejects',async()=>{
 const f=fixture(),d=durable(f),lines=[];
 for(let i=0;i<12;i++){
  const at=iso(base+i*300000+1000);
  lines.push(submit('a'+i,at,'sender'+(i%3)+'@example.com'),submit('r'+i,at,null),submit('o'+i,at,null,'203.0.113.9'),row('n'+i,at,'NOQUEUE: reject: RCPT from client.example[192.0.2.24]: 550 rejected'));
 }
 lines.push(submit('first',iso(base+299999),'user@example.com','192.0.2.24','CROSS'),submit('duplicate',iso(base+300000),'user@example.com','192.0.2.24','CROSS'),row('rm',iso(base+600000),'CROSS: removed','postfix/qmgr[9]'),submit('reuse',iso(base+600001),'user@example.com','192.0.2.24','CROSS'));
 lines.push(row('reject1',iso(base+899999),'REJ: milter-reject: END-OF-MESSAGE from client.example[192.0.2.24]: 550 rejected'),row('reject2',iso(base+900000),'REJ: milter-reject: END-OF-MESSAGE from client.example[192.0.2.24]: 550 rejected'),row('reject-rm',iso(base+1200000),'REJ: removed','postfix/qmgr[9]'),row('reject3',iso(base+1200001),'REJ: milter-reject: END-OF-MESSAGE from client.example[192.0.2.24]: 550 rejected'),row('bcc',iso(base+1800000),'CROSS: to=<bcc@example.com>, status=sent','postfix/smtp[4]'));
 lines.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));f.setLines(lines);await d.collect();let r;
 for(let i=0;i<12;i++){f.advance(300000);r=await d.collect();}
 for(const item of ['account','total','relayReceived','relayRejected'])for(const w of r.metrics.find(m=>m.item===item).windows){assert.equal(w.complete,true);assert.deepEqual(w.targets,hourReference(lines,f.now(),w.windowMinutes,item));}
 assert.equal(f.queries.length,12);assert.ok(f.queries.every(q=>Date.parse(q.end)-Date.parse(q.start)===300000));assert.equal(d.collection.bins.length,12);
 // Fifteen minutes uses the last three buckets too, without another archive read.
 const settings=defaultMonitorSettings();settings.rules.relayReceived.windowMinutes=15;
 const fifteen=await f.collector.collect(settings,{collection:d.collection});assert.deepEqual(window(fifteen,'relayReceived',15).targets,hourReference(lines,f.now(),15,'relayReceived'));assert.equal(f.queries.length,12);
 assert.ok(!JSON.stringify(d.collection).includes('client.example'));
});
test('new/legacy collection begins warm-up without backfill and does not reread a completed bucket',async()=>{
 const f=fixture();f.advance(65*60000);let r=await f.collector.collect(defaultMonitorSettings());assert.equal(window(r,'total').reason,'WARMING_UP');assert.equal(f.queries.length,0);
 f.advance(300000);r=await f.collector.collect(defaultMonitorSettings());assert.equal(window(r,'total').value,0);assert.equal(window(r,'total',60).reason,'WARMING_UP');assert.equal(f.queries.length,1);
 await f.collector.collect(defaultMonitorSettings());assert.equal(f.queries.length,1);
});
test('catch-up saves oldest buckets individually and restart resumes after the last complete bucket',async()=>{
 const f=fixture(),d=durable(f);await d.collect();f.advance(20*60000);f.setLines([submit(1,iso(base+1000)),submit(2,iso(base+601000))]);
 const search=f.archive.search;let failed=false;
 f.archive.search=async q=>{if(q.start===iso(base+600000)&&!failed){failed=true;throw {code:'SYNTHETIC_FAILURE'};}return search(q);};
 let r=await d.collect();assert.equal(window(r,'total').reason,'SYNTHETIC_FAILURE');assert.equal(d.collection.watermark,iso(base+600000));assert.equal(d.collection.bins.length,2);assert.equal(d.checkpoints.filter(c=>c.bins.length===1).length,1);
 const resumed=createMonitorCollector({config:{},mailcow:{createApiContext:()=>({}),call:async()=>[]},logArchive:f.archive,relayReader:async()=>({ips:['192.0.2.0/24'],consistent:true,etag:'relay-v1'}),now:f.now});
 r=await d.collect(resumed);assert.equal(d.collection.watermark,iso(f.now()));assert.equal(d.collection.bins.length,4);assert.equal(window(r,'total').value,0);assert.deepEqual(f.queries.map(q=>q.start),[0,1,2,3].map(i=>iso(base+i*300000)));
});
test('more than an hour behind skips expired buckets and keeps only twelve recent numeric buckets',async()=>{
 const f=fixture(),d=durable(f);await d.collect();f.advance(125*60000);await d.collect();assert.equal(f.queries.length,12);assert.equal(f.queries[0].start,iso(f.now()-3600000));assert.equal(d.collection.bins.length,12);assert.equal(d.collection.watermark,iso(f.now()));
 f.advance(300000);await d.collect();assert.equal(f.queries.length,13);assert.equal(d.collection.bins.length,12);assert.ok(d.collection.bins.every(b=>Date.parse(b.end)>f.now()-3600000));
});
test('stalled success checkpoints confirmed buckets but never judges stale values, regression restarts warm-up',async()=>{
 const f=fixture(),d=durable(f);await d.collect();f.advance(15*60000);f.setSuccess(iso(base+600000));let r=await d.collect();assert.equal(d.collection.watermark,iso(base+600000));assert.equal(window(r,'total').reason,'COLLECTION_UNCONFIRMED');assert.equal(f.queries.length,2);
 f.advance(300000);r=await d.collect();assert.equal(f.queries.length,2);assert.equal(window(r,'total').complete,false);
 f.setSuccess(iso(base+300000));r=await d.collect();assert.equal(window(r,'total').reason,'COLLECTION_UNCONFIRMED');assert.equal(d.collection.bins.length,2);
 f.setSuccess(undefined);r=await d.collect();assert.equal(window(r,'total').reason,'WARMING_UP');f.advance(300000);r=await d.collect();assert.equal(window(r,'total').complete,true);assert.equal(window(r,'total',60).reason,'WARMING_UP');
});
test('collection limits leave already checkpointed buckets intact and resume the uncompleted bucket',async()=>{
 let ticks=0;const f=fixture({limits:{milliseconds:100},monotonicNow:()=>++ticks*45}),d=durable(f);await d.collect();f.advance(15*60000);let r=await d.collect();assert.equal(window(r,'total').reason,'COLLECTION_LIMIT');assert.ok(d.collection.bins.length>0&&d.collection.bins.length<3);const end=d.collection.watermark;
 ticks=0;r=await d.collect();assert.ok(Date.parse(d.collection.watermark)>Date.parse(end));assert.equal(window(r,'total').complete,true);
});
test('state byte and QID-key limits fail closed without saving partial counts',async()=>{
 for(const limits of [{seen:1},{stateBytes:400}]){
  const f=fixture({limits}),d=durable(f);await d.collect();f.advance(300000);f.setLines([submit(1,iso(base+1000)),submit(2,iso(base+2000))]);const r=await d.collect();assert.equal(window(r,'total').reason,'COLLECTION_STATE_LIMIT');assert.equal(d.collection.watermark,iso(base));assert.equal(d.collection.bins.length,0);
 }
});
test('numeric bucket gaps and masked accounts remain unknown only for affected windows',async()=>{
 const f=fixture(),d=durable(f);await d.collect();f.advance(300000);f.setGap([{from:iso(base),to:iso(base+300000),reason:'synthetic gap'}]);await d.collect();assert.equal(d.collection.bins[0].complete,false);f.setGap([]);f.advance(55*60000);let r=await d.collect();assert.equal(window(r,'total').complete,true);assert.equal(window(r,'total',60).reason,'ARCHIVE_GAP');
 f.advance(300000);r=await d.collect();assert.equal(window(r,'total',60).complete,true);
});
test('recently repeated QID stays suppressed after its first occurrence expires (accepted hourly-scan limitation)',async()=>{
 const f=fixture(),d=durable(f);await d.collect();const lines=[submit(1,iso(base+1000),'user@example.com','192.0.2.24','LONG'),submit(2,iso(base+55*60000+1000),'user@example.com','192.0.2.24','LONG'),submit(3,iso(base+60*60000+1000),'user@example.com','192.0.2.24','LONG')];f.setLines(lines);f.advance(60*60000);await d.collect();f.advance(300000);const r=await d.collect();assert.equal(window(r,'total',60).value,0);assert.equal(hourReference(lines,f.now(),60,'total')[0].value,1);
 f.advance(65*60000);f.setLines([submit(4,iso(f.now()-1000),'user@example.com','192.0.2.24','LONG')]);const fresh=await d.collect();assert.equal(window(fresh,'total').value,1);assert.equal(d.collection.seen.length,1);
});
