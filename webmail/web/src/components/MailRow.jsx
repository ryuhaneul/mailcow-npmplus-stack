import { folderLabel } from '../format.js';
import { cursor, runAction, acting } from '../state/list.js';
import { isSelected, scopeSelection, toggleSelection } from '../state/selection.js';
import { folders, folderColor } from '../state/folders.js';
import { openMessage } from '../state/compose.js';
import Icon from './Icon.jsx';
import { scopedRequestPending, scopedListFrozen } from '../state/scoped-actions.js';
import { failureLabel } from './ScopeActionDialog.jsx';
export function FolderTag({item}) {
  const folder=folders.value.folders.find(value=>value.path===item.folder);
  const color=folderColor(folder);
  return color!==null?<span class={`chip c${color}`}>{folderLabel(folder)}</span>:<span class="ftag"><Icon name={folder?.shared?'users':({INBOX:'inbox',Sent:'send',Archive:'archive',Drafts:'file',Junk:'spam',Trash:'trash'}[item.folder]||'folder')} size="xs"/>{folder?folderLabel(folder):item.folderName}</span>;
}
export default function MailRow({item,mode}) {
  if(item.unavailable)return <li id={`mail-${item.ref}`} data-ref={item.ref} class="m sa-unavailable" tabIndex={0} aria-label={`메일 정보 없음, ${failureLabel(item.code)}`}><span class="av"><Icon name="alert"/></span><span class="from">메일 정보 없음</span><span class="txt"><span class="sj">이 메일은 이동되었거나 없어졌어요.</span><span class="sa-failure-note">{failureLabel(item.code)}{item.retryable?' · 다시 시도할 수 있어요':' · 메일함 상태를 확인해 주세요'}</span></span></li>;
  const disabled=acting.value||scopedRequestPending.value||scopedListFrozen(),selectDisabled=disabled||(scopeSelection.value?.failureView&&!item.retryable);
  const date=new Date(item.date),pad=value=>String(value).padStart(2,'0');
  const selected=isSelected(item.ref),from=item.from.name||item.from.address;
  const toggle=event=>{event.stopPropagation();cursor.value=item.ref;toggleSelection(item.ref);};
  return <li id={`mail-${item.ref}`} class={`m ${!item.seen?'u':''} ${selected?'sel':''} ${cursor.value===item.ref?'cur':''}`} data-ref={item.ref} tabIndex="0" aria-label={`${from}, ${item.subject}`} onFocus={()=>{cursor.value=item.ref;}} onClick={()=>openMessage(item)}>
    <button class="av" type="button" role="checkbox" disabled={selectDisabled} aria-checked={selected} aria-label={`선택: ${item.subject}`} onClick={toggle}>{selected?<Icon name="check"/>:from[0]}</button>
    <button class="cbw" type="button" role="checkbox" disabled={selectDisabled} aria-checked={selected} aria-label={`선택: ${item.subject}`} onClick={toggle}><span class={`cb ${selected?'on':''}`}><Icon name="check"/></span></button>
    <button class={`st ${item.flagged?'on':''}`} type="button" disabled={disabled} aria-label={item.flagged?'별표 해제':'별표'} aria-pressed={item.flagged} onClick={event=>{event.stopPropagation();runAction(item.flagged?'unflag':'flag',[item.ref]);}}><Icon name="star"/></button>
    <span class="from"><span>{from}</span></span><span class="txt"><span class="sj">{item.subject||'(제목 없음)'}</span>{item.code?<span class="sa-failure-note">{failureLabel(item.code)}{!item.retryable?' · 다시 실행하지 않아요':''}</span>:item.preview&&<span class="sn">{item.preview}</span>}</span>
    <span class="chips">{['allmail','search'].includes(mode)&&<FolderTag item={item}/>}</span>
    {mode==='spam'&&<button class="nsp" type="button" disabled={disabled} onClick={event=>{event.stopPropagation();runAction('notspam',[item.ref]);}}>스팸 아님</button>}
    <span class="clip">{item.hasAttachment&&<Icon name="clip" size="xs"/>}</span><time class="time num" dateTime={item.date}>{`${date.getFullYear()}.${pad(date.getMonth()+1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`}</time>
  </li>;
}
