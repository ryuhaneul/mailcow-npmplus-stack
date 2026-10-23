import { session, sessionReady } from './state/session.js';
import { toast } from './state/toast.js';

export async function api(path, { method = 'GET', body, silentSessionErrors = false, ...options } = {}) {
  const headers = new Headers(options.headers);
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart) headers.set('Content-Type', 'application/json');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()) && session.value?.csrf) {
    headers.set('X-Webmail-CSRF', session.value.csrf);
  }
  const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin', ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = payload.error;
    if (['NO_SESSION', 'SESSION_EXPIRED'].includes(error.code)) {
      endSession(error.code, { notify: !silentSessionErrors });
    }
    throw error;
  }
  if (path === '/api/auth/login' || path === '/api/auth/session') session.value = payload;
  if (path === '/api/auth/logout') { session.value = null; sessionReady.value = false; }
  return payload;
}

export async function logout() {
  toast.value = null;
  try { await api('/api/auth/logout', { method: 'POST' }); }
  catch (error) { toast.value = { kind: 'error', message: error.message }; }
  finally { session.value = null; sessionReady.value = false; }
}

export function endSession(code, { notify = true } = {}) {
  session.value = null; sessionReady.value = false;
  if (!['password-changed', 'send-unknown'].includes(toast.value?.kind)) {
    toast.value = notify && code === 'SESSION_EXPIRED' ? { kind: 'session-expired', message: '로그인이 만료됐어요. 다시 로그인해 주세요.' } : null;
  }
}
