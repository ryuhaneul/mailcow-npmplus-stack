import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';
import { loadSessionPrefs } from '../state/prefs.js';
import SettingsTabs from '../components/SettingsTabs.jsx';
import OtpEnrollment, { OtpCodeForm } from '../components/OtpEnrollment.jsx';
import '../components/otp.css';
import './account.css';

export default function OtpPage() {
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [enrolling, setEnrolling] = useState(false), [busy, setBusy] = useState(false);
  async function load() { setError(''); try { setStatus(await api('/api/otp')); } catch (failure) { setError(failure.message); } }
  useEffect(() => { void load(); }, []);
  async function cancel() {
    if (busy) return;
    setBusy(true); setError('');
    try { await api('/api/otp/enrollment', { method: 'DELETE' }); setEnrolling(false); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const finish = async () => { await loadSessionPrefs(); setEnrolling(false); await load(); };
  return <section class="view account-view otp-view" data-page="otp" aria-labelledby="page-title">
    <div class="set-head"><div class="crumb"><a href="#settings">설정</a><span>›</span>계정</div><h1 id="page-title">2단계 인증</h1><SettingsTabs/></div>
    <div class="scroll"><div class="set-body"><div class="otp-wrap">
      {error && <div class="alert crit" role="alert">{error}<button class="btn" onClick={load}>다시 시도</button></div>}
      {!status ? !error && <p role="status">인증 상태를 확인하고 있어요…</p> : enrolling ? <><h2 class="otp-heading">인증 앱 등록</h2><p class="otp-copy">두 단계를 마치면 다음 로그인부터 인증 코드를 확인해요.</p><ol class="otp-steps" aria-label="등록 순서"><li><span>1</span>인증 앱에 추가</li><li><span>2</span>코드로 확인</li></ol><OtpEnrollment onBusy={setBusy} onCancel={cancel} onComplete={finish}/></> : <>
        <div class="otp-state"><h3>{status.enabled ? '2단계 인증을 사용하고 있어요' : '로그인을 한 번 더 안전하게'} <span class={`otp-badge ${status.enabled ? 'on' : ''}`}>{status.enabled ? '켜짐' : '꺼짐'}</span></h3>
          <p>{status.enabled ? '다음 웹메일 로그인부터 인증 앱의 코드를 확인합니다.' : '암호를 입력한 뒤 인증 앱의 코드로 한 번 더 확인합니다.'}</p>{status.enabled && <p>등록한 날짜 <b>{new Date(status.registeredAt).toLocaleString('ko-KR')}</b></p>}
          {!status.enabled && <div class="actions"><button class="btn pri" onClick={() => setEnrolling(true)}>2단계 인증 켜기</button></div>}
        </div>
        {status.enabled && (status.forced ? <><div class="required-note">관리자가 2단계 인증을 필수로 설정했어요. 필수 적용 중에는 끌 수 없습니다.</div><button class="btn" disabled>2단계 인증 끄기</button></> : <div class="otp-disable"><h3>2단계 인증 끄기</h3><p class="otp-copy">현재 인증 앱의 코드를 입력해 주세요.</p><OtpCodeForm label="인증하고 끄기" codeLabel="현재 인증 코드" busyLabel="끄는 중…" submit={async code => { await api('/api/otp/disable', { method: 'POST', body: { code } }); await finish(); }}/></div>)}
        {!status.enabled && <><div class="otp-info"><h3>인증 앱을 준비해 주세요</h3><p>Google Authenticator, Microsoft Authenticator 등<br/>시간 기반 코드를 지원하는 인증 앱을 사용할 수 있어요.</p></div><div class="otp-info"><h3>이 웹메일에 적용됩니다</h3><p>메일 프로그램에서 쓰는 암호와 로그인 방법은 그대로예요.</p></div></>}
        <p class="otp-note">인증 앱을 사용할 수 없으면 관리자에게 초기화를 요청해 주세요.</p>
      </>}
    </div></div></div>
  </section>;
}
