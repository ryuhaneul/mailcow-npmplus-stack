import { normalizeLoginIp } from './login-ip-store.js';
import { BlockList, isIP } from 'node:net';
import { AppError } from '../errors.js';

const MINUTE = 60_000;

export function createRateLimiter({ now = Date.now, logger, readLoginIps = async () => ({ items: [] }) } = {}) {
  let allowedIps = { ipv4: new BlockList(), ipv6: new BlockList() }, nextRead = -Infinity, reading;
  async function refreshLoginIps() {
    if (reading) return reading;
    if (now() < nextRead) return;
    nextRead = now() + MINUTE;
    reading = (async () => {
      try {
        const { items } = await readLoginIps();
        const next = { ipv4: new BlockList(), ipv6: new BlockList() };
        let ignored = 0;
        for (const { ip } of items) {
          let normalized;
          try { normalized = normalizeLoginIp(ip); } catch { ignored++; continue; }
          const [address, bits] = normalized.split('/');
          const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
          if (bits === undefined) next[family].addAddress(address, family);
          else next[family].addSubnet(address, Number(bits), family);
        }
        if (ignored) logger?.warn({ code: 'LOGIN_IP_RULES_IGNORED', count: ignored }, '허용 범위를 벗어난 로그인 예외 IP 행을 무시했습니다.');
        allowedIps = next;
      } catch { /* Retain the last successfully read list, or the empty default. */ }
    })();
    try { await reading; } finally { reading = undefined; }
  }
  function ipAllowed(ip) {
    let address;
    try { address = normalizeLoginIp(ip); } catch { return false; }
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    return allowedIps[family].check(address, family);
  }
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

// Separate from password login limits: login-IP exceptions never exempt OTP.
export function createOtpRateLimiter({ now = Date.now } = {}) {
  const emails = new Map(), ips = new Map();
  const windowMs = 600_000, blockMs = 300_000;
  function prune(map, key) {
    const record = map.get(key);
    if (!record) return null;
    record.times = record.times.filter(attempt => attempt.at > now() - windowMs);
    if (!record.times.length && record.blockedUntil <= now()) { map.delete(key); return null; }
    return record;
  }
  function reserve(ip, email) {
    const buckets = [[emails, email, 5], [ips, ip, 30]];
    const until = Math.max(...buckets.map(([map, key]) => prune(map, key)?.blockedUntil ?? 0));
    if (until > now()) {
      const error = new AppError(429, 'OTP_RATE_LIMITED', '인증 시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.');
      error.retryAfter = Math.max(1, Math.ceil((until - now()) / 1000)); throw error;
    }
    const attempt = { at: now() };
    for (const [map, key, limit] of buckets) {
      const record = prune(map, key) ?? { times: [], blockedUntil: 0 };
      record.times.push(attempt);
      if (record.times.length >= limit) record.blockedUntil = now() + blockMs;
      map.set(key, record);
    }
    let released = false;
    return () => {
      if (released) return; released = true;
      for (const [map, key, limit] of buckets) {
        const record = prune(map, key); if (!record) continue;
        record.times = record.times.filter(value => value !== attempt);
        record.blockedUntil = record.times.length >= limit ? record.times.at(-1).at + blockMs : 0;
        prune(map, key);
      }
    };
  }
  function sweep() { for (const map of [emails, ips]) for (const key of map.keys()) prune(map, key); }
  return { reserve, sweep };
}
