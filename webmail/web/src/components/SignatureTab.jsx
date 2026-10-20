import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import DOMPurify from 'dompurify';
import HtmlSource from './HtmlSource.jsx';
import Icon from './Icon.jsx';
import SignatureList from './SignatureList.jsx';
import SignatureDefaults from './SignatureDefaults.jsx';
import SignatureDialog from './SignatureDialog.jsx';
import SignatureImageLibrary from './SignatureImageLibrary.jsx';
import { normalizeSignature, signatureError } from '../signatures.js';
import { createSignatureImageMap, signatureImageCid } from '../signature-images.js';
import { loadSignatures, saveSignatures, selectedSignatureId, signatureImages, addSignatureImage, loadSignatureImages } from '../state/signatures.js';
import { session } from '../state/session.js';
import './signature.css';

const formats = [
  ['굵게','bold','M7 5h6.5a3.5 3.5 0 0 1 0 7H7ZM7 12h7.5a3.5 3.5 0 0 1 0 7H7Z'],
  ['기울임','italic','M19 4h-9M14 20H5M15 4 9 20'],
  ['밑줄','underline','M6 4v6a6 6 0 0 0 12 0V4M4 20h16'],
  ['취소선','strikeThrough','M16 4H9a4 4 0 0 0-4 4M20 12H4m2 8h9a4 4 0 0 0 4-4'],
  ['글머리 목록','insertUnorderedList','M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01'],
  ['번호 목록','insertOrderedList','M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'],
];
const clean = html => DOMPurify.sanitize(html, { USE_PROFILES: {html:true}, ALLOWED_URI_REGEXP: /^(?:(?:https?|cid|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i, FORBID_TAGS: ['style','form','input','button','textarea','select','iframe'], FORBID_ATTR: ['srcset'] });

// Keep each visited editor mounted: its source selection, DOM Range and scroll belong to its ID.
function SignatureEditor({ item, visible, disabled, onChange, register, onWorking }) {
  const [mode, setMode] = useState('rich'), [ready, setReady] = useState(false), [working, setWorking] = useState(false);
  const [error, setError] = useState(null), [message, setMessage] = useState(''), [image, setImage] = useState(null), [preview, setPreview] = useState(null);
  const [pressed, setPressed] = useState({}), [composing, setComposing] = useState(false);
  const editor = useRef(null), source = useRef(null), range = useRef(null), map = useRef(null), alive = useRef(false), version = useRef(0), current = useRef(item), last = useRef(null), composition = useRef(false), lock = useRef(false);
  current.current = item;
  const blockedHttp = useRef(new Map());
  const locked = (disabled && !composing) || working;
  function displaySource(src) {
    if (location.protocol !== 'https:' || !/^http:/i.test(src)) return src;
    for (const [placeholder, original] of blockedHttp.current) if (original === src) return placeholder;
    // A local transparent placeholder keeps the URL in the JS map without fetching HTTP.
    const bytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), value => value.charCodeAt(0));
    const placeholder = URL.createObjectURL(new Blob([bytes], {type:'image/gif'}));
    blockedHttp.current.set(placeholder,src); return placeholder;
  }
  function canonicalHtml(html) {
    const template = document.createElement('template'); template.innerHTML = html;
    for (const img of template.content.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (blockedHttp.current.has(src)) img.setAttribute('src',blockedHttp.current.get(src));
    }
    return map.current.canonicalHtml(template.innerHTML);
  }
  function remember() {
    const selection = getSelection();
    if (selection?.rangeCount && editor.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) range.current = selection.getRangeAt(0).cloneRange();
    setPressed(Object.fromEntries(formats.map(([, command]) => [command, document.queryCommandState(command)])));
  }
  function changed(html) { version.current++; last.current = html; onChange(html); setPreview(null); }
  function richChanged() { changed(canonicalHtml(editor.current.innerHTML)); if(image && !editor.current.contains(image))setImage(null); remember(); }
  function restore(captured = range.current) {
    editor.current.focus({preventScroll:true});
    const selection = getSelection(); selection.removeAllRanges();
    if (captured && editor.current.contains(captured.commonAncestorContainer)) selection.addRange(captured);
    else { const end = document.createRange(); end.selectNodeContents(editor.current); end.collapse(false); selection.addRange(end); }
  }
  async function project(html) {
    const display = document.createElement('template');
    display.innerHTML = clean(await map.current.displayHtml(html));
    for (const img of display.content.querySelectorAll('img')) if (/^http:/i.test(img.getAttribute('src') || '')) img.setAttribute('src',displaySource(img.getAttribute('src')));
    return display.innerHTML;
  }
  async function run(action) {
    if (lock.current || disabled || composition.current) return;
    const focused = document.activeElement;
    lock.current = true; setWorking(true); onWorking(true); setError(null);
    try { return await action(); }
    catch (value) { if (alive.current) setError(signatureError(value)); throw value; }
    finally { if (alive.current) { lock.current = false; setWorking(false); onWorking(false); requestAnimationFrame(() => { if (alive.current && document.activeElement === document.body) { if(focused?.isConnected && !focused.disabled)focused.focus({preventScroll:true}); else if(mode==='html')source.current?.focus({preventScroll:true}); else if(ready)restore(); } }); } }
  }
  useEffect(() => {
    alive.current = true; map.current = createSignatureImageMap();
    return () => { alive.current = false; version.current++; map.current.dispose(); for (const url of blockedHttp.current.keys()) URL.revokeObjectURL(url); blockedHttp.current.clear(); };
  }, []);
  useEffect(() => {
    if (item.html === last.current || composition.current) return;
    let active = true; const at = version.current, html = item.html;
    normalizeSignature(html).then(async result => {
      const display = await project(result.html);
      if (active && alive.current && at === version.current) { editor.current.innerHTML = display; last.current = html; setReady(true); setError(null); range.current = null; setImage(null); }
    }).catch(value => { if (active && alive.current && at === version.current) { setError(value); setReady(false); } });
    return () => { active = false; };
  }, [item.html]);
  function compose(value) { composition.current = value; setComposing(value); onWorking(value); }
  async function switchMode(next) {
    if (next === mode || composition.current || locked) return;
    if (next === 'html') { remember(); setMode(next); setPreview(null); return; }
    const html = current.current.html, at = version.current;
    try { await run(async () => {
      const result = await normalizeSignature(html), display = await project(result.html);
      if (!alive.current || at !== version.current) return;
      editor.current.innerHTML = display; range.current = null; changed(result.html); setReady(true); setMode(next); setImage(null);
    }); } catch { /* Preserve source, mode and selection on normalization failure. */ }
  }
  async function insert(value, captured) {
    if (mode === 'html') {
      const input = source.current, start = input.selectionStart, end = input.selectionEnd;
      const template=document.createElement('template');template.innerHTML='<img>';
      const node=template.content.firstChild;node.setAttribute('src',value.src);node.alt=value.alt;node.width=value.width;
      const html = current.current.html, markup = node.outerHTML;
      changed(html.slice(0,start) + markup + html.slice(end));
      requestAnimationFrame(() => { if (alive.current) { input.focus({preventScroll:true}); input.setSelectionRange(start+markup.length,start+markup.length); } });
    } else {
      if (!ready) throw new Error('HTML을 확인한 뒤 서식 편집으로 돌아와 주세요.');
      const node = document.createElement('img');
      node.src = value.assetId ? await map.current.urlFor(value.assetId) : displaySource(value.src); node.alt = value.alt; node.width = value.width;
      if (!alive.current) return;
      restore(captured); const selection = getSelection(), target = selection.getRangeAt(0);
      target.deleteContents(); target.insertNode(node); target.setStartAfter(node); target.collapse(true); selection.removeAllRanges(); selection.addRange(target);
      richChanged(); setImage(node);
    }
  }
  useLayoutEffect(() => { register(item.id, { insert }); return () => register(item.id, null); });
  async function paste(event) {
    event.preventDefault();
    if (locked || composition.current) return;
    const clipboard = event.clipboardData, files = [...(clipboard.files || [])];
    if (mode === 'html') {
      if (files.length) { setError(new Error('이미지 파일은 서식 편집에서 붙여 넣어 주세요. 이미지는 보관함에서 넣어 주세요.')); return; }
      const input = source.current, start = input.selectionStart, text = clipboard.getData('text/plain');
      changed(current.current.html.slice(0,start) + text + current.current.html.slice(input.selectionEnd));
      requestAnimationFrame(() => input.setSelectionRange(start+text.length,start+text.length)); return;
    }
    remember(); const captured = range.current?.cloneRange(), at = version.current;
    try { await run(async () => {
      if (files.length) {
        setMessage('이미지를 보관함에 올리는 중…');
        const library = signatureImages.value || await loadSignatureImages();
        for (const file of files) {
          if (!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type)) throw signatureError({code:'SIGNATURE_IMAGE_INVALID'});
          if (file.size > library.maxFileBytes) throw signatureError({code:'SIGNATURE_IMAGE_TOO_LARGE'});
        }
        let cursor = captured, expected = at;
        for (const file of files) {
          const result = await addSignatureImage(file);
          if (!alive.current || expected !== version.current) return;
          await insert({src:signatureImageCid(result.image.id),assetId:result.image.id,alt:result.image.name,width:160},cursor);
          cursor = range.current?.cloneRange(); expected = version.current;
        }
        if (alive.current) setMessage('이미지를 보관함에 추가하고 서명에 넣었어요.');
      } else {
        const html = clipboard.getData('text/html'), text = clipboard.getData('text/plain');
        const node = document.createElement('div'); node.textContent = text;
        const result = await normalizeSignature(html || node.innerHTML), display = await project(result.html);
        if (!alive.current || at !== version.current) return;
        restore(captured); document.execCommand('insertHTML',false,display); richChanged();
      }
    }); } catch { if(alive.current)setMessage(''); }
  }
  async function showPreview() {
    if (preview !== null) { setPreview(null); return; }
    const at = version.current;
    try { await run(async () => { const result = await normalizeSignature(current.current.html), display = await project(result.html); if (alive.current && at === version.current) setPreview(display); }); } catch { /* Keep the original input. */ }
  }
  function updateImage(patch) {
    if (!image || locked) return;
    if (patch.remove) { const caret=document.createRange();caret.setStartBefore(image);caret.collapse(true);image.remove();setImage(null);restore(caret); }
    else { if (patch.width !== undefined) { image.width = Math.max(40,Math.min(600,Number(patch.width)||160)); image.removeAttribute('height'); image.style.removeProperty('width'); image.style.removeProperty('height'); } if (patch.alt !== undefined) image.alt = patch.alt; }
    richChanged();
  }
  return <section class="sig-work address-editor is-target" hidden={!visible} aria-label={`${item.name} 편집기`}>
    <div class="sig-address"><h3>{item.name}</h3><span class="target-badge">지금 편집 중</span><button class="text-action" type="button" disabled={locked || composing} onClick={showPreview}><Icon name="eye" size="s"/>{preview !== null ? '편집으로' : '미리보기'}</button></div>
    {error && <div class="sig-error" role="alert"><p>{error.message}</p>{error.code==='SIGNATURE_DATA_IMAGE' && <p>HTML 원문은 그대로예요. HTML에서 직접 담긴 이미지를 지운 뒤 보관함에서 다시 넣어 주세요.</p>}{error.reloadRequired && <><p>입력은 그대로예요. 이미지 보관함을 다시 불러온 뒤 붙여 넣어 주세요.</p><button class="btn" type="button" disabled={locked} onClick={()=>run(loadSignatureImages).catch(()=>{})}>이미지 보관함 다시 불러오기</button></>}</div>}{message && <p class="paste-message" role="status">{message}</p>}
    <div class="sig-card" hidden={preview !== null}>
      <div class="sig-modebar"><div class="seg" role="tablist" aria-label={`${item.name} 편집 방식`}>{[['rich','서식 편집'],['html','HTML']].map(([value,label]) => <button type="button" role="tab" id={`sig-${item.id}-${value}`} aria-controls={`sig-${item.id}-${value}-panel`} aria-selected={mode === value} tabIndex={mode === value ? 0 : -1} disabled={composing || (disabled && !working)} onClick={()=>switchMode(value)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'rich':event.key==='End'?'html':mode==='rich'?'html':'rich';event.currentTarget.parentElement.querySelector(`[id="sig-${item.id}-${next}"]`).focus();switchMode(next);}}}>{label}</button>)}</div><span class="hint">{mode === 'html' ? 'HTML을 직접 고쳐요' : '보이는 대로 고쳐요'}</span></div>
      <div role="tabpanel" id={`sig-${item.id}-rich-panel`} aria-labelledby={`sig-${item.id}-rich`} hidden={mode !== 'rich'}>
        <div class="sig-format" role="toolbar" aria-label={`${item.name} 서식`}>{formats.map(([label,command,path]) => <button class="ib" type="button" aria-label={label} aria-pressed={Boolean(pressed[command])} disabled={locked || !ready} onMouseDown={event=>event.preventDefault()} onClick={()=>{restore();document.execCommand(command,false);richChanged();}}><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d={path}/></svg></button>)}</div>
        <div class="paste-hint">이미지를 복사한 뒤 여기에 붙여 넣어도 돼요.</div>
        <div ref={editor} class="sig-content" role="textbox" aria-multiline="true" aria-label={`${item.name} 서명`} aria-placeholder="서명을 입력하세요." aria-busy={!ready} contentEditable={!locked && ready} tabIndex={0} onInput={()=>{if(!composition.current)richChanged();}} onCompositionStart={()=>compose(true)} onCompositionEnd={()=>{compose(false);richChanged();}} onMouseUp={remember} onKeyUp={remember} onBlur={remember} onPaste={paste} onClick={event=>setImage(event.target.tagName === 'IMG' ? event.target : null)}/>
        {image && <div class="image-controls"><label>너비 <input class="inp" type="number" min="40" max="600" value={image.width} disabled={locked} onChange={event=>updateImage({width:event.currentTarget.value})}/></label><label>대체 텍스트 <input class="inp image-alt" value={image.alt} disabled={locked} onInput={event=>updateImage({alt:event.currentTarget.value})}/></label><button class="remove" type="button" disabled={locked} onClick={()=>updateImage({remove:true})}>이미지 빼기</button></div>}
      </div>
      <div role="tabpanel" id={`sig-${item.id}-html-panel`} aria-labelledby={`sig-${item.id}-html`} hidden={mode !== 'html'}><HtmlSource html={item.html} onChange={changed} disabled={locked} label={`${item.name} HTML 원문 편집`} inputRef={source} onPaste={paste} onCompositionChange={compose}/><p class="source-help">서식 편집으로 돌아가면 지원 안 되는 부분은 빠져요.</p></div>
    </div>
    {preview !== null && <div class="preview-panel"><h3>받는 사람 화면 미리보기</h3><div class="mail-paper" dangerouslySetInnerHTML={{__html:preview}}/><p class="preview-foot">받는 사람의 설정에 따라 외부 이미지가 안 보일 수 있어요.</p></div>}
    <p class="sig-notice">보관함 이미지는 보낼 때 메일에 함께 들어가요. 주소(URL) 이미지는 받는 사람의 설정에 따라 안 보일 수 있어요.</p>
  </section>;
}

export default function SignatureTab({ identities }) {
  const owner = session.value;
  const [draft,setDraft] = useState(null), [selected,setSelected] = useState(null), [section,setSection] = useState('edit');
  const [busy,setBusy] = useState(false), [editorBusy,setEditorBusy] = useState(false), [error,setError] = useState(null), [saved,setSaved] = useState(false), [dialog,setDialog] = useState(null);
  const [revisionView,setRevisionView] = useState(0);
  const root = useRef(null), returnFocus = useRef(null), controllers = useRef(new Map()), keys = useRef(new Map()), visited = useRef(new Set()), lifetime = useRef(null), working = useRef(false);
  useEffect(() => {
    const token = {}; lifetime.current = token; keys.current.clear(); visited.current.clear(); controllers.current.clear(); setDraft(null); setError(null); setSelected(null); setEditorBusy(false); setSaved(false); setDialog(null); setSection('edit'); working.current = true; setBusy(true);
    loadSignatures().then(value=>{if(lifetime.current===token){setDraft(value);choose(value.items[0]?.id ?? null);if(revisionView)requestAnimationFrame(()=>root.current?.querySelector('.signature-items button, .list-heading button')?.focus());}}).catch(value=>{if(lifetime.current===token)setError(value);}).finally(()=>{if(lifetime.current===token){working.current=false;setBusy(false);}});
    return () => {lifetime.current=null;};
  }, [owner,revisionView]);
  function choose(id) { setSelected(id); selectedSignatureId.value = id; }
  function change(action) { setDraft(value=>action(value)); setSaved(false); }
  const locked = busy || editorBusy;
  async function save(event) {
    event.preventDefault(); if(working.current || editorBusy || !draft)return;
    const token=lifetime.current,focused=document.activeElement;working.current=true;setBusy(true);setError(null);setSaved(false);
    try {
      const value=await saveSignatures(draft);
      if(lifetime.current!==token)return;
      for(const [oldId,newId] of Object.entries(value.idMap || {})){keys.current.set(newId,keys.current.get(oldId)||oldId);keys.current.delete(oldId);}
      setDraft(value);choose(selectedSignatureId.value);setSaved(true);
    }catch(value){if(lifetime.current===token)setError(value);}
    finally{if(lifetime.current===token){working.current=false;setBusy(false);requestAnimationFrame(()=>{if(lifetime.current===token&&document.activeElement===document.body&&focused?.isConnected)focused.focus({preventScroll:true});});}}
  }
  function open(type,id) {
    returnFocus.current=document.activeElement;
    // The new-signature button survives removal of the last list entry.
    if(type==='delete')returnFocus.current=root.current.querySelector('.list-heading button');
    setDialog({type,id});
  }
  function confirm(name) {
    const {type,id}=dialog, original=draft.items.find(item=>item.id===id);
    if(type==='new'||type==='copy') {
      const next={id:`client-${crypto.randomUUID()}`,name,html:type==='copy'?original.html:''};
      change(value=>({...value,items:[...value.items,next]}));choose(next.id);
    } else if(type==='rename') change(value=>({...value,items:value.items.map(item=>item.id===id?{...item,name}:item)}));
    else if(type==='delete') {
      change(value=>({...value,items:value.items.filter(item=>item.id!==id),defaults:Object.fromEntries(Object.entries(value.defaults).map(([address,fields])=>[address,Object.fromEntries(Object.entries(fields).map(([field,value])=>[field,value===id?null:value]))]))}));
      if(selected===id)choose(draft.items.find(item=>item.id!==id)?.id ?? null);
    }
    setDialog(null);
  }
  return <div class="signature-settings variant-d" ref={root} aria-busy={locked}>
    {error && <div class="sig-error" role="alert"><p>{error.message}</p>{error.reloadRequired && <p>입력은 그대로 남아 있어요. 필요한 내용을 복사한 뒤 다시 불러와 주세요.</p>}<button class="btn" type="button" disabled={locked} onClick={()=>setRevisionView(value=>value+1)}>다시 불러오기</button></div>}
    {!draft ? !error && <p role="status">서명을 불러오는 중이에요.</p> : <form aria-label="서명 설정" onSubmit={save}>
      <div class="sig-heading"><div><h2>서명</h2><p>이름을 붙여 만들어 두고, 메일에 맞게 골라 쓰세요.</p></div></div>
      <nav class="d-section-nav" aria-label="서명 설정 화면">{[['edit','서명 편집'],['defaults','주소별 기본값']].map(([value,label])=><button type="button" aria-current={section===value?'page':undefined} disabled={locked} onClick={()=>setSection(value)}>{label}</button>)}</nav>
      {draft.notices?.map((notice,index)=><p class="sig-notice" role="status" key={index}>{notice.message}</p>)}
      <div hidden={section!=='edit'}>
        <SignatureList items={draft.items} selectedId={selected} busy={locked} onSelect={choose} onCreate={()=>open('new')} onRename={id=>open('rename',id)} onCopy={id=>open('copy',id)} onDelete={id=>open('delete',id)}/>
        <div class="sig-grid"><div class="signature-editors">{draft.items.map(item=>{
          if(!keys.current.has(item.id))keys.current.set(item.id,item.id);
          const key=keys.current.get(item.id);
          if(item.id!==selected && !visited.current.has(key))return null;
          visited.current.add(key);
          return <SignatureEditor key={keys.current.get(item.id)} item={item} visible={item.id===selected} disabled={locked} onWorking={setEditorBusy} register={(id,controller)=>controller?controllers.current.set(id,controller):controllers.current.delete(id)} onChange={html=>change(value=>({...value,items:value.items.map(entry=>entry.id===item.id?{...entry,html}:entry)}))}/>;
        })}</div><SignatureImageLibrary targetId={selected} targetName={draft.items.find(item=>item.id===selected)?.name} items={draft.items} disabled={locked} onInsert={async(image,id)=>{const token=lifetime.current;setEditorBusy(true);try{await controllers.current.get(id)?.insert(image);}finally{if(lifetime.current===token)setEditorBusy(false);}}}/></div>
      </div>
      <div hidden={section!=='defaults'}><SignatureDefaults identities={identities.identities} items={draft.items} defaults={draft.defaults} busy={locked} onChange={(address,field,id)=>change(value=>({...value,defaults:{...value.defaults,[address]:{newDefault:null,replyDefault:null,...value.defaults[address],[field]:id}}}))} onEdit={()=>{setSection('edit');requestAnimationFrame(()=>root.current.querySelector('.d-section-nav button').focus());}}/></div>
      <div class="sig-save"><button class="btn pri" type="submit" disabled={locked}>저장</button><span class="sig-status" role="status">{busy?'저장하는 중…':saved?'저장했어요.':''}</span><small class="signature-bytes">{Math.ceil(draft.usedBytes/1024)} / {Math.ceil(draft.maxBytes/1024)}KB</small></div>
    </form>}
    {dialog && <SignatureDialog key={`${dialog.type}:${dialog.id || 'new'}`} type={dialog.type} signature={draft.items.find(item=>item.id===dialog.id)} defaults={draft.defaults} returnFocusRef={returnFocus} onConfirm={confirm} onCancel={()=>setDialog(null)}/>}
  </div>;
}
