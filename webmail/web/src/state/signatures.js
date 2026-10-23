import { batch, effect, signal } from '@preact/signals';
import { session } from './session.js';
import { getSignatures, putSignatures, signatureSessionChanged } from '../signatures.js';
import { deleteSignatureImage, getSignatureImages, uploadSignatureImage } from '../signature-images.js';

// Canonical server snapshots only. Editors keep their unsaved input separately.
export const signatures = signal(null);
export const signatureImages = signal(null);
export const selectedSignatureId = signal(null);
let listPending, imagesPending, listVersion = 0, imagesVersion = 0;
effect(() => {
  session.value; listPending = null; imagesPending = null; listVersion++; imagesVersion++;
  batch(() => { signatures.value = null; signatureImages.value = null; selectedSignatureId.value = null; });
});

export function loadSignatures() {
  if (listPending) return listPending;
  const owner = session.value, version = listVersion;
  const pending = getSignatures().then(value => {
    if (session.value !== owner) throw signatureSessionChanged();
    if (version !== listVersion) return signatures.value || loadSignatures();
    signatures.value = value;
    return value;
  }).finally(() => { if (listPending === pending) listPending = null; });
  listPending = pending;
  return pending;
}
export async function saveSignatures(draft) {
  const owner = session.value;
  const value = await putSignatures(draft, draft.revision ?? signatures.value?.revision);
  if (session.value !== owner) throw signatureSessionChanged();
  listVersion++; listPending = null;
  batch(() => {
    signatures.value = value;
    const selected = selectedSignatureId.value;
    const mapped = Object.hasOwn(value.idMap || {}, selected) ? value.idMap[selected] : selected;
    selectedSignatureId.value = value.items.some(item => item.id === mapped) ? mapped : null;
  });
  return value;
}
export function loadSignatureImages() {
  if (imagesPending) return imagesPending;
  const owner = session.value, version = imagesVersion;
  const pending = getSignatureImages().then(value => {
    if (session.value !== owner) throw signatureSessionChanged();
    if (version !== imagesVersion) return signatureImages.value || loadSignatureImages();
    signatureImages.value = value;
    return value;
  }).finally(() => { if (imagesPending === pending) imagesPending = null; });
  imagesPending = pending;
  return pending;
}
export async function addSignatureImage(file) {
  const owner = session.value, previous = signatureImages.value;
  const value = await uploadSignatureImage(file, previous?.revision);
  if (session.value !== owner) throw signatureSessionChanged();
  imagesVersion++; imagesPending = null;
  if (previous) signatureImages.value = { ...previous, revision: value.revision, usedBytes: value.usedBytes, images: [...previous.images.filter(image => image.id !== value.image.id), value.image] };
  if (!previous) await loadSignatureImages();
  return value;
}
export async function removeSignatureImage(id) {
  const owner = session.value, previous = signatureImages.value;
  const value = await deleteSignatureImage(id, previous?.revision);
  if (session.value !== owner) throw signatureSessionChanged();
  imagesVersion++; imagesPending = null;
  if (previous) signatureImages.value = { ...previous, revision: value.revision, usedBytes: value.usedBytes, images: previous.images.filter(image => image.id !== id) };
  if (!previous) await loadSignatureImages();
  return value;
}
