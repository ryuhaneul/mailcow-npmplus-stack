import { isIP } from 'node:net';
import { createPool } from 'mysql2/promise';
import { AppError } from '../errors.js';

const table = 'mailstack_webmail.login_ip_allowlist';
const invalid = () => new AppError(422, 'INVALID_INPUT', 'IPv4/IPv6 주소·CIDR과 200자 이하 메모를 확인해 주세요.');
export function normalizeLoginIp(input, { allowWide = false } = {}) {
  if (typeof input !== 'string') throw invalid();
  const [address, rawBits, ...extra] = input.trim().split('/');
  let family = !address.includes('%') && isIP(address), width = family === 4 ? 32 : 128;
  if (!family || extra.length || rawBits !== undefined && (!/^\d+$/.test(rawBits) || Number(rawBits) > width)) throw invalid();
  let bits = rawBits === undefined ? width : Number(rawBits), number;
  if (family === 4) number = address.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n);
  else {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const [left, right] = canonical.split('::'), start = left ? left.split(':') : [], end = right ? right.split(':') : [];
    const parts = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
    number = parts.reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n);
    if (number >> 32n === 65535n && bits >= 96) { family = 4; width = 32; bits -= 96; number &= 0xffffffffn; }
  }
  if (!allowWide && bits < (family === 4 ? 16 : 48)) throw new AppError(422, 'INVALID_INPUT', '너무 넓은 대역은 넣을 수 없어요. IPv4는 /16 이상, IPv6는 /48 이상으로 입력해 주세요.');
  number = number >> BigInt(width - bits) << BigInt(width - bits);
  const normalized = family === 4 ? [24n, 16n, 8n, 0n].map(shift => String((number >> shift) & 255n)).join('.') :
    new URL(`http://[${Array.from({ length: 8 }, (_, i) => ((number >> BigInt((7 - i) * 16)) & 65535n).toString(16)).join(':')}]/`).hostname.slice(1, -1);
  return bits === width ? normalized : `${normalized}/${bits}`;
}
export function loginIpInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['ip', 'note'].includes(key))) throw invalid();
  const note = data.note ?? '';
  if (typeof note !== 'string' || !note.isWellFormed() || Array.from(note).length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(note)) throw invalid();
  return { ip: normalizeLoginIp(data.ip), note: note.trim() };
}
export function createLoginIpStore({ config = {}, db, mode = 'webmail' } = {}) {
  db ??= config.dbHost && config.dbUser && config.dbPassword ? createPool({ host: config.dbHost, database: config.dbName,
    user: config.dbUser, password: config.dbPassword, connectionLimit: 2, connectTimeout: 10000, timezone: 'Z', dateStrings: true }) : null;
  const unavailable = () => new AppError(503, 'LOGIN_IPS_UNAVAILABLE', '로그인 예외 IP 저장소를 사용할 수 없어요.');
  const assertAdmin = () => { if (mode !== 'admin') throw new AppError(403, 'FORBIDDEN', '접근할 수 없어요.'); };
  async function list() {
    if (!db) throw unavailable();
    try {
      const [rows] = await db.execute(`SELECT ip,note,created_at AS date,created_by AS actor FROM ${table} ORDER BY ip`);
      return { items: rows.map(row => ({ ...row, date: row.date instanceof Date ? row.date.toISOString() : String(row.date).replace(' ', 'T').replace(/Z?$/, 'Z') })) };
    } catch { throw unavailable(); }
  }
  async function change({ data, address, actor }) {
    assertAdmin();
    const value = data === undefined ? { ip: normalizeLoginIp(address, { allowWide: true }) } : loginIpInput(data);
    if (!db) throw unavailable();
    let connection;
    try {
      connection = await db.getConnection();
      await connection.query("SET time_zone = '+00:00'");
      await connection.beginTransaction();
      const [rows] = await connection.execute(`SELECT ip FROM ${table} ORDER BY ip FOR UPDATE`);
      const exists = rows.some(row => row.ip === value.ip);
      if (data !== undefined) {
        if (exists) throw new AppError(409, 'DUPLICATE_IP', '이미 등록된 IP·대역이에요.');
        if (rows.length >= 100) throw new AppError(422, 'LOGIN_IP_LIMIT', '최대 100개까지 등록할 수 있어요.');
        await connection.execute(`INSERT INTO ${table} (ip,note,created_by) VALUES (?,?,?)`, [value.ip, value.note, actor]);
      } else {
        if (!exists) throw new AppError(404, 'NOT_FOUND', '로그인 예외 IP를 찾을 수 없어요.');
        await connection.execute(`DELETE FROM ${table} WHERE ip = ?`, [value.ip]);
      }
      await connection.commit();
      return { ok: true };
    } catch (error) {
      if (connection) await connection.rollback();
      if (error instanceof AppError) throw error;
      if (error.code === 'ER_DUP_ENTRY') throw new AppError(409, 'DUPLICATE_IP', '이미 등록된 IP·대역이에요.');
      throw unavailable();
    } finally { connection?.release(); }
  }
  return { list, change, close: async () => { await db?.end?.(); } };
}
