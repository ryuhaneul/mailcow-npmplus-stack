import { folderLabel } from '../format.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { list, cursor, acting, loadMessages, loadFailureMessages, listDeleteFolder, isPermanentDelete } from '../state/list.js';
import { selection, scopeSelection, selectPage, clearSelection, isSelected } from '../state/selection.js';
import { runSelectedAction, deleteSelectedMessages, scopedRequestPending, scopedListFrozen } from '../state/scoped-actions.js';
import { folders } from '../state/folders.js';
import { ScopeActionProgress, scopeNumber } from './ScopeActionDialog.jsx';
import Icon from './Icon.jsx';
import { LayoutPicker } from '../pages/SettingsPage.jsx';
export default function ListTools() {
  const [menu,setMenu]=useState(null),root=useRef(null),opener=useRef(null);
  const value=list.value,scoped=scopeSelection.value,frozen=scopedListFrozen(),pending=acting.value||scopedRequestPending.value;
  const scopedAll=scoped?.selected,n=scopedAll?(scoped.initialTotal??scoped.totalEstimate):selection.value.size,disabled=pending||frozen;
  const deleteLabel=isPermanentDelete(listDeleteFolder())?'영구 삭제':'삭제';
  const selectable=value.items.filter(item=>!item.unavailable&&(!scoped?.failureView||item.retryable));
  const all=selectable.length>0&&selectable.every(item=>isSelected(item.ref));
  function closeMenu(restore=true){setMenu(null);if(restore)requestAnimationFrame(()=>opener.current?.focus());}
  function openMenu(name,event){opener.current=event.currentTarget;setMenu(menu===name?null:name);}
  useEffect(()=>{
    if(!menu)return;
    const close=event=>{if(event.type==='keydown'?event.key==='Escape':!root.current.contains(event.target)){if(event.type==='keydown')event.preventDefault();closeMenu(event.type==='keydown');}};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close);};
  },[menu]);
  useLayoutEffect(()=>{if(menu)root.current.querySelector('[role=menu] button')?.focus();},[menu]);
  function choose(action,target){closeMenu(false);runSelectedAction(action,target,cursor.value?[cursor.value]:[]);if(scopeSelection.value?.status!=='confirming')requestAnimationFrame(()=>opener.current?.focus());}
  if(['preparing','running','stopping'].includes(scoped?.status))return <ScopeActionProgress/>;
  const failurePage=scoped?.failureView?scoped.failurePage:null;
  const page=failurePage?.page??value.params.page,limit=failurePage?.pageSize??value.params.pageSize,start=value.total?(page-1)*limit+1:0;
  const pageDisabled=pending||value.loading||(frozen&&!scoped?.failureView);
  const moreDisabled=disabled||(!n&&(!cursor.value||!selectable.some(item=>item.ref===cursor.value)));
  const turnPage=page=>scoped?.failureView?loadFailureMessages(page,limit):loadMessages({page});
  return <div class={`tools sa-tools ${n?'bulk':''}`} ref={root}>
    <button class="cbw" type="button" aria-label={n?'선택 해제':'모두 선택'} aria-pressed={all?'true':n?'mixed':'false'} disabled={!selectable.length||disabled} onClick={()=>n?clearSelection():selectPage(selectable)}><span class={`cb ${all?'on':n?'mixed':''}`}><Icon name="check"/></span></button>
    {n?<><span class="cnt num">{scopeNumber(n)}통 선택</span>
      <button class="tb" type="button" aria-label="보관" data-sa-action="archive" disabled={disabled} onClick={()=>runSelectedAction('archive')}><Icon name="archive"/><span class="lbl">보관</span></button>
      <button class="tb" type="button" aria-label="읽음 표시" data-sa-action="seen" disabled={disabled} onClick={()=>runSelectedAction('seen')}><Icon name="mailopen"/><span class="lbl">읽음 표시</span></button>
      <button class="tb" type="button" aria-label="폴더로 옮기기" data-sa-action="move" aria-expanded={menu==='move'} disabled={disabled} onClick={event=>openMenu('move',event)}><Icon name="folder"/><span class="lbl">폴더로 옮기기</span></button><span class="vr"/>
      <button class="tb" type="button" aria-label={value.params.view==='spam'?'스팸 아님':'스팸 신고'} data-sa-action={value.params.view==='spam'?'notspam':'spam'} disabled={disabled} onClick={()=>runSelectedAction(value.params.view==='spam'?'notspam':'spam')}><Icon name="spam"/><span class="lbl">{value.params.view==='spam'?'스팸 아님':'스팸 신고'}</span></button>
      <button class="tb danger" type="button" aria-label={deleteLabel} data-sa-action={deleteLabel==='영구 삭제'?'delete-forever':'trash'} disabled={disabled} onClick={()=>deleteSelectedMessages()}><Icon name="trash"/><span class="lbl">{deleteLabel}</span></button>
    </>:<button class="ib" type="button" aria-label="새로 고침" disabled={pending} onClick={()=>loadMessages()}><Icon name="refresh"/></button>}
    <button class="ib" type="button" aria-label="더 보기" aria-expanded={menu==='more'} disabled={moreDisabled} onClick={event=>openMenu('more',event)}><Icon name="more"/></button>
    <div class="pager"><LayoutPicker/><span class="num">{scopeNumber(start)}–{scopeNumber(Math.min(page*limit,value.total))} / {scopeNumber(value.total)}</span><button class="ib" type="button" aria-label="이전 페이지" disabled={page<=1||pageDisabled} onClick={()=>void turnPage(page-1)}><Icon name="left"/></button><button class="ib" type="button" aria-label="다음 페이지" disabled={page*limit>=value.total||pageDisabled} onClick={()=>void turnPage(page+1)}><Icon name="right"/></button></div>
    {menu&&<div class="pop list-menu" role="menu" aria-label={menu==='move'?'이동할 폴더':'메일 동작'}>{menu==='move'?<><h5>폴더로 옮기기</h5>{folders.value.folders.filter(folder=>!folder.shared&&folder.rights.insert).map(folder=><button class="opt" role="menuitem" type="button" key={folder.path} onClick={()=>choose('move',folder.path)}>{folderLabel(folder)}</button>)}</>:<>{[['unseen','읽지 않음 표시'],['flag','별표'],['unflag','별표 해제']].map(([action,label])=><button class="opt" role="menuitem" type="button" data-sa-action={action} key={action} onClick={()=>choose(action)}>{label}</button>)}</>}</div>}
  </div>;
}
