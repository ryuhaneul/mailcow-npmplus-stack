import { latestFtsMeasurement, summarizeFtsFolders } from './fts-measure.js';
import { AppError } from '../../errors.js';

const key = row => JSON.stringify([row.user, row.mailbox, row.guid]);
const codeOf = error => error instanceof AppError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
const eligible = row => row?.status === 'ok' && Number.isSafeInteger(row.unindexed) && row.unindexed > 0;
const unfinished = row => ['pending', 'running', 'failed', 'unknown', 'unmeasured'].includes(row.result) || eligible(row.after);

// The scheduler owns timing/lifecycle. This service owns one acquired run and
// never cancels an in-flight remote index when the start deadline passes.
export function createFtsNightly({ state: store, measure, doveadm, audit, history, logger, now = Date.now }) {
  history?.register('fts.nightly', { label: '검색 색인을 정리했어요' });
  async function runOnce({ day, deadline, signal } = {}) {
    const cutoff = () => now() >= deadline || signal?.aborted === true;
    if (!Number.isFinite(deadline)) throw new AppError(422, 'FTS_DEADLINE_INVALID', '색인 종료 시각을 확인해 주세요.');
    let state = null, keepLock = false, sentIndex = false;
    const warnings = [];
    const timestamp = () => new Date(now()).toISOString();
    function warn(code, stage) {
      warnings.push({ code, stage });
      logger?.warn({ code, stage }, '검색 색인 실행 기록을 확인해 주세요.');
    }
    try {
      if ((await store.read()).damaged) throw new AppError(409, 'FTS_STATE_CORRUPT', '색인 상태를 확인해 주세요.');
    } catch (error) {
      warn(codeOf(error), 'run');
      return { status: 'failed', state: null, warnings };
    }
    const token = await store.acquire();
    if (!token) return { status: 'busy', state: null, warnings: [] };
    async function save() {
      if (state.snapshot) {
        const folders = state.folders.map(latestFtsMeasurement);
        const times = folders.map(row => row.measuredAt).filter(value => Number.isFinite(Date.parse(value))).sort();
        state.snapshot = { ...state.snapshot, measuredAt: times.at(-1) ?? state.snapshot.measuredAt,
          folders, ...summarizeFtsFolders(folders) };
      }
      try { state = await store.save(state, token); }
      catch (error) {
        keepLock = sentIndex || error.code === 'FTS_REMOTE_UNKNOWN';
        warn(codeOf(error), 'state');
        throw new AppError(500, 'FTS_STATE_SAVE_FAILED', '색인 진행 상태를 저장하지 못했어요.');
      }
    }
    async function assertUnblocked() {
      const result = await store.read();
      if (result.damaged || !result.state) throw new AppError(409, 'FTS_STATE_CORRUPT', '색인 상태를 확인해 주세요.');
      if (result.state.indexBlocked) {
        keepLock = true;
        state = result.state;
        throw new AppError(409, 'FTS_REMOTE_UNKNOWN', '원격 색인 종료 확인이 필요해요.');
      }
    }
    async function execute(previous) {
      const priority = new Set(), remeasured = new Set();
      for (const row of previous?.folders ?? []) {
        if (!row.mailbox || !unfinished(row) || remeasured.has(key(row))) continue;
        remeasured.add(key(row));
        if (cutoff()) break;
        // Revalidate yesterday's identity before using it as a priority hint.
        try {
          const fresh = await measure.measureFolder(row.user, row.mailbox);
          if (row.guid === null || fresh.guid === row.guid) priority.add(key(fresh));
        } catch (error) { warn(codeOf(error), 'priorityMeasure'); }
      }
      const snapshot = await measure.measureAll({ shouldStop: cutoff });
      const seen = new Set();
      const rows = snapshot.folders.filter(row => {
        const id = key(row);
        if (seen.has(id)) return false;
        seen.add(id); return true;
      });
      state.snapshot = snapshot;
      state.deadline = new Date(deadline).toISOString();
      state.warnings = warnings;
      state.folders = rows.map(row => ({ user: row.user, mailbox: row.mailbox, guid: row.guid,
        before: row, after: null, result: eligible(row) ? 'pending' : row.status === 'ok' ? 'done' : row.status,
        error: null, startedAt: null, finishedAt: null }));
      await save();
      const queue = rows.filter(eligible).sort((a, b) => Number(priority.has(key(b))) - Number(priority.has(key(a))) ||
        b.unindexed - a.unindexed || key(a).localeCompare(key(b)));
      for (const row of snapshot.incomplete ? [] : queue) {
        if (cutoff()) break;
        const record = state.folders.find(item => key(item) === key(row));
        try {
          const before = await measure.measureFolder(row.user, row.mailbox);
          record.before = before;
          if (before.status === 'excluded' && before.reason === 'nonexistent') {
            record.result = 'excluded'; record.error = null;
          } else if (before.guid !== row.guid) {
            record.result = 'failed'; record.error = 'FTS_FOLDER_CHANGED';
          } else if (!eligible(before)) {
            record.result = before.status === 'ok' ? 'done' : before.status;
          } else {
            if (cutoff()) break;
            record.startedAt = timestamp(); record.result = 'running';
            state.current = { user: row.user, mailbox: row.mailbox, guid: row.guid };
            await save();
            // Save/read may themselves consume the remaining start window.
            await assertUnblocked();
            if (cutoff()) {
              state.current = null; record.result = 'pending'; record.startedAt = null;
              break;
            }
            const previouslySent = sentIndex;
            sentIndex = true;
            try { await doveadm.indexMailbox(row.user, row.mailbox); }
            catch (error) {
              if (error.code === 'DOVEADM_UNAVAILABLE') sentIndex = previouslySent;
              if (error.code === 'DOVEADM_INDEX_UNKNOWN') {
                keepLock = true;
                state.indexBlocked = true;
                state.remoteUnknown = { user: row.user, mailbox: row.mailbox, at: timestamp() };
                record.result = 'unknown'; record.error = 'DOVEADM_INDEX_UNKNOWN';
                record.finishedAt = timestamp();
                // Keep the durable current marker/lock even if this write fails.
                try {
                  const blocked = await store.markRemoteUnknown(row);
                  state.indexBlocked = blocked.indexBlocked;
                  state.remoteUnknown = blocked.remoteUnknown;
                } catch (markError) { warn(codeOf(markError), 'remoteUnknown'); }
                state.status = 'unknown';
                await save();
                return;
              }
              throw error;
            }
            record.after = await measure.measureFolder(row.user, row.mailbox);
            record.result = record.after.status === 'excluded' && record.after.reason === 'nonexistent' ? 'excluded' :
              record.after.status === 'ok' && record.after.guid === row.guid ? 'done' : 'failed';
            if (record.result === 'failed') record.error = record.after.guid !== row.guid ? 'FTS_FOLDER_CHANGED' : 'FTS_MEASURE_FAILED';
          }
        } catch (error) {
          if (keepLock || ['FTS_REMOTE_UNKNOWN', 'FTS_STATE_SAVE_FAILED'].includes(error.code)) throw error;
          record.result = 'failed'; record.error = codeOf(error);
        }
        record.finishedAt = timestamp();
        state.current = null;
        await save();
      }
      state.current = null;
      const failed = state.folders.some(row => ['failed', 'unmeasured'].includes(row.result));
      state.status = snapshot.incomplete || cutoff() ? 'cutoff' : failed || warnings.length ? 'failed' : 'done';
      state.finishedAt = timestamp();
      await save();
    }
    try {
      const previous = await store.read();
      if (previous.damaged) throw new AppError(409, 'FTS_STATE_CORRUPT', '색인 상태를 확인해 주세요.');
      state = await store.startRun(day ?? new Date(now() + 9 * 3_600_000).toISOString().slice(0, 10));
      await audit.run({ actor: 'scheduler', ip: '', action: 'fts.nightly', target: state.day,
        kind: 'irreversible', revertible: false, before: { runId: state.runId }, after: {} }, async () => {
        await execute(previous.state);
        return { result: state.status === 'done' ? 'ok' : 'partial', detail: {
          runId: state.runId, status: state.status,
          processed: state.folders.filter(row => row.result === 'done' && row.startedAt).length,
          skipped: state.folders.filter(row => !row.startedAt && row.result !== 'pending').length,
          failed: state.folders.filter(row => ['failed', 'unmeasured'].includes(row.result)).length,
          pending: state.folders.filter(row => row.result === 'pending').length,
        } };
      });
    } catch (error) {
      if (error.code === 'FTS_REMOTE_UNKNOWN') keepLock = true;
      warn(codeOf(error), error.code?.startsWith('AUDIT_') ? 'audit' : 'run');
      if (state) {
        if (keepLock && !state.indexBlocked) {
          try {
            const persisted = (await store.read()).state;
            if (persisted?.indexBlocked) {
              state.indexBlocked = true; state.remoteUnknown = persisted.remoteUnknown;
            }
          } catch (readError) { warn(codeOf(readError), 'stateRead'); }
        }
        state.status = keepLock && (state.indexBlocked || state.remoteUnknown) ? 'unknown' : 'failed';
        state.finishedAt = timestamp();
        if (!sentIndex && !keepLock) state.current = null;
        state.warnings = warnings;
        try { await save(); } catch { /* save already records a safe warning */ }
      }
    } finally {
      if (!keepLock) {
        try { await store.release(token); }
        catch (error) { warn(codeOf(error), 'release'); if (state) state.status = 'failed'; }
      }
    }
    return { status: state?.status ?? 'failed', state, warnings };
  }
  async function recoverAfterRestart() {
    await store.markRemoteUnknown({ reason: 'restart' });
  }
  return { runOnce, recoverAfterRestart };
}
