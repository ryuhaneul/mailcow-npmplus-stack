import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearch } from '../../web/src/search.js';
import { parseSearchQuery } from '../../server/mail/search-query.js';
import { parseRoute, route } from '../../web/src/router.js';
import { list, cursor, acting, loadMessages, cancelListLoad, runAction, connectMailboxEvents, deleteMessages, deleteConfirmation, settleDeleteConfirmation, resetMailbox } from '../../web/src/state/list.js';
import { selection } from '../../web/src/state/selection.js';
import { folders, folderColor, folderColorsAfterChange } from '../../web/src/state/folders.js';
import { storage } from '../../web/src/state/storage.js';
import { session, sessionReady } from '../../web/src/state/session.js';
import { toast } from '../../web/src/state/toast.js';
import { prefs, loadSessionPrefs } from '../../web/src/state/prefs.js';
const params={view:'inbox',folder:'',page:1,pageSize:50,quick:'all',q:'',in:''};
const rows=[1,2,3].map(index=>({ref:`ref${index}`,folder:'INBOX',folderName:'받은편지함',from:{name:'예시',address:'sender@example.com'},to:[],subject:`제목 ${index}`,date:`2026-10-${16-index}T00:00:00.000Z`,size:1024,seen:false,flagged:false,answered:false,hasAttachment:false}));
function setup(t,fetcher) {
  const old=globalThis.fetch;globalThis.fetch=fetcher;
  cancelListLoad();list.value={params:{...params},items:structuredClone(rows),total:3,loading:false,error:null};selection.value=new Set();cursor.value=rows[0].ref;acting.value=false;session.value={user:{email:'user@example.com'},csrf:'synthetic-csrf'};sessionReady.value=true;toast.value=null;
  t.after(()=>{cancelListLoad();globalThis.fetch=old;session.value=null;sessionReady.value=false;toast.value=null;});
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
  setup(t,async()=>result(rows));const previous=globalThis.EventSource;let stream;
  globalThis.EventSource=class{listeners={};closed=false;constructor(){stream=this;}addEventListener(name,handler){this.listeners[name]=handler;}close(){this.closed=true;}emit(name,value){this.listeners[name]({data:JSON.stringify(value)});}};
  t.after(()=>{globalThis.EventSource=previous;});route.value=parseRoute('#inbox');folders.value={folders:[{path:'INBOX',unseen:1,total:3}],virtualAllMail:'WebmailVirtual/AllMail'};
  const close=connectMailboxEvents();stream.emit('mailbox',{path:'INBOX',unseen:7,total:12});assert.equal(folders.value.folders[0].unseen,7);assert.equal(folders.value.folders[0].total,12);
  stream.emit('quota',{usedBytes:95,limitBytes:100});assert.deepEqual(storage.value.quota,{usedBytes:95,limitBytes:100});
  stream.emit('session',{state:'expired'});assert.equal(session.value,null);assert.equal(sessionReady.value,false);assert.equal(stream.closed,true);assert.equal(toast.value.kind,'session-expired');close();
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
