import { useEffect, useState } from 'preact/hooks';
import { WM_THEMES as themes, WM_THEME_ORDER as order } from '../theme/themes.js';
import { WM_C } from '../theme/contrast.js';
import { derive } from '../theme/values.js';
import Icon from './Icon.jsx';

export function radioKeys(event) {
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    const group=event.target.closest('[role=radiogroup]');if(!group)return;
    const buttons=[...group.querySelectorAll('[role=radio]')],index=buttons.indexOf(event.target);if(index<0)return;
    event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+buttons.length)%buttons.length;buttons[next].focus();buttons[next].click();
  }

export default function AppearanceSettings({ state, updatePrefs }) {
  const theme = themes[state.theme];
  const [mode,setMode]=useState(document.documentElement.dataset.mode);
  useEffect(()=>{const apply=()=>setMode(document.documentElement.dataset.mode);document.addEventListener('webmail:apply',apply);return()=>document.removeEventListener('webmail:apply',apply);},[]);
  const custom=state.accent[state.theme], swatch=theme.swatches[typeof custom==='number'?custom:0];
  const color=typeof custom==='string'?custom:swatch[mode==='dark'?2:1];
  const [hex,setHex]=useState(color);
  useEffect(()=>setHex(color),[color]);
  const contrast=derive(state.theme,mode,state.accent);
  const setAccent=value=>updatePrefs({accent:{...state.accent,[state.theme]:value}});
  return <>
      <section><h2>테마</h2><p>색·글꼴·모서리·간격이 함께 바뀝니다. 고르면 바로 화면 전체에 반영돼요.</p><div class="tcards" role="radiogroup" aria-label="테마">{order.map(key=>{const t=themes[key],v=t[mode],accent=state.accent[key],a=typeof accent==='string'?accent:t.swatches[typeof accent==='number'?accent:0][mode==='dark'?2:1],side=/^#/.test(v['--side-bg'])?v['--side-bg']:v['--side-bg']==='transparent'?v['--canvas']:v['--surface'];return <button class="tcard" type="button" role="radio" aria-checked={key===state.theme} tabIndex={key===state.theme?0:-1} onClick={()=>updatePrefs({theme:key})}><span class="thumb" aria-hidden="true" style={{'--t-canvas':v['--canvas'],'--t-side':side,'--t-surface':v['--surface'],'--t-line':v['--line-2'],'--t-ink':v['--ink'],'--t-accent':a,'--t-r':`${Math.min(parseInt(t.shape['--r-main'])/2,6)}px`,'--t-gap':parseInt(t.shape['--app-gap'])?'4px':'0px','--t-pad':key==='seland'?'5px':key==='ink'?'4px 4px 4px 0':'0px'}}><span class="ts"><i/><i/><i/><i/></span><span class="tm"><i/><i class="a"/><i/><i/></span></span><b><Icon name="check" size="xs"/>{t.name}</b><small>{t.desc}</small></button>;})}</div></section>
      <section><h2>밝기</h2><p>‘기기 설정 따름’이면 컴퓨터·휴대폰의 다크 모드를 따라갑니다.</p><div class="seg settings-modes" role="radiogroup" aria-label="밝기">{[['light','라이트'],['dark','다크'],['system','기기 설정 따름']].map(([value,label])=><button type="button" role="radio" aria-checked={state.mode===value} aria-pressed={state.mode===value} tabIndex={state.mode===value?0:-1} onClick={()=>updatePrefs({mode:value})}>{label}</button>)}</div></section>
      <section><h2>강조색</h2><p>단추·선택 표시·링크에 쓰는 색입니다. 테마마다 따로 기억합니다. 고른 색 위 글자와 글자로 쓰는 강조색은 읽기 쉽게 자동으로 맞춥니다.</p><div class="sws named" role="radiogroup" aria-label="강조색 견본">{theme.swatches.map((row,i)=><span class="swi"><button class="swb" type="button" role="radio" aria-label={row[0]} aria-checked={(custom??0)===i} tabIndex={(custom??0)===i||typeof custom==='string'&&i===0?0:-1} style={{background:row[mode==='dark'?2:1],color:WM_C.ratio(WM_C.hex(row[mode==='dark'?2:1]),[255,255,255])>=WM_C.ratio(WM_C.hex(row[mode==='dark'?2:1]),[0,0,0])?'#FFFFFF':'#000000'}} onClick={()=>setAccent(i)}><Icon name="check"/></button><span class="lb" aria-hidden="true">{row[0]}</span></span>)}</div>
      <div class="custom"><label for="settings-color">직접 지정</label><input type="color" id="settings-color" value={color} onInput={event=>setAccent(event.currentTarget.value)}/><input class="inp" aria-label="색 코드" value={hex} maxLength="7" onInput={event=>{const value=event.currentTarget.value;setHex(value);if(/^#[a-f0-9]{6}$/i.test(value))setAccent(value);}} onBlur={()=>setHex(color)}/><button class="btn sm ghost" type="button" onClick={()=>setAccent(0)}>견본으로 되돌리기</button></div>
      <div class="cr">{[['강조색 (단추·선택 바탕)',contrast.accent,typeof custom==='string'?'직접 지정':''],['그 위 글자 — 흑/백 중 자동 선택',contrast.onAccent,`${contrast.onRatio.toFixed(2)}:1 통과`],['글자로 쓸 때 (링크·강조 글자)',contrast.accentInk,`${contrast.inkRatio.toFixed(2)}:1 ${contrast.inkFixed?'자동 보정':'통과'}`],['선·채움 (켜기 단추·막대·포커스, 3:1)',contrast.ui,contrast.uiFixed?'자동 보정':'통과']].map(([label,value,detail])=><div><span>{label}</span><span class="v"><i style={{background:value}}/>{value} · {detail}</span></div>)}</div></section>
  </>;
}
