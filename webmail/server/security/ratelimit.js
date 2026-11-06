import { BlockList, isIP } from 'node:net';
import { AppError } from '../errors.js';

const MINUTE = 60_000;

export function createRateLimiter({ now = Date.now, readLoginIps = async () => ({ items: [] }) } = {}) {
  let allowedIps = new BlockList(), nextRead = -Infinity, reading;
  async function refreshLoginIps() {
    if (reading) return reading;
    if (now() < nextRead) return;
    nextRead = now() + MINUTE;
    reading = (async () => {
      try {
        const { items } = await readLoginIps();
        const next = new BlockList();
        for (const { ip } of items) {
          const [address, bits] = ip.split('/');
          const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
          if (bits === undefined) next.addAddress(address, family);
          else next.addSubnet(address, Number(bits), family);
        }
        allowedIps = next;
      } catch { /* Retain the last successfully read list, or the empty default. */ }
    })();
    try { await reading; } finally { reading = undefined; }
  }
  const ipAllowed = ip => allowedIps.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
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
    const ipRecord = ipAllowed(ip) ? null : prune(ips, ip, 10 * MINUTE);
    const emailRecord = prune(emails, email, 15 * MINUTE);
    const until = Math.max(ipRecord?.blockedUntil ?? 0, emailRecord?.blockedUntil ?? 0);
    if (until > now()) limited(until);
  }
  function recordFailure(ip, email) {
    const limits = [[emails, email, 15 * MINUTE, 5]];
    if (!ipAllowed(ip)) limits.push([ips, ip, 10 * MINUTE, 30]);
    for (const [map, key, window, threshold] of limits) {
      const record = prune(map, key, window) ?? { times: [], blockedUntil: 0 };
      record.times.push(now());
      if (record.times.length >= threshold) record.blockedUntil = now() + 15 * MINUTE;
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
  return { refreshLoginIps, checkLogin, recordFailure, checkPassword, sweep };
}
