import { useEffect, useRef } from 'preact/hooks';
import { AuthFrame, AuthNotice } from './Login.jsx';
export default function Totp({ session, busy, error, submit, cancel }) {
  const code = useRef(null);
  useEffect(() => { if (!busy) code.current?.focus(); }, [busy]);
  return <AuthFrame><h1>2단계 인증</h1><p class="hint">{session.username} 계정의 인증 앱에 표시된<br/>6자리 코드를 입력하세요.</p><AuthNotice error={error}/>
    <form aria-busy={busy} onSubmit={event => { event.preventDefault(); const value = code.current.value; code.current.value = ''; submit({ code: value }); }}>
      <div class="field"><label for="totp">인증 코드</label><input ref={code} class="otp" id="totp" name="code" placeholder="000000" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength="6" required disabled={busy}/><small>여러 번 틀리면 인증이 잠시 제한됩니다.</small></div>
      <button class="btn pri" type="submit" disabled={busy}>인증하고 로그인</button>
    </form><button class="btn ghost auth-cancel" type="button" disabled={busy} onClick={cancel}>다른 계정으로 로그인</button>
  </AuthFrame>;
}
