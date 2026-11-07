import { useState } from 'preact/hooks';
import { api, logout, checkServerSession } from '../api.js';
import { session, authUnavailable } from '../state/session.js';
import { loadSessionPrefs } from '../state/prefs.js';
import { restoreSendAttempt } from '../state/compose.js';
import { navigate } from '../router.js';
import Brand from './Brand.jsx';
import OtpEnrollment, { OtpCodeForm } from './OtpEnrollment.jsx';
import './otp.css';

export default function OtpGate() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const unavailable = authUnavailable.value, enrolling = session.value?.step === 'enroll';
  async function complete() {
    if (session.value?.step !== 'done') return;
    const owner = session.value;
    await restoreSendAttempt(owner.user.email);
    if (session.value !== owner) return;
    await loadSessionPrefs();
    if (session.value === owner && owner.step === 'done') navigate('inbox');
  }
  async function retry() {
    if (busy) return;
    setBusy(true); setError('');
    try { await checkServerSession(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <main class={`login-screen otp-login ${enrolling && !unavailable ? 'wide' : ''}`}><section class="login-card" aria-labelledby="otp-title">
    <Brand/><h1 id="otp-title">{unavailable ? '인증 상태 확인' : enrolling ? '2단계 인증을 등록해 주세요' : '2단계 인증'}</h1>
    <span class="account-email">{session.value?.user.email}</span>
    {unavailable ? <div aria-busy={busy}><p class="otp-copy">지금은 인증 상태를 확인할 수 없어요.</p><p class="otp-error" role="alert">{error}</p><button class="btn pri" onClick={retry} disabled={busy}>{busy ? '확인 중…' : '다시 시도'}</button></div> : enrolling ? <>
      <div class="required-note">관리자가 2단계 인증을 필수로 설정했어요.<br/>등록을 마치면 웹메일을 이용할 수 있습니다.</div>
      <OtpEnrollment onLogout={logout} onComplete={complete} onBusy={setBusy}/>
    </> : <><p class="otp-copy">인증 앱을 열고 이 계정의<br/>6자리 코드를 입력해 주세요.</p>
      <OtpCodeForm onBusy={setBusy} submit={async code => { const value = await api('/api/auth/otp', { method: 'POST', body: { code } }); if (session.value === value) await complete(); }}/>
      <p class="otp-note">인증 앱을 사용할 수 없나요?<br/>관리자에게 초기화를 요청해 주세요.</p>
    </>}
    {(!enrolling || unavailable) && <button type="button" class="btn ghost otp-logout" disabled={busy} onClick={logout}>{enrolling || unavailable ? '로그아웃' : '다른 계정으로 로그인'}</button>}
  </section></main>;
}
