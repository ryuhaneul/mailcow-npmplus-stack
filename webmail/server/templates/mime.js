import libmime from 'libmime';
import { AppError } from '../errors.js';

export const templateIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = () => new AppError(422, 'TEMPLATE_INVALID', '템플릿 이름과 내용을 확인해 주세요.');
const removed = new Set(['to', 'cc', 'bcc', 'reply-to', 'in-reply-to', 'references', 'from', 'x-webmail-template-id', 'x-webmail-template-name']);

export function templateName(value) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 100 || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value;
}

// The compose builder owns MIME generation. Only top-level headers change here;
// multipart boundaries, transfer encodings, attachment and CID bytes stay exact.
export function templateMime(raw, { id, name }) {
  if (!Buffer.isBuffer(raw) || !templateIdPattern.test(id)) throw invalid();
  templateName(name);
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) throw invalid();
  const groups = [];
  for (const line of raw.subarray(0, end).toString('latin1').split('\r\n')) {
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) throw invalid();
    if (/^[ \t]/.test(line)) {
      if (!groups.length) throw invalid();
      groups[groups.length - 1].lines.push(line);
    } else {
      const match = /^([\x21-\x39\x3b-\x7e]+):/.exec(line);
      if (!match) throw invalid();
      groups.push({ name: match[1].toLowerCase(), lines: [line] });
    }
  }
  const kept = groups.filter(group => !removed.has(group.name)).flatMap(group => group.lines);
  const headers = Buffer.from(kept.join('\r\n'), 'latin1');
  const identity = Buffer.from(`\r\nX-Webmail-Template-Id: ${id.toLowerCase()}\r\nX-Webmail-Template-Name: ${libmime.encodeWord(name, 'B', 52)}`);
  return Buffer.concat([headers, identity, raw.subarray(end)]);
}
