import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sanitizeSyncResponse } from '../webmail/server/admin/log-sanitize.js';
import { DEFAULT_RETENTION } from './store.js';

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const sources = Object.keys(DEFAULT_RETENTION);
const allowedFields = ['method', 'path', 'status', 'remote', 'ip', 'service', 'event', 'code'];
const rfc3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
const timeKey = value => value.replace(/(?:\.(\d+))?Z$/, (_, fraction = '') => `.${fraction.padEnd(9, '0')}Z`);
export const archiveError = (status, code, message) => Object.assign(new Error(message), { status, code });
const invalid = () => archiveError(422, 'INVALID_INPUT', '로그 출처와 검색 조건을 확인해 주세요.');
const expired = () => archiveError(410, 'ARCHIVE_SNAPSHOT_EXPIRED', '검색 기준이 바뀌었어요. 다시 검색해 주세요.');
const cannotAdvance = () => archiveError(503, 'LOG_SCAN_CANNOT_ADVANCE', '검색을 진행할 수 없어요. 범위를 줄여 다시 검색해 주세요.');
const cut = value => Array.from(String(value ?? '')).slice(0, 4000).join('');
const advances = (position, previous) => {
  if (!previous) return false;
  for (const field of ['hour', 'memberStart', 'line', 'byte']) {
    if (position[field] !== previous[field]) return position[field] > previous[field];
  }
  return false;
};
const searchable = value => value && typeof value === 'object' ? Object.values(value).map(searchable).join(' ') : String(value ?? '');

function utc(value) {
  if (typeof value !== 'string' || !rfc3339.test(value)) throw invalid();
  const datePart = value.slice(0, 10);
  const local = new Date(`${datePart}T00:00:00Z`);
  if (!Number.isFinite(local.getTime()) || local.toISOString().slice(0, 10) !== datePart || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) throw invalid();
  const zone = /([+-])(\d\d):(\d\d)$/.exec(value);
  if (zone && (Number(zone[2]) > 23 || Number(zone[3]) > 59)) throw invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalid();
  const fraction = /\.(\d+)/.exec(value)?.[1];
  return date.toISOString().replace(/\.\d{3}Z$/, fraction ? `.${fraction}Z` : '.000Z');
}

export function validateQuery(input) {
  const entries = input instanceof URLSearchParams ? [...input] : Object.entries(input ?? {});
  const query = {};
  for (const [name, value] of entries) {
    if (!['source', 'start', 'end', 'q', 'limit', 'cursor'].includes(name) || Object.hasOwn(query, name) || typeof value !== 'string') throw invalid();
    query[name] = value;
  }
  const source = query.source, start = utc(query.start), end = utc(query.end);
  const limit = Number(query.limit ?? '200'), q = query.q ?? '';
  if (!sources.includes(source) || timeKey(start) >= timeKey(end) || Date.parse(end) - Date.parse(start) > DEFAULT_RETENTION[source] * 86400000 || !/^[1-9]\d*$/.test(query.limit ?? '200') || !Number.isSafeInteger(limit) || limit > 1000 || Array.from(q).length > 200 || query.cursor !== undefined && (!query.cursor || query.cursor.length > 4096)) throw invalid();
  return { source, start, end, q, limit, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) };
}

function jsonObject(value) {
  try { const result = JSON.parse(value); return result && typeof result === 'object' && !Array.isArray(result) ? result : null; } catch { return null; }
}
function cleanText(value) {
  let text = sanitizeSyncResponse(String(value ?? ''));
  if (/^\s*[\[{]/.test(text)) return '[구조화 로그 내용 생략]';
  // Header/mail content has no safe free-text projection. Never reveal fragments.
  if (/\b(?:authorization|proxy-authorization|cookie|set-cookie|subject|mail[_ -]?body|raw[_ -]?mail|headers)["']?\s*[:=]/i.test(text)) return '[민감 정보가 포함된 로그]';
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, value => {
    try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return '[URL]'; }
  }).replace(/(\/[^\s?"'<>]*)\?[^\s"'<>]*/g, '$1');
  text = text.replace(/\b((?:password\w*|passwd\w*|passfile\w*|\w*token\w*|\w*secret\w*|api[_-]?key|\w+_key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, '$1***');
  return sanitizeSyncResponse(text);
}
function hiddenValues(value, hidden = []) {
  if (!value || typeof value !== 'object') return hidden;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:headers?|cookie|set-cookie|authorization|subject|body|raw_?mail|mail_?body|requestBody|key)$/i.test(key)) {
      const collect = item => { if (typeof item === 'string' && item) hidden.push(item); else if (item && typeof item === 'object') Object.values(item).forEach(collect); };
      collect(child);
    } else hiddenValues(child, hidden);
  }
  return hidden;
}
function projectedTime(value) { try { return utc(value); } catch { return null; } }
function accessTime(text) {
  const match = /\[(\d\d)\/(\w{3})\/(\d{4}):(\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)\]/.exec(text);
  if (!match) return null;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[2]) + 1;
  return projectedTime(`${match[3]}-${String(month).padStart(2, '0')}-${match[1]}T${match[4]}${match[5]}:${match[6]}`);
}

/** Safe projection only; raw physical bytes are never included in an API value. */
export function projectLine(raw, entry, id, oversized = false) {
  if (oversized) return { id, time: null, program: entry.source, priority: '', message: '[긴 로그 줄 생략]', truncated: true, unknownTime: true };
  const outer = jsonObject(raw), docker = outer && typeof outer.log === 'string';
  const payload = docker ? outer.log : raw;
  const structured = docker ? jsonObject(payload) : outer;
  const safe = structured ? sanitizeSyncResponse(structured, hiddenValues(structured), [...allowedFields, 'program', 'priority']) : null;
  const stamp = docker ? projectedTime(outer.time) : null;
  const time = stamp ?? projectedTime(safe?.time ?? safe?.timestamp) ?? projectedTime(/^\d{4}-\d\d-\d\dT\S+/.exec(payload)?.[0]) ?? accessTime(payload);
  const fields = {};
  for (const key of allowedFields) if (['string', 'number', 'boolean'].includes(typeof safe?.[key])) fields[key] = cleanText(safe[key]);
  if (fields.path) fields.path = fields.path.split(/[?#]/, 1)[0].replace(/^(https?:\/\/)\S+@/, '$1');
  const message = safe ? cleanText(typeof safe.message === 'string' ? safe.message : typeof safe.msg === 'string' ? safe.msg : searchable(fields)) : cleanText(payload.trimEnd());
  // sanitize the original structure first so secret values repeated in message
  // are hidden even when their defining field is excluded by the projection.
  const line = sanitizeSyncResponse({ id, time, program: cleanText(typeof safe?.program === 'string' ? safe.program : entry.source), priority: cleanText(typeof safe?.priority === 'string' ? safe.priority : ''), message, ...(Object.keys(fields).length ? { fields } : {}), ...(!time ? { unknownTime: true } : {}) });
  return line;
}

function coverageOf(snapshot, retention, source) {
  return sources.filter(name => !source || source === name).map(name => {
    const hours = snapshot.catalog.hours.filter(entry => entry.source === name);
    const oldest = hours.reduce((value, entry) => !value || timeKey(entry.minTime) < timeKey(value) ? entry.minTime : value, null);
    const newest = hours.reduce((value, entry) => !value || timeKey(entry.maxTime) > timeKey(value) ? entry.maxTime : value, null);
    const generations = Object.values(snapshot.checkpoint.generations ?? {}).filter(item => item.source === name);
    const observed = generations.map(item => item.observedAt).filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort();
    const gaps = generations.flatMap(item => item.gaps ?? []).filter(gap => gap.source === name).map(gap => ({ source: name, from: projectedTime(gap.start), to: projectedTime(gap.end), reason: cleanText(gap.reason) }));
    return { source: name, retentionDays: retention[name], oldest, newest, gaps, unknownTimeCount: hours.reduce((sum, entry) => sum + entry.unknownTimeCount, 0), backfill: generations.length ? (generations.every(item => item.backfillComplete === true) ? 'complete' : 'unknown') : 'unknown', collectionLagSeconds: observed.length ? Math.max(0, (Date.now() - Date.parse(observed.at(-1))) / 1000) : null };
  });
}

/** Bounded in-process snapshots; restart/expiry/eviction intentionally return 410. */
export function createSearch({ store, maxScanBytes = 256 * 1024 * 1024, timeoutMs = 10000, maxResponseBytes = MAX_RESPONSE_BYTES, snapshotTtlMs = 600000, maxSnapshots = 32, maxSnapshotBytes = 16 * 1024 * 1024, now = Date.now } = {}) {
  if (!store || !Number.isSafeInteger(maxScanBytes) || maxScanBytes < 1 || maxScanBytes > 256 * 1024 * 1024 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_RESPONSE_BYTES || !Number.isSafeInteger(maxSnapshots) || maxSnapshots < 1 || !Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 1 || maxSnapshotBytes > 32 * 1024 * 1024 || snapshotTtlMs <= 0 || snapshotTtlMs > 600000) throw new TypeError('Invalid archive search options');
  const snapshots = new Map(), signingKey = randomBytes(32);
  let cacheBytes = 0, active = 0, closed = false;
  const retention = { ...DEFAULT_RETENTION, ...store.retention };
  function drop(id) { cacheBytes -= snapshots.get(id)?.size ?? 0; snapshots.delete(id); }
  function prune() { for (const [id, value] of snapshots) if (value.expires <= now()) drop(id); }
  const fingerprint = query => createHash('sha256').update(JSON.stringify([query.source, query.start, query.end, query.q, query.limit])).digest('hex');
  function encode(snapshot, position) {
    const body = Buffer.from(JSON.stringify({ id: snapshot.id, fingerprint: snapshot.fingerprint, expires: snapshot.expires, position })).toString('base64url');
    return `${body}.${createHmac('sha256', signingKey).update(body).digest('base64url')}`;
  }
  function decode(cursor, query) {
    const [body, signature, extra] = cursor.split('.');
    const expected = createHmac('sha256', signingKey).update(body ?? '').digest();
    const supplied = Buffer.from(signature ?? '', 'base64url');
    let decoded;
    try { decoded = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw invalid(); }
    if (!decoded || typeof decoded.id !== 'string' || decoded.fingerprint !== fingerprint(query)) throw invalid();
    const snapshot = snapshots.get(decoded.id);
    if (!snapshot || decoded.expires !== snapshot.expires || snapshot.expires <= now()) throw expired();
    if (extra !== undefined || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw invalid();
    const pos = decoded.position;
    if (!pos || !Number.isSafeInteger(pos.line) || pos.line < 0 || !Number.isSafeInteger(pos.byte) || pos.byte < 0) throw invalid();
    return { snapshot, position: pos };
  }
  async function coverage() { return { sources: coverageOf(await store.snapshot(), retention) }; }
  async function search(input, { signal } = {}) {
    const query = validateQuery(input);
    if (closed) throw expired();
    if (active >= 2) throw archiveError(429, 'LOG_QUERY_BUSY', '다른 로그 검색이 진행 중이에요. 잠시 후 다시 시도해 주세요.');
    active++;
    const controller = new AbortController(), started = now();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    function wait(promise) {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', onAbort));
      });
    }
    let snapshot, position, initialPosition, scannedBytes = 0, progressed = false, reason = null;
    const lines = [];
    try {
      prune();
      if (query.cursor) ({ snapshot, position } = decode(query.cursor, query));
      else {
        const state = await wait(store.snapshot());
        const hours = state.catalog.hours.filter(entry => entry.source === query.source && timeKey(entry.hour) < timeKey(query.end) && timeKey(new Date(Date.parse(entry.hour) + 3600000).toISOString()) > timeKey(query.start)).sort((a, b) => a.hour.localeCompare(b.hour));
        const frozen = { catalog: { hours }, checkpoint: state.checkpoint };
        const size = Buffer.byteLength(JSON.stringify(frozen));
        if (size > maxSnapshotBytes) throw archiveError(503, 'LOG_SNAPSHOT_TOO_LARGE', '검색 범위를 줄여 주세요.');
        while (snapshots.size >= maxSnapshots || cacheBytes + size > maxSnapshotBytes) drop(snapshots.keys().next().value);
        snapshot = { id: randomUUID(), fingerprint: fingerprint(query), expires: now() + snapshotTtlMs, state: frozen, coverage: coverageOf(state, retention, query.source)[0], size };
        snapshots.set(snapshot.id, snapshot); cacheBytes += size;
        position = hours.length ? { source: query.source, hour: hours[0].hour, memberStart: 0, line: 0, byte: 0 } : null;
      }
      initialPosition = position ? { ...position } : null;
      const covered = snapshot.coverage;
      const incomplete = !covered.oldest || timeKey(query.start) < timeKey(covered.oldest) || timeKey(query.end) > timeKey(covered.newest) || covered.gaps.some(gap => !gap.from || !gap.to || timeKey(gap.from) < timeKey(query.end) && timeKey(gap.to) > timeKey(query.start));
      const result = () => ({ source: query.source, requestedRange: { start: query.start, end: query.end }, coverage: covered, lines, returned: lines.length, nextCursor: position ? encode(snapshot, position) : null, complete: position === null, incomplete, partialReason: position ? reason : null, scannedBytes, collectionLagSeconds: covered.collectionLagSeconds });
      if (Buffer.byteLength(JSON.stringify(result())) + 1024 > maxResponseBytes) throw archiveError(503, 'LOG_RESPONSE_TOO_LARGE', '보관 범위 정보가 너무 커요.');
      const hours = snapshot.state.catalog.hours;
      const startHour = position ? hours.findIndex(entry => entry.source === position.source && entry.hour === position.hour) : hours.length;
      if (startHour < 0) throw invalid();
      outer: for (let h = startHour; h < hours.length; h++) {
        const entry = hours[h];
        const index = await wait(store.readIndex(entry));
        let first = h === startHour ? index.members.findIndex(member => member.start === position.memberStart) : 0;
        if (first < 0) throw invalid();
        for (let m = first; m < index.members.length; m++) {
          const member = index.members[m];
          const resume = h === startHour && m === first ? { ...position } : { line: 0, byte: 0 };
          if (resume.line >= member.lineCount || resume.byte > member.uncompressedBytes) throw invalid();
          position = { source: entry.source, hour: entry.hour, memberStart: member.start, line: resume.line, byte: resume.byte };
          const nextMember = () => m + 1 < index.members.length ? { source: entry.source, hour: entry.hour, memberStart: index.members[m + 1].start, line: 0, byte: 0 } : h + 1 < hours.length ? { source: hours[h + 1].source, hour: hours[h + 1].hour, memberStart: 0, line: 0, byte: 0 } : null;
          const inputStream = createReadStream(store.file(entry.file), { start: member.start, end: member.end - 1, highWaterMark: 16384, signal: controller.signal });
          const gzip = createGunzip({ chunkSize: 16384 });
          inputStream.on('error', error => gzip.destroy(error));
          inputStream.pipe(gzip);
          const abortRead = () => { inputStream.destroy(); gzip.destroy(Object.assign(new Error('Aborted'), { name: 'AbortError' })); };
          controller.signal.addEventListener('abort', abortRead, { once: true });
          let lineNumber = 0, lineBytes = 0, parts = [], memberBytes = 0;
          try {
            for await (const chunk of gzip) {
              let offset = 0;
              while (offset < chunk.length) {
                if (signal?.aborted) throw archiveError(499, 'LOG_QUERY_CANCELLED', '로그 검색을 취소했어요.');
                if (controller.signal.aborted || now() - started >= timeoutMs || scannedBytes >= maxScanBytes) {
                  reason = scannedBytes >= maxScanBytes ? 'scan_bytes' : 'timeout';
                  break outer;
                }
                const newline = chunk.indexOf(10, offset);
                const end = newline < 0 ? chunk.length : newline + 1;
                const length = Math.min(end - offset, maxScanBytes - scannedBytes);
                const piece = chunk.subarray(offset, offset + length);
                scannedBytes += length; memberBytes += length; lineBytes += length;
                if (lineNumber >= resume.line && lineBytes <= MAX_LINE_BYTES) parts.push(Buffer.from(piece));
                if (lineBytes > MAX_LINE_BYTES) parts = [];
                offset += length;
                if (lineNumber > resume.line || lineNumber === resume.line && lineBytes > resume.byte) {
                  progressed = true;
                  position = { source: entry.source, hour: entry.hour, memberStart: member.start, line: lineNumber, byte: lineBytes };
                }
                if (newline >= 0 && offset === newline + 1) {
                  if (lineNumber >= resume.line) {
                    const before = { source: entry.source, hour: entry.hour, memberStart: member.start, line: lineNumber, byte: 0 };
                    const id = `${entry.source}/${entry.hour}/${member.start}/${lineNumber}`;
                    const line = projectLine(lineBytes > MAX_LINE_BYTES ? '' : Buffer.concat(parts).toString('utf8'), entry, id, lineBytes > MAX_LINE_BYTES);
                    const matchesTime = !line.time || timeKey(line.time) >= timeKey(query.start) && timeKey(line.time) < timeKey(query.end);
                    if (matchesTime && searchable({ message: line.message, fields: line.fields }).toLowerCase().includes(query.q.toLowerCase())) {
                      const display = { ...line, message: cut(line.message), program: cut(line.program), priority: cut(line.priority), ...(line.fields ? { fields: Object.fromEntries(Object.entries(line.fields).map(([key, value]) => [key, cut(value)])) } : {}) };
                      lines.push(display);
                      if (Buffer.byteLength(JSON.stringify(result())) + 1024 > maxResponseBytes) { lines.pop(); position = before; reason = 'response_bytes'; break outer; }
                    }
                  }
                  lineNumber++; lineBytes = 0; parts = [];
                  if (lineNumber >= resume.line) position = lineNumber === member.lineCount ? nextMember() : { source: entry.source, hour: entry.hour, memberStart: member.start, line: lineNumber, byte: 0 };
                  if (lines.length >= query.limit && lineNumber < member.lineCount) { reason = 'limit'; break outer; }
                }
              }
            }
            if (memberBytes !== member.uncompressedBytes || lineNumber !== member.lineCount || lineBytes !== 0) throw archiveError(502, 'LOG_ARCHIVE_READ_FAILED', '보관 로그를 읽을 수 없어요.');
          } catch (error) {
            if (timedOut && !signal?.aborted && error.name === 'AbortError') { reason = 'timeout'; break outer; }
            throw error;
          } finally {
            controller.signal.removeEventListener('abort', abortRead);
            inputStream.destroy(); gzip.destroy();
          }
          position = nextMember();
          if (lines.length >= query.limit) { reason = 'limit'; break outer; }
        }
      }
      if (signal?.aborted) throw archiveError(499, 'LOG_QUERY_CANCELLED', '로그 검색을 취소했어요.');
      if (position && (!progressed || !advances(position, initialPosition))) throw cannotAdvance();
      // Revalidate every pinned file, including already visited ones, against
      // retention/replacement before publishing any part of this snapshot.
      // snapshot() normally resolves from the store's in-memory publication.
      // After the deadline, never wait behind a blocked writer to validate it.
      const current = await (timedOut ? Promise.race([store.snapshot(), new Promise((_, reject) => setImmediate(() => reject(cannotAdvance())))]) : wait(store.snapshot()));
      const identities = new Map(current.catalog.hours.map(entry => [`${entry.source}/${entry.hour}`, entry]));
      for (const entry of hours) {
        const actual = identities.get(`${entry.source}/${entry.hour}`);
        if (!actual || actual.fileId !== entry.fileId || actual.compressedBytes < entry.compressedBytes) throw expired();
      }
      const response = result();
      if (Buffer.byteLength(JSON.stringify(response)) > maxResponseBytes) throw archiveError(503, 'LOG_RESPONSE_TOO_LARGE', '로그 응답이 너무 커요.');
      return response;
    } catch (error) {
      if (error.code === 'ARCHIVE_SNAPSHOT_EXPIRED' || error.code === 'ENOENT') throw expired();
      if (signal?.aborted) throw archiveError(499, 'LOG_QUERY_CANCELLED', '로그 검색을 취소했어요.');
      if (timedOut && !error.status) throw cannotAdvance();
      if (error.status) throw error;
      throw archiveError(502, 'LOG_ARCHIVE_READ_FAILED', '보관 로그를 읽을 수 없어요.');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); active--;
    }
  }
  return { search, coverage, close() { closed = true; snapshots.clear(); cacheBytes = 0; } };
}
