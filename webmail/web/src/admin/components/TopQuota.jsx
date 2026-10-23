import { useAdminData } from '../hooks/useAdminData.js';
import { topQuota } from '../pages/quota.js';
import { accountKind } from '../pages/accounts.js';
import QuotaUsage from './QuotaUsage.jsx';
import Loading from './Loading.jsx';
import LoadError from './LoadError.jsx';
import Empty from './Empty.jsx';
import '../pages/quota.css';
export default function TopQuota() {
  const result = useAdminData('/api/admin/quota'), rows = topQuota(result.data?.items ?? []);
  return <section class="top-quota" aria-labelledby="top-quota-title"><div class="section-title"><h2 id="top-quota-title">쿼터 사용률 상위 5</h2><a class="btn ghost" href="#quota">쿼터 관리</a></div>{result.loading ? <Loading/> : result.error ? <LoadError error={result.error} retry={result.reload}/> : !rows.length ? <Empty>사용률을 계산할 메일함이 없습니다.</Empty> : <div class="quota-top-list">{rows.map(row => <a class="quota-top-item" key={row.address} href={`#accounts/${encodeURIComponent(row.address)}`}><div class="quota-identity"><b>{row.name || row.address}</b><span>{row.address}</span><span class="chip">{accountKind(row.kind)}</span></div><QuotaUsage row={row}/></a>)}</div>}<p class="hint">무제한 메일함은 사용률 순위에서 제외합니다.</p></section>;
}
