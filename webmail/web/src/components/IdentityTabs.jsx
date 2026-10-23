import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';
import { applyServerPrefs } from '../state/prefs.js';
import SignatureTab from './SignatureTab.jsx';
import FromAddressTab from './FromAddressTab.jsx';

export default function IdentityTabs({ tab }) {
  const [preferences, setPreferences] = useState(null);
  const [identities, setIdentities] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active=true;setBusy(true);setError(null);setSaved(false);setPreferences(null);setIdentities(null);
    Promise.all([tab === 'signature' ? Promise.resolve(null) : api('/api/prefs'),api('/api/compose/identities')]).then(([p,i]) => {if(active){setPreferences(p);setIdentities(i);}}).catch(e=>{if(active)setError(e);}).finally(()=>{if(active)setBusy(false);});
    return () => {active=false;};
  }, [version, tab]);
  async function save(doc) {
    if(busy)return;
    setBusy(true);setError(null);setSaved(false);
    try {await api('/api/prefs',{method:'PUT',body:doc});const saved=await api('/api/prefs');setPreferences(saved);applyServerPrefs(saved);setIdentities(await api('/api/compose/identities'));setSaved(true);return saved;}
    catch(e){setError(e);}
    finally{setBusy(false);}
  }
  return <div aria-busy={busy}>{error && <div role="alert"><p>{error.message}</p><button class="btn" type="button" disabled={busy} onClick={()=>setVersion(version+1)}>다시 불러오기</button></div>}{saved && <p role="status">저장했어요.</p>}
    {identities && (tab === 'signature' || preferences) ? tab === 'signature' ? <SignatureTab key={`signature-${version}`} identities={identities}/> : <FromAddressTab identities={identities} preferences={preferences} busy={busy} onSave={save}/> : !error && <p role="status">설정을 불러오는 중이에요.</p>}
  </div>;
}
