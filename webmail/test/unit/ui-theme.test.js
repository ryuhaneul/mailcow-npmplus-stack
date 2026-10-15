import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WM_THEMES, WM_THEME_ORDER } from '../../web/src/theme/themes.js';
import { prefs, loadPrefs, applyServerPrefs } from '../../web/src/state/prefs.js';
import { initTheme, derive } from '../../web/src/theme/apply.js';

test('theme engine applies all attributes and follows system changes', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://newmail.example.com' });
  let change;
  const media = { matches: false, addEventListener(_type, listener) { change = listener; }, removeEventListener() {} };
  const previous = Object.fromEntries(['document', 'CustomEvent', 'localStorage', 'matchMedia'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: dom.window.document, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage, matchMedia: () => media });
  let stop;
  try {
    localStorage.setItem('webmail-prefs', JSON.stringify({ theme: 'seland', mode: 'system', accent: {}, layout: null }));
    loadPrefs({ defaultTheme: 'ink', defaultMode: 'system' });
    stop = initTheme();
    const root = document.documentElement;
    assert.equal(root.dataset.mode, 'light');
    media.matches = true; change();
    assert.equal(root.dataset.mode, 'dark');
    assert.equal(root.dataset.stars, 'on');
    for (const theme of WM_THEME_ORDER) for (const mode of ['light', 'dark']) {
      prefs.value = { theme, mode, accent: { [theme]: '#808080' }, layout: null };
      assert.equal(root.dataset.theme, theme);
      assert.equal(root.dataset.mode, mode);
      assert.equal(root.dataset.stars, theme === 'seland' && mode === 'dark' ? 'on' : 'off');
      for (const key of ['pane', 'density', 'compose']) assert.equal(root.dataset[key], WM_THEMES[theme].layout[key]);
      assert.equal(root.dataset.cbtn, WM_THEMES[theme].shape['--cbtn-style']);
      assert.equal(root.style.getPropertyValue('--accent'), derive(theme, mode).accent);
      assert.equal(root.style.getPropertyValue('--l0-bg'), WM_THEMES[theme].labels[mode][0][0]);
    }
    const server = { theme: 'terra', mode: 'light', accent: {}, layout: { pane: 'right', density: 'compact', compose: 'full' } };
    applyServerPrefs(server);
    assert.equal(root.dataset.density, 'compact');
    assert.deepEqual(JSON.parse(localStorage.getItem('webmail-prefs')), server);
  } finally {
    stop?.(); dom.window.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
