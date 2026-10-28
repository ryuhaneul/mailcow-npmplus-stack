import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import { isDefaultTemplateVariable, templateVariableValue } from '../templates/vars.js';

// Match SignatureDialog's keyboard cycle for native modal dialogs.
function cycleTab(event, dialog) {
  if (event.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
  const first = focusable[0], last = focusable.at(-1);
  if (!first) { event.preventDefault(); dialog.focus(); }
  else if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
}

export default function TemplateVarsDialog({ name, subject, state, missing, focusName, returnFocusRef, onChange, onClose, onCancel }) {
  const dialog = useRef(null), id = useId(), own = state.names.filter(name => !isDefaultTemplateVariable(name)), autos = state.names.filter(isDefaultTemplateVariable);
  const names = [...own, ...autos];
  useLayoutEffect(() => {
    const element = dialog.current, opener = document.activeElement;
    element.showModal();
    const target = names.indexOf(focusName || missing[0]);
    (element.querySelectorAll('input')[Math.max(0, target)] || element.querySelector('button')).focus();
    return () => { element.close(); queueMicrotask(() => { const target = returnFocusRef?.current || opener; if (target?.isConnected) target.focus(); }); };
  }, []);
  const field = (name, index) => <><label for={`${id}-${index}`}>{name}</label><input id={`${id}-${index}`} class={`tpl-in ${missing.includes(name) ? 'empty' : ''}`} data-template-var={name} autoComplete="off" value={templateVariableValue(state, name)} placeholder={isDefaultTemplateVariable(name) ? '받는 사람을 넣으면 채워져요' : ''} onInput={event => onChange(name, event.currentTarget.value)}/></>;
  return <dialog ref={dialog} tabIndex={-1} onKeyDown={event => cycleTab(event, dialog.current)} class="tpl-dlg wide tplA-vardlg" aria-labelledby={`${id}-title`} aria-describedby={`${id}-note`} onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id={`${id}-title`}>「{name || '템플릿 변수'}」 빈칸 채우기</h2><p id={`${id}-note`}>입력하는 대로 제목과 본문에 들어가요. 비워 두면 보내기 전에 다시 알려 드려요.</p>
    <div class="tpl-varform">{own.map((name, index) => <div class="tpl-var-pair" key={name}>{field(name, index)}</div>)}{autos.length > 0 && <p class="tpl-varhead">자동으로 채움 · 고칠 수 있어요</p>}{autos.map((name, index) => <div class="tpl-var-pair" key={name}>{field(name, own.length + index)}</div>)}</div>
    <div class="tplB-prev"><b>제목 미리보기</b><div>{subject}</div></div><div class="acts"><button type="button" class="btn ghost" onClick={onCancel}>취소</button><button type="button" class="btn" onClick={onClose}>닫기</button><button type="button" class="btn pri" onClick={onClose}>다 채웠어요</button></div>
  </dialog>;
}

export function TemplateSendWarning({ items, returnFocusRef, onClose, onFill, onSend }) {
  const dialog = useRef(null), fill = useRef(null), id = useId();
  useLayoutEffect(() => {
    const element = dialog.current, opener = document.activeElement; element.showModal(); fill.current.focus();
    return () => { element.close(); queueMicrotask(() => { const target = returnFocusRef?.current || opener; if (target?.isConnected) target.focus(); }); };
  }, []);
  return <dialog ref={dialog} tabIndex={-1} onKeyDown={event => cycleTab(event, dialog.current)} class="tpl-dlg" aria-labelledby={`${id}-title`} aria-describedby={`${id}-note`} onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id={`${id}-title`}>빈 변수 {items.length}개가 있어요</h2><p id={`${id}-note`}>이대로 보내면 받는 사람에게 {'{{' + items[0].name + '}}'}처럼 그대로 보여요.</p><ul class="tpl-warnlist">{items.map(item => <li key={item.name}><span>{'{{' + item.name + '}}'}</span><small>{item.location}</small></li>)}</ul>
    <div class="acts"><button type="button" class="btn" onClick={onSend}>그대로 보내기</button><button type="button" class="btn pri" ref={fill} onClick={onFill}>채우러 가기</button></div>
  </dialog>;
}
