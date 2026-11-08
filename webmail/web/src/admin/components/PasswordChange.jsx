import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { adminSession } from '../state/session.js';
import ManagementDialog from './ManagementDialog.jsx';
export default function PasswordChange({ close }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [saved, setSaved] = useState(false);
  const current = useRef(null), next = useRef(null), confirm = useRef(null), form = useRef(null), done = useRef(null), pending = useRef(false);
  useEffect(() => {
    const node = form.current, dialog = node.closest('dialog');
    current.current?.focus();
    const trap = event => {
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('input,button')].filter(control => !control.disabled && control.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.addEventListener('keydown', trap);
    return () => { dialog.removeEventListener('keydown', trap); node.reset(); };
  }, []);
  useEffect(() => { if (saved) done.current?.focus(); }, [saved]);
  async function submit(event) {
    event.preventDefault();
    if (pending.current) return;
    setError(null);
    if (next.current.value !== confirm.current.value) {
      setError({ message: '새 암호와 확인이 일치하지 않습니다.', field: 'confirm' });
      confirm.current.focus();
      return;
    }
    pending.current = true; setBusy(true);
    const body = { currentPassword: current.current.value, password: next.current.value, password2: confirm.current.value };
    form.current.reset();
    try { await adminApi('/api/admin/auth/password', { method: 'POST', body }); setSaved(true); }
    catch (failure) {
      const field = failure.code === 'AUTH_FAILED' ? 'current' : failure.status === 422 ? 'new' : null;
      setError({ ...failure, message: failure.message, field });
      (field === 'current' ? current : field === 'new' ? next : current).current?.focus();
    } finally {
      body.currentPassword = undefined; body.password = undefined; body.password2 = undefined;
      pending.current = false; setBusy(false);
    }
  }
  return <ManagementDialog title="내 암호 변경" close={close} busy={busy}>
    <p class="hint">로그인한 관리자 <b>{adminSession.value?.username}</b>의 암호를 변경합니다.</p>
    {saved ? <><div class="alert" role="status"><strong>암호를 변경했습니다.</strong><p>이 관리자의 다른 메일 관리 세션을 종료했습니다.<br/>지금 사용 중인 세션은 계속 사용할 수 있습니다.</p></div><div class="footer-actions"><button class="btn pri" type="button" onClick={close} ref={done}>확인</button></div></> : <form ref={form} onSubmit={submit}>
      {error && <div class="alert danger" role="alert" id="password-change-error"><strong>{error.message}</strong>{Number.isInteger(error.remainingAttempts) && <p>남은 시도 {error.remainingAttempts}회</p>}{error.retryAfter > 0 && <p>{error.retryAfter}초 뒤 다시 시도해 주세요.</p>}</div>}
      <div class="field"><label for="admin-current-password">현재 암호</label><input id="admin-current-password" ref={current} type="password" autoComplete="current-password" required aria-invalid={error?.field === 'current' || undefined} aria-describedby={error?.field === 'current' ? 'password-change-error' : undefined}/></div>
      <div class="field"><label for="admin-new-password">새 암호</label><input id="admin-new-password" ref={next} type="password" autoComplete="new-password" required aria-invalid={error?.field === 'new' || undefined} aria-describedby={`admin-password-policy${error?.field === 'new' ? ' password-change-error' : ''}`}/><small id="admin-password-policy">mailcow에 설정된 암호 정책을 충족해야 합니다.</small></div>
      <div class="field"><label for="admin-confirm-password">새 암호 확인</label><input id="admin-confirm-password" ref={confirm} type="password" autoComplete="new-password" required aria-invalid={error?.field === 'confirm' || undefined} aria-describedby={error?.field === 'confirm' ? 'password-change-error' : undefined}/></div>
      <p class="hint">변경하면 이 관리자의 다른 메일 관리 세션이 종료됩니다.<br/>지금 사용 중인 세션은 유지됩니다.</p>
      <div class="footer-actions"><button class="btn" type="button" disabled={busy} onClick={close}>취소</button><button class="btn pri" type="submit" disabled={busy}>{busy ? '변경 중…' : '암호 변경'}</button></div>
    </form>}
  </ManagementDialog>;
}
