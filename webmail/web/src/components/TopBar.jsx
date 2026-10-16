import { useEffect, useRef, useState } from 'preact/hooks';
import { logout } from '../api.js';
import { session } from '../state/session.js';
import { updatePrefs } from '../state/prefs.js';
import Icon from './Icon.jsx';
import SearchBar from './SearchBar.jsx';
import OooBadge from './OooBadge.jsx';
export default function TopBar({ mode, navOpen, toggleNav }) {
  const [accountOpen, setAccountOpen] = useState(false);
  const account = useRef(null), trigger = useRef(null), exit = useRef(null);
  useEffect(() => {
    if (!accountOpen) return;
    exit.current.focus();
    const outside = event => { if (!account.current.contains(event.target)) setAccountOpen(false); };
    const escape = event => { if (event.key === 'Escape') {setAccountOpen(false);trigger.current.focus();} };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  }, [accountOpen]);
  const user = session.value.user;
  return <header class="top">
    <button class="ib menu-btn" type="button" aria-label="메일함 열기" aria-controls="mail-sidebar" aria-expanded={navOpen} onClick={toggleNav}><Icon name="menu"/></button>
    <SearchBar/>
    <div class="r"><OooBadge/>
      <button class="ib" type="button" aria-label={mode === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'} onClick={() => {updatePrefs({mode:mode === 'dark' ? 'light' : 'dark'});}}><Icon name={mode === 'dark' ? 'sun' : 'moon'}/></button>
      <a class="ib" href="#settings" title="설정" aria-label="설정"><Icon name="settings"/></a>
      <div class="account" ref={account}>
        <button class="me" ref={trigger} type="button" aria-label="사용자 메뉴" aria-haspopup="menu" aria-expanded={accountOpen} title={user.name} onClick={()=>setAccountOpen(!accountOpen)} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();setAccountOpen(true);}}}>{user.name?.slice(-2) || user.email.slice(0,2)}</button>
        {accountOpen && <div class="pop account-menu" role="menu" aria-label="사용자 메뉴"><h5>{user.email}</h5><button class="opt" ref={exit} type="button" role="menuitem" onClick={logout}>로그아웃</button></div>}
      </div>
    </div>
  </header>;
}
