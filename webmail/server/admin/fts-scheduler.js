const KST_OFFSET = 9 * 3_600_000;
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

// Only process-local tick deduplication lives here. Persistent ownership and
// window-start-day run IDs belong to fts-state, including after an application restart.
export function createFtsScheduler({ config, nightly, logger, now = Date.now,
  setInterval: schedule = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval }) {
  const controller = new AbortController();
  let timer = null, lastDay = null, running = false, started = false;
  async function tick() {
    if (!config.enabled || controller.signal.aborted || running) return;
    const time = now();
    const local = new Date(time + KST_OFFSET);
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    const start = minutes(config.start), end = minutes(config.end);
    const overnight = start > end;
    const inWindow = overnight ? minute >= start || minute < end : minute >= start && minute < end;
    if (!inWindow) return;
    // After midnight, retain the date on which this window opened.
    const dayTime = time + KST_OFFSET - (overnight && minute < end ? 86_400_000 : 0);
    const day = new Date(dayTime).toISOString().slice(0, 10);
    if (lastDay === day) return;
    lastDay = day;
    running = true;
    const deadline = Date.parse(`${day}T${config.end}:00+09:00`) + (overnight ? 86_400_000 : 0);
    try { return await nightly.runOnce({ day, deadline, signal: controller.signal }); }
    catch {
      logger?.warn({ code: 'FTS_SCHEDULER_FAILED' }, '검색 색인 예약 실행을 확인해 주세요.');
    } finally { running = false; }
  }
  async function start() {
    if (started || controller.signal.aborted) return;
    started = true;
    try { if (nightly.recoverAfterRestart) await nightly.recoverAfterRestart(); }
    catch { logger?.warn({ code: 'FTS_RESTART_RECOVERY_FAILED' }, '검색 색인 재시작 복구 기록을 확인해 주세요.'); }
    if (!config.enabled || controller.signal.aborted) return;
    timer = schedule(() => { void tick(); }, 60_000);
    timer.unref?.();
    void tick();
  }
  function stop() {
    controller.abort();
    if (timer !== null) cancel(timer);
    timer = null;
  }
  return { start, stop, tick };
}
