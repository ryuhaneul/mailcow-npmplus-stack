import { referenceSections, referenceRow } from '../pages/accounts.js';
import Empty from './Empty.jsx';
export default function AccountRefs({ refs = {}, preview = false }) {
  return <div class="account-refs">{referenceSections.map(([kind, label, link, action]) => <section class="detail-section" key={kind}><div class="section-title"><h3>{label}</h3><a class="btn ghost" href={`#${link}`}>{action}</a></div>{refs[kind]?.length ? <div class="table-wrap"><table aria-label={label}><thead><tr><th>주소 · 항목</th><th>연결 대상</th><th>{preview ? '영향 · 현재 상태' : '현재 상태'}</th></tr></thead><tbody>{refs[kind].map((row, index) => <tr key={index}>{referenceRow(kind, row).map((value, cell) => <td key={cell}>{value}</td>)}</tr>)}</tbody></table></div> : <Empty>연결된 항목이 없어요.</Empty>}</section>)}</div>;
}
