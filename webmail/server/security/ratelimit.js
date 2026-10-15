import { AppError } from '../errors.js';

const MINUTE = 60_000;

export function createRateLimiter({ now = Date.now } = {}) {
  const ips = new Map();
  const emails = new Map();
  const passwords = new Map();

  function prune(map, key, window) {
    const record = map.get(key);
    if (!record) return null;
    record.times = record.times.filter(time => time > now() - window);
    if (!record.times.length && record.blockedUntil <= now()) {
      map.delete(key);
      return null;
    }
    return record;
  }
  function limited(until) {
    const error = new AppError(429, 'RATE_LIMITED', '시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.');
    error.retryAfter = Math.max(1, Math.ceil((until - now()) / 1000));
    throw error;
  }
  function checkLogin(ip, email) {
    const ipRecord = prune(ips, ip, 10 * MINUTE);
    const emailRecord = prune(emails, email, 15 * MINUTE);
    const until = Math.max(ipRecord?.blockedUntil ?? 0, emailRecord?.blockedUntil ?? 0);
    if (until > now()) limited(until);
  }
  function recordFailure(ip, email) {
    for (const [map, key, window] of [[ips, ip, 10 * MINUTE], [emails, email, 15 * MINUTE]]) {
      const record = prune(map, key, window) ?? { times: [], blockedUntil: 0 };
      record.times.push(now());
      if (record.times.length >= 5) record.blockedUntil = now() + 15 * MINUTE;
      map.set(key, record);
    }
  }
  function checkPassword(email) {
    const record = prune(passwords, email, 60 * MINUTE) ?? { times: [], blockedUntil: 0 };
    if (record.times.length >= 5) limited(record.times[0] + 60 * MINUTE);
    record.times.push(now());
    passwords.set(email, record);
  }
  function sweep() {
    for (const [map, window] of [[ips, 10 * MINUTE], [emails, 15 * MINUTE], [passwords, 60 * MINUTE]]) {
      for (const key of map.keys()) prune(map, key, window);
    }
  }
  return { checkLogin, recordFailure, checkPassword, sweep };
}
