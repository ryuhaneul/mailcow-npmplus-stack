import * as filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from '../errors.js';
import { bounceAddress } from './bounce-policy.js';
import { notificationAddress } from './quota-notification-state.js';

export const monitorItems = Object.freeze(['account', 'total', 'queue', 'relayReceived', 'relayRejected']);
export const defaultMonitorSettings = () => ({ v: 1, enabled: false, recipients: [], repeatMinutes: 60, recoveryEnabled: true,
  rules: { account: [{ windowMinutes: 5, threshold: 50 }, { windowMinutes: 60, threshold: 200 }], total: [{ windowMinutes: 5, threshold: 600 }, { windowMinutes: 60, threshold: 2500 }], queue: { mode: 'snapshot', threshold: 100 }, relayReceived: { windowMinutes: 5, threshold: 300 }, relayRejected: { windowMinutes: 5, threshold: 20 } },
  bounceAuto: { enabled: false, durationMinutes: 60 } });
export const emptyMonitorState = () => ({ v: 1, settingsEtag: null, relayEtag: null, lastAttemptAt: null, lastCompleteAt: null, asOf: null, snapshot: null, collection: null, incidents: [], outbox: [], notifications: [] });
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, names) => object(v) && Object.keys(v).sort().join(',') === [...names].sort().join(',');
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v > 0 && v <= max;
export const monitorTime = v => v === null || typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const invalid = () => new AppError(422, 'INVALID_INPUT', '감시 기준과 알림 주소를 확인해 주세요.');
export function validateMonitorSettings(v) {
  if (!keys(v, ['v','enabled','recipients','repeatMinutes','recoveryEnabled','rules','bounceAuto']) || v.v !== 1 || typeof v.enabled !== 'boolean' || typeof v.recoveryEnabled !== 'boolean' || !integer(v.repeatMinutes, 525600) || !Array.isArray(v.recipients) || v.recipients.length > 20 || v.recipients.some(a => !notificationAddress(a) || /[\x00-\x20\x7f-\x9f]/.test(a)) || !keys(v.rules, monitorItems) || !keys(v.bounceAuto, ['enabled','durationMinutes']) || typeof v.bounceAuto.enabled !== 'boolean' || !integer(v.bounceAuto.durationMinutes, 525600)) throw invalid();
  const rule = r => keys(r, ['windowMinutes','threshold']) && [5,15,60].includes(r.windowMinutes) && integer(r.threshold);
  for (const item of ['account','total']) if (!Array.isArray(v.rules[item]) || v.rules[item].length !== 2 || !v.rules[item].every(rule) || v.rules[item].map(r => r.windowMinutes).sort((a,b)=>a-b).join(',') !== '5,60') throw invalid();
  if (!keys(v.rules.queue, ['mode','threshold']) || v.rules.queue.mode !== 'snapshot' || !integer(v.rules.queue.threshold) || !rule(v.rules.relayReceived) || !rule(v.rules.relayRejected)) throw invalid();
  const recipients = [...new Set(v.recipients.map(a => a.toLowerCase()))];
  if (v.enabled && !recipients.length) throw invalid();
  return { ...structuredClone(v), recipients };
}
const safeText = v => typeof v === 'string' && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);
const nonnegative = v => Number.isSafeInteger(v) && v >= 0;
function validSnapshot(v) {
  if (!keys(v,['asOf','relayEtag','metrics','sources']) || !monitorTime(v.asOf) || v.asOf === null || !(v.relayEtag === null || safeText(v.relayEtag)) || !Array.isArray(v.metrics) || v.metrics.length !== 5 || new Set(v.metrics.map(m=>m.item)).size !== 5 || !keys(v.sources,['postfix','queue','relay'])) return false;
  for (const m of v.metrics) {
    if (!keys(m,['item','windows']) || !monitorItems.includes(m.item) || !Array.isArray(m.windows) || m.windows.length !== (['account','total'].includes(m.item)?2:1)) return false;
    for (const w of m.windows) {
      const required=['windowMinutes','threshold','value','target','targets','complete','status','reason'];
      if (!object(w) || Object.keys(w).some(k=>![...required,'observedAt','previous'].includes(k)) || required.some(k=>!Object.hasOwn(w,k)) || ![0,5,15,60].includes(w.windowMinutes) || !integer(w.threshold) || !(w.value===null||nonnegative(w.value)) || !(w.target===null||safeText(w.target)) || !Array.isArray(w.targets) || !w.targets.every(t=>keys(t,['target','value'])&&safeText(t.target)&&nonnegative(t.value)) || typeof w.complete!=='boolean' || !['normal','warning','exceeded','unknown'].includes(w.status) || !(w.reason===null||safeText(w.reason))) return false;
      if (w.complete && (w.value===null||w.reason!==null||w.status==='unknown') || !w.complete && (w.status!=='unknown'||w.value!==null)) return false;
      if (Object.hasOwn(w,'observedAt') && !monitorTime(w.observedAt)) return false;
      if (w.previous && (!keys(w.previous,['value','target','observedAt']) || !nonnegative(w.previous.value) || !(w.previous.target===null||safeText(w.previous.target)) || !monitorTime(w.previous.observedAt))) return false;
    }
  }
  for (const name of ['postfix','queue','relay']) {
    const source=v.sources[name];
    if (!keys(source,name==='postfix'?['complete','reason','lastSuccessfulCollectionAt']:['complete','reason']) || typeof source.complete!=='boolean' || !(source.reason===null||safeText(source.reason)) || name==='postfix'&&!monitorTime(source.lastSuccessfulCollectionAt)) return false;
  }
  return true;
}
// Persist only numeric five-minute buckets and recent lifecycle keys, never log bodies.
export const monitorStateMaxBytes = 16*1024*1024;
export const monitorSeenMax = 50000;
export const emptyMonitorCollection = at => ({v:1,startedAt:at,watermark:at,lastSuccessfulCollectionAt:null,bins:[],seen:[]});
export function validMonitorCollection(v) {
  const boundary=t=>monitorTime(t)&&t!==null&&Date.parse(t)%300000===0;
  const pairs=v=>Array.isArray(v)&&v.length<=monitorSeenMax&&new Set(v.map(p=>p?.[0])).size===v.length&&v.every(p=>Array.isArray(p)&&p.length===2&&safeText(p[0])&&nonnegative(p[1]));
  if(!keys(v,['v','startedAt','watermark','lastSuccessfulCollectionAt','bins','seen'])||v.v!==1||!boundary(v.startedAt)||!boundary(v.watermark)||!monitorTime(v.lastSuccessfulCollectionAt)||!Array.isArray(v.bins)||v.bins.length>12||!Array.isArray(v.seen)||v.seen.length>monitorSeenMax)return false;
  if(new Set(v.bins.map(b=>b?.end)).size!==v.bins.length||!v.bins.every(b=>keys(b,['end','complete','reason','counts','accountUnknown'])&&boundary(b.end)&&typeof b.complete==='boolean'&&(b.reason===null||safeText(b.reason))&&b.complete===(b.reason===null)&&typeof b.accountUnknown==='boolean'&&keys(b.counts,['account','total','relayReceived','relayRejected','relayUnauthenticated'])&&nonnegative(b.counts.total)&&['account','relayReceived','relayRejected','relayUnauthenticated'].every(k=>pairs(b.counts[k]))))return false;
  return new Set(v.seen.map(e=>e?.key)).size===v.seen.length&&v.seen.every(e=>keys(e,['key','at'])&&safeText(e.key)&&boundary(e.at));
}
export function validMonitorState(v) {
  if (!(keys(v, Object.keys(emptyMonitorState()))||keys(v,Object.keys(emptyMonitorState()).filter(k=>k!=='collection'))) || !(v.collection===undefined||v.collection===null||validMonitorCollection(v.collection)) || v.v !== 1 || ![v.lastAttemptAt,v.lastCompleteAt,v.asOf].every(monitorTime) || ![v.settingsEtag,v.relayEtag].every(x => x === null || safeText(x)) || !Array.isArray(v.incidents) || !Array.isArray(v.outbox) || !Array.isArray(v.notifications) || v.notifications.length > 1000 || !(v.snapshot === null || validSnapshot(v.snapshot))) return false;
  for (const i of v.incidents) {
    if (!keys(i, ['id','key','item','target','openedAt','closedAt','phase','rules','deliveries']) || !safeText(i.id) || !safeText(i.key) || !monitorItems.includes(i.item) || !safeText(i.target) || !monitorTime(i.openedAt) || i.openedAt === null || !monitorTime(i.closedAt) || !['active','resolved','cancelled'].includes(i.phase) || !Array.isArray(i.rules) || !Array.isArray(i.deliveries)) return false;
    if (!i.rules.every(r => keys(r, ['windowMinutes','value','threshold']) && Number.isSafeInteger(r.value) && r.value >= 0 && integer(r.threshold) && [0,5,15,60].includes(r.windowMinutes))) return false;
    if (!i.deliveries.every(d => keys(d, ['recipient','anchorAt','alerted','recoveryDone']) && notificationAddress(d.recipient) && monitorTime(d.anchorAt) && typeof d.alerted === 'boolean' && typeof d.recoveryDone === 'boolean')) return false;
  }
  const ids=new Set(v.incidents.map(i=>i.id));
  if(ids.size!==v.incidents.length || new Set(v.outbox.map(e=>e.id)).size!==v.outbox.length)return false;
  if (!v.outbox.every(e => ids.has(e.incidentId) && keys(e, ['id','incidentId','recipient','phase','at','pendingAt']) && safeText(e.id) && safeText(e.incidentId) && notificationAddress(e.recipient) && ['alert','recovery'].includes(e.phase) && monitorTime(e.at) && e.at !== null && monitorTime(e.pendingAt))) return false;
  if (!v.notifications.every(n => keys(n, ['id','at','phase','item','target','values','thresholds','recipientResults']) && safeText(n.id) && monitorTime(n.at) && n.at !== null && ['alert','recovery'].includes(n.phase) && monitorItems.includes(n.item) && safeText(n.target) && Array.isArray(n.values) && n.values.every(r=>keys(r,['windowMinutes','value'])&&[0,5,15,60].includes(r.windowMinutes)&&nonnegative(r.value)) && Array.isArray(n.thresholds) && n.thresholds.every(r=>keys(r,['windowMinutes','threshold'])&&[0,5,15,60].includes(r.windowMinutes)&&integer(r.threshold)) && Array.isArray(n.recipientResults) && n.recipientResults.every(r => keys(r, ['recipient','result']) && notificationAddress(r.recipient) && ['sent','failed','unknown'].includes(r.result)))) return false;
  return true;
}
export const emptyBounces = () => ({ v:1, revision:0, startedAt:null, completedEnd:null, recipients:[], seen:[], collection:{ lastAttemptAt:null, reason:null } });
export function validBounces(v) {
  if (!keys(v,Object.keys(emptyBounces())) || v.v!==1 || !nonnegative(v.revision) || !monitorTime(v.startedAt) || !monitorTime(v.completedEnd) || !Array.isArray(v.recipients) || v.recipients.length>10000 || !Array.isArray(v.seen) || !keys(v.collection,['lastAttemptAt','reason']) || !monitorTime(v.collection.lastAttemptAt) || !(v.collection.reason===null||safeText(v.collection.reason))) return false;
  const ids=new Set(),addresses=new Set();
  for (const r of v.recipients) {
    if (!(keys(r,['id','recipient','firstSeenAt','lastSeenAt','bounceCount','lastDsn','lastReason','sourceEventKey','internalExcluded','supported','manual','autoUntil','releasedAt']) || keys(r,['id','recipient','firstSeenAt','lastSeenAt','bounceCount','lastDsn','lastReason','sourceEventKey','internalExcluded','supported','manual','autoUntil','releasedAt','sender','resolvedAt'])) || !safeText(r.id) || !r.id || ids.has(r.id) || !safeText(r.recipient) || !r.recipient || addresses.has(r.recipient) || !monitorTime(r.firstSeenAt) || r.firstSeenAt===null || !monitorTime(r.lastSeenAt) || r.lastSeenAt===null || !integer(r.bounceCount) || !/^5\.\d{1,3}\.\d{1,3}$/.test(r.lastDsn) || !safeText(r.lastReason) || r.lastReason.length>300 || !/^[a-f0-9]{64}$/.test(r.sourceEventKey) || typeof r.internalExcluded!=='boolean' || typeof r.supported!=='boolean' || !monitorTime(r.autoUntil) || !monitorTime(r.releasedAt)) return false;
    if (Object.hasOwn(r,'sender') && (!(r.sender===null || safeText(r.sender)&&r.sender.length<=320&&bounceAddress(r.sender)?.recipient===r.sender) || !monitorTime(r.resolvedAt))) return false;
    if (r.manual!==null && (!keys(r.manual,['until','actor','at']) || !monitorTime(r.manual.until) || !monitorTime(r.manual.at) || r.manual.at===null || !safeText(r.manual.actor))) return false;
    ids.add(r.id);addresses.add(r.recipient);
  }
  return v.seen.every(e=>keys(e,['key','at'])&&/^[a-f0-9]{64}$/.test(e.key)&&monitorTime(e.at)&&e.at!==null) && new Set(v.seen.map(e=>e?.key)).size===v.seen.length;
}
export function normalizeBounces(value) { if(!validBounces(value))throw unavailable(); return {...value,recipients:value.recipients.map(r=>({sender:null,resolvedAt:null,...r}))}; }
const unavailable = () => new AppError(503, 'MONITOR_STORE_UNAVAILABLE', '감시 저장소를 확인해 주세요.');
export function createMonitorStore({ dir = '/data/mail-monitor', fs = filesystem } = {}) {
  const spec = { bounces: {max:16*1024*1024, fallback:emptyBounces, valid:validBounces}, settings: { max: 1024*1024, fallback: defaultMonitorSettings, valid: v => { try { return JSON.stringify(v) === JSON.stringify(validateMonitorSettings(v)); } catch { return false; } } }, state: { max: monitorStateMaxBytes, fallback: emptyMonitorState, valid: validMonitorState } };
  async function read(name) {
    let handle;
    try {
      const parent = await fs.lstat(dir);
      if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700) throw unavailable();
      handle = await fs.open(join(dir, name+'.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > spec[name].max || (stat.mode & 0o777) !== 0o600) throw unavailable();
      const value = JSON.parse(await handle.readFile('utf8'));
      if (!spec[name].valid(value)) throw unavailable();
      return name==='bounces'?normalizeBounces(value):name==='state'?{collection:null,...value}:value;
    } catch (e) { if (e.code === 'ENOENT') return spec[name].fallback(); throw unavailable(); }
    finally { await handle?.close(); }
  }
  async function write(name, value) {
    if (!spec[name].valid(value) || Buffer.byteLength(JSON.stringify(value)) > spec[name].max) throw unavailable();
    const tmp = join(dir, '.'+name+'-'+randomUUID()+'.tmp'); let file, parent;
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
      await fs.chmod(dir, 0o700);
      parent = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      file = await fs.open(tmp, 'wx', 0o600); await file.chmod(0o600);
      await file.writeFile(JSON.stringify(value)+'\n'); await file.sync(); await file.close(); file = null;
      await fs.rename(tmp, join(dir,name+'.json')); await parent.sync();
    } catch { throw unavailable(); }
    finally { await file?.close(); await parent?.close(); await fs.unlink(tmp).catch(()=>{}); }
  }
  return { readBounces:()=>read('bounces'), saveBounces:v=>write('bounces',normalizeBounces(v)), readSettings:()=>read('settings'), saveSettings:v=>write('settings',v), readState:()=>read('state'), saveState:v=>write('state',v) };
}
