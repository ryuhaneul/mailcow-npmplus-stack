import { adminSession, authFailure, acceptSession, returnTo } from './state/session.js';
import { navigateAdmin } from './router.js';
export function createAdminApi({ fetchImpl = globalThis.fetch, getCsrf = () => adminSession.value?.csrf, onSession = acceptSession, onForbidden = error => { if (location.hash !== '#login' && (adminSession.value?.step === 'done' || ['NO_SESSION', 'SESSION_EXPIRED', 'MAILCOW_SESSION_LOST'].includes(error.code))) returnTo.value = location.hash.slice(1) || 'home'; adminSession.value = null; authFailure.value = error; navigateAdmin('login'); } } = {}) {
  return async function request(path, { method = 'GET', body, signal } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/api/admin/') || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('관리 API 경로를 확인해 주세요.');
    const changing = method !== 'GET', headers = changing ? { 'Content-Type': 'application/json', 'X-Mailadmin-CSRF': getCsrf() ?? '' } : {};
    const response = await fetchImpl(path, { method, headers, credentials: 'same-origin', signal, ...(changing ? { body: JSON.stringify(body ?? {}) } : {}) });
    let value = null; if (response.status !== 204) { try { value = await response.json(); } catch { if (response.ok) throw Object.assign(new Error('응답을 읽을 수 없어요.'), { code: 'INVALID_RESPONSE', status: response.status }); value = { error: { code: 'INVALID_RESPONSE', message: '응답을 읽을 수 없어요.' } }; } }
    if (!response.ok) { const failure = Object.assign(new Error(value?.error?.message ?? '요청을 처리하지 못했어요.'), value?.error ?? {}, { status: response.status }); if (response.status === 403) onForbidden(failure); throw failure; }
    if (value?.csrf && value?.user) onSession(value);
    return value;
  };
}
export const adminApi = createAdminApi();
