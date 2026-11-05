import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';
import { validateMonitorSettings, monitorItems } from '../mail-monitor-state.js';
import { notificationAddress } from '../quota-notification-state.js';
const iso=n=>new Date(n).toISOString();
const key=(item,target)=>createHash('sha256').update(JSON.stringify([item,target])).digest('hex');
const invalid=()=>new AppError(422,'INVALID_INPUT','감시 설정과 조회 조건을 확인해 주세요.');
function delivery(incident,recipient){let d=incident.deliveries.find(r=>r.recipient===recipient);if(!d){d={recipient,anchorAt:null,alerted:false,recoveryDone:false};incident.deliveries.push(d);}return d;}
export function monitorTargets(snapshot,incidents=[]) {
  const result=[];
  for(const metric of snapshot.metrics){
    const targets=new Set(metric.windows.flatMap(w=>w.targets.map(t=>t.target)));
    for(const i of incidents)if(i.item===metric.item&&i.phase==='active')targets.add(i.target);
    for(const target of targets){const rules=metric.windows.map(w=>({windowMinutes:w.windowMinutes,threshold:w.threshold,value:w.targets.find(t=>t.target===target)?.value??0,complete:w.complete}));
      result.push({key:key(metric.item,target),item:metric.item,target,complete:rules.every(r=>r.complete),abnormal:rules.some(r=>r.complete&&r.value>=r.threshold),rules:rules.filter(r=>r.complete).map(({complete,...r})=>r)});
    }
  }
  return result;
}
export function createMonitorService({ store, collector, config, mailcow, audit, lock, history, send, now=Date.now, monotonicNow=()=>performance.now(), setTimeout:schedule=globalThis.setTimeout, clearTimeout:cancel=globalThis.clearTimeout }) {
  let running=false;const anchors=new Map(),attempts=new Map();
  history?.register('monitor.settings',{label:'메일 감시 설정을 바꿨어요'});history?.register('monitor.send',{label:'메일 감시 알림을 보냈어요'});
  async function change(fn){return lock.run('mail-monitor-state',async()=>{const s=await store.readState();const value=await fn(s);await store.saveState(s);return value;});}
  function trim(s){s.notifications=s.notifications.filter(n=>now()-Date.parse(n.at)<=30*86400000).slice(-1000);s.incidents=s.incidents.filter(i=>i.phase==='active'||s.outbox.some(e=>e.incidentId===i.id)||now()-Date.parse(i.closedAt??i.openedAt)<=30*86400000);}
  function record(s,e,result){const i=s.incidents.find(i=>i.id===e.incidentId);if(!i)return;s.notifications.push({id:randomUUID(),at:iso(now()),phase:e.phase,item:i.item,target:i.target,values:i.rules.map(r=>({windowMinutes:r.windowMinutes,value:r.value})),thresholds:i.rules.map(r=>({windowMinutes:r.windowMinutes,threshold:r.threshold})),recipientResults:[{recipient:e.recipient,result}]});}
  function settle(s,e,result,recovered=false){const i=s.incidents.find(i=>i.id===e.incidentId);if(!i)return;const d=delivery(i,e.recipient);if(e.phase==='recovery'){if(result!=='failed')d.recoveryDone=true;}else if(result!=='failed'){d.anchorAt=result==='sent'?iso(now()):e.pendingAt??iso(now());d.alerted ||= result==='sent';if(!recovered)anchors.set(i.id+'|'+e.recipient,result==='unknown'?(attempts.get(e.id)??monotonicNow()):monotonicNow());}attempts.delete(e.id);record(s,e,result);}
  function recover(s){for(const e of s.outbox.filter(e=>e.pendingAt)){settle(s,e,'unknown',true);}s.outbox=s.outbox.filter(e=>!e.pendingAt);for(const i of s.incidents)for(const d of i.deliveries)if(d.anchorAt&&Date.parse(d.anchorAt)>now()){d.anchorAt=iso(now());anchors.set(i.id+'|'+d.recipient,monotonicNow());}}
  async function view(){const settings=await store.readSettings(),warnings=[];if(!config.mailcowApiKey)warnings.push('자동 수집용 mailcow API 키가 설정되지 않았어요.');if(!config.logArchiveUrl||!config.logArchiveKey)warnings.push('보관 로그 연결 설정을 확인해 주세요.');if(!notificationAddress('postmaster@'+config.domain))warnings.push('알림 보내는 도메인을 확인해 주세요.');return {settings,etag:etag(settings),effectiveEnabled:settings.enabled&&settings.recipients.length>0,warnings};}
  async function save({session,actor,ip,data}){
    if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.etag!=='string')throw invalid();
    const {etag:expected,...input}=data,settings=validateMonitorSettings(input);
    await lock.run('mail-monitor-settings',async()=>{const before=await store.readSettings();assertUnchanged(expected,before);await audit.run({actor,ip,action:'monitor.settings',target:'메일 감시',kind:'config',revertible:false,before,after:settings},async()=>{await store.saveSettings(settings);return {};});});
    return view(session);
  }
  async function status(){const settings=await store.readSettings(),s=await store.readState();const metrics=settings.enabled&&s.snapshot?s.snapshot.metrics:monitorItems.map(item=>({item,windows:(Array.isArray(settings.rules[item])?settings.rules[item]:[settings.rules[item]]).map(r=>({windowMinutes:r.windowMinutes??0,threshold:r.threshold,value:null,target:null,targets:[],complete:false,status:settings.enabled?'unknown':'disabled',reason:settings.enabled?'NOT_CHECKED':'DISABLED'}))}));return {enabled:settings.enabled,lastAttemptAt:s.lastAttemptAt,lastCompleteAt:s.lastCompleteAt,asOf:s.asOf,metrics,sources:s.snapshot?.sources??{},policy:{available:false},pending:s.outbox.length};}
  async function notifications(query={}){
    if(!query||Object.keys(query).some(k=>!['before','limit'].includes(k))||query.limit!==undefined&&(!/^[1-9]\d*$/.test(String(query.limit))||Number(query.limit)>100))throw invalid();
    let id=null;if(query.before!==undefined){if(typeof query.before!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(query.before))throw invalid();try{id=Buffer.from(query.before,'base64url').toString('utf8');if(Buffer.from(id).toString('base64url')!==query.before)throw invalid();}catch{throw invalid();}}
    const rows=(await store.readState()).notifications.slice().reverse();const index=id===null?0:rows.findIndex(r=>r.id===id)+1;if(id!==null&&index===0)throw invalid();const limit=Number(query.limit??50),items=rows.slice(index,index+limit);return {items,nextBefore:index+limit<rows.length?Buffer.from(items.at(-1).id).toString('base64url'):null};
  }
  async function sendBatch(recipient,settings,signal,senderValid){
    const batch=await change(async s=>{
      const current=await store.readSettings();if(signal.aborted||etag(current)!==etag(settings)||!current.enabled||!current.recipients.includes(recipient))return [];
      const entries=s.outbox.filter(e=>{
        if(e.recipient!==recipient||e.pendingAt)return false;
        const i=s.incidents.find(i=>i.id===e.incidentId),windows=s.snapshot?.metrics.find(m=>m.item===i?.item)?.windows??[];
        return e.phase==='alert'?windows.some(w=>w.complete&&w.targets.some(t=>t.target===i.target&&t.value>=w.threshold)):windows.length>0&&windows.every(w=>w.complete&&(w.targets.find(t=>t.target===i.target)?.value??0)<w.threshold);
      }).slice(0,100);
      for(const e of entries){e.pendingAt=iso(now());attempts.set(e.id,monotonicNow());}return entries.map(e=>({...structuredClone(e),incident:structuredClone(s.incidents.find(i=>i.id===e.incidentId))}));
    });
    if(!batch.length)return {sent:0,failed:0};
    let attempted=false,success=false,error;
    try{await audit.run({actor:'자동 메일 감시',ip:'127.0.0.1',action:'monitor.send',target:recipient,kind:'info',revertible:false},async()=>{const latest=await store.readSettings();if(!senderValid||signal.aborted||etag(latest)!==etag(settings)||!latest.enabled||!latest.recipients.includes(recipient))throw Object.assign(new Error(),{explicit:true});attempted=true;await send(recipient,batch.map(e=>({phase:e.phase,item:e.incident.item,target:e.incident.target,rules:e.incident.rules})),{signal});success=true;return {detail:{sent:1,items:batch.length}};});}catch(e){error=e;}
    const result=success?'sent':!attempted||error?.explicit===true?'failed':'unknown';
    await change(s=>{for(const entry of batch){const e=s.outbox.find(e=>e.id===entry.id);if(!e)continue;settle(s,e,result);if(result==='failed')e.pendingAt=null;else s.outbox=s.outbox.filter(row=>row.id!==e.id);}trim(s);});
    return {sent:result==='sent'?1:0,failed:result==='sent'?0:1};
  }
  async function runOnce({signal:parent}={}){
    if(running||parent?.aborted)return {sent:0,failed:0};running=true;
    const controller=new AbortController(),abort=()=>controller.abort();parent?.addEventListener('abort',abort,{once:true});if(parent?.aborted)abort();
    const timer=schedule(abort,240000);timer.unref?.();let sendTimer;
    try{
      await change(s=>{recover(s);s.lastAttemptAt=iso(now());trim(s);});
      const settings=await store.readSettings();
      if(!settings.enabled){await change(s=>{for(const i of s.incidents)if(i.phase==='active'){i.phase='cancelled';i.closedAt=iso(now());}s.outbox=[];});return {sent:0,failed:0};}
      const snapshot=await collector.collect(settings,{signal:controller.signal});
      if(controller.signal.aborted)return {sent:0,failed:0};
      const accepted=await change(async s=>{
        if(etag(await store.readSettings())!==etag(settings))return false;
        const rulesTag=etag(settings.rules),relayChanged=s.relayEtag!==null&&snapshot.relayEtag!==null&&s.relayEtag!==snapshot.relayEtag;
        if(s.settingsEtag!==null&&s.settingsEtag!==rulesTag||relayChanged){for(const i of s.incidents)if((i.phase==='active'||s.outbox.some(e=>e.incidentId===i.id))&&(s.settingsEtag!==rulesTag||i.item==='total'||i.item.startsWith('relay'))){i.phase='cancelled';i.closedAt=iso(now());}}
        s.settingsEtag=rulesTag;if(snapshot.relayEtag!==null)s.relayEtag=snapshot.relayEtag;
        for(const metric of snapshot.metrics)for(const w of metric.windows)if(!w.complete){const previous=s.snapshot?.metrics.find(m=>m.item===metric.item)?.windows.find(p=>p.windowMinutes===w.windowMinutes);if(previous?.complete)w.previous={value:previous.value,target:previous.target,observedAt:previous.observedAt??s.asOf};else if(previous?.previous)w.previous=previous.previous;}
        s.asOf=snapshot.asOf;s.snapshot=snapshot;if(snapshot.metrics.every(m=>m.windows.every(w=>w.complete)))s.lastCompleteAt=iso(now());
        for(const target of monitorTargets(snapshot,s.incidents)){
          let i=s.incidents.find(i=>i.key===target.key&&i.phase==='active');
          if(target.abnormal){if(!i){i={id:randomUUID(),key:target.key,item:target.item,target:target.target,openedAt:iso(now()),closedAt:null,phase:'active',rules:target.rules,deliveries:[]};s.incidents.push(i);}i.rules=target.rules;}
          else if(i&&target.complete){i.phase='resolved';i.closedAt=iso(now());i.rules=target.rules;}
        }
        s.outbox=s.outbox.filter(e=>{const i=s.incidents.find(i=>i.id===e.incidentId);return settings.recipients.includes(e.recipient)&&i&&i.phase!=='cancelled'&&(e.phase==='alert'?i.phase==='active':settings.recoveryEnabled&&i.phase==='resolved');});
        for(const i of s.incidents)for(const recipient of settings.recipients){const d=delivery(i,recipient);let phase=null;
          if(i.phase==='active'){
            const windows=snapshot.metrics.find(m=>m.item===i.item)?.windows??[];
            // Unknown collection pauses reminders as well as recovery.
            if(!windows.some(w=>w.complete&&w.targets.some(t=>t.target===i.target&&t.value>=w.threshold)))continue;
            const elapsed=d.anchorAt?now()-Date.parse(d.anchorAt):Infinity,mono=anchors.has(i.id+'|'+recipient)?monotonicNow()-anchors.get(i.id+'|'+recipient):Infinity;
            if(elapsed>=settings.repeatMinutes*60000&&mono>=settings.repeatMinutes*60000)phase='alert';
          }else if(i.phase==='resolved'&&settings.recoveryEnabled&&d.alerted&&!d.recoveryDone)phase='recovery';
          if(phase&&!s.outbox.some(e=>e.incidentId===i.id&&e.recipient===recipient&&e.phase===phase))s.outbox.push({id:randomUUID(),incidentId:i.id,recipient,phase,at:iso(now()),pendingAt:null});
        }
        trim(s);return true;
      });
      if(!accepted||controller.signal.aborted)return {sent:0,failed:0};
      if(!(await store.readState()).outbox.length)return {sent:0,failed:0};
      // An invalid sender is recorded as an explicit unsent failure, not an ambiguous SMTP result.
      let senderValid=false;
      try{const context=mailcow.createApiContext({permission:'read'});const domains=await mailcow.call(context,'GET','/api/v1/get/domain/all',undefined,controller.signal);senderValid=Array.isArray(domains)&&domains.some(r=>String(r.domain_name??r.domain).toLowerCase()===config.domain.toLowerCase());}catch{}
      const recipients=[...settings.recipients];let next=0,sent=0,failed=0;
      sendTimer=schedule(abort,90000);sendTimer.unref?.();
      await Promise.all(Array.from({length:Math.min(4,recipients.length)},async()=>{while(next<recipients.length&&!controller.signal.aborted){const recipient=recipients[next++];const result=await sendBatch(recipient,settings,controller.signal,senderValid);sent+=result.sent;failed+=result.failed;}}));
      return {sent,failed};
    }finally{cancel(timer);if(sendTimer!==undefined)cancel(sendTimer);parent?.removeEventListener('abort',abort);running=false;}
  }
  return {view,save,status,notifications,runOnce};
}
