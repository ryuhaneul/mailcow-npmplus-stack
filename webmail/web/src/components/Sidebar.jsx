import { useRef } from 'preact/hooks';
import { toast } from '../state/toast.js';
import { Fragment } from 'preact';
import { prefs } from '../state/prefs.js';
import { sharedViewGroups } from '../state/shared-view.js';
import SharedGroup from './SharedGroup.jsx';
import { logout } from '../api.js';
import { folderDialog } from './FolderDialog.jsx';
import { folders, folderColor, pinnedFolderPaths, visiblePinnedFolders, savePinnedFolders } from '../state/folders.js';
import { route } from '../router.js';
import Brand from './Brand.jsx';
import Icon from './Icon.jsx';
import QuotaMeter from './QuotaMeter.jsx';
import { formatSidebarUnread } from '../format.js';

const special = [
  ['\\Inbox','받은편지함','inbox','inbox'],['\\Sent','보낸편지함','send','f'],['\\Drafts','임시보관함','file','f'],['\\Archive','보관함','archive','f'],['\\Junk','스팸','spam','spam'],['\\Trash','휴지통','trash','f'],
];
function NavItem({ href, title, icon, folder, pinned, mark }) {
  const current = route.value;
  const active = href === `#${current.name}` || current.name === 'f' && folder?.path === current.value;
  return <a href={href} class="nv" title={folder?.shared ? title : pinned ? folder.path : undefined} aria-current={active ? 'page' : undefined}>
    {folder?.shared ? <span class="sh"><Icon name="users"/></span> : icon ? <Icon name={icon} size="s"/> : <span class={`dot c${folderColor(folder)}`}/>}
    <span class="nv-title">{pinned ? <><span class="fpn">{folder.path.split('/').at(-1)}</span>{folder.path.includes('/') && <span class="fpp">{folder.path.slice(0, folder.path.lastIndexOf('/'))}</span>}</> : title}</span>{mark && <span class="pin-mark" role="img" aria-label="고정됨"><Icon name="pin" size="xs"/></span>}{folder?.unseen > 0 && <span class="n u num"><span class="sr">읽지 않음 </span>{formatSidebarUnread(folder.unseen)}</span>}
  </a>;
}
export default function Sidebar() {
  const dragging = useRef(null);
  const rows = folders.value.folders;
  const pins = visiblePinnedFolders(), pinnedPaths = pinnedFolderPaths();
  function togglePin(folder, inPinnedGroup) {
    const wasPinned = pinnedPaths.includes(folder.path);
    if (!savePinnedFolders(wasPinned ? pinnedPaths.filter(path => path !== folder.path) : [...pinnedPaths, folder.path])) {
      toast.value = {kind:'error', message:'폴더는 50개까지 고정할 수 있어요.'};
    }
    if (inPinnedGroup && wasPinned) requestAnimationFrame(() => {
      document.getElementById(`folder-pin-${encodeURIComponent(folder.path)}`)?.focus();
    });
  }
  function pinButton(folder, inPinnedGroup = false) {
    const on = pinnedPaths.includes(folder.path), label = on ? '고정 해제' : '상단 고정';
    return <button id={inPinnedGroup ? undefined : `folder-pin-${encodeURIComponent(folder.path)}`} class="ib folder-pin" type="button" title={label} aria-label={`${folder.name} ${label}`} aria-pressed={on} onClick={() => togglePin(folder, inPinnedGroup)}><Icon name="pin" size="s"/><span class="pin-tip" aria-hidden="true">{label}</span></button>;
  }
  const pinnedGroup = pins.length > 0 && <section class="pinned-folders" aria-label="고정 폴더"><h3 class="pin-heading">고정 <span class="num">{pins.length}</span></h3>{pins.map(folder => <div class="folder-row pinned-row" key={folder.path} data-path={folder.path} draggable onDragStart={event => {dragging.current=folder.path;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',folder.path);event.currentTarget.classList.add('drag');}} onDragOver={event => {if(dragging.current && dragging.current!==folder.path){event.preventDefault();event.currentTarget.classList.add('over');}}} onDragLeave={event=>event.currentTarget.classList.remove('over')} onDrop={event => {
    event.preventDefault();event.currentTarget.classList.remove('over');
    const source=dragging.current;dragging.current=null;
    if(!source || source===folder.path || !pins.some(item=>item.path===source))return;
    const next=pins.map(item=>item.path).filter(path=>path!==source);next.splice(next.indexOf(folder.path),0,source);savePinnedFolders(next);
  }} onDragEnd={event=>{dragging.current=null;event.currentTarget.classList.remove('drag');document.querySelectorAll('.pinned-row.over').forEach(row=>row.classList.remove('over'));}}><span class="pin-grip" aria-hidden="true"><Icon name="grip" size="xs"/></span><NavItem href={`#f/${encodeURIComponent(folder.path)}`} title={folder.name} folder={folder} pinned/>{pinButton(folder,true)}<button class="ib pin-manage" type="button" aria-label={`${folder.name} 폴더 관리`} onClick={()=>{folderDialog.value={folder};}}><Icon name="more" size="s"/></button></div>)}</section>;
  const privateRows = rows.filter(folder => !folder.specialUse && !folder.shared);
  const {groups,hiddenOwnerCount} = sharedViewGroups(rows,prefs.value.sharedView);
  return <>
    <Brand/>
    <a class="compose-btn" href="#compose"><Icon name="pen" size="s"/>메일 쓰기<span class="kbd">C</span></a>
    <nav class="nav" aria-label="폴더">
      {prefs.value.pinPosition === 'inbox' && pinnedGroup}
      {special.map(([kind,title,icon,target],index) => {
        const folder = rows.find(folder => folder.specialUse === kind && !folder.shared);
        return <Fragment key={kind}>
          {folder && <NavItem key={kind} href={target === 'f' ? `#f/${encodeURIComponent(folder.path)}` : `#${target}`} title={title} icon={icon} folder={folder}/>}
          {index === 0 && folders.value.virtualAllMail && <NavItem href="#allmail" title="전체편지함" icon="layers"/>}
        </Fragment>;
      })}
      {prefs.value.pinPosition !== 'inbox' && pinnedGroup}
      <h3>내 폴더 <button type="button" aria-label="폴더 만들기" onClick={()=>{folderDialog.value={folder:null};}}><Icon name="plus" size="xs"/></button></h3>
      {privateRows.map(folder=><div class="folder-row" key={folder.path}><NavItem href={`#f/${encodeURIComponent(folder.path)}`} title={folder.name} folder={folder} mark={pinnedPaths.includes(folder.path)}/>{pinButton(folder)}<button class="ib" type="button" aria-label={`${folder.name} 폴더 관리`} onClick={()=>{folderDialog.value={folder};}}><Icon name="more" size="s"/></button></div>)}
      {groups.length > 0 && <div id="sp-shared"><h3>팀·공유 메일함</h3>{groups.filter(group=>!group.hidden).map(group=><SharedGroup key={group.owner} group={group}/>)}{hiddenOwnerCount>0&&<a class="sp-hidden" href="#shared">숨긴 사람 {hiddenOwnerCount}명 · 설정에서 보기</a>}</div>}
      <h3>설정</h3>
      {[['shared','공유 메일함','users'],['filters','필터·규칙','funnel'],['storage','저장 공간','db'],['password','암호 변경','key'],['settings','보기 설정','palette']].map(([path,title,icon]) => <NavItem key={path} href={`#${path}`} title={title} icon={icon}/>)}
    </nav>
    <QuotaMeter/>
    <a class="nv mobile-logout" href="#inbox" onClick={event=>{event.preventDefault();logout();}}>로그아웃</a>
  </>;
}
