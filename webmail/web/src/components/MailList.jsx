import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { folderLabel } from '../format.js';
import { route } from '../router.js';
import { folders } from '../state/folders.js';
import { isPermanentDelete, listDeleteFolder, list, loadMessages, paramsForRoute, cancelListLoad, listLocation, loadFailureMessages } from '../state/list.js';
import MailRow from './MailRow.jsx';
import ListTools from './ListTools.jsx';
import QuickFilter from './QuickFilter.jsx';
import FolderFilter from './FolderFilter.jsx';
import SpamBanner from './SpamBanner.jsx';
import { SearchConditions } from './SearchBar.jsx';
import { scopeSelection } from '../state/selection.js';
import ScopeActionDialog, { ScopeSelectionNotice, ScopeActionResult, ScopeActionAnnouncement, scopeLabel, quickLabels } from './ScopeActionDialog.jsx';
import './select-all.css';
function group(date) {
  const value=new Date(date),today=new Date();today.setHours(0,0,0,0);
  const day=new Date(value);day.setHours(0,0,0,0);const gap=Math.round((today-day)/86400000);
  return gap===0?'오늘':gap===1?'어제':value.toLocaleDateString('ko-KR',{month:'long',day:'numeric'});
}
export default function MailList({currentRoute,reader}) {
  const current=currentRoute || route.value,value=list.value,scoped=scopeSelection.value,failureView=scoped?.failureView,focusedRow=useRef(null);
  useLayoutEffect(()=>{if(focusedRow.current&&document.activeElement===document.body)document.getElementById(`mail-${value.items.some(item=>item.ref===focusedRow.current)?focusedRow.current:value.items[0]?.ref}`)?.focus({preventScroll:true});},[value.items]);
  useEffect(()=>{listLocation.value=current.name+(current.value?'/'+encodeURIComponent(current.value):'')+(current.q?'?q='+encodeURIComponent(current.q):'');void loadMessages(paramsForRoute(current));return cancelListLoad;},[current]);
  const folder=folders.value.folders.find(folder=>folder.path===(current.name==='inbox'?'INBOX':current.value));
  const query=value.params.q,mode=query?'search':current.name;
  return <section class="view mailview" style="display:flex" aria-label="메일"><div class="listcol">
    <div class="head"><div><div class="eyebrow">{mode==='inbox'?'INBOX':mode==='allmail'?'ALL MAIL':mode==='search'?'SEARCH':mode==='spam'?'SPAM':'FOLDER'}</div><h1 id="page-title" tabIndex={-1}>{failureView?'실패한 메일':mode==='search'?'검색 결과':current.name==='f'&&folder?folderLabel(folder):current.title}</h1></div>
      <div class="meta">{!failureView&&mode==='inbox'&&<><b class="num">{folder?.unseen??value.items.filter(item=>!item.seen).length}</b> 읽지 않음 · </>}<span class="num">{!failureView&&mode==='inbox'&&value.params.quick==='all'?(folder?.total??value.total):value.total}</span>통{mode==='allmail'?' · 스팸·휴지통 뺀 모든 폴더':folder?.shared?' · 팀 공유 메일함':''}</div>
      {!failureView&&!['spam','search'].includes(mode)&&<QuickFilter/>}
    </div>
    {query&&<><SearchConditions query={query}/><div class="sa-context"><span>검색 범위 <b>{scopeLabel(value.params)}</b></span>{value.params.quick!=='all'&&<span>빠른 필터 <b>{quickLabels[value.params.quick]}</b></span>}</div></>}
    {!failureView&&current.name==='allmail'&&<FolderFilter/>}
    {value.params.view==='spam'&&<SpamBanner/>}
    <ListTools/>
    <ScopeSelectionNotice/><ScopeActionResult/><ScopeActionAnnouncement/><ScopeActionDialog/>
    <div class="scroll" aria-busy={value.loading}><ul class="list" onFocusCapture={event=>{focusedRow.current=event.target.closest('.m')?.dataset.ref??null;}} onBlurCapture={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget))focusedRow.current=null;}}>{value.loading&&!value.items.length?<li class="grp" role="status">메일을 불러오는 중…</li>:value.error?<li class="grp" role="alert">{value.error.message}{(failureView||value.error.code==='SEARCH_SLOW')&&<> <button class="btn sm" type="button" onClick={()=>void (failureView?loadFailureMessages(scoped.failurePage?.page??1):loadMessages())}>{failureView?'실패 목록 다시 불러오기':'다시 검색'}</button></>}</li>:!value.items.length?<li class="grp">{failureView?'실패한 메일이 없습니다':'이 보기에 맞는 메일이 없습니다'}</li>:value.items.map((item,index)=><Fragment key={item.ref}>{!failureView&&(index===0||group(value.items[index-1].date)!==group(item.date))&&<li class="grp" role="presentation">{group(item.date)}</li>}<MailRow item={item} mode={mode}/></Fragment>)}</ul></div>
    <div class="foot"><span><span class="kbd">J</span><span class="kbd">K</span> 이동</span><span><span class="kbd">E</span> 보관</span><span><span class="kbd">#</span> {isPermanentDelete(listDeleteFolder())?'영구 삭제':'삭제'}</span><span><span class="kbd">?</span> 단축키 전체</span></div>
  </div><div class="readcol">{reader}</div></section>;
}
