import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { session } from '../state/session.js';
import { getTemplateShare, putTemplateShare, addTemplateShareUser } from '../templates/api.js';
import Icon from './Icon.jsx';
import RecipientInput from './RecipientInput.jsx';

export default function TemplateShareDialog({ templates, returnFocusRef, onClose, onSaved }) {
  const dialog = useRef(null), input = useRef(null), close = useRef(null), pending = useRef(false), live = useRef(true), id = useId();
  const [data, setData] = useState(null), [domainAll, setDomainAll] = useState(false), [users, setUsers] = useState([]), [person, setPerson] = useState(''), [error, setError] = useState(null), [busy, setBusy] = useState('load'), [revision, setRevision] = useState(0);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useLayoutEffect(() => {
    const element = dialog.current, opener = document.activeElement; element.showModal(); close.current.focus();
    return () => { element.close(); queueMicrotask(() => { const target = returnFocusRef?.current || opener; if (target?.isConnected) target.focus(); }); };
  }, []);
  useEffect(() => {
    let cancelled = false; const owner = session.value; setBusy('load'); setError(null);
    getTemplateShare().then(value => { if (!cancelled && owner === session.value) { setData(value); setDomainAll(value.domainAll); setUsers([...value.users]); } }).catch(value => { if (!cancelled && owner === session.value) setError(value); }).finally(() => { if (!cancelled && owner === session.value) setBusy(''); });
    return () => { cancelled = true; };
  }, [revision]);
  function add(value = person) {
    const text = value.trim(), address = text.includes('@') ? text : `${text}@${data.domain}`;
    if (address.includes('@') && address.replace(/^.*</, '').replace(/>$/, '').split('@')[1]?.toLowerCase() !== data.domain.toLowerCase()) { setError({ message: '같은 도메인 사용자만 지정할 수 있어요' }); input.current.focus(); return false; }
    try { setUsers(addTemplateShareUser(users, address)); setPerson(''); setError(null); input.current.focus(); }
    catch (value) { setError(value); input.current.focus(); return false; }
  }
  async function save() {
    if (!data || pending.current) return;
    if (person.trim()) { setError({ message: '입력한 사람을 추가한 뒤 저장해 주세요.' }); input.current.focus(); return; }
    const owner = session.value; pending.current = true; setBusy('save'); setError(null);
    try { const value = await putTemplateShare({ domainAll, users }); if (live.current && owner === session.value) { onSaved(value); onClose(); } }
    catch (value) { if (live.current && owner === session.value) setError(value); }
    finally { pending.current = false; if (live.current && owner === session.value) setBusy(''); }
  }
  const saving = busy === 'save', personError = error?.message === '같은 도메인 사용자만 지정할 수 있어요';
  const personRow = (address, inherited = false) => <div key={address}><span class="av">{address.slice(0, 2)}</span><span class="who">{address}<small>{address}</small></span><span class="ro">{inherited ? '받은편지함 공유' : '읽기 전용'}</span>{!inherited && <button type="button" class="rm" disabled={saving} aria-label={`${address} 공유 해제`} onClick={() => setUsers(users.filter(user => user !== address))}>해제</button>}</div>;
  return <dialog ref={dialog} class="tpl-dlg wide" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); if (!saving) onClose(); }} aria-busy={Boolean(busy)}>
    <h2 id={`${id}-title`}>공유 폴더 공유 설정</h2><p>공유 폴더의 모든 템플릿이 같은 사람에게 보여요. 받는 사람은 읽기만 하고, 원본을 고치면 바로 반영돼요. 각자 복사해서 고쳐 쓸 수 있어요.</p>
    <p class="tplA-sfin"><Icon name="share" size="xs"/><span>지금 공유 폴더에 든 템플릿 {templates.length}개{templates.length ? ': ' : ''}{templates.map((item, index) => <span key={item.id}>{index ? ', ' : ''}<b>{item.name}</b></span>)}</span></p>
    {busy === 'load' && <p role="status">공유 설정을 불러오는 중…</p>}
    {data && <>
      <label class="tpl-switch"><span class="t">같은 도메인 전체<small>@{data.domain} 주소를 쓰는 모든 사람</small></span><input type="checkbox" checked={domainAll} disabled={saving} aria-label="같은 도메인 전체에 공유" onChange={event => setDomainAll(event.currentTarget.checked)}/></label>
      <div class="tpl-share-recipient"><RecipientInput label="사람 지정" id={`${id}-person`} values={[]} query={person} onValues={values => add(values.at(-1).address)} onQuery={setPerson} onError={setError} inputRef={input} disabled={saving} domain={data.domain} addressScope={{ domain: data.domain, exclude: [session.value?.user?.email, ...users].filter(Boolean) }}><button type="button" class="btn" disabled={saving || !person.trim()} onClick={() => add()}>추가</button></RecipientInput>{personError && <p class="field-err" role="alert">{error.message}</p>}</div>
      <h3 class="tplA-sh">내가 고른 공유 대상</h3><div class="tpl-share-people">{domainAll && <div><span class="av"><Icon name="users" size="xs"/></span><span class="who">{data.domain} 전체<small>같은 도메인 모든 사람</small></span><span class="ro">읽기 전용</span><button type="button" class="rm" disabled={saving} onClick={() => setDomainAll(false)}>해제</button></div>}{users.map(user => personRow(user))}{!domainAll && !users.length && <div class="who">아직 고른 사람이 없어요.</div>}</div>
      {data.inboxReaders.length > 0 && <><h3 class="tplA-sh">메일함 전체 공유로 볼 수 있음 <span class="num">{data.inboxReaders.length}명</span></h3><div class="tpl-share-people tplA-inbox" aria-label="메일함 전체 공유로 볼 수 있는 사람(여기서 바꿀 수 없음)">{data.inboxReaders.map(user => personRow(user, true))}</div><p class="tpl-note">받은편지함을 공유받은 사람은 공유 폴더 밖 템플릿까지 모두 읽을 수 있어요. 받은편지함 공유를 빼면 함께 사라져요.</p></>}
    </>}
    {error && !personError && <p class="field-err" role="alert">{error.message}</p>}{!data && !busy && error && <button type="button" class="btn sm" onClick={() => setRevision(value => value + 1)}>다시 시도</button>}
    <div class="acts"><button ref={close} type="button" class="btn" disabled={saving} onClick={onClose}>닫기</button><button type="button" class="btn pri" disabled={!data || Boolean(busy)} onClick={save}>{saving ? '저장 중…' : '저장'}</button></div>
  </dialog>;
}
