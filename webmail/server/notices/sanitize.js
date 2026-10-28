import createDOMPurify from 'dompurify';
import { JSDOM, VirtualConsole } from 'jsdom';

// Notices have their own allowlist; email content uses a different sanitizer.
const window = new JSDOM('', { virtualConsole: new VirtualConsole() }).window;
const purify = createDOMPurify(window);
const tags = ['p', 'br', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li'];

export function sanitizeNotice(html) {
  const fragment = purify.sanitize(html, {
    ALLOWED_TAGS: tags, ALLOWED_ATTR: ['href'], ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true,
  });
  for (const element of fragment.querySelectorAll('*')) {
    if (element.tagName !== 'A') { element.removeAttribute('href'); continue; }
    const href = element.getAttribute('href')?.trim() ?? '';
    if (!/^(?:https?:|mailto:)/i.test(href) || /[\x00-\x1f\x7f]/.test(href)) element.removeAttribute('href');
    else element.setAttribute('href', href);
    element.setAttribute('target', '_blank');
    element.setAttribute('rel', 'noopener noreferrer');
  }
  const empty = !fragment.textContent.replace(/[\s\u200b-\u200d\ufeff]/g, '');
  const container = window.document.createElement('div');
  container.append(fragment);
  return { bodyHtml: container.innerHTML, empty };
}
