import { useEffect, useLayoutEffect, useState, useRef } from 'preact/hooks';
import { prefs } from '../state/prefs.js';
import { folders } from '../state/folders.js';
import { storage } from '../state/storage.js';
import { toast } from '../state/toast.js';
import { pendingSend, detachedSendAttempts, clearSendAttempt, sendResultNotice } from '../state/compose.js';
import { isListRoute, connectMailboxEvents, resetMailbox, deleteConfirmation } from '../state/list.js';
import { initMailboxShortcuts } from '../shortcuts.js';
import MailView from './MailView.jsx';
import Composer from './Composer.jsx';
import { route, navigate, keysOpen } from '../router.js';
import { api } from '../api.js';
import { session } from '../state/session.js';
import Starflow from './Starflow.jsx';
import FiltersPage from './FiltersPage.jsx';
import RuleBuilder from './RuleBuilder.jsx';
import Sidebar from './Sidebar.jsx';
import TopBar from './TopBar.jsx';
import MobileQuota from './MobileQuota.jsx';
import { vacation } from './OooBadge.jsx';
import StoragePage from '../pages/StoragePage.jsx';
import { DeleteMessagesDialog } from '../pages/EmptyFolderDialog.jsx';
import PasswordPage from '../pages/PasswordPage.jsx';
import SettingsPage from '../pages/SettingsPage.jsx';
import SharedSettingsPage from '../pages/SharedSettingsPage.jsx';
import KeysDialog from './KeysDialog.jsx';
import FolderDialog, { folderDialog } from './FolderDialog.jsx';

export { default as Starflow } from './Starflow.jsx';
export function useMode() {
  const [mode, setMode] = useState(document.documentElement.dataset.mode);
  useEffect(() => {
    const update = () => setMode(document.documentElement.dataset.mode);
    document.addEventListener('webmail:apply', update);
    return () => document.removeEventListener('webmail:apply', update);
  }, []);
  return mode;
}
export default function Shell() {
  const mode = useMode();
  useLayoutEffect(()=>{resetMailbox();return resetMailbox;},[]);
  const [navOpen, setNavOpen] = useState(false);
  const [checkingReceipts,setCheckingReceipts]=useState(false),[receiptResults,setReceiptResults]=useState([]),[receiptError,setReceiptError]=useState('');
  async function checkDetachedReceipts(){
    if(checkingReceipts)return;
    const owner=session.value;
    setCheckingReceipts(true);setReceiptError('');
    try{
      for(const record of [...detachedSendAttempts.value]){
        try{
          const value=await api(`/api/send/${encodeURIComponent(record.composeId)}`,{silentSessionErrors:true,signal:AbortSignal.timeout(15000)});
          if(session.value!==owner)return;
          const message=value.status==='sent'?(value.copyPending?'보냈어요 · 사본 저장 확인 중이에요':value.sentCopySavedTo==='sent'?'보냈어요 · 보낸편지함에 사본이 있어요':value.sentCopySavedTo==='drafts'?'보냈어요 · 임시보관함에 사본이 있어요':'보냈어요 · 보낸편지함·임시보관함을 확인해 주세요'):value.status==='not_sent'?`안 보냈어요. ${value.error?.message||''} 임시보관함에 저장된 메일을 열어 다시 보내 주세요`:value.reason==='NOT_FOUND'?'발송 여부를 확인할 수 없어요. 보낸편지함·임시보관함을 확인해 주세요.':value.status==='checking'?'발송 결과 확인 중이에요':'발송 여부를 확인할 수 없어요. 보낸편지함·임시보관함을 확인해 주세요.';
          setReceiptResults(previous=>[...previous.filter(item=>item.composeId!==record.composeId),{composeId:record.composeId,message,ref:value.sentCopyRef}]);
          if(value.status==='sent'&&!value.copyPending||value.status==='not_sent'||value.reason==='NOT_FOUND')clearSendAttempt(record.composeId);
        }catch(error){
          if(session.value!==owner)return;
          setReceiptError('결과를 다시 확인하지 못했어요 — 잠시 뒤 다시 확인');
        }
      }
    }finally{if(session.value===owner)setCheckingReceipts(false);}
  }
  function finishDetachedReceipts(){
    if(!window.confirm('보낸편지함에 메일이 없으면 임시보관함 사본이나 새 메일로 다시 보내 주세요'))return;
    for(const record of [...detachedSendAttempts.value])clearSendAttempt(record.composeId);
    setReceiptResults([]);setReceiptError('');
  }

  const current = route.value;
  const onError = error => { if (['NO_SESSION','SESSION_EXPIRED'].includes(error.code)) return; toast.value = { kind: 'error', message: error.message }; };
  useEffect(() => {
    let active = true, stopEvents;
    folders.value = { folders: [], virtualAllMail: null }; storage.value = null; vacation.value = null;
    api('/api/folders').then(value => {if(active) {folders.value=value;stopEvents=connectMailboxEvents();}}).catch(error => {if(active) onError(error);});
    api('/api/storage?quotaOnly=1').then(value => {if(active) storage.value=value;}).catch(error => {if(active) onError(error);});
    api('/api/rules').then(value => {if(active) vacation.value=value.doc?.vacation ?? null;}).catch(error => {if(active) {if(error.code === 'SIEVE_DISABLED') vacation.value=null; else onError(error);}});
    return () => {active=false;stopEvents?.();};
  }, []);
  useEffect(() => {
    document.body.classList.toggle('nav-open', navOpen);
    const close = event => { if (event.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', close);
    return () => { document.body.classList.remove('nav-open'); document.removeEventListener('keydown', close); };
  }, [navOpen]);
  useEffect(initMailboxShortcuts, []);
  useEffect(() => {setNavOpen(false);document.body.dataset.r=current.name;},[current]);
  const folder = current.name === 'f' ? folders.value.folders.find(value=>value.path===current.value) : null;
  return <>
    {prefs.value.theme === 'seland' && mode === 'dark' && <Starflow/>}
    <div class="app">
      <aside class="side" id="mail-sidebar" aria-label="메일함"><Sidebar/></aside>
      <div class="scrim-nav" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <main class="main">
        <TopBar mode={mode} navOpen={navOpen} toggleNav={()=>setNavOpen(!navOpen)}/>
        <MobileQuota/>
        {pendingSend.value&&current.name!=='compose'&&<button class="pending-send-notice" type="button" onClick={()=>navigate('compose')}>발송 결과 확인 중인 메일이 있어요 <span>확인하기</span></button>}
        {(detachedSendAttempts.value.length>0||receiptResults.length>0)&&<div class="pending-send-notice detached-send-notice" role="status" aria-live="polite">
          {detachedSendAttempts.value.length>0&&<><p>발송 결과를 확인해야 하는 메일이 {detachedSendAttempts.value.length}통 있어요</p><button class="btn sm" type="button" disabled={checkingReceipts} onClick={()=>void checkDetachedReceipts()}>다시 확인</button><button class="btn sm" type="button" disabled={checkingReceipts} onClick={finishDetachedReceipts}>확인 끝내기</button></>}
          {receiptResults.length>0&&<><ol style={{maxHeight:'45vh',overflowY:'auto'}}>{receiptResults.map(item=><li key={item.composeId}>{item.message} {item.ref&&<a href={`#read/${encodeURIComponent(item.ref)}`}>사본 보기</a>}</li>)}</ol><button class="btn sm" type="button" onClick={()=>setReceiptResults([])}>결과 닫기</button></>}
          {receiptError&&<small>{receiptError}</small>}
        </div>}
        <div class="stage">{(isListRoute(current)||['read','compose'].includes(current.name))?<MailView/>:current.name === 'filters' ? <FiltersPage/> : current.name === 'rule' ? <RuleBuilder key={`${current.value}?${current.query ?? ''}`} id={current.value} query={current.query}/> : current.name === 'storage' ? <StoragePage/> : current.name === 'password' ? <PasswordPage/> : current.name === 'shared' ? <SharedSettingsPage/> : current.name === 'settings' ? <SettingsPage/> : <section class="placeholder-view" aria-labelledby="page-title"><div class="head"><div><div class="eyebrow">{current.name === 'inbox' ? 'INBOX' : ''}</div><h1 id="page-title">{folder?.name || current.title}</h1></div></div></section>}</div>
        <Composer/>
      </main>
    </div>
    {keysOpen.value && <KeysDialog onClose={()=>navigate(current.name+(current.value?'/'+encodeURIComponent(current.value):'')+(current.q?'?q='+encodeURIComponent(current.q):''))}/>}
    {deleteConfirmation.value && <DeleteMessagesDialog/>}
    {folderDialog.value && <FolderDialog folder={folderDialog.value.folder}/>}
    {toast.value&&!sendResultNotice.value && <div class={`toast open${toast.value.kind === 'rule-apply-result' ? ' rule-result' : ''}`} role="status"><span>{toast.value.message}</span><button type="button" onClick={()=>{toast.value=null;}}>닫기</button></div>}
    {sendResultNotice.value&&<div class={`toast open send-result-notice${sendResultNotice.value.status==='not_sent'?' error':''}`} role={sendResultNotice.value.status==='not_sent'?'alert':'status'}><span>{sendResultNotice.value.message}</span><button type="button" onClick={()=>{const notice=sendResultNotice.value;sendResultNotice.value=null;notice.onView();}}>결과 보기</button><button type="button" onClick={()=>{const notice=sendResultNotice.value;sendResultNotice.value=null;notice.onClose();}}>닫기</button></div>}
  </>;
}
