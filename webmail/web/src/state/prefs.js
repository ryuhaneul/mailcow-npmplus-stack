import { api } from '../api.js';
import { session, sessionReady } from './session.js';
import { signal } from '@preact/signals';
import { toast } from './toast.js';
import { WM_THEMES } from '../theme/themes.js';

export const prefs = signal({ theme: 'ink', mode: 'system', accent: {}, layout: null, pinnedFolders: [], pinPosition: 'mine', sharedView: {} });

// This is a first-paint copy. Server preferences remain authoritative.
export function loadPrefs(config) {
  let copy = {};
  try { copy = JSON.parse(localStorage.getItem('webmail-prefs') || '{}') || {}; } catch {}
  const next = { theme: config.defaultTheme, mode: config.defaultMode, accent: {}, layout: null, pinnedFolders: [], pinPosition: 'mine', sharedView: {}, ...copy };
  if (!WM_THEMES[next.theme]) next.theme = config.defaultTheme;
  if (!['light', 'dark', 'system'].includes(next.mode)) next.mode = config.defaultMode;
  prefs.value = next;
}

export function applyServerPrefs(value) {
  clearTimeout(saveTimer);
  if (prefsOwner !== session.value) { pending = {}; inFlight = {}; prefsOwner = session.value; }
  confirmed = structuredClone(value);
  prefs.value = { ...value, ...inFlight, ...pending };
  if (Object.keys(pending).length) saveTimer = setTimeout(savePrefs, 500);
  try { localStorage.setItem('webmail-prefs', JSON.stringify(value)); } catch {}
}

export async function loadSessionPrefs() {
  const value = await api('/api/prefs');
  applyServerPrefs(value);
  sessionReady.value = true;
}

// Coalesce changed fields only; unrelated server preferences remain authoritative.
let confirmed, saveTimer, saving = false, pending = {}, inFlight = {}, prefsOwner;
export const prefsSaving = signal(false);
export const prefsSaved = signal(null);
export function updatePrefs(patch) {
  if (!confirmed) confirmed = structuredClone(prefs.value);
  prefs.value = { ...prefs.value, ...patch };
  pending = { ...pending, ...structuredClone(patch) };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePrefs, 500);
}
async function savePrefs() {
  if (saving) return;
  const owner = session.value;
  if (!owner || !sessionReady.value) return;
  const patch = pending;
  if (!Object.keys(patch).length) return;
  pending = {}; inFlight = patch;
  saving = true; prefsSaving.value = true;
  try {
    await api('/api/prefs', { method: 'PUT', body: patch });
    const saved = await api('/api/prefs');
    if (session.value !== owner) return;
    confirmed = saved; inFlight = {};
    prefsSaved.value = { patch, saved };
    prefs.value = { ...saved, ...pending };
    try { localStorage.setItem('webmail-prefs', JSON.stringify(saved)); } catch {}
  } catch (error) {
    if (session.value !== owner) return;
    clearTimeout(saveTimer); pending = {}; inFlight = {};
    prefs.value = structuredClone(confirmed);
    toast.value = { kind: 'error', message: error.message || '설정을 저장하지 못했어요. 이전 설정으로 되돌렸어요.' };
  } finally {
    saving = false; prefsSaving.value = false;
    if (Object.keys(pending).length) {
      clearTimeout(saveTimer); saveTimer = setTimeout(savePrefs, 500);
    }
  }
}

export function updateSharedView(sharedView) {
  updatePrefs({ sharedView });
}
