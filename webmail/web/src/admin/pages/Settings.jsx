import { Icons } from '../../components/Icon.jsx';
import AppearanceSettings, { radioKeys } from '../../components/AppearanceSettings.jsx';
import { adminPrefs, updateAdminPrefs } from '../state/prefs.js';
import '../../styles/appearance.css';
import '../../pages/settings.css';
export default function Settings() {
  return <section class="settings-view admin-settings" data-admin-page="settings" aria-labelledby="settings-title" onKeyDown={radioKeys}>
    <Icons/><div class="page-head"><h1 id="settings-title">보기 설정</h1></div>
    <div class="set-body"><div class="vs"><div><AppearanceSettings state={adminPrefs.value} updatePrefs={updateAdminPrefs}/></div></div></div>
  </section>;
}
