import Loading from './Loading.jsx';
import LoadError from './LoadError.jsx';
import { kst } from '../pages/status.js';
import { monitorDefinitions, monitorReason, windowText } from '../pages/monitor.js';
import '../pages/monitor.css';
export default function MonitoringStatusCards({resource}) {
  if(resource.loading)return <section aria-label="감시 상태" class="monitor-ui"><Loading/></section>;
  if(resource.error)return <section class="monitor-ui"><LoadError title="감시 상태를 불러오지 못했습니다" error={resource.error} retry={resource.reload}/></section>;
  const data=resource.data;
  if(!data)return null;
  if(!data.enabled)return <section class="monitor-ui current-section"><div class="run-summary"><b>감시 꺼짐</b><span>감시를 켜면 현재 값과 기준을 확인할 수 있습니다.</span><a class="end" href="#settings/monitor">감시 꺼짐 · 설정으로</a></div></section>;
  const stale=data.asOf&&Date.now()-Date.parse(data.asOf)>600000;
  return <section class="monitor-ui current-section" aria-labelledby="monitor-current-title"><div class="panel-head"><h3 id="monitor-current-title">현재 값과 기준</h3><span class="sub">마지막 판정 {data.asOf?kst(data.asOf):'아직 없음'}{stale?' · 오래된 판정':''}</span></div><div class="cards current-cards">{monitorDefinitions.map(d=>{
    const windows=data.metrics?.find(m=>m.item===d.id)?.windows??[], first=windows[0], status=windows.some(w=>w.complete&&w.status==='exceeded')?'exceeded':windows.some(w=>w.complete&&w.status==='warning')?'warning':windows.every(w=>w.complete)&&windows.length?'normal':'unknown';
    return <a class={`metric-card ${status==='exceeded'?'exceeded':status==='warning'?'at-threshold':''}`} href="#settings/monitor" key={d.id} aria-label={`${d.card??d.name} · 감시 설정으로`}><div class="panel-head"><h3>{d.card??d.name}</h3><span class={`chip ${status==='exceeded'?'danger':status==='warning'?'warn':'neutral'}`}>{{exceeded:'초과',warning:'주의',normal:'정상',unknown:'확인 불가'}[status]}</span></div><div class={`current ${status==='exceeded'?'value-over':''}`}>{first?.complete?first.value:'—'} <small>{d.unit}</small></div><p class="target">{first?.complete?(first.target==='all'?'전체':first.target??'해당 대상 없음'):monitorReason(first?.reason)}</p><div class="meter" role="img" aria-label={first?.complete?`현재 ${first.value}${d.unit}, 기준 ${first.threshold}${d.unit}`:'현재 값 확인 불가'}><span style={{width:first?.complete?`${Math.min(100,first.value/first.threshold*100)}%`:'0%'}}/></div>{windows.map(w=><p class="current-baseline" key={w.windowMinutes}>{windowText(w.windowMinutes)} · 기준 <b>{w.threshold}{d.unit}</b>{w!==first&&<> · 현재 {w.complete?`${w.value}${d.unit}`:'확인 불가'}{w.target&&w.target!=='all'?` · ${w.target}`:''}</>}{!w.complete&&<small class="detail-time">{monitorReason(w.reason)}{w.previous&&` · 이전 ${w.previous.value}${d.unit} (${kst(w.previous.observedAt)})`}</small>}</p>)}<span class="detail-time">{first?.observedAt?`조회 ${kst(first.observedAt)} · `:''}감시 설정으로</span></a>;
  })}</div><p class="hint">저장된 기준과 비교한 값입니다. 계정·전체는 5분과 1시간을 각각 판정합니다. SMTP 접수 시도 메시지 수이며 BCC도 1통입니다.</p></section>;
}
