import { useEffect, useRef, useState } from 'preact/hooks';
import { messageDocument, messageSandbox } from '../reader.js';
import { adjustMailContrast, parseMailColor } from '../theme/mail-contrast.js';
export default function MessageFrame({message}) {
  const frame=useRef(null),contrastCounts=useRef(new WeakMap()),[theme,setTheme]=useState(0),[height,setHeight]=useState(180),[original,setOriginal]=useState(false),[adjusted,setAdjusted]=useState(false);
  useEffect(()=>{const update=()=>setTheme(value=>value+1);document.addEventListener('webmail:apply',update);return()=>document.removeEventListener('webmail:apply',update);},[]);
  const style=getComputedStyle(document.documentElement);
  const darkHtml=document.documentElement.dataset.mode==='dark'&&message.html!=null;
  const source=messageDocument(message,{original:darkHtml&&original,mode:document.documentElement.dataset.mode,fontSize:style.getPropertyValue('--fs-read'),ink:style.getPropertyValue('--ink'),surface:style.getPropertyValue('--surface'),link:style.getPropertyValue('--accent-ink'),radius:style.getPropertyValue('--r-card'),sunken:style.getPropertyValue('--sunken'),line:style.getPropertyValue('--line-2'),muted:style.getPropertyValue('--ink-2')});
  useEffect(()=>{
    const element=frame.current;let active=true,scheduled;
    const resize=()=>{if(!active)return;const body=element.contentDocument?.body;if(body)setHeight(Math.max(80,Math.ceil(body.getBoundingClientRect().height)));};
    const schedule=()=>{cancelAnimationFrame(scheduled);scheduled=requestAnimationFrame(resize);};
    const loaded=()=>{
      const document=element.contentDocument;
      document?.querySelectorAll('img[data-wm-blocked]').forEach(image=>{const placeholder=document.createElement('div');placeholder.className='ph';placeholder.textContent='외부 이미지 1개 — 차단됨';placeholder.setAttribute('role','img');placeholder.setAttribute('aria-label',image.alt || '외부 이미지 1개 — 차단됨');image.replaceWith(placeholder);});
      if(document?.body&&darkHtml&&!original){
        if(!contrastCounts.current.has(document))contrastCounts.current.set(document,adjustMailContrast(document,parseMailColor(style.getPropertyValue('--surface')).slice(0,3)));
        setAdjusted(contrastCounts.current.get(document)>0);
      }
      schedule();document?.fonts.ready.then(schedule);
    };
    element.addEventListener('load',loaded);window.addEventListener('resize',schedule);
    if(element.contentDocument?.readyState==='complete')loaded();
    return()=>{active=false;cancelAnimationFrame(scheduled);element.removeEventListener('load',loaded);window.removeEventListener('resize',schedule);};
  },[source,theme]);
  return <>{darkHtml&&adjusted&&<div class="imgblock"><span>{original?'메일을 원래 색으로 보고 있습니다.':'메일 글씨를 어두운 화면에 맞췄습니다.'}</span><span class="r"><button class="btn sm" type="button" onClick={()=>setOriginal(value=>!value)}>{original?'어둡게 맞추기':'원래 색으로 보기'}</button></span></div>}<div class="body" style={darkHtml&&original?{maxWidth:'none'}:undefined}><div style={darkHtml&&original?{padding:'18px',background:'#ffffff',borderRadius:'var(--r-card)'}:undefined}><iframe ref={frame} class="message-frame" title="메일 본문" sandbox={messageSandbox} srcDoc={source} style={{height:`${height}px`}}/></div></div></>;
}
