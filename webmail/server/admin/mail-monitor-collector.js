import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { queueItems } from './services/status.js';
import { archiveCoverage } from './services/logs.js';
import { readRelayFiles, relayNetwork } from './relay-files.js';
import { notificationAddress } from './quota-notification-state.js';

const minute = 60000;
const iso = n => new Date(n).toISOString();
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export function monitorTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,19)!==value.slice(0,19)) return null;
  const fraction = /\.(\d+)Z$/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value))*1000000n+BigInt(fraction.padEnd(9,'0').slice(3));
}
function programOf(row) {
  const text = `${row.program}: ${row.message}`;
  const match = /\b(postfix(?:\/(?:submission(?:-haproxy)?|smtps(?:-haproxy)?|sogo|bcc|quarantine))?\/smtpd)(?:\[(\d+)\])?:\s*([\s\S]*)/i.exec(text);
  return match ? { program:match[1], pid:match[2]??'', body:match[3] } : null;
}
export function monitorEvent(row) {
  const removed=/postfix\/qmgr(?:\[\d+\])?:\s*([A-Za-z0-9]+):\s+removed\b/.exec(`${row.program}: ${row.message}`);
  if(removed)return {kind:'removed',qid:removed[1]};
  const p=programOf(row); if(!p)return null;
  const ip=/\bclient=[^\s,]*\[([^\]]+)\]/.exec(p.body)?.[1] ?? /\bfrom [^\s]*\[([^\]]+)\]/.exec(p.body)?.[1];
  const client=isIP(ip??'')?relayNetwork(ip).ip:null;
  const qid=/^([A-Za-z0-9]+):\s*/.exec(p.body)?.[1];
  if(qid&&qid!=='NOQUEUE'&&/\bclient=/.test(p.body)) {
    if(!client)return {kind:'unparseable'};
    const raw=/\bsasl_username=([^\s,;]+)/.exec(p.body)?.[1]??null;
    return {kind:'submission',qid,client,account:raw&&notificationAddress(raw)&&!raw.includes('*')?raw.toLowerCase():null,authenticated:raw!==null,pid:p.pid,program:p.program};
  }
  if(/\bmilter-reject:/.test(p.body) || /^NOQUEUE:\s+reject:/.test(p.body)) return {kind:'rejection',qid:qid==='NOQUEUE'?null:qid,client,pid:p.pid,stage:/reject:\s*(\S+)/.exec(p.body)?.[1]??'',program:p.program};
  if(/\b(?:client=|milter-reject:)|^NOQUEUE:\s+reject:/.test(p.body))return {kind:'unparseable'};
  return null;
}
const emptyCounts = () => ({ account:new Map(), total:new Map(), relayReceived:new Map(), relayRejected:new Map() });
const add=(map,key)=>map.set(key,(map.get(key)??0)+1);
function unknownMetric(item,rules,reason){return {item,windows:rules.map(r=>({windowMinutes:r.windowMinutes??0,threshold:r.threshold,value:null,target:null,targets:[],complete:false,status:'unknown',reason}))};}
function rulesFor(settings,item){return Array.isArray(settings.rules[item])?settings.rules[item]:[settings.rules[item]];}
export function createMonitorCollector({ config, mailcow, logArchive, relayReader=readRelayFiles, now=Date.now, monotonicNow=()=>performance.now(), limits={} }) {
  const cap={milliseconds:120000,pages:256,rows:200000,bytes:128*1024*1024,...limits};
  let warmSince=now(),lastSuccess=null;
  async function readArchive(T,signal) {
    if(!logArchive?.enabled)return {complete:false,reason:'ARCHIVE_DISABLED'};
    // This is the last successful observation, not a continuous coverage proof.
    const status=await logArchive.status({signal});
    const stamp=status?.sources?.postfix?.lastSuccessfulCollectionAt;
    const success=typeof stamp==='string'&&monitorTimestamp(stamp)!==null?Date.parse(stamp):null;
    if(success===null || lastSuccess!==null&&success<lastSuccess)warmSince=now();
    lastSuccess=success;
    if(success===null || success<T)return {complete:false,reason:'COLLECTION_UNCONFIRMED',lastSuccessfulCollectionAt:stamp??null};
    const start=T-60*minute;
    let pages=0,rows=0,bytes=0;const started=monotonicNow();
    const run=async()=>{
      const counts=new Map([5,15,60].map(w=>[w,emptyCounts()])), seenRows=new Set(), submissions=new Map(), rejections=new Set();
      let cursor=null; const accountUnknown=new Set(),cursors=new Set(); let coverage=null;
      do {
        if(signal.aborted)throw Object.assign(new Error(),{code:'COLLECTION_ABORTED'});
        if(++pages>cap.pages || monotonicNow()-started>=cap.milliseconds)throw Object.assign(new Error(),{code:'COLLECTION_LIMIT'});
        const data=await logArchive.search({source:'postfix',start:iso(start),end:iso(T),q:'',limit:'1000',...(cursor?{cursor}:{})},{signal});
        if(!object(data)||!Array.isArray(data.lines)||data.lines.length>1000||!(data.nextCursor===null||typeof data.nextCursor==='string'&&data.nextCursor.length>0&&data.nextCursor.length<=4096)||typeof data.incomplete!=='boolean'||![null,'limit','response_bytes','scan_bytes','timeout'].includes(data.partialReason)||!Number.isSafeInteger(data.scannedBytes)||data.scannedBytes<0)throw Object.assign(new Error(),{code:'INVALID_ARCHIVE_RESPONSE'});
        bytes+=data.scannedBytes;rows+=data.lines.length;
        if(bytes>cap.bytes||rows>cap.rows)throw Object.assign(new Error(),{code:'COLLECTION_LIMIT'});
        const checked=archiveCoverage(data.coverage,'postfix');

        if(coverage&&JSON.stringify(checked)!==JSON.stringify(coverage))throw Object.assign(new Error(),{code:'ARCHIVE_CHANGED'});
        coverage=checked;
        for(const row of data.lines){
          if(!object(row)||typeof row.id!=='string'||!row.id||row.id.length>512||typeof row.program!=='string'||typeof row.message!=='string'||Array.from(row.message).length>=4000||['[민감 정보가 포함된 로그]','[구조화 로그 내용 생략]'].includes(row.message)||row.truncated||row.unknownTime)throw Object.assign(new Error(),{code:'ARCHIVE_LOSS'});
          const stampKey=monitorTimestamp(row.time);if(stampKey===null)throw Object.assign(new Error(),{code:'ARCHIVE_LOSS'});
          if(seenRows.has(row.id))throw Object.assign(new Error(),{code:'ARCHIVE_DUPLICATE_ROW'});seenRows.add(row.id);
          if(stampKey<monitorTimestamp(iso(start))||stampKey>=monitorTimestamp(iso(T)))throw Object.assign(new Error(),{code:'ARCHIVE_TIME_RANGE'});
          const event=monitorEvent(row);if(!event)continue;if(event.kind==='unparseable')throw Object.assign(new Error(),{code:'ARCHIVE_PARSE_LOSS'});
          // A queue removal closes its lifecycle; ordinary delivery retry lines never count.
          if(event.kind==='removed'){for(const k of submissions.keys())if(k.startsWith(event.qid+'|'))submissions.delete(k);for(const k of rejections)if(k.startsWith(event.qid+'|'))rejections.delete(k);continue;}
          if(event.kind==='submission'){
            const key=[event.qid,event.pid,event.client,event.account].join('|');
            if(submissions.has(key))continue;submissions.set(key,stampKey);
          }
          if(event.kind==='rejection'&&event.qid){const key=[event.qid,event.pid,event.stage].join('|');if(rejections.has(key))continue;rejections.add(key);}
          for(const [window,values] of counts)if(stampKey>=monitorTimestamp(iso(T-window*minute))){
            if(event.kind==='removed'){for(const k of submissions.keys())if(k.startsWith(event.qid+'|'))submissions.delete(k);for(const k of rejections)if(k.startsWith(event.qid+'|'))rejections.delete(k);continue;}
          if(event.kind==='submission'){
              if(event.authenticated){add(values.total,'all');if(event.account)add(values.account,event.account);else accountUnknown.add(window);}
              // Relay membership is applied after the complete snapshot is read.
            }
          }
          // Compact parsed facts only; no raw log lines survive this page.
          if(event.client){facts.push({event,stamp:row.time});}
        }
        cursor=data.nextCursor;
        if(cursor){if(cursors.has(cursor))throw Object.assign(new Error(),{code:'ARCHIVE_CURSOR_LOOP'});cursors.add(cursor);}
        else if(data.partialReason!==null||data.complete===false)throw Object.assign(new Error(),{code:'ARCHIVE_INCOMPLETE'});
      }while(cursor);
      return {complete:true,counts,accountUnknown,coverage,lastSuccessfulCollectionAt:stamp};
    };
    let facts=[];
    for(let attempt=0;attempt<2;attempt++)try{facts=[];return {...await run(),facts};}catch(e){if(e.status===410||e.statusCode===410){if(!attempt)continue;}return {complete:false,reason:typeof e.code==='string'&&/^[A-Z_]+$/.test(e.code)?e.code:'ARCHIVE_UNAVAILABLE',lastSuccessfulCollectionAt:stamp};}
  }
  async function collect(settings,{signal:parent}={}) {
    const controller=new AbortController(),abort=()=>controller.abort();parent?.addEventListener('abort',abort,{once:true});if(parent?.aborted)abort();
    const timeout=setTimeout(abort,cap.milliseconds);timeout.unref?.();
    const T=Math.floor(now()/300000)*300000,signal=controller.signal;
    try {
      const archivePromise=readArchive(T,signal).catch(()=>({complete:false,reason:'ARCHIVE_UNAVAILABLE'}));
      const relayPromise=relayReader(config).then(v=>v.consistent?{...v,complete:true}:{complete:false,reason:'RELAY_MISMATCH'}).catch(e=>({complete:false,disabled:e.code==='RELAY_DISABLED',reason:e.code==='RELAY_DISABLED'?'RELAY_DISABLED':'RELAY_UNAVAILABLE'}));
      const queuePromise=(async()=>{try{const context=mailcow.createApiContext({permission:'read'});const items=queueItems(await mailcow.call(context,'GET','/api/v1/get/mailq/all',undefined,signal),now());if(items.some(r=>!r.id))throw new Error();return {complete:true,value:new Set(items.map(r=>r.id)).size,at:iso(now())};}catch{return {complete:false,reason:'QUEUE_UNAVAILABLE'};}})();
      const [archive,relay,queue]=await Promise.all([archivePromise,relayPromise,queuePromise]);
      const networks=relay.complete?relay.ips.map(relayNetwork):[];
      const matched=ip=>{if(!ip)return false;const n=relayNetwork(ip);return networks.some(r=>r.family===n.family&&r.start<=n.start&&r.end>=n.end);};
      if(archive.complete)for(const {event,stamp}of archive.facts)if(matched(event.client))for(const [window,values]of archive.counts)if(monitorTimestamp(stamp)>=monitorTimestamp(iso(T-window*minute))){if(event.kind==='submission'){add(values.relayReceived,event.client);if(!event.authenticated)add(values.total,'all');}else add(values.relayRejected,event.client);}
      const metrics=[];
      for(const item of ['account','total','queue','relayReceived','relayRejected']){
        const rules=rulesFor(settings,item);
        if(item==='queue'){
          if(!queue.complete)metrics.push(unknownMetric(item,rules,queue.reason));
          else metrics.push({item,windows:[{windowMinutes:0,threshold:rules[0].threshold,value:queue.value,target:'all',targets:[{target:'all',value:queue.value}],complete:true,status:queue.value>rules[0].threshold?'exceeded':queue.value===rules[0].threshold?'warning':'normal',reason:null,observedAt:queue.at}]});
          continue;
        }
        const needsRelay=item==='total'||item.startsWith('relay');
        const reason=!archive.complete?archive.reason:needsRelay&&!relay.complete&&!relay.disabled?relay.reason:item.startsWith('relay')&&relay.disabled?'RELAY_DISABLED':null;
        if(reason){metrics.push(unknownMetric(item,rules,reason));continue;}
        metrics.push({item,windows:rules.map(r=>{
          if(item==='account'&&archive.accountUnknown.has(r.windowMinutes))return unknownMetric(item,[r],'ACCOUNT_UNKNOWN').windows[0];
          if(archive.coverage.gaps.some(g=>!g.from||!g.to||Date.parse(g.from)<T&&Date.parse(g.to)>T-r.windowMinutes*minute))return unknownMetric(item,[r],'ARCHIVE_GAP').windows[0];
          if(T-warmSince<r.windowMinutes*minute)return unknownMetric(item,[r],'WARMING_UP').windows[0];
          const map=archive.counts.get(r.windowMinutes)[item];
          const targets=[...map].map(([target,value])=>({target,value})).sort((a,b)=>b.value-a.value||a.target.localeCompare(b.target));
          if(item==='total'&&!targets.length)targets.push({target:'all',value:0});
          const top=targets[0]??{target:null,value:0};
          return {windowMinutes:r.windowMinutes,threshold:r.threshold,...top,targets,complete:true,status:top.value>r.threshold?'exceeded':top.value===r.threshold?'warning':'normal',reason:null};
        })});
      }
      return {asOf:iso(T),metrics,sources:{postfix:{complete:archive.complete,reason:archive.reason??null,lastSuccessfulCollectionAt:archive.lastSuccessfulCollectionAt??null},queue:{complete:queue.complete,reason:queue.reason??null},relay:{complete:relay.complete,reason:relay.reason??null}},relayEtag:relay.disabled?'disabled':relay.etag??null};
    }finally{clearTimeout(timeout);parent?.removeEventListener('abort',abort);}
  }
  return {collect};
}
