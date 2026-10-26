import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { inflateSync, crc32 } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';
import { readFaviconState, readFaviconFile, resolveFaviconFile, faviconFilePattern, faviconHash } from '../../favicon-store.js';

const maxBytes = 262144, ttl = 10 * 60 * 1000;
const bad = () => new AppError(422, 'FAVICON_TYPE', 'PNG·SVG·ICO 형식과 정사각형 크기를 확인해 주세요.');
const invalid = () => new AppError(422, 'INVALID_INPUT', '탭 아이콘 저장 입력값을 확인해 주세요.');
const missing = () => new AppError(404, 'NOT_FOUND', '탭 아이콘 미리보기를 찾을 수 없어요.');
const failed = () => new AppError(502, 'WRITE_VERIFY_FAILED', '탭 아이콘을 저장하지 못했어요. 다시 확인해 주세요.');
const state = value => ({ version: value?.version ?? null });
function input(data, keys) { if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key))) throw invalid(); }
function png(data, standalone = true) {
  if (data.length < 45 || data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') throw bad();
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (width !== height || width === 0 || standalone && (width < 16 || width > 512)) throw bad();
  const depth = data[24], color = data[25], channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const depths = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] };
  if (!depths[color]?.includes(depth) || data[26] || data[27] || data[28] > 1) throw bad();
  const compressed = []; let ended = false;
  for (let offset = 8; offset < data.length;) {
    if (offset + 12 > data.length) throw bad();
    const length = data.readUInt32BE(offset), end = offset + 12 + length;
    if (end > data.length || crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) throw bad();
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) throw bad();
    if (type === 'IDAT') compressed.push(data.subarray(offset + 8, end - 4));
    if (type === 'IEND') { if (length || end !== data.length) throw bad(); ended = true; }
    offset = end;
  }
  if (!ended || !compressed.length) throw bad();
  let pixels;
  try { pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: 8 * 1024 * 1024 }); } catch { throw bad(); }
  const passes = data[28] === 1 ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  let offset = 0;
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.ceil((width - x) / dx), rows = Math.ceil((height - y) / dy);
    if (columns <= 0 || rows <= 0) continue;
    const stride = 1 + Math.ceil(columns * channels * depth / 8);
    for (let row = 0; row < rows; row++) { if (offset + stride > pixels.length || pixels[offset] > 4) throw bad(); offset += stride; }
  }
  if (offset !== pixels.length) throw bad();
}
function image(mime, dataBase64) {
  if (typeof dataBase64 !== 'string' || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) throw bad();
  if (dataBase64.length > Math.ceil(maxBytes / 3) * 4) throw bad();
  const data = Buffer.from(dataBase64, 'base64');
  if (!data.length || data.length > maxBytes || data.toString('base64') !== dataBase64) throw bad();
  let type, ext;
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { png(data); type = 'image/png'; ext = 'png'; }
  else if (data.length >= 6 && data.readUInt32LE(0) === 65536) {
    const count = data.readUInt16LE(4), header = 6 + count * 16;
    if (!count || header > data.length) throw bad();
    for (let index = 0; index < count; index++) {
      const offset = 6 + index * 16, length = data.readUInt32LE(offset + 8), start = data.readUInt32LE(offset + 12);
      if (!length || start < header || start + length > data.length || (index === 0 && (data[offset] || 256) !== (data[offset + 1] || 256))) throw bad();
    }
    const first = data.subarray(data.readUInt32LE(18), data.readUInt32LE(18) + data.readUInt32LE(14));
    if (first.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) png(first, false);
    type = 'image/vnd.microsoft.icon'; ext = 'ico';
  } else {
    let source, dom;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(data);
      if (/<!DOCTYPE/i.test(source)) throw bad();
      dom = new JSDOM(source, { contentType: 'image/svg+xml' });
      const root = dom.window.document.documentElement;
      if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') throw bad();
      const viewBox = root.getAttribute('viewBox');
      if (!viewBox || /,\s*,/.test(viewBox)) throw bad();
      const parts = viewBox.trim().split(/[\s,]+/);
      if (!parts || parts.length !== 4 || parts.some(part => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(part))) throw bad();
      const values = parts.map(Number);
      if (!values.every(Number.isFinite) || values[2] <= 0 || values[2] !== values[3]) throw bad();
    } catch { throw bad(); } finally { dom?.window.close(); }
    type = 'image/svg+xml'; ext = 'svg';
  }
  if (mime !== type && !(type === 'image/vnd.microsoft.icon' && mime === 'image/x-icon')) throw bad();
  return { data, mime: type, ext, size: data.length, version: faviconHash(data) };
}
export function createFaviconService({ dir, audit, lock, history, logger, now = Date.now, io = fs }) {
  const previews = new Map(), target = 'favicon';
  function enabled() { if (!dir) throw new AppError(503, 'FAVICON_DISABLED', '탭 아이콘 관리가 꺼져 있어요.'); }
  function sweep() { for (const [id, item] of previews) if (item.expires <= now()) previews.delete(id); }
  function previewItem(id, owner) { sweep(); const item = previews.get(id); if (!item || item.owner !== owner) throw missing(); return item; }
  async function get() { enabled(); const [current, previous] = await Promise.all([readFaviconState(dir), readFaviconState(dir, 'previous')]); return { current, previous, etag: etag(current?.version ?? null) }; }
  async function preview({ owner, data }) {
    enabled(); input(data, ['mime', 'dataBase64']); const value = image(data.mime, data.dataBase64); sweep();
    while (previews.size >= 20) previews.delete(previews.keys().next().value);
    const id = randomBytes(16).toString('hex'); previews.set(id, { ...value, owner, expires: now() + ttl });
    return { id, mime: value.mime, size: value.size, expiresAt: new Date(now() + ttl).toISOString(), url: `/api/admin/favicon/file/${id}` };
  }
  async function file(id, owner) { enabled(); const value = previewItem(id, owner); return { data: value.data, mime: value.mime }; }
  async function stage(path, bytes) {
    const temp = `${path}.tmp`; await io.writeFile(temp, bytes, { mode: 0o644 });
    if (!(await io.readFile(temp)).equals(Buffer.from(bytes))) throw failed();
    const handle = await io.open(temp, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function commit(current, previous, item = null) {
    await io.mkdir(dir, { recursive: true });
    const changes = [
      { path: join(dir, 'favicon.previous.json'), bytes: JSON.stringify(previous) + '\n' },
      { path: join(dir, 'favicon.json'), bytes: JSON.stringify(current) + '\n' },
    ];
    if (item) {
      const path = resolveFaviconFile(dir, current);
      let existing;
      try { existing = await io.readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing !== undefined) await readFaviconFile(dir, current, io);
      else changes.unshift({ path, bytes: item.data });
    }
    for (const change of changes) {
      try { change.before = await io.readFile(change.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const renamed = [];
    try {
      for (const change of changes) await stage(change.path, change.bytes);
      for (const change of changes) { await io.rename(`${change.path}.tmp`, change.path); renamed.push(change); }
    } catch (error) {
      try {
        for (const change of renamed.reverse()) {
          if (change.before === undefined) await io.unlink(change.path);
          else { await stage(change.path, change.before); await io.rename(`${change.path}.tmp`, change.path); }
        }
      } catch { logger?.warn({ code: 'FAVICON_PREVIOUS_RESTORE_FAILED' }, '이전 탭 아이콘 정보를 복원하지 못했습니다.'); throw failed(); }
      throw error;
    } finally {
      for (const change of changes) try { await io.unlink(`${change.path}.tmp`); } catch {}
    }
    const keep = new Set([current?.file, previous?.file]);
    try { for (const entry of await io.readdir(dir, { withFileTypes: true })) if (entry.isFile() && faviconFilePattern.test(entry.name) && !keep.has(entry.name)) await io.unlink(join(dir, entry.name)); }
    catch { logger?.warn({ code: 'FAVICON_CLEANUP_FAILED' }, '탭 아이콘 파일 정리를 다음 저장 때 다시 시도합니다.'); return true; }
    return false;
  }
  async function change(args, mode) {
    enabled(); input(args.data, mode === 'put' ? ['etag', 'previewId'] : ['etag']);
    return lock.run(target, async () => {
      const before = await readFaviconState(dir); assertUnchanged(args.data.etag, before?.version ?? null);
      const item = mode === 'put' ? previewItem(args.data.previewId, args.owner) : null;
      const next = item ? { version: item.version, file: `favicon-${item.version}.${item.ext}`, mime: item.mime, size: item.size, savedAt: new Date(now()).toISOString() } : mode === 'revert' ? await readFaviconState(dir, 'previous') : null;
      if ((next?.version ?? null) === (before?.version ?? null)) return { current: before, etag: etag(before?.version ?? null), unchanged: true };
      if (next && !item) await readFaviconFile(dir, next, io);
      return audit.run({ actor: args.actor, ip: args.ip, action: 'favicon.change', target, kind: 'config', revertible: true, before: state(before), after: state(next) }, async intent => {
        const cleanupPending = await commit(next, before, item); if (item) previews.delete(args.data.previewId);
        return { current: next, etag: etag(next?.version ?? null), auditId: intent.id, detail: { before: state(before), after: state(next), ...(cleanupPending ? { cleanupPending: true } : {}) } };
      });
    });
  }
  history.register('favicon.change', { label: '탭 아이콘을 바꿨어요', runLocked: (_target, operation) => lock.run(target, operation), read: async () => { enabled(); return state(await readFaviconState(dir)); }, write: async ({ expected, value }) => {
    enabled(); const current = await readFaviconState(dir), previous = await readFaviconState(dir, 'previous'); assertUnchanged(etag(expected.version), current?.version ?? null);
    if ((previous?.version ?? null) !== value.version) throw new AppError(409, 'NOT_REVERTIBLE', '바로 이전 탭 아이콘만 되돌릴 수 있어요.');
    if (previous) await readFaviconFile(dir, previous, io); await commit(previous, current);
  } });
  return { get, preview, file, put: args => change(args, 'put'), revert: args => change(args, 'revert'), remove: args => change(args, 'remove') };
}
