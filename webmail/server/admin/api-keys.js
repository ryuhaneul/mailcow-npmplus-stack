import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { AppError } from '../errors.js';
import { createResourceLock } from './lock.js';

const tokenPattern = /^mak_v1_[A-Za-z0-9_-]{43}$/;
const idPattern = /^[a-f0-9]{32}$/;
const controls = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const fields = ['id', 'name', 'permission', 'allowedIps', 'expiresAt', 'createdBy', 'createdAt', 'lastUsedAt', 'lastUsedIp', 'revokedAt', 'digest'];
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const invalid = code => Object.assign(new AppError(422, 'INVALID_INPUT', 'API 키 입력값을 확인해 주세요.'), { detail: { code } });
const unavailable = () => new AppError(503, 'API_KEY_STORE_UNAVAILABLE', 'API 키 저장소를 사용할 수 없어요.');
const conflict = () => new AppError(409, 'CONFLICT', '이미 사용한 이름이나 식별자예요.');
const missing = () => new AppError(404, 'NOT_FOUND', 'API 키를 찾을 수 없어요.');
const digest = token => createHash('sha256').update(token).digest();

function nameInput(value) {
  if (typeof value !== 'string' || controls.test(value)) throw invalid('INVALID_NAME');
  const name = value.trim();
  if (!name || Array.from(name).length > 80) throw invalid('INVALID_NAME');
  return name;
}

function ipParts(value) {
  const family = typeof value === 'string' && !value.includes('%') ? isIP(value) : 0;
  if (!family) throw invalid('INVALID_IP');
  if (family === 4) return { family, address: value, number: value.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n) };
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const [left, right] = address.split('::');
  const start = left ? left.split(':') : [], end = right ? right.split(':') : [];
  const groups = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
  return { family, address, number: groups.reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n) };
}

function ipv4(number) { return [24n, 16n, 8n, 0n].map(shift => Number((number >> shift) & 255n)).join('.'); }
function ipAddress(value) {
  const ip = ipParts(value);
  return ip.family === 6 && ip.number >> 32n === 65535n ? ipv4(ip.number & 0xffffffffn) : ip.address;
}

// Masking only canonicalizes the stored network; BlockList performs membership checks.
function ipRule(value) {
  if (typeof value !== 'string') throw invalid('INVALID_IP');
  const parts = value.trim().split('/');
  if (parts.length > 2) throw invalid('INVALID_IP');
  let ip = ipParts(parts[0]), bits = ip.family === 4 ? 32 : 128;
  let prefix = parts.length === 1 ? bits : /^\d{1,3}$/.test(parts[1]) ? Number(parts[1]) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw invalid('INVALID_IP');
  if (ip.family === 6 && ip.number >> 32n === 65535n && prefix >= 96) {
    ip = ipParts(ipv4(ip.number & 0xffffffffn)); prefix -= 96; bits = 32;
  }
  const number = ip.number >> BigInt(bits - prefix) << BigInt(bits - prefix);
  const address = bits === 32 ? ipv4(number) : ipParts(Array.from({ length: 8 }, (_, i) => ((number >> BigInt((7 - i) * 16)) & 65535n).toString(16)).join(':')).address;
  return prefix === bits ? address : `${address}/${prefix}`;
}

function allowedInput(values) {
  if (!Array.isArray(values) || values.length > 32) throw invalid('INVALID_IPS');
  return [...new Set(values.map(ipRule))];
}

function ipAllowed(rules, value) {
  let address;
  try { address = ipAddress(value); } catch { return false; }
  if (!rules.length) return true;
  const list = new BlockList();
  for (const rule of rules) {
    const [network, prefix] = rule.split('/'), family = isIP(network) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(network, family);
    else list.addSubnet(network, Number(prefix), family);
  }
  return list.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
}

function validateFile(data) {
  if (!data || data.version !== 1 || Object.keys(data).sort().join(',') !== 'records,version' || !Array.isArray(data.records) || data.records.length > 1000) throw unavailable();
  const ids = new Set(), names = new Set();
  for (const row of data.records) {
    if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== [...fields].sort().join(',')) throw unavailable();
    if (typeof row.id !== 'string' || !idPattern.test(row.id) || ids.has(row.id) || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest) || !['read', 'full'].includes(row.permission)) throw unavailable();
    if (nameInput(row.name) !== row.name || names.has(row.name) || JSON.stringify(allowedInput(row.allowedIps)) !== JSON.stringify(row.allowedIps)) throw unavailable();
    if (typeof row.createdBy !== 'string' || !row.createdBy.trim() || controls.test(row.createdBy) || !iso(row.createdAt)) throw unavailable();
    if (![row.expiresAt, row.lastUsedAt, row.revokedAt].every(value => value === null || iso(value))) throw unavailable();
    if ((row.lastUsedAt === null) !== (row.lastUsedIp === null) || row.lastUsedIp !== null && ipAddress(row.lastUsedIp) !== row.lastUsedIp) throw unavailable();
    ids.add(row.id); names.add(row.name);
  }
  return data.records;
}

/** Single process/writer store. Token plaintext exists only in create's return value. */
export function createApiKeyStore({ directory = '/data/api-keys', now = Date.now, fs = filesystem } = {}) {
  const path = join(directory, 'keys.json'), lock = createResourceLock(), allocated = new Set(), uses = new Map();
  let records = [], seenFile = false;
  function checkMetadata(stat, mode, directoryEntry = false) {
    if ((directoryEntry ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o7777) !== mode || stat.uid !== process.getuid()) throw unavailable();
  }
  async function read() {
    let handle;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      checkMetadata(await fs.lstat(directory), 0o700, true);
      try { handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if (error.code !== 'ENOENT' || seenFile) throw error;
        records = []; return;
      }
      checkMetadata(await handle.stat(), 0o600);
      records = validateFile(JSON.parse(await handle.readFile('utf8')));
      seenFile = true;
    } catch { throw unavailable(); }
    finally { await handle?.close().catch(() => {}); }
  }
  async function save(candidate) {
    const temp = join(directory, `.keys.${randomBytes(16).toString('hex')}.tmp`);
    let handle, dir, renamed = false;
    try {
      dir = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      checkMetadata(await dir.stat(), 0o700, true);
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify({ version: 1, records: candidate })}\n`, 'utf8');
      await handle.sync();
      await handle.close(); handle = undefined;
      await fs.rename(temp, path); renamed = true;
      seenFile = true;
      await dir.sync();
      records = candidate;
    } catch {
      if (renamed) {
        // Never restore the old memory snapshot after an observable rename.
        await read();
        throw new AppError(503, 'API_KEY_STORE_DURABILITY_UNCERTAIN', '변경은 저장됐지만 내구성을 확인하지 못했어요. 다시 읽고 확인해 주세요.');
      }
      throw unavailable();
    } finally {
      await handle?.close().catch(() => {});
      await dir?.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
    }
  }
  function dto(row) {
    const { digest: _digest, ...item } = row;
    const use = uses.get(row.id);
    if (use && (row.lastUsedAt === null || use.lastUsedAt >= row.lastUsedAt)) Object.assign(item, use);
    return { ...item, allowedIps: [...item.allowedIps], status: row.revokedAt !== null ? 'revoked' : row.expiresAt !== null && now() >= Date.parse(row.expiresAt) ? 'expired' : 'active' };
  }
  function reason(row, ip) {
    if (!row) return 'UNKNOWN_KEY';
    if (row.revokedAt !== null) return 'REVOKED';
    if (row.expiresAt !== null && now() >= Date.parse(row.expiresAt)) return 'EXPIRED';
    if (!ipAllowed(row.allowedIps, ip)) return 'IP_DENIED';
    return null;
  }
  const run = operation => lock.run('store', async () => { await read(); return operation(); });
  const allocateId = () => {
    let id;
    do { id = randomBytes(16).toString('hex'); } while (allocated.has(id));
    allocated.add(id); return id;
  };
  async function create(input, createdBy, { id } = {}) {
    return run(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'permission', 'allowedIps', 'expiresAt'].includes(key))) throw invalid('INVALID_INPUT');
      if (records.some(row => row.id === id)) throw conflict();
      if (typeof id !== 'string' || !idPattern.test(id) || !allocated.has(id)) throw invalid('INVALID_ID');
      const name = nameInput(input.name), allowedIps = allowedInput(input.allowedIps === undefined ? [] : input.allowedIps), expiresAt = input.expiresAt ?? null;
      if (!['read', 'full'].includes(input.permission)) throw invalid('INVALID_PERMISSION');
      if (expiresAt !== null && (!iso(expiresAt) || now() >= Date.parse(expiresAt))) throw invalid('INVALID_EXPIRY');
      if (typeof createdBy !== 'string' || !createdBy.trim() || controls.test(createdBy)) throw invalid('INVALID_CREATOR');
      if (records.some(row => row.id === id || row.name === name)) throw conflict();
      if (records.length >= 1000) throw invalid('TOO_MANY_KEYS');
      const token = `mak_v1_${randomBytes(32).toString('base64url')}`;
      const row = { id, name, permission: input.permission, allowedIps, expiresAt, createdBy, createdAt: new Date(now()).toISOString(), lastUsedAt: null, lastUsedIp: null, revokedAt: null, digest: digest(token).toString('hex') };
      await save([...records, row]);
      allocated.delete(id);
      return { item: dto(row), token };
    });
  }
  async function authenticate(token, ip) {
    return run(() => {
      if (typeof token !== 'string' || !tokenPattern.test(token)) return { ok: false, reason: 'INVALID_TOKEN' };
      const hash = digest(token);
      const row = records.find(record => timingSafeEqual(hash, Buffer.from(record.digest, 'hex')));
      const failure = reason(row, ip);
      return failure ? { ok: false, reason: failure } : { ok: true, item: dto(row) };
    });
  }
  async function recordUse(id, ip) {
    return run(async () => {
      const row = records.find(record => record.id === id), failure = reason(row, ip);
      if (failure) throw Object.assign(new AppError(403, 'API_KEY_FORBIDDEN', 'API 키로 접근할 수 없어요.'), { reason: failure });
      const use = { lastUsedAt: new Date(now()).toISOString(), lastUsedIp: ipAddress(ip) };
      if (row.lastUsedAt === null || now() - Date.parse(row.lastUsedAt) >= 60_000) {
        const updated = { ...row, ...use };
        await save(records.map(record => record.id === id ? updated : record));
      }
      uses.set(id, use);
      return dto(records.find(record => record.id === id));
    });
  }
  async function revoke(id) {
    return run(async () => {
      const row = records.find(record => record.id === id);
      if (!row) throw missing();
      if (row.revokedAt !== null) return dto(row);
      const updated = { ...row, revokedAt: new Date(now()).toISOString() };
      await save(records.map(record => record.id === id ? updated : record));
      return dto(updated);
    });
  }
  const list = () => run(() => records.map(dto));
  const get = id => run(() => { const row = records.find(record => record.id === id); if (!row) throw missing(); return dto(row); });
  return { list, get, allocateId, create, revoke, authenticate, recordUse };
}
