import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import { folders } from '../state/folders.js';
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
  async function submit(event) {
    event.preventDefault();if(busy)return;setBusy(true);setError(null);
    try {
      const path=folder?`/api/folders/${encodeURIComponent(folder.path)}`:'/api/folders';
      const result=await api(path,{method:deleting?'DELETE':folder?'PATCH':'POST',...(deleting?{}:{body:{name}})});
      folders.value=await api('/api/folders');
      if(folder && route.value.name==='f' && route.value.value===folder.path)navigate(deleting?'inbox':`f/${encodeURIComponent(result.folder.path)}`);
      toast.value={kind:'success',message:deleting?'폴더를 지웠어요.':folder?'폴더 이름을 바꿨어요.':'폴더를 만들었어요.'};close();
    } catch(failure){setError(failure);setBusy(false);}
  }
  const text=error?.code==='FOLDER_NOT_EMPTY'?'메일이 있는 폴더는 지울 수 없어요. 먼저 메일을 옮기거나 비워 주세요.':error?.code==='FOLDER_IN_RULES'?`이 폴더를 쓰는 필터가 ${error.rules?.length||0}개 있어요. 필터에서 폴더를 바꾼 뒤 지워 주세요.`:error?.code==='RULES_LOCKED'?'필터가 정상 상태가 아니라 지금은 이름을 바꿀 수 없어요. 필터 화면을 확인해 주세요.':error?.message||'요청을 처리하지 못했어요.';
  return <dialog class="common-dialog" ref={dialog} aria-labelledby="folder-title" onCancel={event=>{event.preventDefault();if(!busy)close();}}><form class="dlg" onSubmit={submit} aria-busy={busy}>
    <h2 id="folder-title">{deleting?`‘${folder.name}’ 폴더를 지울까요?`:folder?'폴더 관리':'폴더 만들기'}</h2>
    {deleting?<p>빈 폴더만 지울 수 있어요.</p>:<><div class="field"><label for="folder-name">폴더 이름</label><input class="inp" id="folder-name" value={name} required maxLength="100" autoFocus autoComplete="off" disabled={busy} onInput={event=>setName(event.currentTarget.value)}/></div>{folder&&<><p class="note">이름을 바꾸면 이 폴더를 쓰는 필터 경로도 함께 바뀝니다.</p><div class="field"><label id="folder-color-label">폴더 색</label><div class="sws" role="group" aria-labelledby="folder-color-label">{Array.from({length:8},(_,i)=><button class={`swb c${i}`} type="button" aria-label={`폴더 색 ${i+1}`} aria-pressed={(prefs.value.folderColors[folder.path]??folder.color??0)===i} style={{background:'var(--c-bg)',color:'var(--c-ink)'}} onClick={()=>updatePrefs({folderColors:{...prefs.value.folderColors,[folder.path]:i}})}><Icon name="check"/></button>)}</div></div></>}</>}
    {error&&<div class="field-err" role="alert">{text} {['FOLDER_IN_RULES','RULES_LOCKED'].includes(error.code)&&<a href="#filters" onClick={close}>필터 화면으로</a>}</div>}
    <div class="dialog-actions"><div>{folder&&!deleting&&<button class="btn ghost" type="button" disabled={busy} onClick={()=>{setDeleting(true);setError(null);}}>폴더 지우기</button>}</div><div><button class="btn ghost" type="button" disabled={busy} onClick={deleting?()=>{setDeleting(false);setError(null);}:close}>취소</button><button class={`btn ${deleting?'dan':'pri'}`} type="submit" disabled={busy||!deleting&&(!name.trim()||folder&&name===folder.name)}>{busy?'처리 중…':deleting?'폴더 지우기':folder?'이름 바꾸기':'만들기'}</button></div></div>
  </form></dialog>;
}
