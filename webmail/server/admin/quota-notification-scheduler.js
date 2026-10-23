export function createQuotaNotificationScheduler({ service, logger, setInterval: schedule = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval }) {
  let timer = null, running = false, stopped = false, active = null;
  function tick() {
    if (running || stopped) return;
    running = true;
    active = (async () => {
      try { await service.runOnce({ stopped: () => stopped }); }
      catch { logger?.warn({ code: 'QUOTA_NOTIFICATION_FAILED' }, '쿼터 알림 실행 기록을 확인해 주세요.'); }
      finally { running = false; }
    })();
    return active;
  }
  function start() {
    if (timer !== null || stopped) return;
    // Delay the first check; never replay missed ticks after a restart.
    timer = schedule(() => { void tick(); }, 5 * 60_000); timer.unref?.();
  }
  async function stop() { stopped = true; if (timer !== null) cancel(timer); timer = null; await active; }
  return { start, stop, tick };
}
