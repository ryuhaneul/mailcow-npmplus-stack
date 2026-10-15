import { route, navigate } from './router.js';
import { list, cursor, listLocation, isListRoute, runAction } from './state/list.js';
import { toggleSelection, selection } from './state/selection.js';
// Each screen registers its shortcuts when that screen is implemented.
export function initShortcuts(handle) {
  const onKey = event => {
    if (event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
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
    if(key==='/'){event.preventDefault();document.getElementById('mail-search')?.focus();return;}
    if(key==='u'&&route.value.name==='read'){event.preventDefault();navigate(listLocation.value);return;}
    if(!isListRoute(route.value))return;
    const items=list.value.items,index=items.findIndex(item=>item.ref===cursor.value),item=items[index];
    if(key==='j'||key==='k'){
      event.preventDefault();const next=items[Math.max(0,Math.min(items.length-1,index+(key==='j'?1:-1)))];
      if(next){cursor.value=next.ref;const row=document.getElementById(`mail-${next.ref}`);row?.focus({preventScroll:true});row?.scrollIntoView({block:'nearest'});}return;
    }
    if(key==='enter'&&!event.target.closest('button,a,[role=checkbox]')&&item){event.preventDefault();navigate(`read/${encodeURIComponent(item.ref)}`);}
    else if(key==='x'&&item){event.preventDefault();toggleSelection(item.ref);}
    else if(key==='s'&&item){event.preventDefault();void runAction(item.flagged?'unflag':'flag',[item.ref]);}
    else if(['e','#','!'].includes(key)&&item){event.preventDefault();void runAction(key==='e'?'archive':key==='#'?'trash':list.value.params.view==='spam'?'notspam':'spam',selection.value.size?[...selection.value]:[item.ref]);}
  });
}
