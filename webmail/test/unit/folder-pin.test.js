import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrefsService, PREFS_ENTRY } from '../../server/prefs.js';
import { folders, pinnedFoldersAfterChange, pinnedFolderPaths, visiblePinnedFolders, savePinnedFolders } from '../../web/src/state/folders.js';
import { prefs, prefsSaving, prefsSaved, applyServerPrefs, updatePrefs } from '../../web/src/state/prefs.js';
import { session, sessionReady } from '../../web/src/state/session.js';

function fixture() {
  let raw=null, fail=false;
  const client={enabled:new Set(),capabilities:new Map(),exec:async(command,args,options)=>{
    if(fail)throw new Error('synthetic');
    if(command==='GETMETADATA')options.untagged.METADATA({attributes:[{value:''},[{value:PREFS_ENTRY},{value:raw===null?null:Buffer.from(raw)}]]});
    else raw=args[1][1].value.toString();
    return {next(){}};
  }};
  const service=createPrefsService({config:{defaultTheme:'ink',defaultMode:'light',publicHostnames:[]},imap:{withMailbox:async(_s,_p,fn)=>fn(client)},directory:{identities:async()=>({identities:[{address:'user@example.com'}]})}});
  return {service,owner:{email:'user@example.com'},stored:()=>JSON.parse(raw),setRaw:value=>{raw=JSON.stringify(value);},fail:()=>{fail=true;}};
}
test('pin prefs: missing fields default and partial PUT preserves existing preferences',async()=>{
  const f=fixture();f.setRaw({mode:'dark',folderColors:{A:2},imageAllow:['sender@example.com'],fromNames:{'user@example.com':'Synthetic'},signatures:{'user@example.com':{html:'<p>Signature</p>',auto:false}}});
  const first=await f.service.get(f.owner);assert.deepEqual(first.pinnedFolders,[]);assert.equal(first.pinPosition,'mine');
  await f.service.put(f.owner,{pinnedFolders:['A','A/하위'],pinPosition:'inbox'});
  const saved=await f.service.get(f.owner);assert.deepEqual(saved,{...first,pinnedFolders:['A','A/하위'],pinPosition:'inbox'});
  await f.service.put(f.owner,{mode:'light'});assert.deepEqual(f.stored().pinnedFolders,['A','A/하위']);
});
for(const [name,value] of [['not array',{}],['51st',Array.from({length:51},(_,i)=>`F${i}`)],['duplicate',['A','A']],['empty',['']],['blank',[' ']],['number',[4]],['null',[null]],['nul',['A\0B']],['newline',['A\nB']],['return',['A\rB']]])test(`pin prefs: reject ${name}`,async()=>{
  const f=fixture();await assert.rejects(f.service.put(f.owner,{pinnedFolders:value}),error=>error.statusCode===422);assert.equal(f.stored(),null);
});
test('pin prefs: accepts 50, rejects invalid position, 413 and 503 leave stored pins unchanged',async()=>{
  const f=fixture(),paths=Array.from({length:50},(_,i)=>`F${i}`);await f.service.put(f.owner,{pinnedFolders:paths,pinPosition:'mine'});
  await assert.rejects(f.service.put(f.owner,{pinPosition:'top'}),error=>error.statusCode===422);
  await assert.rejects(f.service.put(f.owner,{pinnedFolders:['x'.repeat(65536)]}),error=>error.statusCode===413);
  assert.deepEqual(f.stored().pinnedFolders,paths);f.fail();await assert.rejects(f.service.put(f.owner,{pinnedFolders:[]}),error=>error.statusCode===503);assert.deepEqual(f.stored().pinnedFolders,paths);
});
let stateSequence=0;
function state(paths,rows=paths) {
  session.value={user:{email:`pin${++stateSequence}@example.com`}};
  prefs.value={pinnedFolders:paths,folderColors:{}};
  folders.value={folders:rows.map(path=>({path,name:path.split('/').at(-1)}))};
}
test('pin state: rename A and descendants, preserve AB, never prune new paths against old rows',()=>{
  state(['A','A/하위','AB']);
  const renamed=pinnedFoldersAfterChange({from:'A',to:'Z'});assert.deepEqual(renamed,['Z','Z/하위','AB']);
  prefs.value={...prefs.value,pinnedFolders:renamed};folders.value={folders:[{path:'Z'},{path:'Z/하위'},{path:'AB'}]};
  assert.deepEqual(visiblePinnedFolders().map(row=>row.path),renamed);
  assert.deepEqual(pinnedFoldersAfterChange({from:'Z',deleted:true}),['AB']);
});
test('pin state: show existing personal folders only, keep stale saved entries until a pin change',()=>{
  state(['Gone','A','Inbox','Shared'],['A']);folders.value={folders:[...folders.value.folders,{path:'Inbox',specialUse:'\\Inbox'},{path:'Shared',shared:true}]};
  assert.deepEqual(visiblePinnedFolders().map(row=>row.path),['A']);assert.deepEqual(prefs.value.pinnedFolders,['Gone','A','Inbox','Shared']);
});
test('pin state: rename alias survives failed prefs save, clears after pin save success and is session scoped',()=>{
  state(['A','A/하위','AB']);const before={...prefs.value};
  const paths=pinnedFoldersAfterChange({from:'A',to:'Z'});prefs.value={...before,pinnedFolders:paths};
  prefsSaving.value=true;prefs.value=before;prefsSaving.value=false;
  assert.deepEqual(pinnedFolderPaths(),['Z','Z/하위','AB']);
  prefsSaving.value=true;prefs.value={...before,pinnedFolders:paths};prefsSaved.value={patch:{pinnedFolders:paths},saved:prefs.value};prefsSaving.value=false;
  prefs.value=before;assert.deepEqual(pinnedFolderPaths(),['A','A/하위','AB']);
  pinnedFoldersAfterChange({from:'A',to:'Y'});session.value=null;assert.deepEqual(pinnedFolderPaths(),['A','A/하위','AB']);
});
test('pin state: 51st pin is refused without changing preferences',()=>{
  const paths=Array.from({length:51},(_,i)=>`F${i}`);state(paths.slice(0,50),paths);assert.equal(savePinnedFolders(paths),false);assert.equal(prefs.value.pinnedFolders.length,50);
});

test('pin aliases survive unrelated in-flight save with queued optimistic pins, then pin save failure',async t=>{
  const oldFetch=globalThis.fetch,oldStorage=globalThis.localStorage;
  globalThis.localStorage={setItem(){}};sessionReady.value=true;
  state(['A']);const original={...prefs.value};applyServerPrefs(original);
  let stored={...original},release,failPins=true;
  const gate=new Promise(resolve=>{release=resolve;});
  globalThis.fetch=async(_path,options)=>{
    if(options.method==='PUT'){
      const patch=JSON.parse(options.body);
      if(patch.mode)await gate;
      if(patch.pinnedFolders&&failPins)return Response.json({error:{code:'SYNTHETIC',message:'합성 실패'}},{status:503});
      stored={...stored,...patch};return new Response(null,{status:204});
    }
    return Response.json(stored);
  };
  t.mock.timers.enable({apis:['setTimeout']});
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.localStorage=oldStorage;sessionReady.value=false;session.value=null;});
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  updatePrefs({mode:'dark'});t.mock.timers.tick(500);await flush();
  const paths=pinnedFoldersAfterChange({from:'A',to:'Z'});folders.value={folders:[{path:'Z'}]};updatePrefs({pinnedFolders:paths});
  release();await flush();await flush();assert.deepEqual(prefs.value.pinnedFolders,['Z']);assert.deepEqual(stored.pinnedFolders,['A']);
  t.mock.timers.tick(500);await flush();await flush();assert.deepEqual(prefs.value.pinnedFolders,['A']);assert.deepEqual(pinnedFolderPaths(),['Z']);
  assert.equal(visiblePinnedFolders()[0].path,'Z');
  failPins=false;savePinnedFolders(['Z']);t.mock.timers.tick(500);await flush();await flush();assert.deepEqual(stored.pinnedFolders,['Z']);
  prefs.value={...prefs.value,pinnedFolders:['A']};assert.deepEqual(pinnedFolderPaths(),['A']);
});
