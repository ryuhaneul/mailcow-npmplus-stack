import { signal } from '@preact/signals';
import { adminNav } from './state/nav.js';
const names = new Set(['home', 'login', 'flow', ...adminNav.map(item => item[0])]);
export function parseAdminRoute(hash = '') {
  try { const [name = 'home', ...parts] = (hash.replace(/^#/, '') || 'home').split('/'); return { name: names.has(name) ? name : 'home', parts: parts.map(decodeURIComponent) }; }
  catch { return { name: 'home', parts: [] }; }
}
export const adminRoute = signal(parseAdminRoute());
export function initAdminRouter() { const update = () => { adminRoute.value = parseAdminRoute(location.hash); }; addEventListener('hashchange', update); update(); return () => removeEventListener('hashchange', update); }
export function navigateAdmin(hash) { location.hash = hash; }
