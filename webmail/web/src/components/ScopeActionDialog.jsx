import { useLayoutEffect, useRef } from 'preact/hooks';
import { folders } from '../state/folders.js';
import { folderLabel } from '../format.js';
import { list, loadFailureMessages } from '../state/list.js';
import { selection, scopeSelection, selectAllMatching, clearSelection } from '../state/selection.js';
import { cancelScopedAction, confirmScopedAction, stopScopedAction, resumeScopedAction, canResumeScopedAction, retryFailedScopedAction, canRetryFailedScopedAction, returnToMailbox, scopedRequestPending } from '../state/scoped-actions.js';
import Icon from './Icon.jsx';

export const scopeActions = {
  seen:{label:'읽음 표시',question:'읽음으로 표시할까요?',progress:'읽음 표시 중',done:'읽음 표시를 마쳤어요'},
  unseen:{label:'읽지 않음 표시',question:'읽지 않음으로 표시할까요?',progress:'읽지 않음 표시 중',done:'읽지 않음 표시를 마쳤어요'},
  flag:{label:'별표',question:'별표를 붙일까요?',progress:'별표 추가 중',done:'별표를 붙였어요'},
  unflag:{label:'별표 해제',question:'별표를 해제할까요?',progress:'별표 해제 중',done:'별표를 해제했어요'},
  move:{label:'폴더로 옮기기',question:'다른 폴더로 옮길까요?',progress:'폴더로 옮기는 중',done:'폴더로 옮겼어요'},
  archive:{label:'보관',question:'보관할까요?',progress:'보관 중',done:'보관을 마쳤어요'},
  trash:{label:'휴지통으로 옮기기',question:'휴지통으로 옮길까요?',progress:'휴지통으로 옮기는 중',done:'휴지통으로 옮겼어요',danger:true},
  spam:{label:'스팸 신고',question:'스팸으로 신고할까요?',progress:'스팸 신고 중',done:'스팸으로 신고했어요'},
  notspam:{label:'스팸 아님',question:'스팸 아님으로 처리할까요?',progress:'스팸 아님 처리 중',done:'스팸 아님으로 처리했어요'},
  'delete-forever':{label:'영구 삭제',question:'영구 삭제할까요?',progress:'영구 삭제 중',done:'영구 삭제를 마쳤어요',danger:true},
};
export const scopeNumber=value=>(value??0).toLocaleString('ko-KR');
export const quickLabels={all:'전체',unread:'읽지 않음',starred:'별표',attach:'첨부 있음'};
function namedFolder(path) {const folder=folders.value.folders.find(item=>item.path===path);return folder?folderLabel(folder):path;}
export function scopeLabel(scope) {
  const junk=folders.value.folders.find(item=>item.specialUse==='\\Junk')?.path??'Junk';
  const trash=folders.value.folders.find(item=>item.specialUse==='\\Trash')?.path??'Trash';
  const path=scope.view==='spam'?junk:scope.view==='folder'?scope.folder:'INBOX';
  const confined=(scope.view==='spam'||scope.view==='folder')&&[junk,trash].includes(path);
  if(confined)return `${namedFolder(path)} 안${scope.q?.trim()?'에서 검색':''}`;
  if(scope.view==='allmail'||scope.q?.trim())return '전체편지함 · 스팸·휴지통 제외';
  return scope.view==='inbox'?'받은편지함':namedFolder(path);
}
export function failureLabel(code) {
  return ({ACTION_OUTCOME_UNKNOWN:'결과 확인 필요',FOLDER_READONLY:'읽기 전용',MAIL_UNAVAILABLE:'연결 오류',STALE_SCOPE:'원본 폴더 변경',MOVE_UNSUPPORTED:'이동 미지원',DELETE_NOT_ALLOWED:'영구 삭제 불가'})[code]||'처리 실패';
}
export function ScopeSelectionNotice() {
  const value=list.value,scoped=scopeSelection.value,all=scoped?.selected&&['all','confirming'].includes(scoped.status)&&!scoped.selectionId;
  const page=!scoped?.failureView&&!all&&selection.value.size>0&&value.items.length>0&&value.items.every(item=>selection.value.has(item.ref))&&value.total>value.items.length;
  const button=useRef(null),previous=useRef(false);
  useLayoutEffect(()=>{
    if(previous.current&&document.activeElement===document.body){
      if(all||page)button.current?.focus();else document.querySelector('.sa-tools .cbw')?.focus();
    }
    previous.current=all||page;
  },[all,page]);
  if(!all&&!page)return null;
  return <div class={`sa-notice ${all?'all':''}`}>
    <span>{all?<b>{scopeNumber(scoped.totalEstimate)}통 모두 선택됨</b>:<>이 화면 <b>{scopeNumber(value.items.length)}통</b> 선택됨</>}</span>
    <button ref={button} class="sa-link" type="button" onClick={()=>all?clearSelection():selectAllMatching(value.params,value.total)}>{all?'선택 해제':<>조건에 맞는 메일 {scopeNumber(value.total)}통 모두 선택</>}</button>
  </div>;
}
export function ScopeActionProgress() {
  const value=scopeSelection.value,info=scopeActions[value.action],known=value.initialTotal!==null,m=value.attempted,n=value.initialTotal;
  return <div class="tools sa-progress"><div class="sa-job"><div class="sa-job-main">
    <strong>{value.status==='stopping'?'멈추는 중…':known?info.progress:'조건에 맞는 메일 준비 중…'}{known&&<> · <span class="num">시도 {scopeNumber(m)} / {scopeNumber(n)}</span></>}</strong>
    <div class="sa-track" role="progressbar" aria-label={`${info.label} 시도 진행`} aria-valuemin={0} aria-valuemax={known?n:undefined} aria-valuenow={known?m:undefined} aria-valuetext={known?`${scopeNumber(m)} / ${scopeNumber(n)}통 시도`:'대상을 준비하고 있어요'}><span style={{width:`${known&&n>0?m/n*100:0}%`}}/></div>
    <p>{known?<>처리 {scopeNumber(value.totals.processed)}통 · 건너뜀 {scopeNumber(value.totals.skipped)}통 · 실패 {scopeNumber(value.totals.failed)}통</>:'확인 시점의 조건에 맞는 대상을 준비하고 있어요.'}</p>
    <p>멈추면 지금 처리 중인 묶음까지 마친 뒤 멈춰요. 이미 처리한 메일은 그대로예요.</p>
  </div><button class="btn sa-stop" type="button" disabled={value.stopRequested} onClick={stopScopedAction}>{value.stopRequested?'멈추는 중…':'멈추기'}</button></div></div>;
}
function resultTitle(value) {
  const info=scopeActions[value.action];
  if(value.status==='error')return `${info.label} 중 오류가 발생했어요`;
  if(value.status==='stopped')return scopedRequestPending.value?'현재 묶음의 응답을 기다리고 있어요':`${info.label} 중단`;
  return value.totals.failed?`${info.label} 결과`:info.done;
}
export function ScopeActionResult() {
  const value=scopeSelection.value,visible=value&&['completed','stopped','error'].includes(value.status),root=useRef(null);
  useLayoutEffect(()=>{if(visible&&document.activeElement===document.body)root.current?.focus();},[visible,value?.status]);
  if(!visible)return null;
  const remaining=value.remainingEstimate??(value.initialTotal===null?null:value.initialTotal-value.attempted),pending=scopedRequestPending.value;
  return <section class={`sa-result ${value.status==='completed'&&!value.totals.failed?'sa-success':''}`} ref={root} tabIndex={-1} aria-labelledby="sa-result-title"><div class="sa-job"><div class="sa-job-main">
    <h2 id="sa-result-title"><Icon name={value.status==='completed'&&!value.totals.failed?'check':value.status==='error'?'alert':'info'}/>{resultTitle(value)}</h2>
    <p class="sa-counts">처리 <b class="num">{scopeNumber(value.totals.processed)}통</b> · 건너뜀 <b class="num">{scopeNumber(value.totals.skipped)}통</b> · 실패 <b class="num">{scopeNumber(value.totals.failed)}통</b></p>
    {value.totals.skipped>0&&<p>건너뜀은 그새 조건에서 벗어났거나 이미 없어진 메일이에요.</p>}
    {value.status!=='completed'&&<p>{remaining===null?'대상 준비를 마치지 못했어요.':<>남은 <b>{scopeNumber(remaining)}통</b>은 처리하지 않았어요.</>} 이미 처리한 메일은 그대로예요.</p>}
    {value.error&&<p class="sa-error" role="alert">{value.error.code==='SCOPE_EXPIRED'?'선택이 만료됐어요. 다시 선택해 주세요.':value.responseLost?'응답을 받지 못했어요. 이어서 실행하면 마지막 처리 결과부터 확인해요.':value.error.message}</p>}
    {value.unknownFailed>0&&<p class="sa-error">결과가 불명확한 메일 {scopeNumber(value.unknownFailed)}통은 실제 적용되었을 수 있어요. 메일함 상태를 확인해 주세요. 이 메일은 다시 실행하지 않아요.</p>}
    {value.failureView&&<p>실패한 메일만 표시하고 있어요.{value.unknownFailed>0?' 결과를 확인해야 하는 메일도 포함돼요.':''}</p>}
    {value.expiresAt&&value.status!=='completed'&&<p>선택 기록은 시간이 지나면 만료돼요. 만료되면 다시 선택해 주세요.</p>}
  </div><div class="sa-result-actions">
    {canResumeScopedAction()&&<button class="btn" type="button" onClick={()=>void resumeScopedAction()}>남은 것 이어서</button>}
    {canRetryFailedScopedAction()&&<button class="btn sa-retry" type="button" onClick={retryFailedScopedAction}>실패만 다시</button>}
    {value.totals.failed>0&&!value.failureView&&<button class="btn" type="button" disabled={pending} onClick={()=>void loadFailureMessages()}>실패 메일 보기</button>}
    <button class="btn ghost" type="button" disabled={pending} onClick={()=>void returnToMailbox()}>메일함으로 돌아가기</button>
  </div></div></section>;
}
export function ScopeActionAnnouncement() {
  const value=scopeSelection.value;let text='';
  if(value){
    if(value.status==='all')text=`조건에 맞는 메일 ${scopeNumber(value.totalEstimate)}통 모두 선택됨`;
    else if(value.status==='preparing')text='조건에 맞는 메일을 준비하고 있어요.';
    else if(value.status==='stopping')text='현재 묶음을 마친 뒤 멈춰요.';
    else if(value.status==='running')text=`${scopeActions[value.action].progress}. 시도 ${scopeNumber(value.attempted)} / ${scopeNumber(value.initialTotal)}통. 처리 ${scopeNumber(value.totals.processed)}통.`;
    else if(['completed','stopped','error'].includes(value.status))text=`${resultTitle(value)}. 처리 ${scopeNumber(value.totals.processed)}통, 건너뜀 ${scopeNumber(value.totals.skipped)}통, 실패 ${scopeNumber(value.totals.failed)}통.`;
  }
  return <div class="sr" role="status" aria-live="polite" aria-atomic="true">{text}</div>;
}
function Confirmation({value}) {
  const dialog=useRef(null),info=scopeActions[value.action],n=value.confirmationTotal;
  useLayoutEffect(()=>{
    const opener=document.activeElement,element=dialog.current;element.showModal();
    return()=>{
      element.close();
      requestAnimationFrame(()=>{
        const fallback=document.querySelector(value.retrySelectionId?'.sa-retry':`[data-sa-action="${value.action}"]` ) || (!value.retrySelectionId&&['unseen','flag','unflag'].includes(value.action)?document.querySelector('.sa-tools [aria-label="더 보기"]'):null);
        (opener?.isConnected&&opener!==document.body&&!opener.disabled?opener:fallback&&!fallback.disabled?fallback:document.querySelector('.sa-stop:not(:disabled),.sa-result,#page-title'))?.focus({preventScroll:true});
      });
    };
  },[]);
  return <dialog class="sa-dialog" ref={dialog} aria-labelledby="sa-confirm-title" aria-describedby="sa-confirm-description sa-cutoff" onKeyDown={event=>{
    if(event.key!=='Tab')return;
    const buttons=dialog.current.querySelectorAll('button:not(:disabled)'),first=buttons[0],last=buttons[buttons.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }} onCancel={event=>{event.preventDefault();cancelScopedAction();}}>
    <form onSubmit={event=>{event.preventDefault();void confirmScopedAction();}}>
      <div class="sa-modal-kicker">메일 일괄 처리</div><h2 id="sa-confirm-title">{scopeNumber(n)}통을 {info.question}</h2>
      <p id="sa-confirm-description">{value.action==='delete-forever'?<>지운 메일은 <b>복구할 수 없어요.</b></>:value.action==='trash'?'휴지통으로 옮긴 메일은 휴지통에서 다시 꺼낼 수 있어요.':'아래 조건에 맞는 메일에 적용해요.'}</p>
      <dl><dt>대상</dt><dd><b class="num">{scopeNumber(n)}통</b> · {value.retrySelectionId?'다시 실행할 수 있는 실패 메일만':'선택한 조건 전체 · 준비 전 추정치'}</dd>
        <dt>폴더</dt><dd>{scopeLabel(value.scope)}</dd>
        <dt>검색어</dt><dd>{value.scope.q||'없음'}</dd>
        <dt>빠른 필터</dt><dd>{quickLabels[value.scope.quick]}</dd>
        {value.scope.in&&<><dt>폴더 조건</dt><dd>{namedFolder(value.scope.in)}</dd></>}
        {value.action==='move'&&<><dt>이동할 폴더</dt><dd>{namedFolder(value.target)}</dd></>}
      </dl>
      <p class="sa-cutoff" id="sa-cutoff">{value.retrySelectionId?'처음 실행에서 실패한 메일만 다시 처리해요. 결과가 불명확한 메일은 제외해요.':<>확인을 누른 뒤 도착한 메일은 포함 안 돼요.<br/>준비가 끝나면 실제 대상 수를 표시해요.</>}</p>
      <div class="sa-dactions"><button class="btn" type="button" autoFocus onClick={cancelScopedAction}>취소</button><button class={`btn ${info.danger?'dan':'pri'}`} type="submit">{scopeNumber(n)}통 {info.label}</button></div>
    </form>
  </dialog>;
}
export default function ScopeActionDialog() {const value=scopeSelection.value;return value?.status==='confirming'?<Confirmation value={value}/>:null;}
