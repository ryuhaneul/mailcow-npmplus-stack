import { JSDOM } from 'jsdom';
import { AppError } from '../errors.js';
import { sanitizeComposeHtml } from '../mail/sanitize.js';
import { MAX_SIGNATURES_BYTES } from '../signatures.js';
import { withSignatureStoreLock } from '../signature-store-lock.js';

const invalid = () => new AppError(422, 'SIGNATURE_INVALID', '서명 형식을 확인해 주세요.');
const unavailable = () => new AppError(503, 'SIGNATURE_SERVICE_UNAVAILABLE', '서명 저장을 준비하지 못했어요.');
const checkSize = value => {
  if (Buffer.byteLength(value) > MAX_SIGNATURES_BYTES) throw new AppError(413, 'SIGNATURES_TOO_LARGE', '서명 저장 용량을 넘었어요. 서명 크기를 줄여 주세요.');
};

// The caller owns the account queue and mailbox lock, including on list PUT.
export function createSignatureNormalizer({ config, images }) {
  return async function normalizeHtml({ client, html }) {
    if (typeof html !== 'string') throw invalid();
    checkSize(html);
    const fragment = JSDOM.fragment(html), references = new Set();
    function inspect(root) {
      for (const element of root.querySelectorAll('*')) {
        // Reader-only mappings and arbitrary data attributes are never storage input.
        for (const attribute of [...element.attributes]) if (attribute.name.startsWith('data-')) element.removeAttribute(attribute.name);
        if (element.tagName === 'TEMPLATE') inspect(element.content);
        if (element.tagName !== 'IMG') continue;
        const src = (element.getAttribute('src') ?? '').trim();
        const scheme = src.replace(/[\x00-\x20\x7f]/g, '');
        if (/^data:/i.test(scheme)) throw new AppError(422, 'SIGNATURE_DATA_IMAGE', '이미지는 보관함에서 넣어 주세요.');
        let decoded = scheme;
        try { decoded = decodeURIComponent(scheme); } catch { /* malformed CID is rejected by the exact check below */ }
        if (/^cid:/i.test(scheme) || /^cid:/i.test(decoded)) {
          const match = /^cid:wm-sig-v1\.([A-Za-z0-9_-]{32})@signature\.invalid$/.exec(src);
          if (!match) throw new AppError(422, 'SIGNATURE_IMAGE_INVALID', '보관함에서 넣은 서명 이미지를 확인해 주세요.');
          references.add(match[1]);
        }
      }
    }
    inspect(fragment);
    if (references.size) {
      if (typeof images?.read !== 'function') throw unavailable();
      const doc = await images.read(client);
      for (const id of references) if (!Object.hasOwn(doc.images, id)) throw new AppError(422, 'SIGNATURE_IMAGE_NOT_FOUND', '서명 이미지가 보관함에 없어요. 다시 넣어 주세요.');
    }
    const container = fragment.ownerDocument.createElement('div');
    container.append(fragment);
    const clean = sanitizeComposeHtml(container.innerHTML, { publicHostnames: config.publicHostnames });
    checkSize(clean);
    return clean;
  };
}

export default async function signaturesRoutes(app, { service, normalizeHtml, imap }) {
  const parse = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    parse(request, body, (error, value) => done(error ? invalid() : null, value));
  });
  app.get('/api/signatures', request => service.get(request.session));
  app.put('/api/signatures', { bodyLimit: MAX_SIGNATURES_BYTES, errorHandler(error) {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') throw new AppError(413, 'SIGNATURES_TOO_LARGE', '서명 저장 용량을 넘었어요. 서명 크기나 새 메일 기본 서명을 줄여 주세요.');
    throw error;
  } }, request => service.put(request.session, request.body, request.headers['if-match']));
  app.post('/api/signatures/normalize', { bodyLimit: MAX_SIGNATURES_BYTES }, async request => {
    const body = request.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'html') || typeof body.html !== 'string') throw invalid();
    if (typeof normalizeHtml !== 'function' || typeof imap?.withMailbox !== 'function') throw unavailable();
    return withSignatureStoreLock(request.session.email, async () => {
      try {
        const html = await imap.withMailbox(request.session, 'INBOX', client => normalizeHtml({ session: request.session, client, html: body.html }));
        if (typeof html !== 'string') throw unavailable();
        return { html };
      } catch (error) {
        if (error instanceof AppError && error.statusCode !== 502) throw error;
        throw new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
      }
    });
  });
}
