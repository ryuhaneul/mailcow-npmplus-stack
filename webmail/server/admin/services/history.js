import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';

const notRevertible = () => new AppError(409, 'NOT_REVERTIBLE', '이 변경은 되돌릴 수 없어요.');
const oldShareMessage = '이 공유 기록은 이전 형식이라 되돌릴 수 없어요. 공유 화면에서 직접 바꿔 주세요.';
const isOldShare = record => ['share.grant', 'share.revoke'].includes(record.action) && (record.before?.version !== 2 || record.after?.version !== 2);
const changed = () => new AppError(409, 'CHANGED_ELSEWHERE', '다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.');
export function createHistoryService({ audit, lock }) {
  const adapters = new Map();
  function register(action, adapter) { adapters.set(action, adapter); }
  function decorate(record) {
    const adapter = adapters.get(record.action);
    // 목록 시점의 가능 여부이며 실행 직전 현재 값이 바뀌면 409로 멈춘다.
    const canRevert = record.kind === 'config' && record.revertible === true && record.result === 'ok' && Boolean(adapter) && !isOldShare(record);
    const label = adapter?.label ?? '설정을 바꿨어요';
    const suffix = !record.result ? ' (결과 확인 안 됨)' : record.result === 'failed' ? ' (실패)' : record.result === 'partial' ? ' (일부 적용)' : record.kind === 'irreversible' ? ' (되돌리기 불가)' : '';
    return { ...record, ...(isOldShare(record) ? { revertCode: 'RECORD_FORMAT_OLD', revertReason: oldShareMessage } : {}), ...(adapter?.prepareRevert && record.detail?.skipped ? { skipped: record.detail.skipped } : {}), canRevert, summary: `${record.actor}님이 ${record.target} ${label}${suffix}` };
  }
  async function records() {
    const entries = new Map();
    const { rows, damaged } = await audit.read();
    for (const row of rows) {
      if (row.phase === 'intent') entries.set(row.id, { ...row });
      else if (row.phase === 'result' && entries.has(row.id)) {
        const entry = entries.get(row.id);
        Object.assign(entry, { result: row.result, resultTs: row.ts, detail: row.detail, ...(row.code ? { code: row.code } : {}) });
      }
    }
    return { records: [...entries.values()].reverse().map(decorate).sort((a, b) => b.ts.localeCompare(a.ts)), damaged };
  }
  async function detail(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new AppError(404, 'NOT_FOUND', '변경 기록을 찾을 수 없어요.');
    const data = await records();
    const record = data.records.find(entry => entry.id === id);
    if (!record) throw new AppError(404, 'NOT_FOUND', '변경 기록을 찾을 수 없어요.');
    return { ...record, damaged: data.damaged };
  }
  async function list({ filter = 'all', page = '1', limit = '50', q = '' } = {}) {
    if (!['all', 'revertible', 'irreversible'].includes(filter) || !/^[1-9]\d*$/.test(String(page)) || !Number.isSafeInteger(Number(page)) ||
      !/^[1-9]\d*$/.test(String(limit)) || Number(limit) > 50 || typeof q !== 'string') throw new AppError(422, 'INVALID_INPUT', '기록 검색 조건을 확인해 주세요.');
    const search = q.trim().toLowerCase();
    const data = await records();
    const items = data.records.filter(record =>
      (filter === 'all' || (filter === 'revertible' ? record.canRevert : record.kind === 'irreversible')) &&
      (!search || `${record.actor} ${record.target} ${record.summary}`.toLowerCase().includes(search)));
    const offset = (Number(page) - 1) * 50;
    return { items: items.slice(offset, offset + Number(limit)), total: items.length, page: Number(page), pageSize: 50, damaged: data.damaged };
  }
  async function revert(id, { confirm, actor, ip, session }) {
    if (confirm !== true) throw new AppError(422, 'INVALID_INPUT', '되돌리기를 확인해 주세요.');
    const record = await detail(id);
    if (isOldShare(record)) throw new AppError(409, 'RECORD_FORMAT_OLD', oldShareMessage);
    if (!record.canRevert) throw notRevertible();
    const adapter = adapters.get(record.action);
    const runLocked = adapter.runLocked ?? ((target, operation) => lock.run(target, operation));
    return runLocked(record.target, async () => {
      const prepared = adapter.prepareRevert ? await adapter.prepareRevert({ session, target: record.target, record }) : undefined;
      const expected = prepared ? prepared.expected : record.after;
      const target = prepared ? prepared.target : record.before;
      const current = await adapter.read({ session, target: record.target, record });
      if (!isDeepStrictEqual(current, expected)) throw changed();
      return audit.run({ actor, ip, action: record.action, target: record.target, kind: 'config', revertible: true,
        before: expected, after: target, revertOf: record.id,
        scriptSha256Before: record.scriptSha256After, scriptSha256After: record.scriptSha256Before,
        bytesBefore: record.bytesAfter, bytesAfter: record.bytesBefore }, async intent => {
        const written = await adapter.write({ session, target: record.target, value: target, expected, record, ...(prepared ? { skipped: prepared.skipped } : {}) });
        const applied = await adapter.read({ session, target: record.target, record });
        if (!isDeepStrictEqual(applied, prepared ? written.target : record.before)) throw new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 값이 예상과 달라요. 현재 값을 다시 확인해 주세요.');
        return { id: intent.id, result: 'ok', detail: prepared ? { skipped: written.skipped } : {}, ...(prepared ? { skipped: written.skipped } : {}) };
      }, { prepare: adapter.prepare ? intent => adapter.prepare({ record, intent }) : undefined });
    });
  }
  return { register, list, detail, revert };
}
