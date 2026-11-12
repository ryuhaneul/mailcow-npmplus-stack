import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';

export const ADMIN_ACCOUNTS_LOCK = 'admin-accounts';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
export const etag = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function assertUnchanged(expected, current) {
  if (typeof expected !== 'string' || expected !== etag(current)) throw new AppError(409, 'CHANGED_ELSEWHERE', '다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.');
}
export { createResourceLock } from '../resource-lock.js';
