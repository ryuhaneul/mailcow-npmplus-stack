import { signal } from '@preact/signals';
import { adminApi } from '../api.js';
import { adminSession } from '../state/session.js';

export const noticeFilters = [['all', '전체'], ['published', '게시 중'], ['hidden', '숨김'], ['draft', '임시']];
export const noticeCategories = [['update', '업데이트', 'c-up'], ['maintenance', '점검', 'c-fix'], ['info', '안내', 'c-info']];
export const noticeStateLabel = state => ({ published: '게시 중', hidden: '숨김', draft: '임시' })[state];
export function noticeTimestamp(value) {
  if (!value) return '아직 게시하지 않음';
  const date = new Date(value), pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function noticeShortDate(value) {
  if (!value) return '미게시';
  const date = new Date(value); return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}
export const sortNotices = rows => [...rows].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.publishedAt ?? b.updatedAt) - Date.parse(a.publishedAt ?? a.updatedAt) || b.id - a.id);
const editable = row => ({ title: row?.title ?? '', bodyHtml: row?.bodyHtml ?? '', category: row?.category ?? 'update', audienceAll: row?.audienceAll ?? true, domains: [...(row?.domains ?? [])], pinned: row?.pinned ?? false });
const cleanTitle = value => value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
export function validateNoticeDraft(draft, { empty, domains } = {}) {
  const errors = {};
  const title = typeof draft.title === 'string' ? cleanTitle(draft.title) : '';
  if (!title) errors.title = '제목을 입력해 주세요.';
  else if (!title.isWellFormed() || Array.from(title).length > 200) errors.title = '제목은 200자 이하로 입력해 주세요.';
  const text = typeof draft.bodyHtml === 'string' ? draft.bodyHtml.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, '').replace(/&(?:nbsp|#160|#x0*a0);|[\s\u200b-\u200d\ufeff]/gi, '') : '';
  if (empty === true || !text || !draft.bodyHtml.isWellFormed()) errors.bodyHtml = '본문을 입력해 주세요.';
  if (!noticeCategories.some(([value]) => value === draft.category)) errors.category = '분류를 선택해 주세요.';
  if (typeof draft.audienceAll !== 'boolean' || !Array.isArray(draft.domains) || !draft.audienceAll && !draft.domains.length) errors.domains = '대상 도메인을 1개 이상 선택해 주세요.';
  else if (!draft.audienceAll && domains && draft.domains.some(name => !domains.includes(name))) errors.domains = '사용 중인 도메인을 선택해 주세요.';
  return errors;
}
export function createNoticeEditor({ row = null, domains = [], request = adminApi, getOwner = () => adminSession.peek() } = {}) {
  let initial = editable(row), alive = true, previewVersion = 0;
  const account = getOwner(), active = () => alive && getOwner() === account;
  const state = signal({ draft: editable(row), meta: { id: row?.id ?? null, state: row?.state ?? 'draft', updatedAt: row?.updatedAt ?? null, publishedAt: row?.publishedAt ?? null }, errors: {}, error: null, message: '', busy: false, tab: 'write', preview: null, deleted: false });
  const set = patch => { if (active()) state.value = { ...state.peek(), ...patch }; };
  const fingerprint = value => JSON.stringify({ ...value, domains: [...value.domains].sort() });
  const dirty = () => !state.peek().deleted && fingerprint(state.peek().draft) !== fingerprint(initial);
  function update(key, value) {
    if (!active() || state.peek().busy) return;
    previewVersion++;
    set({ draft: { ...state.peek().draft, [key]: Array.isArray(value) ? [...value] : value }, errors: { ...state.peek().errors, [key]: null }, error: null, message: '', preview: null });
  }
  function adopt(value, keepDraft = false) {
    const draft = keepDraft ? state.peek().draft : editable(value);
    initial = editable(value);
    set({ draft, meta: { id: value.id, state: value.state, updatedAt: value.updatedAt, publishedAt: value.publishedAt }, errors: {}, preview: null });
  }
  async function preview() {
    if (!active() || state.peek().busy) return;
    const version = ++previewVersion;
    set({ tab: 'preview', busy: true, error: null });
    try {
      const value = await request('/api/admin/notices/preview', { method: 'POST', body: { bodyHtml: state.peek().draft.bodyHtml } });
      if (version === previewVersion) set({ preview: value });
    } catch (error) { set({ error }); }
    finally { set({ busy: false }); }
  }
  function write() { if (!state.peek().busy) set({ tab: 'write', error: null }); }
  async function save(publish = false) {
    if (!active() || state.peek().busy) return;
    const current = state.peek(), errors = validateNoticeDraft(current.draft, { domains });
    set({ errors, error: null, message: '' });
    if (Object.keys(errors).length) return;
    set({ busy: true });
    try {
      const clean = await request('/api/admin/notices/preview', { method: 'POST', body: { bodyHtml: current.draft.bodyHtml } });
      if (!active()) return;
      const checked = validateNoticeDraft(current.draft, { empty: clean.empty, domains });
      if (Object.keys(checked).length) { set({ errors: checked, tab: 'write' }); return; }
      const body = { ...current.draft, title: cleanTitle(current.draft.title), bodyHtml: clean.bodyHtml,
        domains: current.draft.audienceAll ? [] : [...new Set(current.draft.domains)].sort(), publish,
        ...(current.meta.id ? { updatedAt: current.meta.updatedAt } : {}) };
      const value = await request(`/api/admin/notices${current.meta.id ? `/${current.meta.id}` : ''}`, { method: current.meta.id ? 'PUT' : 'POST', body });
      if (!active()) return;
      adopt(value); set({ message: publish ? '게시했어요.' : value.state === 'draft' ? '임시 저장했어요.' : '저장했어요.' });
      return value;
    } catch (error) { set({ error }); }
    finally { set({ busy: false }); }
  }
  async function hide() {
    if (!active() || state.peek().busy || !state.peek().meta.id) return;
    const current = state.peek(), keepDraft = dirty();
    set({ busy: true, error: null, message: '' });
    try {
      const value = await request(`/api/admin/notices/${current.meta.id}/hide`, { method: 'POST', body: { updatedAt: current.meta.updatedAt } });
      if (!active()) return;
      adopt(value, keepDraft); set({ message: '숨겼어요.' }); return value;
    } catch (error) { set({ error }); }
    finally { set({ busy: false }); }
  }
  async function remove() {
    if (!active() || state.peek().busy || !state.peek().meta.id) return;
    const current = state.peek();set({ busy: true, error: null, message: '' });
    try {
      await request(`/api/admin/notices/${current.meta.id}`, { method: 'DELETE', body: { updatedAt: current.meta.updatedAt } });
      if (!active()) return;
      set({ deleted: true, message: '삭제했어요.' });return true;
    } catch (error) { set({ error }); }
    finally { set({ busy: false }); }
  }
  return { state, dirty, update, preview, write, save, hide, remove, dispose() { alive = false; previewVersion++; } };
}

export function createNoticesList({ request = adminApi, getOwner = () => adminSession.peek() } = {}) {
  let version = 0, alive = true;
  const account = getOwner(), active = () => alive && getOwner() === account;
  const state = signal({ filter: 'all', enabled: true, items: [], loading: true, busy: false, error: null, message: '' });
  const set = patch => { if (active()) state.value = { ...state.peek(), ...patch }; };
  async function load(filter = state.peek().filter) {
    const current = ++version;set({ filter, loading: true, error: null, items: [] });
    try {
      const value = await request(`/api/admin/notices?state=${filter}`);
      if (current === version) set({ ...value, items: sortNotices(value.items), loading: false });
    } catch (error) { if (current === version) set({ error, loading: false }); }
  }
  async function change(row, action) {
    if (!active() || state.peek().busy) return;
    set({ busy: true, error: null, message: '' });
    try {
      const value = await request(`/api/admin/notices/${row.id}/${action}`, { method: 'POST', body: { updatedAt: row.updatedAt } });
      if (!active()) return;
      const current = state.peek();
      const items = current.items.map(item => item.id === value.id ? value : item).filter(item => current.filter === 'all' || item.state === current.filter);
      set({ items: sortNotices(items), message: action === 'hide' ? '숨겼어요.' : action === 'publish' ? '게시했어요.' : action === 'pin' ? '위로 고정했어요.' : '고정을 해제했어요.' });
    } catch (error) { set({ error }); }
    finally { set({ busy: false }); }
  }
  return { state, load, change, dispose() { alive = false; version++; } };
}
