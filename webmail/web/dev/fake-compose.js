// Development fixtures follow the compose service request/response contract.
export const composeContacts=[{name:'예시 최근',address:'recent@example.com',kind:'recent'},{name:'예시 사람',address:'person@example.com',kind:'person'},{name:'예시 팀',address:'team@example.com',kind:'team'}];
export function composeFixture(){return {attachments:new Map(),nextId:0,draftUid:1000,draftError:null,sendError:null,sendResult:{ok:true},sendGate:null,draftGate:null,draftActive:0,maxDraftActive:0};}
export async function fakeCompose(request,response,state,send,recorded){
  const url=new URL(request.url,'http://localhost'),path=url.pathname;
  if(path==='/api/contacts'){const q=(url.searchParams.get('q')||'').toLowerCase();send(response,200,{items:state.config.contactsEnabled===false?[]:composeContacts.filter(item=>(item.name+' '+item.address).toLowerCase().includes(q)).slice(0,Number(url.searchParams.get('limit')||8))});return true;}
  if(!['/api/attachments','/api/drafts','/api/send'].includes(path)&&!path.startsWith('/api/attachments/'))return false;
  const fixture=state.compose??=composeFixture();
  const fail=(status,code,message,extra={})=>{send(response,status,{error:{code,message,...extra}});return true;};
  if(path.startsWith('/api/attachments/')&&request.method==='DELETE'){const id=decodeURIComponent(path.split('/').at(-1));if(!fixture.attachments.delete(id))return fail(404,'ATTACHMENT_NOT_FOUND','첨부 파일을 찾을 수 없어요.');send(response,204);return true;}
  let raw=[];for await(const chunk of request)raw.push(chunk);raw=Buffer.concat(raw);
  if(path==='/api/attachments'){
    const incoming=new Request('http://localhost/api/attachments',{method:'POST',headers:{'Content-Type':request.headers['content-type']},body:raw});const data=await incoming.formData(),file=data.get('file'),composeId=data.get('composeId')??undefined;
    if(!file||typeof file==='string')return fail(422,'BAD_REQUEST','작성 내용을 확인해 주세요.');
    if(composeId!==undefined&&(typeof composeId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(composeId)))return fail(422,'BAD_REQUEST','작성 내용을 확인해 주세요.');
    recorded.body={filename:file.name,size:file.size,contentType:file.type,composeId};
    const total=[...fixture.attachments.values()].filter(item=>composeId===undefined||item.composeId===composeId).reduce((sum,item)=>sum+item.size,0)+file.size;
    if(total>state.config.attachMaxMb*1024**2)return fail(413,'ATTACH_TOO_LARGE','첨부 파일 합계가 허용 크기를 넘었어요.');
    const value={id:`example-upload-${++fixture.nextId}`,filename:file.name,size:file.size,contentType:file.type||'application/octet-stream'};fixture.attachments.set(value.id,{...value,composeId});send(response,201,value);return true;
  }
  const body=JSON.parse(raw.toString());recorded.body=body;
  if(path==='/api/drafts'){fixture.draftActive++;fixture.maxDraftActive=Math.max(fixture.maxDraftActive,fixture.draftActive);try{if(fixture.draftGate)await fixture.draftGate;if(fixture.draftError)return fail(fixture.draftError.status,fixture.draftError.code,fixture.draftError.message);return writeDraft();}finally{fixture.draftActive--;}}
  if(fixture.sendGate)await fixture.sendGate;
  if(fixture.sendError)return fail(fixture.sendError.status,fixture.sendError.code,fixture.sendError.message,fixture.sendError.smtpMessage?{smtpMessage:fixture.sendError.smtpMessage}:{});
  if(!body.to.length&&!body.cc.length&&!body.bcc.length)return fail(422,'NO_RECIPIENT','받는 사람을 입력해 주세요.');
  const domains=state.identities.anyAtDomains.map(value=>value.replace(/^@/,''));
  if(!state.identities.anyAddress&&!state.identities.identities.some(item=>item.address===body.from)&&!domains.includes(body.from.split('@')[1]))return fail(403,'FROM_NOT_ALLOWED','이 주소로는 메일을 보낼 수 없어요.');
  if(body.attachmentIds.some(id=>!fixture.attachments.has(id)))return fail(404,'ATTACHMENT_NOT_FOUND','첨부 파일을 찾을 수 없어요.');
  const result=fixture.sendResult;
  for(const id of body.attachmentIds)fixture.attachments.delete(id);
  if(body.draftRef&&!result.warnings?.includes('DRAFT_DELETE_FAILED'))state.mail=state.mail.filter(item=>item.ref!==body.draftRef);
  send(response,200,result);return true;
  function writeDraft(){
    if(body.attachmentIds.some(id=>!fixture.attachments.has(id)))return fail(404,'ATTACHMENT_NOT_FOUND','첨부 파일을 찾을 수 없어요.');
    const ref=Buffer.from(JSON.stringify(['Drafts',1,++fixture.draftUid])).toString('base64url');
    state.mail=state.mail.filter(item=>item.ref!==body.draftRef);state.mail.push({ref,folder:'Drafts',folderName:'임시보관함',from:{address:body.from,name:''},to:body.to,subject:body.subject,preview:'',date:new Date().toISOString(),size:raw.length,seen:true,flagged:false,answered:false,hasAttachment:body.attachmentIds.length>0||Boolean(body.forwardParts?.length)});
    // Saving a draft keeps uploaded attachment IDs valid for later saves and send.
    send(response,200,{draftRef:ref});return true;
  }
}
