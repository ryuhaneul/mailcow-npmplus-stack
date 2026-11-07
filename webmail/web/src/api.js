import { session, sessionReady, verifiedSession, invalidateSessionResources, authGeneration, advanceAuthGeneration, authUnavailable } from './state/session.js';
import { toast } from './state/toast.js';

export async function api(path, { method = 'GET', body, silentSessionErrors = false, acceptSession = true, ...options } = {}) {
  const generation = authGeneration, headers = new Headers(options.headers);
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart) headers.set('Content-Type', 'application/json');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()) && session.value?.csrf) {
    headers.set('X-Webmail-CSRF', session.value.csrf);
  }
  const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin', ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = payload.error;
    if (acceptSession) handleAuthFailure(error, { generation, notify: !silentSessionErrors });
    throw error;
  }
  const authResponse = ['/api/auth/login', '/api/auth/session', '/api/auth/otp', '/api/otp/enrollment/confirm', '/api/otp/disable'].includes(path);
  if (acceptSession && authResponse && generation === authGeneration) {
    acceptAuthSession(payload, { rotate: path !== '/api/auth/session' });
    if (path !== '/api/auth/session') broadcastAuthChange();
  }
  if (path === '/api/auth/logout' && generation === authGeneration) { endSession('LOGOUT', { notify: false }); broadcastAuthChange(); }
  return payload;
}

export async function logout() {
  toast.value = null;
  const owner = session.value;
  try { await api('/api/auth/logout', { method: 'POST' }); }
  catch (error) { toast.value = { kind: 'error', message: error.message }; }
  finally {
    if (session.value === owner || authUnavailable.value && session.value?.csrf === owner?.csrf) {
      const notice = toast.value; endSession('LOGOUT', { notify: false }); toast.value = notice; broadcastAuthChange();
    }
  }
}

export function endSession(code, { notify = true } = {}) {
  advanceAuthGeneration(); authUnavailable.value = false;
  session.value = null; sessionReady.value = false; invalidateSessionResources();
  showSessionNotice(code, { notify });
}

export function showSessionNotice(code, { notify = true } = {}) {
  if (!['password-changed', 'send-unknown'].includes(toast.value?.kind)) {
    toast.value = notify && ['OTP_PENDING_EXPIRED', 'OTP_STATE_CHANGED'].includes(code) ? { kind: 'session-expired', message: code === 'OTP_PENDING_EXPIRED' ? '등록 시간이 지나 다시 로그인해야 해요.' : '인증 설정이 바뀌었어요. 다시 로그인해 주세요.' } : notify && code === 'SESSION_EXPIRED' ? { kind: 'session-expired', message: '로그인이 만료됐어요. 다시 로그인해 주세요.' } : null;
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
  const owner = session.value, generation = authGeneration, version = checkVersion;
  const pending = (async () => {
    let value;
    try { value = await api('/api/auth/session', { silentSessionErrors: true, acceptSession: false }); }
    catch (error) {
      if (version !== checkVersion || session.value !== owner || generation !== authGeneration) return;
      verifiedSession.value = null;
      handleAuthFailure(error, { generation, notify: false });
      if (['NO_SESSION', 'SESSION_EXPIRED', 'OTP_PENDING_EXPIRED', 'OTP_STATE_CHANGED'].includes(error.code)) {
        if (globalThis.document?.querySelector('.composer')) closedComposerOwner = owner?.user.email;
        // The common handler already invalidated this credential generation.
      }
      throw error;
    }
    if (version !== checkVersion || session.value !== owner || generation !== authGeneration) return;
    const sameAccount = owner?.user.email === value.user.email;
    const sameReady = sameAccount && owner.step === 'done' && value.step === 'done' && owner.otp?.version === value.otp?.version;
    if (sameReady && !authUnavailable.value) {
      if (owner.csrf !== value.csrf) advanceAuthGeneration();
      owner.csrf = value.csrf; owner.otp = value.otp;
      owner.expiresAt = value.expiresAt; verifiedSession.value = owner; return owner;
    }
    if (globalThis.document?.querySelector('.composer')) closedComposerOwner = owner?.user.email;
    acceptAuthSession(value);
    if (value.step !== 'done') return value;
    const { loadSessionPrefs } = await import('./state/prefs.js');
    await loadSessionPrefs();
    if (session.value !== value || value.step !== 'done') return;
    if (!sameAccount) {
      const { navigate } = await import('./router.js');
      if (session.value !== value) return;
      navigate('inbox');
    }
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
    advanceAuthGeneration();
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

export function acceptAuthSession(value, { rotate = false } = {}) {
  if (!['done', 'otp', 'enroll'].includes(value?.step)) {
    handleAuthFailure({ code: 'OTP_UNAVAILABLE' });
    throw { code: 'OTP_UNAVAILABLE', message: '지금은 인증 상태를 확인할 수 없어요.' };
  }
  const owner = session.value;
  if (rotate || owner !== value && (owner?.csrf !== value.csrf || owner?.step !== value.step || owner?.otp?.version !== value.otp?.version || owner?.user.email !== value.user.email)) {
    advanceAuthGeneration(); invalidateSessionResources(); sessionReady.value = false;
  }
  authUnavailable.value = false;
  session.value = value; verifiedSession.value = value.step === 'done' ? value : null;
  if (value.step !== 'done') sessionReady.value = false;
}
export function handleAuthFailure(error, { generation = authGeneration, notify = true } = {}) {
  if (generation !== authGeneration) return;
  if (['NO_SESSION', 'SESSION_EXPIRED', 'OTP_PENDING_EXPIRED', 'OTP_STATE_CHANGED'].includes(error?.code)) {
    const changed = error.code === 'SESSION_EXPIRED' && error.message === '인증 설정이 바뀌었어요. 다시 로그인해 주세요.';
    endSession(changed ? 'OTP_STATE_CHANGED' : error.code, { notify: notify || changed || error.code === 'OTP_PENDING_EXPIRED' }); return;
  }
  if (error?.code === 'OTP_REQUIRED') {
    advanceAuthGeneration(); invalidateSessionResources(); sessionReady.value = false;
    authUnavailable.value = false;
    if (session.value) session.value = { ...session.value, step: ['otp', 'enroll'].includes(error.step) ? error.step : 'enroll', expiresAt: error.expiresAt ?? session.value.expiresAt };
    void checkServerSession().catch(() => {});
  } else if (error?.code === 'OTP_UNAVAILABLE') {
    advanceAuthGeneration(); invalidateSessionResources(); sessionReady.value = false;
    if (session.value) session.value = { ...session.value };
    authUnavailable.value = true;
  }
}
