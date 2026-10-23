import { useLayoutEffect, useRef } from 'preact/hooks';
export default function ComposeEditor({signatureNonce,html,onChange,disabled,editor}) {
  const frame=useRef(null),latest=useRef({html,onChange,disabled}),reported=useRef(html),range=useRef(null),composing=useRef(false),idle=useRef(new Set());latest.current={html,onChange,disabled};
  useLayoutEffect(()=>{
    const element=frame.current;let detach;
    const theme=()=>{const root=element.contentDocument?.documentElement;if(!root)return;const source=getComputedStyle(document.documentElement);for(const key of ['--font','--ink','--ink-2','--line-2','--surface','--accent-ink'])root.style.setProperty(key,source.getPropertyValue(key));root.style.colorScheme=document.documentElement.dataset.mode;};
    const loaded=()=>{
      detach?.();const doc=element.contentDocument;doc.body.innerHTML=latest.current.html;reported.current=latest.current.html;doc.body.contentEditable=String(!latest.current.disabled);doc.body.setAttribute('role','textbox');doc.body.setAttribute('aria-label','본문');doc.body.setAttribute('aria-multiline','true');theme();
      const remember=()=>{const selection=doc.getSelection();if(selection?.rangeCount)range.current=selection.getRangeAt(0).cloneRange();};
      const changed=()=>{reported.current=doc.body.innerHTML;latest.current.onChange(reported.current);remember();};
      const start=()=>{composing.current=true;};
      const finish=()=>{for(const resolve of idle.current)resolve();idle.current.clear();};
      const end=()=>{composing.current=false;changed();finish();};
      const key=event=>{
        if(event.key==='Escape'){
          if(!element.dispatchEvent(new KeyboardEvent('keydown',{key:event.key,bubbles:true,cancelable:true})))event.preventDefault();
        }else if(event.ctrlKey&&(event.key==='Enter'||event.shiftKey&&event.key.toLowerCase()==='h')){event.preventDefault();element.dispatchEvent(new KeyboardEvent('keydown',{key:event.key,ctrlKey:true,shiftKey:event.shiftKey,bubbles:true,cancelable:true}));}
      };
      doc.addEventListener('compositionstart',start);doc.addEventListener('compositionend',end);doc.addEventListener('input',changed);doc.addEventListener('mouseup',remember);doc.addEventListener('keyup',remember);doc.addEventListener('keydown',key);
      editor.current={whenIdle(){return composing.current?new Promise(resolve=>idle.current.add(resolve)):Promise.resolve();},format(command,value){if(latest.current.disabled)return;doc.body.focus();if(range.current){const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range.current);}doc.execCommand(command,false,value);changed();}};
      detach=()=>{finish();doc.removeEventListener('compositionstart',start);doc.removeEventListener('compositionend',end);doc.removeEventListener('input',changed);doc.removeEventListener('mouseup',remember);doc.removeEventListener('keyup',remember);doc.removeEventListener('keydown',key);};
    };
    element.addEventListener('load',loaded);document.addEventListener('webmail:apply',theme);if(element.contentDocument?.readyState==='complete')loaded();
    return()=>{detach?.();element.removeEventListener('load',loaded);document.removeEventListener('webmail:apply',theme);editor.current=null;};
  },[]);
  // A signature-only replacement keeps authored nodes and their native selection alive.
  function replaceSignature(body,html){
    if(!signatureNonce)return false;
    const doc=body.ownerDocument,next=doc.createElement('template');next.innerHTML=html;
    function boundaries(root){
      const walker=doc.createTreeWalker(root,128);let start;
      for(let node=walker.nextNode();node;node=walker.nextNode()){
        if(node.parentElement?.closest('blockquote'))continue;
        if(node.data===`webmail-signature:${signatureNonce}`)start=node;
        else if(start&&node.data===`/webmail-signature:${signatureNonce}`&&start.parentNode===node.parentNode)return {start,end:node};
      }
      return null;
    }
    function region(pair){const range=doc.createRange();range.setStartBefore(pair.start);range.setEndAfter(pair.end);return range;}
    const before=boundaries(body),after=boundaries(next.content);
    if(!before&&!after)return false;
    const oldCopy=body.cloneNode(true),newCopy=next.content.cloneNode(true);
    const oldPair=boundaries(oldCopy),newPair=boundaries(newCopy);
    if(oldPair)region(oldPair).deleteContents();
    if(newPair)region(newPair).deleteContents();
    const container=doc.createElement('div');container.append(newCopy);
    if(oldCopy.innerHTML!==container.innerHTML)return false;
    let target;
    if(before){target=region(before);target.deleteContents();}
    else{
      const path=[];let parent=after.start.parentNode;
      while(parent!==next.content){path.unshift([...parent.parentNode.childNodes].indexOf(parent));parent=parent.parentNode;}
      for(const index of path)parent=parent===next.content?body.childNodes[index]:parent.childNodes[index];
      if(parent===next.content)parent=body;
      target=doc.createRange();target.setStart(parent,[...after.start.parentNode.childNodes].indexOf(after.start));target.collapse(true);
    }
    if(after)target.insertNode(region(after).cloneContents());
    return true;
  }
  // Reconcile external HTML in the same commit, before another native input can arrive.
  useLayoutEffect(()=>{const body=frame.current.contentDocument?.body;if(body){body.contentEditable=String(!disabled);if(!composing.current&&html!==reported.current){if(!replaceSignature(body,html)){body.innerHTML=html;range.current=null;}reported.current=html;}}},[html,disabled]);
  const source='<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>@font-face{font-family:Pretendard;src:url(/fonts/PretendardVariable.woff2) format("woff2");font-weight:45 920;font-display:swap}*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{padding:18px 22px 10px;font-family:var(--font);font-size:15px;line-height:1.75;color:var(--ink);background:var(--surface);outline:0;overflow-wrap:anywhere}p{margin:0 0 12px}ul{margin:0 0 12px;padding-left:22px}img{max-width:100%;height:auto}blockquote{margin:18px 0;padding-left:14px;border-left:2px solid var(--line-2);color:var(--ink-2)}.sig{margin-top:18px;padding-top:12px;border-top:1px dashed var(--line-2);font-size:13.5px;line-height:1.6;color:var(--ink-2)}.sig b{color:var(--ink)}a{color:var(--accent-ink)}</style></head><body></body></html>';
  return <div class="c-body compose-editor-wrap"><iframe ref={frame} class="compose-editor" title="서식 편집기" sandbox="allow-same-origin" srcDoc={source}/></div>;
}
