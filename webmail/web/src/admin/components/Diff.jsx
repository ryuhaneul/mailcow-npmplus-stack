export default function Diff({ rows }) {
  return <div class="table-wrap"><table class="ac-diff"><thead><tr><th>바뀌는 항목</th><th>변경 전</th><th>변경 후</th></tr></thead><tbody>{rows.map(([name, before, after], index) => <tr key={index}><td>{name}</td><td>{before}</td><td>{after}</td></tr>)}</tbody></table></div>;
}
