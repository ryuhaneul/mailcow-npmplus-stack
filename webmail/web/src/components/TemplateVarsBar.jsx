import { useId } from 'preact/hooks';
import { isDefaultTemplateVariable, templateVariableValue } from '../templates/vars.js';
import Icon from './Icon.jsx';

export default function TemplateVarsBar({ name, state, missing, disabled, rootRef, buttonRef, onChange, onOpen, onDismiss }) {
  const id = useId(), own = state.names.filter(name => !isDefaultTemplateVariable(name)), autos = state.names.filter(isDefaultTemplateVariable);
  return <div ref={rootRef} class={`tplA-strip ${missing.length ? '' : 'done'}`} role="group" aria-label="템플릿 변수">
    <div class="hd"><span class="nm"><span aria-hidden="true">{'{ }'}</span>{name || '템플릿 변수'}</span><span class="cnt" role="status" aria-live="polite">{missing.length ? `남은 칸 ${missing.length}개` : '다 채웠어요'}</span><button ref={buttonRef} type="button" class="btn sm tplA-fillbtn" disabled={disabled} onClick={onOpen}>빈칸 채우기</button><button type="button" class="ib" aria-label="변수 띠 닫기" disabled={disabled} onClick={onDismiss}><Icon name="x" size="xs"/></button></div>
    <div class="ins">{own.map((name, index) => <label key={name} for={`${id}-${index}`}><span>{name}</span><input class={`tpl-in ${missing.includes(name) ? 'empty' : ''}`} id={`${id}-${index}`} data-template-var={name} value={templateVariableValue(state, name)} placeholder=" " autoComplete="off" disabled={disabled} onInput={event => onChange(name, event.currentTarget.value)}/></label>)}</div>
    {autos.length > 0 && <div class="auto">자동: {autos.map(name => <span key={name}><b>{name}</b> {templateVariableValue(state, name) || '받는 사람을 넣으면 채워져요'}</span>)}</div>}
  </div>;
}
