import { route, navigate } from './router.js';
import { list, cursor, listLocation, isListRoute, runAction, acting } from './state/list.js';
import { toggleSelection, selectionMode } from './state/selection.js';
import { runSelectedAction, deleteSelectedMessages, scopedRequestPending, scopedListFrozen } from './state/scoped-actions.js';
import { openMessage } from './state/compose.js';
const scopes = new Map();
// Example: registerShortcuts('read', { r: reply, a: replyAll, f: forward }).
// Compose may register 'Ctrl+Enter' and 'Ctrl+Shift+H', including inside inputs.
export function registerShortcuts(scope, handlers) {
  scopes.set(scope, handlers);
  return () => { if (scopes.get(scope) === handlers) scopes.delete(scope); };
}
function registeredShortcut(event, editing) {
  const key = event.ctrlKey && event.key === 'Enter' ? 'Ctrl+Enter' : event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'h' ? 'Ctrl+Shift+H' : event.key.toLowerCase();
  if (editing && !(route.value.name === 'compose' && ['Ctrl+Enter','Ctrl+Shift+H'].includes(key))) return false;
  if ((event.ctrlKey || event.metaKey || event.altKey) && !['Ctrl+Enter','Ctrl+Shift+H'].includes(key)) return false;
  const handler = scopes.get(route.value.name)?.[key];
  if (!handler) return false;
  event.preventDefault(); handler(event); return true;
}
export function initShortcuts(handle) {
  const onKey = event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector('dialog[open],.sp-popover[role=dialog]')) return;
    const editing = Boolean(event.target.closest('input,textarea,select,[contenteditable]'));
    if (registeredShortcut(event, editing) || editing) return;
    handle?.(event);
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

export function initMailboxShortcuts() {
  let go=false;
  return initShortcuts(event=>{
    if(event.ctrlKey||event.altKey||event.metaKey)return;
    const key=event.key.toLowerCase();
    if(go){go=false;if(key==='i'){event.preventDefault();navigate('inbox');return;}if(key==='s'){event.preventDefault();navigate('settings');return;}}
    if(key==='g'){go=true;return;}
    if(key==='?'){event.preventDefault();navigate('keys');return;}
    if(key==='c'){event.preventDefault();navigate('compose');return;}
    if(key==='/'){event.preventDefault();document.getElementById('mail-search')?.focus();return;}
    if(key==='u'&&route.value.name==='read'){event.preventDefault();navigate(listLocation.value);return;}
    if(!isListRoute(route.value))return;
    const items=list.value.items,index=items.findIndex(item=>item.ref===cursor.value),item=items[index];
    const selectable=item&&!item.unavailable&&item.retryable!==false,locked=acting.value||scopedRequestPending.value||scopedListFrozen();
    if(key==='j'||key==='k'){
      event.preventDefault();const next=items[Math.max(0,Math.min(items.length-1,index+(key==='j'?1:-1)))];
      if(next){cursor.value=next.ref;const row=document.getElementById(`mail-${next.ref}`);row?.focus({preventScroll:true});row?.scrollIntoView({block:'nearest'});}return;
    }
    if(key==='enter'&&!event.target.closest('button,a,[role=checkbox]')&&item&&!item.unavailable){event.preventDefault();openMessage(item);}
    else if(key==='x'&&selectable&&!locked){event.preventDefault();toggleSelection(item.ref);}
    else if(key==='s'&&selectable&&!locked){event.preventDefault();void runAction(item.flagged?'unflag':'flag',[item.ref]);}
    else if(['e','#','!'].includes(key)&&(selectable||selectionMode.value!=='none')&&!locked){event.preventDefault();const fallback=selectable?[item.ref]:[];void (key==='#'?deleteSelectedMessages(fallback):runSelectedAction(key==='e'?'archive':list.value.params.view==='spam'?'notspam':'spam',undefined,fallback));}
  });
}
