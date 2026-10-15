import { Fragment } from 'preact';
import { useEffect } from 'preact/hooks';
import { folderLabel } from '../format.js';
import { route } from '../router.js';
import { folders } from '../state/folders.js';
import { list, loadMessages, paramsForRoute, cancelListLoad, listLocation } from '../state/list.js';
import MailRow from './MailRow.jsx';
import ListTools from './ListTools.jsx';
import QuickFilter from './QuickFilter.jsx';
import FolderFilter from './FolderFilter.jsx';
import SpamBanner from './SpamBanner.jsx';
import { SearchConditions } from './SearchBar.jsx';
function group(date) {
  const value=new Date(date),today=new Date();today.setHours(0,0,0,0);
  const day=new Date(value);day.setHours(0,0,0,0);const gap=Math.round((today-day)/86400000);
  return gap===0?'오늘':gap===1?'어제':value.toLocaleDateString('ko-KR',{month:'long',day:'numeric'});
}
export default function MailList() {
  const current=route.value,value=list.value;
  useEffect(()=>{listLocation.value=current.name+(current.value?'/'+encodeURIComponent(current.value):'')+(current.q?'?q='+encodeURIComponent(current.q):'');void loadMessages(paramsForRoute(current));return cancelListLoad;},[current]);
  const folder=folders.value.folders.find(folder=>folder.path===(current.name==='inbox'?'INBOX':current.value));
  const query=value.params.q,mode=query?'search':current.name;
  return <section class="view mailview" style="display:flex" aria-label="메일"><div class="listcol">
    <div class="head"><div><div class="eyebrow">{mode==='inbox'?'INBOX':mode==='allmail'?'ALL MAIL':mode==='search'?'SEARCH':mode==='spam'?'SPAM':'FOLDER'}</div><h1 id="page-title">{mode==='search'?'검색 결과':current.name==='f'&&folder?folderLabel(folder):current.title}</h1></div>
      <div class="meta">{mode==='inbox'&&<><b class="num">{folder?.unseen??value.items.filter(item=>!item.seen).length}</b> 읽지 않음 · </>}<span class="num">{mode==='inbox'&&value.params.quick==='all'?(folder?.total??value.total):value.total}</span>통{mode==='allmail'?' · 스팸·휴지통 뺀 모든 폴더':folder?.shared?' · 팀 공유 메일함':''}</div>
      {!['spam','search'].includes(mode)&&<QuickFilter/>}
    </div>
    {query&&<SearchConditions query={query}/>}
    {current.name==='allmail'&&<FolderFilter/>}
    {value.params.view==='spam'&&<SpamBanner/>}
    <ListTools/>
    <div class="scroll" aria-busy={value.loading}><ul class="list">{value.loading&&!value.items.length?<li class="grp" role="status">메일을 불러오는 중…</li>:value.error?<li class="grp" role="alert">{value.error.message}</li>:!value.items.length?<li class="grp">이 보기에 맞는 메일이 없습니다</li>:value.items.map((item,index)=><Fragment key={item.ref}>{(index===0||group(value.items[index-1].date)!==group(item.date))&&<li class="grp" role="presentation">{group(item.date)}</li>}<MailRow item={item} mode={mode}/></Fragment>)}</ul></div>
    <div class="foot"><span><span class="kbd">J</span><span class="kbd">K</span> 이동</span><span><span class="kbd">E</span> 보관</span><span><span class="kbd">#</span> 삭제</span><span><span class="kbd">?</span> 단축키 전체</span></div>
  </div><div class="readcol" aria-hidden="true"/></section>;
}
