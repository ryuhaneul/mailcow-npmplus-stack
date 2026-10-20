import { createHash } from 'node:crypto';
import { previewFixture } from './fake-rule-preview.js';
import { minimumDocumentVersion } from '../../server/sieve/model.js';
// Synthetic development fixtures. API fields follow server/sieve/service.js.
export const exampleRules = [
  {id:'rule0001',enabled:true,match:'all',conditions:[{field:'from',op:'has',value:'@partner.example.com'},{field:'subject',op:'has',value:'명세서'}],actions:{move:'거래처'},stop:false},
  {id:'rule0002',enabled:true,match:'any',conditions:[{field:'subject',op:'has',value:'세금계산서'},{field:'subject',op:'has',value:'계산서 발행'}],actions:{move:'세금계산서'},stop:false},
  {id:'rule0003',enabled:true,match:'all',conditions:[{field:'from',op:'eq',value:'winner@prize.example.com'}],actions:{trash:true},stop:true},
  {id:'rule0004',enabled:false,match:'all',conditions:[{field:'from',op:'eq',value:'news@letter.example.com'}],actions:{move:'뉴스레터',read:true},stop:false},
  {id:'rule0005',enabled:true,match:'all',conditions:[{field:'subject',op:'has',value:'[하늘]'}],actions:{move:'하늘 프로젝트',star:true},stop:false},
];
export function rulesFixture(state = 'ok', overrides = {}) {
  const doc = {v:1,rev:7,rules:structuredClone(exampleRules),blocked:[],vacation:{enabled:false,start:null,end:null,subject:'부재중입니다',body:''}};
  const activeName = ['none'].includes(state) ? null : ['import_pending','import_blocked','inactive_other'].includes(state) ? 'rainloop.user' : 'webmail-rules';
  const result = {state,rev:state==='none'?0:['import_pending','import_blocked','damaged'].includes(state)?null:7,doc:state==='none'?{...doc,rev:0,rules:[]}:['import_pending','import_blocked','damaged'].includes(state)?null:doc,activeName,activeScript:activeName,missingFolders:[],internalDomains:['example.com'],prevAvailable:state==='damaged'};
  if (state.startsWith('import_')) result.importReport = {format:'rainloop',sourceName:'rainloop.user',sourceSha256:'a'.repeat(64),planSha256:'b'.repeat(64),rules:structuredClone(exampleRules.slice(0,2)),items:[{n:1,summary:'거래처 명세서를 폴더로 옮기기',status:'same',changes:[]},{n:2,summary:'세금계산서 폴더로 옮기기',status:'changed',changes:['받은편지함에 남지 않고 폴더로만 가요 · POP3·Gmail 가져오기로 받지 않아요']},...(state==='import_blocked'?[{n:3,summary:'기존 메일 본문 조건',status:'unconvertible',changes:[],reason:'본문 조건은 옮길 수 없어요.'}]:[])]};
  if (state === 'newer_version') result.doc = {...doc,v:3};
  if (state === 'import_pending') result.importReport.items.push({n:3,summary:'보낸 사람 body@example.com → 별표',status:'unconvertible',changes:[],reason:'본문 조건은 옮길 수 없어요.'});
  if (state === 'import_blocked') {result.importReport.rules=[];result.importReport.items=result.importReport.items.filter(item=>item.status==='unconvertible');}
  return {...result,...overrides};
}
// Stage-two examples keep the basic five-rule fixture unchanged.
export const exampleGroupedRules = [
  {id:'gmail001',enabled:true,match:'all',conditions:[
    {match:'any',conditions:[{field:'from',op:'eq',value:'billing@example.com'},{field:'from',op:'eq',value:'orders@example.com'}]},
    {match:'any',conditions:[{field:'subject',op:'has',value:'견적'},{field:'subject',op:'has',value:'발주'}]},
  ],actions:{move:'거래처'},stop:false},
  {id:'gmail002',enabled:true,match:'all',conditions:[{field:'subject',op:'matches',value:'*소식*'}],actions:{move:'신규 폴더',read:true},stop:false},
];
// Synthetic XML preview, independently overridable by UI scenarios.
export function gmailImportFixture() {
  const [same,changed] = structuredClone(exampleGroupedRules);
  return [
    {n:1,gmail:{conditions:[['보낸 사람','billing@example.com OR orders@example.com'],['제목','견적 OR 발주']],actions:['받은편지함 건너뛰기','거래처 라벨']},status:'same',rule:same,changes:[]},
    {n:2,gmail:{conditions:[['제목','*소식*']],actions:['신규 폴더 라벨','스팸으로 보내지 않음','읽음 표시']},status:'changed',rule:changed,changes:['Gmail은 검색어처럼 찾지만, 여기서는 제목 전체를 패턴으로 비교해요.','스팸으로 보내지 않음은 반영하지 않아요.','받은편지함에 남지 않고 폴더로만 가요.'],newFolder:'신규 폴더'},
    {n:3,gmail:{conditions:[['포함하는 단어','body:example']],actions:['별표']},status:'no',changes:[],reason:'본문 조건은 옮길 수 없어요.'},
  ];
}
const sha = value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function xmlPreview(state, body) {
  if (state.importPreview) return structuredClone(state.importPreview);
  const items = gmailImportFixture();
  const existing = state.rules.doc?.rules.length ?? 0;
  const mode = body.mode ?? 'new';
  const applied = items.filter(item => item.status !== 'no').length;
  const plan = {mode,existing,applied,total:(mode==='append'?existing:0)+applied,newFolders:['신규 폴더'],replacesUndo:!!state.rules.importInfo};
  if(state.rules.activeName && state.rules.activeName!=='webmail-rules')plan.deactivates=state.rules.activeName;
  const expect = {xmlSha256:sha(body.xml),mode,...(state.rules.rev==null?{}:{rev:state.rules.rev}),...(state.rules.activeName?{activeName:state.rules.activeName,activeSha256:sha(state.rules.activeName)}:{}),planSha256:sha({items,plan,rev:state.rules.rev})};
  return {items,counts:{same:1,changed:1,no:1},plan,expect};
}
function imported(state, {rules,dropped,mode,name,kind,createdFolders=[],deactivated}) {
  state.importUndo = structuredClone(state.rules);
  for(const path of createdFolders)if(!state.folders.some(folder=>folder.path===path))state.folders.push({...state.folders[0],path,name:path.split('/').at(-1),parent:path.includes('/')?path.slice(0,path.lastIndexOf('/')):null,specialUse:null,shared:false,unseen:0,total:0,color:null});
  const rev = (state.rules.rev ?? 0) + 1;
  const doc = {...(state.rules.doc ?? rulesFixture('none').doc),rev,rules:mode==='append'?[...(state.rules.doc?.rules ?? []),...rules]:rules};
  doc.v = minimumDocumentVersion(doc.rules);
  const importInfo = {at:new Date().toISOString(),source:{kind,name},mode,dropped:dropped.map(item=>({n:item.n,summary:item.summary ?? [...(item.gmail?.conditions ?? []).map(([key,value])=>`${key}: ${value}`),...(item.gmail?.actions ?? [])].join(' · '),reason:item.reason})),undo:{available:true,edited:false}};
  state.rules = {...state.rules,state:'ok',doc,rev,activeName:'webmail-rules',activeScript:'webmail-rules',importInfo};
  delete state.rules.importReport;
  return {rev,applied:rules.length,dropped:dropped.length,createdFolders,...(deactivated?{deactivated}:{})};
}
export async function fakeRules(request, response, state, send) {
  const path = new URL(request.url,'http://localhost').pathname;
  if (!path.startsWith('/api/rules')) return false;
  if (request.method === 'GET') {send(response,200,state.rules);return true;}
  let raw='';for await(const chunk of request) raw+=chunk;
  let body;try{body=raw?JSON.parse(raw):undefined;}catch{send(response,400,{error:{code:'BAD_REQUEST',message:'요청을 확인해 주세요.'}});return true;}
  state.requests[state.requests.length-1].body=body;
  if (request.method==='POST' && path==='/api/rules/preview') {send(response,200,state.rulePreview ?? previewFixture(body.rule));return true;}
  const fail = (code,message) => send(response,409,{error:{code,message}});
  if (state.rulesError) {
    const error = typeof state.rulesError === 'string' ? {code:state.rulesError,message:'필터가 바뀌었어요. 다시 확인해 주세요.'} : state.rulesError;
    send(response,['FOLDER_CREATE_FAILED','IMPORT_WRITE_FAILED'].includes(error.code)?502:409,{error});return true;
  }
  if (request.method==='POST' && ['/api/rules/import/xml/preview','/api/rules/import/xml'].includes(path)) {
    if(!['none','ok','import_pending','import_blocked','inactive_other'].includes(state.rules.state)) fail('RULES_STATE','현재 필터 상태에서는 가져올 수 없어요.');
    else if(typeof body?.xml!=='string' || typeof body?.fileName!=='string' || (body.mode!==undefined && !['append','replace'].includes(body.mode))) send(response,422,{error:{code:'RULES_INVALID',message:'가져오기 요청을 확인해 주세요.'}});
    else {
      const preview = xmlPreview(state,body);
      if(path.endsWith('/preview')) send(response,200,preview);
      else if(body.confirm!==true) send(response,422,{error:{code:'RULES_INVALID',message:'반영 내용을 확인해 주세요.'}});
      else if(JSON.stringify(body.expect)!==JSON.stringify(preview.expect)) fail('IMPORT_PREVIEW_CHANGED','미리보기 뒤 필터가 바뀌었어요.');
      else if(!preview.plan.applied) fail('IMPORT_NOTHING','반영할 수 있는 규칙이 없어요.');
      else send(response,200,imported(state,{rules:preview.items.flatMap(item=>item.rule?[item.rule]:[]),dropped:preview.items.filter(item=>['no','unconvertible'].includes(item.status)),mode:preview.plan.mode,name:body.fileName,kind:'gmail-xml',createdFolders:preview.plan.newFolders,deactivated:preview.plan.deactivates}));
    }
  } else if(request.method==='POST' && path==='/api/rules/import/undo') {
    const info=state.rules.importInfo;
    if(state.rules.state==='newer_version') fail('RULES_STATE','현재 필터 상태에서는 이 작업을 할 수 없어요.');
    else if(!info?.undo.available || !state.importUndo || body?.at!==info.at) fail('UNDO_UNAVAILABLE','이 가져오기는 되돌릴 수 없어요.');
    else if(info.undo.edited && !body.acceptEdits) fail('UNDO_EDITED','가져온 뒤 고친 내용이 있어요.');
    else {state.rules=state.importUndo;delete state.rules.importInfo;delete state.importUndo;send(response,200,{...(state.rules.rev==null?{}:{rev:state.rules.rev}),restored:state.rules.state!=='none' && state.rules.doc?'webmail':'none',...(state.rules.activeName?{activeName:state.rules.activeName}:{})});}
  } else if (request.method==='PUT'  && path==='/api/rules') {
    if (!['ok','none'].includes(state.rules.state)) fail('RULES_STATE','현재 필터 상태에서는 이 작업을 할 수 없어요.');
    else if (body.baseRev!==state.rules.rev) fail('RULES_CONFLICT','필터가 바뀌었어요. 다시 불러온 뒤 저장해 주세요.');
    else {const rev=state.rules.rev+1;const importInfo=state.rules.importInfo;state.rules={...rulesFixture(),doc:{...body.doc,rev},rev,...(importInfo?{importInfo:{...importInfo,undo:{...importInfo.undo,edited:true}}}:{})};send(response,200,{rev});}
  } else if (request.method==='POST' && path==='/api/rules/apply-existing') {
    const matched=previewFixture(body.rule).count;
    send(response,200,state.ruleApplyResult ?? {matched,moved:body.rule.actions.move?matched:0,trashed:body.rule.actions.trash?matched:0,flagged:body.rule.actions.read||body.rule.actions.star?matched:0,failed:[]});
  } else if (request.method==='POST' && path==='/api/rules/import') {
    if(!['import_pending','import_blocked'].includes(state.rules.state))fail('RULES_STATE','현재 필터 상태에서는 이 작업을 할 수 없어요.');
    else if(body.sourceName!==state.rules.importReport.sourceName || body.sourceSha256!==state.rules.importReport.sourceSha256)fail('IMPORT_PREVIEW_CHANGED','가져올 필터가 바뀌었어요. 다시 확인해 주세요.');
    else if(body.confirm!==true || body.planSha256!==state.rules.importReport.planSha256) fail('IMPORT_PREVIEW_CHANGED','미리보기를 다시 확인해 주세요.');
    else {const report=state.rules.importReport;send(response,200,imported(state,{rules:report.rules,dropped:report.items.filter(item=>['no','unconvertible'].includes(item.status)),mode:'new',name:report.sourceName,kind:'active-script',deactivated:state.rules.activeName}));}
  } else if(request.method==='POST' && path==='/api/rules/reactivate' && state.rules.state==='inactive_other') {
    const previousActive=state.rules.activeName;state.rules={...state.rules,state:'ok',activeName:'webmail-rules',activeScript:'webmail-rules'};send(response,200,{previousActive});
  } else if(request.method==='POST' && path==='/api/rules/restore' && ((body.source==='data' && state.rules.state==='modified_externally') || (body.source==='prev' && state.rules.state==='damaged' && state.rules.prevAvailable))) {
    const rev=(state.rules.rev??0)+1;state.rules={...rulesFixture(),rev,doc:{...rulesFixture().doc,rev}};send(response,200,{rev});
  } else fail('RULES_STATE','현재 필터 상태에서는 이 작업을 할 수 없어요.');
  return true;
}
