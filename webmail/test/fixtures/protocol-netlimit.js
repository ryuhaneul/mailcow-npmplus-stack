import { randomBytes } from 'node:crypto';
import { AppError } from '../../server/errors.js';
export function createFakeProtocolNetlimitStore() {
  const rows = new Map();
  const store = {
    rows, allowlistEmpty: false, failure: null, writeFailure: null, removeFailure: null,
    async read(email) {
      if (store.failure) throw store.failure;
      return { ...(rows.get(email) ?? { enabled: false, version: null }), allowlistEmpty: store.allowlistEmpty, ips: [] };
    },
    async write({ email, enabled, expected, version = randomBytes(16).toString('hex') }) {
      if (store.writeFailure) throw store.writeFailure;
      if ((rows.get(email)?.version ?? null) !== expected.version) throw new AppError(409, 'CHANGED_ELSEWHERE', '합성 충돌');
      const row = { enabled, version }; rows.set(email, row); return { ...row };
    },
    async remove({ email, expected }) {
      if (store.removeFailure) throw store.removeFailure;
      if ((rows.get(email)?.version ?? null) !== expected.version) throw new AppError(409, 'CHANGED_ELSEWHERE', '합성 충돌');
      rows.delete(email); return { enabled: false, version: null };
    }, async close() {},
  };
  return store;
}
