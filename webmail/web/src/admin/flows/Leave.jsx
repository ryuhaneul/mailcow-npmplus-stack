import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { useAdminData } from '../hooks/useAdminData.js';
import ManagementDialog from '../components/ManagementDialog.jsx';
import AccountRefs from '../components/AccountRefs.jsx';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Notice from '../components/Notice.jsx';
import MutationError from '../components/MutationError.jsx';
import RecordNotice from '../components/RecordNotice.jsx';
import { GranteeSelect } from '../pages/Shares.jsx';
import Empty from '../components/Empty.jsx';
import { referenceRow } from '../pages/accounts.js';

const mailMode = request => request.receiveBlocked ? 'block' : request.forwardTo ? 'forward' : 'allow';
const choices = request => ({ mode: mailMode(request), forwardTo: request.forwardTo || '', cleanRefs: request.cleanRefs ?? true, cleanShares: request.cleanShares ?? false });
const requestFor = draft => ({ receiveBlocked: draft.mode === 'block', forwardTo: draft.mode === 'forward' ? draft.forwardTo : null });
const filterLocation = row => ({'active-user':'개인 활성 필터',prefilter:'관리자 사전 필터',postfilter:'관리자 사후 필터',global:'공통 필터'})[row.type] || (row.source === 'user' ? '개인 필터' : row.source === 'global' ? '공통 필터' : '연결');
const reason = code => ({ OWNER_FORWARD_ACTIVE: '현재 전달을 먼저 제거해 주세요.', OWNER_FORWARD_UNEDITABLE: '관리 전달 필터를 직접 확인해 주세요.', FILTER_UNINSPECTABLE: '필터 내용을 안전하게 확인할 수 없어요.', FILTER_TARGET_REMAINS: '필터의 전달 대상을 먼저 정리해 주세요.', LAST_TEAM_MEMBER: '팀의 마지막 구성원이라 다른 구성원이 필요해요.' })[code] || '이 연결을 먼저 확인·정리해 주세요.';
function KeptShareRows({ address }) {
  const result = useAdminData(`/api/admin/mailboxes/${encodeURIComponent(address)}/refs?scope=all`);
  return <div aria-busy={result.loading}>{result.loading ? <Loading message="유지할 공유를 불러오는 중…"/> : result.error ? <LoadError title="유지할 공유를 불러오지 못했습니다" error={result.error} retry={result.reload}/> : <>{result.data.warnings?.map(warning => <Notice key={warning.code} tone="warn">{warning.message}</Notice>)}{result.data.refs.shares.length ? <div class="table-wrap"><table aria-label="유지할 읽기 공유"><thead><tr><th>주소 · 항목</th><th>연결 대상</th><th>영향 · 현재 상태</th></tr></thead><tbody>{result.data.refs.shares.map((row, index) => <tr key={index}>{referenceRow('shares', { ...row, effect: 'kept' }).map((value, cell) => <td key={cell}>{value}</td>)}</tr>)}</tbody></table></div> : <Empty>연결된 항목이 없어요.</Empty>}</>}</div>;
}
function KeptShares({ address }) {
  const [open, setOpen] = useState(false);
  return <section class="detail-section" aria-label="유지할 읽기 공유"><div class="section-title"><h3>유지할 읽기 공유</h3></div><Notice>기존 읽기 공유는 변경하지 않습니다.</Notice>{open ? <KeptShareRows address={address}/> : <><p class="hint">공유 목록은 필요할 때 확인할 수 있습니다.</p><button class="btn" type="button" onClick={() => setOpen(true)}>공유 목록 보기</button></>}<p class="hint">공유 목록 조회 결과는 이번 퇴사 처리의 변경 대상에 포함되지 않습니다.</p></section>;
}
export function RetirementPreview({ plan, leave = false }) {
  const changes = leave ? plan.receiveChanges : plan.changes;
  return <>{leave && <Notice>{plan.confirmation}<p>로그인 차단 · 메일 보존</p></Notice>}<dl class="kv"><dt>새 메일</dt><dd>{(leave ? plan.receiveBlocked : plan.after?.receiveBlocked) ? '수신 차단' : '수신 허용'}</dd>{leave && <><dt>기존 공유</dt><dd>{plan.cleanShares ? '정리' : '유지'}</dd></>}<dt>현재 전달</dt><dd>{plan.forwarding?.length ? plan.forwarding.map(row => row.inspected ? row.targets.join(', ') || '전달 안 함' : '확인 필요').join(' · ') : '전달 안 함'}</dd></dl>{plan.forwardingChange && <Notice>{plan.forwardingChange.message}</Notice>}{changes?.length > 0 && <><Notice tone="warn">차단 전에 전달 연결을 정리합니다. 다른 대상은 유지하며, 정리하지 못한 연결이 있으면 차단하지 않습니다.</Notice><div class="table-wrap"><table aria-label="정리될 연결"><thead><tr><th>연결</th><th>변경</th></tr></thead><tbody>{changes.map((row, i) => <tr key={i}><td>{row.address} · {row.kind === 'team' ? '팀 분배' : row.kind === 'owner-forward' ? '기존 전달' : '별칭'}</td><td>{row.kind === 'owner-forward' ? '미리보기에 표시된 관리 전달 제거' : `${row.remove?.join(', ') || ''} 제외`}{row.keep?.length > 0 && <small> · {row.keep.join(', ')} 유지</small>}</td></tr>)}</tbody></table></div></>}{plan.blockers?.map((row, i) => <Notice key={i} tone="danger"><p>{row.address || row.mailbox || '필터'} · {filterLocation(row)} {row.id ? `#${row.id}` : ''}</p><p>{reason(row.code)}</p><a href="#filters">필터에서 확인</a> · <a href="#teams">팀 분배에서 확인</a></Notice>)}{leave && <><AccountRefs refs={plan.refs} preview omitShares={plan.sharesState === 'deferred-kept'}/>{plan.sharesState === 'deferred-kept' && <KeptShares key={`${plan.address}:${plan.etag}`} address={plan.address}/>}</>}{plan.warnings?.map(row => <Notice key={row.code} tone="warn">{row.message}</Notice>)}<p class="hint">이미 접수된 메일은 이번 차단으로 취소되지 않습니다. 기존 메일은 보존됩니다.</p></>;
}
function OperationResult({ result, leave = false }) {
  return <><Notice tone={result.result === 'partial' ? 'warn' : ''}>{result.result === 'partial' ? '일부 작업만 완료됐어요. 완료된 변경은 이미 적용됐습니다. 남은 정리를 다시 미리보기로 확인해 주세요.' : '변경 내용을 저장했습니다.'}</Notice>{result.steps?.map((row, i) => <p key={i}>{row.stage} · {row.status === 'ok' ? '완료' : '실패'} {row.code}</p>)}{result.recovery?.map((row, i) => <Notice key={i}>{typeof row === 'string' ? row : row.message}</Notice>)}<RecordNotice steps={result.steps}/>{result.warnings?.map(row => <Notice key={row.code} tone="warn">{row.message}</Notice>)}{leave && <Notice tone="warn">막힌 뒤에도 옛 기기가 계속 접속을 시도하면 그 IP가 차단될 수 있고, 회사 IP면 사내 전체가 막힐 수 있어요.</Notice>}</>;
}
export function LeaveDialog({ row, close, saved = () => {}, settings = () => {} }) {
  const initial = row.retirement?.pendingOperation, [pending, setPending] = useState(initial), [draft, setDraft] = useState(() => choices(initial?.kind === 'leave' ? initial.request : {})), [preview, setPreview] = useState(null), [result, setResult] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false), [ack, setAck] = useState(false);
  const already = result?.alreadyRetired || !result && row.retirement?.retired && pending?.kind !== 'leave', locked = pending?.kind === 'leave';
  const finish = () => { if (busy) return; close(); if (result) saved(result); };
  const request = locked ? pending.request : { cleanRefs: draft.cleanRefs, cleanShares: draft.cleanShares, ...requestFor(draft) };
  const change = patch => { setDraft(value => ({ ...value, ...patch })); setPreview(null); setAck(false); setError(null); };
  async function submit(event) {
    event.preventDefault(); if (busy || preview && (!ack || preview.canPrepare === false || error?.status === 409)) return;
    setBusy(true); setError(null);
    try {
      const response = await adminApi('/api/admin/flows/leave', { method: 'POST', body: { address: row.address, mode: 'disable', ...request, action: preview ? 'run' : 'preview', ...(preview ? { etag: preview.etag, cleanupConfirmed: ack } : {}) } });
      if (response.alreadyRetired) { setResult(response); setPreview(null); }
      else if (preview) { setResult(response); setPending(response.retirement?.pendingOperation || null); }
      else { setPreview(response); setAck(false); }
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  if (already) return <ManagementDialog title="이미 퇴사 처리된 계정입니다" close={finish}><p>{row.name} · {row.address}</p><Notice>퇴사 처리를 다시 실행하지 않습니다. 새 메일 수신 차단과 전달은 계정 설정에서 변경할 수 있습니다.</Notice><p>기존 메일과 공유 설정은 그대로 유지됩니다.</p><div class="footer-actions"><button class="btn" onClick={finish}>닫기</button><button class="btn pri" onClick={() => { finish(); settings(); }}>계정 설정으로</button></div></ManagementDialog>;
  return <ManagementDialog title={locked ? '퇴사 처리 · 남은 정리' : preview ? '퇴사 처리 · 변경 미리보기' : '퇴사 처리'} busy={busy} close={finish}><p class="muted">{row.name} · {row.address}</p>{result ? <><OperationResult result={result} leave/><div class="footer-actions"><button class="btn" onClick={finish}>계정에서 확인</button>{result.result === 'partial' && pending?.kind === 'leave' && <button class="btn pri" onClick={() => { setPreview(null); setResult(null); setError(null); setAck(false); }}>남은 정리 미리보기</button>}</div></> : <form onSubmit={submit}><fieldset class="flow-fields" disabled={busy}>{!preview ? <><Notice>로그인을 차단하고 메일은 보존합니다.</Notice>{!row.retirement?.retired && row.active === 2 && <Notice tone="warn">받기 전용 계정입니다. 퇴사 여부를 확인한 뒤 실행하면 퇴사 기록을 남깁니다.</Notice>}{locked && <Notice tone="warn">이미 적용된 퇴사 처리의 남은 정리입니다. 저장된 요청 선택값을 그대로 사용합니다.</Notice>}<div class="field"><label for="leave-mail-mode">새 메일 처리</label><select id="leave-mail-mode" disabled={locked} value={locked ? mailMode(request) : draft.mode} onChange={event => change({ mode: event.currentTarget.value, forwardTo: '' })}><option value="allow">{locked && !Object.hasOwn(request, 'forwardTo') ? '수신 허용 · 기존 전달 유지' : '수신 허용 · 전달 안 함'}</option><option value="block" disabled={!row.retirement?.featureEnabled}>수신 차단</option><option value="forward">수신 허용 · 새 메일 전달</option></select><small>수신 차단과 새 메일 전달은 함께 사용할 수 없습니다. 수신 차단을 선택하면 현재 관리 전달을 끕니다.</small></div>{(locked ? mailMode(request) : draft.mode) === 'forward' && <div class="field"><p>전달받을 사람</p>{locked ? <p>{request.forwardTo}</p> : <GranteeSelect owner={row.address} value={draft.forwardTo} onChange={value => change({ forwardTo: value })}/>}</div>}<label class="checkline"><input type="checkbox" disabled={locked} checked={locked ? request.cleanRefs : draft.cleanRefs} onChange={event => change({ cleanRefs: event.currentTarget.checked })}/>팀 분배·보내기 권한·동기화에서 제외</label><label class="checkline"><input id="leave-clean-shares" type="checkbox" disabled={locked} checked={locked ? request.cleanShares : draft.cleanShares} onChange={event => change({ cleanShares: event.currentTarget.checked })}/>기존 공유 정리(제외)</label><p class="hint">선택하지 않으면 기존 공유를 유지합니다. 퇴사 처리 후에도 공유를 추가할 수 있습니다.</p>{!row.retirement?.featureEnabled && <Notice tone="warn">서버 수신 차단 기능 꺼짐 · 현재는 새 메일을 받습니다. 수신 차단을 변경하려면 서버 기능을 먼저 켜야 합니다.</Notice>}</> : <><RetirementPreview plan={preview} leave/><label class="checkline"><input type="checkbox" checked={ack} onChange={event => setAck(event.currentTarget.checked)}/>변경 내용과 정리될 연결을 확인했습니다</label></>}</fieldset><MutationError error={error} reload={() => { setPreview(null); setAck(false); setError(null); }}/><div class="footer-actions"><button class="btn" type="button" disabled={busy} onClick={preview ? () => { setPreview(null); setAck(false); setError(null); } : finish}>{preview ? '이전' : '취소'}</button><button class="btn pri" disabled={busy || preview && (!ack || preview.canPrepare === false || error?.status === 409)}>{busy ? '처리 중…' : preview ? '퇴사 처리 실행' : '변경 미리보기'}</button></div></form>}</ManagementDialog>;
}
export function RetirementSettings({ row, saved, record }) {
  const state = row.retirement || {}, [blocked, setBlocked] = useState(!!state.receiveBlocked), [mode, setMode] = useState(state.receiveBlocked ? 'remove' : 'keep'), [forwardTo, setForwardTo] = useState(''), [preview, setPreview] = useState(null), [result, setResult] = useState(null), [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(null), section = useRef(null);
  useEffect(() => { setBlocked(!!state.receiveBlocked); }, [state.receiveBlocked]);
  const eligible = state.retired && row.active === 2 && state.pendingOperation?.kind !== 'leave';
  const editable = eligible && (state.featureEnabled || !state.receiveBlocked);
  const forwardingChanged = mode === 'remove' ? state.forwarding === null || !!state.forwarding?.length : mode === 'forward' && !!forwardTo && !state.forwarding?.includes(forwardTo);
  const changed = blocked !== !!state.receiveBlocked || forwardingChanged;
  const recovering = state.pendingOperation?.kind === 'settings';
  const canPreview = changed || recovering;
  const sharesLink = <a class="btn ghost" href={`#shares/${encodeURIComponent(row.address)}`}>공유 설정</a>;
  const request = { receiveBlocked: blocked, ...(mode === 'forward' ? { forwardTo } : mode === 'remove' || blocked ? { forwardTo: null } : {}) };
  async function submit(event) {
    event.preventDefault(); if (busy || !editable || !canPreview || preview && (!ack || preview.canPrepare === false || error?.status === 409)) return;
    setBusy(true); setError(null);
    try {
      const response = await adminApi(`/api/admin/mailboxes/${encodeURIComponent(row.address)}/${preview ? 'retirement' : 'retirement-preview'}`, { method: preview ? 'PATCH' : 'POST', body: { ...request, ...(preview ? { etag: preview.etag, cleanupConfirmed: ack } : {}) } });
      if (preview) { setPreview(null); setResult(response); saved(response); } else { setPreview(response); setAck(false); }
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <section class="detail-section" id="retirement-settings" ref={section} tabIndex="-1">
    <div class="section-title"><h3>퇴사 · 수신 설정</h3></div>
    <dl class="kv">
      <dt>퇴사</dt><dd>{state.retired ? `처리됨${state.recordedAt ? ` · ${new Date(state.recordedAt).toLocaleDateString('ko-KR')}` : ''}` : row.active === 2 ? '기록 확인 필요' : '처리 전'}</dd>
      <dt>로그인</dt><dd>{row.active === 1 ? '허용됨' : '차단됨'}</dd>
      <dt>새 메일 수신</dt><dd>{!state.featureEnabled && state.receiveBlocked ? '차단 선택 저장됨' : state.effectiveReceiveBlock === 'on' ? '차단 중' : state.effectiveReceiveBlock === 'unverified' ? '차단 적용 확인 필요' : '허용 중'}{!state.featureEnabled && <span class="muted"> · 서버 기능 꺼짐</span>}</dd>
      <dt>새 메일 전달</dt><dd>{state.forwarding === null ? '확인 필요' : state.forwarding?.length ? `전달: ${state.forwarding.join(', ')}` : '전달 안 함'}</dd>
    </dl>
    {!state.retired && row.active === 2 && <Notice tone="warn"><p>퇴사 확인 필요 · 받기 전용 계정입니다. 퇴사 여부를 확인한 뒤 퇴사 기록을 남겨 주세요.</p>{record && <div class="footer-actions"><button class="btn" type="button" onClick={record}>퇴사 기록 남기기</button></div>}</Notice>}
    {state.pendingOperation && <Notice tone="warn">남은 정리가 있습니다. {state.pendingOperation.kind === 'leave' ? '퇴사 처리에서 저장된 요청으로 다시 미리보기를 확인해 주세요.' : '현재 설정을 다시 미리보기로 확인해 주세요.'}</Notice>}
    {state.warnings?.filter(warning => state.featureEnabled || warning.code !== 'RECEIVE_BLOCK_UNVERIFIED').map(warning => <Notice key={warning.code} tone="warn">{warning.message}</Notice>)}
    {editable ? <form class="management" onSubmit={submit}>
      <fieldset class="flow-fields" disabled={busy}>
        {state.featureEnabled && <><label class="checkline"><input id="receive-block" type="checkbox" checked={blocked} aria-describedby="receive-block-help" onChange={event => { setBlocked(event.currentTarget.checked); if (event.currentTarget.checked) setMode('remove'); setPreview(null); setError(null); }}/>새 메일 수신 차단</label><p class="hint" id="receive-block-help">차단하면 이 주소로 보내는 새 메일을 거부합니다. 보관된 메일은 공유로 확인할 수 있습니다.</p></>}
        <div class="field"><label for="retirement-mail-mode">새 메일 전달</label><select id="retirement-mail-mode" disabled={blocked} value={mode} onChange={event => { setMode(event.currentTarget.value); setPreview(null); setError(null); }}><option value="keep">기존 전달 유지</option><option value="remove">전달 안 함 · 기존 관리 전달 끄기</option><option value="forward">수신 허용 · 새 메일 전달</option></select></div>
        {mode === 'forward' && !blocked && <div class="field"><p>전달받을 사람</p><GranteeSelect owner={row.address} value={forwardTo} onChange={value => { setForwardTo(value); setPreview(null); }}/></div>}
      </fieldset>
      <div class="footer-actions">{sharesLink}{canPreview && <button class="btn" type="submit" disabled={busy}>{recovering ? '남은 정리 미리보기' : '변경 미리보기'}</button>}</div>
    </form> : sharesLink}
    {error && !preview && <MutationError error={error}/>}
    {result && <OperationResult result={result}/>} {preview && <ManagementDialog title={`새 메일 수신 ${blocked ? '차단' : '허용'}으로 바꿀까요?`} busy={busy} close={() => { if (!busy) { setPreview(null); setError(null); } }}><form onSubmit={submit}>{!blocked && <Notice>이전에 제외한 팀·별칭 연결은 자동 복원되지 않습니다.</Notice>}<RetirementPreview plan={preview}/><p>기존 메일과 읽기 공유는 유지됩니다.</p><label class="checkline"><input type="checkbox" checked={ack} onChange={event => setAck(event.currentTarget.checked)}/>변경 내용과 정리될 연결을 확인했습니다</label><MutationError error={error} reload={() => { setPreview(null); setError(null); }}/><div class="footer-actions"><button class="btn" type="button" disabled={busy} onClick={() => { setPreview(null); setError(null); }}>취소</button><button class="btn pri" disabled={busy || !ack || preview.canPrepare === false || error?.status === 409}>{blocked ? '수신 차단' : '수신 허용'}</button></div></form></ManagementDialog>}</section>;
}
export default function Leave({ address = '' }) {
  const [selected, setSelected] = useState(address), [open, setOpen] = useState(true), [page, setPage] = useState(1), [q, setQ] = useState(''), boxes = useAdminData(`/api/admin/mailboxes?${new URLSearchParams({q,page})}`), detail = useAdminData(`/api/admin/mailboxes/${encodeURIComponent(selected)}`);
  return <div data-admin-page="flow-leave"><div class="page-head"><h1>퇴사 처리</h1></div><div class="field"><label for="leave-search">메일함 검색</label><input id="leave-search" value={q} onInput={event => { setQ(event.currentTarget.value); setPage(1); }}/></div><div class="field"><label for="leave-address">메일함</label><select id="leave-address" value={selected} onChange={event => { setSelected(event.currentTarget.value); setOpen(true); }}><option value="">메일함 선택</option>{selected && !boxes.data?.items.some(row => row.address === selected) && <option value={selected}>{selected}</option>}{boxes.data?.items.map(row => <option value={row.address}>{row.name} · {row.address}</option>)}</select></div><div class="account-pages"><button class="btn" disabled={page===1} onClick={() => setPage(page-1)}>이전 쪽</button><span>{page}</span><button class="btn" disabled={!boxes.data || page*boxes.data.pageSize>=boxes.data.total} onClick={() => setPage(page+1)}>다음 쪽</button></div>{boxes.error && <LoadError error={boxes.error} retry={boxes.reload}/>} {selected && (detail.loading || detail.data?.address !== selected && !detail.error ? <Loading/> : detail.error ? <LoadError error={detail.error} retry={detail.reload}/> : <><a class="btn" href={`#accounts/${encodeURIComponent(selected)}`}>계정에서 확인</a><button class="btn" onClick={() => setOpen(true)}>퇴사 처리</button>{open && <LeaveDialog key={selected} row={detail.data} close={() => setOpen(false)} saved={detail.reload} settings={() => { location.hash = `#accounts/${encodeURIComponent(selected)}`; }}/>}</>)}</div>;
}
