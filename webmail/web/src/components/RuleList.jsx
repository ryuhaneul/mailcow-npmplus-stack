import { useState } from 'preact/hooks';
import Icon from './Icon.jsx';
import { folders, folderColor } from '../state/folders.js';

export function Condition({ condition: c }) {
  if (c.conditions) return <>({c.conditions.map((child, i) => <span key={i}>{i > 0 && (c.match === 'all' ? ' 그리고 ' : ' 또는 ')}<Condition condition={child}/></span>)})</>;
  if (c.field === 'attachment') return <>첨부파일이 있으면</>;
  const field = c.field === 'subject' ? '제목' : c.field === 'from' ? '보낸 사람' : '받는 사람(To·Cc)';
  if (c.op === 'eq') return <>{field}{c.field === 'subject' ? '이' : ' 주소가'} <b>{c.value}</b>과 같으면</>;
  if (c.op === 'matches') return <>{field}{c.field === 'subject' ? '이' : ' 주소가'} 패턴 <b>{c.value}</b>에 맞으면</>;
  if (c.op === 'start') return <>{field}{c.field === 'subject' ? '이' : ' 주소가'} <b>{c.value}</b>으로 시작하면</>;
  return <>{field}{c.field === 'subject' ? '에' : ' 이름·주소에'} <b>{c.value}</b>{c.op === 'not' ? '이 없으면' : '이 있으면'}</>;
}
export function RuleSummary({ rule }) {
  const a = rule.actions;
  const actions = [];
  if (a.move) {
    const color = folderColor(folders.value.folders.find(folder => folder.path === a.move));
    actions.push(<><span class={`chip ${color !== null ? `c${color}` : 'plain'}`}>{a.move}</span> 폴더로 옮기기</>);
  }
  if (a.trash) actions.push('삭제 (휴지통으로)');
  if (a.read) actions.push('읽음으로 표시');
  if (a.star) actions.push('별표');
  if (a.forward?.length) actions.push(`${a.forward.join(', ')}로 전달`);
  return <>{rule.conditions.map((c, i) => <span key={i}>{i > 0 && (rule.match === 'all' ? ' 그리고 ' : ' 또는 ')}<Condition condition={c}/></span>)}<span class="arrow" aria-hidden="true"> → </span><span class="to">{actions.map((action, i) => <span key={i}>{i > 0 && ' · '}{action}</span>)}</span></>;
}
function Arrow({ down = false }) {
  return <svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d={down ? 'M12 5v14m-6-6 6 6 6-6' : 'M12 19V5m-6 6 6-6 6 6'}/></svg>;
}
export default function RuleList({ rules, editable = false, busy = false, missingFolders = [], onChange }) {
  const [dragId, setDragId] = useState(null);
  function move(from, to) {
    if (from === to || from < 0 || busy || !editable) return;
    const next = [...rules]; next.splice(to, 0, next.splice(from, 1)[0]); onChange(next);
  }
  return <ul class="rules" aria-label={editable ? '필터 규칙' : '필터 규칙 (읽기 전용)'}>{rules.map((rule, i) => <li class={`rule${rule.enabled ? '' : ' off'}`} key={rule.id}
    onDragOver={event => { if (editable && !busy) event.preventDefault(); }}
    onDrop={event => {event.preventDefault(); move(rules.findIndex(r => r.id === dragId), i); setDragId(null);}}>
    <span class="grip" draggable={editable && !busy} onDragStart={event => {setDragId(rule.id); event.dataTransfer.setData('text/plain', rule.id);}} onDragEnd={() => setDragId(null)} aria-hidden="true"><svg class="i s" viewBox="0 0 24 24"><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/></svg></span>
    <span class="ord num">{i + 1}</span><div class="say"><RuleSummary rule={rule}/>{!rule.enabled && <span class="note">꺼져 있음</span>}{missingFolders.includes(rule.actions.move) && <span class="note">폴더 없음: {rule.actions.move} — 메일은 받은편지함에 남아요.</span>}</div>
    <span class="state">{rule.enabled ? '켜짐' : '꺼짐'}</span>
    {editable && <div class="ops"><button class="sw" type="button" role="switch" aria-checked={rule.enabled} aria-label={`${i + 1}번 규칙 켜기`} disabled={busy} onClick={() => onChange(rules.map(r => r.id === rule.id ? {...r, enabled: !r.enabled} : r))}/>
      <button class="ib" type="button" aria-label={`${i + 1}번 규칙 위로`} disabled={busy || i === 0} onClick={() => move(i, i - 1)}><Arrow/></button>
      <button class="ib" type="button" aria-label={`${i + 1}번 규칙 아래로`} disabled={busy || i === rules.length - 1} onClick={() => move(i, i + 1)}><Arrow down/></button>
      {!busy && <a class="ib" href={`#rule/${encodeURIComponent(rule.id)}`} aria-label={`${i + 1}번 규칙 수정`}><Icon name="pen"/></a>}
      <button class="ib" type="button" aria-label={`${i + 1}번 규칙 삭제`} disabled={busy} style="color:var(--danger)" onClick={() => onChange(rules.filter(r => r.id !== rule.id))}><Icon name="trash"/></button></div>}
  </li>)}</ul>;
}
