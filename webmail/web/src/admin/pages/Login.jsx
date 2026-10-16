import { useEffect, useRef } from 'preact/hooks';
import { authMessages, safeFallbackUrl, remainingTime } from '../auth.js';
export function AuthFrame({ children }) {
  return <main class="login-wrap" data-admin-page="login"><section class="login-card" aria-label="관리자 로그인">
    <div class="brand"><span class="mark">ㅁ</span><div><b>메일 관리<small>관리자 로그인</small></b></div></div>{children}
  </section></main>;
}
export function AuthNotice({ error }) {
  if (!error || error.code === 'NO_SESSION' || error.code === 'RATE_LIMITED') return null;
  const url = error.code === 'ADMIN_PENDING_ACTION' ? safeFallbackUrl(error.fallbackUrl) : null;
  return <div class="alert danger" role="alert" data-error-code={error.code}>
    <p>{authMessages[error.code] ?? error.message}</p>
    {Number.isInteger(error.remainingAttempts) && <p>남은 시도 {error.remainingAttempts}회</p>}
    {url && <p><a href={url}>mailcow 관리 화면</a></p>}
  </div>;
}
export default function Login({ busy, error, seconds, submit }) {
  const username = useRef(null), disabled = busy || seconds > 0;
  useEffect(() => { if (!disabled) username.current?.focus(); }, [disabled]);
  return <AuthFrame><h1>메일 관리에 로그인</h1><p class="hint">mailcow 관리자 계정을 사용합니다.</p>
    {seconds > 0 && <div class="alert danger" role="alert"><strong>로그인이 잠시 잠겼습니다.</strong><p>반복된 실패로 5분 뒤 다시 시도할 수 있습니다.<br/>남은 시간 <span class="num">{remainingTime(seconds)}</span></p></div>}
    <AuthNotice error={error}/>
    <form aria-busy={busy} onSubmit={event => { event.preventDefault(); const form = event.currentTarget, data = new FormData(form); form.elements.password.value = ''; submit({ username: data.get('username'), password: data.get('password') }); }}>
      <div class="field"><label for="admin-id">관리자 아이디</label><input ref={username} id="admin-id" name="username" autoComplete="username" required disabled={disabled}/></div>
      <div class="field"><label for="admin-password">암호</label><input id="admin-password" name="password" type="password" autoComplete="current-password" placeholder="암호를 입력하세요" required disabled={disabled}/></div>
      <button class="btn pri" type="submit" disabled={disabled}>로그인</button>
    </form><p class="hint auth-footer">2단계 인증을 켠 계정은 다음 단계에서 코드를 확인합니다. 도메인 관리자는 접근할 수 없습니다.</p>
  </AuthFrame>;
}
