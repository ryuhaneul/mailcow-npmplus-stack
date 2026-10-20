import { signal } from '@preact/signals';
import { api } from '../api.js';
import { session } from './session.js';
import { selection, scopeSelection } from './selection.js';
import { acting, cancelListLoad, loadMessages, loadFailureMessages, runAction, deleteMessages, listDeleteFolder, isPermanentDelete } from './list.js';

// Separate from the list's keyboard-focus cursor. A cursor advances only on a receipt.
export const scopedRequestPending = signal(false);
let generation=0, ownsActing=false;
function releaseActing() {if(ownsActing)acting.value=false;ownsActing=false;}
function update(patch) {scopeSelection.value={...scopeSelection.value,...patch};}
export function scopedListFrozen() {
  const value=scopeSelection.value;
  return ['preparing','running','stopping','stopped','error'].includes(value?.status) || (value?.status==='confirming' && !!value.selectionId);
}
export function resetScopedAction() {
  generation++;scopeSelection.value=null;releaseActing();
}
export function interruptScopedAction() {
  const value=scopeSelection.peek();
  if(!value)return;
  generation++;
  if(['preparing','running','stopping'].includes(value.status)){update({status:'stopped',stopRequested:true,responseLost:true});releaseActing();}
  else if(value.status==='confirming')cancelScopedAction();
}
export function requestScopedAction(action,target) {
  const value=scopeSelection.value;
  if(!value?.selected || value.status!=='all' || acting.value || scopedRequestPending.value)return;
  update({status:'confirming',confirmationTotal:value.totalEstimate,action,...(action==='move'?{target}:{target:undefined})});
}
// Toolbar/shortcuts share this entry. Row/reader actions keep explicit runAction refs.
export function runSelectedAction(action,target,fallbackRefs=[]) {
  if(scopeSelection.value?.selected)return requestScopedAction(action,target);
  return runAction(action,selection.value.size?[...selection.value]:fallbackRefs,target);
}
export function deleteSelectedMessages(fallbackRefs=[]) {
  const folder=listDeleteFolder();
  if(scopeSelection.value?.selected)return requestScopedAction(isPermanentDelete(folder)?'delete-forever':'trash');
  return deleteMessages(selection.value.size?[...selection.value]:fallbackRefs,folder);
}
export function cancelScopedAction() {
  if(scopeSelection.value?.status==='confirming'){
    const value=scopeSelection.value;
    update(value.retrySelectionId?{status:value.confirmationReturnStatus,selected:value.confirmationReturnSelected,retrySelectionId:undefined}:{status:'all',action:undefined,target:undefined});
  }
}
export function stopScopedAction() {
  if(['preparing','running','stopping'].includes(scopeSelection.value?.status))update({stopRequested:true,status:'stopping'});
}
function actionBody(value) {
  return {scope:value.scope,action:value.action,...(value.action==='move'?{target:value.target}:{})};
}
function receipt(value) {
  const current=scopeSelection.value;
  if(value.selectionId!==current.selectionId || value.sequence<current.sequence)return false;
  const failures=value.sequence>current.sequence?[...current.failures,...value.failed]:current.failures;
  update({sequence:value.sequence,batchId:value.batchId,totals:{...value.totals},failures,
    retryableFailed:failures.filter(item=>item.retryable).length,unknownFailed:failures.filter(item=>item.code==='ACTION_OUTCOME_UNKNOWN').length,
    attempted:value.totals.processed+value.totals.skipped+value.totals.failed,
    initialTotal:value.initialTotal,cursor:value.nextCursor,remainingEstimate:value.remainingEstimate,
    failed:value.failed,reason:value.reason});
  return true;
}
async function finish() {
  update({status:'completed',selected:false,stopRequested:false,responseLost:false});selection.value=new Set();
  if(scopeSelection.value.totals.failed)await loadFailureMessages();
  else await loadMessages({}, {preserveScopeResult:true});
}
async function drive(recoverOnly=false) {
  if(scopedRequestPending.value)return;
  const token=++generation;
  scopedRequestPending.value=true;ownsActing=true;acting.value=true;cancelListLoad();
  const current=()=>token===generation && !!scopeSelection.value;
  update({status:scopeSelection.value.phase==='execute'?'running':'preparing',stopRequested:false,error:null});
  try {
    while(current()) {
      const value=scopeSelection.value;
      if(!session.value){resetScopedAction();return;}
      if(value.phase!=='execute') {
        const body={...actionBody(value),selectionKey:value.selectionKey,cursor:value.cursor,
          ...(value.retrySelectionId?{selectionId:value.retrySelectionId,retry:'failed'}:{})};
        update({lastSentCursor:value.cursor,lastSentPhase:'prepare'});
        const result=await api('/api/messages/selections',{method:'POST',body});
        if(!current())return;
        update({selectionId:result.selectionId,cursor:result.cursor,expiresAt:result.expiresAt,
          totalEstimate:result.totalEstimate,initialTotal:result.initialTotal,
          phase:result.phase==='ready'?'execute':'prepare',cutoff:result.cutoff,responseLost:false});
        if(scopeSelection.value.stopRequested || recoverOnly){update({status:'stopped'});return;}
        if(result.phase==='ready')update({status:'running'});
        continue;
      }
      update({lastSentCursor:value.cursor,lastSentPhase:'execute'});
      const result=await api('/api/messages/actions/scope',{method:'POST',body:{...actionBody(value),cursor:value.cursor}});
      if(!current())return;
      receipt(result);update({responseLost:false});
      if(result.state==='completed'){await finish();return;}
      // A zero-progress budget receipt must not become an automatic request loop.
      if(scopeSelection.value.stopRequested || recoverOnly || result.delta.processed+result.delta.skipped+result.delta.failed===0){
        update({status:'stopped'});return;
      }
    }
  } catch(error) {
    if(!current())return;
    if(error.detail){receipt(error.detail);update({status:'error',error,responseLost:false,stopRequested:true});}
    else update({status:error.code?'error':'stopped',error,responseLost:!error.code,stopRequested:true});
  } finally {
    scopedRequestPending.value=false;
    releaseActing();
  }
}
export function confirmScopedAction() {
  if(scopeSelection.value?.status!=='confirming' || scopedRequestPending.value)return;
  if(scopeSelection.value.retrySelectionId)return confirmRetryFailedScopedAction();
  update({selectionKey:globalThis.crypto.randomUUID(),phase:'prepare'});
  return drive();
}
export function canResumeScopedAction() {
  const value=scopeSelection.value;
  return !scopedRequestPending.value && !!value && ['stopped','error'].includes(value.status) && !!value.selectionKey &&
    !(value.phase==='execute'&&!value.cursor) &&
    !['SCOPE_EXPIRED','STALE_SCOPE','SCOPE_CURSOR_INVALID','SCOPE_CURSOR_MISMATCH','NO_SESSION','SESSION_EXPIRED'].includes(value.error?.code);
}
export function resumeScopedAction() {
  const value=scopeSelection.value;
  if(!canResumeScopedAction())return;
  return drive(value.responseLost);
}
export function canRetryFailedScopedAction() {
  const value=scopeSelection.value;
  return !!value?.selectionId && value.retryableFailed>0 && ['completed','stopped','error'].includes(value.status) &&
    !scopedRequestPending.value && !['SCOPE_EXPIRED','NO_SESSION','SESSION_EXPIRED'].includes(value.error?.code);
}
export function retryFailedScopedAction() {
  const value=scopeSelection.value;
  if(!canRetryFailedScopedAction())return;
  // The server filters retryable refs; it never re-searches the original scope.
  update({status:'confirming',selected:false,retrySelectionId:value.selectionId,confirmationTotal:value.retryableFailed,confirmationReturnStatus:value.status,confirmationReturnSelected:value.selected});
}
export function confirmRetryFailedScopedAction() {
  const value=scopeSelection.value;
  if(value?.status!=='confirming' || !value.retrySelectionId || scopedRequestPending.value)return;
  update({selectionKey:globalThis.crypto.randomUUID(),selectionId:null,phase:'prepare',cursor:null,lastSentCursor:null,
    sequence:-1,totals:{processed:0,skipped:0,failed:0},attempted:0,initialTotal:null,
    failures:[],retryableFailed:0,unknownFailed:0,failurePage:null,failureView:false,error:null,responseLost:false,stopRequested:false});
  return drive();
}
export async function returnToMailbox() {
  if(scopedRequestPending.value)return;
  resetScopedAction();selection.value=new Set();
  return loadMessages();
}
