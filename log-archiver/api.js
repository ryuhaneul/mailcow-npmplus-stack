import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createSearch, archiveError, MAX_RESPONSE_BYTES } from './search.js';

/** Internal server only. D0 owns listen/address and closes this server on shutdown. */
export function createArchiveServer({ store, key, search = createSearch({ store }), status } = {}) {
  if (typeof key !== 'string' || !key) throw new TypeError('Archive key required');
  const expected = createHash('sha256').update(key).digest();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 12000, headersTimeout: 10000 }, async (request, response) => {
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', abort);
    function send(code, value) {
      if (response.destroyed) return;
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw archiveError(503, 'LOG_RESPONSE_TOO_LARGE', '로그 응답이 너무 커요.');
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...(code === 429 ? { 'Retry-After': '1' } : {}) });
      response.end(body);
    }
    try {
      const url = new URL(request.url, 'http://archive.internal');
      if (request.method === 'GET' && url.pathname === '/healthz' && !url.search) { response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return; }
      const supplied = request.headers['x-log-archive-key'];
      const digest = createHash('sha256').update(typeof supplied === 'string' ? supplied : '').digest();
      const count = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'x-log-archive-key').length;
      if (!timingSafeEqual(expected, digest) || count !== 1) throw archiveError(403, 'FORBIDDEN', '접근할 수 없어요.');
      if (request.method !== 'GET') throw archiveError(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청이에요.');
      if (url.pathname === '/v1/search') send(200, await search.search(url.searchParams, { signal: controller.signal }));
      else if (url.pathname === '/v1/coverage' && !url.search) send(200, await search.coverage());
      else if (url.pathname === '/v1/status' && !url.search) {
        if (status) send(200, await status());
        else {
          const { checkpoint } = await store.snapshot();
          // No raw checkpoint, fingerprints, paths, content, or configuration.
          send(200, { generations: Object.entries(checkpoint.generations ?? {}).map(([generation, value]) => ({ generation, source: value.source, offset: value.offset, ...(Number.isSafeInteger(value.observedSize) ? { observedSize: value.observedSize } : {}) })) });
        }
      } else throw archiveError(404, 'NOT_FOUND', '요청한 API를 찾을 수 없어요.');
    } catch (error) {
      const safe = error.status ? error : archiveError(503, 'LOG_ARCHIVE_UNAVAILABLE', '보관 로그를 읽을 수 없어요.');
      send(safe.status, { error: { code: safe.code, message: safe.message } });
    } finally { response.removeListener('close', abort); }
  });
  server.on('close', () => search.close());
  return server;
}
