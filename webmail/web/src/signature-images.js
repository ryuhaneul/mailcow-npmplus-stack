import { effect } from '@preact/signals';
import { endSession } from './api.js';
import { session } from './state/session.js';
import { signatureError, signatureRequest, signatureSessionChanged } from './signatures.js';

const activeMaps = new Set();
const assetPattern = /^[A-Za-z0-9_-]{32}$/;
const cidPattern = /^cid:wm-sig-v1\.([A-Za-z0-9_-]{32})@signature\.invalid$/;
function assetPath(id) {
  if (!assetPattern.test(id)) throw signatureError({ code: 'SIGNATURE_IMAGE_INVALID' });
  return `/api/signature-images/${id}`;
}
export function signatureImageCid(id) {
  assetPath(id);
  return `cid:wm-sig-v1.${id}@signature.invalid`;
}
export function getSignatureImages() { return signatureRequest('/api/signature-images'); }
export function uploadSignatureImage(file, revision) {
  const body = new FormData();
  body.append('file', file);
  return signatureRequest('/api/signature-images', { method: 'POST', headers: revision == null ? {} : { 'If-Match': revision }, body });
}
export async function deleteSignatureImage(id, revision) {
  const value = await signatureRequest(assetPath(id), { method: 'DELETE', headers: revision == null ? {} : { 'If-Match': revision } });
  for (const map of activeMaps) map.release(id);
  return value;
}
export async function getSignatureImageContent(id) {
  const owner = session.value;
  try {
    const response = await fetch(`${assetPath(id)}/content`, { method: 'GET', credentials: 'same-origin' });
    if (!response.ok) {
      const { error } = await response.json();
      if (session.value !== owner) throw signatureSessionChanged();
      if (['NO_SESSION', 'SESSION_EXPIRED'].includes(error.code) && session.value === owner) endSession(error.code);
      throw { ...error, status: response.status };
    }
    const blob = await response.blob();
    if (session.value !== owner) throw signatureSessionChanged();
    return blob;
  } catch (error) { throw signatureError(error); }
}

// Use one map per editor/preview lifetime. Normalize HTML before projecting it to live DOM.
export function createSignatureImageMap() {
  const entries = new Map(), reverse = new Map();
  let disposed = false, generation = 0;
  function release(id) {
    const entry = entries.get(id);
    if (!entry) return;
    generation++;
    entries.delete(id);
    if (entry.url) { reverse.delete(entry.url); URL.revokeObjectURL(entry.url); }
  }
  function clear() { generation++; for (const id of entries.keys()) release(id); }
  const stop = effect(() => { session.value; clear(); });
  async function urlFor(id) {
    assetPath(id);
    if (disposed) throw signatureSessionChanged();
    if (!entries.has(id)) {
      const entry = {};
      entries.set(id, entry);
      entry.promise = getSignatureImageContent(id).then(blob => {
        if (disposed || entries.get(id) !== entry) throw signatureSessionChanged();
        entry.url = URL.createObjectURL(blob);
        reverse.set(entry.url, signatureImageCid(id));
        return entry.url;
      }).catch(error => { if (entries.get(id) === entry) release(id); throw error; });
    }
    return entries.get(id).promise;
  }
  function fragment(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template;
  }
  function images(root) {
    const result = [...root.querySelectorAll('img')];
    for (const template of root.querySelectorAll('template')) result.push(...images(template.content));
    return result;
  }
  const map = {
    urlFor, release, clear,
    async displayHtml(html) {
      const version = generation;
      const template = fragment(html);
      await Promise.all(images(template.content).map(async img => {
        const match = cidPattern.exec(img.getAttribute('src') || '');
        if (match) img.setAttribute('src', await urlFor(match[1]));
      }));
      if (disposed || version !== generation) throw signatureSessionChanged();
      return template.innerHTML;
    },
    canonicalHtml(html) {
      if (disposed) throw signatureSessionChanged();
      const template = fragment(html);
      for (const img of images(template.content)) {
        const src = img.getAttribute('src') || '';
        if (reverse.has(src)) img.setAttribute('src', reverse.get(src));
        else if (/^blob:/i.test(src.trim())) throw signatureError({ code: 'SIGNATURE_IMAGE_INVALID' });
      }
      return template.innerHTML;
    },
    dispose() { disposed = true; stop(); clear(); activeMaps.delete(map); },
  };
  activeMaps.add(map);
  return map;
}
