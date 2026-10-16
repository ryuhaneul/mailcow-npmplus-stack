import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
export const etag = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function assertUnchanged(expected, current) {
  if (typeof expected !== 'string' || expected !== etag(current)) throw new AppError(409, 'CHANGED_ELSEWHERE', '다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.');
}
export function createResourceLock() {
  const pending = new Map();
  async function run(target, operation) {
    const previous = pending.get(target) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    pending.set(target, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (pending.get(target) === current) pending.delete(target);
    }
  }
  return { run };
}
