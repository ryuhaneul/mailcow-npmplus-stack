import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import { applyServerPrefs } from '../state/prefs.js';
import { list, cursor, listLocation, notify, runAction, deleteMessages } from '../state/list.js';
import { navigate } from '../router.js';
import { initShortcuts } from '../shortcuts.js';
import { startCompose } from '../state/compose.js';
import { senderOf, allowSender } from '../reader.js';
import { FolderTag } from './MailRow.jsx';
import Icon from './Icon.jsx';
import ReaderToolbar from './ReaderToolbar.jsx';
import MessageFrame from './MessageFrame.jsx';
import ImageBlockBar from './ImageBlockBar.jsx';
import Attachments from './Attachments.jsx';
export default function Reader({messageRef}) {
  const [message,setMessage]=useState(null),[error,setError]=useState(null),[busy,setBusy]=useState(false),active=useRef(false),request=useRef(null);
  async function load(images=false) {
    request.current?.abort();const controller=new AbortController();request.current=controller;setBusy(true);setError(null);
    try {
      const value=await api(`/api/messages/${encodeURIComponent(messageRef)}?images=${images?1:0}`,{signal:controller.signal});
      if(!active.current||controller.signal.aborted)return;
      setMessage(value);cursor.value=value.ref;
      list.value={...list.value,items:list.value.items.map(item=>item.ref===value.ref?{...item,seen:value.seen,flagged:value.flagged}:item)};
    } catch(value) {if(active.current&&!controller.signal.aborted){setError(value);notify(value);}}
    finally {if(active.current&&!controller.signal.aborted)setBusy(false);}
  }
  useEffect(()=>{active.current=true;void load();return()=>{active.current=false;request.current?.abort();};},[messageRef]);
  async function always() {
    setBusy(true);
    try {
      const document=await api('/api/prefs'),next=allowSender(document,senderOf(message).address);
      await api('/api/prefs',{method:'PUT',body:next});
      if(!active.current)return;
      applyServerPrefs(next);await load();
    } catch(value){if(active.current){setBusy(false);notify(value);}}
  }
  function step(offset) {
    const index=list.value.items.findIndex(item=>item.ref===messageRef),next=index<0?null:list.value.items[index+offset];
    if(next)navigate(`read/${encodeURIComponent(next.ref)}`);
  }
  async function action(value,target) {
    const result=await (value==='trash'?deleteMessages([messageRef],message.folder):runAction(value,[messageRef],target));
    if(!active.current||!result||result.failed.length||!result.done)return;
    if(['archive','trash','spam','notspam','move'].includes(value))navigate(listLocation.value);
    else setMessage(current=>({...current,...(value==='unseen'?{seen:false}:{flagged:value==='flag'})}));
  }
  useEffect(()=>initShortcuts(event=>{
    if(event.ctrlKey||event.altKey||event.metaKey||event.defaultPrevented||!message)return;
    const key=event.key.toLowerCase();
    if(['j','k'].includes(key)){event.preventDefault();step(key==='j'?1:-1);}
    else if(['r','a','f'].includes(key)){event.preventDefault();startCompose(({r:'reply',a:'replyall',f:'forward'})[key],message);}
    else if(['s','e','#','!'].includes(key)){event.preventDefault();void action(key==='s'?(flagged?'unflag':'flag'):key==='e'?'archive':key==='#'?'trash':message.spam?'notspam':'spam');}
  }),[message,list.value.items]);
  if(!message)return <div class="empty-read" role={error?'alert':'status'}>{error?error.message:'메일을 불러오는 중…'}</div>;
  const sender=senderOf(message),files=message.attachments||[],cached=list.value.items.find(item=>item.ref===messageRef),flagged=cached?.flagged??message.flagged;
  return <><ReaderToolbar message={message} action={action} step={step} flagged={flagged}/><div class="scroll reader-scroll" aria-busy={busy}><article class="reader">
    <h1>{message.subject||'(제목 없음)'}</h1><div class="tagline"><FolderTag item={{...message,folderName:message.folder}}/><span>·</span><span>{files.length?`첨부 ${files.length}개`:'첨부 없음'}</span></div>
    <div class="sender"><span class="pic" aria-hidden="true">{(sender.name||sender.address)[0]}</span><div class="who"><div><b>{sender.name||sender.address}</b> <span>&lt;{sender.address}&gt;</span></div><div>받는 사람: {message.to.map(person=>person.name?`${person.name} <${person.address}>`:person.address).join(', ')}{message.cc.length>0&&<> · 참조: {message.cc.map(person=>person.address).join(', ')}</>}</div></div><div class="when"><span class="num">{message.date?new Date(message.date).toLocaleString('ko-KR',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):''}</span><button class="ib" type="button" aria-label="답장" onClick={()=>startCompose('reply',message)}><Icon name="reply"/></button></div></div>
    {message.spam&&<div class="spambar"><Icon name="alert"/><span><b>스팸으로 분류된 메일</b>입니다. 링크와 첨부를 열지 마세요. 아는 사람이 보낸 메일이면 ‘스팸 아님’을 눌러 주세요.</span><span class="r"><button class="btn sm" type="button" onClick={()=>action('notspam')}>스팸 아님</button></span></div>}
    <ImageBlockBar message={message} busy={busy} showOnce={()=>load(true)} showAlways={always}/><MessageFrame key={message.ref} message={message}/><Attachments message={message}/>
    <div class="replybox">{[['reply','답장'],['replyall','전체 답장'],['fwd','전달']].map(([icon,label])=><button class="btn" type="button" key={icon} onClick={()=>startCompose(({reply:'reply',replyall:'replyall',fwd:'forward'})[icon],message)}><Icon name={icon}/>{label}</button>)}</div>
  </article></div></>;
}
