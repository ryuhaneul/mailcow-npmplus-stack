import { randomBytes, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';
import { readBrandState, resolveBrandFile, brandFilePattern } from '../../brand-store.js';

const maxBytes = 1048576, ttl = 10 * 60 * 1000;
const sha16 = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const bad = () => new AppError(422, 'LOGO_TYPE', 'PNG·JPEG·WebP·SVG 그림과 선언한 종류를 확인해 주세요.');
const invalid = () => new AppError(422, 'INVALID_INPUT', '로고 저장 입력값을 확인해 주세요.');
const missing = () => new AppError(404, 'NOT_FOUND', '로고 미리보기를 찾을 수 없어요.');
const failed = () => new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 로고가 예상과 달라요. 다시 확인해 주세요.');
const state = value => ({ version: value?.version ?? null });
function input(data, keys) { if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key))) throw invalid(); }
function image(mime, dataBase64) {
  if (typeof dataBase64 !== 'string' || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) throw bad();
  if (dataBase64.length > Math.ceil(maxBytes / 3) * 4) throw new AppError(422, 'LOGO_SIZE', '로고는 0바이트보다 크고 1MiB 이하여야 해요.');
  const data = Buffer.from(dataBase64, 'base64');
  if (!data.length || data.length > maxBytes) throw new AppError(422, 'LOGO_SIZE', '로고는 0바이트보다 크고 1MiB 이하여야 해요.');
  if (data.toString('base64') !== dataBase64) throw bad();
  let type, ext;
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { type = 'image/png'; ext = 'png'; }
  else if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) { type = 'image/jpeg'; ext = 'jpg'; }
  else if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') { type = 'image/webp'; ext = 'webp'; }
  else {
    let source; try { source = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw bad(); }
    if (/<!DOCTYPE/i.test(source)) throw bad();
    source = source.trimStart();
    if (source.startsWith('<?xml')) { const end = source.indexOf('?>'); if (end < 0) throw bad(); source = source.slice(end + 2).trimStart(); }
    while (source.startsWith('<!--')) { const end = source.indexOf('-->'); if (end < 0) throw bad(); source = source.slice(end + 3).trimStart(); }
    if (!/^<svg(?:\s|\/?>)/.test(source)) throw bad(); type = 'image/svg+xml'; ext = 'svg';
  }
  if (mime !== type) throw bad();
  return { data, mime: type, ext, size: data.length, sha16: sha16(data) };
}
const metadata = value => value ? Object.fromEntries(['light', 'dark'].map(variant => [variant, value[variant] ? { file: value[variant].file, sha16: brandFilePattern.exec(value[variant].file)[1], mime: value[variant].mime, size: value[variant].size } : null])) : null;
const version = value => sha16(JSON.stringify(metadata(value)));
export function createLogoService({ dir, audit, lock, history, logger, now = Date.now, io = fs }) {
  const previews = new Map(), target = 'logo';
  function enabled() { if (!dir) throw new AppError(503, 'LOGO_DISABLED', '로고 관리가 꺼져 있어요.'); }
  function sweep() { for (const [id, item] of previews) if (item.expires <= now()) previews.delete(id); }
  function previewItem(id, owner) { sweep(); const item = previews.get(id); if (!item || item.owner !== owner) throw missing(); return item; }
  async function get() { enabled(); const [current, previous] = await Promise.all([readBrandState(dir), readBrandState(dir, 'previous')]); return { current, previous, etag: etag(current?.version ?? null) }; }
  async function preview({ owner, data }) {
    enabled(); input(data, ['variant', 'mime', 'dataBase64']); if (!['light', 'dark'].includes(data.variant)) throw invalid();
    const value = image(data.mime, data.dataBase64); sweep(); while (previews.size >= 20) previews.delete(previews.keys().next().value);
    const id = randomBytes(16).toString('hex'); previews.set(id, { ...value, variant: data.variant, owner, expires: now() + ttl });
    return { id, variant: data.variant, mime: value.mime, size: value.size, sha16: value.sha16, expiresAt: new Date(now() + ttl).toISOString(), url: `/api/admin/logo/file/${id}` };
  }
  async function file(which, owner) {
    enabled(); if (!['light', 'dark'].includes(which)) { const value = previewItem(which, owner); return { data: value.data, mime: value.mime }; }
    const current = await readBrandState(dir), entry = (which === 'dark' ? current?.dark : null) ?? current?.light; if (!entry) throw missing();
    let data; try { data = await io.readFile(resolveBrandFile(dir, entry)); } catch { throw new AppError(503, 'LOGO_READ_UNAVAILABLE', '저장한 로고를 읽을 수 없어요.'); }
    if (data.length !== entry.size || sha16(data) !== brandFilePattern.exec(entry.file)[1]) throw failed(); return { data, mime: entry.mime };
  }
  async function replace(which, value) {
    const path = join(dir, `${which}.json`), temp = `${path}.tmp`; await io.writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o644 }); await io.rename(temp, path);
  }
  async function assets(variant, item) {
    const entry = { file: `${variant}-${item.sha16}.${item.ext}`, mime: item.mime, size: item.size, savedAt: new Date(now()).toISOString() }, path = resolveBrandFile(dir, entry);
    try { await io.writeFile(path, item.data, { flag: 'wx', mode: 0o644 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; if (!(await io.readFile(path)).equals(item.data)) throw failed(); }
    return entry;
  }
  async function clean(current, previous) {
    const keep = new Set([current?.light?.file, current?.dark?.file, previous?.light?.file, previous?.dark?.file]);
    for (const entry of await io.readdir(dir, { withFileTypes: true })) if (entry.isFile() && brandFilePattern.test(entry.name) && !keep.has(entry.name)) await io.unlink(join(dir, entry.name));
  }
  async function commit(current, previous, cleanup = true) {
    await io.mkdir(dir, { recursive: true });
    const previousPath = join(dir, 'previous.json');
    let savedPrevious;
    try { savedPrevious = await io.readFile(previousPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await replace('previous', previous);
    try { await replace('current', current); }
    catch (error) {
      try {
        if (savedPrevious === undefined) await io.unlink(previousPath);
        else { await io.writeFile(`${previousPath}.tmp`, savedPrevious, { mode: 0o644 }); await io.rename(`${previousPath}.tmp`, previousPath); }
      } catch {
        logger?.warn({ code: 'LOGO_PREVIOUS_RESTORE_FAILED' }, '로고 저장 실패 후 이전 로고 정보를 복원하지 못했습니다.');
        throw new AppError(502, 'WRITE_VERIFY_FAILED', '로고 저장에 실패했고 이전 로고 정보도 복원하지 못했어요. 관리자에게 문의해 주세요.');
      }
      throw error;
    }
    if ((await readBrandState(dir))?.version !== current?.version || (await readBrandState(dir, 'previous'))?.version !== previous?.version) throw failed();
    if (cleanup) try { await clean(current, previous); } catch { logger?.warn({ code: 'LOGO_CLEANUP_FAILED' }, '로고 파일 정리를 다음 저장 때 다시 시도합니다.'); return true; }
    return false;
  }
  async function put({ owner, actor, ip, data }) {
    enabled(); input(data, ['etag', 'lightPreviewId', 'darkPreviewId']);
    return lock.run(target, async () => {
      const before = await readBrandState(dir); assertUnchanged(data.etag, before?.version ?? null);
      const light = previewItem(data.lightPreviewId, owner), darkId = data.darkPreviewId;
      if (light.variant !== 'light') throw invalid();
      const dark = darkId !== undefined && !['same', 'remove'].includes(darkId) ? previewItem(darkId, owner) : null; if (dark && dark.variant !== 'dark') throw invalid();
      previews.delete(data.lightPreviewId); if (dark) previews.delete(darkId);
      const descriptor = (variant, item) => ({ file: `${variant}-${item.sha16}.${item.ext}`, mime: item.mime, size: item.size, savedAt: new Date(now()).toISOString() });
      const next = { light: descriptor('light', light), dark: darkId === 'same' ? descriptor('light', light) : darkId === 'remove' ? null : dark ? descriptor('dark', dark) : before?.dark ?? null }; next.version = version(next);
      if (next.version === before?.version) return { current: before, etag: etag(before.version), unchanged: true };
      return audit.run({ actor, ip, action: 'logo.change', target, kind: 'config', revertible: true, before: state(before), after: state(next) }, async intent => {
        await io.mkdir(dir, { recursive: true }); await assets('light', light); if (dark) await assets('dark', dark);
        const cleanupPending = await commit(next, before); return { current: next, etag: etag(next.version), auditId: intent.id, detail: { before: metadata(before), after: metadata(next), ...(cleanupPending ? { cleanupPending: true } : {}) } };
      });
    });
  }
  history.register('logo.change', { label: '웹메일 로고를 바꿨어요', read: async () => { enabled(); return state(await readBrandState(dir)); }, write: async ({ expected, value }) => {
    enabled(); const current = await readBrandState(dir), previous = await readBrandState(dir, 'previous'); assertUnchanged(etag(expected.version), current?.version ?? null);
    if ((previous?.version ?? null) !== value.version) throw new AppError(409, 'NOT_REVERTIBLE', '바로 이전 로고만 되돌릴 수 있어요.'); await commit(previous, current, false);
  } });
  return { get, preview, put, file };
}
