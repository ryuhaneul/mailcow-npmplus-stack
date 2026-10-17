import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ADMIN_PREFS_KEY, adminPrefs, normalizeAdminPrefs, readAdminPrefs, updateAdminPrefs } from '../../web/src/admin/state/prefs.js';
import { WM_THEME_ORDER } from '../../web/src/theme/themes.js';
import { prefs } from '../../web/src/state/prefs.js';
import { derive as webmailDerive, initTheme } from '../../web/src/theme/apply.js';
import { derive, appearanceValues } from '../../web/src/theme/values.js';
import { initAdminTheme } from '../../web/src/admin/theme.js';
const defaults = { theme: 'ink', mode: 'system', accent: {} };
test('admin prefs missing, malformed and invalid values use safe defaults', () => {
  for (const value of [undefined, null, [], 'bad', 4, { theme: '__proto__', mode: 'wrong', accent: { ink: -1, terra: 7, amber: '#fff', olive: {}, seland: 1.2 } }]) assert.deepEqual(normalizeAdminPrefs(value), defaults);
  for (const raw of [null, '{', 'null', '[]']) assert.deepEqual(readAdminPrefs({ getItem: () => raw }), defaults);
  assert.deepEqual(readAdminPrefs({ getItem() { throw Error('blocked'); } }), defaults);
});
test('admin prefs round trip only appearance values and keep per-theme accents', () => {
  let stored; const storage = { setItem(key, value) { assert.equal(key, ADMIN_PREFS_KEY); stored = value; }, getItem: () => stored };
  adminPrefs.value = defaults;
  const next = updateAdminPrefs({ theme: 'terra', mode: 'dark', accent: { ink: 2, terra: '#abcdef', unknown: 1 }, layout: 'ignored' }, storage);
  assert.deepEqual(next, { theme: 'terra', mode: 'dark', accent: { ink: 2, terra: '#abcdef' } });
  assert.deepEqual(readAdminPrefs(storage), next);
  assert.doesNotThrow(() => updateAdminPrefs({ mode: 'light' }, { setItem() { throw Error('blocked'); } }));
  adminPrefs.value = defaults;
});
test('admin and webmail derive identical contrast-corrected appearance for every theme/mode/accent', () => {
  for (const theme of WM_THEME_ORDER) for (const mode of ['light', 'dark']) for (const a of [0, 3, '#777777', '#ffff00', '#000000']) {
    const state = { theme, mode, accent: { [theme]: a }, layout: null }; prefs.value = state;
    assert.deepEqual(webmailDerive(theme, mode), derive(theme, mode, state.accent));
    assert.deepEqual(appearanceValues(state, mode).contrast, webmailDerive(theme, mode));
  }
});
test('admin applies the same CSS variables as webmail before rendering and loads login preferences', () => {
  const dom = new JSDOM('<html/>', { url: 'https://admin.example.com' });
  const keys = ['document', 'matchMedia', 'CustomEvent', 'localStorage'];
  const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: dom.window.document, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  try {
    for (const theme of WM_THEME_ORDER) for (const mode of ['light', 'dark']) {
      const state = { theme, mode, accent: { [theme]: '#777777' }, layout: null }; prefs.value = state;
      const stop = initTheme(), expected = Object.fromEntries(Object.keys(appearanceValues(state, mode).vars).map(key => [key, document.documentElement.style.getPropertyValue(key)])); stop();
      localStorage.setItem(ADMIN_PREFS_KEY, JSON.stringify(state));
      const admin = initAdminTheme();
      for (const [key, value] of Object.entries(expected)) assert.equal(document.documentElement.style.getPropertyValue(key), value, `${theme}/${mode}/${key}`);
      assert.equal(document.documentElement.dataset.theme, theme); assert.equal(document.documentElement.dataset.mode, mode);
      assert.equal(document.documentElement.dataset.stars, theme === 'seland' && mode === 'dark' ? 'on' : 'off'); admin.stop();
    }
  } finally { Object.assign(globalThis, previous); adminPrefs.value = defaults; dom.window.close(); }
});
