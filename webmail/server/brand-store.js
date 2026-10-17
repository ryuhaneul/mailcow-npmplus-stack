import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.js';

export const brandFilePattern = /^(?:light|dark)-([a-f0-9]{16})\.(png|jpg|webp|svg)$/;
const mimeByExt = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const unavailable = () => new AppError(503, 'LOGO_READ_UNAVAILABLE', '저장한 로고를 읽을 수 없어요.');
export function resolveBrandFile(dir, entry) {
  const match = typeof entry?.file === 'string' && brandFilePattern.exec(entry.file);
  if (!dir || !match || mimeByExt[match[2]] !== entry.mime || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 1048576) throw unavailable();
  return join(dir, entry.file);
}
export async function readBrandState(dir, which = 'current') {
  if (!dir) return null;
  if (!['current', 'previous'].includes(which)) throw unavailable();
  let raw; try { raw = await readFile(join(dir, `${which}.json`), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw unavailable(); }
  try {
    const value = JSON.parse(raw); if (value === null) return null;
    if (!value || typeof value !== 'object' || !/^[a-f0-9]{16}$/.test(value.version) || !value.light) throw unavailable();
    resolveBrandFile(dir, value.light); if (value.dark !== null) resolveBrandFile(dir, value.dark);
    return { version: value.version, light: { file: value.light.file, mime: value.light.mime, size: value.light.size, savedAt: value.light.savedAt }, dark: value.dark === null ? null : { file: value.dark.file, mime: value.dark.mime, size: value.dark.size, savedAt: value.dark.savedAt } };
  } catch { throw unavailable(); }
}
