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
  if (state.startsWith('import_')) result.importReport = {format:'rainloop',sourceName:'rainloop.user',sourceSha256:'a'.repeat(64),rules:structuredClone(exampleRules.slice(0,2)),items:[{n:1,summary:'거래처 명세서를 폴더로 옮기기',status:'same',changes:[]},{n:2,summary:'세금계산서 폴더로 옮기기',status:'changed',changes:['받은편지함에 남지 않고 폴더로만 가요 · POP3·Gmail 가져오기로 받지 않아요']},...(state==='import_blocked'?[{n:3,summary:'기존 메일 본문 조건',status:'unconvertible',changes:[],reason:'본문 조건은 옮길 수 없어요.'}]:[])]};
  return {...result,...overrides};
}
export async function fakeRules(request, response, state, send) {
  const path = new URL(request.url,'http://localhost').pathname;
  if (!path.startsWith('/api/rules')) return false;
  if (request.method === 'GET') {send(response,200,state.rules);return true;}
  let raw='';for await(const chunk of request) raw+=chunk;
  let body;try{body=raw?JSON.parse(raw):undefined;}catch{send(response,400,{error:{code:'BAD_REQUEST',message:'요청을 확인해 주세요.'}});return true;}
  state.requests[state.requests.length-1].body=body;
  const fail = (code,message) => send(response,409,{error:{code,message}});
  if (state.rulesError) {fail(state.rulesError,'필터가 바뀌었어요. 다시 확인해 주세요.');return true;}
  if (request.method==='PUT' && path==='/api/rules') {
    if (!['ok','none'].includes(state.rules.state)) fail('RULES_STATE','현재 필터 상태에서는 이 작업을 할 수 없어요.');
    else if (body.baseRev!==state.rules.rev) fail('RULES_CONFLICT','필터가 바뀌었어요. 다시 불러온 뒤 저장해 주세요.');
    else {const rev=state.rules.rev+1;state.rules={...rulesFixture(),doc:{...body.doc,rev},rev};send(response,200,{rev});}
  } else if (request.method==='POST' && path==='/api/rules/import') {
    if(state.rules.state!=='import_pending')fail('RULES_STATE','현재 필터 상태에서는 이 작업을 할 수 없어요.');
    else if(body.sourceName!==state.rules.importReport.sourceName || body.sourceSha256!==state.rules.importReport.sourceSha256)fail('IMPORT_SOURCE_CHANGED','가져올 필터가 바뀌었어요. 다시 확인해 주세요.');
    else {state.rules={...rulesFixture(),doc:{...rulesFixture().doc,rev:1,rules:state.rules.importReport.rules},rev:1};send(response,200,{rev:1});}
  } else if(request.method==='POST' && path==='/api/rules/reactivate' && state.rules.state==='inactive_other') {
    const previousActive=state.rules.activeName;state.rules={...state.rules,state:'ok',activeName:'webmail-rules',activeScript:'webmail-rules'};send(response,200,{previousActive});
  } else if(request.method==='POST' && path==='/api/rules/restore' && ((body.source==='data' && state.rules.state==='modified_externally') || (body.source==='prev' && state.rules.state==='damaged' && state.rules.prevAvailable))) {
    const rev=(state.rules.rev??0)+1;state.rules={...rulesFixture(),rev,doc:{...rulesFixture().doc,rev}};send(response,200,{rev});
  } else fail('RULES_STATE','현재 필터 상태에서는 이 작업을 할 수 없어요.');
  return true;
}
