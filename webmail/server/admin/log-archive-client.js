import http from 'node:http';
import https from 'node:https';
import { AppError } from '../errors.js';

export const LOG_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_ARCHIVE_TIMEOUT_MS = 12_000;
export const archiveUnavailable = () => new AppError(503, 'LOG_ARCHIVE_UNAVAILABLE', '보관 로그를 읽을 수 없어요. 잠시 뒤 다시 시도해 주세요.');

export function createLogArchiveClient({ config, logger, timeoutMs = LOG_ARCHIVE_TIMEOUT_MS, maxResponseBytes = LOG_ARCHIVE_MAX_BYTES }) {
  const enabled = Boolean(config.logArchiveUrl && config.logArchiveKey);
  async function request(path, query, { signal } = {}) {
    if (!enabled) throw archiveUnavailable();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const url = new URL(path, config.logArchiveUrl);
      if (query) url.search = new URLSearchParams(query).toString();
      const transport = url.protocol === 'https:' ? https : http;
      const response = await new Promise((resolve, reject) => {
        const req = transport.request(url, { method: 'GET', signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, headers: { 'X-Log-Archive-Key': config.logArchiveKey, accept: 'application/json' } }, response => {
          const chunks = []; let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > maxResponseBytes) { reject(archiveUnavailable()); response.destroy(); }
            else chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => resolve({ status: response.statusCode, contentType: response.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.once('error', reject);
        req.end();
      });
      // Never expose upstream error bodies, credentials, URLs or filesystem paths.
      if (response.status === 403) logger?.warn('보관기 인증 실패');
      if (response.status === 410) throw new AppError(410, 'ARCHIVE_SEARCH_RESTART', '검색 기준이 바뀌었어요. 다시 검색해 주세요.');
      if (response.status === 422) throw new AppError(422, 'INVALID_INPUT', '로그 출처와 검색 조건을 확인해 주세요.');
      if (response.status === 429) throw Object.assign(new AppError(429, 'LOG_QUERY_BUSY', '다른 로그 검색이 진행 중이에요. 잠시 후 다시 시도해 주세요.'), { retryAfter: 1 });
      if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.contentType ?? '')) throw archiveUnavailable();
      const result = JSON.parse(response.body);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw archiveUnavailable();
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw archiveUnavailable();
    } finally { clearTimeout(timer); }
  }
  return {
    enabled,
    search: (query, options) => request('/v1/search', query, options),
    status: options => request('/v1/status', undefined, options),
    coverage: options => request('/v1/coverage', undefined, options),
  };
}
