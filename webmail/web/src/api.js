import { session, sessionReady, verifiedSession, invalidateSessionResources } from './state/session.js';
import { toast } from './state/toast.js';

export async function api(path, { method = 'GET', body, silentSessionErrors = false, acceptSession = true, ...options } = {}) {
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
    if (acceptSession && ['NO_SESSION', 'SESSION_EXPIRED'].includes(error.code)) {
      endSession(error.code, { notify: !silentSessionErrors });
    }
    throw error;
  }
  if (acceptSession && (path === '/api/auth/login' || path === '/api/auth/session')) {
    session.value = payload; verifiedSession.value = payload;
    if (path === '/api/auth/login') broadcastAuthChange();
  }
  if (path === '/api/auth/logout') { session.value = null; sessionReady.value = false; invalidateSessionResources(); broadcastAuthChange(); }
  return payload;
}

export async function logout() {
  toast.value = null;
  try { await api('/api/auth/logout', { method: 'POST' }); }
  catch (error) { toast.value = { kind: 'error', message: error.message }; }
  finally { session.value = null; sessionReady.value = false; }
}

export function endSession(code, { notify = true } = {}) {
  session.value = null; sessionReady.value = false; invalidateSessionResources();
  if (!['password-changed', 'send-unknown'].includes(toast.value?.kind)) {
    toast.value = notify && code === 'SESSION_EXPIRED' ? { kind: 'session-expired', message: '로그인이 만료됐어요. 다시 로그인해 주세요.' } : null;
  }
}

const authChannelName = 'webmail-auth-change';
let authChannel, sessionCheck, checkVersion = 0, closedComposerOwner;
function broadcastAuthChange() {
  if (authChannel) authChannel.postMessage('changed');
  else try { localStorage.setItem(authChannelName, crypto.randomUUID()); } catch {}
}
// A focus check preserves the object for the same server session, so open editors survive.
export function checkServerSession() {
  if (sessionCheck) return sessionCheck;
  const owner = session.value, version = checkVersion;
  const pending = (async () => {
    let value;
    try { value = await api('/api/auth/session', { silentSessionErrors: true, acceptSession: false }); }
    catch (error) {
      if (version !== checkVersion || session.value !== owner) return;
      verifiedSession.value = null;
      if (['NO_SESSION', 'SESSION_EXPIRED'].includes(error.code)) {
        if (globalThis.document?.querySelector('.composer')) closedComposerOwner = owner?.user.email;
        endSession(error.code, { notify: false });
      }
      throw error;
    }
    if (version !== checkVersion || session.value !== owner) return;
    const sameAccount = owner?.user.email === value.user.email;
    if (sameAccount) {
      owner.csrf = value.csrf; owner.expiresAt = value.expiresAt;
      verifiedSession.value = owner;
      return owner;
    }
    if (globalThis.document?.querySelector('.composer')) closedComposerOwner = owner?.user.email;
    invalidateSessionResources();
    sessionReady.value = false;
    session.value = value; verifiedSession.value = value;
    const { applyServerPrefs } = await import('./state/prefs.js');
    const preferences = await api('/api/prefs', { acceptSession: false });
    if (session.value !== value) return;
    applyServerPrefs(preferences);
    const { navigate } = await import('./router.js');
    if (session.value !== value) return;
    navigate('inbox');
    sessionReady.value = true;
    if (closedComposerOwner && closedComposerOwner !== value.user.email) toast.value = { kind: 'account-changed', message: '다른 탭에서 계정이 바뀌어 작성 중이던 창을 닫았어요. 마지막 자동 저장본은 이전 계정의 임시보관함에 있어요.' };
    closedComposerOwner = null;
    return value;
  })().finally(() => { if (sessionCheck === pending) sessionCheck = null; });
  sessionCheck = pending;
  return pending;
}
export function watchServerSession(onVerified) {
  const verify = () => { verifiedSession.value = null; void checkServerSession().then(value => { if (value) onVerified(); }).catch(() => {}); };
  const changed = () => {
    checkVersion++; sessionCheck = null;
    invalidateSessionResources(); verify();
  };
  const storage = event => { if (event.key === authChannelName) changed(); };
  const hidden = () => { if (document.visibilityState === 'visible') verify(); else verifiedSession.value = null; };
  const blur = () => { verifiedSession.value = null; };
  if (typeof BroadcastChannel !== 'undefined') {
    authChannel = new BroadcastChannel(authChannelName);
    authChannel.onmessage = changed;
  } else window.addEventListener('storage', storage);
  window.addEventListener('focus', verify);
  window.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    authChannel?.close(); authChannel = null;
    window.removeEventListener('storage', storage);
    window.removeEventListener('focus', verify);
    window.removeEventListener('blur', blur);
    document.removeEventListener('visibilitychange', hidden);
  };
}
