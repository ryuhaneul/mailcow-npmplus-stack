import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { getTemplates } from '../templates/api.js';

export default function TemplateSaveDialog({ subject, hasForwardFiles, selectedTemplate, busy, error, returnFocusRef, onCancel, onSave }) {
  const dialog = useRef(null), input = useRef(null), id = useId();
  const [mode, setMode] = useState('new'), [name, setName] = useState([...subject].slice(0, 30).join('') || '새 템플릿'), [mine, setMine] = useState(null), [selected, setSelected] = useState(''), [problem, setProblem] = useState(''), [loadError, setLoadError] = useState(null), [retry, setRetry] = useState(0);
  useLayoutEffect(() => {
    const element = dialog.current, opener = document.activeElement; element.showModal(); input.current.focus(); input.current.select();
    return () => { element.close(); const target = returnFocusRef?.current || opener; queueMicrotask(() => { if (target?.isConnected) target.focus(); }); };
  }, []);
  useEffect(() => {
    let cancelled = false; setLoadError(null);
    getTemplates().then(value => { if (!cancelled) { setMine(value.mine); setSelected((value.mine.find(item => item.owner === selectedTemplate?.owner && item.id === selectedTemplate?.id) || value.mine[0])?.ref || ''); } }).catch(error => { if (!cancelled) setLoadError(error); });
    return () => { cancelled = true; };
  }, [retry]);
  function save() {
    const existing = mode === 'over' ? mine?.find(item => item.ref === selected) : null;
    if (mode === 'new' && (!name.trim() || [...name.trim()].length > 100)) { setProblem('템플릿 이름은 1~100자로 입력해 주세요.'); input.current.focus(); return; }
    if (mode === 'over' && !existing) { setProblem('덮어쓸 내 템플릿을 골라 주세요.'); return; }
    setProblem(''); onSave({ name: existing?.name || name.trim(), existing });
  }
  return <dialog ref={dialog} class="tpl-dlg" aria-labelledby={`${id}-title`} aria-describedby={`${id}-note`} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id={`${id}-title`}>템플릿으로 저장</h2><p id={`${id}-note`}>지금 쓴 제목·본문·첨부를 저장해요. 받는 사람은 저장하지 않아요.</p>
    <label class="tpl-choice"><input type="radio" name={`${id}-mode`} value="new" checked={mode === 'new'} disabled={busy} onChange={() => setMode('new')}/><span><b>새 템플릿</b><small>이름을 붙여 새로 만들어요.</small></span></label>
    <div class="tplA-sv" hidden={mode !== 'new'}><input ref={input} class="tpl-in" aria-label="새 템플릿 이름" aria-invalid={Boolean(problem)} aria-describedby={problem ? `${id}-problem` : undefined} disabled={busy} value={name} onInput={event => { setName(event.currentTarget.value); setProblem(''); }}/></div>
    <label class="tpl-choice"><input type="radio" name={`${id}-mode`} value="over" checked={mode === 'over'} disabled={busy || !mine?.length} onChange={() => setMode('over')}/><span><b>기존 템플릿 덮어쓰기</b><small>고른 템플릿의 내용을 지금 내용으로 바꿔요. 공유 중이면 받는 사람에게도 바로 반영돼요.</small></span></label>
    <div class="tplA-sv" hidden={mode !== 'over'}><select class="tpl-in" aria-label="덮어쓸 템플릿" value={selected} disabled={busy} onChange={event => setSelected(event.currentTarget.value)}>{mine?.map(item => <option key={item.ref} value={item.ref}>{item.name}</option>)}</select></div>
    {!mine && !loadError && <p role="status" class="tpl-note">템플릿 목록을 불러오는 중…</p>}
    {loadError && <p role="alert" class="tpl-note">{loadError.message}<button type="button" class="btn sm" disabled={busy} onClick={() => setRetry(value => value + 1)}>다시 시도</button></p>}
    <p class="tpl-note">채운 값은 그대로 저장돼요</p>{hasForwardFiles && <p class="tpl-note">전달한 원본 첨부는 템플릿에 들어가지 않아요</p>}
    {problem && <p id={`${id}-problem`} class="field-err" role="alert">{problem}</p>}{error && <p class="field-err" role="alert">{error.message}</p>}
    <div class="acts"><button class="btn" type="button" disabled={busy} onClick={onCancel}>취소</button><button class="btn pri" type="button" disabled={busy || mode === 'over' && !selected} onClick={save}>{busy ? '저장 중…' : '저장'}</button></div>
  </dialog>;
}
