// Written for a later browser-capable gate. Do not run on the constrained host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createFakeApi } from '../../web/dev/fake-api.js';

const captures=process.env.NOTICES_CAPTURE_DIR||'/tmp/notices-captures';
const fixtureRows=()=>Array.from({length:53},(_,index)=>{
  const id=53-index;
  return {id,seq:id,title:id===53?'11월 2일 새벽 점검':id===52?'필터에 본문 조건 추가':id===51?'필터가 맨 위 규칙 하나만 적용돼요':`합성 공지 ${id}`,
    category:id===53?'maintenance':id>50?'update':'info',pinned:id===53,publishedAt:'2026-10-27T06:40:00Z',bodyHtml:'<p>이제 새 메일 하나에는 <strong>목록 맨 위에서부터 처음 맞는 규칙 하나만</strong> 적용돼요.</p><ul><li>규칙 순서를 확인해 주세요.</li></ul><p><a href="https://docs.example.test/filters">필터 도움말</a>에서 확인할 수 있어요.</p>'};
});
await test('notices A UI: desktop popover, mobile modal, keyboard, states and pagination',async t=>{
  const fake=createFakeApi({authenticated:true});
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'notices-test-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0,hmr:false}});
  await server.listen();t.after(()=>server.close());t.after(()=>fake.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());
  await mkdir(captures,{recursive:true});
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  async function open({width=1280,mode='light',rows=fixtureRows(),enabled=true,loadFailures=0,seenFailures=0,holdLoad=false}={}) {
    const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',error=>errors.push(error.message));
    let watermark=50,releaseLoad;const gate=new Promise(resolve=>{releaseLoad=resolve;});
    const state={rows,enabled};
    await page.route('**/api/prefs',route=>route.request().method()==='GET'?route.fulfill({json:{...fake.state.prefs,mode}}):route.fulfill({status:204}));
    await page.route('**/api/notices**',async route=>{
      const request=route.request(),url=new URL(request.url());requests.push({path:url.pathname+url.search,method:request.method(),body:request.method()==='POST'?request.postDataJSON():undefined});
      const unreadCount=()=>state.rows.filter(row=>row.seq>watermark).length;
      const items=()=>state.rows.map(row=>({...row,unread:row.seq>watermark})).sort((a,b)=>b.seq-a.seq);
      if(url.pathname.endsWith('/unread'))return route.fulfill({json:{enabled:state.enabled,unreadCount:state.enabled?unreadCount():0}});
      if(url.pathname.endsWith('/seen')) {
        assert.equal(request.headers()['x-webmail-csrf'],fake.state.csrf);assert.equal(request.headers().authorization,undefined);
        assert.deepEqual(Object.keys(request.postDataJSON()),['upTo']);
        if(seenFailures-->0)return route.fulfill({status:503,json:{error:{code:'SYNTHETIC_FAILURE',message:'합성 읽음 실패'}}});
        watermark=Math.max(watermark,Math.min(request.postDataJSON().upTo,Math.max(0,...state.rows.map(row=>row.seq))));
        return route.fulfill({json:{unreadCount:unreadCount()}});
      }
      if(url.searchParams.get('scope')==='recent') {
        if(holdLoad)await gate;
        if(loadFailures-->0)return route.fulfill({status:503,json:{error:{code:'SYNTHETIC_FAILURE',message:'합성 조회 실패'}}});
        const all=items();return route.fulfill({json:{enabled:state.enabled,unreadCount:unreadCount(),maxSeq:Math.max(0,...all.map(row=>row.seq)),pinned:all.filter(row=>row.pinned),items:all.filter(row=>!row.pinned).slice(0,5)}});
      }
      const before=Number(url.searchParams.get('before')||Infinity),all=items().filter(row=>row.seq<before),pageItems=all.slice(0,50);
      return route.fulfill({json:{items:pageItems,nextBefore:all.length>50?pageItems.at(-1).seq:null}});
    });
    await page.goto(`${origin}/#inbox`);await expect(page.locator('.top')).toBeVisible();
    const bell=page.getByRole('button',{name:/^공지(?:, 새 공지 \d+개)?$/});
    if(enabled)await expect(bell).toBeVisible();
    return {page,context,bell,state,requests,errors,releaseLoad,close:()=>context.close()};
  }
  for(const width of [1280,768])await t.test(`${width}: nonmodal popover, title focus, native tab out, outside click and Escape restore bell`,async()=>{
    const f=await open({width});try{
      await expect(f.bell).toHaveAccessibleName('공지, 새 공지 3개');await expect(f.bell.locator('.bell-mark')).toHaveAttribute('aria-hidden','true');
      assert.equal(await f.bell.evaluate(el=>el.nextElementSibling?.getAttribute('aria-label')),width>760?'다크 모드로 전환':null);
      await f.bell.focus();await f.page.keyboard.press('Enter');const panel=f.page.getByRole('dialog',{name:'공지',exact:true});
      await expect(panel).not.toHaveAttribute('aria-modal','true');await expect(f.page.locator('#notice-title')).toBeFocused();
      await panel.evaluate(el=>Promise.race([Promise.all(el.getAnimations().map(animation=>animation.finished)),new Promise((_,reject)=>setTimeout(()=>reject(new Error('notice animation exceeded 2 seconds')),2000))]));
      assert.equal(Math.round((await panel.boundingBox()).width),384);
      await expect(f.bell).toHaveAccessibleName('공지');await expect(panel.locator('.na-item.unread')).toHaveCount(3);
      await f.page.keyboard.press('Tab');await expect(panel.locator('.na-row').first()).toBeFocused();
      await f.page.keyboard.press('Enter');await expect(panel.locator('.na-row').first()).toHaveAttribute('aria-expanded','true');
      await expect(panel.getByRole('link',{name:'필터 도움말'})).toHaveAttribute('target','_blank');await expect(panel.getByRole('link',{name:'필터 도움말'})).toHaveAttribute('rel','noopener noreferrer');
      await panel.getByRole('button',{name:'모두 보기',exact:true}).focus();await f.page.keyboard.press('Tab');
      assert.equal(await panel.evaluate(el=>el.contains(document.activeElement)),false);
      await f.page.keyboard.press('Escape');await expect(panel).toHaveCount(0);await expect(f.bell).toBeFocused();
      await f.bell.click();await f.page.locator('.search').click();await expect(panel).toHaveCount(0);await expect(f.bell).toBeFocused();
      assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  for(const width of [375,760])await t.test(`${width}: full-screen modal, inert background, Tab wrap, close focus and breakpoint transition`,async()=>{
    const f=await open({width});try{
      await f.bell.click();const panel=f.page.getByRole('dialog',{name:'공지',exact:true});
      await expect(panel).toHaveAttribute('aria-modal','true');assert.equal(await panel.evaluate(el=>el.matches(':modal')),true);
      await panel.evaluate(el=>Promise.race([Promise.all(el.getAnimations().map(animation=>animation.finished)),new Promise((_,reject)=>setTimeout(()=>reject(new Error('notice animation exceeded 2 seconds')),2000))]));
      const box=await panel.boundingBox();assert.equal(box.x,0);assert.equal(box.y,0);assert.equal(box.width,width);assert.equal(box.height,900);
      await f.page.locator('.top .me').evaluate(el=>el.focus());assert.equal(await panel.evaluate(el=>el.contains(document.activeElement)),true);
      await f.page.locator('#notice-title').focus();await f.page.keyboard.press('Shift+Tab');await expect(panel.getByRole('button',{name:'모두 보기',exact:true})).toBeFocused();
      await f.page.keyboard.press('Tab');await expect(panel.getByRole('button',{name:'닫기',exact:true})).toBeFocused();
      await f.page.keyboard.press('Escape');await expect(panel).toHaveCount(0);await expect(f.bell).toBeFocused();
      await f.bell.click();await panel.getByRole('button',{name:'닫기',exact:true}).click();await expect(f.bell).toBeFocused();
      await f.bell.click();await f.page.setViewportSize({width:1280,height:900});await expect(f.page.getByRole('dialog',{name:'공지',exact:true})).not.toHaveAttribute('aria-modal','true');
      await f.page.setViewportSize({width,height:900});assert.equal(await f.page.getByRole('dialog',{name:'공지',exact:true}).evaluate(el=>el.matches(':modal')),true);
      assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  await t.test('before pagination, no invented counts, pinned notices occur once, new marks persist until close',async()=>{
    const f=await open();try{
      await f.bell.click();const panel=f.page.getByRole('dialog',{name:'공지',exact:true});
      await expect(panel.locator('.ntc-foot')).toHaveText('모두 보기');await panel.getByRole('button',{name:'모두 보기',exact:true}).click();
      await expect(panel.locator('.na-item')).toHaveCount(50);await expect(panel.locator('.na-item[data-id="53"]')).toHaveCount(1);await expect(panel.locator('.na-item.unread')).toHaveCount(3);
      await expect(panel.locator('.ntc-foot')).toHaveText('더 보기');await panel.getByRole('button',{name:'더 보기',exact:true}).click();
      await expect(panel.locator('.na-item')).toHaveCount(53);await expect(panel.locator('.ntc-foot')).toHaveCount(0);
      assert.ok(f.requests.some(request=>request.path==='/api/notices?scope=all&before=4'));
      assert.equal(f.requests.filter(request=>request.path==='/api/notices/seen').length,1);
      await f.page.keyboard.press('Escape');await f.bell.click();await expect(panel.locator('.na-item.unread')).toHaveCount(0);
    }finally{await f.close();}
  });
  await t.test('loading three skeleton rows; error retry; empty; disabled bell; failed seen restores dot without error text',async()=>{
    let f=await open({holdLoad:true});try{
      await f.bell.click();await expect(f.page.getByRole('dialog',{name:'공지',exact:true}).getByRole('status')).toHaveText('공지 불러오는 중');await expect(f.page.locator('.ntc-skeleton')).toHaveCount(3);
      f.releaseLoad();await expect(f.page.locator('.na-item')).toHaveCount(6);
    }finally{f.releaseLoad();await f.close();}
    f=await open({loadFailures:1});try{
      await f.bell.click();await expect(f.page.getByRole('alert')).toContainText('공지를 불러오지 못했어요.');await f.page.getByRole('button',{name:'다시 시도',exact:true}).click();await expect(f.page.locator('.na-item')).toHaveCount(6);
    }finally{await f.close();}
    f=await open({rows:[]});try{
      await f.bell.click();await expect(f.page.getByText('아직 공지가 없어요',{exact:true})).toBeVisible();await expect(f.page.getByText('새 소식이 생기면 여기에서 알려 드릴게요.',{exact:true})).toBeVisible();await expect(f.page.locator('.ntc-foot')).toHaveCount(0);
    }finally{await f.close();}
    f=await open({enabled:false});try{await expect(f.page.locator('.bell')).toHaveCount(0);}finally{await f.close();}
    f=await open({seenFailures:1});try{
      await f.bell.click();await expect.poll(()=>f.requests.filter(request=>request.path==='/api/notices/seen').length).toBe(1);await expect(f.bell).toHaveAccessibleName('공지, 새 공지 3개');await expect(f.page.locator('.na-item')).toHaveCount(6);await expect(f.page.locator('.ntc-error')).toHaveCount(0);
      await f.page.keyboard.press('Escape');await f.bell.click();await expect(f.bell).toHaveAccessibleName('공지');
    }finally{await f.close();}
  });
  await t.test('HTML render repeats notice policy and keyboard inside popover does not run mailbox shortcuts',async()=>{
    const rows=fixtureRows();rows[0].bodyHtml='<p class="bad" onclick="bad()">safe<img src="https://images.example.test/tracker"></p><a href="javascript:bad()">bad link</a>';
    const f=await open({rows});try{
      await f.bell.click();const panel=f.page.getByRole('dialog',{name:'공지',exact:true});await panel.locator('.na-row').first().click();
      await expect(panel.locator('img,script,[onclick],.bad')).toHaveCount(0);await expect(panel.locator('.nbody a[href]')).toHaveCount(0);
      const hash=await f.page.evaluate(()=>location.hash);await f.page.keyboard.press('c');assert.equal(await f.page.evaluate(()=>location.hash),hash);
    }finally{await f.close();}
  });
  for(const width of [1280,768,375])for(const mode of ['light','dark'])await t.test(`capture ${width} ${mode}: tokens, expanded layout and accessibility`,async()=>{
    const f=await open({width,mode});try{
      await f.bell.click();const panel=f.page.getByRole('dialog',{name:'공지',exact:true});await panel.locator('.na-row').nth(2).click();
      await expect(f.page.locator('html')).toHaveAttribute('data-mode',mode);
      const results=await new AxeBuilder({page:f.page}).include('#notice-panel').analyze();assert.deepEqual(results.violations,[]);
      await f.page.screenshot({path:`${captures}/notices-${width}-${mode}.png`});assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
});
