import { storage } from '../state/storage.js';
import { quotaView } from '../format.js';
export default function MobileQuota() {
  const q = quotaView(storage.value);
  if (!q) return null;
  return <a class="mquota" data-level={q.level} href="#storage" aria-label="저장 공간">
    <span class="mq-t"><b class="num">{q.used}</b> / {q.limit} · <b class="num lv">{q.percent}%</b></span>
    <span class="bar" aria-hidden="true"><span style={{width:`${Math.min(100,q.percent)}%`}}/></span>
    {q.message && <span class="mq-w">{q.level === 'crit' ? '95% 넘음' : '80% 넘음'}</span>}
  </a>;
}
