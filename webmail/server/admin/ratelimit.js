import { AppError } from '../errors.js';

export function createAdminRateLimiter({ now = Date.now } = {}) {
  const ips = new Map();
  const usernames = new Map();
  function prune(map, key) {
    const record = map.get(key);
    if (!record) return null;
    record.times = record.times.filter(time => time.at > now() - 10 * 60_000);
    if (!record.times.length && record.blockedUntil <= now()) { map.delete(key); return null; }
    return record;
  }
  function check(ip, username) {
    const until = Math.max(prune(ips, ip)?.blockedUntil ?? 0, prune(usernames, username)?.blockedUntil ?? 0);
    if (until <= now()) return;
    const error = new AppError(429, 'RATE_LIMITED', '반복된 실패로 5분 뒤 다시 시도할 수 있습니다.');
    error.retryAfter = Math.max(1, Math.ceil((until - now()) / 1000));
    throw error;
  }
  function remaining(ip, username) {
    return Math.max(0, 5 - Math.max(prune(ips, ip)?.times.length ?? 0, prune(usernames, username)?.times.length ?? 0));
  }
  // Reserve before yielding to mailcow: concurrent requests share the same budget.
  function reserve(ip, username) {
    check(ip, username);
    const attempt = { at: now() };
    for (const [map, key] of [[ips, ip], [usernames, username]]) {
      const record = prune(map, key) ?? { times: [], blockedUntil: 0 };
      record.times.push(attempt);
      if (record.times.length >= 5) record.blockedUntil = now() + 5 * 60_000;
      map.set(key, record);
    }
    return () => {
      for (const [map, key] of [[ips, ip], [usernames, username]]) {
        const record = prune(map, key);
        if (!record) continue;
        record.times = record.times.filter(time => time !== attempt);
        record.blockedUntil = record.times.length >= 5 ? record.times.at(-1).at + 5 * 60_000 : 0;
        prune(map, key);
      }
    };
  }
  function sweep() { for (const map of [ips, usernames]) for (const key of map.keys()) prune(map, key); }
  return { reserve, remaining, sweep };
}
