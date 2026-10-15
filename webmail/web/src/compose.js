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
export function initialComposition(seed,identities,preferences,email) {
  const from=identities.defaultFrom||identities.identities[0]?.address||email,kind=seed?.kind||'new',message=seed?.message;
  const base={kind,from,to:[],cc:[],bcc:[],pendingTo:'',pendingCc:'',pendingBcc:'',subject:'',html:'<p><br></p>',attachments:[],forwardFiles:[],draftRef:null,internalImages:false};
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
    base.html=`<p><br></p><blockquote><p>${escapeHtml((message.from||[]).map(item=>item.name?`${item.name} <${item.address}>`:item.address).join(', '))}<br>${escapeHtml(message.date||'')}<br>${escapeHtml(message.subject||'')}</p>${body}</blockquote>`;
  }
  base.html=replaceSignature(base.html,signatureMarkup(preferences,from,kind!=='forward'));return base;
}
export function composePayload(model,sending=false) {
  return {from:model.from,to:recipients(model.to,sending?model.pendingTo:''),cc:recipients(model.cc,sending?model.pendingCc:''),bcc:recipients(model.bcc,sending?model.pendingBcc:''),subject:model.subject,html:model.html,attachmentIds:model.attachments.filter(file=>file.id).map(file=>file.id),...(model.draftRef?{draftRef:model.draftRef}:{}),...(model.forwardFiles.length?{forwardParts:model.forwardFiles.map(({ref,partId})=>({ref,partId}))}:{}),...(model.inReplyTo?{inReplyTo:model.inReplyTo}:{}),...(model.references?{references:model.references}:{}),...(sending&&model.replyToRef?{replyToRef:model.replyToRef}:{})};
}
export function attachmentLimitMessage(filename,limit,bytes) {return `‘${filename}’을 붙일 수 없어요. 한 메일의 첨부는 모두 합쳐 ${limit}MB까지예요(지금 ${Number((bytes/1024**2).toFixed(1))}MB). 파일을 나눠 여러 메일로 보내 주세요.`;}
export const sendWarnings={SENT_COPY_FAILED:'보냈지만 보낸편지함에 사본을 남기지 못했어요',DRAFT_DELETE_FAILED:'보냈지만 임시저장본을 지우지 못했어요',ANSWERED_FAILED:'보냈지만 답장 표시를 남기지 못했어요'};
