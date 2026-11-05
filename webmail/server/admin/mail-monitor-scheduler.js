export function createMonitorScheduler({ service, logger, setInterval: schedule = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval, setTimeout: deadline = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout }) {
  let timer = null, active = null, controller = null, stopped = false;
  function tick() {
    if (active || stopped) return;
    controller = new AbortController();
    const timeout = deadline(() => controller?.abort(), 240000); timeout.unref?.();
    active = (async()=>{try { return await service.runOnce({ signal: controller.signal }); }
      catch { logger?.warn({ code:'MAIL_MONITOR_FAILED' },'감시 실행 상태를 확인해 주세요.'); }
      finally { clear(timeout); active=null; controller=null; }})();
    return active;
  }
  function start() { if (timer !== null || stopped) return; timer=schedule(()=>{void tick();},300000); timer.unref?.(); }
  async function stop() { stopped=true; if(timer!==null)cancel(timer);timer=null;controller?.abort();await active; }
  return {start,stop,tick};
}
