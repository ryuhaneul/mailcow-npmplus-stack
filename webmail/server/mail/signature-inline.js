import { JSDOM } from 'jsdom';
import { AppError } from '../errors.js';

const opaqueId = /^[A-Za-z0-9_-]{32}$/;
const tokenPattern = /^cid:wm-compose-v1\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{32})@signature\.invalid$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new AppError(422, 'SIGNATURE_INVALID', '서명 형식을 확인해 주세요.');

// Collision checks are deliberately broader than the exact, case-sensitive token match.
function collisionKey(value) {
  try { value = decodeURIComponent(value); } catch { /* Keep malformed old CIDs unchanged. */ }
  return value.trim().replace(/^cid:/i, '').replace(/^<|>$/g, '').toLowerCase();
}

// images is the caller's validated, account-owned signature-images document.images
// snapshot. No storage, random source, URL loading or mutation occurs here.
export function prepareSignatureInline({ html, signatureImages = [], images = {}, existingCids = [], nonce }) {
  if (typeof html !== 'string' || !Array.isArray(signatureImages) || !object(images) || !Array.isArray(existingCids) || existingCids.some(cid => typeof cid !== 'string') || typeof nonce !== 'string' || nonce.length !== 32 || !opaqueId.test(nonce)) throw invalid();
  const manifest = new Map();
  for (const entry of signatureImages) {
    if (!object(entry) || Object.keys(entry).length !== 2 || typeof entry.token !== 'string' || typeof entry.assetId !== 'string') throw invalid();
    const match = tokenPattern.exec(entry.token);
    if (!match || match[0] !== entry.token || match[2] !== entry.assetId || manifest.has(entry.token)) throw invalid();
    manifest.set(entry.token, entry.assetId);
  }
  const dom = new JSDOM(html, { includeNodeLocations: true });
  try {
    const document = dom.window.document, occupied = new Set(existingCids.map(collisionKey));
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        if (/^cid:/i.test(attribute.value.trim())) occupied.add(collisionKey(attribute.value));
      }
    }
    const occurrences = [], seen = new Set();
    for (const element of document.querySelectorAll('img[src]')) {
      const token = element.getAttribute('src');
      if (element.closest('blockquote') || !manifest.has(token)) continue;
      const location = dom.nodeLocation(element)?.attrs?.src;
      if (!location) continue;
      // Do not turn entity-encoded spellings into a match or reserialize old mail.
      const source = html.slice(location.startOffset, location.endOffset);
      const attribute = /^([^\s=]+\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s]*))$/s.exec(source);
      if (!attribute || (attribute[2] ?? attribute[3] ?? attribute[4]) !== token) continue;
      const start = location.startOffset + attribute[1].length + (attribute[4] === undefined ? 1 : 0);
      occurrences.push({ token, start, end: start + token.length });
      seen.add(token);
    }
    if (seen.size !== manifest.size) throw invalid();
    const parts = [], byAsset = new Map();
    let totalBytes = 0, sequence = 0;
    for (const assetId of manifest.values()) {
      if (byAsset.has(assetId)) continue;
      if (!Object.hasOwn(images, assetId)) throw new AppError(422, 'SIGNATURE_IMAGE_NOT_FOUND', '서명 이미지가 보관함에 없어요. 다시 넣어 주세요.');
      const image = images[assetId], content = Buffer.from(image.base64, 'base64');
      let cid;
      do { cid = `wm-inline-v1.${nonce}.${++sequence}@signature.invalid`; } while (occupied.has(collisionKey(cid)));
      occupied.add(collisionKey(cid));
      byAsset.set(assetId, cid);
      parts.push({ filename: image.name, contentType: image.contentType, content, cid, contentDisposition: 'inline' });
      totalBytes += content.length;
    }
    let output = html;
    for (const { token, start, end } of occurrences.sort((a, b) => b.start - a.start)) {
      output = output.slice(0, start) + `cid:${byAsset.get(manifest.get(token))}` + output.slice(end);
    }
    return { html: output, parts, totalBytes };
  } finally { dom.window.close(); }
}
