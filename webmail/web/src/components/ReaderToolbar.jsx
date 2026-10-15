import { useEffect, useRef, useState } from 'preact/hooks';
import { folders } from '../state/folders.js';
import { folderLabel } from '../format.js';
import { list, acting, listLocation, searchRuleSeed, isPermanentDelete } from '../state/list.js';
import { navigate } from '../router.js';
import { readerRuleSeed } from '../reader.js';
import Icon from './Icon.jsx';
export default function ReaderToolbar({message,action,step,flagged}) {
  const [menu,setMenu]=useState(null),root=useRef(null),index=list.value.items.findIndex(item=>item.ref===message.ref),disabled=acting.value;
  useEffect(()=>{
    if(!menu)return;
    const close=event=>{if(event.type==='keydown'?event.key==='Escape':!root.current.contains(event.target))setMenu(null);};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close);};
  },[menu]);
  const button=(label,icon,handler,extra='')=><button class={`ib ${extra}`} type="button" aria-label={label} title={label} disabled={disabled} onClick={handler}><Icon name={icon}/></button>;
  return <div class="rbar reader-tools" role="toolbar" aria-label="메일 도구" ref={root}>
    <a class="back" href={`#${listLocation.value}`} aria-label="목록"><Icon name="left"/><span class="t">목록</span></a>
    {button('보관','archive',()=>action('archive'))}
    {message.spam?<button class="btn sm" type="button" disabled={disabled} onClick={()=>action('notspam')}><Icon name="check"/>스팸 아님</button>:button('스팸 신고','spam',()=>action('spam'))}
    {button(isPermanentDelete(message.folder)?'영구 삭제':'삭제','trash',()=>action('trash'))}<span class="vr hide-m"/>
    {button('읽지 않음으로','mail',()=>action('unseen'),'hide-m')}
    <button class="ib hide-m" type="button" aria-label="폴더로 옮기기" title="라벨 · 폴더로 옮기기" aria-expanded={menu==='move'} disabled={disabled} onClick={()=>setMenu(menu==='move'?null:'move')}><Icon name="folder"/></button>
    <button class="ib" type="button" aria-label="더 보기" aria-expanded={menu==='more'} disabled={disabled} onClick={()=>setMenu(menu==='more'?null:'more')}><Icon name="more"/></button>
    {!message.spam&&<button class="auto-btn" type="button" title="이 메일로 규칙 만들기" onClick={()=>{searchRuleSeed.value=readerRuleSeed(message);navigate('rule');}}><Icon name="funnel"/><span class="t">이 메일로 규칙 만들기</span></button>}
    <div class="pos"><span class="num">{index>=0?`${index+1} / ${list.value.total}`:''}</span><button class="ib" type="button" aria-label="이전 메일" disabled={index<=0||disabled} onClick={()=>step(-1)}><Icon name="up"/></button><button class="ib" type="button" aria-label="다음 메일" disabled={index<0||index>=list.value.items.length-1||disabled} onClick={()=>step(1)}><Icon name="down"/></button></div>
    {menu&&<div class="pop list-menu" role="menu" aria-label={menu==='move'?'이동할 폴더':'메일 동작'}>{menu==='move'?<><h5>폴더로 옮기기</h5>{folders.value.folders.filter(folder=>!folder.shared&&folder.rights.insert).map(folder=><button class="opt" role="menuitem" type="button" key={folder.path} onClick={()=>{setMenu(null);action('move',folder.path);}}>{folderLabel(folder)}</button>)}</>:<>{[[flagged?'unflag':'flag',flagged?'별표 해제':'별표'],['unseen','읽지 않음으로'],['move','폴더로 옮기기']].map(([value,label])=><button class="opt" role="menuitem" type="button" key={value} onClick={()=>{setMenu(value==='move'?'move':null);if(value!=='move')action(value);}}>{label}</button>)}</>}</div>}
  </div>;
}
