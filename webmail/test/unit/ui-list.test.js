import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearch } from '../../web/src/search.js';
import { parseSearchQuery } from '../../server/mail/search-query.js';
import { parseRoute, route } from '../../web/src/router.js';
import { list, cursor, acting, loadMessages, cancelListLoad, runAction, connectMailboxEvents } from '../../web/src/state/list.js';
import { selection } from '../../web/src/state/selection.js';
import { folders } from '../../web/src/state/folders.js';
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
