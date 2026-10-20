import { useState } from 'preact/hooks';
import Icon from './Icon.jsx';
import { RuleSummary } from './RuleList.jsx';

const statuses = { same: '그대로', changed: '달라짐', no: '반영 안 됨' };

export function ImportOriginal({ item }) {
  if (!item.gmail) return <span>{item.summary}</span>;
  return <dl class="gi-gm">{(item.gmail.conditions ?? []).map(([name, value], i) => <div key={i}><dt>{name}</dt><dd>{value}</dd></div>)}
    <div class="gi-gm-act"><dt>동작</dt><dd>{(item.gmail.actions ?? []).join(' · ')}</dd></div>
  </dl>;
}

export function ImportTable({ items }) {
  const [filter, setFilter] = useState('all');
  const visible = items.filter(item => filter === 'all' || item.status === filter);
  const no = visible.filter(item => item.status === 'no');
  const row = item => <tr class={`gi-tr gi-tr-${item.status}`} key={item.n}>
    <td class="gi-n num">{item.n}</td><td class="gi-orig"><ImportOriginal item={item}/></td>
    <td class="gi-arr" aria-hidden="true"><Icon name="right" size="s"/></td>
    <td class="gi-res">{item.status === 'no' ? <p class="gi-no"><b>이 규칙은 반영 안 됨</b><span>{item.reason}</span></p> : <>
      {item.rule ? <div class="say"><RuleSummary rule={item.rule}/></div> : <span>{item.summary}</span>}
      {(item.changes ?? []).map((change, i) => <p class="gi-diff" key={i}><Icon name="info" size="s"/><span>{change}</span></p>)}
      {item.newFolder && <p class="rule-note">‘{item.newFolder}’ 폴더가 없어서 적용할 때 새로 만들어요.</p>}
    </>}</td>
    <td class="gi-stc"><span class={`gi-st gi-st-${item.status}`}><Icon name={item.status === 'same' ? 'check' : item.status === 'changed' ? 'info' : 'x'} size="s"/>{statuses[item.status]}</span>
      {item.newFolder && <span class="chip plain gi-tag">폴더 새로 만듦</span>}</td>
  </tr>;
  return <>
    <div class="gi-bar"><div class="seg gi-seg" role="group" aria-label="상태로 거르기">{[['all','전체'],...Object.entries(statuses)].map(([key, label]) => <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label} <b class="num">{items.filter(item => key === 'all' || item.status === key).length}</b></button>)}</div></div>
    <div class="gi-tablewrap"><table class="gi-table"><caption class="sr">Gmail 필터와 반영 결과</caption>
      <thead><tr><th scope="col">#</th><th scope="col">Gmail 원문</th><th aria-hidden="true"></th><th scope="col">새 웹메일 반영 결과</th><th scope="col">상태</th></tr></thead>
      <tbody>{visible.filter(item => item.status !== 'no').map(row)}</tbody>
      {no.length > 0 && <tbody class="gi-badgroup"><tr><th colSpan="5" scope="rowgroup"><Icon name="alert" size="s"/>반영 안 되는 규칙 {no.length}개 — 적용하면 버려져요</th></tr>{no.map(row)}</tbody>}
    </table></div>
  </>;
}

export function ImportConsent({ plan, dropped, confirmed, onChange, busy, onConfirm, onModeChange, xml = false }) {
  return <div class="gi-apply">
    {onModeChange && plan.existing > 0 && <fieldset class="gi-mode" aria-disabled={busy}><legend>지금 웹메일 규칙 {plan.existing}개가 있어요</legend><div class="acts-list">
      {[['append','뒤에 덧붙이기',`지금 규칙 ${plan.existing}개는 그대로 두고 그 뒤에 ${plan.applied}개를 붙여요. 모두 ${plan.existing + plan.applied}개.`],['replace','통째로 바꾸기',`지금 규칙 ${plan.existing}개는 빠지고 가져온 ${plan.applied}개만 남아요. 되돌리기로 다시 살릴 수 있어요.`]].map(([mode, label, detail]) => <label class={`act${plan.mode === mode ? ' on' : ''}`} key={mode}><input type="radio" name="gi-mode" value={mode} checked={plan.mode === mode} onClick={event => {if (busy) event.preventDefault();}} onChange={() => {if (!busy) onModeChange(mode);}}/><div><span class="gi-lbl">{label}{mode === 'append' && <span class="chip plain">기본</span>}</span><small>{detail}</small></div></label>)}
    </div></fieldset>}
    <ul class="gi-notes">
      {plan.deactivates && <li><Icon name="info" size="s"/><span>{xml && '이번 XML 파일을 기준으로 적용하고, '}지금 켜진 ‘{plan.deactivates}’ 필터는 꺼지고 보관돼요(지우지 않아요). 위 ‘반영 안 됨’ {dropped}개는 적용 뒤 새 웹메일에서 동작하지 않아요.</span></li>}
      <li><Icon name="info" size="s"/><span>반영 안 되는 {dropped}개는 버리고, 조건·동작과 이유만 필터 목록에 남겨 둬요.</span></li>
      <li><Icon name="info" size="s"/><span>적용한 뒤 ‘되돌리기’로 적용 직전 상태로 돌릴 수 있어요. 이미 배달·이동된 메일은 그대로예요.</span></li>
      <li><Icon name="info" size="s"/><span>앞으로 오는 메일부터 적용돼요. 이미 받은 메일은 옮기지 않아요.</span></li>
      {plan.replacesUndo && <li><Icon name="alert" size="s"/><span>이전에 가져온 필터의 되돌리기 기록은 이번 가져오기로 바뀌어요.</span></li>}
    </ul>
    {plan.applied > 0 ? <>
      <label class="gi-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => onChange(event.currentTarget.checked)}/><span>반영 안 되는 <b>{dropped}개는 버리고</b> 반영되는 <b>{plan.applied}개만</b> 적용하는 것을 확인했어요{plan.deactivates && `. ‘${plan.deactivates}’ 필터가 꺼지는 것도 확인했어요`}.</span></label>
      <div class="save-row gi-save"><span class="gi-total">적용하면 규칙 <b class="num">{plan.total}</b>개{plan.mode === 'replace' ? ' (바꾸기)' : plan.mode === 'append' ? ' (덧붙이기)' : ''}</span><div class="r"><a class="btn ghost" href="#filters" aria-disabled={busy} onClick={event => {if (busy) event.preventDefault();}}>취소</a><button class="btn pri" type="button" disabled={busy || !confirmed} aria-describedby={!confirmed ? 'gi-why' : undefined} onClick={() => {if (confirmed && !busy) onConfirm();}}>{plan.applied}개 적용</button></div></div>
      {!confirmed && <p class="rule-note" id="gi-why">위 확인을 체크하면 적용할 수 있어요.</p>}
    </> : <><p role="status">반영할 수 있는 규칙이 없어요. 이유를 확인하고 다른 파일을 골라 주세요.</p><div class="save-row gi-save"><div class="r"><a class="btn ghost" href="#filters" aria-disabled={busy} onClick={event => {if (busy) event.preventDefault();}}>취소</a></div></div></>}
  </div>;
}

export default function ImportReview({ report, pending, busy, onConfirm }) {
  const [confirmed, setConfirmed] = useState(false);
  let index = 0;
  const items = report.items.map(item => ({...item, status: item.status === 'unconvertible' ? 'no' : item.status, rule: item.rule ?? (item.status !== 'unconvertible' && item.status !== 'no' ? report.rules?.[index++] : undefined)}));
  const applied = items.filter(item => item.status !== 'no').length;
  return <section class="import-review gi-body" aria-labelledby="import-title"><h2 id="import-title">기존 필터 가져오기</h2>
    <p>아래 규칙과 달라지는 동작을 확인해 주세요. 가져와서 켜면 기존 필터는 꺼지고 원본은 보관돼요.</p>
    <ImportTable items={items}/>
    {pending && <ImportConsent plan={report.plan ?? {mode:'new',existing:0,applied,total:applied,deactivates:report.sourceName}} dropped={items.length - applied} confirmed={confirmed} onChange={setConfirmed} busy={busy} onConfirm={onConfirm}/>}
  </section>;
}
