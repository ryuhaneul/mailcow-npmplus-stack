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
      let uidvalidity;
      try { ({ uidvalidity } = await mailboxStatus(client, path, ['UIDVALIDITY'])); }
      catch (error) {
        // A rejected post-mapping STATUS cannot establish the captured source identity.
        if (error.code === 'MAIL_REJECTED') throw stale();
        throw error;
      }
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

// Shared limits for scoped preparation and execution; keep UID commands bounded.
export const scopedUidLimit = 5000, scopedSetLimit = 16 * 1024;
export function uidSet(uids) {
  const ranges = [];
  let first, last;
  for (const uid of uids) {
    if (uid === last) continue;
    if (uid === last + 1) { last = uid; continue; }
    if (first !== undefined) ranges.push(first === last ? String(first) : `${first}:${last}`);
    first = last = uid;
  }
  if (first !== undefined) ranges.push(first === last ? String(first) : `${first}:${last}`);
  return ranges.join(',');
}
export function* scopedUidBatches(uids, limit = scopedUidLimit) {
  let batch = [], length = 0, first, last;
  for (const uid of uids) {
    const contiguous = batch.length && uid === last + 1;
    const added = contiguous ? (first === last ? 1 + String(uid).length : String(uid).length - String(last).length) : (batch.length ? 1 : 0) + String(uid).length;
    if (batch.length && (batch.length === limit || length + added > scopedSetLimit)) {
      yield batch;
      batch = []; length = 0; first = last = undefined;
    }
    if (!batch.length || uid !== last + 1) first = uid;
    const extra = batch.length && uid === last + 1 ? (first === last ? 1 + String(uid).length : String(uid).length - String(last).length) : (batch.length ? 1 : 0) + String(uid).length;
    length += extra; batch.push(uid); last = uid;
  }
  if (batch.length) yield batch;
}

export const scopedBatchPolicy = Object.freeze({
  initial: 500, min: 50, max: 2000, flagInitial: scopedUidLimit, flagMax: scopedUidLimit, targetMs: 2000, growth: 2,
  safety: 2, marginMs: 2000, minStartMs: 10000, mutationTimeoutMs: 120000,
});
export function scopedBatchState(action) {
  const flag = ['seen', 'unseen', 'flag', 'unflag'].includes(action);
  return { size: flag ? scopedBatchPolicy.flagInitial : scopedBatchPolicy.initial,
    max: flag ? scopedBatchPolicy.flagMax : scopedBatchPolicy.max, lastMs: 0, lastCount: 0 };
}
export function scopedBatchReserve(state, count) {
  const estimate = state.lastCount ? state.lastMs * count / state.lastCount : 0;
  return Math.max(scopedBatchPolicy.minStartMs, estimate * scopedBatchPolicy.safety + scopedBatchPolicy.marginMs);
}
export function updateScopedBatch(state, count, elapsedMs) {
  state.lastMs = elapsedMs; state.lastCount = count;
  state.size = Math.max(scopedBatchPolicy.min, Math.min(state.max,
    state.size * scopedBatchPolicy.growth, Math.floor(count * scopedBatchPolicy.targetMs / Math.max(1, elapsedMs))));
}
