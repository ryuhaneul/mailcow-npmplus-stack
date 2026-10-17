import { useLayoutEffect, useRef } from 'preact/hooks';
export default function ComposeEditor({html,onChange,disabled,editor}) {
  const frame=useRef(null),latest=useRef({html,onChange,disabled}),reported=useRef(html),range=useRef(null),composing=useRef(false);latest.current={html,onChange,disabled};
  useLayoutEffect(()=>{
    const element=frame.current;let detach;
    const theme=()=>{const root=element.contentDocument?.documentElement;if(!root)return;const source=getComputedStyle(document.documentElement);for(const key of ['--font','--ink','--ink-2','--line-2','--surface','--accent-ink'])root.style.setProperty(key,source.getPropertyValue(key));root.style.colorScheme=document.documentElement.dataset.mode;};
    const loaded=()=>{
      detach?.();const doc=element.contentDocument;doc.body.innerHTML=latest.current.html;reported.current=latest.current.html;doc.body.contentEditable=String(!latest.current.disabled);doc.body.setAttribute('role','textbox');doc.body.setAttribute('aria-label','본문');doc.body.setAttribute('aria-multiline','true');theme();
      const remember=()=>{const selection=doc.getSelection();if(selection?.rangeCount)range.current=selection.getRangeAt(0).cloneRange();};
      const changed=()=>{reported.current=doc.body.innerHTML;latest.current.onChange(reported.current);remember();};
      const start=()=>{composing.current=true;};
      const end=()=>{composing.current=false;changed();};
      const key=event=>{if(event.ctrlKey&&(event.key==='Enter'||event.shiftKey&&event.key.toLowerCase()==='h')){event.preventDefault();element.dispatchEvent(new KeyboardEvent('keydown',{key:event.key,ctrlKey:true,shiftKey:event.shiftKey,bubbles:true,cancelable:true}));}};
      doc.addEventListener('compositionstart',start);doc.addEventListener('compositionend',end);doc.addEventListener('input',changed);doc.addEventListener('mouseup',remember);doc.addEventListener('keyup',remember);doc.addEventListener('keydown',key);
      editor.current={format(command,value){if(latest.current.disabled)return;doc.body.focus();if(range.current){const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range.current);}doc.execCommand(command,false,value);changed();}};
      detach=()=>{doc.removeEventListener('compositionstart',start);doc.removeEventListener('compositionend',end);doc.removeEventListener('input',changed);doc.removeEventListener('mouseup',remember);doc.removeEventListener('keyup',remember);doc.removeEventListener('keydown',key);};
    };
    element.addEventListener('load',loaded);document.addEventListener('webmail:apply',theme);if(element.contentDocument?.readyState==='complete')loaded();
    return()=>{detach?.();element.removeEventListener('load',loaded);document.removeEventListener('webmail:apply',theme);editor.current=null;};
  },[]);
  // Reconcile external HTML in the same commit, before another native input can arrive.
  useLayoutEffect(()=>{const body=frame.current.contentDocument?.body;if(body){body.contentEditable=String(!disabled);if(!composing.current&&html!==reported.current){body.innerHTML=html;reported.current=html;range.current=null;}}},[html,disabled]);
  const source='<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>@font-face{font-family:Pretendard;src:url(/fonts/PretendardVariable.woff2) format("woff2");font-weight:45 920;font-display:swap}*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{padding:18px 22px 10px;font-family:var(--font);font-size:15px;line-height:1.75;color:var(--ink);background:var(--surface);outline:0;overflow-wrap:anywhere}p{margin:0 0 12px}ul{margin:0 0 12px;padding-left:22px}img{max-width:100%;height:auto}blockquote{margin:18px 0;padding-left:14px;border-left:2px solid var(--line-2);color:var(--ink-2)}.sig{margin-top:18px;padding-top:12px;border-top:1px dashed var(--line-2);font-size:13.5px;line-height:1.6;color:var(--ink-2)}.sig b{color:var(--ink)}a{color:var(--accent-ink)}</style></head><body></body></html>';
  return <div class="c-body compose-editor-wrap"><iframe ref={frame} class="compose-editor" title="서식 편집기" sandbox="allow-same-origin" srcDoc={source}/></div>;
}
