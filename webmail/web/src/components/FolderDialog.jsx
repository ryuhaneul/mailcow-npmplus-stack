import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import { folders, folderColor, folderColorsAfterChange, pinnedFoldersAfterChange, pinnedFolderPaths, visiblePinnedFolders, savePinnedFolders } from '../state/folders.js';
import { prefs, updatePrefs } from '../state/prefs.js';
import { toast } from '../state/toast.js';
import { route, navigate } from '../router.js';
import Icon from './Icon.jsx';
import './dialogs.css';
export const folderDialog = signal(null);
export default function FolderDialog({folder}) {
  const dialog=useRef(null);
  const [name,setName]=useState(folder?.name||'');
  const [busy,setBusy]=useState(false),[deleting,setDeleting]=useState(false),[error,setError]=useState(null);
  const close=()=>{folderDialog.value=null;};
  useEffect(()=>{const element=dialog.current,opener=document.activeElement;element.showModal();return()=>{element.close();opener?.focus();};},[]);
  const pinnedPaths=pinnedFolderPaths(), pinIndex=visiblePinnedFolders().findIndex(item=>item.path===folder?.path);
  const isPinned=folder && pinnedPaths.includes(folder.path);
  function togglePinned(checked) {
    const saved=savePinnedFolders(checked?[...pinnedPaths,folder.path]:pinnedPaths.filter(path=>path!==folder.path));
    if(!saved)toast.value={kind:'error',message:'폴더는 50개까지 고정할 수 있어요.'};
    return saved;
  }
  function movePin(direction) {
    const paths=visiblePinnedFolders().map(item=>item.path), next=pinIndex+direction;
    if(next<0||next>=paths.length)return;
    [paths[pinIndex],paths[next]]=[paths[next],paths[pinIndex]];savePinnedFolders(paths);
  }
  async function submit(event) {
    event.preventDefault();if(busy)return;if(folder&&!deleting&&name===folder.name){close();return;}setBusy(true);setError(null);
    const previousToast=toast.peek();
    try {
      const path=folder?`/api/folders/${encodeURIComponent(folder.path)}`:'/api/folders';
      const result=await api(path,{method:deleting?'DELETE':folder?'PATCH':'POST',...(deleting?{}:{body:{name}})});
      const change=folder?{from:folder.path,to:result?.folder?.path,deleted:deleting}:{created:result.folder.path};
      updatePrefs({folderColors:folderColorsAfterChange(change),pinnedFolders:pinnedFoldersAfterChange(change)});
      folders.value=await api('/api/folders');
      if(folder && route.value.name==='f' && route.value.value===folder.path)navigate(deleting?'inbox':`f/${encodeURIComponent(result.folder.path)}`);
      if(toast.peek()?.kind!=='error'||toast.peek()===previousToast)toast.value={kind:'success',message:deleting?'폴더를 지웠어요.':folder?'폴더 이름을 바꿨어요.':'폴더를 만들었어요.'};
      close();
    } catch(failure){setError(failure);setBusy(false);}
  }
  const text=error?.code==='FOLDER_NOT_EMPTY'?'메일이 있는 폴더는 지울 수 없어요. 먼저 메일을 옮기거나 비워 주세요.':error?.code==='FOLDER_IN_RULES'?`이 폴더를 쓰는 필터가 ${error.rules?.length||0}개 있어요. 필터에서 폴더를 바꾼 뒤 지워 주세요.`:error?.code==='RULES_LOCKED'?'필터가 정상 상태가 아니라 지금은 이름을 바꿀 수 없어요. 필터 화면을 확인해 주세요.':error?.message||'요청을 처리하지 못했어요.';
  return <dialog class="common-dialog" ref={dialog} aria-labelledby="folder-title" onCancel={event=>{event.preventDefault();if(!busy)close();}}><form class="dlg folder-settings" onSubmit={submit} aria-busy={busy}>
    <h2 id="folder-title">{deleting?`‘${folder.name}’ 폴더를 지울까요?`:folder?'폴더 관리':'폴더 만들기'}</h2>
    {deleting?<p>빈 폴더만 지울 수 있어요.</p>:<>{folder&&<h3>이 폴더</h3>}<div class="field"><label for="folder-name">폴더 이름</label><input class="inp" id="folder-name" value={name} required maxLength="100" autoFocus autoComplete="off" disabled={busy} onInput={event=>setName(event.currentTarget.value)}/></div>{folder&&<><p class="note">이름을 바꾸면 이 폴더를 쓰는 필터 경로도 함께 바뀝니다.</p><div class="field"><label id="folder-color-label">폴더 색</label><div class="sws" role="group" aria-labelledby="folder-color-label">{Array.from({length:8},(_,i)=><button class={`swb c${i}`} type="button" aria-label={`폴더 색 ${i+1}`} aria-pressed={folderColor(folder)===i} style={{background:'var(--c-bg)',color:'var(--c-ink)'}} onClick={()=>updatePrefs({folderColors:{...prefs.value.folderColors,[folder.path]:i}})}><Icon name="check"/></button>)}</div></div><div class="field pin-settings"><label class="pin-check"><input type="checkbox" checked={isPinned} disabled={busy} onChange={event=>{if(!togglePinned(event.currentTarget.checked))event.currentTarget.checked=isPinned;}}/>상단 고정</label>{isPinned&&<div class="pin-order" role="group" aria-label="고정 폴더 순서"><button class="btn ghost" type="button" disabled={busy||pinIndex<=0} onClick={()=>movePin(-1)}>위로</button><button class="btn ghost" type="button" disabled={busy||pinIndex<0||pinIndex===visiblePinnedFolders().length-1} onClick={()=>movePin(1)}>아래로</button></div>}</div><hr/><h3>사이드바 공통 설정</h3><div class="field"><label for="pin-position">고정 폴더 위치</label><select class="inp" id="pin-position" value={prefs.value.pinPosition||'mine'} disabled={busy} onChange={event=>updatePrefs({pinPosition:event.currentTarget.value})}><option value="mine">내 폴더 위</option><option value="inbox">받은편지함 위</option></select><p class="note">모든 고정 폴더에 적용</p></div></>}</>}
    {error&&<div class="field-err" role="alert">{text} {['FOLDER_IN_RULES','RULES_LOCKED'].includes(error.code)&&<a href="#filters" onClick={close}>필터 화면으로</a>}</div>}
    <div class="dialog-actions"><div>{folder&&!deleting&&<button class="btn ghost" type="button" disabled={busy} onClick={()=>{setDeleting(true);setError(null);}}>폴더 지우기</button>}</div><div><button class="btn ghost" type="button" disabled={busy} onClick={deleting?()=>{setDeleting(false);setError(null);}:close}>취소</button><button class={`btn ${deleting?'dan':'pri'}`} type="submit" disabled={busy||!deleting&&(!name.trim())}>{busy?'처리 중…':deleting?'폴더 지우기':folder?'이름 바꾸기':'만들기'}</button></div></div>
  </form></dialog>;
}
