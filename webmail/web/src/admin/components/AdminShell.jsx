import { useEffect, useRef, useState } from 'preact/hooks';
import AdminSidebar from './AdminSidebar.jsx';
import AdminTopBar from './AdminTopBar.jsx';
export default function AdminShell({ title, theme, children }) {
  const [open, setOpen] = useState(false), [narrow, setNarrow] = useState(() => innerWidth <= 900), root = useRef(null);
  const close = () => setOpen(false);
  useEffect(() => { const media = matchMedia('(max-width: 900px)'), change = () => setNarrow(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  useEffect(() => { if (!open) return; const previous = document.activeElement; root.current.querySelector('#nav a')?.focus(); const key = event => { if (event.key === 'Escape') { close(); previous?.focus(); } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [open]);
  return <div class="app" ref={root}><a class="skip" href="#admin-content" onClick={event => { event.preventDefault(); root.current.querySelector('#admin-content')?.focus(); }}>본문으로 이동</a><button class={`shade${open ? ' open' : ''}`} aria-label="관리 메뉴 닫기" type="button" onClick={close}/><AdminSidebar open={open} close={close} hidden={narrow && !open}/><main class="main"><AdminTopBar title={title} open={open} toggle={() => setOpen(!open)} theme={theme}/><div id="admin-content" tabIndex="-1"><div class="page-head"><h1>{title}</h1></div>{children}</div></main></div>;
}
