import { api } from '../api.js';
import { sessionReady } from './session.js';
import { signal } from '@preact/signals';
import { WM_THEMES } from '../theme/themes.js';

export const prefs = signal({ theme: 'ink', mode: 'system', accent: {}, layout: null });

// This is a first-paint copy. Server preferences remain authoritative.
export function loadPrefs(config) {
  let copy = {};
  try { copy = JSON.parse(localStorage.getItem('webmail-prefs') || '{}') || {}; } catch {}
  const next = { theme: config.defaultTheme, mode: config.defaultMode, accent: {}, layout: null, ...copy };
  if (!WM_THEMES[next.theme]) next.theme = config.defaultTheme;
  if (!['light', 'dark', 'system'].includes(next.mode)) next.mode = config.defaultMode;
  prefs.value = next;
}

export function applyServerPrefs(value) {
  prefs.value = value;
  try { localStorage.setItem('webmail-prefs', JSON.stringify(value)); } catch {}
}

export async function loadSessionPrefs() {
  const value = await api('/api/prefs');
  applyServerPrefs(value);
  sessionReady.value = true;
}
