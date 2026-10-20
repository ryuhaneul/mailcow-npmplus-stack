import jsdom from 'jsdom';
import { AppError } from '../errors.js';

const ATOM = 'http://www.w3.org/2005/Atom';
const APPS = 'http://schemas.google.com/apps/2006';

function invalid(reason) {
  const error = new AppError(422, 'XML_INVALID', 'Gmail 필터 내보내기 파일을 확인해 주세요.');
  error.reason = reason;
  error.detail = { reason };
  throw error;
}

/** Read namespace-qualified direct children, retaining duplicates and missing attributes. */
export function readGmailXml(xml) {
  if (typeof xml !== 'string' || !xml.isWellFormed()) invalid('not_utf8');
  if (Buffer.byteLength(xml, 'utf8') > 512 * 1024) invalid('too_large');
  xml = xml.replace(/^\uFEFF/, '');
  if (xml.startsWith('\uFEFF')) invalid('malformed');
  // Check even declarations inside comments: no DTD processing may reach the DOM.
  if (/<!\s*(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST)\b/i.test(xml)) invalid('dtd');
  const declaration = /^<\?xml\s[^?]*\?>/.exec(xml)?.[0] ?? '';
  if (declaration) {
    const encoding = /\bencoding\s*=\s*(['"])(.*?)\1/i.exec(declaration)?.[2];
    if (encoding && !/^utf-8$/i.test(encoding)) invalid('not_utf8');
  }
  if (xml.slice(declaration.length).includes('<?')) invalid('pi');
  let dom;
  try {
    dom = new jsdom.JSDOM(xml, { contentType: 'application/xml', runScripts: undefined, resources: undefined });
  } catch { invalid('malformed'); }
  try {
    const doc = dom.window.document;
    if (doc.getElementsByTagName('parsererror').length) invalid('malformed');
    const root = doc.documentElement;
    if (root?.namespaceURI !== ATOM || root.localName !== 'feed') invalid('not_gmail');
    const entries = [...root.children].filter(node => node.namespaceURI === ATOM && node.localName === 'entry');
    if (!entries.length) invalid('not_gmail');
    if (entries.length > 1000) invalid('too_many_entries');
    return { entries: entries.map((entry, index) => ({
      n: index + 1,
      props: [...entry.children]
        .filter(node => node.namespaceURI === APPS && node.localName === 'property')
        .map(node => [node.getAttribute('name'), node.getAttribute('value')])
    })) };
  } finally { dom.window.close(); }
}
