import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { adminSession } from '../state/session.js';
import { useAdminData } from '../hooks/useAdminData.js';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import FlowSteps from '../components/FlowSteps.jsx';
import ConfirmTyped from '../components/ConfirmTyped.jsx';
import Diff from '../components/Diff.jsx';
import Notice from '../components/Notice.jsx';
import '../pages/cleanup.css';

export const cleanupFolders = [['inbox', '받은편지함'], ['sent', '보낸편지함'], ['junk', '정크'], ['all', '전체 폴더']];
const size = value => `${Number(value).toLocaleString('ko-KR', { maximumFractionDigits: 3 })} KiB`;
export function QuotaDiff({ value }) {
  return <Diff rows={[
    ['사용량', size(value.before.usedKiB), size(value.after.usedKiB)],
    ['한도', value.before.limitKiB === '-' ? '무제한' : size(value.before.limitKiB), value.after.limitKiB === '-' ? '무제한' : size(value.after.limitKiB)],
    ['사용량 차이', '—', `${(value.after.usedBytes - value.before.usedBytes).toLocaleString('ko-KR')} bytes`],
  ]}/>;
}
export function CleanEditor({ mailbox, flow = false, options, page, setPage }) {
  const [draft, setDraft] = useState({ mailbox: mailbox?.trim().toLowerCase() || '', folder: 'inbox', before: '', confirmTeam: false }), [step, setStep] = useState(0), [preview, setPreview] = useState(null), [result, setResult] = useState(null), [error, setError] = useState(null), [fieldError, setFieldError] = useState(null), [busy, setBusy] = useState(false), [disabled, setDisabled] = useState(false), [typed, setTyped] = useState(''), [ack, setAck] = useState(false);
  const alive = useRef(true), heading = useRef(null), pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (flow || step > 0) heading.current?.focus(); }, [step, flow]);
  function reset() { setStep(0); setPreview(null); setResult(null); setTyped(''); setAck(false); setFieldError(null); setError(null); }
  function change(patch) { setDraft(old => ({ ...old, ...patch })); reset(); }
  const field = name => fieldError?.field === name ? <p id={`clean-${name}-error`} class="cleanup-field-error" role="alert">{fieldError.message}</p> : null;
  async function submit(event) {
    event.preventDefault();
    if (pending.current || disabled || !draft.before || !draft.mailbox) return;
    if (step === 1) { setStep(2); setTyped(''); setAck(false); return; }
    if (step === 2 && (!ack || typed !== draft.mailbox || !preview)) return;
    pending.current = true; setBusy(true); setError(null); setFieldError(null);
    try {
      const value = await adminApi(`/api/admin/cleanup/${step === 0 ? 'count' : 'run'}`, { method: 'POST', body: step === 0 ? draft : { token: preview.token, confirmAddress: typed } });
      if (!alive.current) return;
      if (step === 0) { setPreview(value); setStep(1); } else { setResult(value); setStep(3); }
    } catch (failure) {
      if (!alive.current) return;
      if (failure.code === 'CLEANUP_DISABLED') setDisabled(true);
      if (['COUNT_CHANGED', 'PREVIEW_EXPIRED'].includes(failure.code)) { reset(); setError(failure); }
      else if (failure.status === 422) { if (step === 2 && failure.code !== 'CONFIRM_ADDRESS_REQUIRED') reset(); setFieldError({ field: failure.code === 'DATE_REQUIRED' ? 'before' : failure.code === 'TEAM_CONFIRM_REQUIRED' ? 'team' : failure.code === 'CONFIRM_ADDRESS_REQUIRED' ? 'confirm' : 'mailbox', message: failure.message }); }
      else { setError(failure); if (step === 2) { setPreview(null); setTyped(''); setAck(false); setStep(0); } }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  const inputs = <><h2 ref={step === 0 ? heading : null} tabIndex="-1">{flow ? '정리 범위' : '기준일 이전 메일 삭제'}</h2>{flow && <><div class="field"><label for="clean-mailbox">메일함</label><select id="clean-mailbox" required value={draft.mailbox} onChange={event => change({ mailbox: event.currentTarget.value, confirmTeam: false })} aria-describedby="clean-mailbox-error"><option value="">메일함 선택</option>{draft.mailbox && !options.data?.items.some(row => row.address === draft.mailbox) && <option value={draft.mailbox}>{draft.mailbox}</option>}{options.data?.items.map(row => <option key={row.address} value={row.address}>{row.name} · {row.address}</option>)}</select>{field('mailbox')}</div>{options.loading ? <Loading/> : options.error ? <LoadError error={options.error} retry={options.reload}/> : <div class="account-pages"><button class="btn" type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>이전 쪽</button><span>{page} / {Math.max(1, Math.ceil(options.data.total / options.data.pageSize))}</span><button class="btn" type="button" disabled={page * options.data.pageSize >= options.data.total} onClick={() => setPage(page + 1)}>다음 쪽</button></div>}</>}{!flow && field('mailbox')}<div class="form-grid"><div class="field"><label for="clean-folder">폴더</label><select id="clean-folder" value={draft.folder} onChange={event => change({ folder: event.currentTarget.value })}>{cleanupFolders.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div class="field"><label for="clean-before">이 날짜 이전 (선택 날짜 제외)</label><input id="clean-before" required type="date" value={draft.before} onInput={event => change({ before: event.currentTarget.value })} aria-describedby="clean-before-error"/>{field('before')}</div></div><Notice tone="warn">팀 메일은 보존이 기본입니다. 개인 메일함을 우선 정리하세요. 삭제할 개수는 다음 단계에서 먼저 계산합니다.</Notice><label class="checkline"><input type="checkbox" checked={draft.confirmTeam} onChange={event => change({ confirmTeam: event.currentTarget.checked })} aria-describedby="clean-team-error"/>팀 메일함의 메일을 정리하는지 확인했어요.</label>{field('team')}<Notice tone="danger"><strong>삭제한 메일은 되돌릴 수 없습니다.</strong><p>보관할 메일이 없는지 확인하세요. 백업이 없는 메일함은 복구할 수 없습니다.</p></Notice></>;
  return <div class="cleanup-editor">{error && <Notice tone="danger"><p role="alert" data-error-code={error.code}>{error.message}</p></Notice>}{flow && <FlowSteps step={step}/>}{disabled ? null : step === 3 ? <section class="ac-result" aria-live="polite"><h2 ref={heading} tabIndex="-1">{result.result === 'partial' ? '일부 작업만 완료됐어요' : '메일 정리 완료'}</h2><Diff rows={[
    ['조건', `${result.mailbox} / ${cleanupFolders.find(([key]) => key === result.folder)?.[1]}`, `${draft.before} 이전 (해당일 제외)`],
    ['삭제 개수', `${preview.count}통`, `${result.deleted}통 삭제 · 잔여 대상 ${result.remaining}통`],
  ]}/><QuotaDiff value={result}/>{result.result === 'partial' && <><div class="table-wrap"><table aria-label="단계별 결과"><thead><tr><th>단계</th><th>결과</th></tr></thead><tbody><tr><td>메일 삭제</td><td>{result.deleted}통 삭제</td></tr><tr><td>잔여 대상 확인</td><td>{result.remaining}통 남음</td></tr><tr><td>용량 확인</td><td>완료</td></tr></tbody></table></div><Notice tone="warn">{result.recovery} <a href={`#cleanup/${encodeURIComponent(draft.mailbox)}`}>메일 정리에서 확인</a></Notice></>}<Notice>변경 기록에서 완료 단계와 결과를 확인할 수 있습니다. <a href="#history">변경 기록</a></Notice><div class="footer-actions"><button class="btn" onClick={reset}>개수 다시 확인</button><a class="btn pri" href={`#cleanup/${encodeURIComponent(draft.mailbox)}`}>메일 정리</a><a class="btn" href="#history">변경 기록</a></div></section> : <form onSubmit={submit}><div class={flow ? 'ac-flow-grid' : ''}><section><fieldset class="flow-fields" disabled={busy}>{step === 0 ? inputs : step === 1 ? <>{!flow && inputs}<h2 ref={heading} tabIndex="-1">삭제 대상 개수 확인</h2><Notice tone="warn"><strong>{preview.count}통</strong>이 조건에 맞습니다.<br/>메일 본문은 표시하지 않습니다.</Notice><Diff rows={[
    ['메일함', draft.mailbox, '동일'], ['폴더', cleanupFolders.find(([key]) => key === draft.folder)[1], '다른 폴더는 유지'], ['날짜 범위', `${draft.before} 이전 (해당일 제외)`, '조건에 맞는 메일만 삭제'], ['메일 수', `${preview.count}통`, '조건에 맞는 메일만 삭제'],
  ]}/><Notice tone="danger">실행 직전에 다시 확인해 개수나 조건이 달라지면 멈춥니다. 삭제는 복구할 수 없습니다.</Notice></> : <><h2 ref={heading} tabIndex="-1">되돌릴 수 없는 작업 확인</h2><Notice tone="danger">이 작업은 메일을 영구 삭제합니다. 백업이 없어 되돌릴 수 없습니다.<p>지운 메일은 휴지통으로 가지 않고 바로 사라집니다.</p></Notice><p>{draft.mailbox} · {preview.count}통 삭제</p><ConfirmTyped expected={draft.mailbox} value={typed} onChange={setTyped}/>{field('confirm')}<label class="checkline"><input type="checkbox" checked={ack} onChange={event => setAck(event.currentTarget.checked)}/>미리보기의 변경 내용과 영향을 확인했어요.</label></>}</fieldset><div class="footer-actions">{step === 0 ? flow && <a class="btn" href="#home">취소</a> : <button class="btn" type="button" disabled={busy} onClick={() => { if (step === 1) reset(); else { setStep(1); setTyped(''); setAck(false); setFieldError(null); } }}>이전</button>}<button class={`btn ${step === 2 ? 'dan' : 'pri'}`} disabled={busy || step === 0 && (!draft.before || !draft.mailbox || flow && (options.loading || options.error)) || step === 2 && (!ack || typed !== draft.mailbox)}>{busy ? '처리 중…' : ['개수 먼저 확인', '실행 확인으로', '영구 삭제 실행'][step]}</button></div></section>{flow && <aside class="ac-aside-note"><h3>실행 전 확인</h3><p>실행 직전에 다시 확인해 개수나 조건이 달라지면 멈춥니다.</p><Notice>개수 확인은 10분 동안 유효합니다.</Notice><p>메일 본문은 표시하지 않습니다.</p></aside>}</div></form>}</div>;
}
function CleanFlow({ address }) {
  const [page, setPage] = useState(1), options = useAdminData(`/api/admin/mailboxes?page=${page}`);
  return <div class="content ac-workflow cleanup-flow" data-admin-page="flow-clean"><a class="ac-back" href="#home">← 작업 시작으로</a><div class="ac-intro"><div><small>관리 작업</small><h1>메일 정리</h1><p class="muted">개수 확인 후 되돌릴 수 없는 삭제</p></div></div><CleanEditor flow mailbox={address} options={options} page={page} setPage={setPage}/></div>;
}
export default function Clean({ address = '' }) {
  if (adminSession.value?.features?.cleanup !== true) return <div class="content"><Notice>메일 정리와 용량 재확인이 꺼져 있어요.</Notice></div>;
  return <CleanFlow address={address}/>;
}
