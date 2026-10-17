import { signal } from '@preact/signals';
import { WM_THEMES, WM_THEME_ORDER } from '../../theme/themes.js';
export const ADMIN_PREFS_KEY = 'webmail-admin-prefs';
export function normalizeAdminPrefs(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const accent = {};
  if (source.accent && typeof source.accent === 'object' && !Array.isArray(source.accent)) {
    for (const key of WM_THEME_ORDER) {
      const a = source.accent[key];
      if (typeof a === 'string' && /^#[0-9a-f]{6}$/i.test(a) || Number.isInteger(a) && a >= 0 && a < WM_THEMES[key].swatches.length) accent[key] = a;
    }
  }
  return { theme: WM_THEME_ORDER.includes(source.theme) ? source.theme : 'ink', mode: ['system', 'light', 'dark'].includes(source.mode) ? source.mode : 'system', accent };
}
export function readAdminPrefs(storage = globalThis.localStorage) {
  try { return normalizeAdminPrefs(JSON.parse(storage.getItem(ADMIN_PREFS_KEY))); } catch { return normalizeAdminPrefs(); }
}
export const adminPrefs = signal(normalizeAdminPrefs());
export function updateAdminPrefs(patch, storage = globalThis.localStorage) {
  const next = normalizeAdminPrefs({ ...adminPrefs.value, ...patch });
  adminPrefs.value = next;
  try { storage.setItem(ADMIN_PREFS_KEY, JSON.stringify(next)); } catch {}
  return next;
}
