import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { toast } from '../state/toast.js';
import Brand from './Brand.jsx';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api('/api/auth/login', { method: 'POST', body: { email, password } });
      setPassword(''); toast.value = null; navigate('inbox');
    } catch (failure) { setError(failure.message); setPassword(''); }
    finally { setBusy(false); }
  }
  return <main class="login-screen"><section class="login-card" aria-labelledby="login-title">
    <Brand/>
    <h1 id="login-title">로그인</h1>
    {toast.value && <p class={`alert ${toast.value.kind === 'error' ? 'crit' : 'warn'}`} role={toast.value.kind === 'error' ? 'alert' : 'status'}>{toast.value.message}</p>}
    <form onSubmit={submit} aria-busy={busy}>
      <div class="field"><label for="login-email">메일 주소</label><input id="login-email" class="inp" type="email" name="email" autoComplete="username" required value={email} onInput={event => setEmail(event.currentTarget.value)} /></div>
      <div class="field"><label for="login-password">암호</label><input id="login-password" class="inp" type="password" name="password" autoComplete="current-password" required value={password} onInput={event => setPassword(event.currentTarget.value)} /></div>
      <p class="login-error" role="alert" aria-live="polite">{error}</p>
      <button class="btn pri login-submit" type="submit" disabled={busy}>{busy ? '로그인 중…' : '로그인'}</button>
    </form>
  </section></main>;
}
