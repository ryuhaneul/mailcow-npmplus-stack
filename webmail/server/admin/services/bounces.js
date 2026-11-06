import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';
import { bounceAddress, bounceDomain } from '../bounce-policy.js';
import { monitorTimestamp } from '../mail-monitor-collector.js';
import { archiveCoverage } from './logs.js';
const iso = n => new Date(n).toISOString();
const minute = 60000, day = 86400000;
const invalid = () => new AppError(422, 'INVALID_INPUT', '반송 주소와 입력값을 확인해 주세요.');
const unavailable = () => new AppError(503, 'BOUNCE_UNAVAILABLE', '반송 수집과 정책 상태를 확인해 주세요.');
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (data, names) => object(data) && Object.keys(data).sort().join(',') === [...names].sort().join(',');
const fail = code => { throw Object.assign(new Error(), { code }); };
export function bounceEvent(row) {
  const match = /\b(postfix(?:\/(?:submission|smtps|sogo|bcc|quarantine))?\/(?:smtp|lmtp|local|virtual|error))(?:\[\d+\])?:\s*([A-Za-z0-9]+):\s+([\s\S]*)/.exec(`${row.program}: ${row.message}`);
  if (!match || !/\bstatus=bounced(?:\s|$)/.test(match[3])) return null;
  const dsn = /(?:^|,\s*)dsn=(5\.\d{1,3}\.\d{1,3})(?:,|\s|$)/.exec(match[3])?.[1];
  const raw = /(?:^|,\s*)to=<([^>]+)>/.exec(match[3])?.[1];
  if (!dsn || !raw) return null;
  const address = bounceAddress(raw), time = monitorTimestamp(row.time);
  if (!address || time === null || raw.includes('*')) return null;
  // Keep a short classification, never the remote server's arbitrary diagnostic/body text.
  const reason = dsn === '5.1.1' ? '받는 주소 없음' : dsn === '5.1.10' ? '메일을 받지 않는 도메인 (null MX)' : '영구 배달 실패 (' + dsn + ')';
  const key = createHash('sha256').update(JSON.stringify([time.toString(),match[1],match[2],address.recipient,dsn])).digest('hex');
  return { ...address, qid:match[2], dsn, reason, key, at: iso(Date.parse(row.time)), stamp: row.time };
}
// Compact qmgr facts only. Correlation never crosses this completed search window.
export function bounceSenderEvent(row) {
  const text=/^postfix\/qmgr(?:\[\d+\])?$/.test(row.program)?`${row.program}: ${row.message}`:row.program==='postfix'?row.message:'';
  const match=/^(?:(?:[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\S+)\s+\S+\s+)?postfix\/qmgr(?:\[\d+\])?:\s*([A-Za-z0-9]+):\s+([\s\S]*)/.exec(text);
  if(!match)return null;
  const stamp=monitorTimestamp(row.time);if(stamp===null)return null;
  if(/^removed\b/.test(match[2]))return {qid:match[1],stamp,kind:'removed',sender:null};
  if(!/^from=/.test(match[2]))return null;
  const raw=/^from=<([^>]*)>/.exec(match[2])?.[1],address=raw&&!raw.includes('*')?bounceAddress(raw):null;
  return {qid:match[1],stamp,kind:'from',sender:address?.recipient??null};
}
export function correlateBounceSenders(events,facts) {
  const byQueue=new Map();
  for(const fact of facts){if(!byQueue.has(fact.qid))byQueue.set(fact.qid,[]);byQueue.get(fact.qid).push(fact);}
  for(const list of byQueue.values())list.sort((a,b)=>a.stamp<b.stamp?-1:a.stamp>b.stamp?1:0);
  for(const event of events){
    const list=byQueue.get(event.qid)??[],stamp=monitorTimestamp(event.stamp);let low=0,high=list.length;
    while(low<high){const mid=(low+high)>>>1;if(list[mid].stamp<=stamp)low=mid+1;else high=mid;}
    const fact=list[low-1];event.sender=fact?.kind==='from'?fact.sender:null;
  }
  return events;
}
export function createBouncesService({ store, mailcow, logArchive, policy, audit, lock, history, now = Date.now, monotonicNow = () => performance.now(), limits = {}, policyStatus = () => policy.status() }) {
  const cap = { milliseconds:120000, pages:256, rows:200000, bytes:128*1024*1024, ...limits };
  let running = false, collectionError = null;
  for (const action of ['suppress','release','delete','resolution']) history?.register('bounce.' + action, { label:action==='resolution'?'반송 주소 정리 완료 표시를 바꿨어요':'반송 주소 억제를 바꿨어요' });
  async function readState() { try { return await store.readBounces(); } catch(e) { policy.invalidate('STORE_UNAVAILABLE'); throw e; } }
  async function readSettings() { try { return await store.readSettings(); } catch(e) { policy.invalidate('STORE_UNAVAILABLE'); throw e; } }
  const active = (r, settings) => r.manual && (r.manual.until === null || Date.parse(r.manual.until) > now()) ? 'manual' : settings.bounceAuto.enabled && r.autoUntil && Date.parse(r.autoUntil) > now() ? 'auto' : 'none';
  const projection = (r, settings) => ({ ...r, internalExcluded: policy.domainsReady() ? policy.internal(r.recipient) : r.internalExcluded, state:active(r, settings), etag:etag(r) });
  async function refreshDomains(signal) {
    try {
      const context = mailcow.createApiContext({ permission:'read' });
      const values = await Promise.all(['domain/all','alias-domain/all'].map(path => mailcow.call(context, 'GET', '/api/v1/get/' + path, undefined, signal)));
      const names = [];
      for (let i=0;i<values.length;i++) {
        const rows = values[i]; if (!Array.isArray(rows) && !(object(rows) && !Object.keys(rows).length)) throw unavailable();
        for (const row of Array.isArray(rows) ? rows : []) { const name = bounceDomain(i === 0 ? row.domain_name ?? row.domain : row.alias_domain); if (!name) throw unavailable(); names.push(name); }
      }
      policy.setDomains(names);
    } catch { policy.invalidate('DOMAINS_UNAVAILABLE'); throw unavailable(); }
  }
  async function publish() {
    try { const [state, settings] = await Promise.all([readState(),readSettings()]); policy.publish(state, settings); }
    catch { policy.invalidate('STORE_UNAVAILABLE'); throw unavailable(); }
  }
  async function initialize() { try { await refreshDomains(); await publish(); } catch {} }
  async function settingsChanged() { await lock.run('mail-bounces', publish).catch(() => {}); }
  async function readChunk(start, end, signal, started) {
    let pages=0, rows=0, bytes=0;
    for (let attempt=0;attempt<2;attempt++) {
      const events=[],senderFacts=[], ids=new Set(), cursors=new Set(); let cursor=null, coverage=null;
      try {
        do {
          if (signal.aborted) fail('COLLECTION_ABORTED');
          if (++pages>cap.pages || monotonicNow()-started>=cap.milliseconds) fail('COLLECTION_LIMIT');
          const result=await logArchive.search({source:'postfix',start:iso(start),end:iso(end),q:'',limit:'1000',...(cursor?{cursor}:{})},{signal});
          if (!object(result) || !Array.isArray(result.lines) || result.lines.length>1000 || !(result.nextCursor===null || typeof result.nextCursor==='string' && result.nextCursor.length>0 && result.nextCursor.length<=4096) || typeof result.incomplete!=='boolean' || ![null,'limit','response_bytes','scan_bytes','timeout'].includes(result.partialReason) || !Number.isSafeInteger(result.scannedBytes) || result.scannedBytes<0) fail('INVALID_ARCHIVE_RESPONSE');
          rows+=result.lines.length; bytes+=result.scannedBytes;
          if(rows>cap.rows || bytes>cap.bytes) fail('COLLECTION_LIMIT');
          const checked=archiveCoverage(result.coverage,'postfix');
          if (coverage && JSON.stringify(coverage)!==JSON.stringify(checked)) fail('ARCHIVE_CHANGED'); coverage=checked;
          if (coverage.gaps.some(g=>!g.from || !g.to)) fail('ARCHIVE_GAP');
          for (const row of result.lines) {
            if (!object(row) || typeof row.id!=='string' || !row.id || row.id.length>512 || ids.has(row.id) || typeof row.program!=='string' || typeof row.message!=='string' || Array.from(row.message).length>=4000 || ['[민감 정보가 포함된 로그]','[구조화 로그 내용 생략]'].includes(row.message) || row.truncated || row.unknownTime) fail('ARCHIVE_LOSS');
            ids.add(row.id); const stamp=monitorTimestamp(row.time);
            if(stamp===null || stamp<monitorTimestamp(iso(start)) || stamp>=monitorTimestamp(iso(end))) fail('ARCHIVE_TIME_RANGE');
            const senderFact=bounceSenderEvent(row);if(senderFact)senderFacts.push(senderFact);
            const event=bounceEvent(row); if(event) events.push(event);
            else if (/\bstatus=bounced\b/.test(row.message) && /\bdsn=5\./.test(row.message)) fail('ARCHIVE_PARSE_LOSS');
          }
          cursor=result.nextCursor;
          if(cursor){ if(cursors.has(cursor)) fail('ARCHIVE_CURSOR_LOOP'); cursors.add(cursor); }
          else if(result.partialReason!==null || result.complete===false) fail('ARCHIVE_INCOMPLETE');
        } while(cursor);
        if (signal.aborted || monotonicNow()-started>=cap.milliseconds) fail('COLLECTION_LIMIT');
        return {events:correlateBounceSenders(events,senderFacts),gaps:coverage.gaps.filter(g=>Date.parse(g.from)<end && Date.parse(g.to)>start)};
      } catch(e) { if ((e.status===410 || e.statusCode===410) && attempt===0) continue; throw e; }
    }
  }
  async function runOnce({ signal:parent } = {}) {
    if(running) return; running=true;
    const controller=new AbortController(), abort=()=>controller.abort(); parent?.addEventListener('abort',abort,{once:true}); if(parent?.aborted)abort();
    const runStarted=monotonicNow();
    const timer=setTimeout(abort,cap.milliseconds); timer.unref?.();
    try {
      await refreshDomains(controller.signal);
      if (!logArchive?.enabled) fail('ARCHIVE_DISABLED');
      const status = await logArchive.status({ signal:controller.signal });
      const success = monitorTimestamp(status?.sources?.postfix?.lastSuccessfulCollectionAt);
      if (success === null) fail('COLLECTION_UNCONFIRMED');
      const T=Math.min(now(),Number(success/1000000n));
      const initial=await lock.run('mail-bounces',async()=>{ const s=await readState(); if(s.startedAt===null){s.startedAt=iso(T-5*minute);await store.saveBounces(s);} return s; });
      const watermark=Date.parse(initial.completedEnd??initial.startedAt);
      if(watermark>T) fail('CLOCK_REVERSED');
      if(T-watermark>90*day) fail('ARCHIVE_RETENTION_LOSS');
      let start=Math.max(Date.parse(initial.startedAt),watermark-5*minute), end=Math.min(T,watermark+5*minute);
      let completedEnd=initial.completedEnd;
      do {
        const {events,gaps}=await readChunk(start,end,controller.signal,runStarted);
        if(controller.signal.aborted) fail('COLLECTION_ABORTED');
        await lock.run('mail-bounces',async()=>{
          const state=await readState(), settings=await readSettings();
          if(state.completedEnd!==completedEnd) fail('COLLECTION_CHANGED');
          const seen=new Set(state.seen.map(e=>e.key)), recipients=new Map(state.recipients.map(r=>[r.recipient,r]));
          let checked=0;
          for(const event of events){
            if(checked++%256===0 && (controller.signal.aborted || monotonicNow()-runStarted>=cap.milliseconds))fail('COLLECTION_LIMIT');
            if(seen.has(event.key))continue;
            seen.add(event.key);state.seen.push({key:event.key,at:event.at});
            let row=recipients.get(event.recipient);
            if(!row){row={id:randomUUID(),recipient:event.recipient,firstSeenAt:event.at,lastSeenAt:event.at,bounceCount:0,lastDsn:event.dsn,lastReason:event.reason,sourceEventKey:event.key,internalExcluded:policy.internal(event.recipient),supported:event.supported,manual:null,autoUntil:null,releasedAt:null,sender:null,resolvedAt:null};state.recipients.push(row);recipients.set(event.recipient,row);}
            row.bounceCount++;
            if(row.resolvedAt!==null && monitorTimestamp(event.stamp)>monitorTimestamp(row.resolvedAt))row.resolvedAt=null;
            if(Date.parse(event.at)<Date.parse(row.firstSeenAt))row.firstSeenAt=event.at;
            if(Date.parse(event.at)>=Date.parse(row.lastSeenAt))Object.assign(row,{lastSeenAt:event.at,lastDsn:event.dsn,lastReason:event.reason,sourceEventKey:event.key,sender:event.sender});
            const afterRelease=row.releasedAt===null || monitorTimestamp(event.stamp)>monitorTimestamp(row.releasedAt);
            if(settings.bounceAuto.enabled && event.supported && !policy.internal(event.recipient) && ['5.1.1','5.1.10'].includes(event.dsn) && afterRelease){
              const until=Date.parse(event.at)+settings.bounceAuto.durationMinutes*minute;
              if(until>now() && until>Date.parse(row.autoUntil??'1970-01-01'))row.autoUntil=iso(until);
            }
          }
          for(const row of state.recipients)row.internalExcluded=policy.internal(row.recipient);
          state.recipients=state.recipients.filter(r=>now()-Date.parse(r.lastSeenAt)<=30*day || r.manual && (r.manual.until===null || Date.parse(r.manual.until)>now()) || r.autoUntil && Date.parse(r.autoUntil)>now());
          state.seen=state.seen.filter(e=>now()-Date.parse(e.at)<=30*day);
          state.completedEnd=iso(end);state.revision++;state.collection={lastAttemptAt:iso(now()),reason:null,gaps:[...new Map([...(state.collection.gaps??[]),...gaps].map(g=>[JSON.stringify([g.from,g.to,g.reason]),g])).values()].sort((a,b)=>Date.parse(a.to)-Date.parse(b.to)||a.from.localeCompare(b.from)||a.reason.localeCompare(b.reason)).slice(-20)};
          if(controller.signal.aborted)fail('COLLECTION_ABORTED');
          if(monotonicNow()-runStarted>=cap.milliseconds)fail('COLLECTION_LIMIT');
          await store.saveBounces(state);policy.publish(state,settings);collectionError=null;
        });
        completedEnd=iso(end);
        start=end;end=Math.min(T,start+5*minute);
      } while(start<T);
      return {complete:true,end:completedEnd};
    } catch(e) {
      collectionError=typeof e.code==='string'&&/^[A-Z_]+$/.test(e.code)?e.code:'COLLECTION_UNAVAILABLE';
      // A failed chunk must not advance its durable watermark or publish partial policy.
      if(!policy.domainsReady() || collectionError==='MONITOR_STORE_UNAVAILABLE')policy.invalidate(collectionError);
      try{await lock.run('mail-bounces',async()=>{const s=await readState();s.collection={...s.collection,lastAttemptAt:iso(now()),reason:collectionError};await store.saveBounces(s);});}catch{policy.invalidate('STORE_UNAVAILABLE');}
      return {complete:false,reason:collectionError};
    } finally {clearTimeout(timer);parent?.removeEventListener('abort',abort);running=false;}
  }
  async function list(query={}) {
    if(!object(query) || Object.keys(query).some(k=>!['q','state','before','limit'].includes(k)) || query.q!==undefined && (typeof query.q!=='string' || Array.from(query.q).length>200 || /[\x00-\x1f\x7f]/.test(query.q)) || !['all','suppressed','unsuppressed','internal','auto','manual','resolved'].includes(query.state??'all') || query.limit!==undefined && (!/^[1-9]\d*$/.test(String(query.limit)) || Number(query.limit)>100))throw invalid();
    const state=await readState(),settings=await readSettings();
    const rows=state.recipients.map(r=>projection(r,settings)).filter(r=>(!query.q || (r.recipient+' '+r.lastDsn+' '+r.lastReason+' '+(r.sender??'')).toLowerCase().includes(query.q.toLowerCase())) && (query.state===undefined || query.state==='all' || query.state==='resolved'&&r.resolvedAt!==null || ['auto','manual'].includes(query.state)&&!r.internalExcluded&&r.state===query.state || query.state==='internal'&&r.internalExcluded || query.state==='suppressed'&&!r.internalExcluded&&r.state!=='none' || query.state==='unsuppressed'&&!r.internalExcluded&&r.state==='none')).sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt)||a.id.localeCompare(b.id));
    let index=0;
    if(query.before!==undefined){if(typeof query.before!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(query.before))throw invalid();const id=Buffer.from(query.before,'base64url').toString();if(Buffer.from(id).toString('base64url')!==query.before)throw invalid();index=rows.findIndex(r=>r.id===id)+1;if(!index)throw invalid();}
    const limit=Number(query.limit??50),items=rows.slice(index,index+limit);
    return {items,total:rows.length,nextBefore:index+limit<rows.length?Buffer.from(items.at(-1).id).toString('base64url'):null,collection:{...state.collection,gapCount:(state.collection.gaps??[]).length,lastGapAt:state.collection.gaps?.at(-1)?.to??null,completedEnd:state.completedEnd,reason:collectionError??state.collection.reason},policy:policyStatus()};
  }
  async function mutate({id,data,actor,ip},kind) {
    const names=kind==='resolution'?['resolved','etag']:kind==='suppress'?(data?.mode==='duration'?['mode','minutes','etag']:['mode','etag']):['etag'];
    if(!exact(data,names)||typeof data.etag!=='string'||typeof id!=='string'||id.length>128 || kind==='resolution'&&typeof data.resolved!=='boolean' || kind==='suppress'&&(!['duration','manual'].includes(data.mode)||data.mode==='duration'&&(!Number.isSafeInteger(data.minutes)||data.minutes<1||data.minutes>525600)))throw invalid();
    return lock.run('mail-bounces',async()=>{
      const state=await readState(),settings=await readSettings(),row=state.recipients.find(r=>r.id===id);
      if(!row)throw new AppError(404,'NOT_FOUND','반송 주소를 찾을 수 없어요.');assertUnchanged(data.etag,row);
      if(kind==='suppress' && (!policy.domainsReady()))throw unavailable();
      if(kind==='suppress' && (policy.internal(row.recipient)||!row.supported))throw invalid();
      if(kind==='delete' && active(row,settings)!=='none')throw new AppError(409,'BOUNCE_SUPPRESSED','먼저 억제를 해제해 주세요.');
      const before=structuredClone(row);
      if(kind==='suppress')row.manual={until:data.mode==='manual'?null:iso(now()+data.minutes*minute),actor:String(actor??'admin'),at:iso(now())};
      else if(kind==='resolution')row.resolvedAt=data.resolved?iso(now()):null;
      else if(kind==='release'){row.manual=null;row.autoUntil=null;row.releasedAt=iso(now());}
      else state.recipients=state.recipients.filter(r=>r.id!==id);
      state.revision++;
      const result=await audit.run({actor,ip,action:'bounce.'+kind,target:row.recipient,kind:'config',revertible:false,before,after:kind==='delete'?null:row},async()=>{
        await store.saveBounces(state);policy.publish(state,settings);return kind==='delete'?{id,deleted:true}:projection(row,settings);
      });
      return result;
    });
  }
  return {initialize,settingsChanged,refreshDomains,runOnce,list,suppress:args=>mutate(args,'suppress'),release:args=>mutate(args,'release'),remove:args=>mutate(args,'delete'),resolve:args=>mutate(args,'resolution')};
}
