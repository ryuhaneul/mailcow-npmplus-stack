import { batch, effect, signal } from '@preact/signals';
import { session } from './session.js';
import { getSignatures, putSignatures, signatureSessionChanged } from '../signatures.js';
import { deleteSignatureImage, getSignatureImages, uploadSignatureImage } from '../signature-images.js';

// Canonical server snapshots only. Editors keep their unsaved input separately.
export const signatures = signal(null);
export const signatureImages = signal(null);
export const selectedSignatureId = signal(null);
effect(() => {
  session.value;
  batch(() => { signatures.value = null; signatureImages.value = null; selectedSignatureId.value = null; });
});

export async function loadSignatures() {
  const owner = session.value;
  const value = await getSignatures();
  if (session.value !== owner) throw signatureSessionChanged();
  signatures.value = value;
  return value;
}
export async function saveSignatures(draft) {
  const owner = session.value;
  const value = await putSignatures(draft, signatures.value?.revision);
  if (session.value !== owner) throw signatureSessionChanged();
  batch(() => {
    signatures.value = value;
    const selected = selectedSignatureId.value;
    const mapped = Object.hasOwn(value.idMap || {}, selected) ? value.idMap[selected] : selected;
    selectedSignatureId.value = value.items.some(item => item.id === mapped) ? mapped : null;
  });
  return value;
}
export async function loadSignatureImages() {
  const owner = session.value;
  const value = await getSignatureImages();
  if (session.value !== owner) throw signatureSessionChanged();
  signatureImages.value = value;
  return value;
}
export async function addSignatureImage(file) {
  const owner = session.value, previous = signatureImages.value;
  const value = await uploadSignatureImage(file, previous?.revision);
  if (session.value !== owner) throw signatureSessionChanged();
  if (previous) signatureImages.value = { ...previous, revision: value.revision, usedBytes: value.usedBytes, images: [...previous.images.filter(image => image.id !== value.image.id), value.image] };
  return value;
}
export async function removeSignatureImage(id) {
  const owner = session.value, previous = signatureImages.value;
  const value = await deleteSignatureImage(id, previous?.revision);
  if (session.value !== owner) throw signatureSessionChanged();
  if (previous) signatureImages.value = { ...previous, revision: value.revision, usedBytes: value.usedBytes, images: previous.images.filter(image => image.id !== id) };
  return value;
}
