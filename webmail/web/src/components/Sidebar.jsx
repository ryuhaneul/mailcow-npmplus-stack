import { Fragment } from 'preact';
import { folderLabel } from '../format.js';
import { logout } from '../api.js';
import { folderDialog } from './FolderDialog.jsx';
import { folders, folderColor } from '../state/folders.js';
import { route } from '../router.js';
import Brand from './Brand.jsx';
import Icon from './Icon.jsx';
import QuotaMeter from './QuotaMeter.jsx';

const special = [
  ['\\Inbox','받은편지함','inbox','inbox'],['\\Sent','보낸편지함','send','f'],['\\Drafts','임시보관함','file','f'],['\\Archive','보관함','archive','f'],['\\Junk','스팸','spam','spam'],['\\Trash','휴지통','trash','f'],
];
function NavItem({ href, title, icon, folder }) {
  const current = route.value;
  const active = href === `#${current.name}` || current.name === 'f' && folder?.path === current.value;
  return <a href={href} class="nv" title={folder?.shared ? title : undefined} aria-current={active ? 'page' : undefined}>
    {folder?.shared ? <span class="sh"><Icon name="users"/></span> : icon ? <Icon name={icon} size="s"/> : <span class={`dot c${folderColor(folder)}`}/>}
    {folder?.shared ? <span style={{minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{title}</span> : title}{folder?.unseen > 0 && <span class="n u num">{folder.unseen}</span>}
  </a>;
}
export default function Sidebar() {
  const rows = folders.value.folders;
  const privateRows = rows.filter(folder => !folder.specialUse && !folder.shared);
  const sharedRows = rows.filter(folder => folder.shared);
  return <>
    <Brand/>
    <a class="compose-btn" href="#compose"><Icon name="pen" size="s"/>메일 쓰기<span class="kbd">C</span></a>
    <nav class="nav" aria-label="폴더">
      {special.map(([kind,title,icon,target],index) => {
        const folder = rows.find(folder => folder.specialUse === kind && !folder.shared);
        return <Fragment key={kind}>
          {folder && <NavItem key={kind} href={target === 'f' ? `#f/${encodeURIComponent(folder.path)}` : `#${target}`} title={title} icon={icon} folder={folder}/>}
          {index === 0 && folders.value.virtualAllMail && <NavItem href="#allmail" title="전체편지함" icon="layers"/>}
        </Fragment>;
      })}
      <h3>내 폴더 <button type="button" aria-label="폴더 만들기" onClick={()=>{folderDialog.value={folder:null};}}><Icon name="plus" size="xs"/></button></h3>
      {privateRows.map(folder=><div class="folder-row" key={folder.path}><NavItem href={`#f/${encodeURIComponent(folder.path)}`} title={folder.name} folder={folder}/><button class="ib" type="button" aria-label={`${folder.name} 폴더 관리`} onClick={()=>{folderDialog.value={folder};}}><Icon name="more" size="s"/></button></div>)}
      {sharedRows.length > 0 && <><h3>팀·공유 메일함</h3>{sharedRows.map(folder => <NavItem key={folder.path} href={`#f/${encodeURIComponent(folder.path)}`} title={folderLabel(folder)} folder={folder}/>)}</>}
      <h3>설정</h3>
      {[['filters','필터·규칙','funnel'],['storage','저장 공간','db'],['password','암호 변경','key'],['settings','보기 설정','palette']].map(([path,title,icon]) => <NavItem key={path} href={`#${path}`} title={title} icon={icon}/>)}
    </nav>
    <QuotaMeter/>
    <a class="nv mobile-logout" href="#inbox" onClick={event=>{event.preventDefault();logout();}}>로그아웃</a>
  </>;
}
