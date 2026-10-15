import { useEffect, useState } from 'preact/hooks';
import { route, navigate } from '../router.js';
import { folders } from '../state/folders.js';
import { parseSearch } from '../search.js';
import { searchRuleSeed } from '../state/list.js';
import Icon from './Icon.jsx';
export default function SearchBar() {
  const current=route.value;
  const activeQuery=current.name==='search'?current.value:(current.q||'');
  const [query,setQuery]=useState(activeQuery);
  useEffect(()=>{setQuery(activeQuery);},[current]);
  const scoped=current.name==='spam'||current.name==='f'&&folders.value.folders.some(folder=>folder.path===current.value&&folder.specialUse==='\\Trash');
  const waitingForFolder=current.name==='f'&&!folders.value.virtualAllMail;
  const base=current.name==='f'?`f/${encodeURIComponent(current.value)}`:'spam';
  function submit(event) {
    event.preventDefault();if(waitingForFolder)return;const text=query.trim();
    navigate(scoped?base+(text?'?q='+encodeURIComponent(text):''):text?`search/${encodeURIComponent(text)}`:'inbox');
  }
  return <form class="search" role="search" onSubmit={submit}><Icon name="search" size="s"/><input id="mail-search" disabled={waitingForFolder} placeholder="메일 검색 — 예: 보낸사람:partner 견적" aria-label="메일 검색" enterKeyHint="search" value={query} onInput={event=>setQuery(event.currentTarget.value)}/>{current.q&&<button class="ib" type="button" aria-label="검색 지우기" onClick={()=>{setQuery('');navigate(base);}}><Icon name="x" size="s"/></button>}<span class="kbd">/</span></form>;
}
export function SearchConditions({query}) {
  let parsed;try{parsed=parseSearch(query);}catch{return null;}
  return <div class="sbar"><div class="sconds">검색 조건{parsed.chips.map((chip,index)=><span class="q" key={index}><span>{chip.label}</span>{chip.value}</span>)}</div><button class="btn" type="button" onClick={()=>{searchRuleSeed.value={conditions:parsed.conditions,sourceQuery:query};navigate('rule');}}><Icon name="funnel" size="s"/>이 검색 조건으로 규칙 만들기</button>{parsed.textTerms.length>0&&<span class="note">본문 검색어는 규칙 조건으로 옮기지 않아요.</span>}</div>;
}
