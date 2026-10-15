import { fakeRules, rulesFixture } from './fake-rules.js';
// Development and capture fixtures only. Never imported by the browser entry point.
export const fakeConfigs = {
  a: { brandName: '예시 메일', orgName: '예시 회사', brandMark: '예', defaultTheme: 'ink', defaultMode: 'system', attachMaxMb: 25, autoexpungeDays: 30, version: '0.1.0' },
  b: { brandName: '새빛 우편', orgName: '새빛 연구소', brandMark: '빛', defaultTheme: 'ink', defaultMode: 'system', attachMaxMb: 25, autoexpungeDays: null, version: '0.1.0' },
};
const rights = { write: true, delete: true, insert: true, seen: true };
const fixtureFolders = [
  ['INBOX','받은편지함','\\Inbox',9],['Sent','보낸편지함','\\Sent',0],['Drafts','임시보관함','\\Drafts',1],['Archive','보관함','\\Archive',0],['Junk','스팸','\\Junk',3],['Trash','휴지통','\\Trash',0],
].map(([path,name,specialUse,unseen])=>({path,name,parent:null,specialUse,shared:false,rights,unseen,total:20,color:null}));
for(const [i,name] of ['거래처','하늘 프로젝트','인사·총무','세금계산서','뉴스레터','디자인 리뷰'].entries())fixtureFolders.push({path:name,name,parent:null,specialUse:null,shared:false,rights,unseen:i===1?1:0,total:10,color:i+1});
for(const [path,name] of [['Shared/sales@example.com/INBOX','영업팀'],['Shared/support@example.com/INBOX','고객지원']])fixtureFolders.push({path,name,parent:'Shared',specialUse:null,shared:true,owner:path.split('/')[1],rights:{write:false,delete:false,insert:false,seen:true},unseen:2,total:10,color:null});
const messages = {
  EMAIL_FORMAT: '메일 주소를 확인해 주세요.', AUTH_FAILED: '메일 주소나 암호가 맞지 않아요.', RATE_LIMITED: '시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.', MAIL_UNAVAILABLE: '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.', NO_SESSION: '로그인이 필요해요.', SESSION_EXPIRED: '로그인이 만료됐어요. 다시 로그인해 주세요.', CSRF: '요청을 확인할 수 없어요.',
};
export function createFakeApi({ variant = 'a', authenticated = false } = {}) {
  const state = { rules: rulesFixture(), rulesError: null, authenticated, config: structuredClone(fakeConfigs[variant]), folders: structuredClone(fixtureFolders), loginError: null, sessionError: null, protectedError: null, csrf: 'synthetic-csrf-token', requests: [], storage: { quota: {usedBytes:16.6*1024**3,limitBytes:20*1024**3},level:'warn',folders:fixtureFolders.filter(folder=>!folder.shared).map((folder,index)=>({path:folder.path,name:folder.name,messages:index === 5 ? 1204 : 20+index*100,sizeBytes:[6.2,3.1,.2,2.4,.4,2.1,.4,.5,.3,.2,.7,.1][index]*1024**3})).sort((a,b)=>b.sizeBytes-a.sizeBytes) }, vacation: {enabled:true,until:'2026-10-17'} };
  const publicSession = () => ({user:{email:'user@example.com',name:'이서윤'},csrf:state.csrf,expiresAt:Date.now()+8*60*60*1000});
  function send(response,status,payload) {
    response.statusCode=status;response.setHeader('Content-Type','application/json; charset=utf-8');response.setHeader('Cache-Control','no-store');response.end(payload===undefined ? undefined : JSON.stringify(payload));
  }
  function fail(response,code) {send(response,code==='RATE_LIMITED'?429:code==='EMAIL_FORMAT'?400:code==='MAIL_UNAVAILABLE'?503:403,{error:{code,message:messages[code]}});}
  async function middleware(request,response,next) {
    const path = new URL(request.url,'http://localhost').pathname;
    if(!path.startsWith('/api/'))return next();
    state.requests.push({path,method:request.method,csrf:request.headers['x-webmail-csrf']});
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
    if(path==='/api/auth/logout'){state.authenticated=false;return send(response,204);}
    if(path==='/api/folders')return send(response,200,{folders:state.folders,virtualAllMail:'WebmailVirtual/AllMail'});
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
    if(path==='/api/dev/vacation')return send(response,200,state.vacation);
    send(response,404,{error:{code:'NOT_FOUND',message:'요청한 경로를 찾을 수 없어요.'}});
  }
  return {state,middleware};
}
