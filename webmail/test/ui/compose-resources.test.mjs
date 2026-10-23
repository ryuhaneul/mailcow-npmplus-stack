import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { installAuth } from '../../server/routes/auth.js';
import { installErrors } from '../../server/errors.js';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

const asset='A'.repeat(32),sig='S'.repeat(32);
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7H8AAAAASUVORK5CYII=','base64');
const captures=process.env.COMPOSE_CAPTURE_DIR||'/tmp/compose-resources-captures';
await test('compose preload, account domains and warm opening latency',async t=>{
  const fake=createFakeApi({authenticated:true});
  const root=process.env.COMPOSE_BENCH_ROOT||fileURLToPath(new URL('../../web',import.meta.url));
  const server=await createServer({configFile:false,root,logLevel:'error',plugins:[preact(),{name:'compose-cache-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
  await server.listen();t.after(()=>server.close());t.after(()=>fake.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`,metrics=[];
  await mkdir(captures,{recursive:true});
  async function open({email='person@account.example',signed=false,authenticated=true,identityGate,failPreload=false,width=1280}={}){
    fake.state.authenticated=authenticated;fake.state.prefs.fromNames={};fake.state.prefs.defaultFrom=null;
    fake.state.identities={identities:[{address:email,name:'Synthetic',kind:'self'},{address:'alias@other.example',name:'Alias',kind:'alias'}],defaultFrom:email,anyAtDomains:[],anyAddress:false};
    const page=await browser.newPage({viewport:{width,height:900}}),requests=[],errors=[];let identityCount=0;
    page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))requests.push({path:new URL(r.url()).pathname,method:r.method()});});
    const user={user:{email,name:'Synthetic'},csrf:fake.state.csrf,expiresAt:Date.now()+3600000};
    let document={revision:'r1',items:signed?[{id:sig,name:'합성 서명',html:`<p>합성 서명 본문</p><img src="cid:wm-sig-v1.${asset}@signature.invalid" alt="합성 로고">`}]:[],defaults:signed?{[email]:{newDefault:sig,replyDefault:null}}:{},usedBytes:100,maxBytes:262144,notices:[]};
    await page.route('**/api/auth/session',route=>authenticated?route.fulfill({json:user}):route.fallback());
    await page.route('**/api/auth/login',route=>{fake.state.authenticated=true;return route.fulfill({json:user});});
    await page.route('**/api/compose/identities',async route=>{identityCount++;if(identityGate)await identityGate;if(failPreload&&identityCount===1)return route.fulfill({status:503,json:{error:{code:'DIRECTORY_UNAVAILABLE',message:'합성 실패'}}});return route.fulfill({json:{identities:[{address:email,name:fake.state.prefs.fromNames[email]||'Synthetic',kind:'self'},{address:'alias@other.example',name:'Alias',kind:'alias'}],defaultFrom:email,anyAtDomains:[],anyAddress:false}});});
    await page.route('**/api/rules',async route=>{await new Promise(resolve=>setTimeout(resolve,1000));return route.fallback();});
    await page.route('**/api/signatures',route=>{if(route.request().method()==='PUT'){document={...document,...route.request().postDataJSON(),revision:'r2'};}return route.fulfill({json:document});});
    await page.route('**/api/signatures/normalize',route=>route.fulfill({json:{html:route.request().postDataJSON().html}}));
    await page.route('**/api/signature-images',route=>route.fulfill({json:{revision:'i1',images:signed?[{id:asset,name:'logo.png',contentType:'image/png',size:bytes.length,width:1,height:1}]:[],usedBytes:bytes.length,maxBytes:1048576,maxFileBytes:204800,maxCount:20}}));
    await page.route('**/api/signature-images/*/content',route=>route.fulfill({body:bytes,contentType:'image/png'}));
    await page.goto(origin+'/#inbox');
    return {page,requests,errors,email,identityCount:()=>identityCount,document:()=>document};
  }
  async function warm(c){
    await expect(c.page.locator('.compose-btn')).toBeAttached();
    await c.page.evaluate(async()=>{
      const resources=await import('/src/state/compose-resources.js'),value=await resources.getComposeResources();
      const document=value.assets.signatures,id=document?.defaults[value.identities.defaultFrom]?.newDefault;
      if(id){const ready=await resources.prepareComposeSignature(document,id);for(const match of ready.items.find(item=>item.id===id).html.matchAll(/cid:wm-sig-v1\.([A-Za-z0-9_-]{32})@signature\.invalid/g))await resources.composeImageContent(match[1]);}
    });
  }
  for(const signed of [false,true])await t.test(`1s rules delay benchmark, signature=${signed}`,async()=>{
    const c=await open({signed});try{
      await expect(c.page.locator('.compose-btn')).toBeVisible();
      if(!process.env.COMPOSE_BENCH_ROOT)await warm(c);
      const before=c.requests.length,start=performance.now();
      await c.page.locator('.compose-btn').click();
      const body=c.page.frameLocator('iframe.compose-editor').locator('body');await expect(body).toHaveAttribute('contenteditable','true');
      metrics.push({signature:signed,openMs:Math.round(performance.now()-start),newRequests:c.requests.slice(before)});
      if(!process.env.COMPOSE_BENCH_ROOT){
        assert.equal(c.requests.slice(before).some(r=>['/api/rules','/api/compose/identities','/api/signatures','/api/signature-images','/api/signatures/normalize'].includes(r.path)||r.path.endsWith('/content')),false);
        await expect(c.page.getByRole('combobox',{name:'받는 사람 추가',exact:true})).toHaveAttribute('placeholder','이름이나 주소 · @account.example');
        if(signed){await expect(body).toContainText('합성 서명 본문');assert.deepEqual(await body.locator('img').evaluate(async img=>Array.from(new Uint8Array(await(await fetch(img.src)).arrayBuffer()))),[...bytes]);}
        await c.page.getByRole('button',{name:'쓰기 창 닫기',exact:true}).click();
        const again=c.requests.length;await c.page.locator('.compose-btn').click();await expect(body).toHaveAttribute('contenteditable','true');
        assert.equal(c.requests.slice(again).some(r=>['/api/rules','/api/compose/identities','/api/signatures','/api/signature-images'].includes(r.path)),false);
      }
      assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();}
  });
  await writeFile(`${captures}/${process.env.COMPOSE_BENCH_ROOT?'before':'after'}-timings.json`,JSON.stringify(metrics,null,2));
  if(process.env.COMPOSE_BENCH_ROOT)return;
  await t.test('first login shares pending preload, briefly loads and then opens with the right domain',async()=>{
    let release;const gate=new Promise(resolve=>release=resolve),c=await open({authenticated:false,identityGate:gate,email:'member@another.example'});
    try{
      await c.page.getByLabel('메일 주소',{exact:true}).fill(c.email);await c.page.getByLabel('암호',{exact:true}).fill('synthetic-password');await c.page.getByRole('button',{name:'로그인',exact:true}).click();
      await expect(c.page.locator('.compose-btn')).toBeVisible();await c.page.locator('.compose-btn').click();
      await expect(c.page.getByRole('status').filter({hasText:'보낼 주소를 불러오는 중…'})).toBeVisible();
      release();await expect(c.page.frameLocator('iframe.compose-editor').locator('body')).toHaveAttribute('contenteditable','true');
      assert.equal(c.identityCount(),1);await expect(c.page.getByRole('combobox',{name:'받는 사람 추가',exact:true})).toHaveAttribute('placeholder','이름이나 주소 · @another.example');
    }finally{release();await c.page.close();}
  });
  await t.test('failed initial preload retries when composing',async()=>{
    const c=await open({failPreload:true});try{
      await expect.poll(()=>c.identityCount()).toBe(1);await c.page.locator('.compose-btn').click();
      await expect(c.page.frameLocator('iframe.compose-editor').locator('body')).toHaveAttribute('contenteditable','true');assert.equal(c.identityCount(),2);
    }finally{await c.page.close();}
  });
  await t.test('name and signature settings refresh caches; focus refresh preserves chosen address, signature and body',async()=>{
    const c=await open({signed:true});try{
      await warm(c);
      await c.page.evaluate(()=>location.hash='filters/from');
      await c.page.locator(`[id="from-name-${c.email}"]`).fill('새 표시 이름');await c.page.getByRole('button',{name:`${c.email} 이름 저장`,exact:true}).click();await expect(c.page.getByRole('status')).toContainText('저장했어요.');
      // The same public save function used by signature settings updates its canonical signal.
      await c.page.evaluate(async()=>{const state=await import('/src/state/signatures.js');await state.saveSignatures({...state.signatures.value,items:state.signatures.value.items.map(item=>({...item,name:'바뀐 서명',html:'<p>바뀐 본문</p>'}))});});
      await warm(c);await c.page.locator('.compose-btn').click();const body=c.page.frameLocator('iframe.compose-editor').locator('body');await expect(body).toContainText('바뀐 본문');await expect(c.page.getByRole('button',{name:'보낸 사람 선택'})).toContainText('새 표시 이름');
      await c.page.getByRole('button',{name:'보낸 사람 선택'}).click();await c.page.getByRole('option').filter({hasText:'alias@other.example'}).click();await c.page.getByRole('button',{name:'서명: 없음',exact:true}).click();await c.page.getByRole('menuitemradio',{name:'바뀐 서명',exact:true}).click();
      await body.evaluate(node=>{const p=node.ownerDocument.createElement('p');p.textContent='사용자가 쓴 본문';node.prepend(p);node.dispatchEvent(new Event('input',{bubbles:true}));});
      const beforeFocus=c.identityCount();await c.page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await expect.poll(()=>c.identityCount()).toBeGreaterThan(beforeFocus);await expect(c.page.getByRole('button',{name:'보낸 사람 선택'})).toContainText('alias@other.example');await expect(body).toContainText('사용자가 쓴 본문');await expect(body).toContainText('바뀐 본문');await expect(c.page.getByRole('button',{name:'서명: 바뀐 서명',exact:true})).toBeVisible();
    }finally{await c.page.close();}
  });
  for(const width of [1280,768,375])await t.test(`warm composer capture at ${width}`,async()=>{
    const c=await open({width});try{await warm(c);if(width<700)await c.page.getByRole('button',{name:'메일함 열기',exact:true}).click();await c.page.locator('.compose-btn').click();await expect(c.page.frameLocator('iframe.compose-editor').locator('body')).toHaveAttribute('contenteditable','true');assert.equal(await c.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(width<700){await expect(c.page.getByRole('button',{name:'메일함 열기',exact:true})).toHaveAttribute('aria-expanded','false');await expect.poll(()=>c.page.locator('#mail-sidebar').evaluate(node=>node.getBoundingClientRect().right)).toBeLessThanOrEqual(0);}await c.page.screenshot({path:`${captures}/compose-${width}.png`,fullPage:true});}finally{await c.page.close();}
  });
});


await test('real authentication cookies and cross-tab composition ownership',async t=>{
  const temp=await mkdtemp(join(tmpdir(),'compose-auth-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const backend=Fastify({logger:false});installErrors(backend);backend.decorate('directory',{mailboxName:async email=>email});
  await installAuth(backend,{config:{publicHostnames:['127.0.0.1'],sessionIdleMin:480,sessionMaxHours:24},tempRoot:temp,verifyLogin:async()=>({connection:{logout:async()=>{}}})});
  let sessionGate,sessionReads=0,delayed,draftSaves=0,nativeEvents=false,streams=[],sseAuthFailures=0;
  async function late(req,reply,kind){const entry=delayed;if(entry?.kind!==kind||entry.started)return false;entry.started=true;await entry.gate;if(req.session.connection===null){reply.code(403).send({error:{code:'SESSION_EXPIRED',message:'synthetic old credential lifetime'}});return true;}return false;}
  const snapshot=email=>({revision:'r-'+email,items:[{id:sig,name:'합성 서명',html:`<p>${email} 비공개 서명</p>`}],defaults:{[email]:{newDefault:sig,replyDefault:sig}},usedBytes:128,maxBytes:262144,notices:[]});
  backend.get('/api/compose/identities',async req=>({identities:[{address:req.session.email,name:req.session.email,kind:'self'}],defaultFrom:req.session.email,anyAtDomains:[],anyAddress:false}));
  backend.get('/api/signatures',async(req,reply)=>{if(await late(req,reply,'signature'))return;return snapshot(req.session.email);});
  backend.post('/api/signatures/normalize',async req=>({html:req.body.html}));
  backend.get('/api/signature-images',async()=>({revision:'i1',images:[],usedBytes:0,maxBytes:1048576,maxFileBytes:204800,maxCount:20}));
  backend.post('/api/drafts',async()=>({draftRef:'synthetic'}));
  backend.put('/api/drafts',async(req,reply)=>{if(await late(req,reply,'draft'))return;draftSaves++;return {draftRef:'synthetic'};});
  backend.get('/api/signature-images/:id/content',async(req,reply)=>{if(await late(req,reply,'image'))return;return reply.type('image/png').send(bytes);});
  await backend.ready();t.after(()=>backend.close());
  const fake=createFakeApi({authenticated:true});t.after(()=>fake.close());
  const paths=new Set(['/api/compose/identities','/api/signatures','/api/signatures/normalize','/api/signature-images','/api/drafts',`/api/signature-images/${asset}/content`]);
  const root=process.env.COMPOSE_AUTH_ROOT||fileURLToPath(new URL('../../web',import.meta.url));
  const server=await createServer({configFile:false,root,logLevel:'error',plugins:[preact(),{name:'compose-real-auth',configureServer(server){server.middlewares.use(async(req,res,next)=>{
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    if(path==='/api/events'&&nativeEvents){
      let owner;try{const raw=(req.headers.cookie||'').split(';').map(item=>item.trim()).find(item=>item.startsWith('webmail_sid='))?.slice(12);owner=await backend.sessions.get(raw);}catch(error){sseAuthFailures++;res.statusCode=403;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{code:error.code,message:error.message}}));return;}
      res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-store');res.write('retry: 20\n\n');streams.push({res,owner});return;
    }
    if(!path.startsWith('/api/auth/')&&!paths.has(path))return next();
    if(path==='/api/auth/session'){sessionReads++;if(sessionGate)await sessionGate;}
    const raw=[];for await(const chunk of req)raw.push(chunk);const body=Buffer.concat(raw),headers={...req.headers};delete headers.host;delete headers['content-length'];if(headers.origin)headers.origin='https://127.0.0.1';
    const response=await backend.inject({method:req.method,url:req.url,headers,...(body.length?{payload:body}:{})});
    res.statusCode=response.statusCode;for(const [key,value] of Object.entries(response.headers)){if(key==='set-cookie')res.setHeader(key,Array.isArray(value)?value.map(item=>item.replace(/; Secure/gi,'')):value.replace(/; Secure/gi,''));else if(!['content-length','connection','transfer-encoding'].includes(key))res.setHeader(key,value);}res.end(response.rawPayload);
  });server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0,hmr:false}});
  await server.listen();t.after(()=>{for(const stream of streams)stream.res.destroy();return server.close();});
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});t.after(()=>browser.close());
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  const login=async(page,email)=>{await page.getByLabel('메일 주소',{exact:true}).fill(email);await page.getByLabel('암호',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'로그인',exact:true}).click();await expect(page.locator('.compose-btn')).toBeVisible();};
  async function openPair(fallback=false){
    const context=await browser.newContext();await context.addInitScript(()=>{const Native=window.EventSource;window.testStreams=[];window.EventSource=class extends Native{constructor(...args){super(...args);window.testStreams.push(this);}};});if(fallback)await context.addInitScript(()=>{window.BroadcastChannel=undefined;});
    const page=await context.newPage();page.setDefaultTimeout(8000);await page.goto(origin);await login(page,'a@example.com');
    await page.locator('.compose-btn').click();const body=page.frameLocator('iframe.compose-editor').locator('body');await expect(body).toContainText('a@example.com 비공개 서명');
    const tab=await context.newPage();tab.setDefaultTimeout(8000);await tab.goto(origin);await expect(tab.locator('.compose-btn')).toBeVisible();
    return {context,page,tab,body};
  }
  for(const fallback of [false,true])await t.test(`other-tab logout/login invalidates immediately (${fallback?'storage':'BroadcastChannel'})`,async()=>{
    const c=await openPair(fallback);let release;
    try{
      await c.page.getByRole('button',{name:'쓰기 창 닫기',exact:true}).click();
      await c.tab.evaluate(async()=>{await(await import('/src/api.js')).logout();});
      sessionGate=new Promise(resolve=>release=resolve);
      await login(c.tab,'b@example.com');
      await expect.poll(()=>c.page.evaluate(async()=>({identities:(await import('/src/state/compose-resources.js')).composeIdentities.value,signatures:(await import('/src/state/signatures.js')).signatures.value}))).toEqual({identities:null,signatures:null});
      release();sessionGate=null;
      await expect.poll(()=>c.page.evaluate(async()=>(await import('/src/state/session.js')).session.value?.user.email)).toBe('b@example.com');
      await expect(c.page.locator('.compose-btn')).toBeVisible();await c.page.bringToFront();await c.page.locator('.compose-btn').click();
      await expect(c.body).toContainText('b@example.com 비공개 서명');await expect(c.body).not.toContainText('a@example.com');await expect(c.page.getByRole('button',{name:'보낸 사람 선택'})).toContainText('b@example.com');
      await mkdir(captures,{recursive:true});await c.page.screenshot({path:`${captures}/cross-tab-${fallback?'storage':'channel'}.png`});
    }finally{release?.();sessionGate=null;await c.context.close();}
  });
  await t.test('focus verifies a missed cookie change before composition; open-window transition notice contains no old account',async()=>{
    const c=await openPair();try{
      // An HTTP client changes the real cookie without publishing an application event.
      await c.context.request.post(origin+'/api/auth/login',{data:{email:'b@example.com',password:'synthetic-password'},headers:{origin:'https://127.0.0.1'}});
      await c.page.evaluate(()=>{window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));});
      try {await expect(c.page.locator('.toast')).toContainText('다른 탭에서 계정이 바뀌어 작성 중이던 창을 닫았어요. 마지막 자동 저장본은 이전 계정의 임시보관함에 있어요.');} catch(error) {console.log('FOCUS_TRANSITION',await c.page.evaluate(async()=>({owner:(await import('/src/state/session.js')).session.value?.user.email,toast:(await import('/src/state/toast.js')).toast.value,composer:Boolean(document.querySelector('.composer'))})));throw error;}
      await expect(c.page.locator('.toast')).not.toContainText('a@example.com');await expect(c.page.locator('.composer')).toHaveCount(0);
      await c.page.locator('.compose-btn').click();await expect(c.body).toContainText('b@example.com 비공개 서명');await expect(c.body).not.toContainText('a@example.com');
      await c.page.screenshot({path:`${captures}/cross-tab-notice.png`});
    }finally{await c.context.close();}
  });
  await t.test('same-account focus and relogin preserve object and editor; paired focus/visibility has one in-flight check',async()=>{
    const c=await openPair();let release;
    try{
      await c.page.bringToFront();await expect(c.body).toContainText('a@example.com');
      await c.body.evaluate(node=>{node.prepend(node.ownerDocument.createTextNode('작성 중 본문 '));node.dispatchEvent(new Event('input',{bubbles:true}));});
      await c.page.evaluate(async()=>{window.previousOwner=(await import('/src/state/session.js')).session.value;await(await import('/src/api.js')).checkServerSession();});
      const loggedIn=await c.tab.evaluate(async()=>(await import('/src/api.js')).api('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'synthetic-password'}}));
      await expect.poll(()=>c.page.evaluate(async()=>(await import('/src/state/session.js')).session.value?.csrf)).toBe(loggedIn.csrf);
      await expect.poll(()=>c.page.evaluate(async()=>{const state=await import('/src/state/session.js');return state.verifiedSession.value===state.session.value;})).toBe(true);
      const before=sessionReads;sessionGate=new Promise(resolve=>release=resolve);
      await c.page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
      await expect.poll(()=>sessionReads-before).toBe(1);
      await c.page.evaluate(async()=>{window.checkComplete=(await import('/src/api.js')).checkServerSession();});
      release();sessionGate=null;await c.page.evaluate(()=>window.checkComplete);
      assert.equal(sessionReads-before,1);assert.equal(await c.page.evaluate(async()=>(await import('/src/state/session.js')).session.value===window.previousOwner),true);
      await expect(c.body).toContainText('작성 중 본문');await expect(c.body).toContainText('a@example.com 비공개 서명');await expect(c.page.locator('.toast')).toHaveCount(0);
    }finally{release?.();sessionGate=null;await c.context.close();}
  });
  for(const kind of ['signature','image','draft'])await t.test(`same-account relogin keeps editor after late old-session ${kind} failure`,async()=>{
    const c=await openPair();let release;
    try{
      const entry={kind,gate:new Promise(resolve=>release=resolve),started:false};delayed=entry;
      if(kind==='draft')await c.body.evaluate(node=>{node.prepend(node.ownerDocument.createTextNode('이전 저장 요청 '));node.dispatchEvent(new Event('input',{bubbles:true}));});
      else await c.page.evaluate(async kind=>{window.lateResult=null;window.oldRequest=(kind==='signature'?(await import('/src/state/signatures.js')).loadSignatures():(await import('/src/signature-images.js')).getSignatureImageContent('A'.repeat(32))).catch(error=>{window.lateResult=error.code;});},kind);
      await expect.poll(()=>entry.started,{timeout:7000}).toBe(true);
      const auth=await c.tab.evaluate(async()=>(await import('/src/api.js')).api('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'synthetic-password'}}));
      await expect.poll(()=>c.page.evaluate(async()=>(await import('/src/state/session.js')).session.value?.csrf)).toBe(auth.csrf);
      await c.body.evaluate(node=>{node.prepend(node.ownerDocument.createTextNode('새 세션의 저장 전 본문 '));node.dispatchEvent(new Event('input',{bubbles:true}));});
      const successBefore=draftSaves;
      const response=c.page.waitForResponse(response=>response.status()===403&&response.url().includes(kind==='draft'?'/api/drafts':kind==='signature'?'/api/signatures':'/content'));
      release();delayed=null;await response;
      if(kind!=='draft')await c.page.evaluate(()=>window.oldRequest);
      else await expect(c.page.locator('.c-head .saved')).not.toContainText('임시 저장 중');
      assert.equal(await c.page.evaluate(async()=>(await import('/src/state/session.js')).session.value?.user.email),'a@example.com');
      await expect(c.body).toContainText('새 세션의 저장 전 본문');await expect(c.page.locator('#login-email')).toHaveCount(0);
      await mkdir(captures,{recursive:true});await c.page.screenshot({path:`${captures}/late-${kind}.png`});
      if(kind==='draft'){await expect.poll(()=>draftSaves,{timeout:7000}).toBeGreaterThan(successBefore);await expect(c.page.locator('.c-head .saved')).toContainText('임시 저장됨');}
    }finally{release?.();delayed=null;await c.context.close();}
  });
  await t.test('late A autosave error preserves B editor and its next successful save',async()=>{
    const c=await openPair();let release;
    try{
      const entry={kind:'draft',gate:new Promise(resolve=>release=resolve),started:false};delayed=entry;
      await c.body.evaluate(node=>{node.prepend(node.ownerDocument.createTextNode('A 저장 중 '));node.dispatchEvent(new Event('input',{bubbles:true}));});
      await expect.poll(()=>entry.started,{timeout:7000}).toBe(true);
      await c.context.request.post(origin+'/api/auth/login',{data:{email:'b@example.com',password:'synthetic-password'},headers:{origin:'https://127.0.0.1'}});
      await c.page.evaluate(()=>{window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));});
      await expect.poll(()=>c.page.evaluate(async()=>(await import('/src/state/session.js')).session.value?.user.email)).toBe('b@example.com');
      await expect(c.page.locator('.compose-btn')).toBeVisible();await c.page.locator('.compose-btn').click();await expect(c.body).toContainText('b@example.com 비공개 서명');
      await c.body.evaluate(node=>{node.prepend(node.ownerDocument.createTextNode('B 저장 전 중요한 본문 '));node.dispatchEvent(new Event('input',{bubbles:true}));});
      const successBefore=draftSaves,response=c.page.waitForResponse(response=>response.status()===403&&response.url().includes('/api/drafts'));
      release();delayed=null;await response;
      await expect.poll(()=>c.page.evaluate(async()=>(await import('/src/state/session.js')).session.value?.user.email)).toBe('b@example.com');await expect(c.body).toContainText('B 저장 전 중요한 본문');
      await expect.poll(()=>draftSaves,{timeout:7000}).toBeGreaterThan(successBefore);await expect(c.page.locator('.c-head .saved')).toContainText('임시 저장됨');
      await c.page.screenshot({path:`${captures}/late-draft-account-switch.png`});
    }finally{release?.();delayed=null;await c.context.close();}
  });
  await t.test('late SSE expiry reconnects after relogin without closing the editor; fresh expiry logs out',async()=>{
    const c=await openPair();try{
      await c.page.evaluate(()=>{window.oldStream=window.testStreams.at(-1);window.streamCount=window.testStreams.length;});
      const auth=await c.tab.evaluate(async()=>(await import('/src/api.js')).api('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'synthetic-password'}}));
      await expect.poll(()=>c.page.evaluate(async()=>(await import('/src/state/session.js')).session.value?.csrf)).toBe(auth.csrf);
      await c.body.evaluate(node=>{node.prepend(node.ownerDocument.createTextNode('SSE 이후 유지할 본문 '));node.dispatchEvent(new Event('input',{bubbles:true}));});
      await expect.poll(()=>c.page.evaluate(()=>window.oldStream.readyState)).toBe(1);
      await c.page.evaluate(()=>window.oldStream.dispatchEvent(new MessageEvent('session',{data:JSON.stringify({state:'expired'})})));
      await expect.poll(()=>c.page.evaluate(()=>window.testStreams.length-window.streamCount)).toBe(1);await expect(c.body).toContainText('SSE 이후 유지할 본문');
      await c.page.screenshot({path:`${captures}/late-sse.png`});
      await c.context.request.post(origin+'/api/auth/logout',{headers:{origin:'https://127.0.0.1','x-webmail-csrf':auth.csrf}});
      await c.page.evaluate(()=>window.testStreams.at(-1).dispatchEvent(new MessageEvent('session',{data:JSON.stringify({state:'expired'})})));
      await expect(c.page.locator('#login-email')).toBeVisible();await expect(c.page.locator('.composer')).toHaveCount(0);
    }finally{await c.context.close();}
  });
  for(const fallback of [false,true]) await t.test(`old auth failure between external notification and session verification (${fallback?'storage':'BroadcastChannel'})`,async()=>{
    const c=await openPair(fallback);let releaseOld,releaseCheck;
    try{
      const entry={kind:'signature',gate:new Promise(r=>releaseOld=r),started:false};delayed=entry;
      await c.page.evaluate(async()=>{window.oldRequest=(await import('/src/signatures.js')).getSignatures().catch(e=>({code:e.code}));});
      await expect.poll(()=>entry.started).toBe(true);
      const before=await c.page.evaluate(async()=>{const s=await import('/src/state/session.js');return {epoch:s.sessionResourceEpoch.value,generation:s.authGeneration};});
      sessionGate=new Promise(r=>releaseCheck=r);
      await c.tab.evaluate(async()=>(await import('/src/api.js')).api('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'synthetic-password'}}));
      await expect.poll(()=>c.page.evaluate(async()=>(await import('/src/state/session.js')).sessionResourceEpoch.value)).toBeGreaterThan(before.epoch);
      await c.page.evaluate(async()=>{window.pendingVerification=(await import('/src/api.js')).checkServerSession().catch(e=>({code:e.code}));});const notified=await c.page.evaluate(async()=>{const s=await import('/src/state/session.js');return {epoch:s.sessionResourceEpoch.value,generation:s.authGeneration,verified:s.verifiedSession.value!==null};});
      await c.body.evaluate(node=>{node.prepend(node.ownerDocument.createTextNode('재확인 중 보존해야 할 본문 '));node.dispatchEvent(new Event('input',{bubbles:true}));});
      releaseOld();delayed=null;await c.page.evaluate(()=>window.oldRequest);await c.page.waitForTimeout(100);
      const afterError=await c.page.evaluate(async()=>{const s=await import('/src/state/session.js');return {owner:s.session.value?.user.email||null,composer:Boolean(document.querySelector('.composer')),generation:s.authGeneration};});
      releaseCheck();sessionGate=null;await c.page.evaluate(()=>window.pendingVerification);
      const afterCheck=await c.page.evaluate(async()=>{const s=await import('/src/state/session.js');return {owner:s.session.value?.user.email||null,composer:Boolean(document.querySelector('.composer')),serverOwner:(await(await fetch('/api/auth/session')).json()).user?.email};});
      const result={mode:fallback?'storage':'BroadcastChannel',before,notified,afterError,afterCheck};console.log('PREVERIFY '+JSON.stringify(result));
      await mkdir(captures,{recursive:true});await writeFile(captures+'/preverify-'+(fallback?'storage':'channel')+'.json',JSON.stringify(result,null,2));await c.page.screenshot({path:captures+'/preverify-'+(fallback?'storage':'channel')+'.png'});
      assert.equal(afterError.owner,'a@example.com');await expect(c.body).toContainText('재확인 중 보존해야 할 본문');
    }finally{releaseOld?.();releaseCheck?.();delayed=null;sessionGate=null;await c.context.close();}
  });
  await t.test('native EventSource reconnect uses fresh cookies; expiry of that current session must log out',async()=>{
    nativeEvents=true;streams=[];sseAuthFailures=0;
    const previousMail=fake.state.mail;fake.state.mail=previousMail.map(item=>({...item,subject:'A 전용 목록 '+item.ref}));
    const c=await openPair();try{
      await expect.poll(()=>streams.length).toBe(2);
      const pageStream=streams.find(item=>item.owner.email==='a@example.com');
      await expect.poll(()=>c.page.evaluate(async()=>(await import('/src/state/list.js')).list.value.items.length)).toBeGreaterThan(0);
      assert.equal(await c.page.evaluate(async()=>(await import('/src/state/list.js')).list.value.items.every(item=>item.subject.startsWith('A 전용 목록 '))),true);
      const nativeCount=await c.page.evaluate(()=>window.testStreams.length);
      const auth=await c.tab.evaluate(async()=>(await import('/src/api.js')).api('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'synthetic-password'}}));
      await expect.poll(()=>c.page.evaluate(async()=>(await import('/src/state/session.js')).session.value?.csrf)).toBe(auth.csrf);
      await c.page.bringToFront();await c.page.evaluate(async()=>{await(await import('/src/api.js')).checkServerSession();});const generation=await c.page.evaluate(async()=>(await import('/src/state/session.js')).authGeneration);
      pageStream.res.destroy();
      await expect.poll(()=>streams.length,{timeout:5000}).toBe(3);
      assert.equal(await c.page.evaluate(()=>window.testStreams.length),nativeCount,'native reconnect retains its JavaScript EventSource object');
      const current=streams.at(-1);assert.notEqual(current.owner,pageStream.owner);assert.equal(current.owner.csrf,auth.csrf);
      await backend.sessions.destroy(current.owner,'SESSION_EXPIRED');
      assert.equal(current.owner.connection,null);
      current.res.write('event: session\ndata: {"state":"expired"}\n\n');current.res.end();
      if(process.env.COMPOSE_AUTH_ROOT){await expect.poll(()=>sseAuthFailures).toBeGreaterThan(0);}else{await expect.poll(()=>c.page.evaluate(async()=>(await import('/src/state/session.js')).session.value)).toBe(null);}await c.page.waitForTimeout(150);
      const result=await c.page.evaluate(async()=>{const s=await import('/src/state/session.js');return {owner:s.session.value?.user.email||null,ready:s.sessionReady.value,composer:Boolean(document.querySelector('.composer')),nativeStreams:window.testStreams.length,states:window.testStreams.map(x=>x.readyState),generation:s.authGeneration};});
      result.baseline=Boolean(process.env.COMPOSE_AUTH_ROOT);result.generationAfterRelogin=generation;result.serverSessionConnection=current.owner.connection;result.sseAuthFailures=sseAuthFailures;
      console.log('NATIVE_SSE '+JSON.stringify(result));await mkdir(captures,{recursive:true});await writeFile(captures+'/'+(process.env.COMPOSE_AUTH_ROOT?'baseline-':'')+'native-sse.json',JSON.stringify(result,null,2));await c.page.screenshot({path:captures+'/'+(process.env.COMPOSE_AUTH_ROOT?'baseline-':'')+'native-sse.png'});
      assert.equal(result.owner,null);await expect(c.page.locator('.composer')).toHaveCount(0);
      if(!process.env.COMPOSE_AUTH_ROOT){
        await expect(c.page.getByRole('status')).toContainText('로그인이 만료됐어요. 다시 로그인해 주세요.');
        assert.equal(await c.page.evaluate(async()=>(await import('/src/state/list.js')).list.value.items.length),0);
        fake.state.mail=previousMail.map(item=>({...item,subject:'B 전용 목록 '+item.ref}));
        await login(c.page,'b@example.com');
        await expect.poll(()=>c.page.evaluate(async()=>(await import('/src/state/list.js')).list.value.items.length)).toBeGreaterThan(0);
        assert.equal(await c.page.evaluate(async()=>(await import('/src/state/list.js')).list.value.items.every(item=>item.subject.startsWith('B 전용 목록 '))),true);
      }
    }finally{await c.context.close();nativeEvents=false;fake.state.mail=previousMail;}
  });
});
