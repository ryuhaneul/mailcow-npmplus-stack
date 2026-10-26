import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

const captures=process.env.FOLDER_PIN_CAPTURE_DIR||'/tmp/folder-pin-captures';
await test('folder pin UI and sidebar regressions',async t=>{
  const fake=createFakeApi({authenticated:true}),original=structuredClone(fake.state);
  const personal=(path,unseen=0)=>({path,name:path.split('/').at(-1),parent:path.includes('/')?path.slice(0,path.lastIndexOf('/')):null,specialUse:null,shared:false,unseen,total:0,color:null,rights:{write:true,delete:true,insert:true,seen:true}});
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'folder-pin-test-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
  await server.listen();t.after(()=>server.close());t.after(()=>fake.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());
  await mkdir(captures,{recursive:true});
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  function reset({pins=[],position='mine',mode='light',missing=false}={}){
    fake.state.prefs={...structuredClone(original.prefs),pinnedFolders:pins,pinPosition:position,mode};
    if(missing){delete fake.state.prefs.pinnedFolders;delete fake.state.prefs.pinPosition;}
    fake.state.folders=[...structuredClone(original.folders),...['A','A/하위','AB'].map(path=>personal(path))];fake.state.requests=[];
  }
  async function open(width=1280,mode='light'){
    const context=await browser.newContext({viewport:{width,height:900},colorScheme:mode}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(7000);
    await page.goto(origin+'/#inbox');await expect(page.locator('#page-title')).toHaveText('받은편지함');
    await expect.poll(()=>page.evaluate(async()=>{const {sessionReady}=await import('/src/state/session.js');return sessionReady.value;})).toBe(true);
    await sidebar(page);
    return {context,page,errors,close:async()=>{assert.deepEqual(errors,[]);await context.close();}};
  }
  async function sidebar(page){const menu=page.getByRole('button',{name:'메일함 열기'});if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')!=='true')await menu.click();}
  const mine=(page,path)=>page.locator(`.folder-row:not(.pinned-row)`).filter({has:page.locator(`a[href="#f/${encodeURIComponent(path)}"]`)});
  const pinned=page=>page.locator('.pinned-row');
  const order=page=>pinned(page).evaluateAll(rows=>rows.map(row=>row.dataset.path));
  async function waitSaved(paths){await expect.poll(()=>fake.state.prefs.pinnedFolders).toEqual(paths);}
  async function manage(page,path){await sidebar(page);await mine(page,path).getByRole('button',{name:`${path.split('/').at(-1)} 폴더 관리`,exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();}

  await t.test('new fields absent on first screen; personal only, keyboard pin focus and hover tooltip',async()=>{
    reset({missing:true});const c=await open();try{
      await expect(c.page.locator('.pinned-folders')).toHaveCount(0);
      const row=mine(c.page,'A'),button=row.locator('.folder-pin');
      await row.locator('a').focus();assert.equal(await button.evaluate(el=>getComputedStyle(el).opacity),'1');
      await c.page.keyboard.press('Tab');await expect(button).toBeFocused();await expect(button.locator('.pin-tip')).toHaveText('상단 고정');
      await c.page.keyboard.press('Enter');await expect(button).toBeFocused();await expect(button).toHaveAccessibleName('A 고정 해제');await waitSaved(['A']);
      await expect(row.getByRole('img',{name:'고정됨'})).toBeVisible();
      await row.hover();await expect(button).toHaveAttribute('title','고정 해제');
      await expect(c.page.locator('#sp-shared .folder-pin')).toHaveCount(0);await expect(c.page.locator('.nav>a .folder-pin')).toHaveCount(0);
      await pinned(c.page).getByRole('button',{name:'A 고정 해제'}).click();await waitSaved([]);await expect(button).toBeFocused();
    }finally{await c.close();}
  });
  await t.test('dialog pin-only close skips PATCH, keyboard up/down, shared settings, folder color',async()=>{
    reset({pins:['A','AB']});const c=await open();try{
      await manage(c.page,'AB');await c.page.getByRole('button',{name:'위로',exact:true}).focus();await c.page.keyboard.press('Enter');await waitSaved(['AB','A']);
      await expect(c.page.getByRole('button',{name:'위로',exact:true})).toBeDisabled();await c.page.getByRole('button',{name:'아래로',exact:true}).click();await waitSaved(['A','AB']);
      await c.page.getByLabel('상단 고정',{exact:true}).uncheck();await waitSaved(['A']);
      await c.page.getByLabel('고정 폴더 위치',{exact:true}).selectOption('inbox');await c.page.getByRole('button',{name:'폴더 색 4',exact:true}).click();
      await expect.poll(()=>fake.state.prefs.folderColors.AB).toBe(3);
      await c.page.getByRole('button',{name:'이름 바꾸기',exact:true}).click();await expect(c.page.getByRole('dialog')).toHaveCount(0);
      assert.equal(fake.state.requests.some(req=>req.method==='PATCH'),false);assert.equal(fake.state.prefs.pinPosition,'inbox');await expect(mine(c.page,'AB').getByRole('button',{name:'AB 폴더 관리',exact:true})).toBeFocused();
      await expect(mine(c.page,'AB').locator('.dot')).toHaveClass('dot c3');
      assert.equal(await c.page.locator('.nav').evaluate(el=>el.firstElementChild.classList.contains('pinned-folders')),true);
    }finally{await c.close();}
  });
  await t.test('drag reorder, refresh and second context preserve pins, unread and active row',async()=>{
    reset({pins:['A','A/하위','AB']});const c=await open();try{
      await pinned(c.page).filter({has:c.page.locator('a[href="#f/AB"]')}).dragTo(pinned(c.page).filter({has:c.page.locator('a[href="#f/A"]')}));await waitSaved(['AB','A','A/하위']);
      assert.deepEqual(await order(c.page),['AB','A','A/하위']);
      await mine(c.page,'거래처').getByRole('button',{name:'거래처 상단 고정'}).click();await waitSaved(['AB','A','A/하위','거래처']);
      const pin=pinned(c.page).filter({has:c.page.locator(`a[href="#f/${encodeURIComponent('거래처')}"]`)});
      await expect(pin.locator('.n')).toHaveText(await mine(c.page,'거래처').locator('.n').textContent());
      await pin.locator('a').click();await expect(pin.locator('a')).toHaveAttribute('aria-current','page');await expect(mine(c.page,'거래처').locator('a')).toHaveAttribute('aria-current','page');
      await c.page.reload();await expect(pinned(c.page)).toHaveCount(4);await sidebar(c.page);assert.deepEqual(await order(c.page),['AB','A','A/하위','거래처']);
      const other=await open();try{assert.deepEqual(await order(other.page),['AB','A','A/하위','거래처']);}finally{await other.close();}
    }finally{await c.close();}
  });
  await t.test('rename and pin together migrate A subtree but keep AB; delete removes pins',async()=>{
    reset({pins:['A/하위','AB']});const c=await open();try{
      await manage(c.page,'A');await c.page.getByLabel('상단 고정',{exact:true}).check();await c.page.getByLabel('폴더 이름',{exact:true}).fill('Z');
      await c.page.getByRole('button',{name:'이름 바꾸기',exact:true}).click();await expect(c.page.getByRole('dialog')).toHaveCount(0);await waitSaved(['Z/하위','AB','Z']);
      assert.deepEqual(await order(c.page),['Z/하위','AB','Z']);await expect(pinned(c.page).first().locator('.fpp')).toHaveText('Z');
      await manage(c.page,'Z');await c.page.getByRole('button',{name:'폴더 지우기',exact:true}).click();await c.page.getByRole('button',{name:'폴더 지우기',exact:true}).click();await waitSaved(['AB']);assert.deepEqual(await order(c.page),['AB']);
    }finally{await c.close();}
  });
  await t.test('rename success / prefs failure retains session pins; next pin save repairs paths',async()=>{
    reset({pins:['A','A/하위','AB']});const c=await open();try{
      let fail=true;await c.page.route('**/api/prefs',route=>route.request().method()==='PUT'&&fail?route.fulfill({status:503,json:{error:{code:'MAIL_UNAVAILABLE',message:'합성 저장 실패'}}}):route.fallback());
      await manage(c.page,'A');await c.page.getByLabel('폴더 이름',{exact:true}).fill('Z');await c.page.getByRole('button',{name:'이름 바꾸기',exact:true}).click();
      await expect(c.page.getByText('합성 저장 실패 고정 폴더 설정을 다시 저장해 주세요.',{exact:true})).toBeVisible();
      assert.deepEqual(fake.state.prefs.pinnedFolders,['A','A/하위','AB']);assert.deepEqual(await order(c.page),['Z','Z/하위','AB']);
      fail=false;await mine(c.page,'AB').getByRole('button',{name:'AB 고정 해제'}).click();await waitSaved(['Z','Z/하위']);
      await c.page.reload();await expect(pinned(c.page)).toHaveCount(2);await sidebar(c.page);assert.deepEqual(await order(c.page),['Z','Z/하위']);
    }finally{await c.close();}
  });
  for(const status of [422,413,503])await t.test(`prefs ${status} restores confirmed pins and position`,async()=>{
    reset({pins:['A']});const c=await open();try{
      await c.page.route('**/api/prefs',route=>route.request().method()==='PUT'?route.fulfill({status,json:{error:{code:`SYNTHETIC_${status}`,message:`합성 ${status} 실패`}}}):route.fallback());
      await manage(c.page,'AB');await c.page.getByLabel('상단 고정',{exact:true}).check();await c.page.getByLabel('고정 폴더 위치',{exact:true}).selectOption('inbox');
      await expect(c.page.getByText(`합성 ${status} 실패`,{exact:true})).toBeVisible();await expect(c.page.getByLabel('상단 고정',{exact:true})).not.toBeChecked();await expect(c.page.getByLabel('고정 폴더 위치',{exact:true})).toHaveValue('mine');assert.deepEqual(await order(c.page),['A']);
    }finally{await c.close();}
  });
  await t.test('51st pin rejected, stale paths disappear on next pin change',async()=>{
    const paths=Array.from({length:51},(_,i)=>`Folder${i}`);reset({pins:paths.slice(0,50)});fake.state.folders.push(...paths.map(path=>personal(path)));const c=await open();try{
      await mine(c.page,paths[50]).getByRole('button',{name:paths[50]+' 상단 고정',exact:true}).click();await expect(c.page.getByText('폴더는 50개까지 고정할 수 있어요.',{exact:true})).toBeVisible();assert.equal(fake.state.prefs.pinnedFolders.length,50);assert.equal(await pinned(c.page).count(),50);
      await manage(c.page,paths[50]);await c.page.getByLabel('상단 고정',{exact:true}).click();await expect(c.page.getByLabel('상단 고정',{exact:true})).not.toBeChecked();assert.equal(fake.state.prefs.pinnedFolders.length,50);
      await c.page.getByRole('button',{name:'이름 바꾸기',exact:true}).click();
      fake.state.prefs.pinnedFolders=['A','Gone'];await c.page.reload();await expect(pinned(c.page)).toHaveCount(1);await sidebar(c.page);assert.deepEqual(await order(c.page),['A']);
      await mine(c.page,'AB').getByRole('button',{name:'AB 상단 고정',exact:true}).click();await waitSaved(['A','AB']);
    }finally{await c.close();}
  });
  await t.test('two contexts adding independently: last saved array overwrites first (known limitation)',async()=>{
    reset();const first=await open(),second=await open();try{
      await mine(first.page,'A').getByRole('button',{name:'A 상단 고정',exact:true}).click();await waitSaved(['A']);
      await mine(second.page,'AB').getByRole('button',{name:'AB 상단 고정',exact:true}).click();await waitSaved(['AB']);
      assert.deepEqual(await order(first.page),['A']);await first.page.reload();await expect(pinned(first.page)).toHaveCount(1);await sidebar(first.page);assert.deepEqual(await order(first.page),['AB']);
    }finally{await first.close();await second.close();}
  });
  for(const width of [1280,768,375])for(const mode of ['light','dark'])for(const position of ['mine','inbox'])await t.test(`capture ${width} ${mode} ${position}`,async()=>{
    reset({pins:['거래처','A/하위','AB'],position,mode});const c=await open(width,mode);try{
      await expect(c.page.locator('html')).toHaveAttribute('data-mode',mode);
      await c.page.evaluate(()=>document.fonts.ready);
      assert.deepEqual(await order(c.page),['거래처','A/하위','AB']);
      assert.equal(await c.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await c.page.screenshot({path:`${captures}/${width}-${mode}-${position}.png`,animations:'disabled'});
      await manage(c.page,'A/하위');await expect(c.page.getByRole('heading',{name:'이 폴더',exact:true})).toBeVisible();await expect(c.page.getByRole('heading',{name:'사이드바 공통 설정',exact:true})).toBeVisible();
      await c.page.screenshot({path:`${captures}/${width}-${mode}-${position}-dialog.png`,animations:'disabled'});
      if(width===375){await expect(c.page.getByRole('button',{name:'위로',exact:true})).toBeEnabled();await c.page.getByRole('button',{name:'위로',exact:true}).click();await waitSaved(['A/하위','거래처','AB']);await c.page.getByRole('button',{name:'이름 바꾸기',exact:true}).click();await expect(c.page.getByRole('dialog')).toHaveCount(0);}
    }finally{await c.close();}
  });
});
