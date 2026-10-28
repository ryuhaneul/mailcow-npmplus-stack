import { api } from '../api.js';

const templatePath = ref => `/api/templates/${encodeURIComponent(ref)}`;
export const getTemplates = () => api('/api/templates');
export const getTemplate = ref => api(templatePath(ref));
export const createTemplate = input => api('/api/templates', { method: 'POST', body: input });
export const updateTemplate = (ref, input) => api(templatePath(ref), { method: 'PUT', body: input });
// Use the returned html when inserting: its inline images refer to the new uploads.
export const templateAttachmentsToCompose = (ref, composeId) => api(`${templatePath(ref)}/attachments-to-compose`, { method: 'POST', body: { composeId } });

export function searchTemplates(items, query = '') {
  const needle = query.trim().toLocaleLowerCase('ko-KR');
  return items.filter(item => `${item.name}\n${item.subject}`.toLocaleLowerCase('ko-KR').includes(needle));
}

export function templateUid(ref) {
  try {
    const tuple = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(ref.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))));
    if (!Array.isArray(tuple) || tuple.length !== 3 || !Number.isInteger(tuple[2]) || tuple[2] < 1 || tuple[2] > 0xffffffff) throw new Error();
    return tuple[2];
  } catch { throw { code: 'INVALID_REF', message: '템플릿 목록을 다시 불러와 주세요.' }; }
}
// The server changes only inline image sources. Keep authenticated source URLs
// for local display blobs; canonical mail HTML continues to contain fresh CIDs.
export function templateComposeImages(template, html) {
  const before = document.createElement('template'), after = document.createElement('template');
  before.innerHTML = template.html; after.innerHTML = html;
  const sources = [...before.content.querySelectorAll('img')], result = new Map();
  [...after.content.querySelectorAll('img')].forEach((image, index) => {
    const cid = image.getAttribute('src'), source = sources[index]?.getAttribute('src');
    if (/^cid:wm-template-v1\.[A-Za-z0-9_-]+@template\.invalid$/.test(cid || '') && source?.startsWith(`/api/messages/${encodeURIComponent(template.ref)}/parts/`)) result.set(cid.slice(4), source);
  });
  return result;
}

const templateKey = item => JSON.stringify([item.owner, item.id]);
export function availableTemplatePins(data, pins = data.pins) {
  const available = new Set([...data.mine, ...data.shared, ...data.public].map(templateKey)), seen = new Set();
  return (pins ?? []).filter(pin => {
    const key = templateKey(pin);
    if (!available.has(key) || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(({ owner, id }) => ({ owner, id }));
}
export function templateListGroups(data, query = '', pins = data.pins) {
  const selected = new Set(availableTemplatePins(data, pins).map(templateKey));
  return [['mine', '내 템플릿'], ['shared', '공유받은 템플릿'], ['public', '회사 공용']].map(([kind, label]) => ({
    kind, label, items: searchTemplates(data[kind], query).map(item => ({ ...item, kind, pinned: selected.has(templateKey(item)) })).sort((a, b) => Number(b.pinned) - Number(a.pinned)),
  }));
}
export function toggleTemplatePin(data, pins, item, { complete = Boolean(Array.isArray(data?.mine) && Array.isArray(data?.shared) && Array.isArray(data?.public)) } = {}) {
  const seen = new Set(), existing = (pins ?? []).filter(pin => {
    const key = templateKey(pin); if (seen.has(key)) return false; seen.add(key); return true;
  }).map(({ owner, id }) => ({ owner, id }));
  const base = complete && !data?.publicUnavailable ? availableTemplatePins(data, existing) : existing, key = templateKey(item);
  const next = base.some(pin => templateKey(pin) === key) ? base.filter(pin => templateKey(pin) !== key) : [...base, { owner: item.owner, id: item.id }];
  return next.length > 20 ? null : next;
}

export const deleteTemplate = (ref, baseUid) => api(templatePath(ref), { method: 'DELETE', body: { baseUid } });
export const moveTemplate = (ref, shared) => api(`${templatePath(ref)}/move`, { method: 'POST', body: { shared } });

export const getTemplateShare = () => api('/api/templates/share');
export const putTemplateShare = value => api('/api/templates/share', { method: 'PUT', body: { domainAll: value.domainAll, users: [...value.users] } });
export const copyTemplate = ref => api(`${templatePath(ref)}/copy`, { method: 'POST' });
export function addTemplateShareUser(users, value) {
  const match = value.trim().match(/^(.*?)<([^<>]+)>$/), address = (match ? match[2] : value).trim().toLowerCase();
  if (!/^[^\s<>@,;:"()[\]\\/*?\x00-\x1f\x7f]+@[^\s<>@,;:"()[\]\\/*?\x00-\x1f\x7f]+$/.test(address)) throw { code: 'TEMPLATE_SHARE_INVALID', message: '공유할 메일 주소를 확인해 주세요.' };
  if (users.includes(address)) return [...users];
  if (users.length >= 50) throw { code: 'TEMPLATE_SHARE_INVALID', message: '사람은 50명까지 지정할 수 있어요.' };
  return [...users, address];
}
export function templateShareSummary(value) {
  if (!value) return '';
  return [value.domainAll ? `${value.domain} 전체` : '', value.users.length ? `${value.users.length}명 지정` : '', value.inboxReaders.length ? `메일함 전체 공유 ${value.inboxReaders.length}명` : ''].filter(Boolean).join(' · ') || '아직 아무에게도 공유하지 않았어요';
}
export const templateUnavailable = error => ['NOT_FOUND', 'TEMPLATE_NOT_FOUND', 'MESSAGE_NOT_FOUND', 'STALE_REF', 'TEMPLATE_FORBIDDEN', 'MAIL_FORBIDDEN'].includes(error?.code);
