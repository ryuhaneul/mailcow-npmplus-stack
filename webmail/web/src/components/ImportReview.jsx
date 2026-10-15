import RuleList from './RuleList.jsx';

export default function ImportReview({ report, pending, busy, onConfirm }) {
  return <section class="import-review" aria-labelledby="import-title"><h2 id="import-title">기존 필터 가져오기</h2>
    <p>{pending ? '아래 규칙과 달라지는 동작을 확인해 주세요. 가져와서 켜면 기존 필터는 꺼지고 원본은 보관돼요.' : '아래 변환 결과와 옮길 수 없는 항목을 확인해 주세요.'}</p>
    <RuleList rules={report.rules ?? []}/>
    <ul class="import-items" aria-label="변환 결과">{report.items.map(item => <li key={item.n}>
      <b>{item.n}. {item.summary}</b><span>{({same: '그대로 가져와요', changed: '동작이 달라져요', unconvertible: '옮길 수 없어요'})[item.status]}</span>
      {(item.changes ?? []).map((change, i) => <p key={i}>{change}</p>)}{item.reason && <p>{item.reason}</p>}
    </li>)}</ul>
    {pending && <button class="btn pri" type="button" disabled={busy} onClick={onConfirm}>가져와서 켜기</button>}
  </section>;
}
