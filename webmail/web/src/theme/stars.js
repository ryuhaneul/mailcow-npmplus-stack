export function initStars(frame) {
  if (!/^https?:$/.test(location.protocol)) return;
  const controller = new AbortController();
  const signal = controller.signal;
  let latest = null, scheduled = 0, hovering = false;
  const send = m => frame.contentWindow && frame.contentWindow.postMessage(Object.assign({ namespace: 'starflow-base-stars-v1' }, m), location.origin);
  function leave() { cancelAnimationFrame(scheduled); scheduled = 0; latest = null; if (hovering) send({ type: 'leave' }); hovering = false; }
  document.addEventListener('pointermove', ev => {
    if (document.documentElement.dataset.stars !== 'on' || ev.defaultPrevented || !['mouse', 'pen'].includes(ev.pointerType) || ev.buttons || !(getSelection() || {}).isCollapsed) { leave(); return; }
    hovering = true; latest = { type: 'move', x: ev.clientX / innerWidth, y: ev.clientY / innerHeight };
    if (!scheduled) scheduled = requestAnimationFrame(() => { scheduled = 0; const m = latest; latest = null; if (m) send(m); });
  }, { passive: true, signal });
  ['pointerdown', 'pointercancel'].forEach(t => document.addEventListener(t, leave, { passive: true, signal }));
  document.addEventListener('pointerleave', leave, { signal });
  ['blur', 'resize', 'pagehide'].forEach(t => window.addEventListener(t, leave, { signal }));
  document.addEventListener('visibilitychange', leave, { signal });
  frame.addEventListener('load', leave, { signal });
  return () => { leave(); controller.abort(); };
}
