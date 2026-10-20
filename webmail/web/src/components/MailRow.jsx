import { folderLabel } from '../format.js';
import { cursor, runAction, acting } from '../state/list.js';
import { selection, toggleSelection } from '../state/selection.js';
import { folders, folderColor } from '../state/folders.js';
import { navigate } from '../router.js';
import Icon from './Icon.jsx';
export function FolderTag({item}) {
  const folder=folders.value.folders.find(value=>value.path===item.folder);
  const color=folderColor(folder);
  return color!==null?<span class={`chip c${color}`}>{folderLabel(folder)}</span>:<span class="ftag"><Icon name={folder?.shared?'users':({INBOX:'inbox',Sent:'send',Archive:'archive',Drafts:'file',Junk:'spam',Trash:'trash'}[item.folder]||'folder')} size="xs"/>{folder?folderLabel(folder):item.folderName}</span>;
}
export default function MailRow({item,mode}) {
  const date=new Date(item.date),pad=value=>String(value).padStart(2,'0');
  const selected=selection.value.has(item.ref),from=item.from.name||item.from.address;
  const toggle=event=>{event.stopPropagation();cursor.value=item.ref;toggleSelection(item.ref);};
  return <li id={`mail-${item.ref}`} class={`m ${!item.seen?'u':''} ${selected?'sel':''} ${cursor.value===item.ref?'cur':''}`} data-ref={item.ref} tabIndex="0" aria-label={`${from}, ${item.subject}`} onFocus={()=>{cursor.value=item.ref;}} onClick={()=>navigate(`read/${encodeURIComponent(item.ref)}`)}>
    <button class="av" type="button" role="checkbox" aria-checked={selected} aria-label={`선택: ${item.subject}`} onClick={toggle}>{selected?<Icon name="check"/>:from[0]}</button>
    <button class="cbw" type="button" role="checkbox" aria-checked={selected} aria-label={`선택: ${item.subject}`} onClick={toggle}><span class={`cb ${selected?'on':''}`}><Icon name="check"/></span></button>
    <button class={`st ${item.flagged?'on':''}`} type="button" disabled={acting.value} aria-label={item.flagged?'별표 해제':'별표'} aria-pressed={item.flagged} onClick={event=>{event.stopPropagation();runAction(item.flagged?'unflag':'flag',[item.ref]);}}><Icon name="star"/></button>
    <span class="from"><span>{from}</span></span><span class="txt"><span class="sj">{item.subject||'(제목 없음)'}</span>{item.preview&&<span class="sn">{item.preview}</span>}</span>
    <span class="chips">{['allmail','search'].includes(mode)&&<FolderTag item={item}/>}</span>
    {mode==='spam'&&<button class="nsp" type="button" disabled={acting.value} onClick={event=>{event.stopPropagation();runAction('notspam',[item.ref]);}}>스팸 아님</button>}
    <span class="clip">{item.hasAttachment&&<Icon name="clip" size="xs"/>}</span><time class="time num" dateTime={item.date}>{`${date.getFullYear()}.${pad(date.getMonth()+1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`}</time>
  </li>;
}
