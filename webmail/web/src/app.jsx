import { useEffect } from 'preact/hooks';
import { preloadComposeResources, refreshComposeResources } from './state/compose-resources.js';
import './styles/shared.css';
import { session, sessionReady } from './state/session.js';
import { prefs } from './state/prefs.js';
import { Icons } from './components/Icon.jsx';
import Login from './components/Login.jsx';
import Shell, { Starflow, useMode } from './components/Shell.jsx';
export default function App() {
  const mode = useMode(), owner = session.value, ready = sessionReady.value;
  useEffect(() => {
    if (!owner || !ready) return;
    void preloadComposeResources().catch(() => {});
    const refresh = () => { void refreshComposeResources(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [owner, ready]);
  return <><Icons/>{session.value && sessionReady.value ? <Shell/> : <>{prefs.value.theme === 'seland' && mode === 'dark' && <Starflow/>}<Login/></>}</>;
}
