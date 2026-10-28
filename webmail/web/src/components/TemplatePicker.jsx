import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { getTemplates, getTemplate, searchTemplates, templateUnavailable } from '../templates/api.js';
import { formatBytes } from '../format.js';
import Icon from './Icon.jsx';
import { navigate } from '../router.js';

export default function TemplatePicker({ returnFocusRef, onCancel, onChoose, onCreate }) {
  const dialog = useRef(null), search = useRef(null), id = useId();
  const [list, setList] = useState(null), [error, setError] = useState(null), [retry, setRetry] = useState(0), [query, setQuery] = useState(''), [selected, setSelected] = useState(null), [preview, setPreview] = useState(null), [previewError, setPreviewError] = useState(null);
  useLayoutEffect(() => {
    const element = dialog.current, opener = document.activeElement;
    element.showModal(); search.current.focus();
    return () => { element.close(); const target = returnFocusRef?.current || opener; queueMicrotask(() => { if (target?.isConnected) target.focus(); }); };
  }, []);
  useEffect(() => {
    let cancelled = false; setError(null); setList(null);
    getTemplates().then(value => { if (!cancelled) setList(value); }).catch(error => { if (!cancelled) setError(error); });
    return () => { cancelled = true; };
  }, [retry]);
  const all = list ? [...list.mine, ...list.shared, ...list.public] : [], filtered = searchTemplates(all, query);
  const pinned = item => list.pins.some(pin => pin.owner === item.owner && pin.id === item.id);
  const groups = list ? [['pins', '고정', filtered.filter(pinned)], ['mine', '내 템플릿', filtered.filter(item => list.mine.includes(item) && !pinned(item))], ['shared', '공유받은 템플릿', filtered.filter(item => list.shared.includes(item) && !pinned(item))], ['public', '회사 공용', filtered.filter(item => list.public.includes(item) && !pinned(item))]] : [];
  const ordered = groups.flatMap(([, , items]) => items), active = ordered.find(item => item.ref === selected) || ordered[0];
  useEffect(() => {
    let cancelled = false; setPreview(null); setPreviewError(null);
    if (active) getTemplate(active.ref).then(value => { if (!cancelled) setPreview(value); }).catch(error => { if (!cancelled) setPreviewError(error); });
    return () => { cancelled = true; };
  }, [active?.ref, retry]);
  useEffect(() => { dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [active?.ref]);
  function key(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); const index = ordered.indexOf(active);
      setSelected(ordered[(index + (event.key === 'ArrowDown' ? 1 : -1) + ordered.length) % ordered.length]?.ref);
    } else if (event.key === 'Enter' && (event.target === search.current || event.target.closest('[role=option]')) && active) { event.preventDefault(); onChoose(preview?.ref === active.ref ? preview : active); }
  }
  const appearance = getComputedStyle(document.documentElement);
  return <dialog ref={dialog} class="tpl-dlg tplA-pickdlg" aria-labelledby={`${id}-title`} onKeyDown={key} onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h2 id={`${id}-title`} class="sr">템플릿</h2><div class="tplA-pick"><div class="tpl-search"><Icon name="search" size="s"/><input ref={search} class="tpl-in" placeholder="템플릿 찾기 — 이름·제목" aria-label="템플릿 찾기" role="combobox" aria-expanded="true" aria-activedescendant={active ? `${id}-option-${ordered.indexOf(active)}` : undefined} aria-controls={`${id}-list`} autoComplete="off" value={query} onInput={event => setQuery(event.currentTarget.value)}/><button type="button" class="ib tpl-picker-close" aria-label="템플릿 닫기" onClick={onCancel}><Icon name="x" size="s"/></button></div>
      <span class="sr" role="status" aria-live="polite">{list ? `${filtered.length}개 템플릿` : '템플릿을 불러오는 중…'}</span>
      <div class="tplA-pick-body"><div class="tplA-pick-list" id={`${id}-list`} role="listbox" aria-label="템플릿" aria-busy={!list && !error}>
        {list?.publicUnavailable && <div class="tplA-empty" role="alert"><p>회사 공용 템플릿을 불러오지 못했어요</p><button type="button" class="btn sm" onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
        {!list && !error && <div class="tpl-loading" role="status">템플릿을 불러오는 중…</div>}
        {error && <div class="tplA-empty" role="alert"><span>{error.message}</span><button type="button" class="btn sm" onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
        {list && !all.length && !list.publicUnavailable && <div class="tplA-empty"><span>템플릿이 없어요</span><button class="btn sm" type="button" onClick={onCreate}>만들기</button></div>}
        {list && all.length > 0 && !filtered.length && <p class="tplA-empty">찾는 템플릿이 없어요.</p>}
        {groups.filter(([, , items]) => items.length).map(([key, label, items]) => <div role="group" aria-label={label} key={key}><h4 role="presentation">{label}</h4>{items.map(item => <button type="button" role="option" key={item.ref} id={`${id}-option-${ordered.indexOf(item)}`} tabIndex={active?.ref === item.ref ? 0 : -1} aria-selected={active?.ref === item.ref} title={item.name} onFocus={() => setSelected(item.ref)} onMouseOver={() => setSelected(item.ref)} onClick={() => onChoose(preview?.ref === item.ref ? preview : item)}><span class="tpl-picker-name">{item.name}</span>{pinned(item) && <Icon name="pin" size="xs"/>}{item.hasAttachments && <Icon name="clip" size="xs"/>}</button>)}</div>)}
      </div><div class="tplA-pick-prev" aria-live="polite" aria-busy={Boolean(active && !preview && !previewError)}>
        {previewError ? <p role="alert"><span>{templateUnavailable(previewError) ? '더 이상 볼 수 없어요' : previewError.message}</span><button class="btn sm" type="button" onClick={() => setRetry(value => value + 1)}>다시 시도</button></p> : preview ? <><b>{preview.subject}</b><iframe title="템플릿 미리보기" sandbox="allow-same-origin" srcDoc={`<!doctype html><html lang="ko"><head><meta name="referrer" content="no-referrer"><style>@font-face{font-family:Pretendard;src:url(/fonts/PretendardVariable.woff2) format("woff2");font-weight:45 920}body{margin:0;font:13.5px/1.7 Pretendard,sans-serif;overflow-wrap:anywhere;color:${appearance.getPropertyValue('--ink-2')};background:${appearance.getPropertyValue('--surface')}}img{max-width:100%}p{margin:0 0 8px}</style></head><body>${preview.html}</body></html>`}/><div class="tpl-atts">{preview.attachments.map(file => <span class="att" key={file.part}><Icon name="clip" size="xs"/><span>{file.name}</span><small>{formatBytes(file.size)}</small></span>)}</div></> : active ? <p>미리보기를 불러오는 중…</p> : null}
      </div></div><div class="tplA-pick-foot"><span><span class="kbd">↑</span><span class="kbd">↓</span> 고르기 · <span class="kbd">Enter</span> 넣기</span><a href="#templates" onClick={event => { event.preventDefault(); onCancel(); navigate('templates'); }}>템플릿 관리</a></div></div>
  </dialog>;
}

export function TemplateInsertDialog({ template, kind, busy, error, returnFocusRef, onCancel, onConfirm }) {
  const dialog = useRef(null), cancel = useRef(null), id = useId(), [mode, setMode] = useState('replace');
  useLayoutEffect(() => {
    const element = dialog.current, opener = document.activeElement; element.showModal(); cancel.current.focus();
    return () => { element.close(); const target = returnFocusRef?.current || opener; queueMicrotask(() => { if (target?.isConnected) target.focus(); }); };
  }, []);
  const reply = ['reply', 'replyall', 'forward'].includes(kind);
  return <dialog ref={dialog} class="tpl-dlg" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id={`${id}-title`}>이미 쓴 내용이 있어요</h2><p>「{template.name}」을(를) 어떻게 넣을까요?{reply ? ' 아래 인용문은 그대로 둬요.' : ''}</p>
    <label class="tpl-choice"><input type="radio" name={`${id}-how`} checked={mode === 'replace'} disabled={busy} onChange={() => setMode('replace')}/><span><b>바꾸기</b><small>{reply ? '쓴 본문을 템플릿 본문으로 바꿔요. 제목·인용문은 그대로 둬요.' : kind === 'draft' ? '쓴 본문을 템플릿 본문으로 바꿔요. 제목은 비어 있을 때만 채워요.' : '쓴 내용을 지우고 템플릿 제목·본문으로 바꿔요.'}</small></span></label>
    <label class="tpl-choice"><input type="radio" name={`${id}-how`} checked={mode === 'append'} disabled={busy} onChange={() => setMode('append')}/><span><b>뒤에 넣기</b><small>{reply ? '쓴 내용 아래, 인용문 앞에 템플릿 본문을 붙여요. 제목은 그대로 둬요.' : '쓴 내용 아래에 템플릿 본문을 붙여요. 제목은 비어 있을 때만 채워요.'}</small></span></label>
    {error && <p role="alert" class="field-err">{error.message}</p>}<div class="acts"><button type="button" class="btn" ref={cancel} disabled={busy} onClick={onCancel}>취소</button><button type="button" class="btn pri" disabled={busy} onClick={() => onConfirm(mode)}>{busy ? '넣는 중…' : '넣기'}</button></div>
  </dialog>;
}
