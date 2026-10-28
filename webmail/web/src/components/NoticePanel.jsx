import DOMPurify from 'dompurify';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { noticePanel, closeNotices, toggleNotice, showAllNotices, loadMoreNotices, retryNotices } from '../state/notices.js';
import Icon from './Icon.jsx';

const categories = { update: ['업데이트', 'c-up'], maintenance: ['점검', 'c-fix'], info: ['안내', 'c-info'] };
// Repeat the notice-only server policy at the HTML rendering boundary.
function bodyHtml(html) {
  const fragment = DOMPurify.sanitize(html, { ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true });
  for (const element of fragment.querySelectorAll('*')) {
    if (element.tagName !== 'A') { element.removeAttribute('href'); continue; }
    const href = element.getAttribute('href')?.trim() ?? '';
    if (!/^(?:https?:|mailto:)/i.test(href) || /[\x00-\x1f\x7f]/.test(href)) element.removeAttribute('href');
    else element.setAttribute('href', href);
    element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer');
  }
  const container = document.createElement('div'); container.append(fragment); return container.innerHTML;
}
function noticeDate(value, long = false) {
  const date = new Date(value), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(date.toDateString())) / 864e5);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (long) return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 ${time}`;
  if (days === 0) return `오늘 ${time}`;
  if (days === 1) return '어제';
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}
function Pin() {
  return <svg class="npin" viewBox="0 0 24 24" role="img" aria-label="고정"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>;
}
function NoticeItem({ item, panel }) {
  const expanded = panel.expandedId === item.id, unread = panel.unreadIds.includes(item.id);
  const [label, category] = categories[item.category];
  return <div class={`na-item${unread ? ' unread' : ''}${item.pinned ? ' pinned' : ''}${expanded ? ' open' : ''}`} data-id={item.id}>
    <button class="na-row" type="button" aria-expanded={expanded} aria-controls={`notice-body-${item.id}`} onClick={() => toggleNotice(item.id)}>
      <span class="u" aria-hidden="true"/><span class="t">{item.title}</span>
      <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      <span class="meta">{item.pinned && <Pin/>}<span class={`ncat ${category}`}>{label}</span><span>{noticeDate(item.publishedAt)}</span>{unread && <span class="sr">새 공지</span>}</span>
    </button>
    <div class="na-open" id={`notice-body-${item.id}`} hidden={!expanded}>
      {expanded && <><div class="nbody" dangerouslySetInnerHTML={{ __html: bodyHtml(item.bodyHtml) }}/><div class="when">{noticeDate(item.publishedAt, true)} 게시</div></>}
    </div>
  </div>;
}
function Loading() {
  return <div class="ntc-loading" role="status"><span class="sr">공지 불러오는 중</span><div class="ntc-skeleton" aria-hidden="true"/>
    <div class="ntc-skeleton" aria-hidden="true"/><div class="ntc-skeleton" aria-hidden="true"/></div>;
}
function ErrorState({ retry }) {
  return <div class="ntc-empty ntc-error" role="alert"><span>공지를 불러오지 못했어요.</span><button class="btn" type="button" onClick={retry}>다시 시도</button></div>;
}
export default function NoticePanel({ mobile, trigger }) {
  const element = useRef(null), title = useRef(null);
  const panel = noticePanel.value, Panel = mobile ? 'dialog' : 'div';
  useLayoutEffect(() => {
    const node = element.current;
    if (mobile) node.showModal(); // Native modal makes the background inert.
    title.current.focus();
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeNotices(); } };
    const outside = event => { if (!node.contains(event.target) && !trigger.current?.contains(event.target)) closeNotices(); };
    document.addEventListener('keydown', escape, true);
    document.addEventListener('click', outside, true);
    return () => {
      document.removeEventListener('keydown', escape, true); document.removeEventListener('click', outside, true);
      if (mobile && node.open) node.close();
      if (trigger.current?.isConnected) trigger.current.focus();
    };
  }, [mobile]);
  function keyboard(event) {
    event.stopPropagation();
    if (!mobile || event.key !== 'Tab') return;
    const controls = [...element.current.querySelectorAll('button:not(:disabled),a[href],[tabindex="0"]')].filter(node => node.getClientRects().length);
    const first = controls[0], last = controls.at(-1), active = document.activeElement;
    if (!first) { event.preventDefault(); title.current.focus(); return; }
    if (event.shiftKey && (active === first || active === title.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || active === title.current)) { event.preventDefault(); first.focus(); }
  }
  const items = panel.scope === 'recent' ? [...panel.pinned, ...panel.items] : panel.items;
  const footer = panel.status === 'ready' && !panel.moreError && (panel.scope === 'recent' ? items.length > 0 : panel.nextBefore !== null);
  return <Panel class="ntc-pop" ref={element} id="notice-panel" role="dialog" aria-modal={mobile ? 'true' : undefined} aria-labelledby="notice-title"
    onKeyDown={keyboard} onCancel={event => { event.preventDefault(); closeNotices(); }}>
    <div class="ntc-head"><h2 id="notice-title" ref={title} tabIndex={-1}>공지</h2>{panel.openedUnread > 0 && <span class="sub">새 공지 {panel.openedUnread}개</span>}
      <button class="ntc-x" type="button" aria-label="닫기" onClick={closeNotices}><Icon name="x"/></button>
    </div>
    <div class="ntc-body" aria-busy={panel.status === 'loading' || panel.loadingMore}>
      {panel.status === 'loading' ? <Loading/> : panel.status === 'error' ? <ErrorState retry={retryNotices}/> : items.length ? items.map(item => <NoticeItem key={item.id} item={item} panel={panel}/>) :
        <div class="ntc-empty"><Icon name="bell"/><b>아직 공지가 없어요</b><span>새 소식이 생기면 여기에서 알려 드릴게요.</span></div>}
      {panel.moreError && <ErrorState retry={loadMoreNotices}/>}
    </div>
    {footer && <div class="ntc-foot"><button type="button" disabled={panel.loadingMore} onClick={panel.scope === 'recent' ? showAllNotices : loadMoreNotices}>{panel.scope === 'recent' ? '모두 보기' : '더 보기'}</button></div>}
  </Panel>;
}
