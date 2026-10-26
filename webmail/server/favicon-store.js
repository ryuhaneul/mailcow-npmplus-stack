import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

export const faviconFilePattern = /^favicon-([a-f0-9]{16})\.(png|svg|ico)$/;
export const faviconCsp = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
export const faviconHash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const mimes = { png: 'image/png', svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon' };
const unavailable = () => new AppError(503, 'FAVICON_READ_UNAVAILABLE', '저장한 탭 아이콘을 읽을 수 없어요.');
export function resolveFaviconFile(dir, entry) {
  const match = typeof entry?.file === 'string' && faviconFilePattern.exec(entry.file);
  if (!dir || !match || mimes[match[2]] !== entry.mime || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 262144) throw unavailable();
  return join(dir, entry.file);
}
export async function readFaviconState(dir, which = 'current') {
  if (!dir) return null;
  if (!['current', 'previous'].includes(which)) throw unavailable();
  let raw;
  try { raw = await readFile(join(dir, which === 'current' ? 'favicon.json' : 'favicon.previous.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw unavailable(); }
  try {
    const entry = JSON.parse(raw); if (entry === null) return null;
    resolveFaviconFile(dir, entry);
    if (entry.version !== faviconFilePattern.exec(entry.file)[1]) throw unavailable();
    return { version: entry.version, file: entry.file, mime: entry.mime, size: entry.size, savedAt: entry.savedAt };
  } catch { throw unavailable(); }
}
export async function readFaviconFile(dir, entry, io = { readFile }) {
  let data;
  try { data = await io.readFile(resolveFaviconFile(dir, entry)); } catch { throw unavailable(); }
  if (data.length !== entry.size || faviconHash(data) !== entry.version) throw unavailable();
  return { data, mime: entry.mime };
}
