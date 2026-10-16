import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { prefs, prefsSaving, updatePrefs } from '../state/prefs.js';
import { WM_THEMES as themes, WM_THEME_ORDER as order } from '../theme/themes.js';
import { WM_C } from '../theme/contrast.js';
import { derive } from '../theme/apply.js';
import Icon from '../components/Icon.jsx';
import './settings.css';

const layouts = {
  pane: [['none','없음','목록을 누르면 읽기 화면으로 바뀝니다'],['right','오른쪽','목록 옆에 읽기 창(3단)']],
  density: [['normal','보통','한 줄에 여유'],['compact','촘촘','한 화면에 더 많이']],
  compose: [['float','떠 있는 창','오른쪽 아래 작은 창'],['drawer','오른쪽 서랍','목록 위로 서랍처럼'],['full','화면 전체','작업 면 전체를 씀']],
};
function diagram(kind,value) {
  const rect=(left,top,width,height,opacity=.35)=><i style={{left:`${left}%`,top:`${top}%`,width:`${width}%`,height:`${height}%`,opacity}}/>;
  if(kind==='pane')return value==='none'?<>{rect(4,8,22,84)}{rect(30,8,66,84,.2)}</>:<>{rect(4,8,22,84)}{rect(30,8,28,84,.2)}{rect(61,8,35,84,.55)}</>;
  if(kind==='density')return (value==='normal'?[12,34,56,78]:[8,22,36,50,64,78]).map(top=>rect(8,top,84,value==='normal'?12:8));
  return <>{rect(4,8,92,84,.15)}{value==='float'?rect(56,40,38,52,.7):value==='drawer'?rect(48,8,48,84,.7):rect(4,8,92,84,.7)}</>;
}
function Preview({layout}) {
  const box=(left,top,width,height,background,extra={})=><i style={{left:`${left}%`,top:`${top}%`,width:`${width}%`,height:`${height}%`,background,...extra}}/>;
  const rows=layout.density==='compact'?8:5,listWidth=layout.pane==='right'?30:72;
  return <aside class="pvbox" aria-label="미리보기"><header><span class="live"/>미리보기 — 지금 설정</header><div class="pvb">
    <div class="lay" aria-hidden="true">{box(2,4,20,92,'transparent')}{box(4,8,16,8,'var(--accent)')}{[22,30,38].map(top=>box(4,top,14,4,'var(--line-2)'))}{box(24,4,listWidth+2,92,'var(--surface)',{border:'1px solid var(--line)'})}{Array.from({length:rows},(_,i)=>box(26,10+i*80/rows,listWidth-2,80/rows*.55,i===1?'var(--sel)':'var(--line-2)'))}{layout.pane==='right'&&<>{box(58,4,40,92,'var(--surface)',{border:'1px solid var(--line)'})}{box(61,12,26,6,'var(--ink)')}{[24,32,40,48].map(top=>box(61,top,33,3.5,'var(--line-2)'))}</>}{layout.compose==='float'?box(66,46,30,50,'var(--surface)',{border:'1px solid var(--accent-ui)',boxShadow:'var(--float)'}):layout.compose==='drawer'?box(52,6,46,88,'var(--surface)',{border:'1px solid var(--accent-ui)',boxShadow:'var(--float)'}):<>{box(24,4,74,92,'var(--surface)',{border:'1px solid var(--accent-ui)'})}{box(28,12,30,5,'var(--ink)')}{[24,32,40].map(top=>box(28,top,66,3.5,'var(--line-2)'))}</>}</div>
    <div class="lay-cap">읽기 창 <b>{layouts.pane.find(row=>row[0]===layout.pane)[1]}</b> · 목록 <b>{layouts.density.find(row=>row[0]===layout.density)[1]}</b> · 쓰기 <b>{layouts.compose.find(row=>row[0]===layout.compose)[1]}</b> (테두리 강조 = 쓰기 창 자리)</div>
    <div class="pvrow"><span class="dot c2" style={{margin:0}}/><b>박지아</b> 2차 시안 리뷰<span>오전 9:12</span></div><div class="pvrow n"><span class="dot c1" style={{margin:0}}/>김민준 견적서 회신<span>어제</span></div>
    <div class="preview-actions"><span class="btn pri sm">보내기</span><span class="btn sm">임시 저장</span><span class="chip c2">하늘 프로젝트</span></div><div class="preview-text">본문 속 <a class="ac" href="#settings">강조색 링크</a>와 <span>강조 글자</span></div>
  </div></aside>;
}
export default function SettingsPage() {
  const state=prefs.value, theme=themes[state.theme], layout=state.layout||theme.layout;
  const [mode,setMode]=useState(document.documentElement.dataset.mode);
  useEffect(()=>{const apply=()=>setMode(document.documentElement.dataset.mode);document.addEventListener('webmail:apply',apply);return()=>document.removeEventListener('webmail:apply',apply);},[]);
  const custom=state.accent[state.theme], swatch=theme.swatches[typeof custom==='number'?custom:0];
  const color=typeof custom==='string'?custom:swatch[mode==='dark'?2:1];
  const [hex,setHex]=useState(color);
  useEffect(()=>setHex(color),[color]);
  const contrast=derive(state.theme,mode);
  const setAccent=value=>updatePrefs({accent:{...prefs.value.accent,[prefs.value.theme]:value}});
  function radioKeys(event) {
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    const group=event.target.closest('[role=radiogroup]');if(!group)return;
    const buttons=[...group.querySelectorAll('[role=radio]')],index=buttons.indexOf(event.target);if(index<0)return;
    event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+buttons.length)%buttons.length;buttons[next].focus();buttons[next].click();
  }
  return <section class="view settings-view" aria-labelledby="page-title" onKeyDown={radioKeys}>
    <div class="set-head"><div class="crumb"><a href="#settings">설정</a><Icon name="right" size="xs"/>화면</div><h1 id="page-title">보기 설정</h1><nav class="tabs" aria-label="설정"><a href="#settings" aria-current="page">보기</a><a href="#filters">필터·규칙</a><a href="#storage">저장 공간</a><a href="#password">암호</a></nav></div>
    <div class="scroll"><div class="set-body"><div class="vs"><div>
      <section><h2>테마</h2><p>색·글꼴·모서리·간격이 함께 바뀝니다. 고르면 바로 화면 전체에 반영돼요.</p><div class="tcards" role="radiogroup" aria-label="테마">{order.map(key=>{const t=themes[key],v=t[mode],accent=state.accent[key],a=typeof accent==='string'?accent:t.swatches[typeof accent==='number'?accent:0][mode==='dark'?2:1],side=/^#/.test(v['--side-bg'])?v['--side-bg']:v['--side-bg']==='transparent'?v['--canvas']:v['--surface'];return <button class="tcard" type="button" role="radio" aria-checked={key===state.theme} tabIndex={key===state.theme?0:-1} onClick={()=>updatePrefs({theme:key})}><span class="thumb" aria-hidden="true" style={{'--t-canvas':v['--canvas'],'--t-side':side,'--t-surface':v['--surface'],'--t-line':v['--line-2'],'--t-ink':v['--ink'],'--t-accent':a,'--t-r':`${Math.min(parseInt(t.shape['--r-main'])/2,6)}px`,'--t-gap':parseInt(t.shape['--app-gap'])?'4px':'0px','--t-pad':key==='seland'?'5px':key==='ink'?'4px 4px 4px 0':'0px'}}><span class="ts"><i/><i/><i/><i/></span><span class="tm"><i/><i class="a"/><i/><i/></span></span><b><Icon name="check" size="xs"/>{t.name}</b><small>{t.desc}</small></button>;})}</div></section>
      <section><h2>밝기</h2><p>‘기기 설정 따름’이면 컴퓨터·휴대폰의 다크 모드를 따라갑니다.</p><div class="seg settings-modes" role="radiogroup" aria-label="밝기">{[['light','라이트'],['dark','다크'],['system','기기 설정 따름']].map(([value,label])=><button type="button" role="radio" aria-checked={state.mode===value} aria-pressed={state.mode===value} tabIndex={state.mode===value?0:-1} onClick={()=>updatePrefs({mode:value})}>{label}</button>)}</div></section>
      <section><h2>강조색</h2><p>단추·선택 표시·링크에 쓰는 색입니다. 테마마다 따로 기억합니다. 고른 색 위 글자와 글자로 쓰는 강조색은 읽기 쉽게 자동으로 맞춥니다.</p><div class="sws named" role="radiogroup" aria-label="강조색 견본">{theme.swatches.map((row,i)=><span class="swi"><button class="swb" type="button" role="radio" aria-label={row[0]} aria-checked={(custom??0)===i} tabIndex={(custom??0)===i||typeof custom==='string'&&i===0?0:-1} style={{background:row[mode==='dark'?2:1],color:WM_C.ratio(WM_C.hex(row[mode==='dark'?2:1]),[255,255,255])>=WM_C.ratio(WM_C.hex(row[mode==='dark'?2:1]),[0,0,0])?'#FFFFFF':'#000000'}} onClick={()=>setAccent(i)}><Icon name="check"/></button><span class="lb" aria-hidden="true">{row[0]}</span></span>)}</div>
      <div class="custom"><label for="settings-color">직접 지정</label><input type="color" id="settings-color" value={color} onInput={event=>setAccent(event.currentTarget.value)}/><input class="inp" aria-label="색 코드" value={hex} maxLength="7" onInput={event=>{const value=event.currentTarget.value;setHex(value);if(/^#[a-f0-9]{6}$/i.test(value))setAccent(value);}} onBlur={()=>setHex(color)}/><button class="btn sm ghost" type="button" onClick={()=>setAccent(0)}>견본으로 되돌리기</button></div>
      <div class="cr">{[['강조색 (단추·선택 바탕)',contrast.accent,typeof custom==='string'?'직접 지정':''],['그 위 글자 — 흑/백 중 자동 선택',contrast.onAccent,`${contrast.onRatio.toFixed(2)}:1 통과`],['글자로 쓸 때 (링크·강조 글자)',contrast.accentInk,`${contrast.inkRatio.toFixed(2)}:1 ${contrast.inkFixed?'자동 보정':'통과'}`],['선·채움 (켜기 단추·막대·포커스, 3:1)',contrast.ui,contrast.uiFixed?'자동 보정':'통과']].map(([label,value,detail])=><div><span>{label}</span><span class="v"><i style={{background:value}}/>{value} · {detail}</span></div>)}</div></section>
      <section><h2>폴더 색 견본</h2><p>내 폴더에 고를 수 있는 색입니다. 라이트·다크 각각 이 테마에 맞춘 한 벌이 있어, 모드를 바꿔도 같은 라벨은 같은 색 계열로 보입니다.</p><div class="labsets">{['light','dark'].map(value=><div class="labset" style={{background:theme[value]['--surface'],border:`1px solid ${theme[value]['--line']}`,color:theme[value]['--ink']}}><h4 style={{color:theme[value]['--ink-2']}}>{value==='light'?'라이트':'다크'}{value===mode?' · 지금':''}</h4>{theme.labels[value].map((label,i)=><span class="chip" style={{'--c-bg':label[0],'--c-ink':label[1],'--c-dot':label[2]}}>{['기본','거래처','하늘 프로젝트','인사·총무','세금계산서','뉴스레터','디자인 리뷰','보관'][i]}</span>)}</div>)}</div></section>
      <section><h2>배치</h2><p>테마를 고르면 그 테마의 기본 배치가 따라옵니다. 여기서 직접 바꾸면 테마를 바꿔도 그 선택을 그대로 둡니다.</p>{Object.entries(layouts).map(([kind,rows])=><div class="opt-row"><span>{kind==='pane'?'읽기 창':kind==='density'?'목록 간격':'쓰기 창'}</span><div class="opts" role="radiogroup" aria-label={kind==='pane'?'읽기 창':kind==='density'?'목록 간격':'쓰기 창'}>{rows.map(([value,label,description])=><button class="optc" type="button" role="radio" aria-checked={layout[kind]===value} tabIndex={layout[kind]===value?0:-1} onClick={()=>updatePrefs({layout:{...(prefs.value.layout||themes[prefs.value.theme].layout),[kind]:value}})}><span class="dg" aria-hidden="true">{diagram(kind,value)}</span>{label}<small>{description}</small></button>)}</div></div>)}<div class="lstate">{state.layout?<><span>직접 바꾼 배치를 쓰는 중 (테마를 바꿔도 유지)</span><button class="btn sm" type="button" onClick={()=>updatePrefs({layout:null})}>테마 기본 배치로</button></>:<span>‘{theme.name}’ 테마의 기본 배치를 따르는 중</span>}</div></section>
    </div><Preview layout={layout}/></div><span class="sr" role="status">{prefsSaving.value?'설정을 저장하는 중…':''}</span></div></div>
  </section>;
}

export function LayoutPicker() {
  const [open,setOpen]=useState(false),root=useRef(null),trigger=useRef(null),popup=useRef(null);
  const state=prefs.value,layout=state.layout||themes[state.theme].layout;
  function close(){setOpen(false);trigger.current.focus({preventScroll:true});}
  useLayoutEffect(()=>{
    if(!open)return;
    popup.current.querySelector('select').focus({preventScroll:true});
    const outside=event=>{if(!root.current.contains(event.target))setOpen(false);};
    const escape=event=>{if(event.key==='Escape'){event.preventDefault();close();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  return <div class="layout-control" ref={root}>
    <button class="ib" type="button" ref={trigger} aria-label="보기 배치" title="보기 배치" aria-expanded={open} aria-haspopup="dialog" onClick={()=>setOpen(!open)}><Icon name="layers"/></button>
    {open&&<section class="pop layout-menu" ref={popup} role="dialog" aria-label="보기 배치"><h5>보기 배치</h5>{Object.entries(layouts).map(([kind,rows])=><label key={kind}>{kind==='pane'?'읽기 창':kind==='density'?'목록 간격':'쓰기 창'}<select class="inp" aria-label={kind==='pane'?'읽기 창':kind==='density'?'목록 간격':'쓰기 창'} value={layout[kind]} onChange={event=>updatePrefs({layout:{...(prefs.value.layout||themes[prefs.value.theme].layout),[kind]:event.currentTarget.value}})}>{rows.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>)}</section>}
  </div>;
}
