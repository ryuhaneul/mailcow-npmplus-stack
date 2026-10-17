import { createPortal } from 'preact/compat';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { prefs, updateSharedView } from '../state/prefs.js';
import { setSharedViewMode, toggleSharedFolder, setSharedOwnerHidden } from '../state/shared-view.js';
import { route } from '../router.js';
import { radioKeys } from './AppearanceSettings.jsx';
import Icon from './Icon.jsx';

const modes = [['inbox','받은편지함만'],['all','전부'],['custom','직접 고름']];
const notes = {inbox:'받은편지함만 보입니다. 처음 공유받으면 이 방식입니다.',all:'모든 폴더가 보입니다. 나중에 만든 폴더도 자동으로 보입니다.',custom:'고른 폴더만 보입니다. 나중에 생긴 폴더는 숨겨집니다.'};
const icons = {'\\Inbox':'inbox','\\Sent':'send','\\Drafts':'file','\\Archive':'archive','\\Junk':'spam','\\Trash':'trash'};
function folderIcon(folder) { return icons[folder.specialUse] || icons[`\\${folder.path.split('/').at(-1) === 'INBOX' ? 'Inbox' : folder.path.split('/').at(-1)}`] || 'folder'; }
const isInbox = (group, folder) => folder.path === group.inbox?.path;
const checked = (group, folder) => isInbox(group,folder) || group.mode === 'all' || group.mode === 'custom' && (prefs.value.sharedView?.[group.owner]?.folders || []).includes(folder.path);
export const visibleCount = group => group.allFolders.length - group.hiddenFolderCount;
export function SharedModes({ group }) {
  return <div class="seg sp-quick" role="radiogroup" aria-label={`${group.owner} 보기 방식`} onKeyDown={radioKeys}>{modes.map(([mode,label])=><button key={mode} type="button" role="radio" aria-checked={group.mode===mode} aria-pressed={group.mode===mode} tabIndex={group.mode===mode?0:-1} onClick={()=>updateSharedView(setSharedViewMode(prefs.value.sharedView,group.owner,mode))}>{label}</button>)}</div>;
}
export function SharedModeNote({ group, popup=false }) { return <p class={popup?'sp-pnote':'sp-mnote'}>{notes[group.mode]}</p>; }
export function SharedFolderList({ group }) {
  return <ul class="sp-fl" role="group" aria-label={`${group.owner} 공유 폴더`}>{group.allFolders.map(folder=>{
    const fixed=isInbox(group,folder), on=checked(group,folder), depth=folder.path.slice(`Shared/${group.owner}/`.length).split('/').length-1;
    return <li key={folder.path}><label class={`sp-f${fixed?' sp-fixed':''}`} style={{'--d':depth}} title={folder.label}>
      <input class="sr" type="checkbox" checked={on} disabled={fixed} aria-label={`${group.owner} ${folder.label} 읽지 않음 ${folder.unseen || 0}`} onChange={event=>updateSharedView(toggleSharedFolder(prefs.value.sharedView,group.owner,folder.path,event.currentTarget.checked,group.allFolders))}/>
      <span class={`cb${on?' on':''}`} aria-hidden="true"><Icon name="check"/></span><span class="sp-fi"><Icon name={folderIcon(folder)} size="s"/></span><span class="sp-ell">{folder.label.split(' / ').at(-1)}</span>{fixed&&<small class="sp-fx">주소 줄</small>}{folder.unseen>0&&<span class="sp-u num" aria-hidden="true">{folder.unseen}</span>}
    </label></li>;
  })}</ul>;
}
export function SharedHideButton({ group, onHide, popup=false }) {
  return <button class={popup?'sp-plink':'btn sm sp-hide'} type="button" onClick={()=>{onHide?.();updateSharedView(setSharedOwnerHidden(prefs.value.sharedView,group.owner,!group.hidden));}}><Icon name={group.hidden?'eye':'eyeoff'} size="xs"/>{group.hidden?'다시 보이기':'사이드바에서 숨기기'}</button>;
}
function Unread({ value }) { return value>0&&<span class="n u num"><span class="sr">읽지 않음 </span>{value}</span>; }
function Popup({ group, anchor, onClose }) {
  const popup=useRef(null);
  useLayoutEffect(()=>{
    const node=popup.current;
    function position(){
      const r=anchor.current.getBoundingClientRect(),w=Math.min(310,innerWidth-24);
      node.style.width=`${w}px`;node.style.maxHeight=`${innerHeight-24}px`;
      node.style.left=`${Math.max(12,Math.min(innerWidth<761?12:r.right+8,innerWidth-12-w))}px`;
      const top=innerWidth<761?r.bottom+6:r.top-8;
      node.style.top=`${Math.max(12,Math.min(top,innerHeight-12-node.offsetHeight))}px`;
    }
    position();const resize=new ResizeObserver(position);resize.observe(node);node.querySelector('button').focus({preventScroll:true});
    const outside=event=>{if(!node.contains(event.target)&&!anchor.current.contains(event.target)){event.preventDefault();onClose();}};
    const key=event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}
      if(event.key==='Tab'){
        const items=[...node.querySelectorAll('button:not(:disabled):not([tabindex="-1"]),input:not(:disabled),a[href]')];
        if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1).focus();}
        else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0].focus();}
      }
    };
    document.addEventListener('pointerdown',outside);node.addEventListener('keydown',key);window.addEventListener('resize',position);
    return()=>{resize.disconnect();document.removeEventListener('pointerdown',outside);node.removeEventListener('keydown',key);window.removeEventListener('resize',position);};
  },[]);
  return createPortal(<section ref={popup} class="pop sp-popover" role="dialog" aria-label={`${group.owner} 폴더 고르기`}><h5>사이드바에 보일 폴더</h5><div class="sp-ph"><b class="sp-ell" title={group.owner}>{group.owner}</b>{group.isNew&&<span class="sp-new">새로 공유됨 · 기본값</span>}<small class="num">{visibleCount(group)}/{group.allFolders.length}</small></div><SharedModes group={group}/><SharedModeNote group={group} popup/><SharedFolderList group={group}/><div class="sp-pf"><SharedHideButton group={group} popup onHide={onClose}/><a href="#shared" onClick={onClose}>설정에서 전부 보기</a></div></section>,document.body);
}
export default function SharedGroup({ group, preview=false }) {
  const [expanded,setExpanded]=useState(()=>{try{return JSON.parse(localStorage.getItem('webmail-shared-expanded')||'{}')[group.owner]!==false;}catch{return true;}});
  const [open,setOpen]=useState(false),anchor=useRef(null);
  const current=route.value, hasChildren=group.allFolders.some(folder=>!isInbox(group,folder));
  const close=()=>{setOpen(false);anchor.current?.focus({preventScroll:true});};
  function toggle(){const next=!expanded;setExpanded(next);try{const map=JSON.parse(localStorage.getItem('webmail-shared-expanded')||'{}');localStorage.setItem('webmail-shared-expanded',JSON.stringify({...map,[group.owner]:next}));}catch{}}
  const head=<><span class="sh"><Icon name="users"/></span><span class="sp-ell">{group.owner}</span><Unread value={group.unread}/></>;
  return <div class="sp-grp" data-owner={group.owner}>
    <div class={`folder-row sp-orow${open?' sp-pop-on':''}`}>
      {hasChildren?(preview?<span class="sp-tw" aria-hidden="true"><Icon name="down" size="xs"/></span>:<button class="sp-tw" type="button" aria-expanded={expanded} aria-label={`${group.owner} 폴더 ${expanded?'접기':'펼치기'}`} onClick={toggle}><Icon name="right" size="xs"/></button>):<span class="sp-tw"/>}
      {preview||group.inboxMissing?<span class="nv" title={group.owner}>{head}</span>:<a class="nv" href={`#f/${encodeURIComponent(group.inbox.path)}`} title={group.owner} aria-current={current.name==='f'&&current.value===group.inbox.path?'page':undefined}>{head}</a>}
      {!preview&&<button ref={anchor} class="ib sp-more" type="button" aria-label={`${group.owner} 폴더 고르기`} aria-haspopup="dialog" aria-expanded={open} onClick={()=>open?close():setOpen(true)}><Icon name="more" size="s"/></button>}
    </div>
    {(expanded||preview)&&group.folders.map(folder=>{
      const content=<><span class="sp-fi"><Icon name={folderIcon(folder)} size="s"/></span><span class="sp-ell">{folder.label}</span><Unread value={folder.unseen}/></>;
      const props={class:'nv sp-kid',style:{'--d':folder.depth},title:folder.label};
      return preview?<span key={folder.path} {...props}>{content}</span>:<a key={folder.path} {...props} href={`#f/${encodeURIComponent(folder.path)}`} aria-current={current.name==='f'&&current.value===folder.path?'page':undefined}>{content}</a>;
    })}
    {group.inboxMissing&&<p class="sp-hint">숨긴 폴더 {group.hiddenFolderCount}개</p>}
    {group.isNew&&!preview&&<p class="sp-hint">새로 공유됨 — 받은편지함만 보입니다. <button type="button" onClick={()=>setOpen(true)}>⋯ 폴더 고르기</button></p>}
    {open&&!preview&&<Popup group={group} anchor={anchor} onClose={close}/>}
  </div>;
}
