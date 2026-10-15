import { storage } from '../state/storage.js';
import { quotaView } from '../format.js';
export default function QuotaMeter() {
  const q = quotaView(storage.value);
  if (!q) return null;
  return <div class="quota" data-level={q.level}>
    <div class="row"><span><b class="num">{q.used}</b> / {q.limit}</span><span class="num lv">{q.percent}%</span></div>
    <div class="bar" role="meter" aria-valuenow={Math.min(100,q.percent)} aria-valuemin="0" aria-valuemax="100" aria-label="저장 공간 사용률"><span style={{width: `${Math.min(100,q.percent)}%`}}/></div>
    <p class="msg">{q.message}</p>
    <div class="row"><span class="num">{q.left}</span><a href="#storage">관리</a></div>
  </div>;
}
