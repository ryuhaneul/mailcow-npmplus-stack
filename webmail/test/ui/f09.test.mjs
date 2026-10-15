import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

const captures = process.env.F09_CAPTURE_DIR || '/tmp/webmail-f09-captures';
const fake = createFakeApi({authenticated:true});
const original = structuredClone(fake.state.storage);
const server = await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'f09-test-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}),args:['--no-sandbox']});
await mkdir(captures,{recursive:true});

await test('F09 storage, empty-folder and password UI', async t => {
  t.after(async()=>{await browser.close();await server.close();});
  async function pageFor(route='storage',width=1280,theme='ink',mode='light',pct=83) {
    fake.state.authenticated=true;
    fake.state.storage=structuredClone(original);
    fake.state.storage.quota.usedBytes=pct/100*fake.state.storage.quota.limitBytes;
    fake.state.storage.level=pct>=95?'crit':pct>=80?'warn':'ok';
    const context=await browser.newContext({viewport:{width,height:width<700?844:900}});
    await context.addInitScript(({theme,mode})=>localStorage.setItem('webmail-prefs',JSON.stringify({theme,mode})),{theme,mode});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${origin}/#${route}`);
    await expect(page.locator(`[data-page="${route}"]`)).toBeVisible();
    await expect(page.locator('.quota .bar')).toHaveCount(1);
    if(route==='storage')await expect(page.getByRole('table')).toBeVisible();
    return {page,context,errors};
  }
  async function fill(page,current='example-password',next='Saebyeok-bit7!',confirmation=next) {
    await page.locator('#pw0').fill(current);await page.locator('#pw1').fill(next);await page.locator('#pw2').fill(confirmation);
  }
  async function noOverflow(page) {
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.equal(await page.locator('.account-view .scroll').evaluate(el=>el.scrollWidth>el.clientWidth),false);
  }
  await t.test('79%, 80%, 95% levels and folder capacity table',async()=>{
    for(const [pct,level] of [[79,'ok'],[80,'warn'],[95,'crit']]) {
      const {page,context,errors}=await pageFor('storage',1280,'ink','light',pct);
      await expect(page.locator('[data-page="storage"]')).toHaveAttribute('data-storage-level',level);
      await expect(page.locator('.big')).toContainText(`${pct}%`);
      await expect(page.locator('.account-view .alert')).toHaveCount(level==='ok'?0:1);
      if(level!=='ok') {
        await expect(page.locator('.account-view .alert')).toHaveClass(`alert ${level}`);
        await expect(page.locator('.account-view .alert')).toContainText(`${pct}%`);
        const colors=await page.locator('.quota .bar span').evaluate(el=>{const probe=document.createElement('span');probe.style.backgroundColor=el.closest('.quota').dataset.level==='crit'?'var(--danger)':'var(--warn)';document.body.append(probe);const result={actual:getComputedStyle(el).backgroundColor,expected:getComputedStyle(probe).backgroundColor};probe.remove();return result;});
        assert.equal(colors.actual,colors.expected);
        const thresholdColors=await page.locator('.thr .bar span').evaluateAll(elements=>elements.map(el=>getComputedStyle(el).backgroundColor));
        assert.notEqual(thresholdColors[0],thresholdColors[1]);
      }
      await expect(page.getByRole('table')).toContainText('받은편지함');
      await expect(page.getByRole('table')).toContainText('6.2GB');
      assert.equal(await page.locator('.demo').count(),0);
      if(pct===95)await page.screenshot({path:`${captures}/f09-storage-95.png`});
      assert.deepEqual(errors,[]);await context.close();
    }
  });
  await t.test('exact folder name, native modal focus, request body and response notification',async()=>{
    const {page,context}=await pageFor();
    await page.getByRole('button',{name:'휴지통 비우기',exact:true}).click();
    const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
    await expect(page.locator('#empty-name')).toBeFocused();
    await page.locator('#empty-name').fill('휴지통 ');await expect(dialog.getByRole('button',{name:'영구 삭제',exact:true})).toBeDisabled();
    await page.locator('#empty-name').fill('휴지통');await expect(dialog.getByRole('button',{name:'영구 삭제',exact:true})).toBeEnabled();
    await page.screenshot({path:`${captures}/f09-empty-dialog.png`});
    const request=page.waitForRequest(req=>req.url().endsWith('/api/folders/Trash/empty'));
    await dialog.getByRole('button',{name:'영구 삭제',exact:true}).click();
    assert.deepEqual((await request).postDataJSON(),{confirmName:'휴지통'});
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('1,204통');await expect(page.locator('.toast')).toContainText('2.1GB');
    await expect(page.getByRole('row').filter({has:page.getByRole('button',{name:'휴지통 비우기',exact:true})})).toContainText('0B');
    await context.close();
  });
  await t.test('empty-folder failure remains visible and Escape restores focus',async()=>{
    const {page,context}=await pageFor();
    await page.route('**/api/folders/Trash/empty',route=>route.fulfill({status:503,json:{error:{code:'MAIL_UNAVAILABLE',message:'폴더를 비울 수 없어요.'}}}));
    const trigger=page.getByRole('button',{name:'휴지통 비우기',exact:true});await trigger.click();await page.locator('#empty-name').fill('휴지통');
    await page.getByRole('button',{name:'영구 삭제',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('폴더를 비울 수 없어요.');
    await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(trigger).toBeFocused();
    await context.close();
  });
  await t.test('all six password conditions and confirmation gate submit',async()=>{
    const {page,context}=await pageFor('password');
    const save=page.getByRole('button',{name:'암호 바꾸기',exact:true});
    const cases=[['example-password','Abcdef1!'],['example-password','abcdefghij7!'],['example-password','Abcdefghijkl!'],['example-password','Abcdefghijk7'],['Saebyeok-bit7!','Saebyeok-bit7!'],['example-password','Example-User7!']];
    for(const [index,[current,next]] of cases.entries()) {
      await fill(page,current,next);await expect(save).toBeDisabled();
      await expect(page.locator('#pw-checks li').nth(index)).not.toHaveClass('ok');
    }
    await fill(page,'example-password','이서윤-Abc7!xyz');await expect(save).toBeDisabled();
    await fill(page);await expect(save).toBeEnabled();await expect(page.locator('#pw-checks li.ok')).toHaveCount(6);
    await page.locator('#pw2').fill('different');await expect(save).toBeDisabled();await expect(page.locator('#pw-match')).toHaveText('두 암호가 다릅니다');
    await context.close();
  });
  await t.test('password success clears inputs during request and returns to login with approved notice',async()=>{
    const {page,context}=await pageFor('password');
    let release;const gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/password',async route=>{assert.deepEqual(route.request().postDataJSON(),{current:'example-password',next:'Saebyeok-bit7!',next2:'Saebyeok-bit7!'});await gate;fake.state.authenticated=false;await route.fulfill({json:{relogin:true}});});
    await fill(page);await page.getByRole('button',{name:'암호 바꾸기',exact:true}).click();
    for(const id of ['pw0','pw1','pw2'])await expect(page.locator(`#${id}`)).toHaveValue('');
    release();await expect(page.getByRole('heading',{name:'로그인',exact:true})).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('암호를 바꿨어요. 이 웹메일의 모든 로그인(다른 기기 포함)을 끝냈어요. 새 암호로 다시 로그인해 주세요.');
    await page.screenshot({path:`${captures}/f09-password-success-login.png`});
    assert.equal(await page.evaluate(()=>localStorage.getItem('webmail-prefs').includes('Saebyeok')),false);
    await context.close();
  });
  await t.test('server password failures, fallback links and cleared inputs',async()=>{
    const failures=[
      [403,'MAILCOW_2FA','mailcow 화면에서 2단계 인증을 쓰고 있어 여기서는 바꿀 수 없어요.'],
      [503,'MAILCOW_UNAVAILABLE','지금은 암호를 바꿀 수 없어요. 잠시 뒤 다시 하거나'],
      [503,'MAILCOW_UNEXPECTED','지금은 암호를 바꿀 수 없어요. 잠시 뒤 다시 하거나'],
      [403,'CURRENT_WRONG','현재 암호가 맞지 않아요.'],
      [422,'PW_MISMATCH','새 암호가 서로 같지 않아요.'],
      [422,'PW_POLICY','새 암호가 메일 서버의 암호 정책에 맞지 않아요.'],
      [422,'PW_SAME','현재 암호와 다른 새 암호를 입력해 주세요.'],
      [422,'PW_FORMAT','암호를 입력해 주세요.'],
      [429,'RATE_LIMITED','시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.'],
    ];
    for(const [status,code,message] of failures) {
      const {page,context}=await pageFor('password');const link=code.startsWith('MAILCOW_');
      await page.route('**/api/password',route=>route.fulfill({status,json:{error:{code,message,...(link?{fallbackUrl:'https://mailcow.example.com'}:{})}}}));
      await fill(page);await page.getByRole('button',{name:'암호 바꾸기',exact:true}).click();
      await expect(page.getByRole('alert')).toContainText(message);
      if(link)await expect(page.getByRole('link',{name:'mailcow 사용자 화면에서 바꾸기'})).toHaveAttribute('href','https://mailcow.example.com');
      for(const id of ['pw0','pw1','pw2'])await expect(page.locator(`#${id}`)).toHaveValue('');
      await expect(page.locator('[data-page="password"]')).toBeVisible();await context.close();
    }
  });
  await t.test('five themes, light/dark, desktop/mobile and requested captures without horizontal overflow',async()=>{
    for(const theme of ['ink','terra','seland','amber','olive'])for(const mode of ['light','dark'])for(const width of [1280,390])for(const screen of ['storage','password']) {
      const {page,context,errors}=await pageFor(screen,width,theme,mode);
      if(screen==='password')await fill(page);
      await noOverflow(page);assert.deepEqual(errors,[]);
      if(theme==='ink' && (screen==='storage' || mode==='light'))await page.screenshot({path:`${captures}/f09-${screen}-${mode}-${width}.png`});
      if(theme==='seland' && mode==='dark' && width===1280 && screen==='storage')await page.screenshot({path:`${captures}/f09-storage-seland-dark.png`});
      await context.close();
    }
    for(const width of [375,768])for(const screen of ['storage','password']) {
      const {page,context}=await pageFor(screen,width);await noOverflow(page);await context.close();
    }
  });
});
