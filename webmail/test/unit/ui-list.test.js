import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearch } from '../../web/src/search.js';
import { parseSearchQuery } from '../../server/mail/search-query.js';
import { parseRoute, route } from '../../web/src/router.js';
import { list, cursor, acting, loadMessages, cancelListLoad, runAction, connectMailboxEvents, deleteMessages, deleteConfirmation, settleDeleteConfirmation, resetMailbox, loadFailureMessages } from '../../web/src/state/list.js';
import { selection, scopeSelection, selectionMode, selectPage, selectAllMatching, toggleSelection, clearSelection, isSelected, updateSelectionPage, selectionScope } from '../../web/src/state/selection.js';
import { runSelectedAction, deleteSelectedMessages, requestScopedAction, cancelScopedAction, confirmScopedAction, stopScopedAction, resumeScopedAction, retryFailedScopedAction, returnToMailbox, canResumeScopedAction, scopedRequestPending } from '../../web/src/state/scoped-actions.js';
import { folders, folderColor, folderColorsAfterChange } from '../../web/src/state/folders.js';
import { storage } from '../../web/src/state/storage.js';
import { session, sessionReady } from '../../web/src/state/session.js';
import { toast } from '../../web/src/state/toast.js';
import { prefs, loadSessionPrefs } from '../../web/src/state/prefs.js';
const params={view:'inbox',folder:'',page:1,pageSize:50,quick:'all',q:'',in:''};
const rows=[1,2,3].map(index=>({ref:`ref${index}`,folder:'INBOX',folderName:'받은편지함',from:{name:'예시',address:'sender@example.com'},to:[],subject:`제목 ${index}`,date:`2026-10-${16-index}T00:00:00.000Z`,size:1024,seen:false,flagged:false,answered:false,hasAttachment:false}));
function setup(t,fetcher) {
  const old=globalThis.fetch;globalThis.fetch=fetcher;
  resetMailbox();route.value=parseRoute('#inbox');list.value={params:{...params},items:structuredClone(rows),total:3,loading:false,error:null};selection.value=new Set();cursor.value=rows[0].ref;acting.value=false;session.value={user:{email:'user@example.com'},csrf:'synthetic-csrf'};sessionReady.value=true;toast.value=null;updateSelectionPage(rows);
  t.after(()=>{resetMailbox();route.value=parseRoute('#inbox');globalThis.fetch=old;session.value=null;sessionReady.value=false;toast.value=null;});
}
function result(items) {return Response.json({items,total:items.length,page:1,pageSize:50});}
test('search chips and rule seed agree with server grammar; body words and folders do not become conditions',()=>{
  for(const query of ['보낸사람:a 제목:b','from:"a b" subject:c 첨부:있음','받는사람:user@example.com 폴더:"하늘 프로젝트" 본문','to:a has:attachment "some words"','unknown:value','from:"a\\" b"']){
    const ui=parseSearch(query),server=parseSearchQuery(query);
    assert.deepEqual(ui.conditions,server.ruleConditions,query);assert.deepEqual(ui.textTerms,server.textTerms,query);
    assert.deepEqual(ui.chips.filter(chip=>chip.field==='folder').map(chip=>chip.value),server.folderFilters);
  }
  assert.equal(parseSearch('보낸사람:a 제목:b').chips.length,2);
  assert.throws(()=>parseSearch('제목:"닫히지 않은 검색'));
});
test('router: spam and a localized trash path retain encoded query on reload',()=>{
  for(const hash of ['#spam?q='+encodeURIComponent('제목:b'), '#f/'+encodeURIComponent('내 휴지통')+'?q='+encodeURIComponent('보낸사람:a')]){
    const parsed=parseRoute(hash);assert.ok(parsed.q);assert.equal(parsed.name,hash.startsWith('#spam')?'spam':'f');
    if(parsed.name==='f')assert.equal(parsed.value,'내 휴지통');
  }
});
test('flag is optimistic and a failed action restores it with the server error',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  setup(t,async()=>{await gate;return Response.json({error:{code:'MAIL_UNAVAILABLE',message:'잠시 뒤 다시 시도해 주세요.'}},{status:503});});
  const pending=runAction('flag',[rows[0].ref]);assert.equal(list.value.items[0].flagged,true);release();await pending;
  assert.equal(list.value.items[0].flagged,false);assert.equal(toast.value.message,'잠시 뒤 다시 시도해 주세요.');
});
test('archive waits for success, sends exact three refs and reloads the list',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});let body;
  setup(t,async(path,options)=>{if(path==='/api/messages/actions'){body=JSON.parse(options.body);await gate;return Response.json({done:3,failed:[]});}return result([]);});
  selection.value=new Set(rows.map(item=>item.ref));const pending=runAction('archive');assert.equal(list.value.items.length,3);
  release();await pending;assert.deepEqual(body,{refs:rows.map(item=>item.ref),action:'archive'});assert.equal(list.value.items.length,0);assert.equal(selection.value.size,0);
});
test('partial failures retain failed selection and revert only failed flags',async t=>{
  setup(t,async path=>path==='/api/messages/actions'?Response.json({done:2,failed:[{ref:rows[1].ref,code:'FOLDER_READONLY'}]}):result(rows.map((item,index)=>({...item,flagged:index!==1}))));
  selection.value=new Set(rows.map(item=>item.ref));await runAction('flag');
  assert.deepEqual(list.value.items.map(item=>item.flagged),[true,false,true]);assert.deepEqual([...selection.value],[rows[1].ref]);assert.equal(toast.value.message,'이 폴더는 변경할 수 없어요.');
});
test('a stale list request cannot replace a newer quick-filter result',async t=>{
  const waits=[];setup(t,()=>new Promise(resolve=>waits.push(resolve)));
  const first=loadMessages(),second=loadMessages({quick:'unread'});
  waits[1](result([rows[1]]));await second;waits[0](result(rows));await first;
  assert.deepEqual(list.value.items.map(item=>item.ref),[rows[1].ref]);assert.equal(list.value.params.quick,'unread');
});
test('mailbox/quota/session SSE events update counts, storage and session',async t=>{
  setup(t,async path=>path==='/api/auth/session'?Response.json({error:{code:'SESSION_EXPIRED',message:'synthetic expiry'}},{status:403}):result(rows));const previous=globalThis.EventSource;let stream;
  globalThis.EventSource=class{listeners={};closed=false;constructor(){stream=this;}addEventListener(name,handler){this.listeners[name]=handler;}close(){this.closed=true;}emit(name,value){this.listeners[name]({data:JSON.stringify(value)});}};
  t.after(()=>{globalThis.EventSource=previous;});route.value=parseRoute('#inbox');folders.value={folders:[{path:'INBOX',unseen:1,total:3}],virtualAllMail:'WebmailVirtual/AllMail'};
  const close=connectMailboxEvents();stream.emit('mailbox',{path:'INBOX',unseen:7,total:12});assert.equal(folders.value.folders[0].unseen,7);assert.equal(folders.value.folders[0].total,12);
  stream.emit('quota',{usedBytes:95,limitBytes:100});assert.deepEqual(storage.value.quota,{usedBytes:95,limitBytes:100});
  stream.emit('session',{state:'expired'});await new Promise(resolve=>setImmediate(resolve));assert.equal(session.value,null);assert.equal(sessionReady.value,false);assert.equal(stream.closed,true);assert.equal(toast.value.kind,'session-expired');close();
});
test('server preferences are applied and copied before session becomes ready',async t=>{
  const server={theme:'olive',mode:'dark',accent:{},layout:null,folderColors:{},imageAllow:[],signatures:{},defaultFrom:null};
  const previous=globalThis.localStorage,oldPrefs=prefs.value,copy={};globalThis.localStorage={setItem(key,value){copy[key]=value;}};
  t.after(()=>{if(previous===undefined)delete globalThis.localStorage;else globalThis.localStorage=previous;prefs.value=oldPrefs;});
  setup(t,async path=>{assert.equal(path,'/api/prefs');assert.equal(sessionReady.value,false);return Response.json(server);});sessionReady.value=false;
  await loadSessionPrefs();assert.deepEqual(prefs.value,server);assert.deepEqual(JSON.parse(copy['webmail-prefs']),server);assert.equal(sessionReady.value,true);
});

test('a different folder clears old rows while its request is pending',async t=>{
  let release;setup(t,()=>new Promise(resolve=>{release=resolve;}));
  const pending=loadMessages({view:'spam'});assert.deepEqual(list.value.items,[]);assert.equal(list.value.loading,true);
  release(result([]));await pending;
});
test('session teardown clears cached rows and ignores a late action result',async t=>{
  const { resetMailbox } = await import('../../web/src/state/list.js');
  let release;setup(t,()=>new Promise(resolve=>{release=resolve;}));
  const pending=runAction('flag',[rows[0].ref]);resetMailbox();assert.deepEqual(list.value.items,[]);assert.equal(acting.value,false);
  release(Response.json({done:1,failed:[]}));await pending;
  assert.deepEqual(list.value.items,[]);assert.equal(toast.value,null);
});

test('standard IMAP names use approved Korean labels while custom folder names are preserved',async()=>{
  const {folderLabel}=await import('../../web/src/format.js');
  assert.equal(folderLabel({path:'INBOX',name:'INBOX'}),'받은편지함');
  assert.equal(folderLabel({path:'Sent',name:'Sent'}),'보낸편지함');
  assert.equal(folderLabel({path:'고객사',name:'고객사'}),'고객사');
  assert.equal(folderLabel({path:'Archive',name:'보관 문서'}),'보관 문서');
});

test('shared folder labels identify owners and translate each relative path segment',async()=>{
  const {folderLabel}=await import('../../web/src/format.js');
  const shared=path=>({path:`Shared/support@example.com/${path}`,name:path.split('/').at(-1),shared:true,owner:'support@example.com'});
  assert.equal(folderLabel(shared('INBOX')),'support@example.com');
  assert.equal(folderLabel(shared('INBOX/처리 완료')),'support@example.com · 받은편지함 / 처리 완료');
  assert.equal(folderLabel(shared('Sent')),'support@example.com · 보낸편지함');
  assert.equal(folderLabel(shared('Archive/Trash/Drafts/Junk')),'support@example.com · 보관함 / 휴지통 / 임시보관함 / 스팸');
  assert.equal(folderLabel({path:'Shared',name:'Shared',shared:true}),'Shared');
  assert.equal(folderLabel({path:'Shared/INBOX',name:'INBOX',shared:true}),'INBOX');
});

test('SEARCH_SLOW stays in the list and retry preserves the same search parameters', async t => {
  const paths = [];
  setup(t, async path => {
    paths.push(path);
    return paths.length === 1 ? Response.json({ error: { code: 'SEARCH_SLOW', message: '메일함 검색 색인을 만드는 중이에요. 잠시 뒤 다시 검색해 주세요.' } }, { status: 503 }) : result(rows);
  });
  await loadMessages({ view: 'allmail', q: '제목:견적' });
  assert.equal(list.value.error.code, 'SEARCH_SLOW');
  assert.equal(list.value.items.length, 0);
  await loadMessages();
  assert.equal(paths[0], paths[1]);
  assert.equal(list.value.error, null);
  assert.equal(list.value.items.length, 3);
});

test('permanent deletion in Trash and Junk requires confirmation and waits for success', async t=>{
  let release,body,calls=0;
  const gate=new Promise(resolve=>{release=resolve;});
  setup(t,async(path,options)=>{
    if(path==='/api/messages/actions'){calls++;body=JSON.parse(options.body);await gate;return Response.json({done:2,failed:[]});}
    return result([]);
  });
  for(const folder of ['Trash','Junk']){
    list.value={...list.value,items:structuredClone(rows),total:3};
    const refs=rows.slice(0,2).map(row=>row.ref),before=calls;
    const pending=deleteMessages(refs,folder);
    assert.equal(calls,before);assert.deepEqual(deleteConfirmation.value.refs,refs);
    settleDeleteConfirmation(true);await Promise.resolve();
    assert.deepEqual(body,{refs,action:'delete-forever'});assert.equal(list.value.items.length,3);
    release();await pending;assert.equal(list.value.items.length,0);
  }
});
test('cancel and session teardown dismiss permanent deletion without requests',async t=>{
  let calls=0;setup(t,async()=>{calls++;return result([]);});
  const cancelled=deleteMessages(['ref1'],'Trash');settleDeleteConfirmation();await cancelled;
  assert.equal(calls,0);assert.equal(deleteConfirmation.value,null);
  const expired=deleteMessages(['ref1'],'Junk');resetMailbox();await expired;
  assert.equal(calls,0);assert.equal(deleteConfirmation.value,null);
});
test('Inbox deletion remains trash and permanent-delete rejection retains messages with notification',async t=>{
  let body;setup(t,async(path,options)=>{
    body=JSON.parse(options.body);
    return Response.json({error:{code:'DELETE_NOT_ALLOWED',message:'영구 삭제는 휴지통이나 스팸함에서만 할 수 있어요.'}},{status:422});
  });
  await deleteMessages(['ref1'],'INBOX');assert.deepEqual(body,{refs:['ref1'],action:'trash'});assert.equal(deleteConfirmation.value,null);
  toast.value=null;const pending=deleteMessages(['ref1'],'Trash');settleDeleteConfirmation(true);await pending;
  assert.deepEqual(body,{refs:['ref1'],action:'delete-forever'});assert.equal(list.value.items.length,3);
  assert.equal(toast.value.message,'영구 삭제는 휴지통이나 스팸함에서만 할 수 있어요.');
});


test('automatic colors balance six, seven and eight folders without saving preferences', t => {
  const previousPrefs=prefs.value,previousFolders=folders.value;
  t.after(()=>{prefs.value=previousPrefs;folders.value=previousFolders;});
  prefs.value={...prefs.value,folderColors:{}};
  const rows=['거래처','하늘 프로젝트','인사·총무','세금계산서','뉴스레터','디자인 리뷰'].map(path=>({path,color:null}));
  folders.value={folders:rows};
  assert.deepEqual(rows.map(folderColor),[1,6,5,4,2,3]);
  assert.equal(new Set(rows.map(folderColor)).size,6);
  folders.value={folders:rows.slice().reverse()};
  assert.deepEqual(rows.map(folderColor),[1,6,5,4,2,3]);
  for (const count of [7,8]) {
    const added=[...rows,{path:'추가'},{path:'또 추가'}].slice(0,count);
    folders.value={folders:added};
    assert.equal(new Set(added.map(folderColor)).size,7);
    assert.equal(added.map(folderColor).filter(color=>color===1).length,count===8?2:1);
  }
  assert.deepEqual(prefs.value.folderColors,{});
});
test('automatic colors count chosen and server colors, exclude gray, special and shared folders',t=>{
  const previousPrefs=prefs.value,previousFolders=folders.value;
  t.after(()=>{prefs.value=previousPrefs;folders.value=previousFolders;});
  prefs.value={...prefs.value,folderColors:{A:1,B:0}};
  const rows=[{path:'A'},{path:'B'},{path:'C',color:2},{path:'D'},{path:'E'},
    {path:'INBOX',specialUse:'\\Inbox',color:3},{path:'Shared',shared:true,color:4}];
  folders.value={folders:rows};
  assert.deepEqual(rows.map(folderColor),[1,0,2,3,4,null,null]);
  folders.value={folders:[{path:'\u{10000}'},{path:'\uE000'}]};
  assert.deepEqual(folders.value.folders.map(folderColor),[2,1]);
});
test('successful create, delete and rename freeze all existing colors and migrate descendants',t=>{
  const previousPrefs=prefs.value,previousFolders=folders.value;
  t.after(()=>{prefs.value=previousPrefs;folders.value=previousFolders;});
  prefs.value={...prefs.value,folderColors:{}};
  let rows=['B','B/child','C','D','E','F'].map(path=>({path}));
  folders.value={folders:rows};
  const initial=Object.fromEntries(rows.map(folder=>[folder.path,folderColor(folder)]));
  prefs.value={...prefs.value,folderColors:folderColorsAfterChange({created:'A'})};
  rows=[...rows,{path:'A'}];folders.value={folders:rows};
  assert.equal(folderColor(rows.at(-1)),7);
  for(const folder of rows.slice(0,-1))assert.equal(folderColor(folder),initial[folder.path]);
  // Freeze unsaved remaining folders too, and remove stale descendant keys.
  prefs.value={...prefs.value,folderColors:{'A/stale':0}};
  const beforeDelete=Object.fromEntries(rows.map(folder=>[folder.path,folderColor(folder)]));
  prefs.value={...prefs.value,folderColors:folderColorsAfterChange({from:'A',deleted:true})};
  rows=rows.filter(folder=>folder.path!=='A');folders.value={folders:rows};
  assert.equal(prefs.value.folderColors.A,undefined);
  assert.equal(prefs.value.folderColors['A/stale'],undefined);
  for(const folder of rows)assert.equal(folderColor(folder),beforeDelete[folder.path]);
  prefs.value={...prefs.value,folderColors:{B:0,'B/stale':5}};
  const beforeRename=Object.fromEntries(rows.map(folder=>[folder.path,folderColor(folder)]));
  prefs.value={...prefs.value,folderColors:folderColorsAfterChange({from:'B',to:'Z'})};
  rows=rows.map(folder=>({...folder,path:folder.path.replace(/^B(?=\/|$)/,'Z')}));folders.value={folders:rows};
  for(const [path,color] of Object.entries(beforeRename))assert.equal(folderColor(rows.find(folder=>folder.path===path.replace(/^B(?=\/|$)/,'Z'))),color);
  assert.equal(prefs.value.folderColors['Z/stale'],5);
  assert.ok(!Object.keys(prefs.value.folderColors).some(path=>path==='B'||path.startsWith('B/')));
});
test('folder color gives preferences including gray priority over server color and automatic color',t=>{
  const previous=prefs.value;t.after(()=>{prefs.value=previous;});
  prefs.value={...prefs.value,folderColors:{Projects:0}};
  assert.equal(folderColor({path:'Projects',color:3}),0);
  prefs.value={...prefs.value,folderColors:{}};
  assert.equal(folderColor({path:'Projects',color:3}),3);
  assert.equal(folderColor({path:'Projects',color:0}),0);
  assert.equal(folderColor({path:'Projects',color:null}),folderColor({path:'Projects'}));
  assert.equal(folderColor({path:'INBOX',specialUse:'\\Inbox'}),null);
  assert.equal(folderColor({path:'Shared/team@example.com',shared:true}),null);
  assert.equal(folderColor(undefined),null);
});

const scope=selectionScope(params);
function deferred() {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function prepared({selectionId='synthetic-scope',phase='ready',cursor='execute-0',initialTotal=6}={}) {
  return Response.json({selectionId,phase,cursor,totalEstimate:6,initialTotal:phase==='ready'?initialTotal:null,
    expiresAt:'2099-01-01T00:00:00Z',...(phase==='ready'?{cutoff:{kind:'uid-fences',capturedAt:'2026-10-20T00:00:00Z'}}:{})});
}
function batch({selectionId='synthetic-scope',sequence=0,processed=2,skipped=0,failed=[],completed=false,nextCursor='execute-1',initialTotal=6,delta}={}) {
  const totals={processed,skipped,failed:failed.length};
  return {selectionId,batchId:`${selectionId}:${sequence}`,sequence,state:completed?'completed':'running',reason:completed?'complete':'batch',
    initialTotal,delta:delta??totals,totals,failed,nextCursor:completed?null:nextCursor,remainingEstimate:initialTotal-processed-skipped-failed.length,elapsedMs:10};
}
function chooseScope(action='archive',target) {selectAllMatching(list.value.params,1848);runSelectedAction(action,target);}
function mailboxStream(t) {
  const previous=globalThis.EventSource;let stream;
  globalThis.EventSource=class{listeners={};constructor(){stream=this;}addEventListener(name,handler){this.listeners[name]=handler;}close(){}emit(name,value){this.listeners[name]({data:JSON.stringify(value)});}};
  const close=connectMailboxEvents();t.after(()=>{close();globalThis.EventSource=previous;});return stream;
}
test('page selection is an explicit Set; unchecking all demotes to the current page minus one row',async t=>{
  setup(t,async()=>result(rows));selectPage(rows);assert.equal(selectionMode.value,'page');assert.deepEqual([...selection.value],rows.map(row=>row.ref));
  selectAllMatching(params,1848);assert.equal(selectionMode.value,'all');assert.equal(selection.value.size,0);
  assert.equal(scopeSelection.value.selectionId,null);assert.equal(scopeSelection.value.initialTotal,null);assert.ok(rows.every(row=>isSelected(row.ref)));
  toggleSelection('ref2');assert.equal(selectionMode.value,'page');assert.equal(scopeSelection.value,null);assert.deepEqual([...selection.value],['ref1','ref3']);
  selectAllMatching(params,1848);clearSelection();assert.equal(selectionMode.value,'none');assert.equal(selection.value.size,0);
});
test('all survives page and page-size changes with the same estimate and new-page selection',async t=>{
  const second=rows.map(row=>({...row,ref:`next-${row.ref}`}));setup(t,async()=>result(second));selectAllMatching(params,1848);const original=scopeSelection.value;
  await loadMessages({page:2,pageSize:100});assert.equal(scopeSelection.value,original);assert.equal(scopeSelection.value.totalEstimate,1848);
  assert.ok(second.every(row=>isSelected(row.ref)));assert.equal(isSelected('ref1'),false);toggleSelection(second[1].ref);assert.deepEqual([...selection.value],[second[0].ref,second[2].ref]);
});
test('page selection clears on page navigation and never promotes to all',async t=>{
  setup(t,async()=>result(rows));selectPage(rows);await loadMessages({page:2});assert.equal(selectionMode.value,'none');assert.equal(scopeSelection.value,null);
});
for(const patch of [{view:'allmail'},{folder:'합성 폴더'},{quick:'unread'},{q:'from:synthetic@example.com'},{in:'합성 폴더'}]) {
  test(`all clears on scope change ${JSON.stringify(patch)}`,async t=>{
    setup(t,async()=>result(rows));selectAllMatching(params,1848);await loadMessages(patch);assert.equal(scopeSelection.value,null);assert.equal(selectionMode.value,'none');
  });
}
for(const action of ['seen','unseen','flag','unflag','move','archive','trash','spam','notspam','delete-forever']) {
  test(`${action}: no prepare before confirmation; confirm uses exact scope and server denominator`,async t=>{
    const requests=[];setup(t,async(path,options)=>{
      requests.push({path,body:options.body?JSON.parse(options.body):null});
      if(path==='/api/messages/selections')return prepared();
      if(path==='/api/messages/actions/scope'){assert.equal(scopeSelection.value.initialTotal,6);assert.equal(scopeSelection.value.status,'running');return Response.json(batch({processed:6,completed:true}));}
      return result(rows);
    });
    const target=action==='move'?'합성 목적지':undefined;chooseScope(action,target);
    assert.equal(scopeSelection.value.status,'confirming');assert.equal(requests.length,0);assert.equal(scopeSelection.value.selectionId,null);assert.equal(scopeSelection.value.totalEstimate,1848);
    cancelScopedAction();assert.equal(scopeSelection.value.status,'all');assert.equal(requests.length,0);requestScopedAction(action,target);await confirmScopedAction();
    assert.equal(requests.length,3);assert.equal(requests[0].path,'/api/messages/selections');
    assert.deepEqual(requests[0].body,{scope,action,...(target?{target}:{}),selectionKey:requests[0].body.selectionKey,cursor:null});assert.match(requests[0].body.selectionKey,/^[A-Za-z0-9_-]+$/);
    assert.deepEqual(requests[1],{path:'/api/messages/actions/scope',body:{scope,action,...(target?{target}:{}),cursor:'execute-0'}});
    assert.ok(requests[2].path.startsWith('/api/messages?'));assert.equal(scopeSelection.value.status,'completed');assert.equal(scopeSelection.value.selected,false);
    assert.equal(scopeSelection.value.attempted,6);assert.equal(scopeSelection.value.totals.processed,6);assert.equal(selectionMode.value,'none');assert.equal(acting.value,false);
  });
}
test('stop during preparation waits for the response; resume uses its execution cursor without re-preparing',async t=>{
  const reached=deferred(),pending=deferred(),requests=[];
  setup(t,async(path,options)=>{
    requests.push({path,body:options.body?JSON.parse(options.body):null});
    if(path==='/api/messages/selections'){reached.resolve();return pending.promise;}
    if(path==='/api/messages/actions/scope')return Response.json(batch({processed:6,completed:true}));return result(rows);
  });
  chooseScope();const run=confirmScopedAction();await reached.promise;assert.equal(scopeSelection.value.status,'preparing');stopScopedAction();assert.equal(scopeSelection.value.status,'stopping');
  toggleSelection('ref1');selectPage(rows);clearSelection();assert.equal(scopeSelection.value.status,'stopping');pending.resolve(prepared());await run;
  assert.equal(scopeSelection.value.status,'stopped');assert.equal(requests.length,1);assert.equal(scopeSelection.value.cursor,'execute-0');
  await resumeScopedAction();assert.equal(requests.filter(row=>row.path==='/api/messages/selections').length,1);assert.equal(requests[1].body.cursor,'execute-0');assert.equal(scopeSelection.value.status,'completed');
});
test('preparation follows server cursors with one selectionKey before executing',async t=>{
  const requests=[];setup(t,async(path,options)=>{
    const body=options.body?JSON.parse(options.body):null;requests.push({path,body});
    if(path==='/api/messages/selections')return body.cursor===null?prepared({phase:'preparing',cursor:'prepare-1'}):prepared();
    if(path==='/api/messages/actions/scope')return Response.json(batch({processed:6,completed:true}));return result(rows);
  });
  chooseScope();await confirmScopedAction();assert.equal(requests[0].body.cursor,null);assert.equal(requests[1].body.cursor,'prepare-1');assert.equal(requests[0].body.selectionKey,requests[1].body.selectionKey);assert.equal(requests[2].body.cursor,'execute-0');
});
test('stop applies the current receipt and sends no next batch; explicit resume uses nextCursor',async t=>{
  const reached=deferred(),pending=deferred(),cursors=[];setup(t,async(path,options)=>{
    if(path==='/api/messages/selections')return prepared();
    if(path==='/api/messages/actions/scope'){const body=JSON.parse(options.body);cursors.push(body.cursor);if(body.cursor==='execute-0'){reached.resolve();return pending.promise;}return Response.json(batch({sequence:1,processed:5,skipped:1,completed:true}));}
    return result(rows);
  });
  chooseScope();const run=confirmScopedAction();await reached.promise;stopScopedAction();assert.equal(scopedRequestPending.value,true);assert.equal(acting.value,true);
  pending.resolve(Response.json(batch()));await run;assert.equal(scopeSelection.value.status,'stopped');assert.deepEqual(cursors,['execute-0']);assert.equal(scopeSelection.value.attempted,2);assert.equal(scopeSelection.value.remainingEstimate,4);assert.equal(acting.value,false);
  await resumeScopedAction();assert.deepEqual(cursors,['execute-0','execute-1']);assert.equal(scopeSelection.value.attempted,6);assert.equal(scopeSelection.value.totals.processed,5);assert.equal(scopeSelection.value.totals.skipped,1);
});
test('lost execution response repeats the same cursor, assigns totals and stops after recovery',async t=>{
  const cursors=[];let lost=true;setup(t,async(path,options)=>{
    if(path==='/api/messages/selections')return prepared();
    if(path==='/api/messages/actions/scope'){
      const {cursor}=JSON.parse(options.body);cursors.push(cursor);if(cursor==='execute-0')return Response.json(batch());
      if(cursor==='execute-1'){if(lost){lost=false;throw new TypeError('synthetic lost response');}return Response.json(batch({sequence:1,processed:4,skipped:1,nextCursor:'execute-2'}));}
      return Response.json(batch({sequence:2,processed:5,skipped:1,completed:true}));
    }return result(rows);
  });
  chooseScope();await confirmScopedAction();assert.equal(scopeSelection.value.responseLost,true);assert.equal(scopeSelection.value.cursor,'execute-1');assert.equal(scopeSelection.value.lastSentCursor,'execute-1');assert.equal(scopeSelection.value.attempted,2);
  await resumeScopedAction();assert.deepEqual(cursors,['execute-0','execute-1','execute-1']);assert.equal(scopeSelection.value.status,'stopped');assert.equal(scopeSelection.value.attempted,5);assert.equal(scopeSelection.value.totals.processed,4);assert.equal(scopeSelection.value.responseLost,false);
  await resumeScopedAction();assert.deepEqual(cursors,['execute-0','execute-1','execute-1','execute-2']);assert.equal(scopeSelection.value.attempted,6);
});
test('lost preparation response preserves selectionKey and cursor and recovery does not silently start changes',async t=>{
  const bodies=[];let lost=true,execute=0;setup(t,async(path,options)=>{
    if(path==='/api/messages/selections'){bodies.push(JSON.parse(options.body));if(lost){lost=false;throw new TypeError('synthetic lost preparation');}return prepared();}
    if(path==='/api/messages/actions/scope'){execute++;return Response.json(batch({processed:6,completed:true}));}return result(rows);
  });
  chooseScope();await confirmScopedAction();assert.equal(scopeSelection.value.selectionId,null);await resumeScopedAction();assert.deepEqual(bodies[0],bodies[1]);assert.equal(execute,0);assert.equal(scopeSelection.value.status,'stopped');await resumeScopedAction();assert.equal(execute,1);
});
test('condition change ignores old generation and sends no subsequent scope request',async t=>{
  const reached=deferred(),pending=deferred();let executions=0;setup(t,async path=>{
    if(path==='/api/messages/selections')return prepared();if(path==='/api/messages/actions/scope'){executions++;reached.resolve();return pending.promise;}return result([rows[2]]);
  });
  chooseScope();const run=confirmScopedAction();await reached.promise;await loadMessages({quick:'unread'});assert.equal(scopeSelection.value,null);assert.equal(acting.value,false);
  pending.resolve(Response.json(batch()));await run;assert.equal(executions,1);assert.equal(scopeSelection.value,null);assert.equal(list.value.params.quick,'unread');assert.deepEqual(list.value.items,[rows[2]]);assert.equal(scopedRequestPending.value,false);
});
test('entering reader stops automatic work with a mounted list and recovers late receipts explicitly',async t=>{
  const reached=deferred(),pending=deferred(),cursors=[];let first=true;setup(t,async(path,options)=>{
    if(path==='/api/messages/selections')return prepared();
    if(path==='/api/messages/actions/scope'){cursors.push(JSON.parse(options.body).cursor);if(first){first=false;reached.resolve();return pending.promise;}return Response.json(batch());}return result(rows);
  });
  chooseScope();const run=confirmScopedAction();await reached.promise;route.value=parseRoute('#read/ref1');assert.equal(scopeSelection.value.status,'stopped');pending.resolve(Response.json(batch()));await run;assert.equal(scopeSelection.value.attempted,0);
  route.value=parseRoute('#inbox');assert.equal(cursors.length,1);await resumeScopedAction();assert.deepEqual(cursors,['execute-0','execute-0']);assert.equal(scopeSelection.value.attempted,2);assert.equal(scopeSelection.value.status,'stopped');
});
test('session teardown ignores late scoped receipts without resurrecting rows or selection',async t=>{
  const reached=deferred(),pending=deferred();let calls=0;setup(t,async path=>{if(path==='/api/messages/selections')return prepared();calls++;reached.resolve();return pending.promise;});
  chooseScope();const run=confirmScopedAction();await reached.promise;session.value=null;assert.equal(scopeSelection.value,null);assert.deepEqual(list.value.items,[]);
  pending.resolve(Response.json(batch()));await run;assert.equal(calls,1);assert.equal(scopeSelection.value,null);assert.equal(acting.value,false);
});
test('zero-progress budget receipt stops rather than spinning and is explicitly resumable',async t=>{
  let executions=0;setup(t,async path=>{if(path==='/api/messages/selections')return prepared();if(path==='/api/messages/actions/scope'){executions++;return Response.json(executions===1?{...batch({processed:0}),reason:'budget'}:batch({processed:6,sequence:1,completed:true}));}return result(rows);});
  chooseScope();await confirmScopedAction();assert.equal(executions,1);assert.equal(scopeSelection.value.status,'stopped');assert.equal(canResumeScopedAction(),true);await resumeScopedAction();assert.equal(executions,2);assert.equal(scopeSelection.value.status,'completed');
});
test('zero candidates still obtain the server completion receipt',async t=>{
  let executions=0;setup(t,async path=>{if(path==='/api/messages/selections')return prepared({initialTotal:0});if(path==='/api/messages/actions/scope'){executions++;return Response.json(batch({processed:0,initialTotal:0,completed:true}));}return result([]);});
  chooseScope();await confirmScopedAction();assert.equal(executions,1);assert.equal(scopeSelection.value.initialTotal,0);assert.equal(scopeSelection.value.attempted,0);assert.equal(scopeSelection.value.status,'completed');
});
test('SSE before confirmation refreshes selected rows without fixing candidates or changing the estimate',async t=>{
  const newcomer={...rows[0],ref:'new-ref'};let calls=0;setup(t,async()=>{calls++;return result([...rows,newcomer]);});const stream=mailboxStream(t);
  chooseScope();stream.emit('mailbox',{path:'INBOX',unseen:4,total:4});for(let i=0;i<20&&list.value.loading;i++)await Promise.resolve();
  assert.equal(calls,1);assert.equal(scopeSelection.value.selectionId,null);assert.equal(scopeSelection.value.totalEstimate,1848);assert.equal(isSelected(newcomer.ref),true);
});
test('SSE defers reload while preparing, running and stopped but updates badges; return reloads once',async t=>{
  const prepareReached=deferred(),preparePending=deferred(),executeReached=deferred(),executePending=deferred();let listCalls=0;
  setup(t,async path=>{if(path==='/api/messages/selections'){prepareReached.resolve();return preparePending.promise;}if(path==='/api/messages/actions/scope'){executeReached.resolve();return executePending.promise;}listCalls++;return result(rows);});
  folders.value={folders:[{path:'INBOX',unseen:1,total:3}]};const stream=mailboxStream(t);chooseScope();const run=confirmScopedAction();await prepareReached.promise;
  stream.emit('mailbox',{path:'INBOX',unseen:8,total:9});assert.equal(listCalls,0);assert.equal(folders.value.folders[0].unseen,8);preparePending.resolve(prepared());await executeReached.promise;
  stream.emit('mailbox',{path:'INBOX',unseen:9,total:10});assert.equal(listCalls,0);await loadMessages({page:2});assert.equal(list.value.params.page,1);toggleSelection('ref1');assert.equal(scopeSelection.value.selected,true);
  stopScopedAction();executePending.resolve(Response.json(batch()));await run;stream.emit('mailbox',{path:'INBOX',unseen:10,total:11});assert.equal(listCalls,0);assert.equal(scopeSelection.value.initialTotal,6);
  await returnToMailbox();assert.equal(listCalls,1);assert.equal(scopeSelection.value,null);assert.equal(selectionMode.value,'none');
});
test('explicit refresh clears a stopped selection and reloads the ordinary list',async t=>{
  const reached=deferred(),pending=deferred();let reloads=0;setup(t,async path=>{if(path==='/api/messages/selections')return prepared();if(path==='/api/messages/actions/scope'){reached.resolve();return pending.promise;}reloads++;return result(rows);});
  chooseScope();const run=confirmScopedAction();await reached.promise;stopScopedAction();pending.resolve(Response.json(batch()));await run;await loadMessages();assert.equal(reloads,1);assert.equal(scopeSelection.value,null);
});
test('fatal error.detail preserves partial results, prevents stale resume and keeps SSE deferred',async t=>{
  const failed=[{ref:'unknown-ref',code:'ACTION_OUTCOME_UNKNOWN',retryable:false}];let reloads=0;
  const detail={...batch({processed:3,skipped:1,failed}),state:'stopped',reason:'stale_scope',nextCursor:null,error:{code:'STALE_SCOPE'}};
  setup(t,async path=>{if(path==='/api/messages/selections')return prepared();if(path==='/api/messages/actions/scope')return Response.json({error:{code:'STALE_SCOPE',message:'합성 원본 변경',detail}},{status:409});reloads++;return result(rows);});
  const stream=mailboxStream(t);chooseScope();await confirmScopedAction();assert.equal(scopeSelection.value.status,'error');assert.deepEqual(scopeSelection.value.totals,{processed:3,skipped:1,failed:1});assert.equal(scopeSelection.value.attempted,5);assert.equal(scopeSelection.value.unknownFailed,1);assert.equal(scopeSelection.value.retryableFailed,0);
  assert.equal(canResumeScopedAction(),false);await resumeScopedAction();retryFailedScopedAction();assert.equal(scopeSelection.value.status,'error');stream.emit('mailbox',{path:'INBOX',unseen:10,total:11});assert.equal(reloads,0);await returnToMailbox();assert.equal(reloads,1);assert.equal(scopeSelection.value,null);
});
test('expired selections never resubmit their expired cursor',async t=>{
  let executions=0;setup(t,async path=>{if(path==='/api/messages/selections')return prepared();executions++;return Response.json({error:{code:'SCOPE_EXPIRED',message:'합성 만료'}},{status:409});});
  chooseScope();await confirmScopedAction();assert.equal(scopeSelection.value.status,'error');assert.equal(canResumeScopedAction(),false);await resumeScopedAction();assert.equal(executions,1);
});
test('failures use server-only pages including unavailable refs; retry prepares the previous failure record',async t=>{
  const failures=[{ref:'ref-outside-page',code:'MAIL_UNAVAILABLE',retryable:true},{ref:'unknown-ref',code:'ACTION_OUTCOME_UNKNOWN',retryable:false}],requests=[];let prepareCount=0;
  setup(t,async(path,options)=>{
    const body=options.body?JSON.parse(options.body):null;requests.push({path,body});
    if(path==='/api/messages/selections'){prepareCount++;return prepared({selectionId:prepareCount===1?'synthetic-scope':'synthetic-retry',initialTotal:prepareCount===1?6:1});}
    if(path==='/api/messages/actions/scope')return Response.json(prepareCount===1?batch({processed:3,skipped:1,failed:failures,completed:true}):batch({selectionId:'synthetic-retry',processed:1,initialTotal:1,completed:true}));
    if(path.startsWith('/api/messages/selections/'))return Response.json({total:2,page:path.includes('page=2')?2:1,pageSize:1,items:[{...failures[path.includes('page=2')?1:0],unavailable:true}]});return result(rows);
  });
  chooseScope('seen');await confirmScopedAction();assert.equal(list.value.resultView,'failed');assert.equal(scopeSelection.value.failureView,true);assert.equal(scopeSelection.value.selected,false);assert.equal(list.value.items[0].ref,'ref-outside-page');assert.equal(list.value.items[0].unavailable,true);
  assert.equal(scopeSelection.value.attempted,6);assert.equal(scopeSelection.value.totals.processed,3);assert.equal(scopeSelection.value.retryableFailed,1);
  selectPage(list.value.items);assert.deepEqual([...selection.value],['ref-outside-page']);assert.equal(scopeSelection.value.status,'completed');clearSelection();assert.equal(scopeSelection.value.failureView,true);
  await loadFailureMessages(2,1);assert.equal(list.value.items[0].ref,'unknown-ref');assert.equal(scopeSelection.value.failurePage.page,2);
  const before=requests.length;retryFailedScopedAction();assert.equal(requests.length,before);assert.equal(scopeSelection.value.status,'confirming');cancelScopedAction();assert.equal(scopeSelection.value.status,'completed');assert.equal(scopeSelection.value.failureView,true);
  retryFailedScopedAction();await confirmScopedAction();const retries=requests.filter(row=>row.path==='/api/messages/selections');assert.notEqual(retries[0].body.selectionKey,retries[1].body.selectionKey);
  assert.deepEqual(retries[1].body,{scope,action:'seen',selectionKey:retries[1].body.selectionKey,cursor:null,selectionId:'synthetic-scope',retry:'failed'});
  assert.equal(scopeSelection.value.initialTotal,1);assert.equal(scopeSelection.value.totals.processed,1);assert.equal(scopeSelection.value.attempted,1);assert.equal(scopeSelection.value.failureView,false);assert.equal(list.value.resultView,'mailbox');
});
test('explicit refs actions stay on the legacy endpoint while all is displayed',async t=>{
  const requests=[];setup(t,async(path,options)=>{requests.push({path,body:options.body?JSON.parse(options.body):null});if(path==='/api/messages/actions')return Response.json({done:1,failed:[]});return result(rows);});
  selectAllMatching(params,1848);await runAction('flag',['ref2']);assert.deepEqual(requests[0],{path:'/api/messages/actions',body:{refs:['ref2'],action:'flag'}});assert.equal(requests.some(row=>row.path==='/api/messages/selections'||row.path==='/api/messages/actions/scope'),false);assert.equal(scopeSelection.value.status,'all');assert.equal(scopeSelection.value.selectionId,null);
});

test('shared action entry keeps page refs exact, uses fallback only without selection and never prepares a scope',async t=>{
  const requests=[];setup(t,async(path,options)=>{
    if(options.body){requests.push({path,body:JSON.parse(options.body)});return Response.json({done:1,failed:[]});}
    return result(rows);
  });
  selectPage([rows[1]]);await runSelectedAction('move','합성 목적지',['ref1']);
  assert.deepEqual(requests[0],{path:'/api/messages/actions',body:{refs:['ref2'],action:'move',target:'합성 목적지'}});
  clearSelection();await runSelectedAction('archive',undefined,['ref3']);
  assert.deepEqual(requests[1],{path:'/api/messages/actions',body:{refs:['ref3'],action:'archive'}});
});
test('shared delete entry confirms all without preparation and retains the legacy page confirmation',async t=>{
  const bodies=[];setup(t,async(path,options)=>{if(options.body){bodies.push(JSON.parse(options.body));return Response.json({done:1,failed:[]});}return result(rows);});
  list.value={...list.value,params:{...params,view:'folder',folder:'Trash'}};
  selectAllMatching(list.value.params,1848);deleteSelectedMessages();assert.equal(scopeSelection.value.status,'confirming');assert.equal(scopeSelection.value.action,'delete-forever');assert.equal(bodies.length,0);
  cancelScopedAction();clearSelection();selectPage([rows[1]]);const pending=deleteSelectedMessages(['ref1']);
  assert.deepEqual(deleteConfirmation.value.refs,['ref2']);assert.equal(bodies.length,0);settleDeleteConfirmation(true);await pending;
  assert.deepEqual(bodies,[{refs:['ref2'],action:'delete-forever'}]);
});
test('scope changes do not unlock an unrelated legacy refs request',async t=>{
  const reached=deferred(),pending=deferred();setup(t,async path=>{
    if(path==='/api/messages/actions'){reached.resolve();return pending.promise;}return result(rows);
  });
  const run=runAction('flag',['ref1']);await reached.promise;await loadMessages({quick:'unread'});assert.equal(acting.value,true);
  pending.resolve(Response.json({done:1,failed:[]}));await run;assert.equal(acting.value,false);
});
test('confirmation invalidates an already pending normal list response before candidates are prepared',async t=>{
  const listReached=deferred(),listPending=deferred(),prepareReached=deferred(),preparePending=deferred();
  setup(t,async path=>{
    if(path==='/api/messages/selections'){prepareReached.resolve();return preparePending.promise;}
    if(path==='/api/messages/actions/scope')return Response.json(batch({processed:6,completed:true}));
    listReached.resolve();return listPending.promise;
  });
  const loading=loadMessages();await listReached.promise;chooseScope();const run=confirmScopedAction();await prepareReached.promise;
  assert.equal(list.value.loading,false);listPending.resolve(result([{...rows[0],ref:'late-ref'}]));await loading;
  assert.deepEqual(list.value.items,rows);assert.equal(isSelected('late-ref'),false);
  stopScopedAction();preparePending.resolve(prepared());await run;assert.equal(scopeSelection.value.status,'stopped');
});

test('stopped failed-only retry uses a new record, preserves cumulative failures and does not execute remaining candidates',async t=>{
  const reached=deferred(),pending=deferred(),requests=[];
  const failure={ref:'failed-in-first-batch',code:'MAIL_UNAVAILABLE',retryable:true};let prepares=0;
  setup(t,async(path,options)=>{
    const body=options.body?JSON.parse(options.body):null;requests.push({path,body});
    if(path==='/api/messages/selections'){prepares++;return prepared({selectionId:prepares===1?'synthetic-scope':'synthetic-retry',initialTotal:prepares===1?6:1});}
    if(path==='/api/messages/actions/scope'){
      if(prepares===2)return Response.json(batch({selectionId:'synthetic-retry',processed:1,initialTotal:1,completed:true}));
      if(body.cursor==='execute-0')return Response.json(batch({processed:1,failed:[failure]}));
      reached.resolve();return pending.promise;
    }
    return result(rows);
  });
  chooseScope();const run=confirmScopedAction();await reached.promise;stopScopedAction();
  pending.resolve(Response.json({...batch({processed:3,sequence:1,nextCursor:'execute-2'}),totals:{processed:3,skipped:0,failed:1},delta:{processed:2,skipped:0,failed:0},remainingEstimate:2}));await run;
  assert.equal(scopeSelection.value.status,'stopped');assert.equal(scopeSelection.value.attempted,4);assert.equal(scopeSelection.value.remainingEstimate,2);
  assert.equal(scopeSelection.value.retryableFailed,1);assert.deepEqual(scopeSelection.value.failures,[failure]);
  retryFailedScopedAction();assert.equal(scopeSelection.value.confirmationTotal,1);cancelScopedAction();assert.equal(scopeSelection.value.status,'stopped');assert.equal(scopeSelection.value.selected,true);
  retryFailedScopedAction();await confirmScopedAction();
  const retries=requests.filter(item=>item.path==='/api/messages/selections');assert.equal(retries.length,2);assert.equal(retries[1].body.retry,'failed');assert.equal(retries[1].body.selectionId,'synthetic-scope');
  assert.equal(requests.some(item=>item.body?.cursor==='execute-2'),false);assert.equal(scopeSelection.value.selectionId,'synthetic-retry');assert.equal(scopeSelection.value.initialTotal,1);assert.equal(scopeSelection.value.attempted,1);assert.equal(canResumeScopedAction(),false);
});

test('opening stopped failure pages selects no rows and preserves the remaining cursor for explicit resume',async t=>{
  const reached=deferred(),pending=deferred();const failure={ref:'failed-ref',code:'MAIL_UNAVAILABLE',retryable:true};
  setup(t,async path=>{
    if(path==='/api/messages/selections')return prepared();
    if(path==='/api/messages/actions/scope'){reached.resolve();return pending.promise;}
    return Response.json({total:1,page:1,pageSize:50,items:[{...failure,unavailable:true}]});
  });
  chooseScope();const run=confirmScopedAction();await reached.promise;stopScopedAction();pending.resolve(Response.json(batch({processed:1,failed:[failure]})));await run;
  await loadFailureMessages();assert.equal(scopeSelection.value.status,'stopped');assert.equal(scopeSelection.value.cursor,'execute-1');assert.equal(scopeSelection.value.selected,false);assert.equal(selectionMode.value,'none');assert.equal(isSelected('failed-ref'),false);assert.equal(canResumeScopedAction(),true);
});
