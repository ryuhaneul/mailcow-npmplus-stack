import { effect, signal } from '@preact/signals';
import { normalizeSignature, signatureSessionChanged, signatureRequest } from '../signatures.js';
import { getSignatureImageContent } from '../signature-images.js';
import { checkServerSession } from '../api.js';
import { session, verifiedSession, sessionResourceEpoch } from './session.js';
import { signatures, signatureImages, loadSignatures, loadSignatureImages } from './signatures.js';

export const MAX_COMPOSE_IMAGE_BYTES = 5 * 1024 * 1024;
export const composeIdentities = signal(null);
let identityPending, preloadPending, identityGeneration = 0, generation = 0, byteCount = 0;
const normalized = new Map(), bytes = new Map(), imagePending = new Map();
export function senderDomain(email) { return String(email ?? '').split('@')[1] || ''; }
function clearAssets() {
  generation++; byteCount = 0; normalized.clear(); bytes.clear(); imagePending.clear();
}
effect(() => {
  session.value; sessionResourceEpoch.value;
  composeIdentities.value = null; identityPending = null; preloadPending = null; identityGeneration++; clearAssets();
});

export function loadComposeIdentities() {
  if (identityPending) return identityPending;
  const owner = session.value, epoch = sessionResourceEpoch.value, version = identityGeneration;
  const pending = signatureRequest('/api/compose/identities').then(value => {
    if (session.value !== owner) throw signatureSessionChanged();
    if (epoch !== sessionResourceEpoch.value) throw signatureSessionChanged();
    if (version !== identityGeneration) return composeIdentities.value || loadComposeIdentities();
    composeIdentities.value = value;
    return value;
  }).finally(() => { if (identityPending === pending) identityPending = null; });
  identityPending = pending;
  return pending;
}
export function refreshComposeIdentities() {
  identityGeneration++; identityPending = null;
  return loadComposeIdentities();
}
export async function composeImageContent(id) {
  if (bytes.has(id)) return bytes.get(id);
  if (imagePending.has(id)) return imagePending.get(id);
  const at = generation, epoch = sessionResourceEpoch.value;
  const pending = getSignatureImageContent(id).then(blob => {
    if (epoch !== sessionResourceEpoch.value) throw signatureSessionChanged();
    if (generation === at && byteCount + blob.size <= MAX_COMPOSE_IMAGE_BYTES) { bytes.set(id, blob); byteCount += blob.size; }
    return blob;
  }).finally(() => { if (imagePending.get(id) === pending) imagePending.delete(id); });
  imagePending.set(id, pending);
  return pending;
}
export async function prepareComposeSignature(document, id) {
  const epoch = sessionResourceEpoch.value;
  const item = document.items.find(item => item.id === id);
  if (!item) return document;
  const key = JSON.stringify([id, item.html]);
  if (!normalized.has(key)) {
    const pending = normalizeSignature(item.html).then(value => {
      return value.html;
    }).catch(error => { if (normalized.get(key) === pending) normalized.delete(key); throw error; });
    normalized.set(key, pending);
  }
  const html = await normalized.get(key);
  if (epoch !== sessionResourceEpoch.value) throw signatureSessionChanged();
  return { ...document, items: document.items.map(value => value.id === id ? { ...value, html } : value) };
}
// Settings save/load signals invalidate prepared content. Warm each default independently:
// a slow image for a different address must not hold up the current composition.
effect(() => {
  const document = signatures.value, library = signatureImages.value, owner = session.value;
  clearAssets();
  if (!owner || !document || !library) return;
  const ids = new Set(Object.values(document.defaults).flatMap(value => [value.newDefault, value.replyDefault]).filter(Boolean));
  for (const id of ids) void prepareComposeSignature(document, id).then(prepared => {
    if (session.value !== owner || signatures.value !== document || signatureImages.value !== library) return;
    const html = prepared.items.find(item => item.id === id)?.html || '';
    const images = new Set([...html.matchAll(/cid:wm-sig-v1\.([A-Za-z0-9_-]{32})@signature\.invalid/g)].map(match => match[1]));
    return Promise.all([...images].map(composeImageContent));
  }).catch(() => {});
});
async function readComposeResources() {
  const [identities, assets] = await Promise.all([
    composeIdentities.value || loadComposeIdentities(),
    Promise.all([signatures.value || loadSignatures(), signatureImages.value || loadSignatureImages()])
      .then(([signatures, images]) => ({ signatures, images })).catch(error => ({ error })),
  ]);
  return { identities, assets };
}
export function preloadComposeResources() {
  if (preloadPending) return preloadPending;
  const pending = readComposeResources().finally(() => { if (preloadPending === pending) preloadPending = null; });
  preloadPending = pending;
  return pending;
}
export async function getComposeResources() {
  const owner = session.value;
  if (!owner || verifiedSession.value !== owner) await checkServerSession();
  if (session.value !== owner || !owner || verifiedSession.value !== owner) throw signatureSessionChanged();
  const epoch = sessionResourceEpoch.value;
  if (preloadPending) {
    try {
      const value = await preloadPending;
      if (session.value !== owner || epoch !== sessionResourceEpoch.value) throw signatureSessionChanged();
      if (!value.assets.error) return value;
    } catch (error) { if (session.value !== owner || epoch !== sessionResourceEpoch.value) throw error; }
    if (session.value !== owner) throw signatureSessionChanged();
  }
  const value = await readComposeResources();
  if (session.value !== owner || epoch !== sessionResourceEpoch.value) throw signatureSessionChanged();
  return value;
}
export function refreshComposeResources() {
  return Promise.allSettled([loadComposeIdentities(), loadSignatures(), loadSignatureImages()]);
}
