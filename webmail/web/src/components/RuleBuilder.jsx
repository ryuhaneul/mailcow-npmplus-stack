import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { folders } from '../state/folders.js';
import { config } from '../state/config.js';
import { toast } from '../state/toast.js';
import Icon from './Icon.jsx';
import { RuleSummary } from './RuleList.jsx';
import RulePreview from './RulePreview.jsx';
import { forwardStatus, personalFolder, ruleProblem, seededConditions } from './rule-form.js';
import './rule-builder.css';

export default function RuleBuilder({ id, query }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [forwardText, setForwardText] = useState('');
  const [applyOld, setApplyOld] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [pending, setPending] = useState(false);
  const live = useRef(true);
  const saving = useRef(false);
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  async function load() {
    setError(null); setBusy(true); setData(null); setDraft(null); setPreview(null);
    try {
      const value = await api('/api/rules');
      if (!live.current) return;
      if (!['ok', 'none'].includes(value.state)) {navigate('filters'); return;}
      const existing = id ? value.doc.rules.find(rule => rule.id === id) : null;
      setData(value);
      if (id && !existing) {setError({code:'NOT_FOUND',message:'이 규칙을 찾을 수 없어요. 필터 목록에서 다시 선택해 주세요.'}); return;}
      const rule = existing ? structuredClone(existing) : {id:crypto.randomUUID().replaceAll('-', '').slice(0,8),enabled:true,match:'all',conditions:seededConditions(query),actions:{move:''},stop:false};
      setDraft(rule); setForwardText(rule.actions.forward?.join(', ') ?? '');
    } catch (e) {if (live.current) setError(e);}
    finally {if (live.current) setBusy(false);}
  }
  useEffect(() => {load();}, []);
  const choices = folders.value.folders.filter(personalFolder);
  const rule = draft && {...draft,actions:{...draft.actions,...(draft.actions.move === '' ? {move:choices[0]?.path ?? ''} : {}),...(draft.actions.forward ? {forward:forwardStatus(forwardText, data.internalDomains).addresses} : {})}};
  const problem = rule ? ruleProblem(rule, folders.value.folders, data.internalDomains, forwardText) : null;
  const serialized = rule && JSON.stringify(rule);
  useLayoutEffect(() => {
    let current = true;
    setPreview(null); setPreviewError(null); setPending(Boolean(rule && !problem));
    if (!rule || problem) return () => {current = false;};
    const timer = setTimeout(async () => {
      try {const result = await api('/api/rules/preview', {method:'POST',body:{rule:JSON.parse(serialized)}}); if (current) setPreview(result);}
      catch (e) {if (current) setPreviewError(e);}
      finally {if (current) setPending(false);}
    }, 300);
    return () => {current = false; clearTimeout(timer);};
  }, [serialized, problem]);
  function updateCondition(index, patch) {
    setDraft({...draft,conditions:draft.conditions.map((condition, i) => i === index ? {...condition,...patch} : condition)});
  }
  function toggleAction(name, checked) {
    const actions = {...draft.actions};
    if (checked) actions[name] = name === 'move' ? choices[0]?.path ?? '' : name === 'forward' ? [] : true;
    else delete actions[name];
    setDraft({...draft,actions});
  }
  async function save(event) {
    event.preventDefault();
    if (saving.current || problem || !rule || error || busy) return;
    saving.current = true; setBusy(true); setError(null);
    let saved = false;
    try {
      const rules = id ? data.doc.rules.map(item => item.id === id ? rule : item) : [...data.doc.rules, rule];
      await api('/api/rules', {method:'PUT',body:{baseRev:data.rev,doc:{...data.doc,rules}}});
      saved = true;
      if (applyOld) {
        try {
          const result = await api('/api/rules/apply-existing', {method:'POST',body:{rule}});
          toast.value = {kind:'rule-apply-result',message:`규칙을 저장했어요. 기존 메일 ${result.matched.toLocaleString()}통 일치 · 이동 ${result.moved}통 · 휴지통 ${result.trashed}통 · 표시 ${result.flagged}통 · 실패 ${result.failed.length}통. 전달은 앞으로 오는 메일에만 해요.`};
        } catch (e) {toast.value = {kind:'rule-apply-result',message:`규칙은 저장했어요. 기존 메일 적용에 실패했어요. ${e.message}`};}
      } else toast.value = {kind:'success',message:'규칙을 저장했어요.'};
      if (live.current) navigate('filters');
    } catch (e) {if (live.current && !saved) {if (e.code === 'RULES_STATE') navigate('filters'); else setError(e);}}
    finally {saving.current = false; if (live.current) setBusy(false);}
  }
  const external = forwardText && forwardStatus(forwardText, data?.internalDomains ?? []).external;
  const days = config.value?.autoexpungeDays;
  return <section class="view rule-builder-view" aria-labelledby="rule-title" aria-busy={busy}>
    <div class="set-head"><div class="crumb"><a href="#filters">필터와 규칙</a><Icon name="right" size="xs"/>{id ? '규칙 수정' : '새 규칙'}</div><h1 id="rule-title">{id ? '규칙 수정' : '규칙 만들기'}</h1><div class="rule-head-space"/></div>
    <div class="scroll"><div class="set-body">
      {error && <div class="banner rule-error" role="alert"><div>{error.code === 'RULES_CONFLICT' ? '필터가 바뀌었어요. 다시 불러온 뒤 저장해 주세요.' : error.code === 'FORWARD_EXTERNAL' ? '회사 밖 주소로는 자동 전달할 수 없습니다(회사 정책). 받는 쪽이 사내 주소인지 확인해 주세요.' : error.code === 'RULES_INVALID' ? `규칙을 확인해 주세요. ${error.path ?? ''} ${error.reason ?? ''}` : error.message}</div><button class="btn" type="button" disabled={busy} onClick={load}>다시 불러오기</button><a class="btn" href="#filters">필터 목록</a></div>}
      {!draft && !error && <p role="status">규칙을 불러오는 중이에요.</p>}
      {rule && <div class="builder"><form onSubmit={save}>
        <div class="summary"><small>이렇게 동작합니다</small><RuleSummary rule={rule}/></div>
        <fieldset class="rule-fields" disabled={busy || Boolean(error)}>
          <div class="step"><h2><i aria-hidden="true">1</i>어떤 메일에<span class="seg" role="group" aria-label="조건 결합">{[['all','모두 맞을 때'],['any','하나라도 맞을 때']].map(([value,label]) => <button type="button" aria-pressed={rule.match === value} onClick={() => setDraft({...draft,match:value})}>{label}</button>)}</span></h2>
            {rule.conditions.map((condition,index) => <div class="cond" key={index}>
              <select class="dd" aria-label={`${index+1}번 조건 항목`} value={condition.field} onChange={e => updateCondition(index, {field:e.currentTarget.value,...(e.currentTarget.value === 'attachment' ? {op:'has',value:''} : {})})}>{[['from','보낸 사람'],['to','받는 사람(To·Cc)'],['subject','제목'],['attachment','첨부파일']].map(([value,label]) => <option value={value}>{label}</option>)}</select>
              <select class="dd" aria-label={`${index+1}번 조건 방식`} disabled={condition.field === 'attachment'} value={condition.op} onChange={e => updateCondition(index,{op:e.currentTarget.value})}>{(condition.field === 'attachment' ? [['has','있음']] : [['has','포함'],['not','포함 안 됨'],['eq',condition.field === 'subject' ? '제목이 정확히' : '주소가 정확히'],['start',condition.field === 'subject' ? '제목이 시작' : '주소가 시작']]).map(([value,label]) => <option value={value}>{label}</option>)}</select>
              <input class="inp" aria-label={`${index+1}번 조건 값`} value={condition.value} disabled={condition.field === 'attachment'} placeholder={condition.field === 'attachment' ? '값 필요 없음' : '조건 값을 입력하세요'} onInput={e => updateCondition(index,{value:e.currentTarget.value})}/>
              <button class="ib remove-condition" type="button" aria-label={`${index+1}번 조건 빼기`} disabled={rule.conditions.length === 1} onClick={() => setDraft({...draft,conditions:draft.conditions.filter((_,i) => i !== index)})}><Icon name="minus"/></button>
            </div>)}
            <button class="addc" type="button" disabled={rule.conditions.length >= 10} onClick={() => setDraft({...draft,conditions:[...draft.conditions,{field:'subject',op:'has',value:''}]})}><Icon name="plus" size="s"/>조건 추가</button>
            <p class="rule-note">보낸 사람·받는 사람의 포함·포함 안 됨은 이름과 주소를 함께 봅니다. 정확히·시작은 주소만 봅니다. 받는 사람은 To·Cc를 모두 봅니다. 제목은 제목 전체를 비교하며, 영문 대소문자는 구분하지 않아요.</p>
            {rule.conditions.some(c => c.field === 'attachment') && <p class="rule-note">첨부파일 있음은 메일의 최상위 Content-Type이 multipart/mixed인 경우예요.</p>}
          </div>
          <div class="step"><h2><i aria-hidden="true">2</i>어떻게 할까요</h2><div class="acts-list">
            <div class={`act${Object.hasOwn(rule.actions,'move') ? ' on' : ''}`}><input id="rule-move" type="checkbox" checked={Object.hasOwn(rule.actions,'move')} disabled={Boolean(rule.actions.trash)} onChange={e => toggleAction('move',e.currentTarget.checked)}/><div><label for="rule-move">폴더로 옮기기</label><small>메일은 폴더 한 곳에만 들어갑니다. 받은편지함에서 빠져 이 폴더로 갑니다</small><div class="ex"><select class="dd" aria-label="옮길 폴더" disabled={!Object.hasOwn(rule.actions,'move')} value={rule.actions.move ?? ''} onChange={e => setDraft({...draft,actions:{...draft.actions,move:e.currentTarget.value}})}>{!choices.length && <option value="">옮길 개인 폴더가 없어요</option>}{rule.actions.move && !choices.some(f => f.path === rule.actions.move) && <option value={rule.actions.move}>폴더 없음: {rule.actions.move}</option>}{choices.map(f => <option value={f.path}>{f.name}</option>)}</select></div></div></div>
            {[['read','읽음으로 표시'],['star','별표 붙이기'],['trash','삭제 (휴지통으로)'],['forward','사내 주소로 전달']].map(([name,label]) => <div class={`act${rule.actions[name] ? ' on' : ''}`} key={name}><input id={`rule-${name}`} type="checkbox" checked={Boolean(rule.actions[name])} disabled={name === 'trash' && Object.hasOwn(rule.actions,'move')} onChange={e => toggleAction(name,e.currentTarget.checked)}/><div><label for={`rule-${name}`}>{label}</label>
              {name === 'trash' && <small>폴더로 옮기기와 함께 고를 수 없습니다.{days ? ` 휴지통 메일은 ${days}일 뒤 지워집니다` : ''}</small>}
              {name === 'forward' && <><small>회사 안 주소로만 전달할 수 있습니다.{data.internalDomains.length > 0 && ` 예: user@${data.internalDomains[0]}`}<br/>전달은 앞으로 오는 메일에만 해요. 주소는 쉼표로 나누어 최대 3개까지 입력해 주세요.</small><div class="ex"><input class="inp forward-input" aria-label="전달 받을 사내 주소" aria-invalid={Boolean(rule.actions.forward && !forwardStatus(forwardText,data.internalDomains).valid)} aria-describedby={external ? 'forward-lock' : undefined} value={forwardText} placeholder={data.internalDomains.length ? `user@${data.internalDomains[0]}` : '전달 받을 사내 메일 주소'} onInput={e => {setForwardText(e.currentTarget.value);if (!draft.actions.forward) toggleAction('forward',true);}}/></div>{external && <div class="lock" id="forward-lock" role="alert"><Icon name="alert" size="s"/><span>회사 밖 주소로는 자동 전달할 수 없습니다(회사 정책). 받는 쪽이 사내 주소인지 확인해 주세요.</span></div>}</>}
            </div></div>)}
          </div></div>
          <div class="step rule-stop"><label><input type="checkbox" checked={rule.stop} onChange={e => setDraft({...draft,stop:e.currentTarget.checked})}/>이후 규칙 멈춤</label><p class="rule-note">이 규칙에 맞으면 뒤에 있는 규칙은 적용하지 않아요.</p></div>
          {problem && <p class="rule-note" role="status">{problem}</p>}
          <div class="save-row"><label><input type="checkbox" checked={applyOld} onChange={e => setApplyOld(e.currentTarget.checked)}/><span>이미 받은 메일 <b class="num">{pending || !preview ? '…' : preview.count.toLocaleString()}</b>통에도 지금 적용</span></label><div class="r"><a class="btn ghost" href="#filters">취소</a><button class="btn pri" type="submit" disabled={Boolean(problem) || pending || Boolean(previewError) || !preview || (!id && data.doc.rules.length >= 100)}>규칙 저장</button></div></div>
          {!id && data.doc.rules.length >= 100 && <p class="rule-note">규칙은 최대 100개까지 저장할 수 있어요.</p>}
        </fieldset>
      </form><RulePreview data={preview} pending={pending} error={previewError} problem={problem}/></div>}
    </div></div>
  </section>;
}
