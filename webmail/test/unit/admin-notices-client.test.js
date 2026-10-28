import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { createNoticeEditor, createNoticesList, noticeFilters, noticeStateLabel, noticeTimestamp, sortNotices, validateNoticeDraft } from '../../web/src/admin/pages/notices.js';
import { adminRoute, initAdminRouter, registerAdminLeaveGuard } from '../../web/src/admin/router.js';
import { createAdminApi } from '../../web/src/admin/api.js';

const version='2026-10-28T05:00:00.123456Z';
const row=(overrides={})=>({id:7,title:'Synthetic notice',bodyHtml:'<p>hello</p>',category:'update',audienceAll:true,domains:[],pinned:false,state:'draft',publishedAt:null,updatedAt:version,...overrides});
const fields=()=>({title:'Synthetic notice',bodyHtml:'<p>hello</p>',category:'update',audienceAll:true,domains:[],pinned:false});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{resolve,reject,promise};};
const fail=(status=503,code='SYNTHETIC_FAILURE')=>Object.assign(new Error('합성 오류'),{status,code});
function editorFixture(t,handler,{existing=null}={}) {
  let account={id:'synthetic-owner'};
  const calls=[];
  const model=createNoticeEditor({row:existing,domains:['example.test','other.test'],getOwner:()=>account,request:async(path,options)=>{calls.push({path,...options});return handler(path,options,calls);}});
  t.after(()=>model.dispose());
  return {model,calls,replaceOwner(){account={id:'other-owner'};}};
}
function fill(model,overrides={}){for(const[key,value]of Object.entries({...fields(),...overrides}))model.update(key,value);}

test('admin notices filters, state labels, sort and timestamps follow approved contract',()=>{
  assert.deepEqual(noticeFilters,[['all','전체'],['published','게시 중'],['hidden','숨김'],['draft','임시']]);
  assert.equal(noticeStateLabel('draft'),'임시');assert.equal(noticeStateLabel('hidden'),'숨김');assert.equal(noticeStateLabel('published'),'게시 중');
  assert.match(noticeTimestamp(version),/\d{2}:\d{2}:\d{2}$/);assert.ok(!noticeTimestamp(version).includes('123456'));
  assert.equal(noticeTimestamp(null),'아직 게시하지 않음');
  const rows=[row({id:1,pinned:false,publishedAt:'2026-10-28T05:00:00Z'}),row({id:2,pinned:true,publishedAt:'2026-10-20T05:00:00Z'})];
  assert.deepEqual(sortNotices(rows).map(item=>item.id),[2,1]);assert.equal(rows[0].id,1);
});
test('admin notices validation: required title, 200 Unicode characters, body text, category and active domain selection',()=>{
  for(const[change,key]of [[{title:' '},'title'],[{title:'x'.repeat(201)},'title'],[{title:'\ud800'},'title'],[{bodyHtml:'<p><br></p>'},'bodyHtml'],[{bodyHtml:'<p>&nbsp;\u200b</p>'},'bodyHtml'],[{bodyHtml:'<script>bad()</script>'},'bodyHtml'],[{category:'invalid'},'category'],[{audienceAll:false,domains:[]},'domains'],[{audienceAll:false,domains:['inactive.test']},'domains']]) {
    assert.ok(validateNoticeDraft({...fields(),...change},{domains:['example.test']})[key]);
  }
  assert.deepEqual(validateNoticeDraft({...fields(),title:'😀'.repeat(200)}),{});
  assert.ok(validateNoticeDraft(fields(),{empty:true}).bodyHtml);
  assert.deepEqual(validateNoticeDraft({...fields(),audienceAll:false,domains:['example.test']},{domains:['example.test']}),{});
});
test('admin notices new editor saves only server-sanitized HTML, exact payload and POST; adoption clears dirty',async t=>{
  const f=editorFixture(t,(path,options)=>path.endsWith('/preview')?{bodyHtml:'<p>clean</p>',empty:false}:row({...options.body,id:11,state:'draft'}));
  assert.equal(f.model.dirty(),false);fill(f.model,{title:'  A\u0000B  ',bodyHtml:'<p class="raw">hello</p>',domains:['other.test']});assert.equal(f.model.dirty(),true);
  const saved=await f.model.save(false);assert.equal(saved.id,11);
  assert.deepEqual(f.calls.map(call=>[call.path,call.method]),[['/api/admin/notices/preview','POST'],['/api/admin/notices','POST']]);
  assert.deepEqual(f.calls[0].body,{bodyHtml:'<p class="raw">hello</p>'});
  assert.deepEqual(f.calls[1].body,{title:'AB',bodyHtml:'<p>clean</p>',category:'update',audienceAll:true,domains:[],pinned:false,publish:false});
  assert.equal(f.model.dirty(),false);assert.equal(f.model.state.value.draft.bodyHtml,'<p>clean</p>');assert.equal(f.model.state.value.message,'임시 저장했어요.');
});
test('admin notices preview uses server output only, writing retains original input and does not mark saved',async t=>{
  const f=editorFixture(t,()=>({bodyHtml:'<p>preview clean</p>',empty:false}));fill(f.model,{bodyHtml:'<p onclick="bad()">raw</p>'});
  await f.model.preview();assert.equal(f.model.state.value.tab,'preview');assert.deepEqual(f.model.state.value.preview,{bodyHtml:'<p>preview clean</p>',empty:false});
  assert.equal(f.model.state.value.draft.bodyHtml,'<p onclick="bad()">raw</p>');assert.equal(f.model.dirty(),true);
  f.model.write();assert.equal(f.model.state.value.tab,'write');assert.equal(f.calls.length,1);
});
test('admin notices edit PUT preserves all microseconds, first publication time and strict editable field whitelist',async t=>{
  const first='2026-10-20T05:00:00Z', next='2026-10-28T05:00:00.123457Z';
  const f=editorFixture(t,(path,options)=>path.endsWith('/preview')?{bodyHtml:'<p>clean</p>',empty:false}:row({...options.body,state:'published',publishedAt:first,updatedAt:next}),{existing:row({state:'published',publishedAt:first})});
  f.model.update('title','changed');await f.model.save(false);
  assert.equal(f.calls[1].method,'PUT');assert.equal(f.calls[1].path,'/api/admin/notices/7');assert.equal(f.calls[1].body.updatedAt,version);
  assert.deepEqual(Object.keys(f.calls[1].body).sort(),['audienceAll','bodyHtml','category','domains','pinned','publish','title','updatedAt']);
  assert.equal(f.model.state.value.meta.publishedAt,first);assert.equal(f.model.state.value.meta.updatedAt,next);assert.equal(f.model.state.value.message,'저장했어요.');
});
test('admin notices publish/re-publish uses one sanitized save and retains hidden notice publication metadata',async t=>{
  const first='2026-10-20T05:00:00Z';
  const f=editorFixture(t,(path,options)=>path.endsWith('/preview')?{bodyHtml:'<p>clean</p>',empty:false}:row({...options.body,state:'published',publishedAt:first}),{existing:row({state:'hidden',publishedAt:first})});
  f.model.update('title','new title');await f.model.save(true);
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.publish,true);assert.equal(f.model.state.value.meta.publishedAt,first);assert.equal(f.model.state.value.message,'게시했어요.');
});
test('admin notices client validation and empty server-sanitized body block all database writes',async t=>{
  const f=editorFixture(t,()=>({bodyHtml:'',empty:true}));await f.model.save();assert.equal(f.calls.length,0);assert.ok(f.model.state.value.errors.title);
  fill(f.model);await f.model.save();assert.equal(f.calls.length,1);assert.ok(f.model.state.value.errors.bodyHtml);assert.equal(f.model.state.value.busy,false);assert.equal(f.model.dirty(),true);
});
test('admin notices busy locks duplicate save, input, preview and delete; errors retain draft and version',async t=>{
  const pending=deferred();const f=editorFixture(t,()=>pending.promise,{existing:row()});f.model.update('title','unsaved');
  const request=f.model.save();assert.equal(f.model.state.value.busy,true);f.model.update('title','blocked');await f.model.save();await f.model.preview();await f.model.remove();
  assert.equal(f.calls.length,1);assert.equal(f.model.state.value.draft.title,'unsaved');pending.reject(fail(409,'CONFLICT'));await request;
  assert.equal(f.model.state.value.busy,false);assert.equal(f.model.state.value.error.code,'CONFLICT');assert.equal(f.model.state.value.meta.updatedAt,version);assert.equal(f.model.dirty(),true);
});
test('admin notices hide preserves unsaved fields and uses returned version for later delete',async t=>{
  const next='2026-10-28T05:00:00.999999Z';
  const f=editorFixture(t,path=>path.endsWith('/hide')?row({state:'hidden',updatedAt:next}):{ok:true},{existing:row({state:'published'})});
  f.model.update('title','unsaved');await f.model.hide();assert.equal(f.model.state.value.meta.state,'hidden');assert.equal(f.model.state.value.draft.title,'unsaved');assert.equal(f.model.dirty(),true);
  assert.deepEqual(f.calls[0].body,{updatedAt:version});await f.model.remove();assert.deepEqual(f.calls[1].body,{updatedAt:next});assert.equal(f.calls[1].method,'DELETE');assert.equal(f.model.dirty(),false);
});
test('admin notices account replacement or disposal drops stale save/preview responses',async t=>{
  const pending=deferred();const f=editorFixture(t,()=>pending.promise);fill(f.model);const request=f.model.save();f.replaceOwner();pending.resolve({bodyHtml:'<p>clean</p>',empty:false});await request;
  assert.equal(f.calls.length,1);assert.equal(f.model.state.value.meta.id,null);
  const second=deferred();const g=editorFixture(t,()=>second.promise);fill(g.model);const preview=g.model.preview();g.model.dispose();second.resolve({bodyHtml:'old owner',empty:false});await preview;assert.equal(g.model.state.value.preview,null);
});
test('admin notices list filters use exact API state; state actions use microsecond version and update filter membership',async()=>{
  const calls=[];const model=createNoticesList({request:async(path,options)=>{calls.push({path,...options});return options?row({state:'hidden',pinned:true}):{enabled:true,items:[row({state:'published'})]};}});
  await model.load('published');assert.equal(calls[0].path,'/api/admin/notices?state=published');await model.change(model.state.value.items[0],'hide');assert.deepEqual(calls[1].body,{updatedAt:version});assert.equal(calls[1].path,'/api/admin/notices/7/hide');assert.equal(model.state.value.items.length,0);assert.equal(model.state.value.message,'숨겼어요.');model.dispose();
});
test('admin notices list feature-off, empty results, errors and out-of-order filters preserve correct state',async()=>{
  const first=deferred();let count=0;const model=createNoticesList({request:async()=>++count===1?first.promise:{enabled:false,items:[]}});
  const older=model.load('all');await model.load('draft');first.resolve({enabled:true,items:[row()]});await older;
  assert.equal(model.state.value.filter,'draft');assert.equal(model.state.value.enabled,false);assert.deepEqual(model.state.value.items,[]);model.dispose();
  const errors=createNoticesList({request:async()=>{throw fail();}});await errors.load();assert.equal(errors.state.value.loading,false);assert.equal(errors.state.value.error.status,503);errors.dispose();
});
test('admin notices API requests retain cookie credentials, custom CSRF and no Authorization',async t=>{
  const calls=[];
  const request=createAdminApi({getCsrf:()=> 'synthetic-csrf',fetchImpl:async(path,options)=>{calls.push({path,...options});return Response.json(path.endsWith('/preview')?{bodyHtml:'<p>clean</p>',empty:false}:row());}});
  const model=createNoticeEditor({request});t.after(()=>model.dispose());fill(model);await model.save();
  for(const call of calls){assert.equal(call.credentials,'same-origin');assert.equal(call.headers['X-Mailadmin-CSRF'],'synthetic-csrf');assert.equal(call.headers.Authorization,undefined);assert.equal(call.headers['Content-Type'],'application/json');}
});

function fakeRouting(t) {
  const keys=['location','history','addEventListener','removeEventListener'],previous=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
  const events=new EventTarget(),location={hash:'#accounts/person%40example.test'},replacements=[];
  globalThis.location=location;globalThis.history={state:null,replaceState(_state,_title,hash){replacements.push(hash);location.hash=hash;}};
  globalThis.addEventListener=events.addEventListener.bind(events);globalThis.removeEventListener=events.removeEventListener.bind(events);
  const stop=initAdminRouter();t.after(()=>{stop();for(const key of keys){if(previous[key]===undefined)delete globalThis[key];else globalThis[key]=previous[key];}});
  return {location,replacements,go(hash){location.hash=hash;events.dispatchEvent(new Event('hashchange'));}};
}
test('admin router without leave guard preserves prior initial, known, invalid and decoded hash routing',t=>{
  const f=fakeRouting(t);assert.deepEqual(adminRoute.value,{name:'accounts',parts:['person@example.test']});
  f.go('#domains');assert.equal(adminRoute.value.name,'domains');f.go('#missing');assert.equal(adminRoute.value.name,'home');f.go('#history/record%20one');assert.deepEqual(adminRoute.value,{name:'history',parts:['record one']});assert.deepEqual(f.replacements,[]);
});
test('admin notice leave guard rejects hash/back navigation, releases after save/unmount and does not affect other pages',t=>{
  const f=fakeRouting(t);f.go('#notices/7');let dirty=true,questions=0;
  const release=registerAdminLeaveGuard(()=>{questions++;return !dirty;});t.after(release);
  f.go('#home');assert.deepEqual(adminRoute.value,{name:'notices',parts:['7']});assert.equal(f.location.hash,'#notices/7');assert.equal(questions,1);
  dirty=false;release();f.go('#settings');assert.equal(adminRoute.value.name,'settings');assert.equal(questions,1);
  f.go('#notices/new');const unmount=registerAdminLeaveGuard(()=>false);unmount();f.go('#logs');assert.equal(adminRoute.value.name,'logs');
});
test('shared FormatBar default retains all eleven composer commands, source toggle and original commands; notices selects six',()=>{
  const source=readFileSync(new URL('../../web/src/components/FormatBar.jsx',import.meta.url),'utf8'),ast=parse(source,{sourceType:'module',plugins:['jsx']});
  const component=ast.program.body.find(node=>node.type==='ExportDefaultDeclaration').declaration;
  const commands=component.body.body.flatMap(node=>node.type==='VariableDeclaration'?node.declarations:[]).find(node=>node.id.name==='commands');
  assert.equal(commands.init.operator,'??');assert.equal(commands.init.left.name,'providedCommands');
  assert.deepEqual(commands.init.right.elements.map(row=>row.elements.map(value=>value.value)),[
    ['굵게','bold','bold'],['기울임','italic','italic'],['밑줄','under','underline'],['취소선','strike','strikeThrough'],['글자색','color','foreColor'],['글머리 목록','ul','insertUnorderedList'],['번호 목록','ol','insertOrderedList'],['인용','quote','formatBlock','blockquote'],['링크','link','createLink'],['그림 넣기','image','insertImage'],['서식 지우기','clear','removeFormat'],
  ]);
  assert.ok(source.includes('onClick={toggle}'));assert.ok(source.includes("editor.current?.format(command,value)"));assert.ok(source.includes("if(command==='foreColor')color.current.click()"));assert.ok(source.includes("['createLink','insertImage'].includes(command)"));
  const noticeSource=readFileSync(new URL('../../web/src/admin/pages/NoticeEditor.jsx',import.meta.url),'utf8'),noticeAst=parse(noticeSource,{sourceType:'module',plugins:['jsx']});
  const limited=noticeAst.program.body.flatMap(node=>node.type==='VariableDeclaration'?node.declarations:[]).find(node=>node.id.name==='commands').init.elements.map(row=>row.elements.map(value=>value.value));
  assert.deepEqual(limited.map(row=>row[2]),['bold','italic','createLink','insertUnorderedList','insertOrderedList','formatBlock']);assert.equal(limited.at(-1)[3],'p');
  assert.ok(noticeSource.includes('if (!dirty) return;'));assert.ok(noticeSource.includes("addEventListener('beforeunload', unload)"));assert.ok(noticeSource.includes('return () => { release();'));
});

test('shared ComposeEditor leaves the default unchanged and only the opt-in notice editor sets p paragraphs',()=>{
  const source=readFileSync(new URL('../../web/src/components/ComposeEditor.jsx',import.meta.url),'utf8'),ast=parse(source,{sourceType:'module',plugins:['jsx']});
  const component=ast.program.body.find(node=>node.type==='ExportDefaultDeclaration').declaration;
  let setting;
  function walk(node){if(!node||typeof node!=='object')return;if(node.type==='IfStatement'&&node.test.type==='BinaryExpression'&&node.test.left.name==='paragraphSeparator')setting=node;for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}}
  walk(component);assert.ok(setting);
  const configure=new Function('paragraphSeparator','doc',source.slice(setting.start,setting.end)),calls=[],doc={execCommand(...args){calls.push(args);}};
  configure(undefined,doc);assert.deepEqual(calls,[]);
  configure('p',doc);assert.deepEqual(calls,[['defaultParagraphSeparator',false,'p']]);
  assert.ok(readFileSync(new URL('../../web/src/admin/pages/NoticeEditor.jsx',import.meta.url),'utf8').includes('paragraphSeparator="p"'));
});

test('shared ComposeEditor keeps original inline CSS by default and uses an external stylesheet only when opted in',()=>{
  const source=readFileSync(new URL('../../web/src/components/ComposeEditor.jsx',import.meta.url),'utf8'),ast=parse(source,{sourceType:'module',plugins:['jsx']});
  const component=ast.program.body.find(node=>node.type==='ExportDefaultDeclaration').declaration;
  const declaration=component.body.body.flatMap(node=>node.type==='VariableDeclaration'?node.declarations:[]).find(node=>node.id.name==='source');
  const render=new Function('stylesheetUrl','return '+source.slice(declaration.init.start,declaration.init.end));
  const original=render(undefined);assert.ok(original.includes('<style>@font-face'));assert.ok(original.includes('body{padding:18px 22px 10px'));assert.ok(!original.includes('<link'));
  const notice=render('/assets/notice-editor.css?synthetic="quoted"&v=1');assert.ok(!notice.includes('<style>'));assert.ok(notice.includes('rel="stylesheet"'));assert.ok(notice.includes('&quot;quoted&quot;&amp;v=1'));
  const noticeSource=readFileSync(new URL('../../web/src/admin/pages/NoticeEditor.jsx',import.meta.url),'utf8');assert.ok(noticeSource.includes('./notice-editor.css?url&no-inline'));assert.ok(noticeSource.includes('stylesheetUrl={editorStylesheet}'));
  assert.ok(!readFileSync(new URL('../../web/src/components/ComposeEditor.jsx',import.meta.url),'utf8').includes("execCommand('styleWithCSS'"));
});
