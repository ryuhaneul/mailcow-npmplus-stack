export const WM_C = (function () {
  function hex(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); }
  function toHex(rgb) { return '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase(); }
  function lum(rgb) { const a = rgb.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * a[0] + .7152 * a[1] + .0722 * a[2]; }
  function ratio(a, b) { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05); }
  function mix(a, b, t) { return a.map((v, i) => v + (b[i] - v) * t); }
  /* c 를 bgs 전부에 대해 target 이상이 되도록, toward 쪽으로 조금씩 섞는다. toward 는 그 모드의 본문 글자색(항상 통과).
     화면에 실제로 칠해지는 값(반올림한 RGB)으로 잰다 */
  function fit(c, bgs, target, toward) {
    for (let t = 0; t <= 1.0001; t += .02) { const m = mix(c, toward, Math.min(t, 1)).map(Math.round); if (Math.min(...bgs.map(b => ratio(m, b))) >= target) return { rgb: m, t }; }
    return { rgb: toward.map(Math.round), t: 1 };
  }
  return { hex, toHex, lum, ratio, mix, fit };
})();

