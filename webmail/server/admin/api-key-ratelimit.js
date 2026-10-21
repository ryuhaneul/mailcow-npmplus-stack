import { AppError } from '../errors.js';

const minute = 60_000;
function limited(until, now) {
  const error = new AppError(429, 'RATE_LIMITED', '요청이 많아요. 잠시 뒤 다시 시도해 주세요.');
  error.retryAfter = Math.max(1, Math.ceil((until - now) / 1000));
  throw error;
}

export function createApiKeyRateLimiter({ now = Date.now, maxEntries = 10_000 } = {}) {
  const ips = new Map(), keys = new Map();
  function pruneIp(ip, at) {
    const record = ips.get(ip);
    if (!record) return;
    record.failures = record.failures.filter(attempt => attempt.at > at - 10 * minute);
    if (record.until <= at && !record.failures.length && record.blockedUntil <= at) { ips.delete(ip); return; }
    return record;
  }
  function sweep() {
    const at = now();
    for (const ip of ips.keys()) pruneIp(ip, at);
    for (const [id, record] of keys) if (record.until <= at) keys.delete(id);
  }
  // Reserve failures before the asynchronous store lookup. Successful authentication releases it.
  function reserveIp(ip) {
    const at = now();
    let record = pruneIp(ip, at);
    if (!record) {
      if (ips.size >= maxEntries) sweep();
      if (ips.size >= maxEntries) limited(at + minute, at);
      record = { count: 0, until: at + minute, failures: [], blockedUntil: 0 };
      ips.set(ip, record);
    }
    if (record.until <= at) { record.count = 0; record.until = at + minute; }
    if (record.count >= 300) limited(record.until, at);
    record.count++;
    if (record.blockedUntil > at) limited(record.blockedUntil, at);
    const attempt = { at };
    record.failures.push(attempt);
    if (record.failures.length >= 5) record.blockedUntil = at + 5 * minute;
    return () => {
      record.failures = record.failures.filter(value => value !== attempt);
      record.blockedUntil = record.failures.length >= 5 ? record.failures.at(-1).at + 5 * minute : 0;
    };
  }
  // Only authenticated persistent ids may reach this map, including denied permissions.
  function reserveKey(id) {
    const at = now();
    let record = keys.get(id);
    if (record?.until <= at) { keys.delete(id); record = undefined; }
    if (!record) {
      if (keys.size >= maxEntries) sweep();
      if (keys.size >= maxEntries) limited(at + minute, at);
      record = { count: 0, until: at + minute };
      keys.set(id, record);
    }
    if (record.count >= 120) limited(record.until, at);
    record.count++;
  }
  return { reserveIp, reserveKey, sweep };
}
