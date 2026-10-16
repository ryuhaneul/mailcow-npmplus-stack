import { useState } from 'preact/hooks';
import { useAdminData } from '../hooks/useAdminData.js';
import { accountFilters, accountKind, accountState } from './accounts.js';
import { bytes } from './status.js';
import Loading from '../components/Loading.jsx';
import LoadError from '../components/LoadError.jsx';
import Empty from '../components/Empty.jsx';
import AccountDetail from './AccountDetail.jsx';
export default function Accounts({ address }) {
  const [kind, setKind] = useState('all'), [q, setQ] = useState(''), [page, setPage] = useState(1);
  const result = useAdminData(`/api/admin/mailboxes?${new URLSearchParams({ kind, q, page })}`), data = result.data;
  const selected = address || data?.items[0]?.address;
  return <div data-admin-page="accounts"><div class="page-head"><div><h1>계정</h1><p>메일함과 연결된 팀·별칭·권한을 함께 관리합니다.</p></div><div class="actions"><a class="btn" href="#flow/csv">CSV 일괄</a><a class="btn pri" href="#flow/join">메일함 만들기</a></div></div><div class={`account-split ${address ? 'detail-open' : ''}`}><section class="list-pane" aria-label="계정 목록"><div class="list-tools"><input class="search" aria-label="메일함 이름 또는 주소 검색" placeholder="이름 또는 메일 주소 검색" value={q} onInput={event => { setQ(event.currentTarget.value); setPage(1); }}/><div class="filters">{accountFilters.map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setPage(1); }}>{label}</button>)}</div></div>
    {result.loading ? <Loading/> : result.error ? <LoadError error={result.error} retry={result.reload}/> : <><div class="list-meta"><span>메일함 {data.total}개</span><span>주소순</span></div>{data.items.length ? data.items.map(row => <a class={`account-item ${selected === row.address ? 'selected' : ''}`} href={`#accounts/${encodeURIComponent(row.address)}`} key={row.address}><span class="pic">{(row.name || row.address).slice(0, 1)}</span><span class="body"><span class="row"><b>{row.name || row.address}</b>{row.active !== 1 && <span class="chip">{accountState(row.active)}</span>}</span><span class="email">{row.address}</span><span class="row"><span class="chip">{accountKind(row.kind)}</span><span class="sub num">{bytes(row.usedBytes)} / {row.quotaGb} GB</span></span></span></a>) : <Empty>일치하는 메일함이 없습니다. 검색어나 필터를 바꿔 보세요.</Empty>}<div class="account-pages"><button class="btn" disabled={page === 1} onClick={() => setPage(page - 1)}>이전 쪽</button><span>{page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}</span><button class="btn" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>다음 쪽</button></div></>}
    </section><section class="account-detail" aria-label="선택 계정 상세">{selected ? <AccountDetail key={selected} address={selected} changed={result.reload}/> : <Empty>메일함을 선택해 주세요.</Empty>}</section></div></div>;
}
