import { createPool } from 'mysql2/promise';
import { AppError } from '../errors.js';
import { newOtpVersion, encryptOtpSeed, decryptOtpSeed, matchTotp, otpUnavailable } from './otp.js';

const accounts = 'mailstack_webmail.otp_accounts', policy = 'mailstack_webmail.otp_policy';
const columns = 'email,version,secret_ciphertext,nonce,tag,key_version,registered_at,last_step';
const metadata = 'email,version,registered_at';
const cleared = 'secret_ciphertext=NULL,nonce=NULL,tag=NULL,key_version=NULL,registered_at=NULL,last_step=-1';
const conflict = () => new AppError(409, 'OTP_STATE_CHANGED', '인증 설정이 바뀌었어요. 다시 로그인해 주세요.');
const invalidCode = () => new AppError(403, 'OTP_INVALID', '인증 코드를 확인해 주세요. 이미 사용한 코드는 다음 코드로 다시 시도해 주세요.');
const forbidden = () => new AppError(403, 'FORBIDDEN', '접근할 수 없어요.');
const versionBytes = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw conflict();
  return Buffer.from(value, 'hex');
};
function address(value) {
  if (typeof value !== 'string' || value.length > 255 || value !== value.trim().toLowerCase() || !value.includes('@') || /[\x00-\x20\x7f]/.test(value)) throw forbidden();
  return value;
}
function publicAccount(row) {
  if (!row) return null;
  if (!Buffer.isBuffer(row.version) || row.version.length !== 16) throw otpUnavailable();
  return { email: row.email, version: row.version.toString('hex'), enabled: row.registered_at !== null,
    registeredAt: row.registered_at === null ? null : row.registered_at instanceof Date ? row.registered_at.toISOString() : String(row.registered_at).replace(' ', 'T').replace(/Z?$/, 'Z') };
}
const publicPolicy = row => {
  if (!row || ![0, 1].includes(Number(row.force_all)) || !/^\d+$/.test(String(row.revision))) throw otpUnavailable();
  return { forceAll: Boolean(Number(row.force_all)), revision: String(row.revision), ...(row.updated_at === undefined ? {} : { updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at).replace(' ', 'T').replace(/Z?$/, 'Z'), updatedBy: row.updated_by }) };
};

export function createOtpStore({ config = {}, db, mode = 'webmail', now = Date.now } = {}) {
  if (!['webmail', 'admin'].includes(mode)) throw new TypeError('Invalid OTP store mode.');
  db ??= config.dbHost && config.dbUser && config.dbPassword ? createPool({ host: config.dbHost, database: config.dbName,
    user: config.dbUser, password: config.dbPassword, connectionLimit: 2, connectTimeout: 10000, timezone: 'Z', dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true }) : null;
  const assertMode = expected => { if (mode !== expected) throw forbidden(); };
  const ownAddress = session => { assertMode('webmail'); if (!session || typeof session !== 'object') throw forbidden(); return address(session.email); };
  const execute = async (connection, sql, values = []) => connection.execute({ sql, timeout: 5000 }, values);
  const query = async (connection, sql) => connection.query({ sql, timeout: 5000 });
  async function run(operation) {
    if (!db) throw otpUnavailable();
    try { return await operation(); } catch (error) { if (error instanceof AppError) throw error; throw otpUnavailable(); }
  }
  async function transaction(operation) {
    return run(async () => {
      let connection, started = false;
      try {
        connection = await db.getConnection();
        await query(connection, "SET time_zone = '+00:00'");
        await query(connection, 'SET SESSION innodb_lock_wait_timeout = 5');
        await query(connection, 'START TRANSACTION'); started = true;
        const value = await operation(connection);
        await query(connection, 'COMMIT'); started = false;
        return value;
      } catch (error) {
        if (started) { try { await query(connection, 'ROLLBACK'); } catch { connection.destroy?.(); } }
        if (['PROTOCOL_SEQUENCE_TIMEOUT', 'ETIMEDOUT'].includes(error.code)) connection?.destroy?.();
        throw error;
      } finally { connection?.release(); }
    });
  }
  async function policyFor(connection, admin = false) {
    const [rows] = await execute(connection, `SELECT id,force_all,revision${admin ? ',updated_at,updated_by' : ''} FROM ${policy} WHERE id=1 ${admin ? 'FOR UPDATE' : 'LOCK IN SHARE MODE'}`);
    return publicPolicy(rows[0]);
  }
  async function accountFor(connection, email, admin = false) {
    const [rows] = await execute(connection, `SELECT ${admin ? metadata : columns} FROM ${accounts} WHERE email=? FOR UPDATE`, [email]);
    return rows[0] ?? null;
  }
  function assertVersion(row, expected) {
    versionBytes(expected);
    if (!row || publicAccount(row).version !== expected) throw conflict();
  }
  async function ensureAccount(session) {
    const email = ownAddress(session), version = newOtpVersion();
    return run(async () => {
      await execute(db, `INSERT IGNORE INTO ${accounts} (email,version) VALUES (?,?)`, [email, versionBytes(version)]);
      return readAccess(session);
    });
  }
  async function readAccess(session) {
    const email = ownAddress(session);
    return run(async () => {
      const [rows] = await execute(db, `SELECT a.email,a.version,a.secret_ciphertext,a.nonce,a.tag,a.key_version,a.registered_at,a.last_step,p.force_all,p.revision FROM ${accounts} a JOIN ${policy} p ON p.id=1 WHERE a.email=?`, [email]);
      if (!rows.length) return null;
      const row = rows[0], state = publicAccount(row);
      return { ...state, forceAll: publicPolicy(row).forceAll, policyRevision: String(row.revision), lastStep: String(row.last_step),
        envelope: state.enabled ? { secret_ciphertext: row.secret_ciphertext, nonce: row.nonce, tag: row.tag, key_version: row.key_version } : null };
    });
  }
  async function confirmEnrollment(session, { draft, code, key, keyVersion }) {
    const email = ownAddress(session);
    return transaction(async connection => {
      const rule = await policyFor(connection), row = await accountFor(connection, email);
      assertVersion(row, session.otpVersion); assertVersion(row, draft.baseVersion);
      if (publicAccount(row).enabled || rule.revision !== draft.policyRevision) throw conflict();
      if (now() >= draft.expiresAt) throw new AppError(403, 'OTP_SETUP_EXPIRED', '등록 시간이 지났어요. 새 QR 코드로 다시 시작해 주세요.');
      const step = matchTotp(draft.seed, code, { now: now() }); if (step === null) throw invalidCode();
      const version = newOtpVersion(), envelope = encryptOtpSeed({ seed: draft.seed, email, version, key, keyVersion });
      const [result] = await execute(connection, `UPDATE ${accounts} SET secret_ciphertext=?,nonce=?,tag=?,key_version=?,registered_at=UTC_TIMESTAMP(6),last_step=?,version=? WHERE email=? AND version=? AND registered_at IS NULL`,
        [envelope.secret_ciphertext, envelope.nonce, envelope.tag, envelope.key_version, String(step), versionBytes(version), email, versionBytes(draft.baseVersion)]);
      if (result.affectedRows !== 1) throw conflict();
      const saved = await accountFor(connection, email);
      return { ...publicAccount(saved), forceAll: rule.forceAll, policyRevision: rule.revision, lastStep: String(step) };
    });
  }
  async function checkRegistered(connection, session, rule, { code, key, keyVersion }, disable) {
    const email = ownAddress(session), row = await accountFor(connection, email);
    assertVersion(row, session.otpVersion);
    const state = publicAccount(row); if (!state.enabled) throw conflict();
    const seed = decryptOtpSeed({ envelope: row, email, version: state.version, key, keyVersion });
    let step;
    try { step = matchTotp(seed, code, { now: now(), lastStep: row.last_step }); } finally { seed.fill(0); }
    if (step === null) throw invalidCode();
    const version = disable ? newOtpVersion() : state.version;
    const [result] = await execute(connection, disable
      ? `UPDATE ${accounts} SET ${cleared},version=? WHERE email=? AND version=? AND registered_at IS NOT NULL AND last_step<?`
      : `UPDATE ${accounts} SET last_step=? WHERE email=? AND version=? AND registered_at IS NOT NULL AND last_step<?`,
    [disable ? versionBytes(version) : String(step), email, versionBytes(state.version), String(step)]);
    if (result.affectedRows !== 1) throw conflict();
    return { ...state, version, ...(disable ? { enabled: false, registeredAt: null } : {}), lastStep: disable ? '-1' : String(step), forceAll: rule.forceAll, policyRevision: rule.revision };
  }
  async function verify(session, args) {
    ownAddress(session);
    return transaction(async connection => checkRegistered(connection, session, await policyFor(connection), args, false));
  }
  async function disable(session, args) {
    ownAddress(session);
    return transaction(async connection => {
      const rule = await policyFor(connection);
      if (rule.forceAll) throw new AppError(403, 'OTP_FORCED', '관리자가 2단계 인증을 필수로 설정했어요. 필수 적용 중에는 끌 수 없습니다.');
      return checkRegistered(connection, session, rule, args, true);
    });
  }
  async function getPolicy() {
    assertMode('admin');
    return run(async () => { const [rows] = await execute(db, `SELECT id,force_all,revision,updated_at,updated_by FROM ${policy} WHERE id=1`); return publicPolicy(rows[0]); });
  }
  async function setPolicy({ forceAll, revision, actor }) {
    assertMode('admin');
    if (typeof forceAll !== 'boolean' || typeof revision !== 'string' || !/^\d+$/.test(revision) || typeof actor !== 'string' || !actor || actor.length > 255) throw new AppError(422, 'INVALID_INPUT', '정책 입력값을 확인해 주세요.');
    return transaction(async connection => {
      const before = await policyFor(connection, true);
      if (before.revision !== revision) throw new AppError(409, 'CONFLICT', '다른 곳에서 정책이 바뀌었어요. 다시 확인해 주세요.');
      if (before.forceAll === forceAll) return { ...before, unchanged: true };
      const [result] = await execute(connection, `UPDATE ${policy} SET force_all=?,revision=revision+1,updated_at=UTC_TIMESTAMP(6),updated_by=? WHERE id=1 AND revision=?`, [Number(forceAll), actor, revision]);
      if (result.affectedRows !== 1) throw conflict();
      return policyFor(connection, true);
    });
  }
  async function readAccountStatus(value) {
    assertMode('admin'); const email = address(value);
    return run(async () => { const [rows] = await execute(db, `SELECT ${metadata} FROM ${accounts} WHERE email=?`, [email]); return publicAccount(rows[0]) ?? { email, version: null, enabled: false, registeredAt: null }; });
  }
  async function listRegistrations() {
    assertMode('admin');
    return run(async () => { const [rows] = await execute(db, `SELECT ${metadata} FROM ${accounts} WHERE registered_at IS NOT NULL`); return rows.map(publicAccount); });
  }
  async function reset({ email: value, version }) {
    assertMode('admin'); const email = address(value);
    return transaction(async connection => {
      const row = await accountFor(connection, email, true);
      if (!row && version === null) return { email, version: null, enabled: false, registeredAt: null, unchanged: true };
      assertVersion(row, version);
      const next = newOtpVersion();
      const [result] = await execute(connection, `UPDATE ${accounts} SET ${cleared},version=? WHERE email=? AND version=?`, [versionBytes(next), email, versionBytes(version)]);
      if (result.affectedRows !== 1) throw conflict();
      return { email, version: next, enabled: false, registeredAt: null };
    });
  }
  async function cleanup({ email: value, version }) {
    assertMode('admin'); const email = address(value);
    return transaction(async connection => {
      const row = await accountFor(connection, email, true);
      if (!row && (version === undefined || version === null)) return { unchanged: true };
      const current = publicAccount(row)?.version;
      if (version !== undefined) assertVersion(row, version);
      if (!current) throw conflict();
      const [result] = await execute(connection, `DELETE FROM ${accounts} WHERE email=? AND version=?`, [email, versionBytes(current)]);
      if (result.affectedRows !== 1) throw conflict();
      return { unchanged: false };
    });
  }
  return { ensureAccount, readAccess, confirmEnrollment, verify, disable, getPolicy, setPolicy, readAccountStatus, listRegistrations, reset, cleanup, close: async () => { await db?.end?.(); } };
}
