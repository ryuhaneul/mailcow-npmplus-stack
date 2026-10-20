import { Fragment } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

// Highlighting is display-only. The textarea value remains the original HTML.
function tag(value) {
  const result=[];let offset=0;
  for(const match of value.matchAll(/(\s+[\w:-]+)(=)("[^"]*"|'[^']*')/g)){
    result.push(<span class="t">{value.slice(offset,match.index)}</span>,<span class="a">{match[1]}</span>,match[2],<span class="s">{match[3]}</span>);offset=match.index+match[0].length;
  }
  result.push(<span class="t">{value.slice(offset)}</span>);return result;
}
function highlight(value) {return value.split(/(<[^>]*>)/g).map((part,index)=><Fragment key={index}>{part.startsWith('<')&&part.endsWith('>')?tag(part):part}</Fragment>);}
export default function HtmlSource({html,onChange,disabled,label="HTML 원문 편집",inputRef,onPaste,onCompositionChange}) {
  const [draft,setDraft]=useState(html),[composing,setComposing]=useState(false),composition=useRef(false),input=useRef(null),display=useRef(null),change=useRef(onChange);change.current=onChange;
  function sync(){const source=input.current,pre=display.current;if(!source||!pre)return;pre.style.width=`${source.clientWidth}px`;pre.style.height=`${source.clientHeight}px`;pre.scrollTop=source.scrollTop;pre.scrollLeft=source.scrollLeft;}
  useLayoutEffect(()=>{if(!composition.current)setDraft(html);},[html]);
  useLayoutEffect(sync,[draft,composing]);
  useLayoutEffect(()=>{
    const element=input.current,observer=new ResizeObserver(sync);observer.observe(element);
    const start=()=>{composition.current=true;setComposing(true);onCompositionChange?.(true);};
    const end=()=>{composition.current=false;setComposing(false);setDraft(element.value);change.current(element.value);onCompositionChange?.(false);};
    element.addEventListener('compositionstart',start);element.addEventListener('compositionend',end);
    return()=>{observer.disconnect();element.removeEventListener('compositionstart',start);element.removeEventListener('compositionend',end);};
  },[]);
  return <div class={`code compose-source-shell ${composing?'is-composing':''}`}><pre ref={display} class="compose-source-pre" aria-hidden="true">{draft.replace(/\r\n?/g,'\n').split('\n').map((line,index)=><span class="compose-source-line" data-line={index+1} key={index}>{line?highlight(line):'\u200b'}</span>)}</pre><textarea ref={element=>{input.current=element;if(inputRef)inputRef.current=element;}} class="compose-source-input" aria-label={label} onPaste={onPaste} value={draft} disabled={disabled} spellCheck={false} wrap="off" onScroll={sync} onInput={event=>{const value=event.currentTarget.value;setDraft(value);if(!composition.current)onChange(value);}} onKeyDown={event=>{if(composition.current||event.isComposing)event.stopPropagation();}}/></div>;
}
