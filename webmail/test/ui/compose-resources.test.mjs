import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
