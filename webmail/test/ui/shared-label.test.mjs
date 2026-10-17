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
      await expect(shared).toBeVisible();await expect(shared).toHaveText(owner);await expect(shared).toHaveAttribute('title',owner);
      const child=page.locator(`.nav a[href="#f/${encodeURIComponent(path+'/처리 완료')}"]`);
      await expect(child).toHaveText(`${owner} · 받은편지함 / 처리 완료`);
      await expect(child).toHaveAttribute('title',`${owner} · 받은편지함 / 처리 완료`);
      assert.equal(await child.locator('span').nth(1).evaluate(el=>getComputedStyle(el).textOverflow),'ellipsis');
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
