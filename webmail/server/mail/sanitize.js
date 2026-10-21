import createDOMPurify from 'dompurify';
import { JSDOM, VirtualConsole } from 'jsdom';

const window = new JSDOM('', { virtualConsole: new VirtualConsole() }).window;
const purify = createDOMPurify(window);
const tags = ['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'style', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'];
const attrs = ['href', 'src', 'alt', 'title', 'width', 'height', 'style', 'class', 'align', 'valign', 'bgcolor', 'color', 'face', 'size', 'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border'];
// CSS escapes and comments must not hide a resource-loading or executable value.
function safeCss(value) {
  const decoded = value.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff))).replace(/\\(.)/gs, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
  return !/url\s*\(|@import|expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/i.test(decoded);
}
function cleanDeclarations(style) {
  for (const name of Array.from(style)) if (!safeCss(`${name}:${style.getPropertyValue(name)}`)) style.removeProperty(name);
}
function cleanStyle(text) {
  const doc = window.document;
  const style = doc.createElement('style'); style.textContent = text; doc.head.append(style);
  try {
    const rules = style.sheet?.cssRules;
    if (!rules) return '';
    for (let i = rules.length - 1; i >= 0; i--) {
      if (!safeCss(rules[i].cssText)) style.sheet.deleteRule(i);
    }
    // CSSOM may decode escapes into HTML tag boundaries during serialization.
    return Array.from(style.sheet.cssRules, rule => rule.cssText).join('\n').replace(/</g, '\\3c ');
  } catch { return ''; } finally { style.remove(); }
}
export function sanitizeHtml(html, { ref, cidParts = new Map(), images = false } = {}) {
  const fragment = purify.sanitize(html, { ALLOWED_TAGS: tags, ALLOWED_ATTR: attrs, ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true, FORCE_BODY: true });
  let blockedImages = 0;
  for (const element of fragment.querySelectorAll('*')) {
    if (element.hasAttribute('style')) {
      cleanDeclarations(element.style);
      element.setAttribute('style', element.style.cssText);
    }
    if (element.tagName === 'STYLE') element.textContent = cleanStyle(element.textContent);
    if (element.tagName === 'A') {
      const href = element.getAttribute('href') || '';
      if (!/^(https?:|mailto:|tel:|#)/i.test(href.trim())) element.removeAttribute('href');
      element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer');
    }
    if (element.tagName !== 'IMG') { element.removeAttribute('src'); continue; }
    const src = (element.getAttribute('src') || '').trim();
    if (/^cid:/i.test(src)) {
      let cid = src.slice(4); try { cid = decodeURIComponent(cid); } catch { /* unmatched CID is removed */ }
      const part = cidParts.get(cid.replace(/^<|>$/g, ''));
      if (part) element.setAttribute('src', `/api/messages/${encodeURIComponent(ref)}/parts/${encodeURIComponent(part)}?inline=1`);
      else element.removeAttribute('src');
    } else if (/^(https?:)?\/\//i.test(src)) {
      const url = src.startsWith('//') ? `https:${src}` : src;
      if (images) element.setAttribute('src', url);
      else { element.removeAttribute('src'); element.setAttribute('data-wm-blocked', url); blockedImages++; }
    } else if (!/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) element.removeAttribute('src');
  }
  const container = window.document.createElement('div'); container.append(fragment);
  return { html: container.innerHTML, blockedImages };
}

// Sending preserves remote images and CID URLs, without reader-only rewrites.
export function sanitizeComposeHtml(html, { publicHostnames = [] } = {}) {
  const fragment = purify.sanitize(html, { ALLOWED_TAGS: tags, ALLOWED_ATTR: [...attrs, 'data-wm-blocked'], ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true, FORCE_BODY: true });
  for (const element of fragment.querySelectorAll('*')) {
    if (element.hasAttribute('style')) {
      cleanDeclarations(element.style);
      element.setAttribute('style', element.style.cssText);
    }
    if (element.tagName === 'STYLE') element.textContent = cleanStyle(element.textContent);
    if (element.tagName !== 'IMG') { element.removeAttribute('src'); element.removeAttribute('data-wm-blocked'); continue; }
    const blocked = element.getAttribute('data-wm-blocked');
    if (blocked && /^(https?:)?\/\//i.test(blocked.trim())) element.setAttribute('src', blocked.trim());
    element.removeAttribute('data-wm-blocked');
    const src = (element.getAttribute('src') || '').trim();
    let internal = /^\/?api\//i.test(src);
    try {
      const url = new URL(src.startsWith('//') ? `https:${src}` : src);
      internal ||= publicHostnames.includes(url.hostname) && url.pathname.startsWith('/api/');
    } catch { /* CID, data and relative URLs have no absolute hostname. */ }
    if (internal) { element.remove(); continue; }
    if (!/^(https?:|cid:|\/\/)/i.test(src) && !/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) element.removeAttribute('src');
  }
  const container = window.document.createElement('div'); container.append(fragment);
  return container.innerHTML;
}
