import { signal } from '@preact/signals';
import { adminApi } from '../api.js';
import { adminSession } from '../state/session.js';

export const publicFilesLimit = 10 * 1024 * 1024;
const editable = row => ({ name: row?.name ?? '새 템플릿', subject: row?.subject ?? '', html: row?.html ?? '<p><br></p>', audienceAll: row?.audienceAll ?? true, domains: [...(row?.domains ?? [])], attachments: (row?.attachments ?? []).map(file => ({ ...file })) });
const fingerprint = value => JSON.stringify({ ...value, domains: [...value.domains].sort() });
export function validatePublicTemplate(draft, domains) {
  const errors = {}, name = draft.name.trim();
  if (!name || !name.isWellFormed() || Array.from(name).length > 100) errors.name = '템플릿 이름은 1~100자로 입력해 주세요.';
  if (!draft.audienceAll && (!draft.domains.length || draft.domains.some(domain => !domains.includes(domain)))) errors.domains = '사용 중인 대상 도메인을 1개 이상 선택해 주세요.';
  if (draft.attachments.reduce((sum, file) => sum + file.size, 0) > publicFilesLimit) errors.attachments = '템플릿 첨부 합계는 10MB까지 저장할 수 있어요.';
  return errors;
}
export function publicTemplatePayload(draft, meta) {
  return { name: draft.name.trim(), subject: draft.subject, html: draft.html, audienceAll: draft.audienceAll, domains: draft.audienceAll ? [] : [...new Set(draft.domains)].sort(),
    keepFileIds: draft.attachments.filter(file => !file.uploadId).map(file => file.id),
    newFiles: draft.attachments.filter(file => file.uploadId).map(({ name, type, dataBase64 }) => ({ name, type, dataBase64 })),
    ...(meta.id ? { updatedAt: meta.updatedAt } : {}) };
}
export async function encodePublicFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export function createPublicTemplateEditor({ row = null, domains = [], request = adminApi, encodeFile = encodePublicFile, getOwner = () => adminSession.peek() } = {}) {
  let initial = editable(row), alive = true, nextFile = 0;
  const owner = getOwner(), active = () => alive && getOwner() === owner;
  const state = signal({ draft: editable(row), meta: { id: row?.id ?? null, updatedAt: row?.updatedAt ?? null }, busy: false, errors: {}, error: null, needsReload: false, deleted: false });
  const set = patch => { if (active()) state.value = { ...state.peek(), ...patch }; };
  const dirty = () => !state.peek().deleted && fingerprint(state.peek().draft) !== fingerprint(initial);
  function update(patch) { if (active() && !state.peek().busy) set({ draft: { ...state.peek().draft, ...patch }, errors: {}, error: null }); }
  function adopt(value) { initial = editable(value); set({ draft: editable(value), meta: { id: value.id, updatedAt: value.updatedAt }, needsReload: false, errors: {}, error: null }); }
  const failed = error => set({ error, ...(error.status === 409 || error.code === 'CONFLICT' ? { needsReload: true } : {}) });
  async function save() {
    if (!active() || state.peek().busy || state.peek().needsReload) return;
    const current = state.peek(), errors = validatePublicTemplate(current.draft, domains);
    set({ errors, error: null }); if (Object.keys(errors).length) return;
    set({ busy: true });
    try {
      const value = await request(`/api/admin/public-templates${current.meta.id ? `/${current.meta.id}` : ''}`, { method: current.meta.id ? 'PUT' : 'POST', body: publicTemplatePayload(current.draft, current.meta) });
      if (!active()) return;
      adopt(value); return value;
    } catch (error) { failed(error); }
    finally { set({ busy: false }); }
  }
  async function reload() {
    if (!active() || state.peek().busy || !state.peek().meta.id) return;
    set({ busy: true, error: null });
    try { const value = await request(`/api/admin/public-templates/${state.peek().meta.id}`); if (active()) adopt(value); }
    catch (error) { failed(error); }
    finally { set({ busy: false }); }
  }
  async function remove() {
    const current = state.peek(); if (!active() || current.busy || !current.meta.id || current.needsReload) return;
    set({ busy: true, error: null });
    try {
      await request(`/api/admin/public-templates/${current.meta.id}`, { method: 'DELETE', body: { updatedAt: current.meta.updatedAt } });
      if (!active()) return;
      set({ deleted: true }); return true;
    } catch (error) { failed(error); }
    finally { set({ busy: false }); }
  }
  async function addFiles(files) {
    if (!active() || state.peek().busy) return;
    set({ busy: true, error: null });
    try {
      if (state.peek().draft.attachments.reduce((sum, file) => sum + file.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > publicFilesLimit) throw { message: '템플릿 첨부 합계는 10MB까지 저장할 수 있어요.' };
      const added = [];
      for (const file of files) {
        if (!file.name.trim()) throw { message: '파일 이름을 확인해 주세요.' };
        const dataBase64 = await encodeFile(file); if (!active()) return;
        added.push({ uploadId: `local-${++nextFile}`, name: file.name, type: file.type || 'application/octet-stream', size: file.size, dataBase64 });
      }
      set({ draft: { ...state.peek().draft, attachments: [...state.peek().draft.attachments, ...added] } });
    } catch (error) { failed(error); }
    finally { set({ busy: false }); }
  }
  return { state, dirty, update, save, reload, remove, addFiles, reportError: failed,
    removeAttachment(index) { update({ attachments: state.peek().draft.attachments.filter((_, position) => position !== index) }); },
    dispose() { alive = false; } };
}
