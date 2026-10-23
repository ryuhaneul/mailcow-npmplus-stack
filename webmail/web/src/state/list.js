import { effect, signal, untracked } from '@preact/signals';
import { api, endSession } from '../api.js';
import { selection, scopeSelection, selectionScopeKey, updateSelectionPage } from './selection.js';
import { interruptScopedAction, resetScopedAction, scopedListFrozen } from './scoped-actions.js';
import { session, authGeneration } from './session.js';
import { folders } from './folders.js';
import { storage } from './storage.js';
import { toast } from './toast.js';
import { route } from '../router.js';

const defaults = {view:'inbox',folder:'',page:1,pageSize:50,quick:'all',q:'',in:''};
export const list = signal({params:defaults,items:[],total:0,loading:false,error:null});
export const cursor = signal(null);
export const acting = signal(false);
export const listLocation = signal('inbox');
export const searchRuleSeed = signal(null);
export const deleteConfirmation = signal(null);
export function isPermanentDelete(folder) {return ['Trash','Junk'].includes(folder);}
export function listDeleteFolder() {return list.value.params.view==='spam'?'Junk':list.value.params.folder;}
export function settleDeleteConfirmation(confirmed=false) {
  const pending=deleteConfirmation.value;
  deleteConfirmation.value=null;
  pending?.resolve(confirmed);
}
export async function deleteMessages(refs, folder) {
  if(acting.value || deleteConfirmation.value || !refs.length)return;
  refs=[...refs];
  if(!isPermanentDelete(folder))return runAction('trash',refs);
  const generation=mailboxGeneration;
  const confirmed=await new Promise(resolve=>{deleteConfirmation.value={refs,resolve};});
  if(confirmed && generation===mailboxGeneration)return runAction('delete-forever',refs);
}
let requestId = 0, controller, mailboxGeneration = 0;
export function isListRoute(value) {return ['inbox','allmail','f','spam','search'].includes(value.name);}
export function paramsForRoute(value) {return {...defaults,view:value.name==='f'?'folder':value.name==='search'?'allmail':value.name,folder:value.name==='f'?value.value:'',q:value.name==='search'?value.value:(value.q||'')};}
function context(value) {return JSON.stringify(value);}
export function notify(error) {
  if (!['NO_SESSION','SESSION_EXPIRED'].includes(error.code))toast.value={kind:'error',message:error.message};
}
export function cancelListLoad() {requestId++;controller?.abort();if(list.value.loading)list.value={...list.value,loading:false};}
export async function loadMessages(patch = {}, {preserveScopeResult=false} = {}) {
  const params={...list.value.params,...patch};
  const scopeChanged=selectionScopeKey(params)!==selectionScopeKey(list.value.params);
  if(!scopeChanged && ['preparing','running','stopping'].includes(scopeSelection.value?.status) && !preserveScopeResult)return;
  if(scopeChanged || (!preserveScopeResult && ['stopped','error','completed'].includes(scopeSelection.value?.status)))resetScopedAction();
  controller?.abort();controller=new AbortController();const id=++requestId;
  const changed=context(params)!==context(list.value.params);
  if(changed){selection.value=new Set();cursor.value=null;}
  list.value={...list.value,params,loading:true,error:null,resultView:'mailbox',...(changed?{items:[],total:0}:{})};
  const query=new URLSearchParams(Object.entries(params).filter(([,value])=>value!==''));
  try {
    const result=await api(`/api/messages?${query}`,{signal:controller.signal});
    if(id!==requestId)return;
    list.value={...list.value,...result,loading:false,resultView:'mailbox'};
    updateSelectionPage(result.items);
    selection.value=new Set([...selection.value].filter(ref=>result.items.some(item=>item.ref===ref)));
    if(!result.items.some(item=>item.ref===cursor.value))cursor.value=result.items[0]?.ref ?? null;
  } catch(error) {
    if(id!==requestId || error.name==='AbortError')return;
    list.value={...list.value,loading:false,error,items:[],total:0};updateSelectionPage([]);selection.value=new Set();notify(error);
  }
}
// Failed rows come from the server's receipt record, never from the original query.
export async function loadFailureMessages(page=1,pageSize=50) {
  const value=scopeSelection.value;
  if(!value?.selectionId)return;
  cancelListLoad();const id=requestId,selectionId=value.selectionId;
  scopeSelection.value={...value,selected:false,failureView:true};
  selection.value=new Set();cursor.value=null;
  list.value={...list.value,items:[],total:0,loading:true,error:null,resultView:'failed'};
  updateSelectionPage([]);
  try {
    const result=await api(`/api/messages/selections/${encodeURIComponent(selectionId)}/failed?page=${page}&pageSize=${pageSize}`);
    if(id!==requestId || scopeSelection.value?.selectionId!==selectionId)return;
    scopeSelection.value={...scopeSelection.value,failurePage:result};
    list.value={...list.value,items:result.items,total:result.total,loading:false};
    updateSelectionPage(result.items);cursor.value=result.items[0]?.ref??null;
    return result;
  } catch(error) {
    if(id!==requestId || scopeSelection.value?.selectionId!==selectionId)return;
    list.value={...list.value,loading:false,error};notify(error);
  }
}
export async function runAction(action, refs = [...selection.value], target) {
  if(acting.value || !refs.length)return;
  acting.value=true;const generation=mailboxGeneration;
  const before=list.value, key=context(before.params), chosen=new Set(refs);
  const optimistic=['seen','unseen','flag','unflag','move'].includes(action);
  if(optimistic)list.value={...before,items:action==='move'?before.items.filter(item=>!chosen.has(item.ref)):before.items.map(item=>chosen.has(item.ref)?{...item,...(['seen','unseen'].includes(action)?{seen:action==='seen'}:{flagged:action==='flag'})}:item)};
  function restore(failed) {
    if(!optimistic || context(list.value.params)!==key)return;
    const failedSet=new Set(failed), old=new Map(before.items.map(item=>[item.ref,item]));
    let items=list.value.items.map(item=>failedSet.has(item.ref)&&old.has(item.ref)?{...item,seen:old.get(item.ref).seen,flagged:old.get(item.ref).flagged}:item);
    if(action==='move')items=[...items,...before.items.filter(item=>failedSet.has(item.ref)&&!items.some(row=>row.ref===item.ref))].sort((a,b)=>b.date.localeCompare(a.date));
    list.value={...list.value,items};
  }
  try {
    const result=await api('/api/messages/actions',{method:'POST',body:{refs,action,...(target===undefined?{}:{target})}});
    if(generation!==mailboxGeneration)return;
    const failed=result.failed.map(item=>item.ref);restore(failed);
    selection.value=new Set([...selection.value].filter(ref=>!chosen.has(ref)||failed.includes(ref)));
    if(failed.length)notify({message:result.failed.every(item=>item.code==='FOLDER_READONLY')?'이 폴더는 변경할 수 없어요.':'일부 메일을 처리하지 못했어요. 다시 시도해 주세요.'});
    if(context(list.value.params)===key)await loadMessages();
    return result;
  } catch(error) {if(generation===mailboxGeneration){restore(refs);notify(error);}}
  finally {if(generation===mailboxGeneration)acting.value=false;}
}
export function connectMailboxEvents() {
  let source, stopped=false;
  function connect() {
    const generation=authGeneration, connection=new EventSource('/api/events');source=connection;
    connection.addEventListener('mailbox',event=>{
      const value=JSON.parse(event.data);
      folders.value={...folders.value,folders:folders.value.folders.map(folder=>folder.path===value.path?{...folder,unseen:value.unseen,total:value.total}:folder)};
      const params=list.value.params;
      if(!scopedListFrozen() && !scopeSelection.value?.failureView && isListRoute(route.value) && (params.view==='allmail'||params.q||(params.view==='inbox'&&value.path==='INBOX')||params.folder===value.path))void loadMessages();
    });
    connection.addEventListener('quota',event=>{const quota=JSON.parse(event.data);storage.value={...storage.value,quota};});
    connection.addEventListener('session',event=>{
      if(stopped||source!==connection||JSON.parse(event.data).state!=='expired')return;
      connection.close();
      if(generation!==authGeneration){if(session.value)connect();return;}
      resetMailbox();endSession('SESSION_EXPIRED');
    });
  }
  connect();
  return ()=>{stopped=true;source.close();};
}

export function resetMailbox() {
  settleDeleteConfirmation();cancelListLoad();resetScopedAction();updateSelectionPage([]);mailboxGeneration++;searchRuleSeed.value=null;listLocation.value='inbox';acting.value=false;selection.value=new Set();cursor.value=null;
  list.value={params:{...defaults},items:[],total:0,loading:false,error:null};
}

// Route changes stop automatic work even when a split-view list stays mounted.
effect(()=>{
  const current=route.value;
  untracked(()=>{
    if(!isListRoute(current))interruptScopedAction();
    else if(scopeSelection.value && selectionScopeKey(paramsForRoute(current))!==scopeSelection.value.scopeKey)resetScopedAction();
  });
});
effect(()=>{if(!session.value)untracked(()=>{if(scopeSelection.value)resetMailbox();});});
