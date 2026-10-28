import { JSDOM } from 'jsdom';
import { AppError } from '../../errors.js';
import { sanitizeComposeHtml } from '../../mail/sanitize.js';
import { hasPublicTemplateCidReference, publicTemplateAttachmentLimit } from '../../templates/public-store.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', '템플릿 이름·본문·대상과 첨부를 확인해 주세요.');
const tooLarge = () => new AppError(422, 'ATTACH_TOO_LARGE', '템플릿 첨부 합계는 10MB까지 저장할 수 있어요.');
function input(data, keys) {
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(key => !keys.includes(key))) throw invalid();
}
const idValue = value => {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
  return Number(value);
};
function version(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalid();
  return value;
}
function domainName(value) {
  if (typeof value !== 'string') throw invalid();
  const name = value.trim().toLowerCase();
  if (name.length > 253 || !name.includes('.') || !name.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) throw invalid();
  return name;
}
function newFile(file) {
  input(file, ['name', 'type', 'dataBase64']);
  if (typeof file.name !== 'string' || !file.name.isWellFormed() || !file.name.trim() || Buffer.byteLength(file.name) > 255 || /[\x00-\x1f\x7f]/.test(file.name) ||
      typeof file.type !== 'string' || !/^[a-z\d!#$&^_.+-]+\/[a-z\d!#$&^_.+-]+$/i.test(file.type) || file.type.length > 255 ||
      typeof file.dataBase64 !== 'string' || file.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.dataBase64)) throw invalid();
  if (file.dataBase64.length > Math.ceil(publicTemplateAttachmentLimit / 3) * 4) throw tooLarge();
  const data = Buffer.from(file.dataBase64, 'base64');
  if (data.toString('base64') !== file.dataBase64) throw invalid();
  if (data.length > publicTemplateAttachmentLimit) throw tooLarge();
  return { name: file.name, type: file.type, data };
}
const metadata = row => row ? { id: row.id, audienceAll: row.audienceAll, domains: row.domains, updatedAt: row.updatedAt, fileCount: row.attachments.length } : null;

export function createPublicTemplatesService({ store, domains, audit, config = {}, normalizeHtml = html => sanitizeComposeHtml(html, { publicHostnames: config.publicHostnames ?? [] }) }) {
  async function validated(data, session, editing) {
    input(data, ['name', 'subject', 'html', 'audienceAll', 'domains', 'keepFileIds', 'newFiles', ...(editing ? ['updatedAt'] : [])]);
    if (typeof data.name !== 'string' || !data.name.isWellFormed() || typeof data.subject !== 'string' || !data.subject.isWellFormed() || /[\x00-\x1f\x7f]/.test(data.subject) || typeof data.html !== 'string' || !data.html.isWellFormed() || typeof data.audienceAll !== 'boolean' || !Array.isArray(data.domains) || !Array.isArray(data.keepFileIds) || !Array.isArray(data.newFiles)) throw invalid();
    const name = data.name.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
    if (!name || Array.from(name).length > 100 || data.keepFileIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(data.keepFileIds).size !== data.keepFileIds.length || !editing && data.keepFileIds.length) throw invalid();
    const files = data.newFiles.map(newFile);
    if (files.reduce((sum, file) => sum + file.data.length, 0) > publicTemplateAttachmentLimit) throw tooLarge();
    const names = [...new Set(data.domains.map(domainName))].sort();
    if (!data.audienceAll) {
      const available = new Set((await domains.list(session)).items.filter(row => row.active).map(row => row.domain));
      if (!names.length || names.some(name => !available.has(name))) throw invalid();
    }
    const html = await normalizeHtml(data.html);
    // Inspect both parsed DOMs: sanitization must not silently discard a CID reference.
    if (hasPublicTemplateCidReference(data.html) || hasPublicTemplateCidReference(html)) throw new AppError(422, 'PUBLIC_TEMPLATE_CID', '메일에 붙인 이미지는 넣을 수 없어요.');
    for (const source of [data.html, html]) for (const image of JSDOM.fragment(source).querySelectorAll('img[src]')) {
      if (!/^https:/i.test(image.getAttribute('src').trim())) throw new AppError(422, 'PUBLIC_TEMPLATE_IMAGE_URL', '그림은 https 주소만 넣을 수 있어요.');
    }
    return { name, subject: data.subject, html, audienceAll: data.audienceAll, domains: data.audienceAll ? [] : names, keepFileIds: data.keepFileIds, newFiles: files };
  }
  async function list() { return store.adminList(); }
  async function get({ id }) { return store.adminGet(idValue(id)); }
  async function save({ session, actor, ip, id, data }) {
    const editing = id !== undefined, key = editing ? idValue(id) : undefined;
    const value = await validated(data, session, editing);
    const updatedAt = editing ? version(data.updatedAt) : undefined;
    const before = editing ? await store.adminGet(key) : null;
    return audit.run({ actor, ip, action: editing ? 'public-template.edit' : 'public-template.create', target: editing ? String(key) : 'new', kind: 'config', revertible: false,
      before: metadata(before), after: { audienceAll: value.audienceAll, domains: value.domains, fileCount: value.keepFileIds.length + value.newFiles.length } },
    () => store.change({ id: key, data: value, updatedAt, actor }));
  }
  async function remove({ actor, ip, id, data }) {
    input(data, ['updatedAt']);
    const key = idValue(id), updatedAt = version(data.updatedAt), before = await store.adminGet(key);
    return audit.run({ actor, ip, action: 'public-template.delete', target: String(key), kind: 'irreversible', revertible: false, before: metadata(before), after: { action: 'delete' } },
      () => store.change({ id: key, updatedAt, actor, action: 'delete' }));
  }
  return { list, get, save, remove };
}
