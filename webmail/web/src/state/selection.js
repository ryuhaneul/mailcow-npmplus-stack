import { computed, signal } from '@preact/signals';

// This Set always contains explicit, current-page refs, never a scope sentinel.
export const selection = signal(new Set());
export const scopeSelection = signal(null);
export const selectionMode = computed(()=>scopeSelection.value?.selected?'all':selection.value.size?'page':'none');
let pageRefs = [];
export function selectionScope(params) {
  return {view:params.view??'inbox',folder:params.folder??'',quick:params.quick??'all',q:params.q??'',in:params.in??''};
}
export function selectionScopeKey(params) {return JSON.stringify(selectionScope(params));}
export function selectionLocked() {return ['preparing','running','stopping'].includes(scopeSelection.value?.status);}
export function updateSelectionPage(items) {pageRefs=items.map(item=>item.ref);}
export function isSelected(ref) {return scopeSelection.value?.selected ? pageRefs.includes(ref) : selection.value.has(ref);}
export function clearSelection() {
  if(selectionLocked())return;
  if(scopeSelection.value?.selected)scopeSelection.value=null;selection.value=new Set();
}
export function selectPage(items) {
  if(selectionLocked())return;
  if(scopeSelection.value?.selected)scopeSelection.value=null;updateSelectionPage(items);selection.value=new Set(pageRefs);
}
export function selectAllMatching(params,totalEstimate) {
  if(selectionLocked() || !totalEstimate)return;
  selection.value=new Set();
  scopeSelection.value={selected:true,status:'all',scope:selectionScope(params),scopeKey:selectionScopeKey(params),
    totalEstimate,initialTotal:null,selectionKey:null,selectionId:null,cursor:null,lastSentCursor:null,
    phase:null,stopRequested:false,sequence:-1,totals:{processed:0,skipped:0,failed:0},attempted:0,
    failures:[],retryableFailed:0,unknownFailed:0,failurePage:null,failureView:false,expiresAt:null,error:null,responseLost:false};
}
export function toggleSelection(ref) {
  if(selectionLocked())return;
  if(scopeSelection.value?.selected){
    scopeSelection.value=null;selection.value=new Set(pageRefs.filter(value=>value!==ref));return;
  }
  const next=new Set(selection.value);if(next.has(ref))next.delete(ref);else next.add(ref);selection.value=next;
}
