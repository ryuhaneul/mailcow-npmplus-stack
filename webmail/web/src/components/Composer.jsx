import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, endSession } from '../api.js';
import { route, navigate } from '../router.js';
import { registerShortcuts } from '../shortcuts.js';
import { composeSeed } from '../state/compose.js';
import { prefs, updatePrefs } from '../state/prefs.js';
import { session } from '../state/session.js';
import { config } from '../state/config.js';
import { listLocation } from '../state/list.js';
import { toast } from '../state/toast.js';
import { initialComposition, composePayload, selectCompositionSignature, changeCompositionFrom, updateCompositionHtml, defaultCompositionSignature, attachmentLimitMessage, sendWarnings } from '../compose.js';
import { getSignatures, normalizeSignature, signatureError } from '../signatures.js';
import { getSignatureImages, createSignatureImageMap } from '../signature-images.js';
import { formatBytes } from '../format.js';
import SignatureDialog from './SignatureDialog.jsx';
import Icon from './Icon.jsx';
import FromPicker from './FromPicker.jsx';
import RecipientInput from './RecipientInput.jsx';
import FormatBar from './FormatBar.jsx';
import HtmlSource from './HtmlSource.jsx';
import ComposeEditor from './ComposeEditor.jsx';
import AttachDrop from './AttachDrop.jsx';
import './compose.css';

export default function Composer() {
  const [model,setModel]=useState(null),[identity,setIdentity]=useState(null),[domain,setDomain]=useState(''),[raw,setRaw]=useState(false),[error,setError]=useState(null),[busy,setBusy]=useState(''),[saving,setSaving]=useState(false),[savedTime,setSavedTime]=useState(null),[result,setResult]=useState(null),[showCc,setShowCc]=useState(false),[showBcc,setShowBcc]=useState(false);
  const current=useRef(null),live=useRef(true),owner=useRef(session.value),version=useRef(0),savedVersion=useRef(0),editedAt=useRef(0),timer=useRef(null),savePromise=useRef(null),uploads=useRef(Promise.resolve()),sending=useRef(false),closing=useRef(false),completed=useRef(false),editor=useRef(null),fileInput=useRef(null),fileKey=useRef(0);
  const [signatureMenu,setSignatureMenu]=useState(false),[replacement,setReplacement]=useState(null),[imageUrls,setImageUrls]=useState(new Map());
  const [draftImageUrls,setDraftImageUrls]=useState(new Map()),draftUrls=useRef(new Map());
  const signatureSnapshot=useRef(null),imageSnapshot=useRef(null),imageMap=useRef(null),signatureRoot=useRef(null),signatureButton=useRef(null),signaturePopup=useRef(null),signatureChange=useRef(0),signaturePromise=useRef(null);
  const open=route.value.name==='compose',seed=composeSeed.value,disabled=Boolean(busy||result);
  function active(){return live.current&&session.value===owner.current;}
  function fail(value){if((current.current?.kind==='draft'||seed?.kind==='draft')&&['MESSAGE_NOT_FOUND','STALE_REF'].includes(value.code))value={...value,message:'임시 메일이 다른 창에서 변경되었거나 삭제됐어요. 임시보관함에서 다시 열어 주세요.'};if(active()&&!['NO_SESSION','SESSION_EXPIRED'].includes(value.code))setError(['SIGNATURE_IMAGE_NOT_FOUND','SIGNATURE_INVALID'].includes(value.code)?signatureError(value):value);}
  function schedule(){clearTimeout(timer.current);if(!completed.current&&!sending.current&&!closing.current)timer.current=setTimeout(()=>{void saveDraft().catch(fail);},Math.max(0,3000-(Date.now()-editedAt.current)));}
  function patch(value,dirty=true){if(!active()||!current.current)return;current.current={...current.current,...value};setModel(current.current);if(dirty){version.current++;editedAt.current=Date.now();setSavedTime(null);schedule();}}
  async function saveDraft(){
    if(savePromise.current)return savePromise.current;
    if(!current.current||completed.current||savedVersion.current===version.current)return;
    let captured;
    const pending=(async()=>{
      await uploads.current;if(!active()||!current.current)return;
      captured=version.current;const snapshot=composePayload(current.current);setSaving(true);
      const value=await api('/api/drafts',{method:'PUT',body:snapshot});
      if(active()&&!completed.current){patch({draftRef:value.draftRef,forwardFiles:current.current.forwardFiles.map(file=>{const mapped=value.forwardParts?.find(part=>part.previousRef===file.ref&&part.previousPartId===file.partId);return mapped?{...file,ref:mapped.ref,partId:mapped.partId,size:mapped.size,sizeKnown:true}:file;})},false);savedVersion.current=captured;setSavedTime(new Date());setError(value=>value?.source==='draft'?null:value);}
    })();
    savePromise.current=pending;
    try{await pending;}catch(value){throw {...value,message:value.message,source:'draft'};}finally{savePromise.current=null;if(active()){setSaving(false);if(captured!==undefined&&version.current!==captured)schedule();}}
  }
  async function releaseAttachments(){if(!active()||!current.current)return;await Promise.allSettled(current.current.attachments.filter(file=>file.id).map(file=>api(`/api/attachments/${encodeURIComponent(file.id)}`,{method:'DELETE'})));}
  function releaseDraftImages(){for(const url of draftUrls.current.values())URL.revokeObjectURL(url);draftUrls.current.clear();}
  function reset(){releaseDraftImages();setDraftImageUrls(new Map());signatureChange.current++;signaturePromise.current=null;clearTimeout(timer.current);current.current=null;setModel(null);setResult(null);setError(null);setRaw(false);setSavedTime(null);setSignatureMenu(false);setReplacement(null);imageMap.current?.clear();setImageUrls(new Map());version.current=0;savedVersion.current=0;completed.current=false;}
  useEffect(()=>{live.current=true;imageMap.current=createSignatureImageMap();return()=>{live.current=false;clearTimeout(timer.current);imageMap.current.dispose();releaseDraftImages();};},[]);
  useEffect(()=>{
    if(!open||current.current&&!seed)return;
    if(seed?.kind==='draft'&&current.current?.draftRef===seed.message.ref){composeSeed.value=null;return;}
    let cancelled=false;
    (async()=>{
      try{
        if(current.current){await saveDraft();if(cancelled||!active())return;await releaseAttachments();}
        const [identities,rules,assets,draft]=await Promise.all([api('/api/compose/identities'),api('/api/rules').catch(error=>{if(error.code==='SIEVE_DISABLED')return {};throw error;}),Promise.all([getSignatures(),getSignatureImages()]).then(([signatures,images])=>({signatures,images})).catch(error=>({error})),seed?.kind==='draft'?api(`/api/drafts/${encodeURIComponent(seed.message.ref)}`):null]);if(cancelled||!active())return;
        reset();setIdentity(identities);setDomain(rules.internalDomains?.[0]||'');
        const signatures=assets.signatures||{items:[],defaults:{}},images=assets.images||{images:[]};
        signatureSnapshot.current=signatures;imageSnapshot.current=images;
        if(assets.error)setError({code:'SIGNATURE_LOAD_FAILED',message:'서명을 불러오지 못했어요. 서명 없이 작성할 수 있어요.'});
        const compositionSeed=draft?{kind:'draft',message:draft}:seed;
        let value,urls=new Map();
        try{
          const from=identities.defaultFrom||identities.identities[0]?.address||owner.current.user.email;
          const prepared=await normalizedSignatures(defaultCompositionSignature(signatures,from,compositionSeed?.kind||'new'));
          value=initialComposition(compositionSeed,identities,prefs.value,owner.current.user.email,{signatures:prepared,images});
          const ids=[...new Set(value.signatureImages.map(entry=>entry.assetId))];
          urls=new Map(await Promise.all(ids.map(async id=>[id,await imageMap.current.urlFor(id)])));
        }catch(error){
          if(cancelled||!active())return;
          value=initialComposition(compositionSeed,identities,prefs.value,owner.current.user.email,{signatures:{items:[],defaults:{}},images});
          setError({code:'SIGNATURE_LOAD_FAILED',message:'서명을 불러오지 못했어요. 서명 없이 작성할 수 있어요.'});
        }
        if(cancelled||!active())return;
        const cidUrls=new Map();
        try{
          for(const file of value.forwardFiles.filter(file=>file.cid&&/^image\/(png|jpeg|gif|webp)$/.test(file.contentType))){
            if(cidUrls.has(file.cid))continue;
            const response=await fetch(`/api/messages/${encodeURIComponent(file.ref)}/parts/${encodeURIComponent(file.partId)}?inline=1`,{credentials:'same-origin'});
            if(!response.ok){const {error}=await response.json();if(active()&&['NO_SESSION','SESSION_EXPIRED'].includes(error.code))endSession(error.code);throw error;}
            cidUrls.set(file.cid,URL.createObjectURL(await response.blob()));
          }
          if(cancelled||!active()){for(const url of cidUrls.values())URL.revokeObjectURL(url);return;}
        }catch(error){for(const url of cidUrls.values())URL.revokeObjectURL(url);throw error;}
        draftUrls.current=cidUrls;setDraftImageUrls(cidUrls);
        setImageUrls(urls);current.current=value;setModel(value);setShowCc(value.cc.length>0);setShowBcc(value.bcc.length>0);composeSeed.value=null;
        if(seed&&seed.kind!=='draft'){version.current=1;editedAt.current=Date.now();schedule();}
      }catch(value){
        if(!cancelled&&active()&&value.code==='DRAFT_UNSUPPORTED'&&seed?.kind==='draft'){
          reset();composeSeed.value=null;navigate(`read/${encodeURIComponent(seed.message.ref)}`);toast.value={kind:'info',message:value.message};
        }else if(!cancelled)fail(value);
      }
    })();
    return()=>{cancelled=true;};
  },[open,seed]);
  async function send(){
    if(sending.current||closing.current||completed.current||!current.current)return;
    sending.current=true;clearTimeout(timer.current);setBusy('send');setError(null);
    try{
      await signaturePromise.current;await savePromise.current;await uploads.current;if(!active())return;
      const body=composePayload(current.current,true),value=await api('/api/send',{method:'POST',body});if(!active())return;
      completed.current=true;
      if(value.rejected?.length||value.warnings?.length)setResult(value);
      else{navigate(listLocation.value);reset();toast.value={kind:'sent',message:'보냈어요'};}
    }catch(value){fail(value);}finally{sending.current=false;if(active()){setBusy('');if(current.current&&!completed.current&&version.current!==savedVersion.current)schedule();}}
  }
  async function close(){
    if(sending.current||closing.current)return;
    closing.current=true;clearTimeout(timer.current);setBusy('close');
    try{
      await signaturePromise.current;
      if(current.current&&!completed.current){
        const value=composePayload(current.current,true);patch({to:value.to,cc:value.cc,bcc:value.bcc,pendingTo:'',pendingCc:'',pendingBcc:''},Boolean(current.current.pendingTo||current.current.pendingCc||current.current.pendingBcc));
        while(savedVersion.current!==version.current){await saveDraft();if(!active())return;}
        await releaseAttachments();
      }
      if(active()){navigate(listLocation.value);reset();}
    }catch(value){fail(value);}finally{closing.current=false;if(active())setBusy('');}
  }
  async function discard(){
    if(sending.current||closing.current||completed.current||!current.current)return;
    signatureChange.current++;closing.current=true;clearTimeout(timer.current);setBusy('discard');
    try{
      await savePromise.current;await uploads.current;
      for(const file of current.current.attachments){await api(`/api/attachments/${encodeURIComponent(file.id)}`,{method:'DELETE'});patch({attachments:current.current.attachments.filter(item=>item.id!==file.id)},false);}
      if(current.current.draftRef){const response=await api('/api/messages/actions',{method:'POST',body:{refs:[current.current.draftRef],action:'trash'}});if(response.failed.length)throw {message:'임시 메일을 지우지 못했어요. 다시 시도해 주세요.'};}
      if(active()){navigate(listLocation.value);reset();}
    }catch(value){fail(value);}finally{closing.current=false;if(active())setBusy('');}
  }
  async function addFiles(files){
    if(sending.current||closing.current||completed.current||!current.current)return;
    const accepted=[],limit=config.value.attachMaxMb,max=limit*1024**2;let total=[...current.current.attachments,...current.current.forwardFiles].reduce((sum,file)=>sum+file.size,current.current.signatureImageBytes);
    for(const file of files){if(total+file.size>max){setError({code:'ATTACH_TOO_LARGE',message:attachmentLimitMessage(file.name,limit,total+file.size)});continue;}total+=file.size;accepted.push({key:++fileKey.current,file,filename:file.name,size:file.size,contentType:file.type,uploading:true});}
    if(!accepted.length)return;
    patch({attachments:[...current.current.attachments,...accepted]});
    const pending=uploads.current.then(async()=>{
      for(const item of accepted){if(!active())return;try{
        const body=new FormData();body.append('composeId',current.current.composeId);body.append('file',item.file);const file=await api('/api/attachments',{method:'POST',body});if(active())patch({attachments:current.current.attachments.map(value=>value.key===item.key?{...item,...file,uploading:false}:value)});
      }catch(value){if(active()){patch({attachments:current.current.attachments.filter(value=>value.key!==item.key)});fail(value.code==='ATTACH_TOO_LARGE'?{...value,message:attachmentLimitMessage(item.filename,limit,total)}:value);}}}
    });uploads.current=pending.catch(fail);await pending;
  }
  async function removeFile(file){
    try{if(file.id){await api(`/api/attachments/${encodeURIComponent(file.id)}`,{method:'DELETE'});patch({attachments:current.current.attachments.filter(item=>item.id!==file.id)});}else patch({forwardFiles:current.current.forwardFiles.filter(item=>!(item.ref===file.ref&&item.partId===file.partId))});}catch(value){fail(value);}
  }
  async function normalizedSignatures(id){
    const document=signatureSnapshot.current,item=document.items.find(item=>item.id===id);
    if(!item)return document;
    const {html}=await normalizeSignature(item.html);
    return {...document,items:document.items.map(value=>value.id===id?{...value,html}:value)};
  }
  async function changeSignature(action,confirm=false){
    if(!current.current||disabled||sending.current||closing.current)return;
    const change=++signatureChange.current,composeId=current.current.composeId;
    signaturePromise.current=null;
    const valid=()=>active()&&change===signatureChange.current&&current.current?.composeId===composeId&&!completed.current;
    const select=(model,document)=>action.type==='from'?changeCompositionFrom(model,action.from,document,imageSnapshot.current,{confirm}):selectCompositionSignature(model,action.id,document,imageSnapshot.current,{confirm});
    try{
      const value=select(current.current,signatureSnapshot.current);
      setSignatureMenu(false);
      if(value.confirmationRequired){setReplacement(action);return;}
      setReplacement(null);
      if(!Object.keys(value.patch).length)return;
      const pending=(async()=>{
        let prepared;
        try{
          prepared=await normalizedSignatures(value.patch.selectedSignatureId);
          if(!valid())return;
          const candidate=select(current.current,prepared);
          if(candidate.confirmationRequired){if(valid())setReplacement(action);return;}
          const ids=[...new Set(candidate.patch.signatureImages.map(entry=>entry.assetId))];
          const entries=await Promise.all(ids.map(async id=>[id,await imageMap.current.urlFor(id)]));
          await editor.current?.whenIdle();
          if(!valid())return;
          const latest=select(current.current,prepared);
          if(latest.confirmationRequired){setReplacement(action);return;}
          setImageUrls(previous=>new Map([...previous,...entries]));patch(latest.patch);
        }catch(error){
          await editor.current?.whenIdle();
          if(!valid())return;
          const fallback=selectCompositionSignature(current.current,null,signatureSnapshot.current,imageSnapshot.current,{confirm});
          if(fallback.confirmationRequired){setReplacement(action);return;}
          patch({...fallback.patch,...(action.type==='from'?{from:action.from}:{})});
          setError({code:'SIGNATURE_LOAD_FAILED',message:'서명을 불러오지 못했어요. 서명 없이 작성할 수 있어요.'});
        }
      })();
      signaturePromise.current=pending;
      try{await pending;}finally{if(signaturePromise.current===pending)signaturePromise.current=null;}
    }catch(value){fail(value);}
  }
  function from(value){changeSignature({type:'from',from:value});}
  function editHtml(html,rich=false){
    try{
      if(rich&&html.includes('blob:')){
        const root=document.createElement('template');root.innerHTML=html;
        const tokens=new Map(current.current.signatureImages.map(({token,assetId})=>[imageUrls.get(assetId),token]));
        const cids=new Map([...draftImageUrls].map(([cid,url])=>[url,`cid:${cid}`]));
        for(const img of root.content.querySelectorAll('img[src]')){
          if(cids.has(img.getAttribute('src'))){img.setAttribute('src',cids.get(img.getAttribute('src')));continue;}
          if(img.closest('blockquote'))continue;
          const src=img.getAttribute('src');
          if(tokens.has(src))img.setAttribute('src',tokens.get(src));
          else if(/^blob:/i.test(src))throw {code:'SIGNATURE_INVALID'};
        }
        html=root.innerHTML;
      }
      patch(updateCompositionHtml(current.current,html).patch);
    }catch(value){fail(value);}
  }
  function editorHtml(){
    if((!model.signatureImages.length||!imageUrls.size)&&!draftImageUrls.size)return model.html;
    const root=document.createElement('template');root.innerHTML=model.html;
    const tokens=new Map(model.signatureImages.map(({token,assetId})=>[token,imageUrls.get(assetId)]));
    for(const img of root.content.querySelectorAll('img[src]')){
      const source=img.getAttribute('src'),cid=/^cid:/i.test(source||'')?source.slice(4):null;
      let key=cid;try{key=decodeURIComponent(cid);}catch{}
      const draftUrl=draftImageUrls.get(key?.replace(/^<|>$/g,''));
      if(draftUrl){img.setAttribute('src',draftUrl);continue;}
      if(img.closest('blockquote'))continue;
      const url=tokens.get(img.getAttribute('src'));if(url)img.setAttribute('src',url);
    }
    return root.innerHTML;
  }
  useEffect(()=>{
    let cancelled=false;
    const ids=[...new Set((model?.signatureImages||[]).map(entry=>entry.assetId))];
    Promise.all(ids.map(async id=>[id,await imageMap.current.urlFor(id)])).then(entries=>{
      if(!cancelled&&active())setImageUrls(previous=>entries.every(([id,url])=>previous.get(id)===url)?previous:new Map([...previous,...entries]));
    }).catch(value=>{if(!cancelled)fail(value);});
    return()=>{cancelled=true;};
  },[model?.signatureImages]);
  useEffect(()=>{
    if(!signatureMenu)return;
    const close=event=>{if(!signatureRoot.current?.contains(event.target))setSignatureMenu(false);};
    document.addEventListener('pointerdown',close);
    // An editor lives in a separate document; its pointer events do not bubble here.
    const doc=document.querySelector('iframe.compose-editor')?.contentDocument;
    doc?.addEventListener('pointerdown',close);
    return()=>{document.removeEventListener('pointerdown',close);doc?.removeEventListener('pointerdown',close);};
  },[signatureMenu]);
  useLayoutEffect(()=>{
    if(signatureMenu)(signaturePopup.current.querySelector('[aria-checked=true]')||signaturePopup.current.querySelector('[role=menuitemradio]'))?.focus();
  },[signatureMenu]);
  function signatureKeyboard(event){
    if(!signatureMenu){if(['Enter',' ','ArrowDown'].includes(event.key)){event.preventDefault();setSignatureMenu(true);}return;}
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setSignatureMenu(false);signatureButton.current.focus();return;}
    if(event.key==='Tab')return;
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();
    const items=[...signaturePopup.current.querySelectorAll('[role=menuitemradio]')],index=items.indexOf(document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  }
  useEffect(()=>open?registerShortcuts('compose',{'Ctrl+Enter':()=>void send(),'Ctrl+Shift+H':()=>setRaw(value=>!value)}):undefined,[open]);
  if(!open&&!model)return null;
  const title=({reply:'답장',replyall:'전체 답장',forward:'전달',draft:'임시 메일 이어 쓰기'})[model?.kind]||'새 메일',signature=signatureSnapshot.current?.items.find(item=>item.id===model?.selectedSignatureId),layout=document.documentElement.dataset.compose;
  const signatureItems=[{id:null,name:'없음'},...(signatureSnapshot.current?.items||[])],totalBytes=model?[...model.attachments,...model.forwardFiles].reduce((sum,file)=>sum+file.size,model.signatureImageBytes):0;
  const nextId=replacement?.type==='from'?defaultCompositionSignature(signatureSnapshot.current,replacement.from,model.kind):replacement?.id;
  return <><div class="compose-dim" onClick={()=>void close()} aria-hidden="true"/><section class={`composer ${raw?'html':''}`} aria-label={title} aria-busy={Boolean(busy)}>
    <div class="c-head"><h2>{title}</h2><span class="saved" role="status">{saving?'임시 저장 중…':savedTime?`임시 저장됨 · ${savedTime.toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'})}`:''}</span><div class="r"><button class="ib" type="button" aria-label="쓰기 창 배치 바꾸기" title="떠 있는 창 / 서랍 / 화면 전체" onClick={()=>{const root=document.documentElement;updatePrefs({layout:{pane:root.dataset.pane,density:root.dataset.density,compose:['float','drawer','full'][(['float','drawer','full'].indexOf(layout)+1)%3]}});}}><Icon name="expand" size="s"/></button><button class="ib" type="button" aria-label="쓰기 창 닫기" disabled={Boolean(busy)} onClick={()=>void close()}><Icon name="x" size="s"/></button></div></div>
    {model?.fromChanged&&<div class="compose-alert compose-result" role="status">보내는 주소를 기본 주소로 바꿨어요.</div>}
    {error&&<div class="compose-alert" role="alert">{error.message}{error.smtpMessage&&<> {error.smtpMessage}</>}</div>}
    {result&&<div class="compose-alert compose-result" role="status"><ul>{result.rejected?.map(item=><li key={item.address}>{item.address}에는 보내지 못했어요: {item.smtpMessage}</li>)}{result.warnings?.map(code=><li key={code}>{code==='SENT_COPY_FAILED'&&model?.draftRef?'보냈지만 보낸편지함에 저장하지 못해 임시보관함에 원본을 남겨 두었어요':sendWarnings[code]||code}</li>)}</ul><button class="btn sm" type="button" onClick={()=>void close()}>닫기</button></div>}
    {model&&identity?<><div class="c-inner"><FromPicker identities={identity} from={model.from} onChange={from} disabled={disabled}/><RecipientInput label="받는 사람" id="compose-to" values={model.to} query={model.pendingTo} onValues={to=>patch({to})} onQuery={pendingTo=>patch({pendingTo})} onError={fail} domain={domain} disabled={disabled}><div class="side-l"><button type="button" disabled={disabled} onClick={()=>setShowCc(!showCc)}>참조</button><button type="button" disabled={disabled} onClick={()=>setShowBcc(!showBcc)}>숨은참조</button></div></RecipientInput>
      {showCc&&<RecipientInput label="참조" id="compose-cc" values={model.cc} query={model.pendingCc} onValues={cc=>patch({cc})} onQuery={pendingCc=>patch({pendingCc})} onError={fail} disabled={disabled}/>}{showBcc&&<RecipientInput label="숨은참조" id="compose-bcc" values={model.bcc} query={model.pendingBcc} onValues={bcc=>patch({bcc})} onQuery={pendingBcc=>patch({pendingBcc})} onError={fail} disabled={disabled}/>}
      <div class="fld"><label for="compose-subject">제목</label><div class="val"><input id="compose-subject" value={model.subject} disabled={disabled} onInput={event=>patch({subject:event.currentTarget.value})}/></div><span/></div>
      <FormatBar raw={raw} toggle={()=>setRaw(value=>!value)} editor={editor} disabled={disabled}/><div class="code-note"><Icon name="info" size="s"/>HTML 원문을 직접 고치는 중입니다. 서식 단추는 원문 모드에서 쉬어요. 다시 누르면 서식 편집으로 돌아갑니다.</div>
      {model.internalImages&&<div class="code-note always" role="status">원문 본문 속 이미지는 함께 가지 않아요.{model.kind==='forward'?'(첨부는 전달됨)':''}</div>}
      <ComposeEditor signatureNonce={model.signatureNonce} html={editorHtml()} onChange={html=>editHtml(html,true)} disabled={disabled} editor={editor}/><HtmlSource html={model.html} onChange={html=>editHtml(html)} disabled={disabled}/>
      <div class="compose-signature-bar" ref={signatureRoot} onKeyDown={signatureKeyboard} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setSignatureMenu(false);}}><span>서명</span><button ref={signatureButton} class="signature-picker" type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={signatureMenu} aria-controls="compose-signature-menu" onClick={()=>setSignatureMenu(!signatureMenu)}>서명: {signature?.name||'없음'} <Icon name="down" size="xs"/></button>{model.signatureDirty&&<small>이 메일에서 수정함</small>}{signatureMenu&&<div ref={signaturePopup} id="compose-signature-menu" class="signature-menu" role="menu" aria-label="서명 바꾸기">{signatureItems.map(item=><button key={item.id??'none'} type="button" role="menuitemradio" tabIndex={-1} aria-checked={model.selectedSignatureId===item.id} onClick={()=>{changeSignature({type:'signature',id:item.id});signatureButton.current.focus();}}>{item.name}{model.selectedSignatureId===item.id&&<Icon name="check" size="s"/>}</button>)}</div>}</div>
      <AttachDrop files={[...model.attachments,...model.forwardFiles]} limit={config.value.attachMaxMb} disabled={disabled} onFiles={addFiles} onRemove={removeFile} inputRef={fileInput}/><small class="compose-grants" role="status">첨부 {[...model.attachments,...model.forwardFiles].some(file=>file.sizeKnown===false)?'크기 확인 필요':formatBytes(totalBytes)} / {config.value.attachMaxMb}MB · 서명 이미지 포함</small>
    </div><div class="c-foot"><div class="send"><button type="button" disabled={disabled||model.attachments.some(file=>file.uploading)} onClick={()=>void send()}><Icon name="send" size="s"/>{busy==='send'?'보내는 중…':'보내기'}</button></div><div class="r"><button class="ib" type="button" aria-label="파일 첨부" disabled={disabled} onClick={()=>fileInput.current.click()}><Icon name="clip" size="s"/></button><button class="ib" type="button" aria-label="임시 메일 삭제" disabled={disabled} onClick={()=>void discard()}><Icon name="trash" size="s"/></button></div></div></>:<div class="empty-read" role="status">{error?'':seed?.kind==='draft'?'임시 메일을 불러오는 중…':'보낼 주소를 불러오는 중…'}</div>}
  </section>{replacement&&<SignatureDialog key={`${replacement.type}:${replacement.from??replacement.id??'none'}`} type="replace" nextSignature={signatureSnapshot.current.items.find(item=>item.id===nextId)||null} returnFocusRef={signatureButton} onCancel={()=>setReplacement(null)} onConfirm={()=>changeSignature(replacement,true)}/>}</>;
}
