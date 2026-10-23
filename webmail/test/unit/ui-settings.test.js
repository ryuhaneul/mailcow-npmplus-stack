import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { prefs, applyServerPrefs, updatePrefs } from '../../web/src/state/prefs.js';
import { session, sessionReady } from '../../web/src/state/session.js';
import { toast } from '../../web/src/state/toast.js';
import { route } from '../../web/src/router.js';
import { initShortcuts, registerShortcuts } from '../../web/src/shortcuts.js';
const document = () => ({theme:'ink',mode:'light',accent:{},layout:null,folderColors:{},imageAllow:['sender@example.com'],signatures:{'user@example.com':{html:'<p>예시</p>',auto:true}},defaultFrom:'user@example.com'});
const flush = () => new Promise(resolve=>setImmediate(resolve));
function setup(t) {
  const fetch=globalThis.fetch,storage=globalThis.localStorage;
  const copies=[];globalThis.localStorage={setItem(_key,value){copies.push(JSON.parse(value));}};
  session.value={user:{email:'user@example.com'},csrf:'synthetic'};sessionReady.value=true;applyServerPrefs(document());copies.length=0;
  t.mock.timers.enable({apis:['setTimeout']});
  t.after(()=>{globalThis.fetch=fetch;globalThis.localStorage=storage;session.value=null;sessionReady.value=false;toast.value=null;});
  return copies;
}
test('appearance changes coalesce into changed fields; copy only follows server success',async t=>{
  const copies=setup(t),requests=[];
  let serverDoc=document();globalThis.fetch=async(path,options)=>{requests.push({path,body:options.body?JSON.parse(options.body):null});if(options.method==='PUT'){serverDoc={...serverDoc,...JSON.parse(options.body)};return new Response(null,{status:204});}return Response.json(serverDoc);};
  updatePrefs({theme:'seland'});updatePrefs({mode:'dark'});updatePrefs({accent:{seland:'#888888'}});
  assert.equal(prefs.value.theme,'seland');assert.equal(copies.length,0);assert.equal(requests.length,0);
  t.mock.timers.tick(500);await flush();
  assert.equal(requests.length,2);assert.deepEqual(requests[0].body,{theme:'seland',mode:'dark',accent:{seland:'#888888'}});assert.deepEqual(copies,[serverDoc]);
});
test('failed prefs save restores confirmed document and keeps persisted copy unchanged',async t=>{
  const copies=setup(t);globalThis.fetch=async()=>Response.json({error:{code:'MAIL_UNAVAILABLE',message:'저장할 수 없어요.'}},{status:503});
  updatePrefs({layout:{pane:'right',density:'compact',compose:'full'}});t.mock.timers.tick(500);await flush();
  assert.deepEqual(prefs.value,document());assert.equal(copies.length,0);assert.equal(toast.value.message,'저장할 수 없어요.');
});
test('screen shortcut registration is scoped, input-safe and removable',t=>{
  const dom=new JSDOM('<textarea></textarea><button>예시</button>'),previous=globalThis.document;globalThis.document=dom.window.document;
  const before=route.value;route.value={name:'compose'};let count=0,ordinary=0;
  const unregister=registerShortcuts('compose',{'Ctrl+Enter':()=>count++,r:()=>count++}),stop=initShortcuts(()=>ordinary++);
  t.after(()=>{stop();unregister();route.value=before;globalThis.document=previous;dom.window.close();});
  const input=globalThis.document.querySelector('textarea'),button=globalThis.document.querySelector('button');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'r',bubbles:true}));assert.equal(count,0);assert.equal(ordinary,0);
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));assert.equal(count,1);
  route.value={name:'inbox'};button.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'r',bubbles:true}));assert.equal(count,1);
  route.value={name:'compose'};unregister();input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));assert.equal(count,1);
});


test('in-flight appearance update preserves a separately saved name and later queued fields', async t => {
  setup(t); let stored={...document(),fromNames:{}},release,started;
  const gate=new Promise(resolve=>{release=resolve;}),begin=new Promise(resolve=>{started=resolve;}),writes=[];
  globalThis.fetch=async(_path,options)=>{
    if(options.method==='PUT'){
      const patch=JSON.parse(options.body);writes.push(patch);
      if(writes.length===1){started();await gate;}
      stored={...stored,...patch};return new Response(null,{status:204});
    }
    return Response.json(stored);
  };
  updatePrefs({mode:'dark'});t.mock.timers.tick(500);await begin;
  stored.fromNames={'user@example.com':'Saved Elsewhere'};
  updatePrefs({theme:'olive'});release();await flush();await flush();
  t.mock.timers.tick(500);await flush();await flush();
  assert.deepEqual(writes,[{mode:'dark'},{theme:'olive'}]);
  assert.equal(stored.fromNames['user@example.com'],'Saved Elsewhere');assert.equal(prefs.value.fromNames['user@example.com'],'Saved Elsewhere');
  assert.equal(prefs.value.theme,'olive');assert.equal(stored.mode,'dark');
});
