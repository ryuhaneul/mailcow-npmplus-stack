import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { createPublicTemplateEditor, publicTemplatePayload, validatePublicTemplate, encodePublicFile, publicFilesLimit } from '../../web/src/admin/pages/public-templates.js';
import { parseAdminRoute } from '../../web/src/admin/router.js';
import { adminNav } from '../../web/src/admin/state/nav.js';

const version = '2026-10-28T07:00:00.123456Z';
const row = extra => ({ id: 7, name: '합성 템플릿', subject: '{{오늘}}', html: '<p>{{이름}}</p>', audienceAll: false, domains: ['example.test'], updatedAt: version, attachments: [{id:11,name:'old.bin',type:'application/octet-stream',size:3}], ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => {resolve=done;}); return {resolve,promise}; };
function fixture(t, request = async () => row(), existing = row()) {
  const calls = []; let owner = {};
  const model = createPublicTemplateEditor({ row:existing, domains:['example.test'], getOwner:()=>owner, request:async(path,options)=>{calls.push({path,...options});return request(path,options);}});
  t.after(()=>model.dispose()); return {model,calls,otherOwner(){owner={};}};
}
test('admin public templates: nav beside notices and numeric/new route preserved',()=>{
  const index=adminNav.findIndex(([name])=>name==='notices');assert.equal(adminNav[index+1][0],'public-templates');
  assert.deepEqual(parseAdminRoute('#public-templates/7'),{name:'public-templates',parts:['7']});
  assert.deepEqual(parseAdminRoute('#public-templates/new'),{name:'public-templates',parts:['new']});
});
test('admin public templates: create/update payload keeps IDs, encodes only added files and retains exact six digit version',async t=>{
  const f=fixture(t);assert.equal(f.model.dirty(),false);
  await f.model.addFiles([{name:'new.bin',type:'application/octet-stream',size:2,arrayBuffer:async()=>new Uint8Array([0,255]).buffer}]);
  f.model.update({name:'  새 이름  ',subject:'{{오늘}} 새 제목'});assert.equal(f.model.dirty(),true);
  await f.model.save();const body=f.calls[0].body;
  assert.equal(f.calls[0].path,'/api/admin/public-templates/7');assert.equal(f.calls[0].method,'PUT');assert.equal(body.updatedAt,version);
  assert.deepEqual(body.keepFileIds,[11]);assert.deepEqual(body.newFiles,[{name:'new.bin',type:'application/octet-stream',dataBase64:'AP8='}]);assert.equal(body.name,'새 이름');
  assert.equal(f.model.dirty(),false);assert.equal(f.model.state.peek().draft.attachments.some(file=>file.uploadId),false);
  const fresh=fixture(t,async()=>row(),null);await fresh.model.save();assert.equal(fresh.calls[0].method,'POST');assert.equal(fresh.calls[0].body.updatedAt,undefined);
});
test('admin public templates: remove retained/new attachment has no remote delete until explicit save',async t=>{
  const f=fixture(t);await f.model.addFiles([{name:'new',type:'',size:1,arrayBuffer:async()=>new Uint8Array([1]).buffer}]);
  f.model.removeAttachment(0);assert.equal(f.calls.length,0);await f.model.save();assert.deepEqual(f.calls[0].body.keepFileIds,[]);assert.equal(f.calls[0].body.newFiles[0].type,'application/octet-stream');
});
test('admin public templates: active domain selection and 100 Unicode character name validation',()=>{
  const draft={...row(),name:'😀'.repeat(100)};assert.deepEqual(validatePublicTemplate(draft,['example.test']),{});
  for(const patch of [{name:''},{name:'x'.repeat(101)},{name:'\ud800'},{domains:[]},{domains:['inactive.test']},{attachments:[{size:publicFilesLimit+1}]}])assert.ok(Object.keys(validatePublicTemplate({...draft,...patch},['example.test'])).length);
  assert.deepEqual(publicTemplatePayload({...draft,audienceAll:true},{id:null}).domains,[]);
});
for(const error of [{status:422,code:'PUBLIC_TEMPLATE_CID',message:'메일에 붙인 이미지는 넣을 수 없어요.'},{status:422,code:'PUBLIC_TEMPLATE_IMAGE_URL',message:'그림은 https 주소만 넣을 수 있어요.'},{status:503,code:'PUBLIC_TEMPLATES_UNAVAILABLE',message:'준비되지 않았어요.'}])test(`admin public templates: ${error.code} preserves input/attachments and server reason`,async t=>{
  const f=fixture(t,async()=>{throw error;});f.model.update({html:'<p>사용자 수정</p>'});const before=structuredClone(f.model.state.peek().draft);
  await f.model.save();assert.deepEqual(f.model.state.peek().draft,before);assert.equal(f.model.state.peek().error.message,error.message);assert.equal(f.model.state.peek().needsReload,false);assert.equal(f.model.dirty(),true);
});
test('admin public templates: 409 freezes saving, preserves draft, explicit reload replaces version and resets dirty',async t=>{
  let reads=0;const f=fixture(t,async(path,options)=>{if(options?.method==='PUT')throw{status:409,code:'CONFLICT',message:'다른 곳'};reads++;return row({updatedAt:'2026-10-28T07:00:00.123457Z',html:'<p>다른 곳 수정</p>'});});
  f.model.update({html:'<p>내 수정</p>'});await f.model.save();assert.equal(f.model.state.peek().needsReload,true);assert.equal(f.model.state.peek().draft.html,'<p>내 수정</p>');
  await f.model.save();assert.equal(f.calls.length,1);await f.model.reload();assert.equal(reads,1);assert.equal(f.model.state.peek().meta.updatedAt,'2026-10-28T07:00:00.123457Z');assert.equal(f.model.state.peek().needsReload,false);assert.equal(f.model.dirty(),false);
});
test('admin public templates: delete sends opened version and clean state only after success',async t=>{
  const f=fixture(t,async()=>({ok:true}));assert.equal(await f.model.remove(),true);assert.deepEqual(f.calls[0],{path:'/api/admin/public-templates/7',method:'DELETE',body:{updatedAt:version}});assert.equal(f.model.dirty(),false);
});
test('admin public templates: quota checked before reading new files and failed multi-file read preserves existing files',async t=>{
  const f=fixture(t);let reads=0;await f.model.addFiles([{name:'over',size:publicFilesLimit,arrayBuffer:async()=>{reads++;return new ArrayBuffer(0);}}]);assert.equal(reads,0);assert.equal(f.model.state.peek().draft.attachments.length,1);
  await f.model.addFiles([{name:'good',size:1,arrayBuffer:async()=>new Uint8Array([1]).buffer},{name:'bad',size:1,arrayBuffer:async()=>{throw Error('합성 읽기 오류');}}]);assert.equal(f.model.state.peek().draft.attachments.length,1);assert.equal(f.model.state.peek().busy,false);
});
test('admin public templates: double save, disposed/changed session and delayed file read cannot update another owner',async t=>{
  const wait=deferred(),f=fixture(t,()=>wait.promise);f.model.update({name:'수정'});const saving=f.model.save();await f.model.save();assert.equal(f.calls.length,1);f.otherOwner();wait.resolve(row({name:'다른 세션'}));await saving;assert.equal(f.model.state.peek().draft.name,'수정');
  const waitFile=deferred(),g=fixture(t);const adding=g.model.addFiles([{name:'wait',size:1,arrayBuffer:()=>waitFile.promise}]);g.model.dispose();waitFile.resolve(new Uint8Array([1]).buffer);await adding;assert.equal(g.model.state.peek().draft.attachments.length,1);
});
test('admin public templates: file bytes use canonical base64 without data URL prefix',async()=>{
  assert.equal(await encodePublicFile({arrayBuffer:async()=>new Uint8Array([0,1,127,255]).buffer}),'AAF//w==');
});
function source(path){return readFileSync(new URL(`../../web/src/${path}`,import.meta.url),'utf8');}
test('admin public templates: JSX and written UI test parse; scoped styles and external CSP stylesheet',()=>{
  for(const path of ['admin/pages/PublicTemplates.jsx','components/TemplateEditor.jsx','admin/app.jsx'])parse(source(path),{sourceType:'module',plugins:['jsx']});
  const ui=readFileSync(new URL('../ui/admin-public-templates.test.mjs',import.meta.url),'utf8');parse(ui,{sourceType:'module'});
  const component=source('admin/pages/PublicTemplates.jsx');assert.match(component,/notice-editor\.css\?url&no-inline/);assert.match(component,/stylesheetUrl=\{editorStylesheet\}/);assert.match(component,/registerAdminLeaveGuard/);assert.match(component,/beforeunload/);assert.match(component,/ManagementDialog title="템플릿 삭제"/);
  for(const rule of source('admin/pages/public-templates.css').split('\n').filter(line=>line.includes('{')&&!line.startsWith('@media')))assert.match(rule,/^\s*\.na-public/);
});
test('personal TemplateEditor defaults still bind original callbacks without management stylesheet or changed shared controls',()=>{
  const text=source('components/TemplateEditor.jsx'),ast=parse(text,{sourceType:'module',plugins:['jsx']});
  assert.ok(ast.program.body.some(node=>node.type==='ExportNamedDeclaration'&&node.declaration?.id?.name==='TemplateEditorFields'));
  const call=text.match(/<TemplateEditorFields ([^>]+)\/>/)[1];for(const value of ['model={model}','onChange={edit}','editor={editor}','onUpload={upload}','onRemoveAttachment={removeAttachment}','nameInput={nameInput}'])assert.ok(call.includes(value));
  assert.equal(call.includes('stylesheetUrl'),false);assert.match(text,/stylesheetUrl=\{stylesheetUrl\}/);assert.match(text,/useState\(false\), \[menu/);
  assert.match(text,/<FormatBar raw=\{raw\} toggle=\{\(\) => setRaw\(value => !value\)\} editor=\{editor\} disabled=\{disabled\}\/>/);
});
