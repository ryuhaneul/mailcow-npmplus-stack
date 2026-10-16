import { folderLabel } from '../format.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { list, cursor, acting, loadMessages, runAction, deleteMessages, listDeleteFolder, isPermanentDelete } from '../state/list.js';
import { selection } from '../state/selection.js';
import { folders } from '../state/folders.js';
import Icon from './Icon.jsx';
import { LayoutPicker } from '../pages/SettingsPage.jsx';
export default function ListTools() {
  const [menu,setMenu]=useState(null),root=useRef(null);
  const value=list.value,n=selection.value.size,disabled=acting.value,deleteLabel=isPermanentDelete(listDeleteFolder())?'영구 삭제':'삭제';
  useEffect(()=>{
    if(!menu)return;
    const close=event=>{if(event.type==='keydown'?event.key==='Escape':!root.current.contains(event.target))setMenu(null);};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close);};
  },[menu]);
  const all=value.items.length>0&&value.items.every(item=>selection.value.has(item.ref));
  const page=value.params.page,limit=value.params.pageSize,start=value.total?(page-1)*limit+1:0;
  function moreAction(action){setMenu(null);runAction(action,cursor.value?[cursor.value]:[]);}
  return <div class={`tools ${n?'bulk':''}`} style="position:relative" ref={root}>
    <button class="cbw" type="button" aria-label={n?'선택 해제':'모두 선택'} disabled={!value.items.length||disabled} onClick={()=>{selection.value=n?new Set():new Set(value.items.map(item=>item.ref));}}><span class={`cb ${all?'on':n?'mixed':''}`}><Icon name="check"/></span></button>
    {n?<><span class="cnt num">{n}통 선택</span>
      <button class="tb" type="button" aria-label="보관" disabled={disabled} onClick={()=>runAction('archive')}><Icon name="archive"/><span class="lbl">보관</span></button>
      <button class="tb" type="button" aria-label="읽음 표시" disabled={disabled} onClick={()=>runAction('seen')}><Icon name="mailopen"/><span class="lbl">읽음 표시</span></button>
      <button class="tb" type="button" aria-label="폴더로 옮기기" aria-expanded={menu==='move'} disabled={disabled} onClick={()=>setMenu(menu==='move'?null:'move')}><Icon name="folder"/><span class="lbl">폴더로 옮기기</span></button><span class="vr"/>
      <button class="tb" type="button" aria-label={value.params.view==='spam'?'스팸 아님':'스팸 신고'} disabled={disabled} onClick={()=>runAction(value.params.view==='spam'?'notspam':'spam')}><Icon name="spam"/><span class="lbl">{value.params.view==='spam'?'스팸 아님':'스팸 신고'}</span></button>
      <button class="tb danger" type="button" aria-label={deleteLabel} disabled={disabled} onClick={()=>deleteMessages([...selection.value],listDeleteFolder())}><Icon name="trash"/><span class="lbl">{deleteLabel}</span></button>
    </>:<><button class="ib" type="button" aria-label="새로 고침" onClick={()=>loadMessages()}><Icon name="refresh"/></button><button class="ib" type="button" aria-label="더 보기" aria-expanded={menu==='more'} disabled={!cursor.value||disabled} onClick={()=>setMenu(menu==='more'?null:'more')}><Icon name="more"/></button></>}
    <div class="pager"><LayoutPicker/><span class="num">{start}–{Math.min(page*limit,value.total)} / {value.total}</span><button class="ib" type="button" aria-label="이전 페이지" disabled={page<=1||value.loading} onClick={()=>loadMessages({page:page-1})}><Icon name="left"/></button><button class="ib" type="button" aria-label="다음 페이지" disabled={page*limit>=value.total||value.loading} onClick={()=>loadMessages({page:page+1})}><Icon name="right"/></button></div>
    {menu&&<div class="pop list-menu" role="menu" aria-label={menu==='move'?'이동할 폴더':'메일 동작'}>{menu==='move'?<><h5>폴더로 옮기기</h5>{folders.value.folders.filter(folder=>!folder.shared&&folder.rights.insert).map(folder=><button class="opt" role="menuitem" type="button" key={folder.path} onClick={()=>{setMenu(null);runAction('move',[...selection.value],folder.path);}}>{folderLabel(folder)}</button>)}</>:<>{[['unseen','읽지 않음 표시'],['flag','별표'],['unflag','별표 해제']].map(([action,label])=><button class="opt" role="menuitem" type="button" key={action} onClick={()=>moreAction(action)}>{label}</button>)}</>}</div>}
  </div>;
}
