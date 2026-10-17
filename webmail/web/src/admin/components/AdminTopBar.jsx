import { adminSession } from '../state/session.js';
import { resolvedAdminMode } from '../theme.js';
import AdminIcon from './AdminIcon.jsx';
export default function AdminTopBar({ title, open, toggle, theme }) {
  const username = adminSession.value?.username ?? '';
  return <header class="top"><button class="ib menu" type="button" aria-label={open ? '관리 메뉴 닫기' : '관리 메뉴 열기'} aria-controls="sidebar" aria-expanded={open} onClick={toggle}><AdminIcon name="menu"/></button>
    <span class="host">{location.hostname}</span><span class="crumb">/</span><span class="crumb">{title}</span>
    <div class="right"><button class="ib" type="button" aria-label={resolvedAdminMode.value === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'} onClick={theme.toggle}><AdminIcon name={resolvedAdminMode.value === 'dark' ? 'sun' : 'moon'}/></button><span class="avatar">{username.slice(0, 1)}</span><span class="admin-name">{username} · 관리자</span></div>
  </header>;
}
