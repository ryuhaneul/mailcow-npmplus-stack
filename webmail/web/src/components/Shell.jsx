import { useEffect, useState, useRef } from 'preact/hooks';
import { prefs } from '../state/prefs.js';
import { initStars } from '../theme/stars.js';
import Brand from './Brand.jsx';

function Icon({ name }) {
  const paths = {
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></>,
    moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  };
  return <svg class="i" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function Starflow() {
  const frame = useRef(null);
  useEffect(() => initStars(frame.current), []);
  return <iframe ref={frame} id="starflow-background" src="/starflow/index.html" tabIndex={-1} aria-hidden="true" title="장식용 별 배경" />;
}

export default function Shell() {
  const [mode, setMode] = useState(document.documentElement.dataset.mode);
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    const update = () => setMode(document.documentElement.dataset.mode);
    document.addEventListener('webmail:apply', update);
    return () => document.removeEventListener('webmail:apply', update);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('nav-open', navOpen);
    const close = event => { if (event.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', close);
    return () => { document.body.classList.remove('nav-open'); document.removeEventListener('keydown', close); };
  }, [navOpen]);
  return <>
    {prefs.value.theme === 'seland' && mode === 'dark' && <Starflow/>}
    <div class="app">
      <aside class="side" id="mail-sidebar" aria-label="메일함"><Brand/><nav class="nav" aria-label="폴더" /></aside>
      <div class="scrim-nav" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <main class="main">
        <header class="top">
          <button class="ib menu-btn" type="button" aria-label="메일함 열기" aria-controls="mail-sidebar" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}><Icon name="menu"/></button>
          <div class="r"><button class="ib" type="button" aria-label={mode === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'} onClick={() => { prefs.value = { ...prefs.value, mode: mode === 'dark' ? 'light' : 'dark' }; }}><Icon name={mode === 'dark' ? 'sun' : 'moon'}/></button></div>
        </header>
        <div class="stage"><div class="head"><div><div class="eyebrow">MAIL</div><h1>메일</h1></div></div></div>
      </main>
    </div>
  </>;
}
