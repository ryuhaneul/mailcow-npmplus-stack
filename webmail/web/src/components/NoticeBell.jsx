import { useEffect, useRef, useState } from 'preact/hooks';
import { session, sessionResourceEpoch } from '../state/session.js';
import { notices, noticePanel, openNotices, closeNotices, watchNotices, noticeLabel } from '../state/notices.js';
import Icon from './Icon.jsx';
import NoticePanel from './NoticePanel.jsx';
import './notices.css';

export default function NoticeBell() {
  const trigger = useRef(null);
  const account = session.value, epoch = sessionResourceEpoch.value;
  const [mobile, setMobile] = useState(() => globalThis.matchMedia?.('(max-width:760px)')?.matches ?? false);
  useEffect(() => watchNotices(), [account, epoch]);
  useEffect(() => {
    const query = globalThis.matchMedia?.('(max-width:760px)');
    if (!query) return;
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const badge = notices.value, panel = noticePanel.value;
  if (!badge.enabled) return null;
  return <>
    <button class={`ib bell${badge.unreadCount > 0 ? ' has-new' : ''}`} ref={trigger} type="button" title="공지"
      aria-label={noticeLabel(badge)} aria-haspopup="dialog" aria-expanded={panel.open} aria-controls="notice-panel"
      onClick={() => { if (panel.open) closeNotices(); else void openNotices(); }}>
      <Icon name="bell"/><span class="bell-mark" aria-hidden="true"/>
    </button>
    {panel.open && <NoticePanel mobile={mobile} trigger={trigger}/>}
  </>;
}
