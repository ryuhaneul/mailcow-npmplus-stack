import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import Icon from './Icon.jsx';
function description(person) {
  const kind=({self:'본인 주소',alias:'별칭',acl:'보내기 권한'})[person?.kind]||'보내기 권한',name=person?.name?.trim();
  return kind+(name&&!/\S+@\S+/.test(name)?` · ${name}`:'');
}
export default function FromPicker({identities,from,onChange,disabled}) {
  const [open,setOpen]=useState(false),[manual,setManual]=useState(!identities.identities.some(item=>item.address===from)),root=useRef(null),popup=useRef(null),item=identities.identities.find(item=>item.address===from),custom=identities.anyAddress||identities.anyAtDomains.length>0;
  const focusButton=()=>root.current.querySelector('.from-sel').focus({preventScroll:true});
  useEffect(()=>{if(!open)return;const close=event=>{if(event.type==='keydown'?event.key==='Escape':!root.current.contains(event.target)){setOpen(false);if(event.type==='keydown')focusButton();}};document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close);};},[open]);
  useLayoutEffect(()=>{
    if(!open)return;
    const menu=popup.current,viewport=window.visualViewport;
    const resize=()=>menu.style.setProperty('--from-menu-height',`${Math.max(0,(viewport?viewport.height+viewport.offsetTop:window.innerHeight)-menu.getBoundingClientRect().top-12)}px`);
    resize();
    const selected=menu.querySelector('[aria-selected=true]');selected?.focus({preventScroll:true});selected?.scrollIntoView({block:'nearest'});
    window.addEventListener('resize',resize);viewport?.addEventListener('resize',resize);
    return()=>{window.removeEventListener('resize',resize);viewport?.removeEventListener('resize',resize);};
  },[open]);
  function keyboard(event) {
    if(open&&event.key==='Escape'){event.preventDefault();setOpen(false);focusButton();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||event.target.matches('input'))return;
    if(!open){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setOpen(true);}return;}
    event.preventDefault();
    const options=[...popup.current.querySelectorAll('[role=option]')],index=options.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,index+(event.key==='ArrowDown'?1:-1)));
    options[next]?.focus({preventScroll:true});options[next]?.scrollIntoView({block:'nearest'});
  }
  return <div class="fld" ref={root} onKeyDown={keyboard}><label>보낸 사람</label><div class="val"><button class="from-sel" type="button" disabled={disabled} aria-label="보낸 사람 선택" aria-haspopup="listbox" aria-expanded={open} onClick={()=>setOpen(!open)}><b>{from||'직접 입력'}</b><span>{manual?'직접 입력':description(item)}</span><Icon name="down" size="xs"/></button>{custom&&manual&&<input aria-label="보낸 사람 직접 입력" placeholder={identities.anyAddress?'보낼 주소 직접 입력':identities.anyAtDomains.join(', ')} value={from} disabled={disabled} onInput={event=>onChange(event.currentTarget.value)}/>}</div><span/>{open&&<div class="pop from-menu" ref={popup} role="listbox" aria-label="보낼 주소"><h5>보낼 주소 고르기</h5>{identities.identities.map(person=><button class={`opt ${!manual&&person.address===from?'hi':''}`} type="button" role="option" aria-selected={!manual&&person.address===from} key={person.address} onClick={()=>{onChange(person.address);setManual(false);setOpen(false);focusButton();}}><i>{person.address[0]}</i><span><b>{person.address}</b><small>{description(person)}</small></span>{person.address===from&&<Icon name="check"/>}</button>)}{custom&&<button class="opt" type="button" role="option" aria-selected={manual} onClick={()=>{setManual(true);setOpen(false);focusButton();}}><i><Icon name="pen"/></i><span>주소 직접 입력<small>{identities.anyAddress?'모든 주소':identities.anyAtDomains.join(', ')}</small></span></button>}{custom&&<p class="compose-grants">{identities.anyAddress?'보낼 주소를 직접 입력할 수 있어요.':`${identities.anyAtDomains.join(', ')} 도메인의 아무 주소로 보낼 수 있어요.`}</p>}</div>}</div>;
}
