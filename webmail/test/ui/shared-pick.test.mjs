import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

await test('shared folder picker and grouped sidebar',async t=>{
  const fake=createFakeApi({authenticated:true});
  const initialPrefs=structuredClone(fake.state.prefs),initialFolders=structuredClone(fake.state.folders);
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'shared-pick-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
  await server.listen();t.after(()=>server.close());t.after(()=>fake.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`,captures=process.env.SHARED_PICK_CAPTURE_DIR;
  if(captures)await mkdir(captures,{recursive:true});
  const sales='sales@example.com',support='support@example.com';
  const path=(owner,name)=>`Shared/${owner}/${name}`;
  const group=(page,owner)=>page.locator(`#sp-shared .sp-grp[data-owner="${owner}"]`);
  const card=(page,owner)=>page.getByRole('region',{name:`${owner} 공유 메일함`,exact:true});
  const more=(page,owner=sales)=>page.getByRole('button',{name:`${owner} 폴더 고르기`,exact:true});
  const checkbox=(scope,owner,name,n=0)=>scope.getByRole('checkbox',{name:`${owner} ${name} 읽지 않음 ${n}`,exact:true});
  async function start({route='inbox',width=1280,theme='ink',mode='light',setup,folderCounts=false}={}){
    fake.state.prefs={...structuredClone(initialPrefs),theme,mode};fake.state.folders=structuredClone(initialFolders);setup?.();
    const context=await browser.newContext({viewport:{width,height:width<700?844:900},colorScheme:mode});
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));if(folderCounts)await page.route('**/api/folders',route=>route.fulfill({json:{folders:fake.state.folders,virtualAllMail:'WebmailVirtual/AllMail'}}));await page.goto(`${origin}/#${route}`);await expect(page.locator('#page-title')).toBeVisible();await expect(page.locator('#sp-shared .sp-grp')).toHaveCount(new Set(fake.state.folders.filter(f=>f.shared&&f.path.startsWith(`Shared/${f.owner}/`)&&!fake.state.prefs.sharedView[f.owner]?.hidden).map(f=>f.owner)).size);
    return {page,context,errors};
  }
  async function menu(page){const open=page.getByRole('button',{name:'메일함 열기'});if(await open.isVisible())await open.click();}
  async function saved(owner,mode){await expect.poll(()=>fake.state.prefs.sharedView[owner]?.mode).toBe(mode);}
  async function capture(page,name){if(captures)await page.screenshot({path:`${captures}/${name}.png`,animations:'disabled'});}
  await t.test('group rows, counts, default disclosure, persisted collapse and fresh hint',async()=>{
    const {page,context,errors}=await start();try{
      const rows=group(page,sales);await expect(rows.locator('.sp-kid')).toHaveCount(3);await expect(rows.locator('.sp-orow .nv')).toHaveCount(1);await expect(rows.locator('.sp-orow .n')).toHaveText('읽지 않음 4');await expect(group(page,support)).toContainText('새로 공유됨 — 받은편지함만 보입니다.');
      const toggle=rows.getByRole('button',{name:`${sales} 폴더 접기`});await expect(toggle).toHaveAttribute('aria-expanded','true');await toggle.click();await expect(rows.locator('.sp-kid')).toHaveCount(0);await page.reload();await expect(group(page,sales).getByRole('button',{name:`${sales} 폴더 펼치기`})).toHaveAttribute('aria-expanded','false');
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  });
  await t.test('popover radio keys, custom restore, checkbox focus, Esc and outside focus return',async()=>{
    const {page,context}=await start();try{
      await more(page).click();const pop=page.getByRole('dialog',{name:`${sales} 폴더 고르기`});await expect(more(page)).toHaveAttribute('aria-expanded','true');await expect(pop.getByRole('radio',{name:'직접 고름',exact:true})).toBeFocused();
      await page.keyboard.press('ArrowLeft');await expect(pop.getByRole('radio',{name:'전부',exact:true})).toHaveAttribute('aria-checked','true');
      const sent=checkbox(pop,sales,'보낸편지함');await expect(sent).toBeChecked();await sent.focus();await sent.press('Space');await expect(sent).toBeFocused();await expect(pop.getByRole('radio',{name:'직접 고름',exact:true})).toHaveAttribute('aria-checked','true');await saved(sales,'custom');
      await pop.getByRole('radio',{name:'받은편지함만',exact:true}).click();await expect(group(page,sales).locator('.sp-kid')).toHaveCount(0);await pop.getByRole('radio',{name:'직접 고름',exact:true}).click();await expect(sent).not.toBeChecked();await expect(checkbox(pop,sales,'임시보관함')).toBeChecked();
      await page.keyboard.press('Escape');await expect(pop).toHaveCount(0);await expect(more(page)).toBeFocused();await expect(more(page)).toHaveAttribute('aria-expanded','false');
      await more(page).click();await page.locator('#page-title').dispatchEvent('pointerdown');await expect(pop).toHaveCount(0);await expect(more(page)).toBeFocused();
      await more(page).click();await pop.getByRole('radio',{name:'직접 고름',exact:true}).focus();await page.keyboard.press('Shift+Tab');await expect(pop.getByRole('link',{name:'설정에서 전부 보기'})).toBeFocused();await page.keyboard.press('Tab');await expect(pop.getByRole('radio',{name:'직접 고름',exact:true})).toBeFocused();
    }finally{await context.close();}
  });
  for(const width of [1280,390])for(const [mode,label] of [['inbox','받은편지함만'],['all','전부'],['custom','직접 고름']]){
    await t.test(`popup shortcut isolation ${mode} ${width}`,async()=>{
      const {page,context}=await start({width,setup(){fake.state.prefs.sharedView[sales].mode=mode;}});try{
        await expect(page.locator('.list .m')).toHaveCount(12);await page.locator('.list .m').first().focus();await menu(page);await more(page).scrollIntoViewIfNeeded();await more(page).click();
        const pop=page.getByRole('dialog',{name:`${sales} 폴더 고르기`});await expect(pop.getByRole('radio',{name:label,exact:true})).toBeFocused();
        const before=await page.locator('.list .m').evaluateAll(rows=>rows.map(row=>({id:row.id,className:row.className,text:row.textContent,checked:[...row.querySelectorAll('[aria-checked]')].map(el=>el.getAttribute('aria-checked'))})));
        const mailBefore=structuredClone(fake.state.mail),requestStart=fake.state.requests.length,hash=await page.evaluate(()=>location.hash),requests=[];
        page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/message'))requests.push(request.method()+' '+new URL(request.url()).pathname);});
        for(const key of ['#','e','j','s','k','x','!','g','i','g','s','c','/','?','u','Enter']){
          await page.keyboard.press(key);await expect(pop.getByRole('radio',{name:label,exact:true})).toBeFocused();assert.equal(await page.evaluate(()=>location.hash),hash);
        }
        assert.deepEqual(requests,[]);assert.deepEqual(fake.state.requests.slice(requestStart).filter(request=>request.path.startsWith('/api/message')),[]);assert.deepEqual(fake.state.mail,mailBefore);
        assert.deepEqual(await page.locator('.list .m').evaluateAll(rows=>rows.map(row=>({id:row.id,className:row.className,text:row.textContent,checked:[...row.querySelectorAll('[aria-checked]')].map(el=>el.getAttribute('aria-checked'))}))),before);
        await page.keyboard.press('Escape');await expect(pop).toHaveCount(0);await expect(more(page)).toBeFocused();
      }finally{await context.close();}
    });
    await t.test(`initial popup focus cycle ${mode} ${width}`,async()=>{
      const {page,context}=await start({width,setup(){fake.state.prefs.sharedView[sales].mode=mode;}});try{
        await menu(page);await more(page).scrollIntoViewIfNeeded();await more(page).click();const pop=page.getByRole('dialog',{name:`${sales} 폴더 고르기`}),selected=pop.getByRole('radio',{name:label,exact:true});
        await expect(selected).toBeFocused();await expect(selected).toHaveJSProperty('tabIndex',0);
        for(const radio of await pop.getByRole('radio').all())if(await radio.getAttribute('aria-checked')==='false')await expect(radio).toHaveJSProperty('tabIndex',-1);
        await page.keyboard.press('Shift+Tab');await expect(pop.getByRole('link',{name:'설정에서 전부 보기'})).toBeFocused();await page.keyboard.press('Tab');await expect(selected).toBeFocused();
        const count=await pop.evaluate(node=>[...node.querySelectorAll('button,input,a[href]')].filter(el=>!el.disabled&&el.tabIndex>=0).length);
        for(const key of ['Tab','Shift+Tab']){
          for(let index=0;index<count*2;index++){await page.keyboard.press(key);assert.equal(await pop.evaluate(node=>node.contains(document.activeElement)),true);}
          await expect(selected).toBeFocused();
        }
        await page.keyboard.press('ArrowRight');await expect(pop.locator('[role=radio][aria-checked=true]')).toBeFocused();await expect(pop.locator('[role=radio][tabindex="0"]')).toHaveCount(1);
        const sent=checkbox(pop,sales,'보낸편지함');await sent.focus();await sent.press('Space');await expect(sent).toBeFocused();
        await page.keyboard.press('Escape');await expect(pop).toHaveCount(0);await expect(more(page)).toBeFocused();await expect(more(page)).toHaveAttribute('aria-expanded','false');
      }finally{await context.close();}
    });
  }
  await t.test('hide current folder and owner keeps view; settings restores selection across reload',async()=>{
    const {page,context}=await start();try{
      await group(page,sales).getByRole('link',{name:'견적',exact:false}).click();await expect(page.locator('#page-title')).toHaveText(`${sales} · 견적`);const hash=await page.evaluate(()=>location.hash);
      await more(page).click();const pop=page.getByRole('dialog');await checkbox(pop,sales,'견적',2).focus();await checkbox(pop,sales,'견적',2).press('Space');assert.equal(await page.evaluate(()=>location.hash),hash);await expect(page.locator('#page-title')).toHaveText(`${sales} · 견적`);
      await pop.getByRole('button',{name:'사이드바에서 숨기기'}).click();await expect(group(page,sales)).toHaveCount(0);assert.equal(await page.evaluate(()=>location.hash),hash);await page.getByRole('link',{name:'숨긴 사람 1명 · 설정에서 보기'}).click();await expect(page.locator('#page-title')).toHaveText('공유 메일함');
      const salesCard=card(page,sales);await salesCard.getByRole('button',{name:'다시 보이기'}).click();await expect(group(page,sales)).toBeVisible();await expect(checkbox(salesCard,sales,'견적',2)).not.toBeChecked();await saved(sales,'custom');
      await expect.poll(()=>fake.state.prefs.sharedView[sales].folders.includes(path(sales,'견적'))).toBe(false);await expect.poll(()=>fake.state.prefs.sharedView[sales].hidden).toBe(false);await page.reload();await expect(checkbox(card(page,sales),sales,'견적',2)).not.toBeChecked();
      await expect(page.locator('.sp-mini')).toHaveAttribute('inert','');await expect(page.locator('.sp-mini a,.sp-mini button,.sp-mini input')).toHaveCount(0);
      await expect(page.getByRole('navigation',{name:'설정',exact:true}).getByRole('link',{name:'공유 메일함'})).toHaveAttribute('aria-current','page');
    }finally{await context.close();}
  });
  await t.test('single inbox has no arrow; inboxMissing remains text with hidden count; empty state',async()=>{
    const {page,context}=await start({setup(){fake.state.folders=fake.state.folders.filter(f=>!f.shared||f.path===path(sales,'INBOX')||f.path===path(support,'保管'));fake.state.folders.push({...initialFolders.find(f=>f.shared),owner:support,path:path(support,'保管'),name:'保管',unseen:0});delete fake.state.prefs.sharedView[support];}});try{
      await expect(group(page,sales).locator('.sp-tw[aria-expanded]')).toHaveCount(0);await expect(group(page,support).locator('.sp-orow a')).toHaveCount(0);await expect(group(page,support).locator('.sp-orow .nv')).toHaveText(support);await expect(group(page,support)).toContainText('숨긴 폴더 1개');await more(page,support).click();await page.getByRole('dialog').getByRole('radio',{name:'전부',exact:true}).click();await expect(group(page,support).locator('.sp-kid')).toHaveCount(1);
    }finally{await context.close();}
    const empty=await start({route:'shared',setup(){fake.state.folders=fake.state.folders.filter(f=>!f.shared);}});try{await expect(empty.page.locator('#sp-shared')).toHaveCount(0);await expect(empty.page.getByText('공유받은 메일함이 없어요.',{exact:true})).toHaveCount(2);}finally{await empty.context.close();}
  });
  await t.test('parent selection is independent; custom and all handle later folders; fresh preference saved',async()=>{
    const {page,context}=await start({route:'shared'});try{
      const salesCard=card(page,sales),parent=checkbox(salesCard,sales,'거래처',3);
      await parent.locator('..').click();await expect(parent).not.toBeChecked();await expect(checkbox(salesCard,sales,'거래처 / 2026',1)).toBeChecked();await expect(group(page,sales).locator('.sp-kid').first()).toHaveText('거래처 / 2026읽지 않음 1');
      const supportCard=card(page,support);await supportCard.getByRole('radio',{name:'전부',exact:true}).click();await expect(group(page,support).locator('.sp-hint')).toHaveCount(0);await saved(support,'all');await expect.poll(()=>fake.state.prefs.sharedView[sales].folders.includes(path(sales,'거래처'))).toBe(false);
      for(const owner of [sales,support])fake.state.folders.push({...initialFolders.find(f=>f.owner===owner),path:path(owner,'나중 폴더'),name:'나중 폴더',unseen:0});
      await page.reload();await expect(group(page,support).getByRole('link',{name:'나중 폴더',exact:true})).toBeVisible();await expect(group(page,sales).getByRole('link',{name:'나중 폴더',exact:true})).toHaveCount(0);await expect(checkbox(card(page,sales),sales,'나중 폴더')).not.toBeChecked();
    }finally{await context.close();}
  });
  await t.test('long shared settings keep the outer shell still when lower folder checkboxes receive focus',async()=>{
    const owners=['consulting@example.com','security@example.com','server@example.com','new-team-a@example.com','new-team-b@example.com'];
    for(const width of [1280,768,375]){
      const {page,context,errors}=await start({width,route:'shared',folderCounts:true,setup(){
        fake.state.folders=fake.state.folders.filter(folder=>!folder.shared);
        fake.state.prefs.sharedView=Object.fromEntries(owners.slice(0,3).map(owner=>[owner,{mode:'inbox',folders:[],hidden:false}]));
        for(const [index,owner] of owners.entries())for(const name of ['INBOX','Sent','Drafts','Archive','Junk','Trash',...(index!==1?['바이러스 격리']:[])]){
          fake.state.folders.push({...initialFolders.find(folder=>folder.shared),owner,path:path(owner,name),name,parent:`Shared/${owner}`,unseen:name==='INBOX'?103212+index*10000:0,total:name==='INBOX'?130117+index*20000:20});
        }
      }});try{
        const consoleErrors=[];page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
        await expect(page.locator('.sp-owner')).toHaveCount(5);
        for(const [index,owner] of owners.entries()){
          const ownerCard=card(page,owner);
          for(let round=0;round<2;round++)for(const label of ['보낸편지함',index===1?'휴지통':'바이러스 격리']){
            const input=checkbox(ownerCard,owner,label),row=input.locator('..');
            await row.scrollIntoViewIfNeeded();
            for(const on of [true,false]){
              await row.click();await expect(input).toBeFocused();await expect(input).toBeChecked({checked:on});
              assert.equal(await page.locator('main').evaluate(node=>node.scrollTop),0);
              await expect(page.locator('#page-title')).toBeVisible();await expect(row).toBeInViewport();
            }
          }
          await saved(owner,'custom');
        }
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await capture(page,`webmail-shared-lower-folders-${width}`);
        assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);
      }finally{await context.close();}
    }
  });
  await t.test('long owner titles, tablet and narrow mobile fit',async()=>{
    const long='a-very-long-shared-mailbox-address-for-testing@example.com';
    for(const width of [768,375]){
      const {page,context}=await start({width,route:'shared',setup(){fake.state.folders=fake.state.folders.map(f=>f.owner===support?{...f,owner:long,path:f.path.replace(support,long)}:f);}});try{
        await expect(card(page,long).locator('.sp-on > b')).toHaveAttribute('title',long);await menu(page);await expect(group(page,long).locator('.sp-orow .nv')).toHaveAttribute('title',long);await more(page,long).scrollIntoViewIfNeeded();await more(page,long).click();await expect(page.getByRole('dialog').locator('.sp-ph > b')).toHaveAttribute('title',long);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0);
      }finally{await context.close();}
    }
  });
  for(const width of [1280,390])for(const theme of ['ink','seland','terra','amber','olive'])for(const mode of ['light','dark'])await t.test(`layout ${theme} ${mode} ${width}`,async()=>{
    const {page,context,errors}=await start({width,theme,mode,route:'shared'});try{
      await expect(page.locator('.sp-owner')).toHaveCount(2);await expect(page.locator('.sp-rules li')).toHaveCount(4);await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0);assert.equal(await page.locator('.sp-bview .scroll').evaluate(el=>el.scrollWidth-el.clientWidth),0);
      if(theme==='ink'&&(width===1280||mode==='light'))await capture(page,`webmail-settings-${mode}-${width}`);
      await menu(page);await more(page).scrollIntoViewIfNeeded();
      const style=await more(page).evaluate(el=>({opacity:getComputedStyle(el).opacity,color:getComputedStyle(el).color}));assert.equal(style.opacity,'1');
      const ratio=await more(page).evaluate(el=>{const rgb=s=>s.match(/[\d.]+/g).slice(0,3).map(Number);const lum=s=>rgb(s).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);const css=getComputedStyle(el),bg=getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim(),probe=document.createElement('span');probe.style.color=bg;document.body.append(probe);const b=lum(getComputedStyle(probe).color),a=lum(css.color);probe.remove();return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);});assert.ok(ratio>=3,`${theme} ${mode} more ratio ${ratio}`);await more(page).click();await expect(page.getByRole('dialog')).toBeVisible();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0);
      if(theme==='ink'&&mode==='light'){await page.keyboard.press('Escape');await page.evaluate(()=>{location.hash='inbox';});await expect(page.locator('#page-title')).toHaveText('받은편지함');if(width<700)await menu(page);await more(page).scrollIntoViewIfNeeded();await more(page).click();await capture(page,width===1280?'webmail-sidebar-popover-light-1280':'webmail-menu-light-390');}
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  });
});
