// Each callback changes one field; the parent preserves every other draft value.
export default function SignatureDefaults({ identities, items, defaults, busy = false, onChange, onEdit }) {
  function choice(address, field, label) {
    return <label><span>{label}</span><select class="dd" aria-label={`${address} ${label}`} value={defaults[address]?.[field] ?? ''} disabled={busy} onChange={event => onChange(address, field, event.currentTarget.value || null)}>
      <option value="">없음</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>;
  }
  return <>
    <div class="sig-heading"><div><h2>주소별 기본 서명</h2><p>새 메일과 답장·전달에 넣을 서명을 따로 골라요.</p></div></div>
    <div class="defaults-note">서명 내용은 <a href="#" onClick={event => { event.preventDefault(); onEdit(); }}>서명 편집</a>에서 고쳐요. ‘없음’을 고르면 자동으로 넣지 않아요.</div>
    <div class="defaults-table">
      <div class="defaults-table-head" aria-hidden="true"><span>보낸 사람 주소</span><span>새 메일 기본 서명</span><span>답장·전달 기본 서명</span></div>
      {identities.map(({ address }) => <section class="default-row" key={address}><h3>{address}</h3>{choice(address, 'newDefault', '새 메일 기본 서명')}{choice(address, 'replyDefault', '답장·전달 기본 서명')}</section>)}
    </div>
    <p class="default-help">작성창에서도 서명을 다른 것으로 바꾸거나 뺄 수 있어요.</p>
  </>;
}
