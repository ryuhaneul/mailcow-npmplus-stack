export default function RulePreview({ data, pending, error, problem }) {
  return <aside class="preview" aria-label="규칙 미리보기" aria-live="polite" aria-busy={pending}>
    <header><small><span class="live"/>받은편지함 · 최근 1년</small><p>{pending ? '지금 조건으로 세는 중이에요.' : data ? <><b class="num">{data.count.toLocaleString()}</b>통 · 지금 조건에 맞는 메일</> : '조건과 동작을 입력해 주세요.'}</p></header>
    <ul class="pv">{error ? <li class="none">{error.message}</li> : problem ? <li class="none">{problem}</li> : !pending && data?.count === 0 ? <li class="none">지금 조건에 맞는 메일이 없습니다. 조건을 넓혀 보세요.</li> : data?.items.map(item => <li key={item.ref}><span class="pf">{item.from.name || item.from.address}</span><span class="pd num">{new Date(item.date).toLocaleDateString('ko-KR', {month:'numeric',day:'numeric'})}</span><span class="ps">{item.subject || '(제목 없음)'}</span></li>)}</ul>
    <footer>{data?.limited && <p class="preview-limit">최근 20,000통까지만 확인했어요. 더 오래된 메일은 이 수와 적용 대상에 포함되지 않아요.</p>}{data && !pending ? <>{data.scanned.toLocaleString()}통 확인 · 최신 20통까지 표시<br/></> : null}조건을 바꾸면 바로 다시 셉니다.</footer>
  </aside>;
}
