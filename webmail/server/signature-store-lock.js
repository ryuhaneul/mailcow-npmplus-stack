import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors.js';

// One queue per login account, shared by every service and session in this process.
const pending = new Map();
const active = new AsyncLocalStorage();
export async function withSignatureStoreLock(email, operation) {
  if (typeof email !== 'string' || !email.trim()) throw new TypeError('A login account is required');
  const account = email.trim().toLowerCase();
  if (active.getStore()?.has(account)) throw new AppError(503, 'SIGNATURE_STORE_REENTRANT', '서명 저장 작업이 중첩됐어요.');
  const previous = pending.get(account) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  pending.set(account, current);
  await previous;
  const scope = new Set([...(active.getStore() ?? []), account]);
  try {
    return await active.run(scope, operation);
  } finally {
    scope.delete(account);
    release();
    if (pending.get(account) === current) pending.delete(account);
  }
}
