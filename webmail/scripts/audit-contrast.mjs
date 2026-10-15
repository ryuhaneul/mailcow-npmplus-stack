import { WM_THEMES, WM_THEME_ORDER } from '../web/src/theme/themes.js';
import { WM_C as C } from '../web/src/theme/contrast.js';
import { derive, TXT, UI } from '../web/src/theme/apply.js';
import { prefs } from '../web/src/state/prefs.js';

// Seven reference swatches and eight extreme custom accents, per theme and mode.
const extremes = ['#000000', '#FFFFFF', '#808080', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF'];
const failures = [];
let combinations = 0, checks = 0;
function check(name, foreground, background, target, context) {
  const ratio = C.ratio(C.hex(foreground), C.hex(background));
  checks++;
  if (ratio < target) failures.push({ ...context, name, foreground, background, ratio, target });
}
for (const theme of WM_THEME_ORDER) {
  const th = WM_THEMES[theme];
  for (const mode of ['light', 'dark']) {
    for (const accent of [...th.swatches.map((_, i) => i), ...extremes]) {
      combinations++;
      const context = { theme, mode, accent };
      prefs.value = { theme, mode, accent: { [theme]: accent }, layout: null };
      const v = th[mode], d = derive(theme, mode);
      const side = /^#/.test(v['--side-bg']) ? v['--side-bg'] : v[v['--side-bg'] === 'transparent' ? '--canvas' : '--surface'];
      const backgrounds = [v['--surface'], v['--sunken'], side, d.sel, v['--hover']];
      check('on-accent', d.onAccent, d.accent, TXT, context);
      check('soft-ink', d.softInk, d.soft, TXT, context);
      for (const background of backgrounds) {
        check('accent-ink', d.accentInk, background, TXT, context);
        for (const key of ['--ink', '--ink-2', '--ink-3', '--danger']) check(key, v[key], background, 4.5, context);
      }
      for (const key of ['--surface', '--sunken']) check('accent-ui', d.ui, v[key], UI, context);
      check('on-danger', v['--on-danger'], v['--danger'], 4.5, context);
      check('warning-quota', v['--warn'], side, 4.5, context);
      check('warning-banner', v['--warn'], v['--warn-bg'], 4.5, context);
      check('danger-banner', v['--danger'], v['--danger-bg'], 4.5, context);
      check('mark', v['--mark-ink'], v['--mark'], 4.5, context);
      th.labels[mode].forEach(([background, foreground], i) => check(`label-${i}`, foreground, background, 4.5, context));
    }
  }
}
console.log(JSON.stringify({ combinations, checks, failures: failures.length, details: failures }, null, 2));
if (failures.length) process.exitCode = 1;
