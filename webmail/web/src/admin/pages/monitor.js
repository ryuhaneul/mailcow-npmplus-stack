import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { registerAdminLeaveGuard } from '../router.js';
export const monitorDefinitions = [
  {id:'account',name:'계정당 발송 수',card:'계정당 발송 최댓값',unit:'통',hint:'한 계정에서 접수한 발송 메시지 수'},
  {id:'total',name:'전체 발송 수',unit:'통',hint:'인증 발송과 허용 릴레이의 접수 메시지 수'},
  {id:'queue',name:'큐에 쌓인 수',unit:'건',hint:'판정 시점에 대기 중인 메일 수'},
  {id:'relayReceived',name:'릴레이 IP 수신량',unit:'통',hint:'허용 릴레이 IP별 접수 메시지 수'},
  {id:'relayRejected',name:'릴레이 IP 거부 수',unit:'건',hint:'허용 릴레이 IP별 SMTP 거부 사건 수'},
];
export const windowText = n => n === 0 ? '판정 시점' : n === 60 ? '1시간' : `${n}분`;
export const monitorReason = code => ({WARMING_UP:'수집 중 · 감시 창 준비 중',NOT_CHECKED:'아직 판정하지 않았습니다',DISABLED:'감시 꺼짐',RELAY_DISABLED:'릴레이 목록 없음',RELAY_MISMATCH:'릴레이 목록 확인 필요',ACCOUNT_UNKNOWN:'계정 확인 불가',ARCHIVE_GAP:'로그 일부 누락 · 확인 불가',COLLECTION_UNCONFIRMED:'수집 완료 확인 불가',ARCHIVE_DISABLED:'보관 로그 연결 필요',QUEUE_UNAVAILABLE:'큐 조회 실패'})[code] ?? '부분 수집 또는 오류 · 확인 불가';
export function monitorSettingsValid(s) {
  const positive=v=>/^\d+$/.test(String(v))&&Number.isSafeInteger(Number(v))&&Number(v)>0;
  return Boolean(s && positive(s.repeatMinutes) && Number(s.repeatMinutes)<=525600 && positive(s.bounceAuto.durationMinutes) && Number(s.bounceAuto.durationMinutes)<=525600 && (!s.enabled||s.recipients.length) && s.recipients.length<=20 && s.recipients.every(validMonitorAddress) && monitorDefinitions.every(d=>(Array.isArray(s.rules[d.id])?s.rules[d.id]:[s.rules[d.id]]).every(r=>positive(r.threshold))));
}
export const validMonitorAddress = value => typeof value==='string' && value.length<=254 && !/[\s\x00-\x1f\x7f]/.test(value) && /^[^@]+@[^@.]+(?:\.[^@.]+)+$/.test(value);
export function numericMonitorSettings(s) { const value=structuredClone(s);value.repeatMinutes=Number(value.repeatMinutes);value.bounceAuto.durationMinutes=Number(value.bounceAuto.durationMinutes);for(const d of monitorDefinitions)for(const rule of Array.isArray(value.rules[d.id])?value.rules[d.id]:[value.rules[d.id]]){rule.threshold=Number(rule.threshold);if(rule.windowMinutes!==undefined)rule.windowMinutes=Number(rule.windowMinutes);}return value; }
export function monitorChanges(before,after) {
  const flat=s=>[['메일 이상 감시',s.enabled?'켜짐':'꺼짐'],...monitorDefinitions.flatMap(d=>(Array.isArray(s.rules[d.id])?s.rules[d.id]:[s.rules[d.id]]).map(r=>[`${d.name} · ${windowText(r.windowMinutes??0)}`,`${r.threshold}${d.unit}`])),['알림 받는 메일 주소',s.recipients.join(', ')||'없음'],['같은 이상 반복 억제',`${s.repeatMinutes}분`],['해소 알림',s.recoveryEnabled?'켜짐':'꺼짐'],['자동 일시 억제',s.bounceAuto.enabled?'켜짐':'꺼짐'],['자동 억제 기간',`${s.bounceAuto.durationMinutes}분`]];
  const previous=flat(before);return flat(after).flatMap(([name,value],i)=>previous[i][0]===name&&previous[i][1]===value?[]:[[name,previous[i][0]===name?previous[i][1]:previous[i][0]+' · '+previous[i][1],value]]);
}
const leaveGuards=new Map();let releaseGuard;
function syncLeaveGuard(){releaseGuard?.();releaseGuard=leaveGuards.size?registerAdminLeaveGuard(()=>{const values=[...leaveGuards.values()];return !values.some(v=>v.busy)&&(!values.some(v=>v.dirty)||window.confirm('저장하지 않은 변경이 있습니다. 화면을 떠날까요?'));}):undefined;}
export function useMonitorLeaveGuard(dirty,busy) {
  useEffect(()=>{if(!dirty&&!busy)return;const id=Symbol();leaveGuards.set(id,{dirty,busy});syncLeaveGuard();const unload=e=>{e.preventDefault();e.returnValue='';};addEventListener('beforeunload',unload);return()=>{leaveGuards.delete(id);syncLeaveGuard();removeEventListener('beforeunload',unload);};},[dirty,busy]);
}

export function useMonitorDialogFocus(open) {
  const previous=useRef(null);
  useLayoutEffect(()=>{if(!open)return;previous.current=globalThis.document?.activeElement;return()=>{const target=previous.current;queueMicrotask(()=>{if(target?.isConnected)target.focus();});};},[open]);
}
