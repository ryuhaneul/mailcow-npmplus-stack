import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';
import { config } from '../state/config.js';
import { recipients } from '../compose.js';
import Icon from './Icon.jsx';
export default function RecipientInput({label,id,values,query,onValues,onQuery,onError,children,disabled,domain}) {
  const [items,setItems]=useState([]),[open,setOpen]=useState(false),[index,setIndex]=useState(0),[failure,setFailure]=useState(null);
  useEffect(()=>{
    setItems([]);setIndex(0);setFailure(null);
    if(config.value?.contactsEnabled===false||!query.trim())return;
    const controller=new AbortController();
    api(`/api/contacts?q=${encodeURIComponent(query.trim())}&limit=8`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setItems(value.items);setOpen(true);}}).catch(error=>{if(!controller.signal.aborted)setFailure(error);});
    return()=>controller.abort();
  },[query,config.value?.contactsEnabled]);
  function add(person) {onValues(recipients([...values,person]));onQuery('');setOpen(false);}
  function commit() {if(!query.trim())return;try{onValues(recipients(values,query));onQuery('');setOpen(false);}catch(error){onError(error);}}
  return <div class="fld"><label for={id}>{label}</label><div class="val">{values.map(person=><span class="pill" key={person.address}><i>{(person.name||person.address)[0]}</i><span title={person.address}>{person.name||person.address}</span><button type="button" disabled={disabled} aria-label={`${person.address} 빼기`} onClick={()=>onValues(values.filter(item=>item.address!==person.address))}><Icon name="x" size="xs"/></button></span>)}<input id={id} aria-label={`${label} 추가`} placeholder={domain?`이름이나 주소 · @${domain}`:'이름이나 주소'} autoComplete="off" value={query} disabled={disabled} role="combobox" aria-expanded={open&&items.length>0} aria-controls={`${id}-suggestions`} aria-activedescendant={open&&items[index]?`${id}-option-${index}`:undefined} onInput={event=>{onQuery(event.currentTarget.value);setOpen(true);}} onFocus={()=>setOpen(true)} onBlur={()=>setOpen(false)} onKeyDown={event=>{
    if(event.ctrlKey||event.metaKey)return;
    if(['ArrowDown','ArrowUp'].includes(event.key)&&items.length){event.preventDefault();setOpen(true);setIndex((index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length);}
    else if(['Enter',',',';'].includes(event.key)){event.preventDefault();if(open&&items[index])add(items[index]);else commit();}
    else if(event.key==='Escape'){event.preventDefault();setOpen(false);}
  }}/></div>{children||<span/>}{config.value?.contactsEnabled!==false&&open&&items.length>0&&<div class="pop" role="listbox" aria-label={`${label} 주소 추천`} id={`${id}-suggestions`}>{items.map((person,i)=><button class={`opt ${index===i?'hi':''}`} type="button" role="option" aria-selected={index===i} id={`${id}-option-${i}`} key={`${person.kind}-${person.address}`} onMouseDown={event=>event.preventDefault()} onClick={()=>add(person)}><i>{(person.name||person.address)[0]}</i><span>{person.name||person.address}<small>{person.address}</small></span><small>{({recent:'최근',person:'사람',team:'팀'})[person.kind]}</small></button>)}</div>}{failure&&<span class="compose-field-error" role="status">{failure.message}</span>}</div>;
}
