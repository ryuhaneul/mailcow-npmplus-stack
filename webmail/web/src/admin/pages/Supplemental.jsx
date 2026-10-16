import { useEffect, useRef, useState } from 'preact/hooks';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import ManagementDialog from '../components/ManagementDialog.jsx';
import MutationError from '../components/MutationError.jsx';
import FlowSteps from '../components/FlowSteps.jsx';
import Diff from '../components/Diff.jsx';
import Notice from '../components/Notice.jsx';
import RecordNotice from '../components/RecordNotice.jsx';
import './supplemental.css';

// These resources return complete lists with domain/id/host keys, rather than paged mailboxes.
export function SupplementalPage({ hash, title, description, actions, state, entries = [], selected, tools, children }) {
  return <div class="management af08a" data-admin-page={hash}><div class="page-head"><div><h1>{title}</h1><p>{description}</p></div><div class="actions">{actions}</div></div><div class={`account-split ${selected && !state.error ? 'detail-open' : ''}`}><section class="list-pane" aria-label={`${title} 목록`}>{tools && <div class="list-tools">{tools}</div>}{state.loading ? <Loading/> : state.error ? <><LoadError error={state.error} retry={state.reload}/>{state.error.code === 'MAP_READ_UNAVAILABLE' && <Notice tone="warn">{state.error.message}<p>읽을 수 없어 편집할 수 없습니다.</p></Notice>}</> : <><div class="list-meta">{entries.length}개</div>{entries.length ? entries.map(row => <a key={row.key} class={`account-item ${row.key === (selected || entries[0]?.key) ? 'selected' : ''}`} href={`#${hash}/${encodeURIComponent(row.key)}`}><span class="body"><b>{row.title}</b><span class="email">{row.description}</span>{row.status && <span class="chip">{row.status}</span>}</span></a>) : <Empty>등록된 항목이 없습니다.</Empty>}</>}</section><section class="account-detail" aria-label={`${title} 상세`}><a class="btn ghost mobile-back" href={`#${hash}`}>← 목록으로</a>{state.loading ? <Loading/> : state.error ? null : children}</section></div></div>;
}

export function CopyValue({ value, label = '값 복사' }) {
  const [message, setMessage] = useState('');
  useEffect(() => setMessage(''), [value]);
  return <><button class="btn" type="button" onClick={async () => { try { await navigator.clipboard.writeText(value); setMessage('값을 복사했습니다.'); } catch { setMessage('표시된 값을 선택해 복사해 주세요.'); } }}>{label}</button>{message && <span role="status">{message}</span>}</>;
}

export function SupplementalResult({ result }) {
  if (!result) return null;
  const notices = [...new Set([result.notice, result.warning, result.detail?.warning, result.detail?.notice].filter(Boolean))];
  return <div class="af08a-result" role="status"><p>{result.unchanged ? '바뀐 내용이 없어요.' : '변경을 적용했습니다.'}</p>{notices.map(value => <Notice key={value}>{value}</Notice>)}<RecordNotice steps={[{ auditId: result.auditId }]}/><a href="#history">변경 기록</a></div>;
}

// All supplementary mutations use the existing four stages and the approved confirmation wording.
export function SupplementalFlow({ title, close, input, prepare, execute, warning, confirmValue = '', overwriteAllowed = false, reload, saved }) {
  const [step, setStep] = useState(0), [preview, setPreview] = useState(null), [result, setResult] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false), [ack, setAck] = useState(false), [typed, setTyped] = useState(''), [overwrite, setOverwrite] = useState(false);
  const heading = useRef(null), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => heading.current?.focus(), [step]);
  const expected = confirmValue;
  const stale = error?.status === 409 && error.code === 'CHANGED_ELSEWHERE';
  function reset() { setStep(0); setPreview(null); setError(null); setAck(false); setTyped(''); setOverwrite(false); reload?.(); }
  async function submit(event) {
    event.preventDefault(); if (busy || stale) return;
    if (step === 1) { setAck(false); setTyped(''); setStep(2); return; }
    if (step === 2 && (!ack || expected && typed !== expected || error?.code === 'ALIAS_DOMAIN_IN_USE' || error?.code === 'DKIM_EXISTS' && !overwrite)) return;
    setBusy(true); setError(null);
    try {
      const value = step === 0 ? await prepare() : await execute(preview, { typed, overwrite });
      if (!live.current) return;
      if (step === 0) { setPreview(value); setStep(1); } else { setResult(value); setStep(3); saved?.(value); }
    } catch (failure) { if (live.current) { setError(failure); if (failure.status === 422) { setStep(0); setPreview(null); setAck(false); setTyped(''); setOverwrite(false); } } }
    finally { if (live.current) setBusy(false); }
  }
  return <ManagementDialog title={title} close={close} busy={busy}><div class="af08a-flow"><FlowSteps step={step}/><h3 ref={heading} tabIndex="-1">{['입력', '변경 미리보기', '실행 전 마지막 확인', '처리 결과'][step]}</h3>{step === 3 ? <><SupplementalResult result={result}/><div class="footer-actions"><button class="btn" onClick={close}>닫기</button></div></> : <form onSubmit={submit}><fieldset class="flow-fields" disabled={busy}>{step === 0 ? input : <Diff rows={preview.rows}/>}<MutationError error={stale ? { ...error, message: '다른 곳에서 바뀌었어요' } : error} reload={reset}/>{error?.code === 'ALIAS_DOMAIN_IN_USE' && <Notice tone="warn">{error.aliases?.map(row => <p key={row.address}><a href={`#aliases/${encodeURIComponent(row.address)}`}>{row.address}</a> → {row.goto}</p>)}{error.bcc?.map(row => <p key={row.id}>BCC · {row.local_dest} → {row.bcc_dest}</p>)}<a href="#aliases">별칭에서 확인</a></Notice>}{error?.code === 'DKIM_EXISTS' && <Notice tone="warn"><p>{error.domains?.join(' · ')}</p>{overwriteAllowed && <button class="btn dan" type="button" onClick={() => { setOverwrite(true); setError(null); setAck(false); }}>덮어쓰기 확인</button>}</Notice>}{(warning || preview?.warning) && <Notice tone="warn">{preview?.warning || warning}</Notice>}{step === 2 && <><Notice>변경 직전에 현재 값을 다시 읽어 대조하고 저장 후 확인합니다. 다른 곳에서 바뀌면 멈춥니다. 모든 변경은 전후 기록을 남깁니다.</Notice>{overwrite && <Notice tone="danger">기존 DKIM 키를 덮어씁니다.</Notice>}{expected && <div class="field"><label for="af08a-confirm">확인하려면 아래 값을 직접 입력하세요.</label><p>{expected}</p><input id="af08a-confirm" required autoComplete="off" value={typed} onInput={event => setTyped(event.currentTarget.value)}/></div>}<label class="checkline"><input type="checkbox" checked={ack} onChange={event => setAck(event.currentTarget.checked)}/>바뀌는 내용과 영향을 확인했습니다.</label></>}</fieldset><div class="footer-actions"><button class="btn" type="button" disabled={busy} onClick={close}>취소</button>{step > 0 && <button class="btn" type="button" disabled={busy} onClick={reset}>입력으로</button>}<button class={`btn ${expected || overwrite ? 'dan' : 'pri'}`} disabled={busy || stale || step === 2 && (!ack || expected && typed !== expected || error?.code === 'ALIAS_DOMAIN_IN_USE' || error?.code === 'DKIM_EXISTS' && !overwrite)}>{busy ? '처리 중…' : ['변경 미리보기', '실행 확인으로', '확인하고 실행'][step]}</button></div></form>}</div></ManagementDialog>;
}
