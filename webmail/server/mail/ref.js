import { AppError } from '../errors.js';
import { fetchOriginals, mailboxStatus } from './imap-raw.js';
import { checkBudget } from './list-query.js';

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
export async function originalRefs(client, session, set, { now = Date.now, freshValidity = false, budget } = {}) {
  const stale = () => new AppError(409, 'STALE_SCOPE', '메일함이 바뀌었어요. 다시 선택해 주세요.');
  const virtualValidity = Number(client.mailbox?.uidValidity);
  const current = new Map();
  if (freshValidity) {
    // Capture validity before discovering mappings, including a source recreated with the same UID.
    checkBudget(budget);
    const folders = await client.list({ listOnly: true });
    const paths = new Set(folders.filter(folder => folder.path !== 'WebmailVirtual' && !folder.path.startsWith('WebmailVirtual/') && !folder.flags?.has('\\Noselect')).map(folder => folder.path));
    for (const path of paths) {
      checkBudget(budget);
      const { uidvalidity } = await mailboxStatus(client, path, ['UIDVALIDITY']);
      current.set(path, { value: uidvalidity, at: now() });
    }
  }
  checkBudget(budget);
  const rows = await fetchOriginals(client, set);
  if (freshValidity) {
    if (rows.some(row => !current.has(row.path))) throw stale();
    for (const [path, record] of current) {
      checkBudget(budget);
      const { uidvalidity } = await mailboxStatus(client, path, ['UIDVALIDITY']);
      if (uidvalidity !== record.value) throw stale();
    }
    if (Number(client.mailbox?.uidValidity) !== virtualValidity) throw stale();
  } else {
    let cache = validityCache.get(session);
    if (!cache) { cache = new Map(); validityCache.set(session, cache); }
    for (const path of new Set(rows.map(row => row.path))) {
      let record = cache.get(path);
      if (!record || now() - record.at >= 60000) {
        checkBudget(budget);
        const { uidvalidity } = await mailboxStatus(client, path, ['UIDVALIDITY']);
        record = { value: uidvalidity, at: now() };
        cache.set(path, record);
      }
      current.set(path, record);
    }
  }
  return rows.map(row => {
    const uidValidity = current.get(row.path).value;
    return { ...row, uidValidity, ref: encodeRef(row.path, uidValidity, row.uid) };
  });
}
