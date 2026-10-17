import { visibleAdminNav } from '../state/nav.js';
import { adminRoute } from '../router.js';
import { adminApi } from '../api.js';
import { adminSession } from '../state/session.js';
import AdminIcon from './AdminIcon.jsx';
export default function AdminSidebar({ open, close, hidden }) {
  return <aside class={`side${open ? ' open' : ''}`} id="sidebar" aria-label="관리 메뉴" inert={hidden || undefined} aria-hidden={hidden || undefined}>
    <a class="brand" href="#home" aria-label="처음 화면으로" onClick={close}><span class="mark">ㅁ</span><div><b>메일 관리 <small>관리자</small></b></div></a>
    <nav id="nav">{visibleAdminNav(adminSession.value?.features).map(({ row: [id, title, icon], heading }) => <>{heading && <div class="nav-heading">{heading}</div>}<a class="nv" href={`#${id}`} aria-current={adminRoute.value.name === id ? 'page' : undefined} onClick={close}><AdminIcon name={icon}/>{title}</a></>)}</nav>
    <div class="side-foot"><span class="chip ok">관리 전용 주소</span><p>공개 웹메일과 분리된 관리 공간</p><button class="btn" type="button" onClick={async () => { try { await adminApi('/api/admin/auth/logout', { method: 'POST' }); } finally { adminSession.value = null; location.hash = 'login'; close(); } }}>로그아웃</button></div>
  </aside>;
}
