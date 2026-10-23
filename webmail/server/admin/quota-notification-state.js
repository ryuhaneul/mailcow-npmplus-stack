import * as filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from '../errors.js';
export const defaultQuotaNotifications = Object.freeze({ enabled: false, sender: '', threshold: 90, intervalMinutes: 60 });
export const notificationAddress = value => typeof value === 'string' && value.length <= 254 && value.split('@')[0].length <= 64 && /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value);
const unavailable = () => new AppError(503, 'QUOTA_NOTIFICATION_STORE_UNAVAILABLE', '쿼터 알림 저장소를 확인해 주세요.');
export function validateQuotaNotifications(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'enabled,intervalMinutes,sender,threshold' ||
    typeof value.enabled !== 'boolean' || typeof value.sender !== 'string' || /[\x00-\x20\x7f-\x9f]/.test(value.sender) || value.sender !== '' && !notificationAddress(value.sender) ||
    !Number.isInteger(value.threshold) || value.threshold < 50 || value.threshold > 99 || !Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 15 || value.intervalMinutes > 1440) {
    throw new AppError(422, 'INVALID_INPUT', '보내는 주소와 기준(50~99%), 간격(15~1440분)을 확인해 주세요.');
  }
  return { ...value, sender: value.sender.toLowerCase() };
}
export const emptyQuotaNotificationState = () => ({ v: 1, accounts: {}, lastCheckAt: null, lastRunFailure: null });
const iso = value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const failure = value => value === null || value && iso(value.at) && value.at !== null && ['SMTP_REJECTED','SEND_FAILED','UNCONFIRMED','COLLECTION_FAILED'].includes(value.code) && Object.keys(value).sort().join(',') === 'at,code';
function validState(value) {
  return value?.v === 1 && Object.keys(value).sort().join(',') === 'accounts,lastCheckAt,lastRunFailure,v' && iso(value.lastCheckAt) && failure(value.lastRunFailure) &&
    value.accounts && typeof value.accounts === 'object' && !Array.isArray(value.accounts) && Object.entries(value.accounts).every(([address, row]) => notificationAddress(address) && row &&
      Object.keys(row).sort().join(',') === 'lastFailure,lastSentAt,pendingAt' && iso(row.lastSentAt) && iso(row.pendingAt) && failure(row.lastFailure));
}
export function createQuotaNotificationStore({ dir = '/data/quota-notifications', fs = filesystem } = {}) {
  async function read(name, fallback, validate) {
    let handle;
    try {
      handle = await fs.open(join(dir, `${name}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (stat.mode & 0o777) !== 0o600) throw unavailable();
      const value = JSON.parse(await handle.readFile('utf8'));
      if (!validate(value)) throw unavailable();
      return value;
    } catch (error) { if (error.code === 'ENOENT') return fallback(); throw unavailable(); }
    finally { await handle?.close(); }
  }
  async function write(name, value, validate) {
    if (!validate(value)) throw unavailable();
    const temp = join(dir, `.${name}-${randomUUID()}.tmp`);
    let handle, directory;
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
      await fs.chmod(dir, 0o700);
      directory = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temp, join(dir, `${name}.json`)); await directory.sync();
    } catch { throw unavailable(); }
    finally { await handle?.close(); await directory?.close(); await fs.unlink(temp).catch(() => {}); }
  }
  const validSettings = value => { try { return JSON.stringify(validateQuotaNotifications(value)) === JSON.stringify(value); } catch { return false; } };
  return {
    readSettings: () => read('settings', () => ({ ...defaultQuotaNotifications }), validSettings),
    saveSettings: value => write('settings', value, validSettings),
    readState: () => read('state', emptyQuotaNotificationState, validState),
    saveState: value => write('state', value, validState),
  };
}
