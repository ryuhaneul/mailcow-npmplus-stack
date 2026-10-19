import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError } from '../errors.js';
import { etag } from './lock.js';

export const trustedHeader = '# mailstack trusted senders v1';
export function trustedInvalid(code) {
  const error = new AppError(422, 'INVALID_INPUT', '발신자, IP 주소와 용도를 확인해 주세요.');
  error.detail = { code };
  return error;
}
export const trustedConflict = () => new AppError(409, 'CONFLICT', '다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.');
const fileInvalid = () => new AppError(409, 'TRUSTED_FILE_INVALID', '신뢰 발신 장비 파일 형식이 올바르지 않아요.');
export function trustedSender(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@#|\x00-\x1f\x7f-\x9f"']+@[^\s@#|\x00-\x1f\x7f-\x9f"']+$/.test(value)) throw trustedInvalid('INVALID_SENDER');
  return value.toLowerCase();
}
export function trustedIp(value) {
  if (typeof value === 'string' && value.includes('/')) throw trustedInvalid('CIDR_NOT_ALLOWED');
  const family = typeof value === 'string' ? isIP(value) : 0;
  if (!family || /[\s%]/.test(value)) throw trustedInvalid('INVALID_IP');
  return family === 4 ? value : new URL(`http://[${value}]/`).hostname.slice(1, -1);
}
export function trustedMemo(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw trustedInvalid('MEMO_INVALID');
  if (Array.from(value).length > 80) throw trustedInvalid('MEMO_TOO_LONG');
  return value;
}
export function trustedIps(values) {
  if (!Array.isArray(values) || !values.length) throw trustedInvalid('INVALID_IP');
  if (values.length > 50) throw trustedInvalid('TOO_MANY_IPS');
  const ips = values.map(trustedIp);
  if (new Set(ips).size !== ips.length) throw trustedInvalid('DUPLICATE_IP');
  return ips.sort();
}
export function renderTrustedSenders(senders) {
  const lines = [trustedHeader];
  const seen = new Set();
  for (const row of [...senders].sort((a, b) => a.sender < b.sender ? -1 : a.sender > b.sender ? 1 : 0)) {
    const sender = trustedSender(row.sender), memo = trustedMemo(row.memo);
    if (seen.has(sender) || !Array.isArray(row.ips) || !row.ips.length) throw fileInvalid();
    seen.add(sender);
    const ips = row.ips.map(trustedIp).sort();
    if (new Set(ips).size !== ips.length) throw fileInvalid();
    lines.push(`#@sender ${sender} memo=${memo}`, ...ips.map(ip => `${sender}|${ip}`));
  }
  return `${lines.join('\n')}\n`;
}
export function parseTrustedSenders(text) {
  try {
    if (typeof text !== 'string' || !text.endsWith('\n')) throw fileInvalid();
    const lines = text.slice(0, -1).split('\n');
    if (lines.shift() !== trustedHeader) throw fileInvalid();
    const senders = [], seen = new Set(); let current;
    for (const line of lines) {
      const found = /^#@sender (\S+) memo=(.*)$/.exec(line);
      if (found) {
        const sender = trustedSender(found[1]);
        if (sender !== found[1] || seen.has(sender) || current && !current.ips.length) throw fileInvalid();
        seen.add(sender); current = { sender, memo: trustedMemo(found[2]), ips: [] }; senders.push(current);
      } else {
        const pair = line.split('|');
        if (pair.length !== 2 || !current || pair[0] !== current.sender) throw fileInvalid();
        const ip = trustedIp(pair[1]);
        if (ip !== pair[1] || current.ips.includes(ip)) throw fileInvalid();
        current.ips.push(ip);
      }
    }
    if (current && !current.ips.length) throw fileInvalid();
    return { senders: senders.map(row => ({ ...row, ips: row.ips.sort() })).sort((a, b) => a.sender < b.sender ? -1 : a.sender > b.sender ? 1 : 0), etag: etag(text) };
  } catch { throw fileInvalid(); }
}
export async function readTrustedSenders(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { throw fileInvalid(); }
  return parseTrustedSenders(text);
}
export async function writeTrustedSenders(path, senders, expected, fs = { open, readFile, rename, unlink }) {
  const text = renderTrustedSenders(senders);
  const temp = join(dirname(path), `.trusted_senders.map.${randomBytes(12).toString('hex')}`);
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o664);
    await handle.chmod(0o664);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    // Check after preparing the temporary file, immediately before replacing the map.
    const current = parseTrustedSenders(await fs.readFile(path, 'utf8'));
    if (current.etag !== expected) throw trustedConflict();
    await fs.rename(temp, path);
    return etag(text);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'WRITE_FAILED', '신뢰 발신 장비 목록을 저장하지 못했어요.');
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
  }
}
