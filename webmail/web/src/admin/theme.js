import { signal } from '@preact/signals';
import { WM_THEMES } from '../theme/themes.js';
export const adminMode = signal('system'), resolvedAdminMode = signal('light');
export function initAdminTheme() {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => { const mode = adminMode.value === 'system' ? media.matches ? 'dark' : 'light' : adminMode.value, theme = WM_THEMES.ink;
    const vars = { ...theme.shape, ...theme[mode], '--accent': theme.swatches[0][mode === 'dark' ? 2 : 1], '--on-accent': theme[mode]['--ink'] === '#141416' ? '#FFFFFF' : '#141416' };
    vars['--accent-ui'] = vars['--accent']; vars['--focus'] = vars['--accent'];
    for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value);
    resolvedAdminMode.value = mode; document.documentElement.dataset.theme = 'ink'; document.documentElement.dataset.mode = mode; document.documentElement.style.colorScheme = mode;
  };
  media.addEventListener('change', apply); apply();
  return { apply, toggle() { adminMode.value = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark'; apply(); }, stop() { media.removeEventListener('change', apply); } };
}
