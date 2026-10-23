import { quotaPercent, quotaTone } from '../pages/quota.js';
import { bytes } from '../pages/status.js';
export default function QuotaUsage({ row }) {
  const percent = quotaPercent(row), tone = quotaTone(row);
  return <div class={`quota-usage ${tone}`}><span class="num">{bytes(row.usedBytes)} / {row.quotaGb > 0 ? `${row.quotaGb} GB` : '무제한'}</span><span class={`chip ${tone}`}>{percent === null ? '무제한' : `${percent.toFixed(1)}%`}{tone === 'danger' ? ' · 위험' : tone === 'warn' ? ' · 주의' : ''}</span>{percent !== null && <meter min="0" max="100" value={Math.min(percent, 100)} aria-label={`${row.address} 쿼터 사용률`} aria-valuetext={`${percent.toFixed(1)}%`}/>}</div>;
}
