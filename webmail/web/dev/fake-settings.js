// Development-only settings and folder mutation fixtures.
export async function fakeSettings(request,response,state,send,recorded) {
  const path=new URL(request.url,'http://localhost').pathname,method=request.method;
  const target=path.match(/^\/api\/folders\/([^/]+)$/);
  if(!(path==='/api/prefs'&&method==='PUT'||path==='/api/folders'&&method==='POST'||target&&['PATCH','DELETE'].includes(method)))return false;
  let raw='';for await(const chunk of request)raw+=chunk;
  const body=raw?JSON.parse(raw):null;recorded.body=body;
  const fail=(status,code,message,extra={})=>{send(response,status,{error:{code,message,...extra}});return true;};
  if(path==='/api/prefs') {
    const fields=['theme','mode','accent','layout','folderColors','imageAllow','signatures','defaultFrom'];
    if(Buffer.byteLength(raw)>65536)return fail(413,'PREFS_TOO_LARGE','설정은 64KB까지 저장할 수 있어요.');
    if(!body||Object.keys(body).length!==fields.length||fields.some(key=>!(key in body)))return fail(422,'PREFS_INVALID','설정 형식을 확인해 주세요.');
    state.prefs=structuredClone(body);send(response,204);return true;
  }
  const folder=target?state.folders.find(folder=>folder.path===decodeURIComponent(target[1])):null;
  if(target&&!folder)return fail(404,'FOLDER_NOT_FOUND','폴더를 찾을 수 없어요.');
  if(method==='DELETE') {
    const rules=state.rules.doc.rules.filter(rule=>rule.actions.move===folder.path).map(rule=>rule.id);
    if(rules.length)return fail(409,'FOLDER_IN_RULES',undefined,{rules});
    if(state.mail.some(item=>item.folder===folder.path))return fail(409,'FOLDER_NOT_EMPTY','메일이 있는 폴더는 지울 수 없어요.');
    state.folders=state.folders.filter(item=>item.path!==folder.path&&!item.path.startsWith(`${folder.path}/`));send(response,204);return true;
  }
  const name=body?.name;
  if(typeof name!=='string'||!name.trim()||name.length>100||name.includes('/')||name.includes('${')||name.startsWith('.')||/^(Shared|WebmailVirtual)/.test(name))return fail(422,'INVALID_NAME','폴더 이름을 확인해 주세요.');
  if(state.folders.some(item=>item.name===name))return fail(409,'EXISTS','같은 이름의 폴더가 있어요.');
  if(method==='PATCH') {
    if(state.rules.state!=='ok')return fail(409,'RULES_LOCKED','필터 상태를 확인해 주세요.');
    const previous=folder.path;folder.name=name;folder.path=folder.parent?`${folder.parent}/${name}`:name;
    for(const item of state.folders)if(item!==folder&&item.path.startsWith(`${previous}/`)){item.path=folder.path+item.path.slice(previous.length);item.parent=item.path.slice(0,item.path.lastIndexOf('/'));}
    for(const item of state.mail)if(item.folder===previous||item.folder.startsWith(`${previous}/`))item.folder=folder.path+item.folder.slice(previous.length);
    for(const rule of state.rules.doc.rules)if(rule.actions.move===previous)rule.actions.move=folder.path;
    send(response,200,{folder});return true;
  }
  const created={path:body.parent?`${body.parent}/${name}`:name,name,parent:body.parent||null,specialUse:null,shared:false,rights:{write:true,delete:true,insert:true,seen:true},unseen:0,total:0,color:null};
  state.folders.push(created);send(response,201,{folder:created});return true;
}
