import { AppError } from '../../errors.js';
import { sanitizeNotice } from '../../notices/sanitize.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', '공지 제목·본문·대상과 입력값을 확인해 주세요.');
function input(data, keys) {
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(key => !keys.includes(key))) throw invalid();
}
function domainName(value) {
  if (typeof value !== 'string') throw invalid();
  const name = value.trim().toLowerCase();
  if (name.length > 253 || !name.includes('.') || !name.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) throw invalid();
  return name;
}
const idValue = value => {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
  return Number(value);
};
function version(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalid();
  return value;
}
const metadata = row => row ? { id: row.id, state: row.state, category: row.category, pinned: row.pinned, audienceAll: row.audienceAll, domains: row.domains, updatedAt: row.updatedAt } : null;

export function createNoticesService({ store, domains, audit }) {
  async function list({ session, state = 'all' }) {
    if (!['all', 'draft', 'published', 'hidden'].includes(state)) throw invalid();
    return store.adminList(state);
  }
  async function get({ id }) { return store.adminGet(idValue(id)); }
  function preview({ data }) {
    input(data, ['bodyHtml']);
    if (typeof data.bodyHtml !== 'string' || !data.bodyHtml.isWellFormed()) throw invalid();
    return sanitizeNotice(data.bodyHtml);
  }
  async function validated(data, session, editing) {
    input(data, ['title', 'bodyHtml', 'category', 'audienceAll', 'domains', 'pinned', 'publish', ...(editing ? ['updatedAt'] : [])]);
    if (typeof data.title !== 'string' || !data.title.isWellFormed()) throw invalid();
    const title = data.title.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
    if (!title || Array.from(title).length > 200 || typeof data.bodyHtml !== 'string' || !data.bodyHtml.isWellFormed()) throw invalid();
    const clean = sanitizeNotice(data.bodyHtml);
    if (clean.empty || !['update', 'maintenance', 'info'].includes(data.category) || typeof data.audienceAll !== 'boolean' || typeof data.pinned !== 'boolean' || typeof data.publish !== 'boolean' || !Array.isArray(data.domains)) throw invalid();
    const names = [...new Set(data.domains.map(domainName))].sort();
    if (!data.audienceAll) {
      if (!names.length) throw invalid();
      const available = new Set((await domains.list(session)).items.filter(row => row.active).map(row => row.domain));
      if (names.some(name => !available.has(name))) throw invalid();
    }
    return { title, bodyHtml: clean.bodyHtml, category: data.category, audienceAll: data.audienceAll, pinned: data.pinned, publish: data.publish, domains: data.audienceAll ? [] : names };
  }
  async function save({ session, actor, ip, id, data }) {
    const editing = id !== undefined, key = editing ? idValue(id) : undefined;
    const value = await validated(data, session, editing);
    const updatedAt = editing ? version(data.updatedAt) : undefined;
    const before = editing ? await store.adminGet(key) : null;
    return audit.run({ actor, ip, action: editing ? 'notice.edit' : 'notice.create', target: editing ? String(key) : 'new', kind: 'config', revertible: false,
      before: metadata(before), after: { category: value.category, audienceAll: value.audienceAll, domains: value.domains, pinned: value.pinned, publish: value.publish } }, () => store.change({ id: key, data: value, updatedAt, actor }));
  }
  async function change({ session, actor, ip, id, data, action }) {
    input(data, ['updatedAt']);
    const key = idValue(id), updatedAt = version(data.updatedAt);
    const before = await store.adminGet(key);
    // Revalidate audience before publishing an existing draft or hidden notice.
    if (action === 'publish') await validated({ title: before.title, bodyHtml: before.bodyHtml, category: before.category,
      audienceAll: before.audienceAll, domains: before.domains, pinned: before.pinned, publish: true, updatedAt: before.updatedAt }, session, true);
    return audit.run({ actor, ip, action: `notice.${action}`, target: String(key), kind: action === 'delete' ? 'irreversible' : 'config', revertible: false,
      before: metadata(before), after: { action } }, () => store.change({ id: key, action, updatedAt, actor }));
  }
  return { list, get, preview, save, change };
}
