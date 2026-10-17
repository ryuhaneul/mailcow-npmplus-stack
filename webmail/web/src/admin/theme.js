import { signal, effect } from '@preact/signals';
import { applyAppearance } from '../theme/values.js';
import { adminPrefs, readAdminPrefs, updateAdminPrefs } from './state/prefs.js';
export const adminMode = { get value() { return adminPrefs.value.mode; }, set value(mode) { updateAdminPrefs({ mode }); } };
export const resolvedAdminMode = signal('light');
export function initAdminTheme() {
  adminPrefs.value = readAdminPrefs();
  const media = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const state = adminPrefs.value, mode = state.mode === 'system' ? media.matches ? 'dark' : 'light' : state.mode;
    const detail = applyAppearance(state, mode);
    resolvedAdminMode.value = mode;
    document.dispatchEvent(new (document.defaultView.CustomEvent)('webmail:apply', { detail }));
  };
  media.addEventListener('change', apply);
  const stop = effect(apply);
  return { apply, toggle() { updateAdminPrefs({ mode: resolvedAdminMode.value === 'dark' ? 'light' : 'dark' }); }, stop() { stop(); media.removeEventListener('change', apply); } };
}
