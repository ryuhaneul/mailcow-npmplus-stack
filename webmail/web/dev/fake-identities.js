// Synthetic authenticated identity/settings endpoints; never included in production.
export const exampleIdentities = {identities:[{address:'user@example.com',name:'이서윤',kind:'self'},{address:'sales@example.com',name:'영업팀',kind:'alias'},{address:'support@example.org',name:'고객지원',kind:'acl'}],anyAtDomains:['@example.net'],anyAddress:false,defaultFrom:'user@example.com'};
export const examplePrefs = {theme:'ink',mode:'light',accent:{},layout:null,folderColors:{거래처:1},imageAllow:['images@example.com'],signatures:{'user@example.com':{html:'<p><b>이서윤</b><br>예시 회사 · user@example.com</p>',auto:true}},defaultFrom:null};
export async function fakeIdentities(request,response,state,send) {
  const path=new URL(request.url,'http://localhost').pathname;
  if(path==='/api/compose/identities'){send(response,200,{...state.identities,defaultFrom:state.prefs.defaultFrom ?? state.identities.defaultFrom});return true;}
  if(path!=='/api/prefs')return false;
  if(request.method==='GET'){send(response,200,state.prefs);return true;}
  let raw='';for await(const chunk of request)raw+=chunk;
  let body;try{body=JSON.parse(raw);}catch{send(response,422,{error:{code:'PREFS_INVALID',message:'설정 형식을 확인해 주세요.'}});return true;}
  state.requests[state.requests.length-1].body=body;
  if(state.prefsError){send(response,503,{error:{code:state.prefsError,message:'설정을 저장할 수 없어요. 잠시 뒤 다시 시도해 주세요.'}});return true;}
  const fields=Object.keys(examplePrefs);
  if(Object.keys(body).length!==fields.length || fields.some(key=>!Object.hasOwn(body,key))){send(response,422,{error:{code:'PREFS_INVALID',message:'설정 형식을 확인해 주세요.'}});return true;}
  state.prefs=structuredClone(body);send(response,204);return true;
}
