import { folders } from './folders.js';
import { signal } from '@preact/signals';
import { navigate } from '../router.js';
export const composeSeed = signal(null);
export const pendingSend = signal(null);
export const sendResultNotice = signal(null);
const pendingKey = 'webmail.pending-send';
export function hasPendingSendAttempt() {
  try { return Boolean(sessionStorage.getItem(pendingKey)); } catch { return false; }
}
const accountHash = async email => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase())))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
export async function rememberSendAttempt(composeId, email) {
  const record = { composeId, accountHash: await accountHash(email) };
  pendingSend.value = { ...record, status: 'checking' };
  try { sessionStorage.setItem(pendingKey, JSON.stringify(record)); } catch { /* The live result remains available if storage is disabled. */ }
}
export function clearSendAttempt() {
  pendingSend.value = null;
  try { sessionStorage.removeItem(pendingKey); } catch {}
}
export async function restoreSendAttempt(email) {
  let record;
  try { record = JSON.parse(sessionStorage.getItem(pendingKey)); } catch { clearSendAttempt(); return null; }
  if (!record) return null;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(record.composeId || '') || !/^[a-f0-9]{64}$/.test(record.accountHash || '') || record.accountHash !== await accountHash(email)) {
    clearSendAttempt(); return null;
  }
  pendingSend.value = { ...record, status: 'checking' };
  return record;
}
export function startCompose(kind, message) {if(!pendingSend.value&&!sendResultNotice.value)composeSeed.value={kind,message};navigate('compose');}
export function openMessage(item) {
  const folder=folders.value.folders.find(folder=>folder.path===item.folder);
  if(folder?.specialUse==='\\Drafts'&&!folder.shared&&!/^(Shared|WebmailVirtual)(\/|$)/.test(item.folder))startCompose('draft',{ref:item.ref});
  else navigate(`read/${encodeURIComponent(item.ref)}`);
}
