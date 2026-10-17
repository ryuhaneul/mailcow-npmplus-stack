import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import { adminSession } from '../state/session.js';
import ManagementPage from '../components/ManagementPage.jsx';
import Notice from '../components/Notice.jsx';
import { CleanEditor, QuotaDiff } from '../flows/Clean.jsx';
import './cleanup.css';

function QuotaRecheck({ mailbox }) {
  const [result, setResult] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false), [disabled, setDisabled] = useState(false);
  const alive = useRef(true), pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function recheck() {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); setError(null); setResult(null);
    try {
      const value = await adminApi('/api/admin/quota-recheck', { method: 'POST', body: { mailbox } });
      if (alive.current) setResult(value);
    } catch (failure) { if (alive.current) { setError(failure); if (failure.code === 'CLEANUP_DISABLED') setDisabled(true); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <section class="detail-section cleanup-quota"><div class="section-title"><h3>용량 재확인</h3><button class="btn" disabled={busy || disabled} onClick={recheck}>{busy ? '처리 중…' : '용량 재확인'}</button></div><p class="hint">메일함의 실제 사용량을 다시 계산해 표시합니다.</p>{error && <Notice tone="danger"><p role="alert" data-error-code={error.code}>{error.message}</p></Notice>}{result && <div aria-live="polite"><QuotaDiff value={result}/><Notice>변경 기록에서 완료 단계와 결과를 확인할 수 있습니다. <a href="#history">변경 기록</a></Notice></div>}</section>;
}
export default function Cleanup({ address }) {
  if (adminSession.value?.features?.cleanup !== true) return <div class="content"><Notice>메일 정리와 용량 재확인이 꺼져 있어요.</Notice></div>;
  return <ManagementPage title="메일 정리" description="개수를 먼저 확인한 뒤, 선택한 범위의 메일만 지웁니다." resource="mailboxes" hash="cleanup" address={address}>{({ data, address }) => {
    const row = data.items.find(value => value.address === address);
    return row ? <div key={row.address} class="cleanup-detail"><div class="detail-head"><div><h2>{row.name || row.address}</h2><p>{row.address}</p></div><span class="chip plain">{row.kind === 'team' ? '팀' : row.kind === 'admin' ? '관리' : '개인'}</span></div><CleanEditor key={`clean:${row.address}`} mailbox={row.address}/><QuotaRecheck key={`quota:${row.address}`} mailbox={row.address}/></div> : <Notice>이 쪽에 메일함이 없어요. 검색어나 쪽을 바꿔 주세요.</Notice>;
  }}</ManagementPage>;
}
