import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, endSession } from '../api.js';
import { route, navigate } from '../router.js';
import { registerShortcuts } from '../shortcuts.js';
import { composeSeed, pendingSend, detachedSendAttempts, detachSendAttempt, sendResultNotice, hasPendingSendAttempt, rememberSendAttempt, restoreSendAttempt, clearSendAttempt } from '../state/compose.js';
import { folders } from '../state/folders.js';
import { prefs, updatePrefs } from '../state/prefs.js';
import { session, authGeneration } from '../state/session.js';
import { composeIdentities, getComposeResources, prepareComposeSignature, composeImageContent, senderDomain } from '../state/compose-resources.js';
import { signatures as cachedSignatures, signatureImages as cachedImages } from '../state/signatures.js';
import { config } from '../state/config.js';
import { listLocation } from '../state/list.js';
import { toast } from '../state/toast.js';
import { initialComposition, composePayload, selectCompositionSignature, changeCompositionFrom, updateCompositionHtml, defaultCompositionSignature, attachmentLimitMessage, sendWarnings } from '../compose.js';
import { signatureError } from '../signatures.js';
import { createSignatureImageMap } from '../signature-images.js';
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
  const current=useRef(null),live=useRef(true),owner=useRef(session.value),version=useRef(0),savedVersion=useRef(0),editedAt=useRef(0),timer=useRef(null),savePromise=useRef(null),uploads=useRef(Promise.resolve()),sending=useRef(false),closing=useRef(false),completed=useRef(false),recovering=useRef(false),editor=useRef(null),fileInput=useRef(null),fileKey=useRef(0),delivery=useRef('idle'),lookupPending=useRef(false);
  const [signatureMenu,setSignatureMenu]=useState(false),[replacement,setReplacement]=useState(null),[imageUrls,setImageUrls]=useState(new Map());
  const [restoration,setRestoration]=useState(()=>hasPendingSendAttempt()?undefined:null),restoredAttempt=useRef(false);
  const [draftImageUrls,setDraftImageUrls]=useState(new Map()),draftUrls=useRef(new Map());
  const signatureSnapshot=useRef(null),imageSnapshot=useRef(null),imageMap=useRef(null),signatureRoot=useRef(null),signatureButton=useRef(null),signaturePopup=useRef(null),signatureChange=useRef(0),signaturePromise=useRef(null);
  const open=route.value.name==='compose',seed=composeSeed.value,disabled=Boolean(busy||result&&result.status!=='not_sent'&&!recovering.current);
  function active(){return live.current&&session.value===owner.current;}
  function fail(value){if(completed.current){if(recovering.current&&value.source==='draft'&&active())setResult(previous=>({...previous,recoveryError:'사본을 임시 저장하지 못했어요. '+value.message}));return;}if((current.current?.kind==='draft'||seed?.kind==='draft')&&['MESSAGE_NOT_FOUND','STALE_REF'].includes(value.code))value={...value,message:'임시 메일이 다른 창에서 변경되었거나 삭제됐어요. 임시보관함에서 다시 열어 주세요.'};if(active()&&!['NO_SESSION','SESSION_EXPIRED'].includes(value.code))setError(['SIGNATURE_IMAGE_NOT_FOUND','SIGNATURE_INVALID'].includes(value.code)?signatureError(value):value);}
  function schedule(){clearTimeout(timer.current);if(!completed.current&&!['checking','unknown'].includes(delivery.current)&&!sending.current&&!closing.current)timer.current=setTimeout(()=>{void saveDraft().catch(fail);},Math.max(0,3000-(Date.now()-editedAt.current)));}
  function patch(value,dirty=true){if(!active()||!current.current)return;current.current={...current.current,...value};setModel(current.current);if(dirty){version.current++;editedAt.current=Date.now();setSavedTime(null);schedule();}}
  async function saveDraft(manual=false){
    if(savePromise.current)return savePromise.current;
    if(!current.current||restoredAttempt.current||delivery.current==='checking'||!manual&&(completed.current||delivery.current==='unknown'||savedVersion.current===version.current))return;
    let captured;
    const pending=(async()=>{
      await uploads.current;if(!active()||!current.current)return;
      captured=version.current;const snapshot={...composePayload(current.current),...(manual?{composeId:current.current.composeId}:{})};setSaving(true);
      const value=await api('/api/drafts',{method:'PUT',body:snapshot});
      if(active()&&current.current){patch({draftRef:value.draftRef,forwardFiles:current.current.forwardFiles.map(file=>{const mapped=value.forwardParts?.find(part=>part.previousRef===file.ref&&part.previousPartId===file.partId);return mapped?{...file,ref:mapped.ref,partId:mapped.partId,size:mapped.size,sizeKnown:true}:file;})},false);savedVersion.current=captured;setSavedTime(new Date());setError(value=>value?.source==='draft'?null:value);if(completed.current&&manual&&savedVersion.current===version.current){recovering.current=false;setResult(previous=>({...previous,warnings:(previous.warnings||[]).filter(code=>code!=='SENT_COPY_FAILED'),sentCopySavedTo:'drafts',sentCopyRef:value.draftRef,copyPending:false,manualRecovery:true,recoveryError:null}));}}
    })();
    savePromise.current=pending;
    try{await pending;}catch(value){throw {...value,message:value.message,source:'draft'};}finally{savePromise.current=null;if(active()){setSaving(false);if(captured!==undefined&&version.current!==captured)schedule();}}
  }
  const refreshedIdentity=composeIdentities.value, refreshedSignatures=cachedSignatures.value, refreshedImages=cachedImages.value;
  useEffect(()=>{
    if(!current.current||!active())return;
    if(refreshedIdentity)setIdentity(refreshedIdentity);
    if(refreshedSignatures)signatureSnapshot.current=refreshedSignatures;
    if(refreshedImages)imageSnapshot.current=refreshedImages;
  },[refreshedIdentity,refreshedSignatures,refreshedImages]);
  async function releaseAttachments(){if(!active()||!current.current)return;await Promise.allSettled(current.current.attachments.filter(file=>file.id).map(file=>api(`/api/attachments/${encodeURIComponent(file.id)}`,{method:'DELETE'})));}
  function releaseDraftImages(){for(const url of draftUrls.current.values())URL.revokeObjectURL(url);draftUrls.current.clear();}
  function reset(){if(sendResultNotice.value?.composeId===current.current?.composeId)sendResultNotice.value=null;releaseDraftImages();setDraftImageUrls(new Map());signatureChange.current++;signaturePromise.current=null;clearTimeout(timer.current);current.current=null;setModel(null);setResult(null);setError(null);setRaw(false);setSavedTime(null);setSignatureMenu(false);setReplacement(null);imageMap.current?.clear();setImageUrls(new Map());version.current=0;savedVersion.current=0;completed.current=false;recovering.current=false;delivery.current='idle';restoredAttempt.current=false;}
  useEffect(()=>{live.current=true;imageMap.current=createSignatureImageMap({loadContent:composeImageContent});return()=>{live.current=false;if(['checking','unknown'].includes(delivery.current))toast.value={kind:'send-unknown',message:'발송 여부를 확인할 수 없어요. 보낸편지함·임시보관함을 확인해 주세요.',ownerEmail:owner.current?.user?.email};pendingSend.value=null;detachedSendAttempts.value=[];sendResultNotice.value=null;clearTimeout(timer.current);imageMap.current.dispose();releaseDraftImages();};},[]);
  useEffect(()=>{if(restoration!==undefined)return;let cancelled=false;restoreSendAttempt(owner.current.user.email).then(value=>{if(!cancelled){setRestoration(value);if(value)navigate('compose');}});return()=>{cancelled=true;};},[]);
  useEffect(()=>{
    if(restoration===undefined)return;
    if(restoration){
      // Recovery needs only the authenticated receipt API. IMAP, signatures or
      // the sender directory may be unavailable after the mail was accepted.
      restoredAttempt.current=true;current.current={composeId:restoration.composeId};composeSeed.value=null;setRestoration(null);
      delivery.current='checking';setResult({status:'checking'});void checkDelivery();return;
    }
    if(!open||current.current&&!seed)return;
    if(current.current&&(['checking','unknown'].includes(delivery.current)||sendResultNotice.value||completed.current&&(recovering.current||result?.copyPending||result?.rejected?.length))){composeSeed.value=null;return;}
    if(seed?.kind==='draft'&&current.current?.draftRef===seed.message.ref){composeSeed.value=null;return;}
    let cancelled=false;
    (async()=>{
      try{
        if(current.current){await saveDraft();if(cancelled||!active())return;await releaseAttachments();}
        const [{identities,assets},draft]=await Promise.all([getComposeResources(),seed?.kind==='draft'?api(`/api/drafts/${encodeURIComponent(seed.message.ref)}`):null]);if(cancelled||!active())return;
        reset();setIdentity(identities);setDomain(senderDomain(owner.current.user.email));
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
            const generation=authGeneration;
            const response=await fetch(`/api/messages/${encodeURIComponent(file.ref)}/parts/${encodeURIComponent(file.partId)}?inline=1`,{credentials:'same-origin'});
            if(!response.ok){const {error}=await response.json();if(active()&&generation===authGeneration&&['NO_SESSION','SESSION_EXPIRED'].includes(error.code))endSession(error.code);throw error;}
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
  },[open,seed,restoration]);
  const unknownMessage='발송 여부를 확인할 수 없어요. 보낸편지함·임시보관함을 확인해 주세요.';
  function applyDelivery(value){
    if(!active())return;
    const status=value.status||(value.ok?'sent':'unknown');
    delivery.current=status;clearTimeout(timer.current);setError(null);
    if(status==='sent'&&!value.copyPending||status==='not_sent'){clearSendAttempt(current.current.composeId);if(toast.value?.kind==='send-unknown')toast.value=null;}
    else if(value.reason==='NOT_FOUND'){clearSendAttempt(current.current.composeId);toast.value={kind:'send-unknown',message:unknownMessage,ownerEmail:owner.current?.user?.email};}
    else if(pendingSend.value)pendingSend.value={...pendingSend.value,status};
    if(status==='sent'){
      completed.current=true;
      recovering.current=!value.sentCopySavedTo&&!value.copyPending&&!restoredAttempt.current;
      if(recovering.current){version.current++;setSavedTime(null);}
    }
    if(status==='not_sent'&&['SIGNATURE_IMAGE_NOT_FOUND','SIGNATURE_INVALID'].includes(value.error?.code))value={...value,error:signatureError(value.error)};
    if(status==='not_sent'&&current.current?.kind==='draft'&&['MESSAGE_NOT_FOUND','STALE_REF'].includes(value.error?.code))value={...value,error:{...value.error,message:'임시 메일이 다른 창에서 변경되었거나 삭제됐어요. 임시보관함에서 다시 열어 주세요.'}};
    setResult({...value,status});
    if(['sent','not_sent'].includes(status)&&(route.value.name!=='compose'||sendResultNotice.value?.composeId===current.current?.composeId)){
      const composeId=current.current.composeId;
      const message=status==='not_sent'?'보내지 못했어요':value.rejected?.length?'메일을 보냈어요 · 일부 주소는 거절됐어요':value.copyPending?'메일을 보냈어요 · 사본 저장 확인 중':!value.sentCopySavedTo?'메일을 보냈어요 · 사본 저장이 필요해요':value.sentCopySavedTo==='drafts'?'메일을 보냈어요 · 사본은 임시보관함에 있어요':'메일을 보냈어요';
      sendResultNotice.value={composeId,status,message,onView:()=>navigate('compose'),onClose:()=>{
        if(current.current?.composeId===composeId&&status==='sent'&&!recovering.current&&!value.copyPending&&!value.rejected?.length)reset();
      }};
    }
  }
  async function checkDelivery(){
    if(!current.current||lookupPending.current)return;
    lookupPending.current=true;setBusy('check');
    try{
      const value=await api(`/api/send/${encodeURIComponent(current.current.composeId)}`,{silentSessionErrors:true,signal:AbortSignal.timeout(15000)});
      applyDelivery(value);
    }catch(value){
      if(['NO_SESSION','SESSION_EXPIRED'].includes(value.code)||!active())toast.value={kind:'send-unknown',message:unknownMessage,ownerEmail:owner.current?.user?.email};
      else {delivery.current=delivery.current==='checking'?'unknown':delivery.current;setResult(previous=>({...previous,status:previous?.status==='checking'?'unknown':previous?.status||'unknown',lookupError:'결과를 다시 확인하지 못했어요 — 잠시 뒤 다시 확인'}));}
    }finally{lookupPending.current=false;if(active())setBusy('');}
  }
  async function send(){
    if(sending.current||closing.current||completed.current||['checking','unknown'].includes(delivery.current)||!current.current)return;
    sending.current=true;clearTimeout(timer.current);setBusy('send');setError(null);
    let requested=false;
    try{
      await signaturePromise.current;await savePromise.current;await uploads.current;if(!active())return;
      const body=composePayload(current.current,true);
      // Commit pending recipient text once, before capturing the send attempt.
      patch({to:body.to,cc:body.cc,bcc:body.bcc,pendingTo:'',pendingCc:'',pendingBcc:''},false);
      delivery.current='checking';
      if(sendResultNotice.value?.composeId===body.composeId)sendResultNotice.value={...sendResultNotice.value,status:'checking',message:'발송 결과 확인 중이에요'};
      await rememberSendAttempt(body.composeId,owner.current.user.email);
      if(!active()){clearSendAttempt();toast.value={kind:'info',message:'로그인이 끝나 보내지 않았어요.'};return;}
      setResult({status:'checking'});requested=true;
      const value=await api('/api/send',{method:'POST',body,silentSessionErrors:true,signal:AbortSignal.timeout(90000)});
      applyDelivery(value);
    }catch(value){
      if(!requested)applyDelivery({status:'not_sent',error:{message:value.message||'작성 내용을 확인해 주세요.'}});
      else if(['CSRF','BAD_ORIGIN'].includes(value.code))applyDelivery({status:'not_sent',error:value});
      else if(['NO_SESSION','SESSION_EXPIRED'].includes(value.code)||!active())toast.value={kind:'send-unknown',message:unknownMessage,ownerEmail:owner.current?.user?.email};
      else await checkDelivery();
    }finally{sending.current=false;if(active()){setBusy('');if(current.current&&!completed.current&&delivery.current==='not_sent'&&version.current!==savedVersion.current)schedule();}}
  }
  function viewMailbox(specialUse){
    const folder=folders.value.folders.find(item=>item.specialUse===`\\${specialUse}`&&!item.shared);
    navigate(`f/${encodeURIComponent(folder?.path||specialUse)}`);
  }
  function finishChecking(){
    if(!restoredAttempt.current)return;
    if(!window.confirm('보낸편지함에 메일이 없으면 임시보관함 사본이나 새 메일로 다시 보내 주세요'))return;
    clearSendAttempt(current.current?.composeId);if(toast.value?.kind==='send-unknown')toast.value=null;navigate(listLocation.value);reset();
  }
  async function resendUnknown(){
    if(busy||result?.status!=='unknown'||result.reason!=='SMTP_OUTCOME_UNKNOWN')return;
    if(!window.confirm('받는 사람에게 같은 메일이 두 번 갈 수 있어요. 다시 보낼까요?'))return;
    // An explicit duplicate-risk confirmation creates a new attempt; the old
    // unknown key remains locked on the server for the rest of the session.
    detachSendAttempt(current.current.composeId);patch({composeId:crypto.randomUUID()},false);delivery.current='idle';setResult(null);
    await send();
  }
  async function close(){
    if(sending.current||closing.current||lookupPending.current||delivery.current==='checking')return;
    if(restoredAttempt.current){
      if(delivery.current==='unknown'){finishChecking();return;}
      navigate(listLocation.value);if(!result?.copyPending)reset();return;
    }
    closing.current=true;clearTimeout(timer.current);setBusy('close');
    const unresolved=delivery.current==='unknown', needsCopy=completed.current&&(!result?.sentCopySavedTo||result?.copyPending);
    let saved=false;
    try{
      await signaturePromise.current;await savePromise.current;
      if(current.current&&(!completed.current||needsCopy)){
        const value=composePayload(current.current,true);patch({to:value.to,cc:value.cc,bcc:value.bcc,pendingTo:'',pendingCc:'',pendingBcc:''},Boolean(current.current.pendingTo||current.current.pendingCc||current.current.pendingBcc));
        if(unresolved||needsCopy)await saveDraft(true);
        while(savedVersion.current!==version.current){await saveDraft(true);if(!active())return;}
        saved=true;
      }
    }catch(value){
      fail(value);
      if(!active()||!window.confirm('이 내용은 계정에 남아 있지 않아요. 그래도 닫을까요?')){closing.current=false;if(active())setBusy('');return;}
    }
    try{
      if(!active())return;
      if(saved)await releaseAttachments();
      if(unresolved)detachSendAttempt(current.current.composeId);
      else clearSendAttempt(current.current?.composeId);
      navigate(listLocation.value);reset();
    }finally{closing.current=false;if(active())setBusy('');}
  }
  async function discard(){
    if(sending.current||closing.current||['checking','unknown'].includes(delivery.current)||completed.current&&(!recovering.current||result?.sentCopySavedTo===null)||!current.current)return;
    signatureChange.current++;closing.current=true;clearTimeout(timer.current);setBusy('discard');
    try{
      await savePromise.current;await uploads.current;
      for(const file of current.current.attachments){await api(`/api/attachments/${encodeURIComponent(file.id)}`,{method:'DELETE'});patch({attachments:current.current.attachments.filter(item=>item.id!==file.id)},false);}
      if(current.current.draftRef){const response=await api('/api/messages/actions',{method:'POST',body:{refs:[current.current.draftRef],action:'trash'}});if(response.failed.length)throw {message:'임시 메일을 지우지 못했어요. 다시 시도해 주세요.'};}
      if(active()){navigate(listLocation.value);reset();}
    }catch(value){fail(value);}finally{closing.current=false;if(active())setBusy('');}
  }
  async function addFiles(files){
    if(sending.current||closing.current||['checking','unknown'].includes(delivery.current)||completed.current&&!recovering.current||!current.current)return;
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
  function normalizedSignatures(id){ return prepareComposeSignature(signatureSnapshot.current,id); }
  async function changeSignature(action,confirm=false){
    if(!current.current||disabled||sending.current||closing.current)return;
    const change=++signatureChange.current,composeId=current.current.composeId;
    signaturePromise.current=null;
    const valid=()=>active()&&change===signatureChange.current&&current.current?.composeId===composeId&&(!completed.current||recovering.current);
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
  useEffect(()=>{if(!open||result?.status!=='sent'||result.sentCopySavedTo)return;const key=event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();void close();}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[open,result]);
  useEffect(()=>open?registerShortcuts('compose',{'Ctrl+Enter':()=>void send(),'Ctrl+Shift+H':()=>setRaw(value=>!value)}):undefined,[open]);
  if(!open&&!model)return null;
  const title=({reply:'답장',replyall:'전체 답장',forward:'전달',draft:'임시 메일 이어 쓰기'})[model?.kind]||'새 메일',signature=(refreshedSignatures||signatureSnapshot.current)?.items.find(item=>item.id===model?.selectedSignatureId),layout=document.documentElement.dataset.compose;
  const signatureItems=[{id:null,name:'없음'},...((refreshedSignatures||signatureSnapshot.current)?.items||[])],totalBytes=model?[...model.attachments,...model.forwardFiles].reduce((sum,file)=>sum+file.size,model.signatureImageBytes):0;
  const nextId=replacement?.type==='from'?defaultCompositionSignature(signatureSnapshot.current,replacement.from,model.kind):replacement?.id;
  return <><div class="compose-dim" onClick={()=>void close()} aria-hidden="true"/><section class={`composer ${raw?'html':''}`} aria-label={title} aria-busy={Boolean(busy)}>
    <div class="c-head"><h2>{title}</h2><span class="saved" role="status">{saving?'임시 저장 중…':savedTime?`임시 저장됨 · ${savedTime.toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'})}`:''}</span><div class="r"><button class="ib" type="button" aria-label="쓰기 창 배치 바꾸기" title="떠 있는 창 / 서랍 / 화면 전체" onClick={()=>{const root=document.documentElement;updatePrefs({layout:{pane:root.dataset.pane,density:root.dataset.density,compose:['float','drawer','full'][(['float','drawer','full'].indexOf(layout)+1)%3]}});}}><Icon name="expand" size="s"/></button><button class="ib" type="button" aria-label="쓰기 창 닫기" disabled={Boolean(busy||result?.status==='checking')} onClick={()=>void close()}><Icon name="x" size="s"/></button></div></div>
    {model?.fromChanged&&<div class="compose-alert compose-result" role="status">보내는 주소를 기본 주소로 바꿨어요.</div>}
    {error&&<div class="compose-alert" role="alert">{error.message}{error.smtpMessage&&<> {error.smtpMessage}</>}</div>}
    {result&&<div class={`compose-alert compose-result delivery-${result.status}`} role="status" aria-live="polite">
      <strong>{result.status==='sent'?'보냈어요':result.status==='not_sent'?'안 보냈어요':result.status==='checking'?'발송 결과 확인 중…':'발송 여부 확인 필요'}</strong>
      {result.status==='sent'&&<>
        <p>{result.manualRecovery?'보낸 메일은 나갔어요. 작성 내용의 복구본을 임시보관함에 저장했어요':result.copyPending?'메일 서버가 발송을 수락했어요. 사본 저장 결과를 확인 중이에요.':result.sentCopySavedTo===undefined?'보냈지만 사본 저장 위치를 확인하지 못했어요. 임시보관함을 확인하고 작성 내용을 임시 저장해 주세요.':result.sentCopySavedTo==='drafts'?'보냈지만 보낸편지함에 저장하지 못해, 보낸 그대로의 사본을 임시보관함에 남겨 두었어요':result.sentCopySavedTo===null?(restoredAttempt.current?'보냈지만 사본을 저장하지 못했어요. 작성 내용은 임시보관함에서 확인해 주세요.':'보냈지만 사본을 저장하지 못했어요. 임시 저장을 눌러 다시 저장해 주세요'):'보낸편지함에 사본을 저장했어요.'}</p>
        <ul>{result.rejected?.map(item=><li key={item.address}>{item.address}에는 보내지 못했어요: {item.smtpMessage}</li>)}{result.warnings?.filter(code=>code!=='SENT_COPY_FAILED').map(code=><li key={code}>{sendWarnings[code]||code}</li>)}</ul>
        {result.recoveryError&&<p>{result.recoveryError}</p>}
        {result.sentCopyRef&&<a class="compose-browse" href={`#read/${encodeURIComponent(result.sentCopyRef)}`} onClick={()=>{navigate(`read/${encodeURIComponent(result.sentCopyRef)}`);reset();}}>{result.sentCopySavedTo==='drafts'?'임시보관함의 사본 보기':'보낸 메일 보기'}</a>}
        {!result.sentCopySavedTo&&!result.copyPending&&!restoredAttempt.current&&<button class="btn sm" type="button" disabled={Boolean(busy||saving)} onClick={()=>void saveDraft(true).catch(fail)}>임시 저장</button>}
      </>}
      {result.status==='not_sent'&&<><p>{result.error?.message}</p>{result.error?.smtpMessage&&<p>서버 응답: {result.error.smtpMessage}</p>}<p>내용을 확인하고 다시 보내 주세요.</p></>}
      {['checking','unknown'].includes(result.status)&&<p>{result.status==='checking'?'아직 보내는 중이에요. 결과를 확인할 때까지 다시 보내지 마세요.':unknownMessage}</p>}
      {(['checking','unknown'].includes(result.status)||result.copyPending)&&<button class="btn sm" type="button" disabled={Boolean(busy)} onClick={()=>void checkDelivery()}>다시 확인</button>}
      {result.status==='unknown'&&<><button class="btn sm" type="button" onClick={()=>viewMailbox('Sent')}>보낸편지함 확인</button><button class="btn sm" type="button" onClick={()=>viewMailbox('Drafts')}>임시보관함 확인</button></>}
      {result.status==='unknown'&&restoredAttempt.current&&<button class="btn sm" type="button" disabled={Boolean(busy)} onClick={finishChecking}>확인 끝내기</button>}
      {result.status==='unknown'&&result.reason==='SMTP_OUTCOME_UNKNOWN'&&!restoredAttempt.current&&<button class="btn sm" type="button" disabled={Boolean(busy)} onClick={()=>void resendUnknown()}>확인했는데 없으면 다시 보내기</button>}
      {result.lookupError&&<small>{result.lookupError}</small>}
      {result.status!=='checking'&&(result.status!=='unknown'||!restoredAttempt.current)&&<button class="btn sm" type="button" disabled={Boolean(busy)} onClick={()=>void close()}>닫기</button>}
    </div>}

    {model&&identity&&!restoredAttempt.current?<><div class="c-inner"><FromPicker identities={identity} from={model.from} onChange={from} disabled={disabled}/><RecipientInput label="받는 사람" id="compose-to" values={model.to} query={model.pendingTo} onValues={to=>patch({to})} onQuery={pendingTo=>patch({pendingTo})} onError={fail} domain={domain} disabled={disabled}><div class="side-l"><button type="button" disabled={disabled} onClick={()=>setShowCc(!showCc)}>참조</button><button type="button" disabled={disabled} onClick={()=>setShowBcc(!showBcc)}>숨은참조</button></div></RecipientInput>
      {showCc&&<RecipientInput label="참조" id="compose-cc" values={model.cc} query={model.pendingCc} onValues={cc=>patch({cc})} onQuery={pendingCc=>patch({pendingCc})} onError={fail} disabled={disabled}/>}{showBcc&&<RecipientInput label="숨은참조" id="compose-bcc" values={model.bcc} query={model.pendingBcc} onValues={bcc=>patch({bcc})} onQuery={pendingBcc=>patch({pendingBcc})} onError={fail} disabled={disabled}/>}
      <div class="fld"><label for="compose-subject">제목</label><div class="val"><input id="compose-subject" value={model.subject} disabled={disabled} onInput={event=>patch({subject:event.currentTarget.value})}/></div><span/></div>
      <FormatBar raw={raw} toggle={()=>setRaw(value=>!value)} editor={editor} disabled={disabled}/><div class="code-note"><Icon name="info" size="s"/>HTML 원문을 직접 고치는 중입니다. 서식 단추는 원문 모드에서 쉬어요. 다시 누르면 서식 편집으로 돌아갑니다.</div>
      {model.internalImages&&<div class="code-note always" role="status">원문 본문 속 이미지는 함께 가지 않아요.{model.kind==='forward'?'(첨부는 전달됨)':''}</div>}
      <ComposeEditor signatureNonce={model.signatureNonce} html={editorHtml()} onChange={html=>editHtml(html,true)} disabled={disabled} editor={editor}/><HtmlSource html={model.html} onChange={html=>editHtml(html)} disabled={disabled}/>
      <div class="compose-signature-bar" ref={signatureRoot} onKeyDown={signatureKeyboard} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setSignatureMenu(false);}}><button ref={signatureButton} class="signature-picker" type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={signatureMenu} aria-controls="compose-signature-menu" onClick={()=>setSignatureMenu(!signatureMenu)}>서명: {signature?.name||'없음'} <Icon name="down" size="xs"/></button>{model.signatureDirty&&<small>이 메일에서 수정함</small>}{signatureMenu&&<div ref={signaturePopup} id="compose-signature-menu" class="signature-menu" role="menu" aria-label="서명 바꾸기">{signatureItems.map(item=><button key={item.id??'none'} type="button" role="menuitemradio" tabIndex={-1} aria-checked={model.selectedSignatureId===item.id} onClick={()=>{changeSignature({type:'signature',id:item.id});signatureButton.current.focus();}}>{item.name}{model.selectedSignatureId===item.id&&<Icon name="check" size="s"/>}</button>)}</div>}</div>
      <AttachDrop files={[...model.attachments,...model.forwardFiles]} limit={config.value.attachMaxMb} disabled={disabled} onFiles={addFiles} onRemove={removeFile} inputRef={fileInput}/><small class="compose-grants" role="status">첨부 {[...model.attachments,...model.forwardFiles].some(file=>file.sizeKnown===false)?'크기 확인 필요':formatBytes(totalBytes)} / {config.value.attachMaxMb}MB · 서명 이미지 포함</small>
    </div><div class="c-foot"><div class="send"><button type="button" disabled={disabled||completed.current||model.attachments.some(file=>file.uploading)} onClick={()=>void send()}><Icon name="send" size="s"/>{busy==='send'?'보내는 중…':'보내기'}</button></div><div class="r"><button class="ib" type="button" aria-label="파일 첨부" disabled={disabled} onClick={()=>fileInput.current.click()}><Icon name="clip" size="s"/></button><button class="ib" type="button" aria-label="임시 메일 삭제" disabled={disabled||result?.sentCopySavedTo===null} onClick={()=>void discard()}><Icon name="trash" size="s"/></button></div></div></>:<div class="empty-read" role="status">{restoredAttempt.current?'발송 결과를 확인하는 창이에요. 작성 내용은 임시보관함에서 확인해 주세요.':error?'':seed?.kind==='draft'?'임시 메일을 불러오는 중…':'보낼 주소를 불러오는 중…'}</div>}
  </section>{replacement&&<SignatureDialog key={`${replacement.type}:${replacement.from??replacement.id??'none'}`} type="replace" nextSignature={signatureSnapshot.current.items.find(item=>item.id===nextId)||null} returnFocusRef={signatureButton} onCancel={()=>setReplacement(null)} onConfirm={()=>changeSignature(replacement,true)}/>}</>;
}
