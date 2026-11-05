import Monitor from './Monitor.jsx';
import Bounces from './Bounces.jsx';
import './monitor.css';
import { Icons } from '../../components/Icon.jsx';
import AppearanceSettings, { radioKeys } from '../../components/AppearanceSettings.jsx';
import { adminPrefs, updateAdminPrefs } from '../state/prefs.js';
import '../../styles/appearance.css';
import '../../pages/settings.css';
export default function Settings({ parts = [] }) {
  const tab = ['monitor','bounces'].includes(parts[0]) ? parts[0] : 'appearance';
  return <section class="settings-view admin-settings" data-admin-page="settings" aria-labelledby="settings-title">
    <Icons/><div class="page-head"><div><h1 id="settings-title">설정</h1><p>메일 관리 환경과 이상 감시를 설정합니다.</p></div></div>
    <nav class="setting-tabs" aria-label="설정 탭">{[['appearance','보기 설정','#settings'],['monitor','감시','#settings/monitor'],['bounces','반송 주소','#settings/bounces']].map(([id,label,href])=><a key={id} href={href} aria-current={tab===id?'page':undefined}>{label}</a>)}</nav>
    {tab==='monitor'?<Monitor/>:tab==='bounces'?<Bounces/>:<div class="set-body" onKeyDown={radioKeys}><div class="vs"><div><AppearanceSettings state={adminPrefs.value} updatePrefs={updateAdminPrefs}/></div></div></div>}
  </section>;
}
