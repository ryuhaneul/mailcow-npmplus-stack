import { WM_THEMES as T } from './themes.js';
import { WM_C as C } from './contrast.js';
  /* 강조색: 견본 id(숫자) 또는 '#RRGGBB'(직접 지정). 테마마다 따로 기억 */
  function accentBase(theme, m, accent) {
    const a = accent[theme], th = T[theme];
    if (typeof a === 'string' && /^#[0-9a-f]{6}$/i.test(a)) return a;
    const sw = th.swatches[typeof a === 'number' && th.swatches[a] ? a : 0];
    return m === 'dark' ? sw[2] : sw[1];
  }
  /* 강조색 하나로부터 파생값을 계산: 위 글자색(흑/백), 글자로 쓸 때 색, 옅은 바탕, 선·채움(3:1) */
  export const TXT = 4.6, UI = 3.1;   // 작은 글자 4.5:1 에 여유, 선·채움 3:1 에 여유
  export function derive(theme, m, accent = {}) {
    const th = T[theme], v = th[m];
    const R = c => c.map(Math.round);
    const base0 = C.hex(accentBase(theme, m, accent));
    const surf = C.hex(v['--surface']), sunk = C.hex(v['--sunken']), canv = C.hex(v['--canvas']), ink = C.hex(v['--ink']), hov = C.hex(v['--hover']);
    const sideBg = /^#/.test(v['--side-bg']) ? C.hex(v['--side-bg']) : (v['--side-bg'] === 'transparent' ? canv : surf);
    // 1) 강조색 위 글자: 흰색 / 테마의 어두운 색 / 검정 중 대비가 가장 큰 쪽.
    //    그래도 4.6 이 안 되면(중간 밝기 회색·원색) 단추 바탕을 그 글자의 반대쪽으로 조금 옮긴다
    const white = [255, 255, 255], themeDark = C.hex(m === 'dark' ? v['--canvas'] : v['--ink']), black = [0, 0, 0];
    const cands = [white, themeDark, black].map(c => ({ c, r: C.ratio(base0, c) })).sort((a, b) => b.r - a.r);
    let onAccent = cands[0].c;
    if (onAccent === black && C.ratio(base0, themeDark) >= TXT) onAccent = themeDark;
    let base = base0, bgShift = false;
    if (C.ratio(base0, onAccent) < TXT) {
      const away = C.lum(onAccent) > .5 ? black : white;
      const f = C.fit(base0, [onAccent], TXT, away); base = f.rgb; bgShift = f.t > 0;
    }
    base = R(base);
    const onRatio = C.ratio(base, onAccent);
    // 선택 행 바탕: 강조색을 살짝 섞되, 그 위 흐린 글자(ink-3)·빨강 글자가 4.6 아래로 떨어지면 섞는 양을 줄인다
    let sel = C.hex(v['--sel-n']);
    if (v['--sel-mode'] === 'accent') {
      const ink3 = C.hex(v['--ink-3']), dan = C.hex(v['--danger']);
      for (let t = m === 'dark' ? .14 : .08; t >= 0; t -= .01) { sel = R(C.mix(surf, base, Math.max(t, 0))); if (Math.min(C.ratio(ink3, sel), C.ratio(dan, sel)) >= TXT) break; }
    }
    // 2) 글자로 쓰는 강조색: 표면·움푹면·사이드·선택 행·마우스 올림 바탕 모두에서 4.6
    const bgs = [surf, sunk, sideBg, sel, hov];
    const ink1 = C.fit(base, bgs, TXT, ink);
    // 3) 옅은 강조 바탕(현재 위치·고른 항목) + 그 위 글자
    const soft = R(C.mix(surf, base, m === 'dark' ? .2 : .13));
    const softInk = C.fit(ink1.rgb, [soft], TXT, ink);
    // 4) 채움·선(켜기 단추, 진행 막대, 포커스 테두리): 3.1
    const ui = C.fit(base, [surf, sunk], UI, ink);
    return {
      accent: C.toHex(base), picked: C.toHex(base0), bgShift, onAccent: C.toHex(onAccent), onRatio,
      accentInk: C.toHex(ink1.rgb), inkFixed: ink1.t > 0, inkRatio: Math.min(...bgs.map(b => C.ratio(ink1.rgb, b))),
      soft: C.toHex(soft), softInk: C.toHex(softInk.rgb), softRatio: C.ratio(softInk.rgb, soft),
      ui: C.toHex(ui.rgb), uiFixed: ui.t > 0, sel: C.toHex(sel)
    };
  }

export function appearanceValues(state, mode) {
  const th = T[state.theme], d = derive(state.theme, mode, state.accent);
  const vars = { ...th.shape, ...th[mode], '--accent': d.accent, '--on-accent': d.onAccent,
    '--accent-ink': d.accentInk, '--accent-soft': d.soft, '--accent-soft-ink': d.softInk,
    '--accent-ui': d.ui, '--sel': d.sel, '--focus': d.ui };
  th.labels[mode].forEach((l, i) => { vars['--l' + i + '-bg'] = l[0]; vars['--l' + i + '-ink'] = l[1]; vars['--l' + i + '-dot'] = l[2]; });
  return { vars, contrast: d };
}
export function applyAppearance(state, mode, root = document.documentElement) {
  const { vars, contrast } = appearanceValues(state, mode);
  for (const k in vars) if (k !== '--sel-mode' && k !== '--cbtn-style') root.style.setProperty(k, vars[k]);
  root.dataset.theme = state.theme; root.dataset.mode = mode; root.style.colorScheme = mode;
  root.dataset.cbtn = T[state.theme].shape['--cbtn-style'];
  root.dataset.stars = state.theme === 'seland' && mode === 'dark' ? 'on' : 'off';
  return contrast;
}
