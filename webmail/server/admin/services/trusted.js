import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { readTrustedSenders, writeTrustedSenders, trustedSender, trustedIp, trustedMemo, trustedIps, trustedInvalid, trustedConflict } from '../trusted-senders.js';

const snapshot = parsed => ({ version: 1, senders: parsed.senders });
const missing = () => new AppError(404, 'NOT_FOUND', '신뢰 발신자를 찾을 수 없어요.');
export function createTrustedService({ config, audit, lock, history, mailcow }) {
  const read = () => readTrustedSenders(config.trustedSenderFile);
  async function list() {
    const parsed = await read();
    return { ...parsed, pairs: parsed.senders.reduce((sum, row) => sum + row.ips.length, 0) };
  }
  async function change({ actor, ip, data, sender: address, address: inputIp }, action) {
    const allowed = action === 'add-sender' ? ['sender', 'memo', 'ips', 'etag'] : action === 'add-ips' ? ['ips', 'etag'] : action === 'memo' ? ['memo', 'etag'] : ['etag'];
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !allowed.includes(key)) || typeof data.etag !== 'string') throw new AppError(422, 'INVALID_INPUT', '요청 값을 확인해 주세요.');
    const sender = trustedSender(action === 'add-sender' ? data.sender : address);
    const ips = ['add-sender', 'add-ips'].includes(action) ? trustedIps(data.ips) : undefined;
    const memo = action === 'add-sender' ? trustedMemo(data.memo === undefined ? '' : data.memo) : action === 'memo' ? trustedMemo(data.memo) : undefined;
    const selectedIp = action === 'remove-ip' ? trustedIp(inputIp) : undefined;
    return lock.run('trusted', async () => {
      const parsed = await read();
      if (parsed.etag !== data.etag) throw trustedConflict();
      const senders = structuredClone(parsed.senders), index = senders.findIndex(row => row.sender === sender), row = senders[index];
      if (action === 'add-sender') {
        if (row) throw new AppError(409, 'EXISTS', '이미 등록한 발신자예요.');
        senders.push({ sender, memo, ips });
      } else {
        if (!row) throw missing();
        if (action === 'add-ips') {
          if (ips.some(value => row.ips.includes(value))) throw trustedInvalid('DUPLICATE_PAIR');
          row.ips = [...row.ips, ...ips].sort();
        } else if (action === 'memo') row.memo = memo;
        else if (action === 'remove-sender') senders.splice(index, 1);
        else {
          if (!row.ips.includes(selectedIp)) throw missing();
          row.ips = row.ips.filter(value => value !== selectedIp);
          if (!row.ips.length) senders.splice(index, 1);
        }
      }
      senders.sort((a, b) => a.sender < b.sender ? -1 : a.sender > b.sender ? 1 : 0);
      return audit.run({ actor, ip, action: `trusted.${action}`, target: 'trusted', kind: 'config', revertible: true,
        before: snapshot(parsed), after: { version: 1, senders } }, async intent => {
        const etag = await writeTrustedSenders(config.trustedSenderFile, senders, data.etag);
        return { result: 'ok', auditId: intent.id, etag };
      });
    });
  }
  async function recent(session) {
    try {
      // Read the raw history: the general log projection prefers MIME From.
      const value = await mailcow.call(session, 'GET', '/api/v1/get/logs/rspamd-history/1000');
      if (!Array.isArray(value) && !(value && typeof value === 'object' && !Object.keys(value).length)) throw new Error();
      const rows = Array.isArray(value) ? value.slice(0, 1000) : [], counts = {}, seen = new Set(), times = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.sender_smtp !== 'string' || typeof row.ip !== 'string' || !Number.isFinite(Number(row.unix_time)) || row.unix_time === '' || row.unix_time == null) throw new Error();
        const time = Number(row.unix_time); times.push(time);
        if (!row.sender_smtp) continue;
        const sender = trustedSender(row.sender_smtp), ip = trustedIp(row.ip), key = `${sender}|${ip}`;
        const id = row['message-id'];
        const unique = typeof id === 'string' && id ? JSON.stringify([id, sender, ip]) : JSON.stringify(row);
        if (seen.has(unique)) {
          // A repeated history row can still carry the most recent observation.
          if (counts[key]) counts[key].lastSeen = Math.max(counts[key].lastSeen, time);
          continue;
        }
        seen.add(unique);
        counts[key] ??= { count: 0, lastSeen: time };
        counts[key].count++; counts[key].lastSeen = Math.max(counts[key].lastSeen, time);
      }
      return { range: rows.length ? { from: Math.min(...times), to: Math.max(...times), lines: rows.length } : null, failed: false, counts };
    } catch { return { range: null, failed: true, counts: {} }; }
  }
  for (const action of ['add-sender', 'add-ips', 'remove-ip', 'remove-sender', 'memo']) history.register(`trusted.${action}`, {
    label: '신뢰 발신 장비를 바꿨어요',
    read: async () => snapshot(await read()),
    prepareRevert: async ({ record }) => {
      if (!isDeepStrictEqual(snapshot(await read()), record.after)) throw trustedConflict();
      return { expected: record.after, target: record.before };
    },
    write: async ({ expected, value }) => {
      const parsed = await read();
      if (!isDeepStrictEqual(snapshot(parsed), expected)) throw trustedConflict();
      await writeTrustedSenders(config.trustedSenderFile, value.senders, parsed.etag);
      return { target: value };
    },
  });
  return { list, recent, addSender: args => change(args, 'add-sender'), addIps: args => change(args, 'add-ips'),
    removeIp: args => change(args, 'remove-ip'), removeSender: args => change(args, 'remove-sender'), memo: args => change(args, 'memo') };
}
