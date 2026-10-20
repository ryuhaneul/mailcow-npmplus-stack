import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

await test('shared mailbox navigation and list titles identify the owner with server-shaped fixtures',async t=>{
  const fake=createFakeApi({authenticated:true});
  fake.state.prefs.sharedView['support@example.com']={mode:'all',folders:[],hidden:false};
  fake.state.folders.push({...fake.state.folders.find(folder=>folder.path==='Shared/support@example.com/INBOX'),path:'Shared/support@example.com/INBOX/처리 완료',name:'처리 완료',parent:'Shared/support@example.com/INBOX',unseen:0});
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'shared-label-test-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
  await server.listen();t.after(()=>server.close());t.after(()=>fake.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
  t.after(()=>browser.close());
  const captures=process.env.SHARED_LABEL_CAPTURE_DIR;
  if(captures)await mkdir(captures,{recursive:true});
  const owner='support@example.com',path=`Shared/${owner}/INBOX`;
  assert.equal(fake.state.folders.find(folder=>folder.path===path).name,'INBOX');
  for(const width of [1280,390,768,375]) {
    const context=await browser.newContext({viewport:{width,height:width<700?844:900},colorScheme:'light'});
    try {
      await context.addInitScript(()=>localStorage.setItem('webmail-prefs',JSON.stringify({theme:'ink',mode:'light'})));
      const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#inbox`);
      await expect(page.locator('#page-title')).toHaveText('받은편지함');
      const open=page.getByRole('button',{name:'메일함 열기'});
      if(await open.isVisible())await open.click();
      const shared=page.locator(`.nav a[href="#f/${encodeURIComponent(path)}"]`);
      await expect(shared).toBeVisible();await expect(shared.locator('.sp-ell')).toHaveText(owner);await expect(shared).toHaveAttribute('title',owner);
      const child=page.locator(`.nav a[href="#f/${encodeURIComponent(path+'/처리 완료')}"]`);
      await expect(child).toHaveText('처리 완료');
      await expect(child).toHaveAttribute('title','처리 완료');
      assert.equal(await child.locator('.sp-ell').evaluate(el=>getComputedStyle(el).textOverflow),'ellipsis');
      if(captures&&[1280,390].includes(width))await page.screenshot({animations:'disabled',path:`${captures}/inbox-light-${width}.png`});
      await shared.click();
      await expect(page.locator('#page-title')).toHaveText(owner);await expect(shared).toHaveAttribute('aria-current','page');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if(captures&&[1280,390].includes(width))await page.screenshot({animations:'disabled',path:`${captures}/shared-light-${width}.png`});
      if(await open.isVisible())await open.click();
      await child.click();await expect(page.locator('#page-title')).toHaveText(`${owner} · 받은편지함 / 처리 완료`);
      assert.deepEqual(errors,[]);
    } finally {await context.close();}
  }
});


await test('sidebar unread counts stay whole and grouped across themes and viewport sizes',async t=>{
  const fake=createFakeApi({authenticated:true});
  for(const folder of fake.state.folders){
    if(folder.path==='INBOX'||folder.path==='Shared/sales@example.com/INBOX')folder.unseen=103212;
    if(folder.path==='Shared/support@example.com/INBOX'||folder.path==='Shared/sales@example.com/견적')folder.unseen=130117;
    if(folder.path==='거래처'){folder.name='아주 긴 일반 폴더 이름으로 숫자 공간 확인';folder.unseen=999999;}
    if(folder.path==='Junk')folder.unseen=9574;
  }
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'sidebar-unread-test-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
  await server.listen();t.after(()=>server.close());t.after(()=>fake.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());
  const captures=process.env.UNREAD_CAPTURE_DIR;
  if(captures)await mkdir(captures,{recursive:true});
  for(const theme of ['seland','ink'])for(const width of [1280,390,768,375])await t.test(`${theme} ${width}`,async()=>{
    fake.state.prefs.theme=theme;fake.state.prefs.mode='light';
    const context=await browser.newContext({viewport:{width,height:900},colorScheme:'light'});
    try{
      const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/api/folders',route=>route.fulfill({json:{folders:fake.state.folders,virtualAllMail:'WebmailVirtual/AllMail'}}));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#inbox`);
      await expect(page.locator('#page-title')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
      const menu=page.getByRole('button',{name:'메일함 열기'});if(await menu.isVisible())await menu.click();
      const shared=page.locator('#sp-shared .sp-grp[data-owner="sales@example.com"] .sp-orow .n');
      await expect(shared).toBeVisible();
      await page.evaluate(()=>document.fonts.ready);
      if(captures&&theme==='seland'&&width===1280)await page.screenshot({animations:'disabled',path:`${captures}/${process.env.UNREAD_CAPTURE_LABEL||'after'}-1280.png`});
      const cases=[
        [page.locator('.nav a[href="#inbox"] .n'),'103,212'],
        [page.locator(`.nav a[href="#f/${encodeURIComponent('거래처')}"] .n`),'999,999'],
        [page.locator('.nav a[href="#spam"] .n'),'9,574'],
        [shared,'103,212'],
        [page.locator('#sp-shared .sp-grp[data-owner="support@example.com"] .sp-orow .n'),'130,117'],
        [page.locator(`.nav a[href="#f/${encodeURIComponent('Shared/sales@example.com/견적')}"] .n`),'130,117'],
      ];
      for(const [badge,number] of cases){
        await expect(badge).toHaveText(`읽지 않음 ${number}`);
        const layout=await badge.evaluate(el=>{
          const style=getComputedStyle(el),range=document.createRange();range.selectNodeContents(el.lastChild);
          const rects=[...range.getClientRects()],r=el.getBoundingClientRect(),row=el.closest('.nv').getBoundingClientRect();
          return {whiteSpace:style.whiteSpace,shrink:style.flexShrink,lines:new Set(rects.map(rect=>rect.top)).size,fits:el.scrollWidth<=el.clientWidth+1&&r.left>=row.left&&r.right<=row.right+1};
        });
        assert.deepEqual(layout,{whiteSpace:'nowrap',shrink:'0',lines:1,fits:true});
      }
      const label=page.locator(`.nav a[href="#f/${encodeURIComponent('거래처')}"] > .nv-title`);
      assert.equal(await label.evaluate(el=>getComputedStyle(el).textOverflow),'ellipsis');
      assert.equal(await label.evaluate(el=>el.scrollWidth>el.clientWidth),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  });
});
