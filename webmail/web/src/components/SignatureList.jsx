import Icon from './Icon.jsx';

// Controlled list: the parent owns drafts, selection and CRUD dialogs.
export default function SignatureList({ items, selectedId, busy = false, onSelect, onCreate, onRename, onCopy, onDelete }) {
  const selected = items.find(item => item.id === selectedId);
  return <>
    <section class="signature-list" aria-label="내 서명">
      <div class="list-heading"><h3>내 서명 <span>{items.length}</span></h3><button type="button" class="btn" disabled={busy} onClick={() => onCreate()}><Icon name="plus" size="s"/>새 서명</button></div>
      <div class="signature-items" role="group" aria-label="편집할 서명">
        {items.map(item => <button type="button" key={item.id} aria-pressed={item.id === selectedId} disabled={busy} onClick={() => onSelect(item.id)}><Icon name="pen" size="s"/><span>{item.name}</span>{item.id === selectedId && <Icon name="check" size="s"/>}</button>)}
        {!items.length && <p>아직 서명이 없어요. 새 서명을 만들어 주세요.</p>}
      </div>
    </section>
    {selected && <div class="signature-actions"><span>선택한 서명 · <b>{selected.name}</b></span><div>
      <button type="button" disabled={busy} onClick={() => onRename(selected.id)}>이름 바꾸기</button>
      <button type="button" disabled={busy} onClick={() => onCopy(selected.id)}>복제</button>
      <button type="button" class="danger-link" disabled={busy} onClick={() => onDelete(selected.id)}>삭제</button>
    </div></div>}
  </>;
}
