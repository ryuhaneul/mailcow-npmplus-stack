import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

// Mount one dialog per operation (key by operation/id). Callbacks never mutate data.
// returnFocusRef provides a surviving target when deletion removes the opener.
export default function SignatureDialog({ type, signature, defaults = {}, nextSignature = null, busy = false, error, returnFocusRef, onConfirm, onCancel }) {
  const dialog = useRef(null), input = useRef(null), cancel = useRef(null), id = useId();
  const naming = ['new', 'rename', 'copy'].includes(type);
  const [name, setName] = useState(type === 'new' ? '' : (signature?.name ?? '') + (type === 'copy' ? ' (복사)' : ''));
  const [problem, setProblem] = useState('');
  const users = Object.entries(defaults).filter(([, value]) => value.newDefault === signature?.id || value.replyDefault === signature?.id);
  const title = type === 'new' ? '새 서명 만들기' : type === 'rename' ? '서명 이름 바꾸기' : type === 'copy' ? '서명 복제' : type === 'delete' ? `‘${signature.name}’ 서명을 지울까요?` : '수정한 서명을 바꿀까요?';
  const confirmLabel = type === 'new' ? '만들기' : type === 'copy' ? '복제' : type === 'delete' ? '서명 삭제' : '바꾸기';
  useLayoutEffect(() => {
    const element = dialog.current, opener = document.activeElement;
    element.showModal();
    (input.current || cancel.current).focus();
    if (type === 'rename' || type === 'copy') input.current.select();
    return () => {
      element.close();
      const target = returnFocusRef?.current || opener;
      if (target?.isConnected) target.focus();
    };
  }, []);
  function confirm() {
    if (busy) return;
    if (naming) {
      const value = name.trim();
      const message = !value ? '서명 이름을 입력해 주세요.' : new TextEncoder().encode(value).length > 200 ? '서명 이름은 200바이트 이하로 입력해 주세요.' : /[\x00-\x1f\x7f-\x9f]/.test(name) ? '서명 이름에 제어 문자를 넣을 수 없어요.' : '';
      setProblem(message);
      if (message) { input.current.focus(); return; }
      onConfirm(value);
    } else onConfirm();
  }
  function keyboard(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); }
    if (event.key === 'Enter' && event.target === input.current && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); confirm(); }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.current.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
    const first = focusable[0], last = focusable.at(-1);
    if (!first) { event.preventDefault(); dialog.current.focus(); }
    else if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  return <dialog class="sig-dialog d-dialog" ref={dialog} tabIndex={-1} aria-labelledby={`${id}-title`} aria-busy={busy} onKeyDown={keyboard} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id={`${id}-title`}>{title}</h2>
    {naming ? <>
      <label class="name-label" for={`${id}-name`}>서명 이름</label>
      <input class="inp" id={`${id}-name`} ref={input} value={name} placeholder="예: 외부 연락용" autoComplete="off" disabled={busy} aria-invalid={Boolean(problem)} aria-describedby={`${id}-note ${id}-limit${problem ? ` ${id}-problem` : ''}`} onInput={event => { setName(event.currentTarget.value); setProblem(''); }}/>
      <p class="dialog-note" id={`${id}-note`}>이름은 서명을 고를 때 보여요.</p>
      <p class="dialog-note" id={`${id}-limit`}>서명 이름은 200바이트까지 입력할 수 있어요.</p>
    </> : type === 'delete' ? <>
      {users.length ? <><p class="delete-default-warning">{users.length}개 주소의 기본 서명이에요.<br/>지우면 그 주소의 해당 기본값은 ‘없음’이 돼요.</p><ul class="delete-users">{users.map(([address, value]) => <li key={address}>{address}<small>{[value.newDefault === signature.id ? '새 메일' : '', value.replyDefault === signature.id ? '답장·전달' : ''].filter(Boolean).join(' · ')}</small></li>)}</ul></> : <p>어떤 주소의 기본값으로도 쓰지 않는 서명이에요.</p>}
      <p class="dialog-note">이미 작성한 메일의 서명과 보관함 이미지는 그대로예요.</p>
    </> : <><p>지금 메일에서 고친 서명 내용이 ‘{nextSignature?.name ?? '없음'}’{!nextSignature ? '으로' : ' 서명으로'} 바뀌어요.</p><p class="dialog-note">메일 본문은 그대로예요.</p></>}
    {problem && <p class="field-err" role="alert" id={`${id}-problem`}>{problem}</p>}
    {error && <p class="field-err" role="alert">{error.message || error}</p>}
    <div class="dialog-footer"><button type="button" class="btn" ref={cancel} disabled={busy} onClick={() => onCancel()}>취소</button><button type="button" class="btn pri" disabled={busy} onClick={confirm}>{confirmLabel}</button></div>
  </dialog>;
}
