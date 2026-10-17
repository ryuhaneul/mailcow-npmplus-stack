import { effect } from '@preact/signals';
import { WM_THEMES as T } from './themes.js';
import { derive as deriveValues, applyAppearance } from './values.js';
import { prefs } from '../state/prefs.js';
let mq;
  function mode() { const st = prefs.value; return st.mode === 'system' ? (mq.matches ? 'dark' : 'light') : st.mode; }
  function layout() { const st = prefs.value; return st.layout || T[st.theme].layout; }
  export { TXT, UI } from './values.js';
  export function derive(theme, m) { return deriveValues(theme, m, prefs.value.accent); }
  export function apply() {
    const st = prefs.value;
    const root = document.documentElement, m = mode(), L = layout();
    const d = applyAppearance(st, m, root);
    root.dataset.pane = L.pane; root.dataset.density = L.density; root.dataset.compose = L.compose;
    document.dispatchEvent(new CustomEvent('webmail:apply', { detail: d }));
    return d;
  }

export function initTheme() {
  mq = matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => { if (prefs.value.mode === 'system') apply(); };
  mq.addEventListener('change', onChange);
  const stop = effect(() => { prefs.value; apply(); });
  return () => { stop(); mq.removeEventListener('change', onChange); };
}
