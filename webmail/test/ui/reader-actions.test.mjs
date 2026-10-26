import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

await test('reader header tooltips, responsive layout and forwarding match the replybox',async t=>{
  const fake=createFakeApi({authenticated:true});
  const message=fake.state.mail.find(item=>item.folder==='INBOX'&&item.hasAttachment);
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'reader-actions-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
  await server.listen();t.after(()=>server.close());t.after(()=>fake.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`,captures=process.env.READER_ACTIONS_CAPTURE_DIR;
  if(captures)await mkdir(captures,{recursive:true});
  for(const mode of ['light','dark'])for(const width of [1280,768,375]){
    fake.state.prefs.mode=mode;
    const page=await browser.newPage({viewport:{width,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    try{
      await page.goto(`${origin}/#read/${encodeURIComponent(message.ref)}`);
      await expect(page.locator('.reader h1')).toHaveText(message.subject);
      await expect(page.locator('html')).toHaveAttribute('data-mode',mode);
      const reply=page.locator('.when').getByRole('button',{name:'답장',exact:true});
      const forward=page.locator('.when').getByRole('button',{name:'전달',exact:true});
      await expect(reply).toHaveAttribute('title','답장하기');await expect(forward).toHaveAttribute('title','전달하기');
      await expect(forward).toBeVisible();await page.evaluate(()=>document.fonts.ready);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.equal(await page.locator('.when').evaluate(element=>{
        const box=element.getBoundingClientRect(),sender=element.closest('.sender').getBoundingClientRect();
        const children=[...element.children].map(child=>child.getBoundingClientRect());
        const range=document.createRange();range.selectNodeContents(element.firstElementChild);
        return element.scrollWidth<=element.clientWidth+1&&box.left>=sender.left&&box.right<=sender.right+1&&new Set([...range.getClientRects()].map(rect=>rect.top)).size===1&&children.every(rect=>rect.top>=box.top&&rect.bottom<=box.bottom)&&children.every((rect,index)=>!index||rect.left>=children[index-1].right);
      }),true);
      if(captures)await page.screenshot({animations:'disabled',path:`${captures}/reader-${mode}-${width}.png`,fullPage:true});
      let previous;
      for(const trigger of [forward,page.locator('.replybox').getByRole('button',{name:'전달',exact:true})]){
        await trigger.click();
        await expect(page.locator('#compose-subject')).toHaveValue(`Fwd: ${message.subject}`);
        const body=page.frameLocator('iframe.compose-editor').locator('body');
        await expect(body.locator('blockquote')).toContainText('프로젝트 2차 시안이 나왔습니다.');
        await expect(page.getByRole('button',{name:'첨부 빼기: 프로젝트_2차시안.pdf',exact:true})).toBeVisible();
        const snapshot={subject:await page.locator('#compose-subject').inputValue(),quote:await body.locator('blockquote').innerHTML(),files:await page.locator('.drop .att').allTextContents()};
        assert.equal(snapshot.files.length,4);
        if(previous)assert.deepEqual(snapshot,previous);previous=snapshot;
        await page.getByRole('button',{name:'쓰기 창 닫기',exact:true}).click();
        await expect(page.locator('#compose-subject')).toHaveCount(0);
        await page.goto(`${origin}/#read/${encodeURIComponent(message.ref)}`);
        await expect(page.locator('.reader h1')).toHaveText(message.subject);
      }
      assert.deepEqual(errors,[]);
    }finally{await page.close();}
  }
});
