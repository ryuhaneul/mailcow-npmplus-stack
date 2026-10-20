import { MAX_SCRIPT_BYTES, validateDocument } from './model.js';
import { hashBody, MAGIC } from './generate.js';

/** Decode only our metadata envelope, never arbitrary Sieve or an import source. */
export function parseScript(script) {
  const damaged = () => ({ state: 'damaged', doc: null, rev: null });
  if (typeof script !== 'string' || Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES || !script.startsWith(`${MAGIC}\n`)) return damaged();
  const lines = script.split('\n');
  let i = 1;
  let encoded = '';
  while (lines[i]?.startsWith('# WEBMAIL-DATA ')) {
    const chunk = lines[i].slice('# WEBMAIL-DATA '.length);
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(chunk)) return damaged();
    encoded += chunk;
    i++;
  }
  if (!encoded) return damaged();
  let doc;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return damaged();
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Number.isSafeInteger(doc?.v) || doc.v < 1) return damaged();
    if (doc.v <= 2) validateDocument(doc, { checkPolicy: false });
  } catch { return damaged(); }
  const hashLine = lines[i];
  const body = lines.slice(i + 1).join('\n');
  const hash = /^# WEBMAIL-HASH ([a-f0-9]{64})$/.exec(hashLine ?? '')?.[1];
  if (doc.v >= 3) {
    if (!hash || hashBody(body) !== hash || !Number.isSafeInteger(doc.rev) || doc.rev < 0 || !Array.isArray(doc.rules) || !Array.isArray(doc.blocked) || !doc.vacation || typeof doc.vacation !== 'object') return damaged();
    return { state: 'newer_version', doc, rev: doc.rev };
  }
  return { state: hash && hashBody(body) === hash ? 'ok' : 'modified_externally', doc, rev: doc.rev };
}
