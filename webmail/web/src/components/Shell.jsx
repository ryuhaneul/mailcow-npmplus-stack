import { useEffect, useLayoutEffect, useState, useRef } from 'preact/hooks';
import { prefs } from '../state/prefs.js';
import { folders } from '../state/folders.js';
import { storage } from '../state/storage.js';
import { toast } from '../state/toast.js';
import { isListRoute, connectMailboxEvents, resetMailbox } from '../state/list.js';
import { initMailboxShortcuts } from '../shortcuts.js';
import MailList from './MailList.jsx';
import { route, navigate, keysOpen } from '../router.js';
import { api } from '../api.js';
import { initStars } from '../theme/stars.js';
import FiltersPage from './FiltersPage.jsx';
import Sidebar from './Sidebar.jsx';
import TopBar from './TopBar.jsx';
import MobileQuota from './MobileQuota.jsx';
import { vacation } from './OooBadge.jsx';
import StoragePage from '../pages/StoragePage.jsx';
import PasswordPage from '../pages/PasswordPage.jsx';
import SettingsPage from '../pages/SettingsPage.jsx';
import KeysDialog from './KeysDialog.jsx';
import FolderDialog, { folderDialog } from './FolderDialog.jsx';

export function Starflow() {
  const frame = useRef(null);
  useEffect(() => initStars(frame.current), []);
  return <iframe ref={frame} id="starflow-background" src="/starflow/index.html" tabIndex={-1} aria-hidden="true" title="장식용 별 배경" />;
}
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
  const current = route.value;
  const onError = error => { if (['NO_SESSION','SESSION_EXPIRED'].includes(error.code)) return; toast.value = { kind: 'error', message: error.message }; };
  useEffect(() => {
    let active = true, stopEvents;
    folders.value = { folders: [], virtualAllMail: null }; storage.value = null; vacation.value = null;
    Promise.all([api('/api/folders'),api('/api/storage?quotaOnly=1')]).then(([f,s]) => { if (active) {folders.value=f;storage.value=s;stopEvents=connectMailboxEvents();} }).catch(error => {if(active) onError(error);});
    // Vacation has no production endpoint yet; only the development fixture provides it.
    if (import.meta.env.DEV && import.meta.env.VITE_WEBMAIL_FAKE_API === '1') api('/api/dev/vacation').then(value => {if(active) vacation.value=value;}).catch(error => {if(active) onError(error);});
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
        <div class="stage">{isListRoute(current)?<MailList/>:current.name === 'filters' ? <FiltersPage/> : current.name === 'storage' ? <StoragePage/> : current.name === 'password' ? <PasswordPage/> : current.name === 'settings' ? <SettingsPage/> : <section class="placeholder-view" aria-labelledby="page-title"><div class="head"><div><div class="eyebrow">{current.name === 'inbox' ? 'INBOX' : ''}</div><h1 id="page-title">{folder?.name || current.title}</h1></div></div></section>}</div>
      </main>
    </div>
    {folderDialog.value && <FolderDialog folder={folderDialog.value.folder}/>}
    {keysOpen.value && <KeysDialog onClose={()=>navigate(current.name+(current.value?'/'+encodeURIComponent(current.value):'')+(current.q?'?q='+encodeURIComponent(current.q):''))}/>}
    {toast.value && <div class="toast open" role="status"><span>{toast.value.message}</span><button type="button" onClick={()=>{toast.value=null;}}>닫기</button></div>}
  </>;
}
