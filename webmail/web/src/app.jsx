import { session } from './state/session.js';
import { prefs } from './state/prefs.js';
import { Icons } from './components/Icon.jsx';
import Login from './components/Login.jsx';
import Shell, { Starflow, useMode } from './components/Shell.jsx';
export default function App() {
  const mode = useMode();
  return <><Icons/>{session.value ? <Shell/> : <>{prefs.value.theme === 'seland' && mode === 'dark' && <Starflow/>}<Login/></>}</>;
}
