import { WM_C as C } from './contrast.js';

// Relative luminance at the white/black text contrast crossover.
export const DARK_SURFACE_THRESHOLD = 0.179;
export const MAIL_TEXT_CONTRAST = 4.5;
// Raise corrected body text to 7:1 so it does not look faint or disabled.
export const MAIL_TEXT_TARGET_CONTRAST = 7;

export function parseMailColor(value) {
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value.trim())) return [...C.hex(value.trim()), 1];
  const match = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return null;
  const parts = match[1].split(/[,\s/]+/).filter(Boolean);
  return parts.map((part, index) => part.endsWith('%') ? parseFloat(part) / 100 * (index < 3 ? 255 : 1) : Number(part)).concat(parts.length === 3 ? [1] : []);
}

export function effectiveMailBackground(element, fallback) {
  const view = element.ownerDocument.defaultView;
  for (let current = element; current; current = current.parentElement) {
    const color = parseMailColor(view.getComputedStyle(current).backgroundColor);
    if (color && color[3] === 1) return color.slice(0, 3);
  }
  return fallback;
}

export function brightenMailText(color, background, alpha = 1) {
  const painted = rgb => rgb.map((value, index) => value * alpha + background[index] * (1 - alpha));
  if (C.lum(background) >= DARK_SURFACE_THRESHOLD || C.ratio(painted(color), background) >= MAIL_TEXT_CONTRAST) return color;
  const rgb = color.map(value => value / 255), max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = delta === 0 ? 0 : max === rgb[0] ? ((rgb[1] - rgb[2]) / delta) % 6 : max === rgb[1] ? (rgb[2] - rgb[0]) / delta + 2 : (rgb[0] - rgb[1]) / delta + 4;
  hue = (hue + 6) % 6;
  const at = light => {
    const chroma = (1 - Math.abs(2 * light - 1)) * saturation;
    const x = chroma * (1 - Math.abs(hue % 2 - 1)), m = light - chroma / 2;
    const channels = hue < 1 ? [chroma,x,0] : hue < 2 ? [x,chroma,0] : hue < 3 ? [0,chroma,x] : hue < 4 ? [0,x,chroma] : hue < 5 ? [x,0,chroma] : [chroma,0,x];
    return channels.map(value => Math.round((value + m) * 255));
  };
  // Check the rounded RGB that the browser will actually paint.
  for (let step = 1; step <= 1000; step++) {
    const next = at(lightness + (1 - lightness) * step / 1000);
    if (C.ratio(painted(next), background) >= MAIL_TEXT_TARGET_CONTRAST) return next;
  }
  return at(1);
}

export function adjustMailContrast(document, fallback) {
  const view = document.defaultView;
  // Snapshot before writing: a parent override must not change a child's source color.
  const entries = [document.body, ...document.body.querySelectorAll('*')]
    .filter(element => !['STYLE','SCRIPT'].includes(element.tagName) && [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()))
    .map(element => {
      const original = view.getComputedStyle(element).color, color = parseMailColor(original);
      const background = effectiveMailBackground(element, fallback);
      // Keep transparent text transparent; it can be intentional hidden content.
      const next = color && color[3] > 0 ? brightenMailText(color.slice(0, 3), background, color[3]) : null;
      return {element, original, alpha:color?.[3], next, changed: next && next.some((value, index) => value !== color[index])};
    });
  for (const entry of entries) if (entry.changed) entry.element.style.setProperty('color', entry.alpha === 1 ? C.toHex(entry.next) : `rgba(${entry.next.join(',')},${entry.alpha})`, 'important');
  // Preserve inherited source colors inside light blocks when an ancestor was adjusted.
  for (const entry of entries) if (!entry.changed && view.getComputedStyle(entry.element).color !== entry.original) entry.element.style.setProperty('color', entry.original, 'important');
  return entries.filter(entry => entry.changed).length;
}
