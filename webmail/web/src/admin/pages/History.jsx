import { useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { useAdminData } from '../hooks/useAdminData.js';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import ManagementDialog from '../components/ManagementDialog.jsx';
import './history.css';
import { kst } from './status.js';

const display = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '—';
const canRevert = row => row?.revertible === true && row?.canRevert === true;
const resultLabel = value => ({ ok: '완료', failed: '실패', partial: '일부 적용', not_run: '실행 안 함', skipped: '실행 안 함' })[value] || value || '결과 확인 안 됨';
export function HistoryOutcome({ value }) {
  const detail = value.detail || value, steps = value.steps || detail.steps || [], recovery = value.recovery || detail.recovery, skipped = value.skipped || detail.skipped || [];
  return <>{skipped.length > 0 && <Notice>없어진 폴더 {skipped.length}개는 건너뛰었어요</Notice>}{value.message && <Notice>{value.message}</Notice>}{value.notice && <Notice>{value.notice}</Notice>}{value.reason && <Notice tone="warn">{value.reason}</Notice>}{detail !== value && <>{detail.notice && <Notice>{detail.notice}</Notice>}{detail.reason && <Notice tone="warn">{detail.reason}</Notice>}</>}{steps.length > 0 && <div class="table-wrap"><table><thead><tr><th>단계</th><th>결과</th><th>안내</th></tr></thead><tbody>{steps.map((row, index) => <tr key={index}><td>{row.stage || row.name || row.target}</td><td>{resultLabel(row.status || row.result)}</td><td>{row.code}{row.message && <p>{row.message}</p>}{row.recovery && <p>{display(row.recovery)}</p>}</td></tr>)}</tbody></table></div>}{recovery && (Array.isArray(recovery) ? recovery : [recovery]).map((row, index) => <Notice tone="warn" key={index}>{typeof row === 'string' ? row : row.message || display(row)}<p><a href="#history">변경 기록</a>{value.action === 'logo.change' && <> · <a href="#logo">웹메일 로고 설정</a></>}</p></Notice>)}</>;
}
export function HistoryMutationError({ error, reload }) {
  if (!error) return null;
  return <Notice tone="danger"><p role="alert" data-error-code={error.code}>{error.message}</p>{error.reason && <p>{error.reason}</p>}{reload && <p><button class="btn" type="button" onClick={reload}>다시 읽기</button></p>}</Notice>;
}
export function RevertDialog({ record, close, onSaved, reload }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  async function submit(event) {
    event.preventDefault(); if (busy || error || !canRevert(record)) return;
    setBusy(true);
    try { const result = await adminApi(`/api/admin/history/${encodeURIComponent(record.id)}/revert`, { method: 'POST', body: { confirm: true } }); onSaved(result); }
    catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <ManagementDialog title={record.action === 'logo.change' ? '이전 로고로 되돌릴까요?' : '이 변경을 되돌릴까요?'} close={close} busy={busy}><form onSubmit={submit}><p>현재 설정과 기록을 대조한 뒤 이전 값으로 되돌립니다. 이후에 다른 변경이 있으면 실행하지 않습니다.</p><Notice>되돌리기도 새 변경 기록으로 남습니다.</Notice>{record.kind === 'irreversible' && record.reason && <Notice tone="danger">{record.reason}</Notice>}<HistoryMutationError error={error} reload={() => { close(); reload(); }}/><div class="footer-actions"><button class="btn" type="button" disabled={busy} onClick={close}>취소</button><button class="btn pri" disabled={busy || Boolean(error) || !canRevert(record)}>되돌리기 실행</button></div></form></ManagementDialog>;
}
function HistoryDetail({ id, refresh }) {
  const resource = useAdminData(`/api/admin/history/${encodeURIComponent(id)}`), [dialog, setDialog] = useState(false), [saved, setSaved] = useState(null);
  const row = resource.data;
  if (resource.loading) return <Loading/>;
  if (resource.error) return <LoadError error={resource.error} retry={resource.reload}/>;
  const detail = row.detail || {}, before = detail.before ?? row.before, after = detail.after ?? row.after;
  const additional = Object.fromEntries(Object.entries(detail).filter(([key]) => !['before', 'after', 'steps', 'recovery', 'notice', 'reason', 'cleanupPending', 'skipped'].includes(key)));
  return <><div class="detail-head"><div><h2>{row.summary}</h2><p>{row.target}</p></div>{canRevert(row) ? <span class="chip plain">되돌리기 가능</span> : row.kind === 'irreversible' ? <span class="chip danger">복구 불가</span> : null}</div><dl class="kv"><dt>변경한 사람</dt><dd>{row.actor}</dd><dt>시각</dt><dd><time dateTime={row.ts}>{kst(row.ts)}</time></dd><dt>처리 결과</dt><dd>{resultLabel(row.result)} {row.code}</dd></dl><section class="detail-section"><h3>변경 전후</h3><div class="log-diff"><div><small>변경 전</small><pre>{display(before)}</pre></div><div><small>변경 후</small><pre>{display(after)}</pre></div></div></section><HistoryOutcome value={row}/>{Object.keys(additional).length > 0 && <section class="detail-section"><h3>처리 내용</h3><pre>{display(additional)}</pre></section>}{row.kind === 'irreversible' && <Notice tone="danger"><strong>이 변경은 되돌릴 수 없어요.</strong></Notice>}{!canRevert(row) && row.revertReason && <Notice tone="warn">{row.revertReason}</Notice>}{canRevert(row) && <><Notice><strong>이 변경을 되돌릴 수 있습니다.</strong><p>현재 값이 기록의 변경 후와 같을 때만 되돌립니다. 다른 사람이 수정했다면 멈추고 안내합니다.</p></Notice><button class="btn pri" disabled={Boolean(saved)} onClick={() => setDialog(true)}>이 변경 되돌리기</button></>}<p class="hint">인증 암호·세션·키는 기록하지 않습니다.</p>{row.revertOf && <p><a href={`#history/${encodeURIComponent(row.revertOf)}`}>원래 변경 기록</a></p>}{saved && <><Notice>{saved.result === 'partial' ? '일부 작업만 완료됐어요.' : '이전 설정으로 되돌렸어요. 새 변경 기록을 남겼습니다.'}</Notice><HistoryOutcome value={{ ...saved, action: row.action }}/>{(saved.id || saved.auditId) && <p><a href={`#history/${encodeURIComponent(saved.id || saved.auditId)}`}>되돌리기 변경 기록</a></p>}</>}{dialog && <RevertDialog record={row} close={() => setDialog(false)} reload={resource.reload} onSaved={result => { setSaved(result); setDialog(false); resource.reload(); refresh(); }}/>}</>;
}
export default function History({ id }) {
  const [filter, setFilter] = useState('all'), [page, setPage] = useState(1);
  const list = useAdminData(`/api/admin/history?${new URLSearchParams({ filter, page })}`), cached = useRef(null);
  if (list.data) cached.current = list.data;
  const data = list.data || cached.current, selected = id || data?.items[0]?.id;
  return <div class="management history-page" data-admin-page="history"><div class="page-head"><div><h1>변경 기록</h1><p>누가 무엇을 바꿨는지, 바꾸기 전후를 확인합니다.</p></div></div><div class={`account-split ${id ? 'detail-open' : ''}`}><section class="list-pane" aria-label="변경 기록 목록"><div class="list-tools"><select aria-label="기록 유형 필터" value={filter} onChange={event => { setFilter(event.currentTarget.value); setPage(1); }}><option value="all">전체 변경</option><option value="revertible">되돌리기 가능</option><option value="irreversible">복구 불가</option></select></div>{list.loading ? <Loading/> : list.error ? <LoadError error={list.error} retry={list.reload}/> : <><div class="list-meta">{data.total}건</div>{data.damaged?.count > 0 && <Notice tone="warn">읽지 못한 변경 기록이 {data.damaged.count}줄 있습니다.</Notice>}{data.items.length ? data.items.map(row => <a class={`account-item ${row.id === selected ? 'selected' : ''}`} href={`#history/${encodeURIComponent(row.id)}`} key={row.id}><span class="body"><b>{row.summary}</b><span class="email">{row.target}</span><small>{kst(row.ts)}</small>{canRevert(row) ? <span class="chip plain">되돌리기 가능</span> : row.kind === 'irreversible' ? <span class="chip danger">복구 불가</span> : row.revertReason ? <small class="email">{row.revertReason}</small> : null}</span></a>) : <Empty>변경 기록이 없습니다.</Empty>}<div class="account-pages"><button class="btn" disabled={page === 1} onClick={() => setPage(page - 1)}>이전 쪽</button><span>{page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}</span><button class="btn" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>다음 쪽</button></div></>}</section><section class="account-detail" aria-label="변경 기록 상세"><a class="btn ghost mobile-back" href="#history">← 목록으로</a>{selected ? <HistoryDetail key={selected} id={selected} refresh={list.reload}/> : <Empty>항목을 선택해 주세요.</Empty>}</section></div></div>;
}
