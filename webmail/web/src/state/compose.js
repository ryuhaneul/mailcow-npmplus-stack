import { folders } from './folders.js';
import { signal } from '@preact/signals';
import { navigate } from '../router.js';
export const composeSeed = signal(null);
export const pendingSend = signal(null);
export const sendResultNotice = signal(null);
export const detachedSendAttempts = signal([]);
const pendingKey = 'webmail.pending-sends', legacyKey = 'webmail.pending-send';
let records = [];
function storeRecords(value) {
  records = value.slice(-20);
  detachedSendAttempts.value = detachedSendAttempts.value.filter(item => records.some(record => record.composeId === item.composeId));
  try {
    if (records.length) sessionStorage.setItem(pendingKey, JSON.stringify(records));
    else sessionStorage.removeItem(pendingKey);
    sessionStorage.removeItem(legacyKey);
  } catch { /* Live receipts remain available when storage is disabled. */ }
}
export function hasPendingSendAttempt() {
  try { return Boolean(sessionStorage.getItem(pendingKey) || sessionStorage.getItem(legacyKey)); } catch { return false; }
}
const accountHash = async email => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase())))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
export async function rememberSendAttempt(composeId, email) {
  const record = { composeId, accountHash: await accountHash(email), recordedAt: Date.now() };
  storeRecords([...records.filter(item => item.composeId !== composeId && item.accountHash === record.accountHash), record]);
  pendingSend.value = { ...record, status: 'checking' };
}
export function clearSendAttempt(composeId = pendingSend.value?.composeId) {
  if (pendingSend.value?.composeId === composeId) pendingSend.value = null;
  storeRecords(records.filter(item => item.composeId !== composeId));
}
export function detachSendAttempt(composeId) {
  const record = records.find(item => item.composeId === composeId);
  if (pendingSend.value?.composeId === composeId) pendingSend.value = null;
  if (record && !detachedSendAttempts.value.some(item => item.composeId === composeId)) detachedSendAttempts.value = [...detachedSendAttempts.value, record];
}
export async function restoreSendAttempt(email) {
  let stored;
  try { stored = JSON.parse(sessionStorage.getItem(pendingKey) || sessionStorage.getItem(legacyKey)); } catch { storeRecords([]); return null; }
  const hash = await accountHash(email);
  const valid = (Array.isArray(stored) ? stored : stored ? [stored] : []).filter(record =>
    /^[a-zA-Z0-9_-]{1,128}$/.test(record?.composeId || '') && record.accountHash === hash
  ).map(record => ({ composeId: record.composeId, accountHash: hash, recordedAt: Number.isFinite(record.recordedAt) ? record.recordedAt : Date.now() }));
  storeRecords(valid.sort((a,b)=>a.recordedAt-b.recordedAt));
  const [record, ...remaining] = records;
  detachedSendAttempts.value = remaining;
  pendingSend.value = record ? { ...record, status: 'checking' } : null;
  return record || null;
}
export function startCompose(kind, message) {if(!pendingSend.value&&!sendResultNotice.value)composeSeed.value={kind,message};navigate('compose');}
export function openMessage(item) {
  const folder=folders.value.folders.find(folder=>folder.path===item.folder);
  if(folder?.specialUse==='\\Drafts'&&!folder.shared&&!/^(Shared|WebmailVirtual)(\/|$)/.test(item.folder))startCompose('draft',{ref:item.ref});
  else navigate(`read/${encodeURIComponent(item.ref)}`);
}
