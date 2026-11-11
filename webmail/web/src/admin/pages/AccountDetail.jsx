import { LeaveDialog, RetirementSettings } from '../flows/Leave.jsx';
import { SelectedShare } from './Shares.jsx';
import ManagementDialog from '../components/ManagementDialog.jsx';
import { useEffect, useRef, useState } from 'preact/hooks';
import { sieveDisabledWarning } from '../../../../server/admin/messages.js';
import { adminApi } from '../api.js';
import { useAdminData } from '../hooks/useAdminData.js';
import { accountKind, accountState, protocolNames } from './accounts.js';
import { bytes } from './status.js';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Notice from '../components/Notice.jsx';
import AccountRefs from '../components/AccountRefs.jsx';
import RecordNotice from '../components/RecordNotice.jsx';
function EditAccount({ row, close, saved }) {
  const dialog = useRef(null), [draft, setDraft] = useState({ name: row.name, quotaGb: row.quotaGb, active: row.active === 1, protocolInternalOnly: row.protocolInternalOnly, protocols: { ...row.protocols } }), [password, setPassword] = useState(''), [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const sieveOff = row.protocols.sieve && !draft.protocols.sieve;
  useEffect(() => { dialog.current.showModal(); return () => { dialog.current?.close(); }; }, []);
  const change = patch => { setDraft(value => ({ ...value, ...patch })); setAck(false); };
  async function submit(event) {
    event.preventDefault(); if (busy || error?.status === 409 || sieveOff && !ack) return;
    const body = { etag: row.etag, name: draft.name, quotaGb: Number(draft.quotaGb), protocols: draft.protocols, protocolInternalOnly: draft.protocolInternalOnly, ...(draft.active !== (row.active === 1) ? { active: draft.active } : {}), ...(password ? { password } : {}) };
    setBusy(true); setError(null);
    try { const response = await adminApi(`/api/admin/mailboxes/${encodeURIComponent(row.address)}`, { method: 'PATCH', body }); setPassword(''); saved(response); }
    catch (failure) { setPassword(''); setError(failure); }
    finally { delete body.password; setBusy(false); }
  }
  return <dialog ref={dialog} class="account-modal" aria-labelledby="edit-title" onCancel={event => { if (busy) event.preventDefault(); else close(); }}><h2 id="edit-title">메일함 수정</h2><p class="muted">{row.address} · {accountKind(row.kind)}</p><form onSubmit={submit}><div class="form-grid"><div class="field"><label for="edit-name">이름</label><input id="edit-name" required maxLength="255" value={draft.name} onInput={event => change({ name: event.currentTarget.value })}/></div><div class="field"><label for="edit-quota">용량 (GB)</label><input id="edit-quota" type="number" min="0.001" step="any" required value={draft.quotaGb} onInput={event => change({ quotaGb: event.currentTarget.value })}/></div></div><label class="checkline"><input type="checkbox" checked={draft.active} onChange={event => change({ active: event.currentTarget.checked })}/>메일함 사용</label><fieldset><legend>프로토콜</legend><div class="protocols">{protocolNames.map(name => <label class="checkline" key={name}><input type="checkbox" checked={draft.protocols[name]} onChange={event => change({ protocols: { ...draft.protocols, [name]: event.currentTarget.checked } })}/>{name === 'sieve' ? 'Sieve' : name.toUpperCase()} 사용</label>)}</div></fieldset><label class="checkline"><input type="checkbox" checked={draft.protocolInternalOnly} aria-describedby="protocol-internal-help" onChange={event => change({ protocolInternalOnly: event.currentTarget.checked })}/>IMAP·POP3·SMTP를 사내 IP에서만 허용</label><p class="hint" id="protocol-internal-help">로그인 예외 IP 목록을 사용합니다. 웹메일은 영향을 받지 않습니다.</p>{draft.protocolInternalOnly && row.protocolInternalAllowlistEmpty && <Notice tone="warn"><p>사내 IP 목록이 비어 있어 이 계정의 외부 로그인이 모두 거부됩니다.</p></Notice>}{sieveOff && <Notice tone="warn"><p data-error-code={sieveDisabledWarning.code}>{sieveDisabledWarning.message}</p><label class="checkline"><input type="checkbox" checked={ack} onChange={event => setAck(event.currentTarget.checked)}/>Sieve를 끌 때의 영향을 확인했어요.</label></Notice>}<div class="field"><label for="edit-password">새 암호 (선택)</label><input id="edit-password" type="password" autoComplete="new-password" value={password} onInput={event => setPassword(event.currentTarget.value)}/><small>비워 두면 지금 암호를 유지합니다. 암호는 변경 기록에 남기지 않습니다.</small></div>{error && <Notice tone="danger"><p role="alert" data-error-code={error.code}>{error.status === 409 ? '다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.' : error.message}</p>{error.status === 409 && <button class="btn" type="button" onClick={() => saved(null)}>현재 값 다시 읽기</button>}</Notice>}<div class="footer-actions"><button class="btn" type="button" disabled={busy} onClick={close}>취소</button><button class="btn pri" type="submit" disabled={busy || error?.status === 409 || sieveOff && !ack}>변경 저장</button></div></form></dialog>;
}
function OtpSection({ address }) {
  const status = useAdminData(`/api/admin/otp/accounts/${encodeURIComponent(address)}`), [confirm, setConfirm] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(null), [saved, setSaved] = useState(false);
  const close = () => { if (!busy) { setConfirm(null); setError(null); } };
  async function reset() {
    if (busy || !confirm || error) return;
    setBusy(true);
    try { await adminApi(`/api/admin/otp/accounts/${encodeURIComponent(address)}/reset`, { method: 'POST', body: { version: confirm.version, confirm: true } }); setConfirm(null); setSaved(true); status.reload(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  return <section class="detail-section otp-account" data-admin-otp="account"><div class="section-title"><h3>웹메일 2단계 인증</h3><button class="btn" disabled={status.loading || !!status.error} onClick={() => { setConfirm(status.data); setError(null); setSaved(false); }}>초기화</button></div>
    {status.loading ? <Loading/> : status.error ? <LoadError error={status.error} retry={status.reload}/> : <dl class="kv"><dt>상태</dt><dd>{status.data.enabled ? '등록됨' : '미등록'}</dd><dt>등록 시각</dt><dd>{status.data.registeredAt ? new Date(status.data.registeredAt).toLocaleString('ko-KR') : '—'}</dd></dl>}
    {saved && <Notice>2단계 인증을 초기화했습니다. 기존 웹메일 세션은 다시 로그인해야 합니다.</Notice>}
    {confirm && <ManagementDialog title="2단계 인증을 초기화할까요?" close={close} busy={busy}><p class="otp-target">{address}</p><p>등록한 인증 앱 연결을 지우고 기존 웹메일 세션을 만료시킵니다.</p><p>전체 필수 적용 중이면 다음 로그인 때 다시 등록해야 합니다.</p>
      {error && <Notice tone="danger"><p role="alert">{error.message}</p><button class="btn" disabled={busy} onClick={() => { close(); status.reload(); }}>현재 상태 다시 읽기</button></Notice>}
      {busy && <p role="status">초기화 중…</p>}<div class="footer-actions"><button class="btn" disabled={busy} onClick={close}>취소</button><button class="btn dan" disabled={busy || !!error} onClick={reset}>{busy ? '초기화 중…' : '초기화'}</button></div>
    </ManagementDialog>}
  </section>;
}
export default function AccountDetail({ address, changed }) {
  const result = useAdminData(`/api/admin/mailboxes/${encodeURIComponent(address)}`), [leaving, setLeaving] = useState(false), [editing, setEditing] = useState(false), [saved, setSaved] = useState(null), heading = useRef(null);
  useEffect(() => { if (matchMedia('(max-width:700px)').matches) heading.current?.focus({ preventScroll: true }); }, [result.data]);
  const savedResult = saved && <><Notice>{saved.result === 'partial' ? '일부 변경만 적용됐어요. 단계별 결과를 확인해 주세요.' : saved.unchanged ? '바뀐 내용이 없어요.' : '변경 내용을 저장했습니다.'}</Notice>{saved.steps?.map((step, i) => <p key={i}>{step.stage} · {step.status === 'ok' ? '완료' : '실패'} {step.code}</p>)}{saved.recovery?.map((row, i) => <Notice key={i}>{typeof row === 'string' ? row : row.message}</Notice>)}<RecordNotice steps={saved.steps}/></>;
  if (result.loading || result.error) return <>{saved?.result === 'partial' && <>{savedResult}<Notice tone="warn">현재 계정 상태는 아직 확인하지 못했습니다. 다시 읽기에 성공한 뒤 설정을 변경해 주세요.</Notice></>}{result.loading ? <Loading/> : <LoadError error={result.error} retry={result.reload}/>}</>;
  const row = result.data;
  return <><a class="btn ghost mobile-back" href="#accounts">← 목록으로</a><div class="detail-head"><span class="pic">{(row.name || row.address).slice(0, 1)}</span><div><h2 tabIndex="-1" ref={heading}>{row.name || row.address}</h2><p>{row.address}</p></div><span class="chip">{accountState(row.active, row.retirement)}</span></div><RetirementSettings row={row} record={() => setLeaving(true)} saved={response => { setSaved(response); result.reload(); changed(); }}/><section class="detail-section"><div class="section-title"><h3>메일함</h3><button class="btn" onClick={() => setEditing(true)}>수정</button></div><dl class="kv"><dt>종류</dt><dd>{accountKind(row.kind)}</dd><dt>사용량</dt><dd><b class="num">{bytes(row.usedBytes)}</b> / {row.quotaGb} GB · {row.messages}통</dd><dt>프로토콜</dt><dd>{protocolNames.filter(name => row.protocols[name]).map(name => name.toUpperCase()).join(' · ') || '꺼짐'}</dd><dt>사내 IP 제한</dt><dd>{row.protocolInternalOnly ? '켜짐 · IMAP·POP3·SMTP' : '꺼짐'}</dd><dt>앱 암호</dt><dd>{row.appPasswordCount}개</dd></dl></section>{row.warnings?.map(warning => <Notice key={warning.code} tone="warn">{warning.message}</Notice>)}{savedResult}<OtpSection key={address} address={address}/><section class="detail-section"><SelectedShare owner={address} embedded/></section><AccountRefs refs={row.refs}/><p class="hint">공유 조회 범위: {row.sharesScope === 'all' ? '모든 계정' : '팀과 이 메일함'}</p><div class="account-links"><a class="btn" href={`#flow/rename/${encodeURIComponent(address)}`}>주소 바꾸기</a><a class="btn" href={`#flow/toAlias/${encodeURIComponent(address)}`}>메일함 → 별칭</a><a class="btn" href="#flow/toMailbox">별칭 → 메일함</a><button class="btn" onClick={() => setLeaving(true)}>{row.retirement?.pendingOperation?.kind === 'leave' ? '퇴사 처리 · 남은 정리' : '퇴사 처리'}</button></div><div class="danger-zone"><a class="btn dan" href={`#flow/delete/${encodeURIComponent(address)}`}>메일함 지우기</a></div>{leaving && <LeaveDialog row={row} close={() => setLeaving(false)} settings={() => window.requestAnimationFrame(() => document.getElementById('retirement-settings')?.focus())} saved={response => { setSaved(response); result.reload(); changed(); }}/>} {editing && <EditAccount row={row} close={() => setEditing(false)} saved={response => { setEditing(false); setSaved(response); result.reload(); changed(); }}/>}</>;
}
