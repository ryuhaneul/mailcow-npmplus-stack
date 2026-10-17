import { fakeCompose } from './fake-compose.js';
import { fakeReader } from './fake-reader.js';
import { fakeSettings } from './fake-settings.js';
import { parseSearch } from '../src/search.js';
import { fakeRules, rulesFixture } from './fake-rules.js';
import { fakeIdentities, exampleIdentities, examplePrefs } from './fake-identities.js';
// Development and capture fixtures only. Never imported by the browser entry point.
export const fakeConfigs = {
  a: { brandName: '예시 메일', orgName: '예시 회사', brandMark: '예', defaultTheme: 'ink', defaultMode: 'system', attachMaxMb: 25, contactsEnabled: true, autoexpungeDays: 30, version: '0.1.0' },
  b: { brandName: '새빛 우편', orgName: '새빛 연구소', brandMark: '빛', defaultTheme: 'ink', defaultMode: 'system', attachMaxMb: 25, contactsEnabled: true, autoexpungeDays: null, version: '0.1.0' },
};
const rights = { write: true, delete: true, insert: true, seen: true };
const fixtureFolders = [
  ['INBOX','받은편지함','\\Inbox',9],['Sent','보낸편지함','\\Sent',0],['Drafts','임시보관함','\\Drafts',1],['Archive','보관함','\\Archive',0],['Junk','스팸','\\Junk',3],['Trash','휴지통','\\Trash',0],
].map(([path,name,specialUse,unseen])=>({path,name,parent:null,specialUse,shared:false,rights,unseen,total:20,color:null}));
for(const [i,name] of ['거래처','하늘 프로젝트','인사·총무','세금계산서','뉴스레터','디자인 리뷰'].entries())fixtureFolders.push({path:name,name,parent:null,specialUse:null,shared:false,rights,unseen:i===1?1:0,total:10,color:i+1});
for(const path of ['Shared/sales@example.com/INBOX','Shared/support@example.com/INBOX','Shared/support@example.com/INBOX/처리 완료'])fixtureFolders.push({path,name:path.split('/').at(-1),parent:path.slice(0,path.lastIndexOf('/')),specialUse:null,shared:true,owner:path.split('/')[1],rights:{write:false,delete:false,insert:false,seen:true},unseen:2,total:10,color:null});
let fixtureUid=0;
function fakeMessage(folder,index) {
  const uid=++fixtureUid;
  return {ref:Buffer.from(JSON.stringify([folder,1,uid])).toString('base64url'),folder,folderName:folder.split('/').at(-1),from:{name:['김민수 · 예시상사','박지수 · 디자인팀','a 담당자','예시 안내'][index%4],address:index%3===0?'a@example.com':`sender${uid}@example.com`},to:[{name:'이서윤',address:'user@example.com'}],subject:['견적서 송부드립니다','b 검토 요청','프로젝트 회의 안내','월간 소식'][index%4],preview:'안녕하세요. 검토할 내용을 보내 드립니다.',date:new Date(Date.UTC(2026,9,15-index%4,14-index%8,30)).toISOString(),size:1024*(index+1),seen:index%4===3,flagged:index%3===0,answered:false,hasAttachment:index%2===0};
}
function fixtureMail(){return [['INBOX',12],['Sent',3],['Archive',2],['거래처',3],['하늘 프로젝트',2],['Junk',3],['Trash',2]].flatMap(([folder,count])=>Array.from({length:count},(_,index)=>fakeMessage(folder,index))).sort((a,b)=>b.date.localeCompare(a.date));}
export const mailContrastFixtures = [
  {subject:'이메일 주소 인증',readerHtml:'<div style="color:#202124"><h2>이메일 주소 인증</h2><p>안녕하세요. 이메일 주소를 인증해 주세요.</p><p><a href="https://example.com/verify" style="color:#202124">이메일 주소 인증하기</a></p><p>이 메일을 요청하지 않았다면 무시하셔도 됩니다.</p></div>'},
  {subject:'흰 표 바탕 안내',readerHtml:'<table bgcolor="#ffffff"><tr><td style="color:#202124;padding:24px">흰 표 위의 검은 글씨는 그대로 유지합니다.</td></tr></table>'},
  {subject:'대비가 맞는 안내',readerHtml:'<p style="color:#ffffff">어두운 화면에서 이미 잘 보이는 글씨입니다.</p>'},
];
const messages = {
  EMAIL_FORMAT: '메일 주소를 확인해 주세요.', AUTH_FAILED: '메일 주소나 암호가 맞지 않아요.', RATE_LIMITED: '시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.', MAIL_UNAVAILABLE: '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.', NO_SESSION: '로그인이 필요해요.', SESSION_EXPIRED: '로그인이 만료됐어요. 다시 로그인해 주세요.', CSRF: '요청을 확인할 수 없어요.',
};
export function createFakeApi({ variant = 'a', authenticated = false, contrastMessages = false } = {}) {
  const streams=new Set();
  const state = { rules: rulesFixture(), rulesError: null, mail:fixtureMail(), actionError:null, actionGate:null, actionFailures:[], identities: structuredClone(exampleIdentities), prefs: {...structuredClone(examplePrefs),theme:fakeConfigs[variant].defaultTheme,mode:fakeConfigs[variant].defaultMode}, prefsError: null, authenticated, config: structuredClone(fakeConfigs[variant]), folders: structuredClone(fixtureFolders), loginError: null, sessionError: null, protectedError: null, csrf: 'synthetic-csrf-token', requests: [], storage: { quota: {usedBytes:16.6*1024**3,limitBytes:20*1024**3},level:'warn',folders:fixtureFolders.filter(folder=>!folder.shared).map((folder,index)=>({path:folder.path,name:folder.name,messages:index === 5 ? 1204 : 20+index*100,sizeBytes:[6.2,3.1,.2,2.4,.4,2.1,.4,.5,.3,.2,.7,.1][index]*1024**3})).sort((a,b)=>b.sizeBytes-a.sizeBytes) }, vacation: {enabled:true,until:'2026-10-17'} };
  if(contrastMessages)state.mail.unshift(...mailContrastFixtures.map((fixture,index)=>({...fakeMessage('INBOX',index),...fixture,hasAttachment:false})));
  function emit(type,value){for(const response of streams)response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);}
  const publicSession = () => ({user:{email:'user@example.com',name:'이서윤'},csrf:state.csrf,expiresAt:Date.now()+8*60*60*1000});
  function send(response,status,payload) {
    response.statusCode=status;response.setHeader('Content-Type','application/json; charset=utf-8');response.setHeader('Cache-Control','no-store');response.end(payload===undefined ? undefined : JSON.stringify(payload));
  }
  function fail(response,code) {send(response,code==='RATE_LIMITED'?429:code==='EMAIL_FORMAT'?400:code==='MAIL_UNAVAILABLE'?503:403,{error:{code,message:messages[code]}});}
  async function middleware(request,response,next) {
    const path = new URL(request.url,'http://localhost').pathname;
    if(!path.startsWith('/api/'))return next();
    const recorded={path,url:request.url,method:request.method,csrf:request.headers['x-webmail-csrf']};state.requests.push(recorded);
    if(path==='/api/config')return send(response,200,state.config);
    if(path==='/api/auth/login' && request.method==='POST') {
      let raw='';for await(const chunk of request)raw+=chunk;
      let body;try{body=JSON.parse(raw);}catch{return fail(response,'EMAIL_FORMAT');}
      if(!body.email?.includes('@'))return fail(response,'EMAIL_FORMAT');
      if(state.loginError)return fail(response,state.loginError);
      if(body.password!=='example-password')return fail(response,'AUTH_FAILED');
      state.authenticated=true;return send(response,200,publicSession());
    }
    if(path==='/api/auth/session' && state.sessionError)return fail(response,state.sessionError);
    if(!state.authenticated)return fail(response,'NO_SESSION');
    if(state.protectedError && path!=='/api/auth/session')return fail(response,state.protectedError);
    if(['POST','PUT','PATCH','DELETE'].includes(request.method) && request.headers['x-webmail-csrf']!==state.csrf)return fail(response,'CSRF');
    if(path==='/api/auth/session')return send(response,200,publicSession());
    if(path==='/api/auth/logout'){state.authenticated=false;state.compose?.attachments.clear();return send(response,204);}
    if(await fakeCompose(request,response,state,send,recorded))return;
    if(await fakeReader(request,response,state,send))return;
    if(await fakeSettings(request,response,state,send,recorded))return;
    if(path==='/api/prefs'&&request.method==='GET')return send(response,200,state.prefs);
    if(path==='/api/events'){
      response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});response.write(': ready\n\n');streams.add(response);response.on('close',()=>streams.delete(response));return;
    }
    if(path==='/api/messages'&&request.method==='GET'){
      const query=new URL(request.url,'http://localhost').searchParams,view=query.get('view')||'inbox',q=query.get('q')||'',folder=query.get('folder')||'',selected=view==='spam'?'Junk':view==='folder'?folder:'INBOX';
      const scoped=['Junk','Trash'].includes(selected)||state.folders.some(folder=>folder.path===selected&&folder.specialUse==='\\Trash'),all=!scoped&&(view==='allmail'||q.trim());
      let parsed;try{parsed=parseSearch(q);}catch(error){return send(response,400,{error});}
      let rows=state.mail.filter(item=>all?!['Junk','Trash','Drafts'].includes(item.folder)&&!item.folder.startsWith('Shared/'):item.folder===selected);
      for(const chip of parsed.chips)rows=rows.filter(item=>{
        const value=chip.value.toLowerCase();
        if(chip.field==='from')return (item.from.name+' '+item.from.address).toLowerCase().includes(value);
        if(chip.field==='to')return item.to.some(person=>(person.name+' '+person.address).toLowerCase().includes(value));
        if(chip.field==='subject')return item.subject.toLowerCase().includes(value);
        if(chip.field==='attachment')return item.hasAttachment;
        if(chip.field==='folder')return item.folder===chip.value||item.folderName===chip.value;
        return (item.subject+' '+item.preview+' '+item.from.name+' '+item.from.address).toLowerCase().includes(value);
      });
      if(query.get('in'))rows=rows.filter(item=>item.folder===query.get('in'));
      const quick=query.get('quick');if(quick==='unread')rows=rows.filter(item=>!item.seen);if(quick==='starred')rows=rows.filter(item=>item.flagged);if(quick==='attach')rows=rows.filter(item=>item.hasAttachment);
      const page=Number(query.get('page')||1),pageSize=Number(query.get('pageSize')||50);return send(response,200,{total:rows.length,page,pageSize,items:rows.slice((page-1)*pageSize,page*pageSize)});
    }
    if(path==='/api/messages/actions'){
      let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);recorded.body=body;
      if(state.actionGate)await state.actionGate;
      if(state.actionError)return fail(response,state.actionError);
      const failed=[];let done=0;
      for(const ref of body.refs){
        const item=state.mail.find(item=>item.ref===ref);
        if(!item||state.actionFailures.includes(ref)){failed.push({ref,code:item?'FOLDER_READONLY':'MESSAGE_NOT_FOUND'});continue;}
        if(['flag','unflag','seen','unseen'].includes(body.action)){
          if(['flag','unflag'].includes(body.action))item.flagged=body.action==='flag';else item.seen=body.action==='seen';
        }else if(body.action==='delete-forever')state.mail=state.mail.filter(item=>item.ref!==ref);
        else {const target=({archive:'Archive',trash:'Trash',spam:'Junk',notspam:'INBOX',move:body.target})[body.action];item.folder=target;item.folderName=target.split('/').at(-1);item.ref=Buffer.from(JSON.stringify([target,1,JSON.parse(Buffer.from(ref,'base64url').toString())[2]])).toString('base64url');}
        done++;
      }
      send(response,200,{done,failed});emit('mailbox',{path:'INBOX',unseen:state.mail.filter(item=>item.folder==='INBOX'&&!item.seen).length,total:state.mail.filter(item=>item.folder==='INBOX').length});return;
    }
    if(path==='/api/folders')return send(response,200,{folders:state.folders.map(folder=>({...folder,color:state.prefs.folderColors[folder.path]??folder.color,total:state.mail.filter(item=>item.folder===folder.path).length,unseen:state.mail.filter(item=>item.folder===folder.path&&!item.seen).length})),virtualAllMail:'WebmailVirtual/AllMail'});
    if(path==='/api/storage')return send(response,200,new URL(request.url,'http://localhost').searchParams.get('quotaOnly') === '1' ? {...state.storage,folders:[]} : state.storage);
    const empty = path.match(/^\/api\/folders\/([^/]+)\/empty$/);
    if(empty && request.method==='POST') {
      let raw='';for await(const chunk of request)raw+=chunk;
      const body=JSON.parse(raw);
      const folder=state.storage.folders.find(folder=>folder.path===decodeURIComponent(empty[1]));
      if(!folder)return send(response,404,{error:{code:'NOT_FOUND',message:'폴더를 찾을 수 없어요.'}});
      state.requests.at(-1).body={confirmName:body.confirmName};
      if(body.confirmName!==folder.name)return send(response,422,{error:{code:'CONFIRM_MISMATCH',message:'폴더 이름이 맞지 않아요.'}});
      const result={deleted:folder.messages,freedBytes:folder.sizeBytes};
      folder.messages=0;folder.sizeBytes=0;
      state.storage.quota.usedBytes=Math.max(0,state.storage.quota.usedBytes-result.freedBytes);
      const ratio=state.storage.quota.usedBytes/state.storage.quota.limitBytes;
      state.storage.level=ratio>=.95?'crit':ratio>=.8?'warn':'ok';
      return send(response,200,result);
    }
    if(path==='/api/password' && request.method==='POST') {
      let raw='';for await(const chunk of request)raw+=chunk;
      const body=JSON.parse(raw);
      const error=!body.current || !body.next || !body.next2 ? [422,'PW_FORMAT','암호를 입력해 주세요.'] : body.next!==body.next2 ? [422,'PW_MISMATCH','새 암호가 서로 같지 않아요.'] : body.next===body.current ? [422,'PW_SAME','현재 암호와 다른 새 암호를 입력해 주세요.'] : body.current!=='example-password' ? [403,'CURRENT_WRONG','현재 암호가 맞지 않아요.'] : null;
      if(error)return send(response,error[0],{error:{code:error[1],message:error[2]}});
      state.authenticated=false;return send(response,200,{relogin:true});
    }
    if(await fakeRules(request,response,state,send))return;
    if(await fakeIdentities(request,response,state,send))return;
    send(response,404,{error:{code:'NOT_FOUND',message:'요청한 경로를 찾을 수 없어요.'}});
  }
  return {state,middleware,emit,close(){for(const response of streams)response.end();streams.clear();}};
}
