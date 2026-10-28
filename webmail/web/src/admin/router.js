import { signal } from '@preact/signals';
import { adminNav } from './state/nav.js';
const names = new Set(['home', 'login', 'flow', 'logs', 'filters', ...adminNav.map(item => item[0])]);
export function parseAdminRoute(hash = '') {
  try { const [name = 'home', ...parts] = (hash.replace(/^#/, '') || 'home').split('/'); return { name: names.has(name) ? name : 'home', parts: parts.map(decodeURIComponent) }; }
  catch { return { name: 'home', parts: [] }; }
}
export const adminRoute = signal(parseAdminRoute());
let leaveGuard;
export function registerAdminLeaveGuard(guard) {
  leaveGuard = guard;
  return () => { if (leaveGuard === guard) leaveGuard = undefined; };
}
export function initAdminRouter() {
  let accepted = location.hash;
  const update = () => {
    const next = location.hash;
    if (next !== accepted && leaveGuard && leaveGuard(parseAdminRoute(next)) === false) {
      history.replaceState(history.state, '', accepted || '#home');
      return;
    }
    accepted = next;
    adminRoute.value = parseAdminRoute(next);
  };
  addEventListener('hashchange', update); update();
  return () => removeEventListener('hashchange', update);
}
export function navigateAdmin(hash) { location.hash = hash; }
