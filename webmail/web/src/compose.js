export function escapeHtml(value='') {return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
export function parseRecipient(value) {
  const match=value.trim().match(/^(.*?)<([^<>]+)>$/),address=(match?match[2]:value).trim(),name=match?match[1].trim().replace(/^"|"$/g,''):'';
  if(!/^[^\s<>@,;:"()[\]\\\x00-\x1f\x7f]+@[^\s<>@,;:"()[\]\\\x00-\x1f\x7f]+$/.test(address))throw {code:'BAD_ADDRESS',message:'메일 주소를 확인해 주세요.'};
  return {address:address.toLowerCase(),name};
}
export function recipients(values,pending='') {
  const all=[...values,...pending.split(/[,;\n]/).filter(value=>value.trim()).map(parseRecipient)];
  return [...new Map(all.map(item=>[item.address.toLowerCase(),item])).values()];
}
export function signatureMarkup(preferences,from,enabled=true) {
  const signature=preferences.signatures?.[from];
  return enabled&&signature?.auto&&signature.html?`<!--webmail-signature--><div class="sig">${signature.html}</div><!--/webmail-signature-->`:'';
}
export function replaceSignature(html,signature) {
  const marker=/<!--webmail-signature-->[\s\S]*?<!--\/webmail-signature-->/;
  return marker.test(html)?html.replace(marker,()=>signature):html+signature;
}
export function initialComposition(seed,identities,preferences,email,options) {
  const from=identities.defaultFrom||identities.identities[0]?.address||email,kind=seed?.kind||'new',message=seed?.message;
  const base={composeId:crypto.randomUUID(),kind,from,to:[],cc:[],bcc:[],pendingTo:'',pendingCc:'',pendingBcc:'',subject:'',html:'<p><br></p>',attachments:[],forwardFiles:[],draftRef:null,internalImages:false};
  if(message){
    const own=new Set([email,...identities.identities.map(item=>item.address)].map(value=>value.toLowerCase()));
    const other=items=>recipients((items||[]).filter(item=>!own.has(item.address.toLowerCase())));
    let reply=other(message.replyTo?.length?message.replyTo:message.from);if(!reply.length)reply=other(message.to);
    if(kind!=='forward'){
      base.to=kind==='replyall'?recipients([...reply,...other(message.to)]):reply;
      base.cc=kind==='replyall'?other(message.cc).filter(item=>!base.to.some(to=>to.address.toLowerCase()===item.address.toLowerCase())):[];
      if(message.messageId)base.inReplyTo=message.messageId;
      const refs=[...(message.references||'').split(/\s+/).filter(Boolean),message.messageId].filter(Boolean);if(refs.length)base.references=[...new Set(refs)].join(' ');
      base.replyToRef=message.ref;
    }else base.forwardFiles=(message.attachments||[]).map(file=>({...file,ref:message.ref}));
    const prefix=kind==='forward'?'Fwd:':'Re:';
    base.subject=(kind==='forward'?/^fwd?:/i:/^re:/i).test(message.subject||'')?message.subject:`${prefix} ${message.subject||''}`;
    const body=message.html??`<pre>${escapeHtml(message.text||'')}</pre>`;
    base.internalImages=/(?:cid:|\/api\/messages\/[^"'<> ]+\/parts\/)/i.test(body);
    base.html=`<p><br></p><blockquote><p>${escapeHtml((message.from||[]).map(item=>item.name?`${item.name} <${item.address}>`:item.address).join(', '))}<br>${escapeHtml(message.date?new Date(message.date).toLocaleString('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'short',hour:'numeric',minute:'2-digit'}):'')}<br>${escapeHtml(message.subject||'')}</p>${body}</blockquote>`;
  }
  if(options){
    base.signatureNonce=options.nonce??composeSignatureNonce();
    if(!/^[A-Za-z0-9_-]{32}$/.test(base.signatureNonce))throw signatureInvalid();
    Object.assign(base,{selectedSignatureId:null,signatureRange:null,signatureBaseline:'',signatureDirty:false,signatureImages:[],signatureImageSizes:{},signatureImageBytes:0});
    const id=defaultCompositionSignature(options.signatures,from,kind);
    Object.assign(base,selectCompositionSignature(base,id,options.signatures,options.images).patch);
  }else base.html=replaceSignature(base.html,signatureMarkup(preferences,from,kind!=='forward'));
  return base;
}
export function composePayload(model,sending=false) {
  return {from:model.from,to:recipients(model.to,sending?model.pendingTo:''),cc:recipients(model.cc,sending?model.pendingCc:''),bcc:recipients(model.bcc,sending?model.pendingBcc:''),subject:model.subject,html:model.html,...(model.signatureImages?{signatureImages:model.signatureImages.map(({token,assetId})=>({token,assetId}))}:{}),attachmentIds:model.attachments.filter(file=>file.id).map(file=>file.id),...(model.draftRef?{draftRef:model.draftRef}:{}),...(model.forwardFiles.length?{forwardParts:model.forwardFiles.map(({ref,partId})=>({ref,partId}))}:{}),...(model.inReplyTo?{inReplyTo:model.inReplyTo}:{}),...(model.references?{references:model.references}:{}),...(sending&&model.replyToRef?{replyToRef:model.replyToRef}:{})};
}
// These ranges and markers belong only to the live composition, never to stored mail.
const signatureInvalid=()=>({code:'SIGNATURE_INVALID',message:'서명 형식을 확인해 주세요.'});
const canonicalSignatureImage=/^cid:wm-sig-v1\.([A-Za-z0-9_-]{32})@signature\.invalid$/;
function composeSignatureNonce(){
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g,'-').replace(/\//g,'_');
}
function signatureFragment(html){const root=document.createElement('template');root.innerHTML=html;return root;}
function outsideQuote(node){return !node.parentElement?.closest('blockquote');}
export function defaultCompositionSignature(signatures,from,kind='new'){
  const defaults=signatures?.defaults?.[from.toLowerCase()];
  return defaults?.[kind==='new'?'newDefault':'replyDefault']??null;
}
function signatureMarkers(nonce){return {start:`<!--webmail-signature:${nonce}-->`,end:`<!--/webmail-signature:${nonce}-->`};}
function currentSignatureRange(html,nonce){
  const markers=signatureMarkers(nonce),locations=[];
  // Label temporary comments with source offsets. Parsing decides whether a comment
  // is really a boundary, rather than text in an attribute, script, or quoted mail.
  const source=html.replace(/<!--[\s\S]*?-->/g,(comment,index)=>{
    if(comment!==markers.start&&comment!==markers.end)return comment;
    const key=locations.length;locations.push({index,length:comment.length,start:comment===markers.start});
    return `<!--wm-range-${nonce}-${key}-->`;
  });
  const root=signatureFragment(source),walker=document.createTreeWalker(root.content,128),prefix=`wm-range-${nonce}-`;
  let start;
  for(let node=walker.nextNode();node;node=walker.nextNode()){
    if(!node.data.startsWith(prefix)||!outsideQuote(node))continue;
    const location=locations[Number(node.data.slice(prefix.length))];
    if(!location)continue;
    if(location.start){if(!start)start={node,location};}
    else if(start&&node.parentNode===start.node.parentNode)return {start:start.location.index,end:location.index+location.length};
  }
  return null;
}
function signatureInsertionPoint(html,nonce){
  const locations=[],prefix=`wm-insert-${nonce}-`;
  const source=html.replace(/<blockquote(?=[\s/>])/gi,(tag,index)=>{
    const key=locations.length;locations.push(index);return `<!--${prefix}${key}-->${tag}`;
  });
  const root=signatureFragment(source),walker=document.createTreeWalker(root.content,128);
  for(let node=walker.nextNode();node;node=walker.nextNode()){
    if(node.data.startsWith(prefix)&&outsideQuote(node))return locations[Number(node.data.slice(prefix.length))];
  }
  return html.length;
}
function signatureContents(html,range,nonce){
  if(!range)return '';
  const {start,end}=signatureMarkers(nonce);
  return signatureFragment(html.slice(range.start+start.length,range.end-end.length)).innerHTML;
}
function compositionImages(html,entries,sizes){
  const root=signatureFragment(html),sources=new Set([...root.content.querySelectorAll('img[src]')].filter(outsideQuote).map(img=>img.getAttribute('src')));
  const manifest=[...new Map(entries.filter(entry=>sources.has(entry.token)).map(entry=>[entry.token,{token:entry.token,assetId:entry.assetId}])).values()];
  const used=[...new Set(manifest.map(entry=>entry.assetId))],imageSizes={};
  for(const id of used)imageSizes[id]=sizes[id];
  return {signatureImages:manifest,signatureImageSizes:imageSizes,signatureImageBytes:used.reduce((total,id)=>total+imageSizes[id],0)};
}
// Call for both rich editor and HTML source changes, after reversing display blobs.
export function updateCompositionHtml(model,html){
  const range=currentSignatureRange(html,model.signatureNonce);
  const dirty=Boolean(model.selectedSignatureId!==null&&(range===null||signatureContents(html,range,model.signatureNonce)!==model.signatureBaseline));
  return {confirmationRequired:false,patch:{html,signatureRange:range,signatureDirty:dirty,...compositionImages(html,model.signatureImages,model.signatureImageSizes)}};
}
function replaceCompositionSignature(model,id,signatures,images,{confirm=false,from=model.from}={}){
  const current=updateCompositionHtml(model,model.html).patch;
  if(current.signatureDirty&&!confirm)return {confirmationRequired:true,patch:null};
  const item=id===null?null:signatures?.items?.find(item=>item.id===id);
  if(id!==null&&!item)throw signatureInvalid();
  const root=signatureFragment(item?.html||''),manifest=[],sizes={...model.signatureImageSizes};
  const inventory=new Map((images?.images||[]).map(image=>[image.id,image]));
  for(const img of root.content.querySelectorAll('img[src]')){
    const src=img.getAttribute('src')||'';
    if(/^data:/i.test(src.replace(/[\s\x00-\x1f]/g,'')))throw {code:'SIGNATURE_DATA_IMAGE_UNSUPPORTED',message:'이미지는 보관함에서 넣어 주세요.'};
    if(!outsideQuote(img))continue;
    const match=canonicalSignatureImage.exec(src);
    if(!match)continue;
    const assetId=match[1],image=inventory.get(assetId);
    if(!image)throw {code:'SIGNATURE_IMAGE_NOT_FOUND',message:'서명 이미지가 보관함에 없어요. 다시 넣어 주세요.'};
    const token=`cid:wm-compose-v1.${model.signatureNonce}.${assetId}@signature.invalid`;
    img.setAttribute('src',token);sizes[assetId]=image.size;manifest.push({token,assetId});
  }
  const content=item?`<div class="sig">${root.innerHTML}</div>`:'',markers=signatureMarkers(model.signatureNonce);
  const markup=item?markers.start+content+markers.end:'';
  const range=current.signatureRange,start=range?.start??signatureInsertionPoint(model.html,model.signatureNonce),end=range?.end??start;
  const html=model.html.slice(0,start)+markup+model.html.slice(end);
  return {confirmationRequired:false,patch:{from,html,selectedSignatureId:id,signatureRange:markup?{start,end:start+markup.length}:null,signatureBaseline:signatureFragment(content).innerHTML,signatureDirty:false,...compositionImages(html,[...model.signatureImages,...manifest],sizes)}};
}
// A confirmation result contains no patch: cancelling leaves every model field intact.
export function selectCompositionSignature(model,id,signatures,images,options={}){
  if(id===model.selectedSignatureId)return {confirmationRequired:false,patch:{}};
  return replaceCompositionSignature(model,id,signatures,images,options);
}
export function changeCompositionFrom(model,from,signatures,images,options={}){
  if(from===model.from)return {confirmationRequired:false,patch:{}};
  return replaceCompositionSignature(model,defaultCompositionSignature(signatures,from,model.kind),signatures,images,{...options,from});
}
export function attachmentLimitMessage(filename,limit,bytes) {return `‘${filename}’을 붙일 수 없어요. 한 메일의 첨부는 모두 합쳐 ${limit}MB까지예요(지금 ${Number((bytes/1024**2).toFixed(1))}MB). 파일을 나눠 여러 메일로 보내 주세요.`;}
export const sendWarnings={SENT_COPY_FAILED:'보냈지만 보낸편지함에 사본을 남기지 못했어요',DRAFT_DELETE_FAILED:'보냈지만 임시저장본을 지우지 못했어요',ANSWERED_FAILED:'보냈지만 답장 표시를 남기지 못했어요'};
