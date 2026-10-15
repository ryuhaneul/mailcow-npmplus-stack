import { AppError } from '../errors.js';
import { fetchOriginals, mailboxStatus } from './imap-raw.js';

const invalid = () => new AppError(400, 'INVALID_REF', '메일 참조를 확인해 주세요.');
const validUint = n => Number.isInteger(n) && n > 0 && n <= 0xffffffff;
function validTuple(tuple) {
  return Array.isArray(tuple) && tuple.length === 3 && typeof tuple[0] === 'string' && tuple[0].length > 0 && !/[\0\r\n]/.test(tuple[0]) && validUint(tuple[1]) && validUint(tuple[2]);
}
export function encodeRef(path, uidValidity, uid) {
  const tuple = [path, Number(uidValidity), Number(uid)];
  if (!validTuple(tuple)) throw invalid();
  return Buffer.from(JSON.stringify(tuple)).toString('base64url');
}
export function decodeRef(ref) {
  if (typeof ref !== 'string' || !/^[A-Za-z0-9_-]+$/.test(ref)) throw invalid();
  let tuple;
  try {
    const bytes = Buffer.from(ref, 'base64url');
    tuple = JSON.parse(bytes.toString('utf8'));
    if (bytes.toString('base64url') !== ref || !validTuple(tuple) || Buffer.from(JSON.stringify(tuple)).toString('base64url') !== ref) throw invalid();
  } catch { throw invalid(); }
  return { path: tuple[0], uidValidity: tuple[1], uid: tuple[2] };
}
export function assertUidValidity(client, ref) {
  if (client.mailbox?.path !== ref.path || Number(client.mailbox?.uidValidity) !== ref.uidValidity) {
    throw new AppError(409, 'STALE_REF', '메일함이 바뀌었어요. 화면을 새로 고쳐 주세요.');
  }
}
const validityCache = new WeakMap();
export async function originalRefs(client, session, set, { now = Date.now } = {}) {
  const rows = await fetchOriginals(client, set);
  let cache = validityCache.get(session);
  if (!cache) { cache = new Map(); validityCache.set(session, cache); }
  const refs = [];
  for (const row of rows) {
    let record = cache.get(row.path);
    if (!record || now() - record.at >= 60000) {
      const { uidvalidity } = await mailboxStatus(client, row.path, ['UIDVALIDITY']);
      record = { value: uidvalidity, at: now() };
      cache.set(row.path, record);
    }
    refs.push({ ...row, ref: encodeRef(row.path, record.value, row.uid) });
  }
  return refs;
}
