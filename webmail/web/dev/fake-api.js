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
  const state = { authenticated, config: structuredClone(fakeConfigs[variant]), folders: structuredClone(fixtureFolders), loginError: null, sessionError: null, protectedError: null, csrf: 'synthetic-csrf-token', requests: [], storage: { quota: {usedBytes:16.6*1024**3,limitBytes:20*1024**3},level:'warn',folders:[] }, vacation: {enabled:true,until:'2026-10-17'} };
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
    if(path==='/api/storage')return send(response,200,state.storage);
    if(path==='/api/dev/vacation')return send(response,200,state.vacation);
    send(response,404,{error:{code:'NOT_FOUND',message:'요청한 경로를 찾을 수 없어요.'}});
  }
  return {state,middleware};
}
