import { useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { useAdminData } from '../hooks/useAdminData.js';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import ManagementDialog from '../components/ManagementDialog.jsx';
import Diff from '../components/Diff.jsx';
import RecordNotice from '../components/RecordNotice.jsx';
import { hasMoveRedirect } from './filter-script.js';
import './filters.css';

const filterPath = address => `/api/admin/filters/${encodeURIComponent(address)}`;
const filterHash = (address = '', tab = 'admin') => `#filters/${encodeURIComponent(address)}/${tab}`;
function FilterTabs({ address, tab, mobile = false }) {
  return <div class={`filters filter-tabs ${mobile ? 'filter-tabs-mobile' : ''}`}>{[['admin','관리자 필터'],['user','사용자 필터'],['checks','필터 점검']].map(([key,label]) => <a key={key} href={filterHash(address, key)} aria-current={tab === key ? 'page' : undefined}>{label}</a>)}</div>;
}
function FilterError({ error, reload }) {
  if (!error) return null;
  return <Notice tone="danger"><p role="alert" data-error-code={error.code}>{error.status === 409 && error.code !== 'FILTER_EXISTS' ? '다른 곳에서 바뀌었어요' : error.message}</p>{error.status === 409 && <button class="btn" type="button" onClick={reload}>다시 읽기</button>}</Notice>;
}
function FilterEditor({ address, row, reload, saved }) {
  const [script, setScript] = useState(row?.script || ''), [type, setType] = useState('prefilter'), [preset, setPreset] = useState('custom');
  const [review, setReview] = useState(false), [moveWarning, setMoveWarning] = useState(false), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const source = !row && preset === 'discard' ? 'discard;\n' : script;
  function preview(event) { event.preventDefault(); if (busy || error?.status === 409) return; setError(null); setConfirmed(false); setMoveWarning(hasMoveRedirect(source)); setReview(true); }
  async function save() {
    if (busy || error?.status === 409 || moveWarning && !confirmed) return;
    setBusy(true); setError(null);
    try {
      const body = row ? { etag: row.etag, script: source } : { type, preset, ...(preset === 'custom' ? { script: source } : {}) };
      if (moveWarning && confirmed) body.confirmMove = true;
      const result = await adminApi(`${filterPath(address)}${row ? `/${encodeURIComponent(row.id)}` : ''}`, { method: row ? 'PUT' : 'POST', body });
      setReview(false); saved(result); reload();
    } catch (failure) { setError(failure); if (failure.code === 'MOVE_CONFIRM') { setMoveWarning(true); setConfirmed(false); } }
    finally { setBusy(false); }
  }
  return <form onSubmit={preview}><fieldset class="flow-fields" disabled={busy}>
    {row ? <dl class="kv"><dt>필터 위치</dt><dd>{row.type} · {row.active ? '활성' : '꺼짐'}</dd><dt>설명</dt><dd>{row.description}</dd></dl> : <div class="form-grid"><div class="field"><label for="filter-position">필터 위치</label><select id="filter-position" value={type} onChange={event => setType(event.currentTarget.value)}><option>prefilter</option><option>postfilter</option></select></div><div class="field"><label for="filter-preset">새 필터</label><select id="filter-preset" value={preset} onChange={event => setPreset(event.currentTarget.value)}><option value="custom">직접 편집</option><option value="discard">메일 버리기 (discard)</option></select></div></div>}
    <div class="field"><label for="admin-script">Sieve 스크립트</label><textarea id="admin-script" rows="12" spellcheck={false} value={source} readOnly={!row && preset === 'discard'} onInput={event => { setScript(event.currentTarget.value); if (error?.status !== 409) setError(null); }}/></div>
    {hasMoveRedirect(source) && <Notice tone="warn"><strong>:copy 없는 redirect는 메일을 옮깁니다.</strong><p>추가 규칙은 옮기기 줄 위에만 넣으세요. 뒤의 사용자·postfilter·스팸 분류가 실행되지 않습니다.</p></Notice>}
    {!review && <FilterError error={error} reload={reload}/>}<div class="footer-actions"><button class="btn pri" disabled={busy || error?.status === 409 || !!row && source === row.script}>차이 미리보기·저장</button></div>
    </fieldset>{review && <ManagementDialog title={moveWarning ? '옮기기 방식으로 바꾸기' : '관리자 필터 변경 미리보기'} busy={busy} close={() => setReview(false)}><Diff rows={[[ '위치', row?.type || '없음', row?.type || type ],['스크립트', <pre>{row?.script || '없음'}</pre>, <pre>{source}</pre>]]}/>{!row && <Notice tone="warn">새 관리자 필터 만들기는 이 도구로 되돌릴 수 없습니다.</Notice>}{moveWarning && <><Notice tone="warn"><strong>:copy가 없으면 뒤의 필터가 실행되지 않습니다.</strong><p>사용자 필터·스팸 분류가 모두 건너뛰어집니다. 팀 메일 원본도 남지 않습니다. 추가 규칙은 옮기기 줄 위에만 배치해야 합니다.</p></Notice><label class="checkline"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.currentTarget.checked)}/>원본 보관과 뒤의 필터 실행이 중단되는 것을 확인했습니다.</label></>}<FilterError error={error} reload={reload}/><div class="footer-actions"><button class="btn" type="button" disabled={busy} onClick={() => setReview(false)}>{moveWarning ? '복사 분배 유지' : '취소'}</button><button class="btn pri" type="button" disabled={busy || moveWarning && !confirmed || error?.status === 409} onClick={save}>{busy ? '저장 중…' : '저장'}</button></div></ManagementDialog>}</form>;
}
function AdminFilters({ address }) {
  const result = useAdminData(filterPath(address)), [selected, setSelected] = useState(null), [saved, setSaved] = useState(null);
  if (result.loading) return <Loading/>;
  if (result.error) return <LoadError error={result.error} retry={result.reload}/>;
  const row = selected === 'new' ? null : result.data.items.find(item => item.id === selected) || result.data.items[0];
  function reload() { result.reload(); }
  return <><div class="section-title"><h2>관리자 필터</h2><button class="btn" onClick={() => { setSelected('new'); setSaved(null); }}>새로 만들기</button></div>{result.data.items.length > 0 && <div class="field"><label for="filter-select">관리자 필터 선택</label><select id="filter-select" value={selected === 'new' ? 'new' : row.id} onChange={event => { setSelected(event.currentTarget.value); setSaved(null); }}>{result.data.items.map(item => <option key={item.id} value={item.id}>{item.type} · {item.description} · {item.active ? '활성' : '꺼짐'} · #{item.id}</option>)}{selected === 'new' && <option value="new">새로 만들기</option>}</select></div>}{!result.data.items.length && <Notice>관리자 필터가 없습니다. 새 필터를 만들 수 있습니다.</Notice>}{saved && <div role="status"><Notice>{saved.unchanged ? '바뀐 내용이 없어요.' : '관리자 필터를 저장했습니다.'}{saved.detail?.reason && <p>{saved.detail.reason}</p>}</Notice>{saved.auditId && <><RecordNotice steps={[{ auditId: saved.auditId }]}/><a class="link" href="#history">변경 기록</a></>}</div>}<FilterEditor key={`${row?.id || 'new'}:${row?.etag || ''}`} row={row} address={address} reload={reload} saved={value => { setSaved(value); setSelected(value.id); }}/></>;
}
function UserFilter({ address }) {
  const result = useAdminData(`/api/admin/user-filters/${encodeURIComponent(address)}`);
  if (result.loading) return <Loading/>;
  if (result.error) return <LoadError error={result.error} retry={result.reload}/>;
  return <><div class="section-title"><h2>사용자 필터</h2><span class="chip">읽기 전용</span></div><dl class="kv"><dt>활성 스크립트</dt><dd>{result.data.activeName || '없음'}</dd></dl>{result.data.script !== null ? <div class="field"><label for="user-script">활성 필터 내용</label><textarea id="user-script" readOnly rows="12" value={result.data.script}/></div> : <Empty>활성 사용자 필터가 없습니다.</Empty>}<Notice>사용자 필터는 읽기만 가능합니다. 메일이 받은편지함에 없는 이유를 조사할 때 확인하세요. 내려받기와 편집은 제공하지 않습니다.</Notice></>;
}
function FilterChecks() {
  const result = useAdminData('/api/admin/checks/filters');
  if (result.loading) return <Loading/>;
  if (result.error) return <LoadError error={result.error} retry={result.reload}/>;
  const data = result.data;
  return <><div class="section-title"><h2>필터 점검</h2><button class="btn" onClick={result.reload}>다시 점검</button></div><p>{data.total}개 중 {data.checked}개 확인</p><h3>계정을 선택하면 활성 사용자 필터를 읽기 전용으로 엽니다.</h3>{[['external','외부 전달'],['nonWebmail','웹메일 규칙이 아님'],['uninspectable','해석 불가'],['failed','점검 실패']].map(([key,label]) => <section class="detail-section" key={key}><h3>{label} · {data[key].length}개</h3>{data[key].map(row => <div class="mini-row" key={row.address}><div><a class="link" href={filterHash(row.address, 'user')}>{row.address}</a><p class="hint">{row.activeName || row.code || (row.targets ? `외부 대상 ${row.targets.length}개 발견 (대상 주소 가림)` : '')}</p></div><a class="btn" href={`#accounts/${encodeURIComponent(row.address)}`}>계정 보기</a></div>)}</section>)}<section class="detail-section"><h3>전역 실행 순서</h3><ol>{[...data.globalOrder].sort((a,b) => a.order-b.order).map(row => <li key={row.order}>{row.type}{row.script !== undefined && <pre>{row.script || '없음'}</pre>}</li>)}</ol></section><Notice tone="warn">:copy 없는 옮기기 뒤에는 사용자·postfilter·스팸 분류가 실행되지 않습니다. 전역 필터는 여기서 편집하지 않습니다.</Notice></>;
}
export default function Filters({ address = '', tab = 'admin' }) {
  const [q, setQ] = useState(''), [page, setPage] = useState(1), result = useAdminData(`/api/admin/mailboxes?${new URLSearchParams({ kind: 'all', q, page })}`);
  const selected = address || result.data?.items[0]?.address, activeTab = ['admin','user','checks'].includes(tab) ? tab : 'admin';
  return <div class="management admin-filters" data-admin-page="filters"><div class="page-head"><div><h1>필터</h1><p>메일함을 고른 뒤 관리자 편집·사용자 읽기·점검을 엽니다.</p></div></div><div class={`account-split ${address || activeTab === 'checks' ? 'detail-open' : ''}`}><section class="list-pane" aria-label="필터 대상 메일함 선택"><div class="list-tools"><input class="search" aria-label="필터 대상 메일함 이름 또는 주소 검색" placeholder="이름 또는 메일 주소 검색" value={q} onInput={event => { setQ(event.currentTarget.value); setPage(1); }}/><FilterTabs address={selected} tab={activeTab}/></div><div class="list-meta">필터 대상 메일함 선택</div>{result.loading ? <Loading/> : result.error ? <LoadError error={result.error} retry={result.reload}/> : <>{result.data.items.length ? result.data.items.map(row => <a key={row.address} class={`account-item ${selected === row.address ? 'selected' : ''}`} href={filterHash(row.address, activeTab === 'checks' ? 'user' : activeTab)}><span class="pic">{(row.name || row.address).slice(0,1)}</span><span class="body"><b>{row.name || row.address}</b><span class="email">{row.address}</span></span></a>) : <Empty>일치하는 메일함이 없습니다.</Empty>}<div class="account-pages"><button class="btn" disabled={page === 1} onClick={() => setPage(page - 1)}>이전 쪽</button><span>{page} / {Math.max(1,Math.ceil(result.data.total / result.data.pageSize))}</span><button class="btn" disabled={page * result.data.pageSize >= result.data.total} onClick={() => setPage(page + 1)}>다음 쪽</button></div></>}</section><section class="account-detail" aria-label="선택 메일함 필터"><a class="btn ghost mobile-back" href="#filters">← 목록으로</a><FilterTabs address={selected} tab={activeTab} mobile/>{activeTab === 'checks' ? <FilterChecks/> : selected ? <><div class="detail-head"><div><h2>{selected}</h2><p>{activeTab === 'user' ? '읽기 전용' : '직접 편집'}</p></div></div>{activeTab === 'user' ? <UserFilter key={selected} address={selected}/> : <AdminFilters key={selected} address={selected}/>}</> : <Empty>메일함을 선택해 주세요.</Empty>}</section></div></div>;
}
