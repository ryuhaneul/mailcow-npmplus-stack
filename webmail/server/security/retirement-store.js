import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { createPool } from 'mysql2/promise';
import { AppError } from '../errors.js';

const accounts = 'mailstack_webmail.account_retirement';
const recipients = 'mailstack_webmail.retirement_recipient_keys';
const lockName = 'mailstack:retirement-routing';
const unavailable = (reason = 'DB_UNAVAILABLE') => Object.assign(new AppError(503, 'RETIREMENT_BLOCK_UNAVAILABLE', '퇴사 설정을 확인할 수 없어요. 다시 시도해 주세요.'), { reason });
const invalid = () => new AppError(422, 'INVALID_INPUT', '퇴사 설정 입력값을 확인해 주세요.');
const conflict = () => new AppError(409, 'CHANGED_ELSEWHERE', '다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.');
const versionPattern = /^[a-f0-9]{32}$/;
export const retirementVersion = () => randomBytes(16).toString('hex');
export function retirementAddress(value) {
  if (typeof value !== 'string') throw invalid();
  const address = value.trim().toLowerCase();
  const [local, domain, extra] = address.split('@');
  if (address.length > 254 || !local || local.length > 64 || extra !== undefined ||
    !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
    !domain || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw invalid();
  return address;
}
export const emptyRetirementState = () => ({ retired: false, receiveBlocked: false, recordedAt: null, source: null, sourceAuditId: null, updatedBy: null, updatedAt: null, version: null, pendingOperation: null });
function dateValue(value) {
  if (value === null) return null;
  const text = value instanceof Date ? value.toISOString() : typeof value === 'string' && /^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  if (typeof text !== 'string' || !Number.isFinite(Date.parse(text))) throw unavailable('DB_STATE_INVALID');
  return new Date(text).toISOString();
}
function dto(row) {
  if (!row) return emptyRetirementState();
  const version = row.version?.toLowerCase();
  if (!versionPattern.test(version ?? '') || ![0, 1, '0', '1'].includes(row.retired) || ![0, 1, '0', '1'].includes(row.receive_blocked) ||
    Number(row.receive_blocked) && !Number(row.retired) || !['leave', 'legacy_import'].includes(row.source)) throw unavailable('DB_STATE_INVALID');
  let pending;
  try { pending = typeof row.pending_operation === 'string' ? JSON.parse(row.pending_operation) : row.pending_operation ?? null; }
  catch { throw unavailable('DB_STATE_INVALID'); }
  if (pending !== null && (typeof pending !== 'object' || Array.isArray(pending))) throw unavailable('DB_STATE_INVALID');
  return { retired: Boolean(Number(row.retired)), receiveBlocked: Boolean(Number(row.receive_blocked)), recordedAt: dateValue(row.recorded_at),
    source: row.source, sourceAuditId: row.source_audit_id, updatedBy: row.updated_by, updatedAt: dateValue(row.updated_at), version, pendingOperation: pending };
}

export function createRetirementStore({ config = {}, db, mode = 'admin', timeoutMs = 1000 } = {}) {
  if (!['admin', 'public'].includes(mode)) throw invalid();
  db ??= config.dbHost && config.dbUser && config.dbPassword ? createPool({ host: config.dbHost, database: config.dbName,
    user: config.dbUser, password: config.dbPassword, dateStrings: true, timezone: 'Z', connectionLimit: 2, waitForConnections: false, connectTimeout: timeoutMs }) : null;
  const scope = new AsyncLocalStorage();
  async function acquire() {
    if (!db) throw unavailable();
    let expired = false, timer;
    const work = Promise.resolve().then(() => db.getConnection()).then(connection => {
      if (expired) { connection.release(); throw unavailable('DB_TIMEOUT'); }
      return { connection, dead: false };
    });
    try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(unavailable('DB_TIMEOUT')); }, timeoutMs); })]); }
    catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
    finally { clearTimeout(timer); }
  }
  async function query(state, sql, values = []) {
    if (state.dead) throw unavailable('DB_CONNECTION_LOST');
    let timer;
    try {
      return await Promise.race([state.connection.execute(sql, values), new Promise((_, reject) => {
        timer = setTimeout(() => { state.dead = true; state.connection.destroy(); reject(unavailable('DB_TIMEOUT')); }, timeoutMs);
      })]);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw conflict();
      if (error instanceof AppError) throw error;
      // A failed connection must not return to the pool with an advisory lock.
      if (!state.dead) { state.dead = true; state.connection.destroy(); }
      throw unavailable();
    } finally { clearTimeout(timer); }
  }
  async function connection(operation) {
    const current = scope.getStore();
    if (current) { if (current.finished) throw unavailable('LOCK_LOST'); return operation(current); }
    let state;
    try { state = await acquire(); return await operation(state); }
    finally { if (state && !state.dead) state.connection.release(); }
  }
  async function transaction(operation) {
    return connection(async state => {
      await query(state, 'START TRANSACTION');
      try { const result = await operation(state); await query(state, 'COMMIT'); return result; }
      catch (error) { if (!state.dead) { try { await query(state, 'ROLLBACK'); } catch {} } throw error; }
    });
  }
  async function read(email) {
    const address = retirementAddress(email);
    return connection(async state => {
      const [rows] = await query(state, `SELECT retired,receive_blocked,recorded_at,source,source_audit_id,updated_by,updated_at,HEX(version) AS version,pending_operation FROM ${accounts} WHERE email=?`, [address]);
      if (!Array.isArray(rows) || rows.length > 1) throw unavailable('DB_STATE_INVALID');
      return dto(rows[0]);
    });
  }
  async function blockedRecipients(addresses) {
    if (!Array.isArray(addresses)) throw invalid();
    const keys = [...new Set(addresses.flatMap(value => {
      const full = retirementAddress(value), [local, domain] = full.split('@');
      return local.includes('+') && local.split('+')[0] ? [full, retirementAddress(`${local.split('+')[0]}@${domain}`)] : [full];
    }))].sort();
    if (!keys.length) return [];
    return connection(async state => {
      const [rows] = await query(state, `SELECT DISTINCT recipient FROM ${recipients} WHERE recipient IN (${keys.map(() => '?').join(',')}) ORDER BY recipient`, keys);
      if (!Array.isArray(rows) || rows.some(row => !keys.includes(row.recipient))) throw unavailable('DB_STATE_INVALID');
      return rows.map(row => row.recipient);
    });
  }
  async function keysForOwner(email) {
    const address = retirementAddress(email);
    return connection(async state => {
      const [rows] = await query(state, `SELECT recipient FROM ${recipients} WHERE owner=? ORDER BY recipient`, [address]);
      if (!Array.isArray(rows)) throw unavailable('DB_STATE_INVALID');
      try { return rows.map(row => retirementAddress(row.recipient)); } catch { throw unavailable('DB_STATE_INVALID'); }
    });
  }
  async function write({ email, retired, receiveBlocked, recordedAt = null, source, sourceAuditId = null, updatedBy, pendingOperation = null, keys = [], expected, version = retirementVersion() }) {
    const address = retirementAddress(email);
    if (typeof retired !== 'boolean' || typeof receiveBlocked !== 'boolean' || receiveBlocked && !retired ||
      !['leave', 'legacy_import'].includes(source) || !versionPattern.test(version) || !expected ||
      expected.version !== null && !versionPattern.test(expected.version ?? '') ||
      sourceAuditId !== null && !versionPattern.test(sourceAuditId) || typeof updatedBy !== 'string' || !updatedBy || updatedBy.length > 255 || /[\x00-\x1f\x7f]/.test(updatedBy) ||
      recordedAt !== null && (typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))) ||
      pendingOperation !== null && (typeof pendingOperation !== 'object' || Array.isArray(pendingOperation)) || !Array.isArray(keys)) throw invalid();
    const normalizedKeys = [...new Set(keys.map(retirementAddress))].sort();
    if (receiveBlocked ? !normalizedKeys.includes(address) : normalizedKeys.length) throw invalid();
    let pending;
    try { pending = pendingOperation === null ? null : JSON.stringify(pendingOperation); }
    catch { throw invalid(); }
    const recorded = recordedAt === null ? null : new Date(recordedAt).toISOString().slice(0, 23).replace('T', ' ');
    return transaction(async state => {
      const values = [Number(retired), Number(receiveBlocked), recorded, source, sourceAuditId, updatedBy, pending, version];
      const [result] = expected.version === null ?
        await query(state, `INSERT INTO ${accounts} (updated_at,retired,receive_blocked,recorded_at,source,source_audit_id,updated_by,pending_operation,version,email) VALUES (UTC_TIMESTAMP(6),?,?,?,?,?,?,?,UNHEX(?),?)`, [...values, address]) :
        await query(state, `UPDATE ${accounts} SET updated_at=UTC_TIMESTAMP(6),retired=?,receive_blocked=?,recorded_at=?,source=?,source_audit_id=?,updated_by=?,pending_operation=?,version=UNHEX(?) WHERE email=? AND version=UNHEX(?)`, [...values, address, expected.version]);
      if (result.affectedRows !== 1) throw conflict();
      await query(state, `DELETE FROM ${recipients} WHERE owner=?`, [address]);
      for (const recipient of normalizedKeys) await query(state, `INSERT INTO ${recipients} (recipient,owner) VALUES (?,?)`, [recipient, address]);
      return { retired, receiveBlocked, recordedAt: dateValue(recorded), source, sourceAuditId, updatedBy, version, pendingOperation: pendingOperation === null ? null : JSON.parse(pending) };
    });
  }
  async function remove({ email, expected }) {
    const address = retirementAddress(email);
    if (!expected || expected.version !== null && !versionPattern.test(expected.version ?? '')) throw invalid();
    if (expected.version === null) { if ((await read(address)).version !== null) throw conflict(); return emptyRetirementState(); }
    return transaction(async state => {
      // The FK cascades only this owner's keys, never another owner sharing a key.
      const [result] = await query(state, `DELETE FROM ${accounts} WHERE email=? AND version=UNHEX(?)`, [address, expected.version]);
      if (result.affectedRows !== 1) throw conflict();
      return emptyRetirementState();
    });
  }
  async function withRoutingLock(operation) {
    if (typeof operation !== 'function') throw invalid();
    const current = scope.getStore();
    if (current) { if (current.dead || current.finished) throw unavailable('LOCK_LOST'); return operation(); }
    return connection(async state => {
      const [rows] = await query(state, 'SELECT GET_LOCK(?,0) AS acquired', [lockName]);
      if (Number(rows?.[0]?.acquired) !== 1) throw unavailable('ROUTING_BUSY');
      try { const value = await scope.run(state, operation); if (state.dead) throw unavailable('DB_CONNECTION_LOST'); return value; }
      finally {
        try { if (!state.dead) { const [released] = await query(state, 'SELECT RELEASE_LOCK(?) AS released', [lockName]); if (Number(released?.[0]?.released) !== 1) { state.dead = true; state.connection.destroy(); throw unavailable('LOCK_LOST'); } } }
        finally { state.finished = true; }
      }
    });
  }
  const common = { blockedRecipients, close: async () => { await db?.end?.(); } };
  return mode === 'public' ? common : { ...common, read, write, remove, keysForOwner, withRoutingLock };
}
