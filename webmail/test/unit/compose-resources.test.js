import { test } from 'node:test';
import assert from 'node:assert/strict';
import { session, verifiedSession, invalidateSessionResources } from '../../web/src/state/session.js';
import { checkServerSession, watchServerSession, api } from '../../web/src/api.js';
import { signatureRequest } from '../../web/src/signatures.js';
import { getSignatureImageContent } from '../../web/src/signature-images.js';
import { toast } from '../../web/src/state/toast.js';
import { signatures, signatureImages } from '../../web/src/state/signatures.js';
import { composeIdentities, getComposeResources, preloadComposeResources, loadComposeIdentities, refreshComposeIdentities, prepareComposeSignature, composeImageContent, MAX_COMPOSE_IMAGE_BYTES, senderDomain } from '../../web/src/state/compose-resources.js';

const id='A'.repeat(32), other='B'.repeat(32);
const doc=()=>({revision:'r1',items:[{id:'sig',name:'Example',html:'<p>Example</p>'}],defaults:{},usedBytes:1,maxBytes:262144,notices:[]});
const library=()=>({revision:'i1',images:[],usedBytes:0,maxBytes:1048576,maxFileBytes:204800,maxCount:20});
function setup(t, handler) {
  const before=globalThis.fetch, requests=[];
  globalThis.fetch=async(path,options)=>{requests.push(path);if(path==='/api/auth/session')return handler?.(path,options) ?? Response.json(session.value);return handler?.(path,options) ?? Response.json(path==='/api/compose/identities'?{identities:[{address:session.value.user.email,name:'Example',kind:'self'}],defaultFrom:session.value.user.email,anyAtDomains:[],anyAddress:false}:path==='/api/signatures'?doc():library());};
  session.value={user:{email:'person@account.example'},csrf:'synthetic'};
  verifiedSession.value=session.value;
  t.after(()=>{session.value=null;globalThis.fetch=before;});
  return requests;
}
test('compose resources deduplicate initial requests and never fetch rules or repeat cached lists',async t=>{
  const requests=setup(t);
  const [first,second]=await Promise.all([getComposeResources(),getComposeResources()]);
  assert.deepEqual(first,second);await getComposeResources();
  assert.deepEqual(requests.sort(),['/api/compose/identities','/api/signature-images','/api/signatures']);
  assert.equal(senderDomain(first.identities.defaultFrom),'account.example');assert.equal(senderDomain('member@another.example'),'another.example');
});
test('logout/account switch clears resources immediately and ignores late identities',async t=>{
  let release, requests=0;
  setup(t,(path)=>path==='/api/compose/identities'&&++requests===1?new Promise(resolve=>{release=()=>resolve(Response.json({identities:[{address:'old@old.example'}]}));}):undefined);
  const pending=loadComposeIdentities();
  session.value=null;assert.equal(composeIdentities.value,null);assert.equal(signatures.value,null);assert.equal(signatureImages.value,null);
  session.value={user:{email:'new@new.example'},csrf:'new'};
  release();await assert.rejects(pending);assert.equal(composeIdentities.value,null);
  const fresh=await getComposeResources();assert.equal(fresh.identities.identities[0].address,'new@new.example');
});
test('failed preload is retried on demand and a failure is never cached',async t=>{
  let lists=0;
  setup(t,path=>path==='/api/signatures'&&++lists===1?Response.json({error:{code:'MAIL_UNAVAILABLE',message:'synthetic'}},{status:503}):undefined);
  assert.ok((await getComposeResources()).assets.error);assert.equal(signatures.value,null);
  const ready=await getComposeResources();assert.deepEqual(ready.assets.signatures,doc());assert.equal(lists,2);
});
test('normalization and image bytes match uncached results and settings updates invalidate them',async t=>{
  let normalizations=0,downloads=0;
  const bytes=Buffer.from('synthetic-image-bytes');
  setup(t,(path,options)=>path.endsWith('/normalize')?(normalizations++,Response.json({html:JSON.parse(options.body).html})):path.endsWith('/content')?(downloads++,new Response(bytes,{headers:{'Content-Type':'image/png'}})):undefined);
  const source=doc();
  assert.deepEqual(await prepareComposeSignature(source,'sig'),source);assert.deepEqual(await prepareComposeSignature(source,'sig'),source);assert.equal(normalizations,1);
  const first=await composeImageContent(id),second=await composeImageContent(id);
  assert.equal(first,second);assert.deepEqual(Buffer.from(await second.arrayBuffer()),bytes);assert.equal(downloads,1);
  signatures.value={...source,revision:'r2'};
  await prepareComposeSignature(source,'sig');await composeImageContent(id);
  assert.equal(normalizations,2);assert.equal(downloads,2);
});
test('image cache is capped at 5MiB; oversized aggregate falls back without retaining failed requests',async t=>{
  const counts=new Map();let fail=true;
  setup(t,path=>{if(!path.endsWith('/content'))return;counts.set(path,(counts.get(path)||0)+1);if(path.includes(other)&&fail){fail=false;return Response.json({error:{code:'MAIL_UNAVAILABLE',message:'synthetic'}},{status:503});}return new Response(new Uint8Array(3*1024*1024));});
  assert.equal(MAX_COMPOSE_IMAGE_BYTES,5*1024*1024);
  await composeImageContent(id);await assert.rejects(composeImageContent(other));await composeImageContent(other);await composeImageContent(other);await composeImageContent(id);
  assert.equal(counts.get(`/api/signature-images/${id}/content`),1);assert.equal(counts.get(`/api/signature-images/${other}/content`),3);
});


test('settings refresh cannot be overwritten by an older identity preload',async t=>{
  let release,count=0;
  setup(t,path=>{if(path!=='/api/compose/identities')return;if(++count===1)return new Promise(resolve=>{release=()=>resolve(Response.json({identities:[{address:'person@account.example',name:'Old'}]}));});return Response.json({identities:[{address:'person@account.example',name:'New'}]});});
  const older=loadComposeIdentities();await refreshComposeIdentities();release();
  assert.equal((await older).identities[0].name,'New');assert.equal(composeIdentities.value.identities[0].name,'New');
});


test('opening while a preload fails makes a fresh on-demand request',async t=>{
  let release,count=0;
  setup(t,path=>{if(path==='/api/compose/identities'&&++count===1)return new Promise(resolve=>{release=()=>resolve(Response.json({error:{code:'DIRECTORY_UNAVAILABLE',message:'synthetic'}},{status:503}));});});
  const preload=preloadComposeResources();const opened=getComposeResources();
  release();await assert.rejects(preload);
  assert.equal((await opened).identities.defaultFrom,'person@account.example');assert.equal(count,2);
});


test('late authentication failure from a previous identity preload cannot log out the new account',async t=>{
  let release;
  setup(t,path=>path==='/api/compose/identities'?new Promise(resolve=>{release=()=>resolve(Response.json({error:{code:'NO_SESSION',message:'synthetic'}},{status:403}));}):undefined);
  const old=loadComposeIdentities(),next={user:{email:'next@another.example'},csrf:'next'};
  session.value=next;release();await assert.rejects(old);
  assert.equal(session.value,next);assert.equal(composeIdentities.value,null);
});


test('unverified compose open waits for one shared server session check before cache reuse',async t=>{
  let release;
  const requests=setup(t,path=>path==='/api/auth/session'?new Promise(resolve=>{release=()=>resolve(Response.json(session.value));}):undefined);
  await preloadComposeResources();const owner=session.value;
  verifiedSession.value=null;
  const first=getComposeResources(),second=getComposeResources();
  assert.equal(requests.filter(path=>path==='/api/auth/session').length,1);
  release();await Promise.all([first,second]);
  assert.equal(session.value,owner);assert.equal(verifiedSession.value,owner);
  assert.equal(requests.filter(path=>path==='/api/compose/identities').length,1);
});
test('cross-tab invalidation discards identities, signatures and late old-account metadata',async t=>{
  let release;
  setup(t,path=>path==='/api/signatures'?new Promise(resolve=>{release=()=>resolve(Response.json(doc()));}):undefined);
  const pending=preloadComposeResources();await Promise.resolve();
  invalidateSessionResources();release();await assert.rejects(pending);
  assert.equal(composeIdentities.value,null);assert.equal(signatures.value,null);assert.equal(signatureImages.value,null);
  assert.equal(verifiedSession.value,null);
});
test('same-account relogin updates CSRF without replacing the session object',async t=>{
  setup(t,path=>path==='/api/auth/session'?Response.json({user:{email:'person@account.example'},csrf:'replacement'}):undefined);
  const owner=session.value;await checkServerSession();
  assert.equal(session.value,owner);assert.equal(owner.csrf,'replacement');assert.equal(verifiedSession.value,owner);
});
test('session verification failures cannot authorize a cached composition',async t=>{
  const requests=setup(t,path=>path==='/api/auth/session'?Response.json({error:{code:'MAIL_UNAVAILABLE',message:'synthetic'}},{status:503}):undefined);
  await preloadComposeResources();verifiedSession.value=null;
  await assert.rejects(getComposeResources());assert.equal(verifiedSession.value,null);
  assert.equal(requests.filter(path=>path==='/api/compose/identities').length,1);
});
test('storage fallback broadcasts login/logout and coalesces focus checks',async t=>{
  const original={window:globalThis.window,document:globalThis.document,BroadcastChannel:globalThis.BroadcastChannel,localStorage:globalThis.localStorage};
  const win=new EventTarget(),document=new EventTarget(),writes=[];
  document.querySelector=()=>null;document.visibilityState='visible';
  globalThis.window=win;globalThis.document=document;globalThis.BroadcastChannel=undefined;globalThis.localStorage={setItem:(...args)=>writes.push(args)};
  let release;const requests=setup(t,path=>path==='/api/auth/session'?new Promise(resolve=>{release=()=>resolve(Response.json(session.value));}):path==='/api/auth/login'?Response.json(session.value):path==='/api/auth/logout'?new Response(null,{status:204}):undefined);
  const stop=watchServerSession(()=>{});t.after(()=>{stop();Object.assign(globalThis,original);});
  win.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(requests.filter(path=>path==='/api/auth/session').length,1);release();await checkServerSession();
  await api('/api/auth/login',{method:'POST',body:{}});await api('/api/auth/logout',{method:'POST'});
  assert.equal(writes.filter(([key])=>key==='webmail-auth-change').length,2);
});


test('cross-tab invalidation rejects late normalized HTML and image bytes before they reach a composer',async t=>{
  let normalize,image;
  const requests=setup(t,(path,options)=>path.endsWith('/normalize')?new Promise(resolve=>{normalize=()=>resolve(Response.json({html:JSON.parse(options.body).html}));}):path.endsWith('/content')?new Promise(resolve=>{image=()=>resolve(new Response('synthetic-image'));}):undefined);
  const html=prepareComposeSignature(doc(),'sig'),bytes=composeImageContent(id);
  invalidateSessionResources();normalize();image();
  await assert.rejects(html);await assert.rejects(bytes);
  assert.equal(requests.filter(path=>path.endsWith('/content')).length,1);
});


for (const code of ['SESSION_EXPIRED','NO_SESSION']) for (const [name,request,path] of [
  ['api',()=>api('/api/drafts',{method:'PUT',body:{}}),'/api/drafts'],
  ['signature JSON',()=>signatureRequest('/api/signatures'),'/api/signatures'],
  ['image content',()=>getSignatureImageContent(id),`/api/signature-images/${id}/content`],
]) {
  test(`${name}: late ${code} after same-account relogin cannot end the new session`,async t=>{
    let release;
    setup(t,p=>p===path?new Promise(resolve=>{release=()=>resolve(Response.json({error:{code,message:'synthetic old session'}},{status:403}));}):p==='/api/auth/session'?Response.json({user:{email:'person@account.example'},csrf:'new-csrf'}):undefined);
    const owner=session.value,notice={kind:'test-notice',message:'keep'};toast.value=notice;
    const old=request(),failed=assert.rejects(old);
    await checkServerSession();release();await failed;
    assert.equal(session.value,owner);assert.equal(owner.csrf,'new-csrf');assert.equal(toast.value,notice);
    t.after(()=>{toast.value=null;});
  });
  test(`${name}: current-generation ${code} still ends the session`,async t=>{
    setup(t,p=>p===path?Response.json({error:{code,message:'synthetic current session'}},{status:403}):undefined);
    await assert.rejects(request());assert.equal(session.value,null);
  });
}
test('late old-account draft auth failure cannot end a newly logged-in account',async t=>{
  let release;
  setup(t,p=>p==='/api/drafts'?new Promise(resolve=>{release=()=>resolve(Response.json({error:{code:'SESSION_EXPIRED',message:'old draft'}},{status:403}));}):p==='/api/auth/login'?Response.json({user:{email:'next@another.example'},csrf:'next'}):undefined);
  const old=api('/api/drafts',{method:'PUT',body:{}}),failed=assert.rejects(old);
  await api('/api/auth/login',{method:'POST',body:{}});const next=session.value;
  release();await failed;assert.equal(session.value,next);
});


test('old-generation SSE expiry reconnects quietly; current-generation expiry still logs out',async t=>{
  const previous=globalThis.EventSource,connections=[];
  globalThis.EventSource=class extends EventTarget{constructor(){super();connections.push(this);}close(){this.closed=true;}};
  setup(t,path=>path==='/api/auth/session'?Response.json({user:{email:'person@account.example'},csrf:'new-sse-csrf'}):undefined);
  const {route}=await import('../../web/src/router.js'),oldRoute=route.value;route.value={name:'settings',value:''};
  const {connectMailboxEvents}=await import('../../web/src/state/list.js');const stop=connectMailboxEvents();
  t.after(()=>{stop();globalThis.EventSource=previous;route.value=oldRoute;});
  const owner=session.value;await checkServerSession();
  const expire=source=>source.dispatchEvent(new MessageEvent('session',{data:JSON.stringify({state:'expired'})}));
  expire(connections[0]);assert.equal(session.value,owner);assert.equal(connections[0].closed,true);assert.equal(connections.length,2);
  expire(connections[0]);assert.equal(connections.length,2);
  expire(connections[1]);assert.equal(session.value,null);
});
