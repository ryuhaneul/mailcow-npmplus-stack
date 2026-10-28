import { batch, effect, signal } from '@preact/signals';
import { api } from '../api.js';
import { session, sessionResourceEpoch, authGeneration } from './session.js';

const closed = () => ({ open: false, status: 'idle', scope: 'recent', pinned: [], items: [],
  unreadIds: [], openedUnread: 0, expandedId: null, nextBefore: null, loadingMore: false, moreError: false });
export const notices = signal({ enabled: false, unreadCount: 0 });
export const noticePanel = signal(closed());
let panelVersion = 0, badgeVersion = 0, unreadPending, marking = null;
const owner = () => ({ session: session.peek(), epoch: sessionResourceEpoch.peek(), generation: authGeneration });
const current = value => value.session && session.peek() === value.session && sessionResourceEpoch.peek() === value.epoch && authGeneration === value.generation;

effect(() => {
  session.value; sessionResourceEpoch.value;
  panelVersion++; badgeVersion++; unreadPending = null; marking = null;
  batch(() => { notices.value = { enabled: false, unreadCount: 0 }; noticePanel.value = closed(); });
});

export function noticeLabel(value = notices.peek()) { return value.unreadCount > 0 ? `공지, 새 공지 ${value.unreadCount}개` : '공지'; }

export function refreshNoticeUnread() {
  if (unreadPending) return unreadPending;
  const account = owner(), version = badgeVersion;
  if (!account.session) return Promise.resolve();
  const pending = api('/api/notices/unread', { silentSessionErrors: true }).then(value => {
    if (!current(account) || version !== badgeVersion || marking !== null) return;
    notices.value = value;
    if (!value.enabled) closeNotices();
  }).catch(() => {}).finally(() => { if (unreadPending === pending) unreadPending = null; });
  unreadPending = pending;
  return pending;
}

async function markSeen(account, upTo, unreadCount) {
  const version = ++badgeVersion;
  marking = version;
  notices.value = { enabled: true, unreadCount: 0 };
  try {
    const value = await api('/api/notices/seen', { method: 'POST', body: { upTo }, silentSessionErrors: true });
    if (current(account) && version === badgeVersion) notices.value = { enabled: true, unreadCount: value.unreadCount };
  } catch {
    if (current(account) && version === badgeVersion) notices.value = { enabled: true, unreadCount };
  } finally {
    if (marking === version) marking = null;
    if (current(account) && version === badgeVersion) badgeVersion++;
  }
}

async function loadRecent() {
  const account = owner(), version = ++panelVersion;
  noticePanel.value = { ...noticePanel.peek(), open: true, scope: 'recent', status: 'loading', moreError: false };
  try {
    const value = await api('/api/notices?scope=recent', { silentSessionErrors: true });
    if (!current(account) || version !== panelVersion) return;
    if (!value.enabled) { notices.value = { enabled: false, unreadCount: 0 }; closeNotices(); return; }
    const unreadIds = [...new Set([...noticePanel.peek().unreadIds, ...[...value.pinned, ...value.items].filter(item => item.unread).map(item => item.id)])];
    const recent = { pinned: value.pinned, items: value.items };
    noticePanel.value = { ...noticePanel.peek(), ...recent, status: 'ready', unreadIds, openedUnread: value.unreadCount, expandedId: null, nextBefore: null };
    await markSeen(account, value.maxSeq, value.unreadCount);
  } catch {
    if (current(account) && version === panelVersion) noticePanel.value = { ...noticePanel.peek(), status: 'error' };
  }
}
export function openNotices() {
  if (!session.peek() || !notices.peek().enabled || noticePanel.peek().open) return Promise.resolve();
  noticePanel.value = { ...closed(), open: true };
  return loadRecent();
}
export function closeNotices() { panelVersion++; noticePanel.value = closed(); }
export function toggleNotice(id) { noticePanel.value = { ...noticePanel.peek(), expandedId: noticePanel.peek().expandedId === id ? null : id }; }

async function allPage(more) {
  const account = owner(), previous = noticePanel.peek();
  if (!previous.open || more && (previous.loadingMore || previous.nextBefore === null)) return;
  const version = ++panelVersion, before = more ? previous.nextBefore : null;
  noticePanel.value = { ...previous, scope: 'all', status: more ? 'ready' : 'loading', loadingMore: more, moreError: false, ...(more ? {} : { expandedId: null }) };
  try {
    const value = await api(`/api/notices?scope=all${before === null ? '' : `&before=${before}`}`, { silentSessionErrors: true });
    if (!current(account) || version !== panelVersion) return;
    const latest = noticePanel.peek(), unreadIds = [...new Set([...latest.unreadIds, ...value.items.filter(item => item.unread).map(item => item.id)])];
    const items = [...(more ? latest.items : []), ...value.items].filter((item, index, rows) => rows.findIndex(row => row.id === item.id) === index);
    noticePanel.value = { ...latest, pinned: [], items, unreadIds, status: 'ready', nextBefore: value.nextBefore, loadingMore: false };
  } catch {
    if (current(account) && version === panelVersion) noticePanel.value = { ...noticePanel.peek(), loadingMore: false, ...(more ? { moreError: true } : { status: 'error' }) };
  }
}
export const showAllNotices = () => allPage(false);
export const loadMoreNotices = () => allPage(true);
export function retryNotices() { return noticePanel.peek().scope === 'all' ? showAllNotices() : loadRecent(); }

export function watchNotices({ target = globalThis.window, schedule = setInterval, cancel = clearInterval } = {}) {
  const refresh = () => { void refreshNoticeUnread(); };
  refresh();
  target?.addEventListener('focus', refresh);
  const timer = schedule(refresh, 10 * 60 * 1000);
  return () => { target?.removeEventListener('focus', refresh); cancel(timer); };
}
