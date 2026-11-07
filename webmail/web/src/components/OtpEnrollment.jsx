import { cloneElement, toChildArray } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import { session } from '../state/session.js';
import './otp.css';

export function OtpCodeForm({ submit, label = '인증하고 로그인', busyLabel = '확인 중…', codeLabel = '6자리 인증 코드', buttonClass = 'btn pri', children, onBusy = () => {}, disabled = false }) {
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [until, setUntil] = useState(0), [clock, setClock] = useState(Date.now());
  const input = useRef(), running = useRef(false);
  useEffect(() => { if (error && !busy) input.current?.focus(); }, [error, busy]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const retry = Math.max(0, Math.ceil((until - clock) / 1000));
  async function confirm(event) {
    event.preventDefault();
    if (running.current || retry || disabled) return;
    running.current = true; setBusy(true); onBusy(true); setError('');
    try { await submit(code); }
    catch (failure) {
      setCode(''); setError(failure.message || '인증을 완료하지 못했어요. 다시 시도해 주세요.');
      if (failure.code === 'OTP_RATE_LIMITED') { setUntil(Date.now() + (failure.retryAfter || 300) * 1000); setClock(Date.now()); }
    } finally { running.current = false; setBusy(false); onBusy(false); }
  }
  return <form class="otp-form" onSubmit={confirm} aria-busy={busy}>
    <label for="otp-code">{codeLabel}</label>
    <input ref={input} id="otp-code" class="inp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" required value={code} onInput={event => setCode(event.currentTarget.value)} disabled={busy || disabled}/>
    <p class="otp-note">인증 앱에 표시된 숫자 6자리를 입력해 주세요.</p>
    <div class="otp-feedback" aria-live="polite">
      {error && <p class="otp-error" role="alert">{error}</p>}
      {retry > 0 && <p role="status">{retry}초 뒤 다시 시도해 주세요.</p>}
      {busy && <p role="status">{busyLabel}</p>}
    </div>
    <div class="actions"><button type="submit" class={buttonClass} disabled={busy || retry > 0 || disabled}>{busy ? busyLabel : label}</button>{toChildArray(children).map(child => typeof child === 'object' ? cloneElement(child, { disabled: busy || disabled || child.props.disabled }) : child)}</div>
  </form>;
}

export default function OtpEnrollment({ onComplete, onCancel, onLogout, onBusy = () => {} }) {
  const [draft, setDraft] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [copyNotice, setCopyNotice] = useState('');
  const generation = useRef(0), starting = useRef(false);
  useEffect(() => { void begin(); return () => { generation.current++; onBusy(false); }; }, []);
  useEffect(() => {
    if (!draft) return;
    const timeout = setTimeout(() => {
      setDraft(null); setError('등록 시간이 지났어요. 새 QR 코드로 다시 시작해 주세요.');
      // Pending expiry must be resolved by the server and return to password login.
      if (session.value?.step === 'enroll') void api('/api/auth/session').catch(() => {});
    }, Math.max(0, Date.parse(draft.expiresAt) - Date.now()));
    return () => clearTimeout(timeout);
  }, [draft]);
  async function begin() {
    if (starting.current) return;
    const version = ++generation.current;
    starting.current = true; setBusy(true); onBusy(true); setError(''); setDraft(null);
    try {
      const value = await api('/api/otp/enrollment', { method: 'POST', body: {} });
      if (version === generation.current) setDraft(value);
    } catch (failure) { if (version === generation.current) setError(failure.message); }
    finally { starting.current = false; if (version === generation.current) { setBusy(false); onBusy(false); } }
  }
  async function confirm(code) {
    try {
      const value = await api('/api/otp/enrollment/confirm', { method: 'POST', body: { draftId: draft.draftId, code } });
      setDraft(null); if (session.value === value && value.step === 'done') await onComplete?.();
    } catch (failure) {
      if (['OTP_SETUP_EXPIRED', 'OTP_UNAVAILABLE'].includes(failure.code)) { setDraft(null); setError(failure.message); }
      throw failure;
    }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(draft.manualKey); setCopyNotice('키를 복사했어요.'); }
    catch { setCopyNotice('복사하지 못했어요. 수동 입력 키를 선택해 복사해 주세요.'); }
  }
  if (!draft) return <div aria-busy={busy}><p class="otp-error" role="alert">{error}</p>{busy ? <p role="status">QR 코드를 준비하고 있어요…</p> : <button class="btn" onClick={begin}>새 QR 코드로 다시 시작</button>}{onCancel && <button class="btn ghost" onClick={onCancel} disabled={busy}>취소</button>}{onLogout && <button class="btn ghost" onClick={onLogout} disabled={busy}>로그아웃</button>}</div>;
  return <div class="otp-enroll">
    <section class="qr-side"><h3>1. 인증 앱에 추가하세요</h3><p>인증 앱에서 QR 코드를 스캔하거나<br/>아래 키를 직접 입력해 주세요.</p>
      <img class="qr" src={draft.qrDataUrl} alt="인증 앱 등록용 QR 코드" width="156" height="156" referrerPolicy="no-referrer"/>
      <span class="qr-caption">QR 코드는 5분 동안 유효합니다</span>
      <label class="otp-note">QR을 읽을 수 없나요? 수동 입력 키</label><div class="key-row"><code class="manual-key">{draft.manualKey}</code><button class="btn" type="button" onClick={copy}>복사</button></div><p role="status">{copyNotice}</p>
    </section>
    <section><h3>2. 코드를 확인해 주세요</h3><p>앱에 계정을 추가한 뒤 코드를 입력하면<br/>2단계 인증이 켜집니다.</p>
      <OtpCodeForm submit={confirm} label={session.value?.step === 'enroll' ? '등록하고 웹메일 이용' : '확인하고 켜기'} busyLabel="등록 중…" onBusy={onBusy}>{onCancel && <button class="btn" type="button" onClick={onCancel}>취소</button>}{onLogout && <button class="btn ghost" type="button" onClick={onLogout}>로그아웃</button>}</OtpCodeForm><p class="otp-note">휴대폰을 잃어버리면 관리자에게 초기화를 요청해 주세요.</p>
    </section>
  </div>;
}
