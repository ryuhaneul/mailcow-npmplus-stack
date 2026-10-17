import { useEffect, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
import Notice from './Notice.jsx';
export default function RecordNotice({ steps = [] }) {
  const [records, setRecords] = useState([]), ids = [...new Set(steps.map(step => step.auditId).filter(Boolean))].join(',');
  useEffect(() => { const controller = new AbortController(); setRecords([]); if (ids) Promise.all(ids.split(',').map(id => adminApi(`/api/admin/history/${encodeURIComponent(id)}`, { signal: controller.signal }).catch(() => null))).then(rows => { if (!controller.signal.aborted) setRecords(rows.filter(row => row?.revertible === true && row.canRevert === true)); }); return () => controller.abort(); }, [ids]);
  return <Notice>변경 기록에서 완료 단계와 결과를 확인할 수 있습니다.{records.map(row => <p key={row.id}><a href="#history">{row.target} 설정은 변경 기록에서 되돌릴 수 있습니다.</a></p>)}</Notice>;
}
