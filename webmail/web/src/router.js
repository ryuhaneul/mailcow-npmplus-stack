import { signal } from '@preact/signals';

export function parseRoute(hash = '') {
  const raw = hash.replace(/^#/, '') || 'inbox';
  const question = raw.indexOf('?');
  const path = question < 0 ? raw : raw.slice(0, question);
  const query = question < 0 ? undefined : raw.slice(question + 1);
  const [name, ...parts] = path.split('/');
  let value;
  try { value = decodeURIComponent(parts.join('/')); } catch { value = parts.join('/'); }
  const titles = { inbox: '받은편지함', allmail: '전체편지함', f: value, spam: '스팸', search: '검색 결과', read: '메일 읽기', compose: '메일 쓰기', filters: '필터·규칙', rule: '규칙 만들기', storage: '저장 공간', password: '암호 변경', settings: '보기 설정', keys: '단축키' };
  return Object.hasOwn(titles, name) ? { name, value, title: titles[name], ...(query === undefined ? {} : { query }) } : { name: 'inbox', value: '', title: titles.inbox };
}
export const route = signal(parseRoute());
export function navigate(path) { location.hash = path; route.value = parseRoute(location.hash); }
export function initRouter() {
  const update = () => { route.value = parseRoute(location.hash); };
  update(); window.addEventListener('hashchange', update);
  return () => window.removeEventListener('hashchange', update);
}
