// Theme: follows the system until the user picks one; a manual choice is kept in localStorage (tk-theme).
// The decorative star background is loaded only while the theme is dark (ported from landing-hub theme.js).
(function () {
  var root = document.documentElement;
  var background = document.getElementById('starflow-background');
  var btn = document.getElementById('themeBtn');
  var mq = matchMedia('(prefers-color-scheme: dark)');
  var scroller = document.querySelector('.page-shell > .scroll-content');

  // The button is icon-only, so its name carries both the current state and the next action.
  var LABELS = {
    ko: { dark: '현재 다크 테마, 라이트 테마로 전환', light: '현재 라이트 테마, 다크 테마로 전환' },
    en: { dark: 'Dark theme active, switch to light theme', light: 'Light theme active, switch to dark theme' },
    ja: { dark: '現在ダークテーマ、ライトテーマに切り替え', light: '現在ライトテーマ、ダークテーマに切り替え' }
  };

  function syncScrollbar() {
    if (scroller) scroller.parentElement.style.setProperty(
      '--scrollbar-width', (scroller.offsetWidth - scroller.clientWidth) + 'px');
  }

  // Track viewport resizing and a scrollbar appearing as content expands.
  if (scroller) new ResizeObserver(syncScrollbar).observe(scroller);

  function sync() {
    var dark = root.dataset.theme === 'dark';
    if (background) {
      if (dark && !background.hasAttribute('src')) {
        background.src = background.dataset.src;
      } else if (!dark && background.hasAttribute('src')) {
        background.removeAttribute('src');
      }
    }
    var labels = LABELS[root.lang] || LABELS.en;
    if (btn) btn.setAttribute('aria-label', dark ? labels.dark : labels.light);
  }

  // Until a manual choice is made, follow system theme changes live.
  mq.addEventListener('change', function (e) {
    if (localStorage.getItem('tk-theme')) return;
    root.dataset.theme = e.matches ? 'dark' : 'light';
    sync();
  });

  if (btn) {
    btn.addEventListener('click', function () {
      var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      localStorage.setItem('tk-theme', next);
      sync();
    });
  }

  // translations.js sets <html lang> on DOMContentLoaded and on every language switch.
  document.addEventListener('DOMContentLoaded', sync);
  document.addEventListener('langchange', sync);

  sync();
  syncScrollbar();
})();
