import { randomBytes } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { AppError } from '../errors.js';
import { encodeRef, decodeRef } from '../mail/ref.js';
import { sanitizeComposeHtml } from '../mail/sanitize.js';

const invalid = () => new AppError(400, 'INVALID_REF', '템플릿 참조를 확인해 주세요.');
export function publicTemplateId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
  return Number(value);
}
export function isPublicTemplateRef(token) {
  const { path } = decodeRef(token);
  return path === 'PublicTemplates' || path.startsWith('PublicTemplates/');
}
export function decodePublicTemplateRef(token) {
  const ref = decodeRef(token), match = /^PublicTemplates\/([1-9]\d*)$/.exec(ref.path);
  if (!match || ref.uidValidity !== 1 || ref.uid !== 1) throw invalid();
  return publicTemplateId(match[1]);
}
const text = html => {
  const fragment = JSDOM.fragment(html);
  for (const node of fragment.querySelectorAll('style,script')) node.remove();
  for (const node of fragment.querySelectorAll('br')) node.replaceWith('\n');
  for (const node of fragment.querySelectorAll('p,div,li,tr')) node.append('\n');
  return fragment.textContent;
};
export function createPublicTemplatesReader({ store, templates, compose, config = {}, configured = true, logger }) {
  const metadata = row => ({ owner: 'public', id: String(row.id), ref: encodeRef(`PublicTemplates/${publicTemplateId(String(row.id))}`, 1, 1),
    name: row.name, subject: row.subject, updatedAt: row.updatedAt, hasAttachments: row.hasAttachments, size: row.size, inShared: false });
  async function list(session) {
    if (!configured) return { items: [], unavailable: false };
    try { return { items: (await store.list(session.email)).items.map(metadata), unavailable: false }; }
    catch (error) {
      logger?.error({ code: 'PUBLIC_TEMPLATES_LIST_FAILED', causeCode: error.code ?? 'UNKNOWN' }, '회사 공용 템플릿을 불러오지 못했습니다.');
      return { items: [], unavailable: true };
    }
  }
  async function get(session, token) {
    const id = decodePublicTemplateRef(token), row = await store.get(session.email, id);
    const html = sanitizeComposeHtml(row.html, { publicHostnames: config.publicHostnames ?? [] });
    return { ...metadata(row), html, text: text(html), attachments: row.attachments.map(file => ({ part: String(file.id), name: file.name, size: file.size, type: file.type })) };
  }
  async function attachments(session, token, input) {
    const id = decodePublicTemplateRef(token), template = await get(session, token);
    return compose.publicTemplateAttachments(session, input, template, fileId => store.file(session.email, id, publicTemplateId(fileId)));
  }
  async function copy(session, token) {
    const template = await get(session, token), composeId = `public-copy-${randomBytes(16).toString('hex')}`;
    const id = decodePublicTemplateRef(token);
    const uploaded = await compose.publicTemplateAttachments(session, { composeId }, template, fileId => store.file(session.email, id, publicTemplateId(fileId)));
    try {
      return await templates.create(session, { name: template.name, subject: template.subject, html: uploaded.html, attachments: uploaded.uploads.map(file => ({ uploadId: file.id })), shared: false });
    } finally {
      const results = await Promise.allSettled(uploaded.uploads.map(file => compose.remove(session, file.id)));
      if (results.some(result => result.status === 'rejected')) logger?.error({ code: 'PUBLIC_TEMPLATE_COPY_CLEANUP_FAILED' }, '공용 템플릿 복사 임시 첨부 정리에 실패했습니다.');
    }
  }
  return { list, get, attachments, copy };
}
