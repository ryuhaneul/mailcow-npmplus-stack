import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi, mailContrastFixtures } from '../../web/dev/fake-api.js';
import { WM_C as C } from '../../web/src/theme/contrast.js';
import { WM_THEME_ORDER } from '../../web/src/theme/themes.js';

await test('HTML mail dark contrast and per-message original colors',async t=>{
  const fake=createFakeApi({authenticated:true,contrastMessages:true});
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'mail-contrast-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
  await server.listen();t.after(()=>server.close());t.after(()=>fake.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  const captures=process.env.MAIL_CONTRAST_CAPTURE_DIR;
  if(captures)await mkdir(captures,{recursive:true});
  const fixtures=mailContrastFixtures.map(fixture=>fake.state.mail.find(item=>item.subject===fixture.subject));
  const measurements=[];
  const errors=[];
  async function open(index=0,mode='dark',theme='ink',width=1280){
    fake.state.prefs={...fake.state.prefs,mode,theme};
    const page=await browser.newPage({viewport:{width,height:900}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(({theme,mode})=>localStorage.setItem('webmail-prefs',JSON.stringify({theme,mode})),{theme,mode});
    await page.goto(`${origin}/#read/${encodeURIComponent(fixtures[index].ref)}`);
    await expect(page.locator('.reader h1')).toHaveText(fixtures[index].subject);
    await expect(page.frameLocator('.message-frame').locator('body')).toContainText(index===0?'이메일 주소 인증':index===1?'흰 표':'잘 보이는');
    return page;
  }
  function body(page){return page.frameLocator('.message-frame').locator('body');}
  async function colors(page,selector='p'){
    return body(page).evaluate((body,selector)=>{
      const view=body.ownerDocument.defaultView,element=body.querySelector(selector);
      return {color:view.getComputedStyle(element).color,background:view.getComputedStyle(body).backgroundColor,scheme:view.getComputedStyle(body.ownerDocument.documentElement).colorScheme,inline:element.getAttribute('style'),height:body.getBoundingClientRect().height};
    },selector);
  }
  const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
  await t.test('five dark themes brighten sender text and links to 7 without altering source data',async()=>{
    for(const theme of WM_THEME_ORDER){
      const page=await open(0,'dark',theme);
      try{
        await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toBeVisible();
        const text=await colors(page),link=await colors(page,'a');
        assert.notEqual(text.color,'rgb(32, 33, 36)');
        const ratio=C.ratio(rgb(text.color),rgb(text.background)),linkRatio=C.ratio(rgb(link.color),rgb(link.background));
        assert.ok(ratio>=7,`${theme}: ${ratio}`);assert.ok(linkRatio>=7,`${theme} link: ${linkRatio}`);
        assert.equal(text.scheme,'dark');
        measurements.push({theme,ratio,linkRatio,color:text.color,background:text.background});
        assert.equal(fixtures[0].readerHtml,mailContrastFixtures[0].readerHtml);
        await expect.poll(async()=>Number.parseFloat(await page.locator('.message-frame').evaluate(frame=>frame.style.height))).toBeGreaterThanOrEqual(Math.ceil(text.height));
        if(captures&&theme==='ink')await page.screenshot({path:`${captures}/dark-auto-1280.png`});
      }finally{await page.close();}
    }
  });
  await t.test('original colors use a white light document and adjustment can be restored',async()=>{
    const page=await open();try{
      await page.locator('.message-frame').evaluate(frame=>window._originalDocument=frame.contentDocument);
      await page.getByRole('button',{name:'원래 색으로 보기',exact:true}).click();
      assert.equal(await page.evaluate(()=>window._originalDocument.querySelector('a').style.getPropertyPriority('color')),'');
      await expect.poll(async()=>(await colors(page)).background).toBe('rgb(255, 255, 255)');
      assert.equal((await colors(page)).color,'rgb(32, 33, 36)');assert.equal((await colors(page)).scheme,'light');
      const box=page.locator('.body > div');
      await expect(box).toHaveCSS('padding','18px');
      await expect(box).toHaveCSS('background-color','rgb(255, 255, 255)');
      assert.equal(await box.evaluate(element=>getComputedStyle(element).borderRadius),await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--r-card').trim()));
      assert.equal(Math.round((await box.boundingBox()).width),Math.round((await page.locator('.imgblock').boundingBox()).width));
      if(captures)await page.screenshot({path:`${captures}/dark-original-1280.png`});
      await page.getByRole('button',{name:'어둡게 맞추기',exact:true}).click();
      await expect.poll(async()=>(await colors(page)).color).not.toBe('rgb(32, 33, 36)');
      const text=await colors(page);assert.ok(C.ratio(rgb(text.color),rgb(text.background))>=7);
      assert.equal(fake.state.requests.filter(request=>request.path==='/api/prefs'&&request.method==='PUT').length,0);
    }finally{await page.close();}
  });
  await t.test('white table and already readable mail stay unchanged with no toggle',async()=>{
    for(const index of [1,2]){
      const page=await open(index);try{
        const selector=index===1?'td':'p';
        await expect(body(page).locator(selector)).toHaveCSS('color',index===1?'rgb(32, 33, 36)':'rgb(255, 255, 255)');
        assert.equal((await colors(page,selector)).inline.includes('!important'),false);
        await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toHaveCount(0);
        if(index===1)await expect(body(page).locator('table')).toHaveCSS('background-color','rgb(255, 255, 255)');
      }finally{await page.close();}
    }
  });
  await t.test('light mode preserves all three fixture colors and hides the toggle',async()=>{
    for(const index of [0,1,2]){
      const page=await open(index,'light');try{
        await expect(body(page).locator(index===1?'td':'p').first()).toHaveCSS('color',index===2?'rgb(255, 255, 255)':'rgb(32, 33, 36)');
        await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toHaveCount(0);
        assert.equal((await colors(page,index===1?'td':'p')).inline?.includes('!important')||false,false);
        if(captures&&index===0)await page.screenshot({path:`${captures}/light-1280.png`});
      }finally{await page.close();}
    }
  });
  await t.test('leaving a message resets original view and live appearance changes update the iframe',async()=>{
    const page=await open();try{
      await page.getByRole('button',{name:'원래 색으로 보기',exact:true}).click();
      await page.evaluate(ref=>location.hash=`read/${encodeURIComponent(ref)}`,fixtures[1].ref);
      await expect(page.locator('.reader h1')).toHaveText(fixtures[1].subject);
      await page.evaluate(ref=>location.hash=`read/${encodeURIComponent(ref)}`,fixtures[0].ref);
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toBeVisible();
      await expect.poll(async()=>(await colors(page)).scheme).toBe('dark');
      await page.evaluate(async()=>{const {prefs}=await import('/src/state/prefs.js');prefs.value={...prefs.value,mode:'light'};});
      await expect.poll(async()=>(await colors(page)).scheme).toBe('light');
      await expect(body(page).locator('p').first()).toHaveCSS('color','rgb(32, 33, 36)');
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toHaveCount(0);
      await page.evaluate(async()=>{const {prefs}=await import('/src/state/prefs.js');prefs.value={...prefs.value,mode:'dark'};});
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toBeVisible();
    }finally{await page.close();}
  });
  await t.test('plain text mail keeps the existing dark rendering and has no adjustment button',async()=>{
    const page=await browser.newPage();try{
      fake.state.prefs={...fake.state.prefs,mode:'dark',theme:'ink'};
      await page.route('**/api/messages/*?images=0',async route=>{const response=await route.fetch();const message=await response.json();await route.fulfill({response,json:{...message,html:null,text:'plain text unchanged'}});});
      await page.goto(`${origin}/#read/${encodeURIComponent(fixtures[0].ref)}`);
      await expect(body(page).locator('pre')).toHaveText('plain text unchanged');
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toHaveCount(0);
      assert.equal(await body(page).locator('pre').getAttribute('style'),null);
    }finally{await page.close();}
  });
  await t.test('unsupported Color 4 foregrounds remain unchanged without exceptions or a toggle',async()=>{
    for(const color of ['lab(40% 10 10)','oklch(40% .1 30)','color(srgb .2 .3 .4)']){
      fake.state.readerHtml=`<p style="color:${color}">이메일 주소 인증</p>`;
      const page=await open();try{
        const text=body(page).locator('p');
        assert.equal(await text.evaluate(element=>element.style.color),await text.evaluate(element=>element.ownerDocument.defaultView.getComputedStyle(element).color));
        assert.equal(await text.evaluate(element=>element.style.getPropertyPriority('color')),'');
        assert.ok((await text.getAttribute('style')).includes(color.split('(')[0]+'('));
        await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toHaveCount(0);
      }finally{await page.close();delete fake.state.readerHtml;}
    }
  });
  await t.test('unknown Color 4 or image backgrounds keep black text and inherited descendants unchanged',async()=>{
    for(const html of [
      '<p style="color:#202124;background:color(srgb 1 1 1);padding:20px">이메일 주소 인증 EVAL black on white Color4</p>',
      '<div style="background:color(srgb 1 1 1)"><p style="color:#202124">이메일 주소 인증 inherited Color4</p></div>',
      '<div style="background-image:linear-gradient(white,white)"><p style="color:#202124">이메일 주소 인증 image background</p></div>',
    ]){
      fake.state.readerHtml=html;
      const page=await open();try{
        await expect(body(page).locator('p')).toHaveCSS('color','rgb(32, 33, 36)');
        assert.equal(await body(page).locator('p').evaluate(element=>element.style.getPropertyPriority('color')),'');
        assert.ok(C.ratio([32,33,36],[255,255,255])>=4.5);
        await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toHaveCount(0);
      }finally{await page.close();delete fake.state.readerHtml;}
    }
  });
  await t.test('responsive mail backgrounds restore source colors and reapply only after widening',async()=>{
    fake.state.readerHtml='<style>@media(max-width:600px){p{background:#ffffff;color:#202124}}</style><p style="color:#202124">이메일 주소 인증 EVAL responsive background</p>';
    const page=await open();try{
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toBeVisible();
      await page.locator('.message-frame').evaluate(frame=>frame._sameDocument=frame.contentDocument);
      await page.setViewportSize({width:375,height:900});
      await expect(body(page).locator('p')).toHaveCSS('background-color','rgb(255, 255, 255)');
      await expect(body(page).locator('p')).toHaveCSS('color','rgb(32, 33, 36)');
      assert.equal(await body(page).locator('p').evaluate(element=>element.style.getPropertyPriority('color')),'');
      assert.ok(C.ratio(rgb((await colors(page)).color),[255,255,255])>=4.5);
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toHaveCount(0);
      await page.setViewportSize({width:1280,height:900});
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toBeVisible();
      const text=await colors(page);assert.ok(C.ratio(rgb(text.color),rgb(text.background))>=7);
      assert.equal(await page.locator('.message-frame').evaluate(frame=>frame.contentDocument===frame._sameDocument),true);
      await expect.poll(async()=>Number.parseFloat(await page.locator('.message-frame').evaluate(frame=>frame.style.height))).toBeGreaterThanOrEqual(Math.ceil(text.height));
    }finally{await page.close();delete fake.state.readerHtml;}
  });
  await t.test('print media and beforeprint/afterprint restore exact source colors then reapply',async()=>{
    fake.state.readerHtml='<style>@media print{p{background:#ffffff;color:#202124!important}}</style><p style="color:#202124">이메일 주소 인증 EVAL printable email</p>';
    const page=await open();try{
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toBeVisible();
      await body(page).evaluate(body=>body.ownerDocument.defaultView.dispatchEvent(new Event('beforeprint')));
      assert.equal(await body(page).locator('p').evaluate(element=>element.style.color),'rgb(32, 33, 36)');
      assert.equal(await body(page).locator('p').evaluate(element=>element.style.getPropertyPriority('color')),'');
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toHaveCount(0);
      await body(page).evaluate(body=>body.ownerDocument.defaultView.dispatchEvent(new Event('afterprint')));
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toBeVisible();
      await page.emulateMedia({media:'print'});
      await expect(body(page).locator('p')).toHaveCSS('background-color','rgb(255, 255, 255)');
      await expect(body(page).locator('p')).toHaveCSS('color','rgb(32, 33, 36)');
      assert.equal(await body(page).locator('p').evaluate(element=>element.style.getPropertyPriority('color')),'');
      assert.ok(C.ratio(rgb((await colors(page)).color),[255,255,255])>=4.5);
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toHaveCount(0);
      await page.emulateMedia({media:'screen'});
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toBeVisible();
      const text=await colors(page);assert.ok(C.ratio(rgb(text.color),rgb(text.background))>=7);
    }finally{await page.close();delete fake.state.readerHtml;}
  });
  await t.test('five thousand paragraphs measure contrast calculation time',async()=>{
    const page=await open();try{
      await expect(page.getByRole('button',{name:'원래 색으로 보기',exact:true})).toBeVisible();
      const result=await page.evaluate(async()=>{
        const {adjustMailContrast}=await import('/src/theme/mail-contrast.js');
        const document=window.document.querySelector('.message-frame').contentDocument;
        document.body.innerHTML='<div style="color:#202124">'+Array.from({length:5000},(_,index)=>`<p>EVAL ${index}</p>`).join('')+'</div>';
        const start=performance.now(),count=adjustMailContrast(document,[24,26,30]);
        return {paragraphs:5000,count,ms:performance.now()-start};
      });
      assert.equal(result.count,5000);t.diagnostic(`5000 paragraphs: ${result.ms.toFixed(1)}ms`);
      await page.evaluate(()=>{
        window._resizeMeasure={passes:0,records:0,startedAt:performance.now()};
        window._resizeObserver=new MutationObserver(records=>{window._resizeMeasure.passes++;window._resizeMeasure.records+=records.length;window._resizeMeasure.completedMs=performance.now()-window._resizeMeasure.startedAt;});
        window._resizeObserver.observe(document.querySelector('.message-frame').contentDocument.body,{attributes:true,attributeFilter:['style'],subtree:true});
      });
      const started=performance.now();
      for(let index=0;index<20;index++){
        await page.setViewportSize({width:1000-index*8,height:900});
        await page.waitForTimeout(35);
      }
      const eventsMs=performance.now()-started;
      await expect.poll(()=>page.evaluate(()=>window._resizeMeasure.passes)).toBe(1);
      // Leave a full debounce interval to catch any height-triggered extra pass.
      await page.waitForTimeout(200);
      const resize=await page.evaluate(()=>{window._resizeObserver.disconnect();return window._resizeMeasure;});
      resize.events=20;resize.eventsMs=eventsMs;resize.totalMs=performance.now()-started;
      assert.equal(resize.passes,1);t.diagnostic(`continuous resize: ${resize.events} events in ${resize.eventsMs.toFixed(1)}ms, ${resize.passes} pass, ${resize.totalMs.toFixed(1)}ms total`);
      if(captures)await writeFile(`${captures}/gated-performance.json`,JSON.stringify({...result,resize},null,2));
    }finally{await page.close();}
  });
  await t.test('tablet and mobile toggle stay usable without horizontal overflow',async()=>{
    for(const width of [768,375]){
      const page=await open(0,'dark','ink',width);try{
        const toggle=page.getByRole('button',{name:'원래 색으로 보기',exact:true});await expect(toggle).toBeVisible();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        if(captures)await page.screenshot({path:`${captures}/dark-auto-${width}.png`});
        await toggle.click();await expect.poll(async()=>(await colors(page)).background).toBe('rgb(255, 255, 255)');
        await page.getByRole('button',{name:'어둡게 맞추기',exact:true}).click();
        await expect.poll(async()=>(await colors(page)).color).not.toBe('rgb(32, 33, 36)');
      }finally{await page.close();}
    }
  });
  assert.deepEqual(errors,[]);
  if(captures)await writeFile(`${captures}/contrast-measurements.json`,JSON.stringify(measurements,null,2));
});
