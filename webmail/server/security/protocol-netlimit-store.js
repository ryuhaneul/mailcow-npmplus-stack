import { randomBytes } from 'node:crypto';
import { createPool } from 'mysql2/promise';
import { AppError } from '../errors.js';

const table = 'mailstack_webmail.account_protocol_netlimit';
const unavailable = (reason = 'DB_UNAVAILABLE') => Object.assign(new AppError(503, 'PROTOCOL_NETLIMIT_UNAVAILABLE', '사내 IP 제한 설정을 확인할 수 없어요. 다시 시도해 주세요.'), { reason });
const conflict = () => new AppError(409, 'CHANGED_ELSEWHERE', '다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.');
export const protocolNetlimitVersion = () => randomBytes(16).toString('hex');
export const protocolNetlimitState = row => ({ enabled: row.enabled, version: row.version });
export function createProtocolNetlimitStore({ config = {}, db, timeoutMs = 1000 } = {}) {
  db ??= config.dbHost && config.dbUser && config.dbPassword ? createPool({ host: config.dbHost, database: config.dbName,
    user: config.dbUser, password: config.dbPassword, connectionLimit: 2, waitForConnections: false, connectTimeout: timeoutMs }) : null;
  async function query(sql, values) {
    if (!db) throw unavailable();
    let connection, expired = false, timer;
    const work = (async () => {
      const acquired = await db.getConnection();
      if (expired) { acquired.release(); throw unavailable(); }
      connection = acquired;
      return connection.execute(sql, values);
    })();
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; connection?.destroy(); reject(unavailable('DB_TIMEOUT')); }, timeoutMs);
      })]);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw conflict();
      if (error instanceof AppError) throw error;
      throw unavailable();
    } finally { clearTimeout(timer); if (!expired) connection?.release(); }
  }
  async function read(email) {
    const [rows] = await query(`SELECT COALESCE(p.enabled,0) AS enabled, HEX(p.version) AS version,
      NOT EXISTS(SELECT 1 FROM mailstack_webmail.login_ip_allowlist) AS allowlist_empty, l.ip
      FROM (SELECT ? AS email) AS target LEFT JOIN ${table} p ON p.email=target.email
      LEFT JOIN mailstack_webmail.login_ip_allowlist l ON p.enabled=1`, [email]);
    if (!rows.length || ![0, 1, '0', '1'].includes(rows[0].enabled)) throw unavailable();
    const version = rows[0].version?.toLowerCase() ?? null;
    if (version !== null && !/^[a-f0-9]{32}$/.test(version)) throw unavailable();
    return { enabled: Number(rows[0].enabled) === 1, version, allowlistEmpty: Boolean(Number(rows[0].allowlist_empty)), ips: rows.map(row => row.ip).filter(ip => ip !== null && ip !== undefined) };
  }
  async function write({ email, enabled, expected, version = protocolNetlimitVersion() }) {
    if (typeof enabled !== 'boolean' || !/^[a-f0-9]{32}$/.test(version)) throw new AppError(422, 'INVALID_INPUT', '사내 IP 제한 입력값을 확인해 주세요.');
    const [result] = expected.version === null ?
      await query(`INSERT INTO ${table} (email,enabled,version) VALUES (?,?,UNHEX(?))`, [email, Number(enabled), version]) :
      await query(`UPDATE ${table} SET enabled=?,version=UNHEX(?) WHERE email=? AND version=UNHEX(?)`, [Number(enabled), version, email, expected.version]);
    if (result.affectedRows !== 1) throw conflict();
    return { enabled, version };
  }
  async function remove({ email, expected }) {
    if (expected.version === null) {
      const current = protocolNetlimitState(await read(email));
      if (current.version !== null) throw conflict();
      return current;
    }
    const [result] = await query(`DELETE FROM ${table} WHERE email=? AND version=UNHEX(?)`, [email, expected.version]);
    if (result.affectedRows !== 1) throw conflict();
    return { enabled: false, version: null };
  }
  return { read, write, remove, close: async () => { await db?.end?.(); } };
}
