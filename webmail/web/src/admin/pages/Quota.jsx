import QuotaNotifications, { QuotaNotificationStatus } from '../components/QuotaNotifications.jsx';
import { useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { useAdminData } from '../hooks/useAdminData.js';
import { accountKind } from './accounts.js';
import { quotaRows, saveQuota } from './quota.js';
import QuotaUsage from '../components/QuotaUsage.jsx';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import Notice from '../components/Notice.jsx';
import './quota.css';
function QuotaRow({ row, status, reload, saved }) {
  const [editing, setEditing] = useState(false), [value, setValue] = useState(String(row.quotaGb)), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  async function submit(event) {
    event.preventDefault(); if (busy || error?.status === 409) return;
    setBusy(true); setError(null);
    try { await saveQuota(row, value, adminApi); saved(row.address); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  return <li class="quota-item" data-quota-address={row.address}><div class="quota-identity"><a href={`#accounts/${encodeURIComponent(row.address)}`}><b>{row.name || row.address}</b><span>{row.address}</span></a><span class="chip">{accountKind(row.kind)}</span></div><div><QuotaUsage row={row}/><QuotaNotificationStatus status={status}/></div><div class="quota-edit">{editing ? <form onSubmit={submit} noValidate><label class="field">한도 (GB)<input type="number" step="any" min="0.0009765625" aria-label={`${row.address} 한도 (GB)`} value={value} disabled={busy || error?.status === 409} onInput={event => setValue(event.currentTarget.value)}/></label><div class="actions"><button class="btn pri" type="submit" disabled={busy || error?.status === 409}>{busy ? '저장 중…' : '저장'}</button><button class="btn" type="button" disabled={busy} onClick={() => { setEditing(false); setError(null); setValue(String(row.quotaGb)); }}>취소</button></div></form> : <button class="btn" type="button" aria-label={`${row.address} 한도 수정`} onClick={() => setEditing(true)}>한도 수정</button>}{error && <Notice tone="danger"><p role="alert">{error.status === 409 ? '다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.' : error.message}</p>{error.status === 409 && <button class="btn" type="button" onClick={reload}>현재 값 다시 읽기</button>}</Notice>}</div></li>;
}
export default function Quota() {
  const notifications = useAdminData('/api/admin/quota/notifications');
  const result = useAdminData('/api/admin/quota'), [q, setQ] = useState(''), [sort, setSort] = useState('percent'), [notice, setNotice] = useState('');
  const rows = quotaRows(result.data?.items ?? [], { q, sort });
  return <div data-admin-page="quota"><div class="page-head"><div><h1>쿼터</h1><p>전체 메일함의 사용량을 확인하고 용량 한도를 조정합니다.</p></div><div class="actions"><button class="btn" type="button" disabled={result.loading} onClick={() => { result.reload(); notifications.reload(); }}>새로고침</button></div></div><div class="content quota-content"><QuotaNotifications resource={notifications}/><div class="quota-tools"><label class="field">계정 검색<input class="search" type="search" placeholder="이름 또는 메일 주소 검색" value={q} onInput={event => setQ(event.currentTarget.value)}/></label><div class="field"><label for="quota-sort">정렬</label><select id="quota-sort" value={sort} onChange={event => setSort(event.currentTarget.value)}><option value="percent">사용률 높은 순</option><option value="used">사용량 많은 순</option><option value="name">이름순</option></select></div></div><p class="hint">80% 이상 주의 · 90% 이상 위험. 무제한 메일함은 사용률과 강조에서 제외합니다. 한도는 0보다 큰 GB 값으로 저장합니다.</p>{notice && <Notice><p role="status">{notice}</p></Notice>}{result.loading ? <Loading/> : result.error ? <LoadError error={result.error} retry={result.reload}/> : <><p class="list-meta">전체 {result.data.items.length}개 중 {rows.length}개</p>{!rows.length ? <Empty>일치하는 메일함이 없습니다. 검색어를 바꿔 보세요.</Empty> : <ul class="quota-list" aria-label="쿼터 목록">{rows.map(row => <QuotaRow key={`${row.address}:${row.etag}`} row={row} status={notifications.data?.state.accounts[row.address]} reload={result.reload} saved={address => { setNotice(`${address} 용량 한도를 저장했습니다.`); result.reload(); }}/>)}</ul>}</>}</div></div>;
}
