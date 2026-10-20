import { createHash } from 'node:crypto';
import { canonicalJSON, MAX_SCRIPT_BYTES, SCRIPT_NAME } from './model.js';

export const importName = `${SCRIPT_NAME}.import`;
export const undoWebmailName = `${SCRIPT_NAME}.undo-webmail`;
export const undoActiveName = `${SCRIPT_NAME}.undo-active`;
const scriptHash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const magic = '# WEBMAIL-IMPORT 1';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clip = (value, max) => {
  const chars = [...String(value ?? '')];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};

export function droppedItems(items) {
  return items.filter(item => !['same', 'changed'].includes(item.status)).map(item => {
    const summary = item.summary ?? [...(item.gmail?.conditions ?? []), ...(item.gmail?.actions ?? [])].map(([name, value]) => `${name}=${value}`).join(' · ');
    return { n: item.n, summary: clip(summary || item.reason, 300), reason: clip(item.reason, 120) };
  });
}

export function importRecord({ at, source, mode, items, webmailScript, activeName, activeScript, afterScript }) {
  const omitted = droppedItems(items);
  const dropped = omitted.slice(0, 1000);
  while (Buffer.byteLength(canonicalJSON(dropped)) > 256 * 1024) dropped.pop();
  return { v: 1, at, source, mode, dropped,
    ...(omitted.length > dropped.length ? { droppedTruncated: omitted.length - dropped.length } : {}),
    undo: { webmail: { present: webmailScript !== null, ...(webmailScript !== null ? { sha256: scriptHash(webmailScript) } : {}) },
      active: activeName ? { name: activeName, sha256: scriptHash(activeScript) } : {}, afterSha256: scriptHash(afterScript) } };
}

export function encodeImportRecord(record) {
  const data = Buffer.from(canonicalJSON(record)).toString('base64url');
  const script = `${magic}\n${data.match(/.{1,120}/g).map(chunk => `# WEBMAIL-DATA ${chunk}`).join('\n')}\n`;
  if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) throw new Error('Import record exceeds storage limit');
  return script;
}

export function parseImportRecord(script) {
  if (typeof script !== 'string' || Buffer.byteLength(script) > MAX_SCRIPT_BYTES || !script.startsWith(`${magic}\n`)) return null;
  const lines = script.slice(magic.length + 1).trimEnd().split('\n');
  if (!lines.length || lines.some(line => !/^# WEBMAIL-DATA [A-Za-z0-9_-]{1,120}$/.test(line))) return null;
  const data = lines.map(line => line.slice('# WEBMAIL-DATA '.length)).join('');
  try {
    const bytes = Buffer.from(data, 'base64url');
    if (bytes.toString('base64url') !== data) return null;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (value?.v !== 1 || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))
      || !['gmail-xml', 'active-script'].includes(value.source?.kind) || typeof value.source.name !== 'string' || !hash(value.source.sha256)
      || !['new', 'append', 'replace'].includes(value.mode) || !Array.isArray(value.dropped) || value.dropped.length > 1000
      || value.dropped.some(item => !Number.isSafeInteger(item?.n) || typeof item.summary !== 'string' || typeof item.reason !== 'string')
      || typeof value.undo?.webmail?.present !== 'boolean' || !hash(value.undo.afterSha256)
      || (value.undo.webmail.present && !hash(value.undo.webmail.sha256)) || !value.undo.active || typeof value.undo.active !== 'object'
      || (value.undo.active.name !== undefined && (typeof value.undo.active.name !== 'string' || !hash(value.undo.active.sha256)))) return null;
    return value;
  } catch { return null; }
}

export async function readImportRecord(client, scripts) {
  return scripts.some(script => script.name === importName) ? parseImportRecord(await client.getScript(importName)) : null;
}

export async function importInfo(client, current) {
  const record = await readImportRecord(client, current.scripts);
  if (!record) return undefined;
  const has = name => current.scripts.some(script => script.name === name);
  const before = record.undo.webmail;
  const currentHash = current.script === null ? null : scriptHash(current.script);
  const beforeBytes = currentHash === (before.present ? before.sha256 : null);
  const unapplied = currentHash !== record.undo.afterSha256 && beforeBytes
    && current.activeName === (record.undo.active.name ?? null);
  let available = !unapplied && current.state !== 'newer_version';
  if (available && before.present) available = has(undoWebmailName) && scriptHash(await client.getScript(undoWebmailName)) === before.sha256;
  const active = record.undo.active;
  if (available && active.name && active.name !== SCRIPT_NAME) available = has(undoActiveName) && scriptHash(await client.getScript(undoActiveName)) === active.sha256;
  return { at: record.at, source: { kind: record.source.kind, name: record.source.name }, mode: record.mode, dropped: record.dropped,
    ...(record.droppedTruncated ? { droppedTruncated: record.droppedTruncated } : {}),
    undo: { available, edited: !beforeBytes && currentHash !== record.undo.afterSha256 } };
}
