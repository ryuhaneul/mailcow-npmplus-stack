import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createFakeApi } from '../../web/dev/fake-api.js';
import { rulesFixture, gmailImportFixture } from '../../web/dev/fake-rules.js';

const captures = process.env.GMAIL_IMPORT_CAPTURE_DIR || '/tmp/webmail-gmail-import-captures';
const fake = createFakeApi({authenticated:true});
const originalFolders = structuredClone(fake.state.folders);
const server = await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'gmail-import-test-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}),args:['--no-sandbox']});
await mkdir(captures,{recursive:true});
const xml = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006"><entry><apps:property name="from" value="billing@example.com"/><apps:property name="label" value="거래처"/></entry></feed>';
const file = {name:'mailFilters.xml',mimeType:'application/xml',buffer:Buffer.from(xml)};
const paths = {undo:'/api/rules/import/undo',preview:'/api/rules/import/xml/preview',apply:'/api/rules/import/xml'};
const recorded = path => fake.state.requests.filter(request => request.path === path);
function noNull(value) {
  assert.notEqual(value,null);
  if(value && typeof value === 'object')for(const item of Object.values(value))noNull(item);
}

await test('Gmail import preview and explicit partial apply', async t => {
  t.after(async()=>{await browser.close();await server.close();});
  async function pageFor({width=1280,mode='light',state='ok',route='filters/import'}={}) {
    fake.state.rules=rulesFixture(state);fake.state.rulesError=null;fake.state.requests=[];fake.state.folders=structuredClone(originalFolders);
    fake.state.prefs.mode=mode;fake.state.prefs.theme='ink';
    delete fake.state.importPreview;delete fake.state.importUndo;
    const context=await browser.newContext({viewport:{width,height:900}});
    await context.addInitScript(mode=>localStorage.setItem('webmail-prefs',JSON.stringify({theme:'ink',mode})),mode);
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${origin}/#${route}`);
    await expect(page.locator('#filters-title')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-mode',mode);
    return {page,context,errors};
  }
  async function pick(page,value=file) {
    await page.getByLabel('Gmail 필터 파일 고르기',{exact:true}).setInputFiles(value);
    await expect(page.locator('.gi-table')).toBeVisible();
  }
  await t.test('entry beside new rule, raw values, three statuses, grouped exclusions, folders and filters',async()=>{
    const {page,context,errors}=await pageFor({route:'filters'});
    await page.getByRole('link',{name:'Gmail 필터 가져오기',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Gmail 필터 가져오기',exact:true})).toBeVisible();
    await pick(page);
    await expect(page.locator('.gi-tr')).toHaveCount(3);
    await expect(page.locator('.gi-tr-same .gi-st')).toHaveText('그대로');
    await expect(page.locator('.gi-tr-changed .gi-st')).toHaveText('달라짐');
    await expect(page.locator('.gi-tr-no .gi-st')).toHaveText('반영 안 됨');
    await expect(page.locator('.gi-badgroup')).toContainText('본문 조건은 옮길 수 없어요.');
    await expect(page.locator('.gi-tr-same .gi-orig')).toContainText('billing@example.com');
    await expect(page.locator('.gi-tag')).toHaveText('폴더 새로 만듦');
    await expect(page.locator('.gi-tr-changed .gi-res')).toContainText('적용할 때 새로 만들어요.');
    await page.getByRole('button',{name:'달라짐 1',exact:true}).click();await expect(page.locator('.gi-tr')).toHaveCount(1);
    await page.getByRole('button',{name:'반영 안 됨 1',exact:true}).click();await expect(page.locator('.gi-tr-no')).toHaveCount(1);
    await page.getByRole('button',{name:'전체 3',exact:true}).click();
    await expect(page.getByRole('button',{name:'2개 적용',exact:true})).toBeDisabled();
    assert.equal(recorded(paths.apply).length,0);assert.deepEqual(errors,[]);await context.close();
  });
  await t.test('append/replace re-preview clears confirmation and sends exact expect, mode and no null',async()=>{
    const {page,context}=await pageFor();await pick(page);
    assert.equal(recorded(paths.preview).at(-1).body.mode,'append');
    await page.locator('.gi-confirm input').check();
    await page.getByRole('radio',{name:/통째로 바꾸기/}).click();
    await expect(page.getByRole('radio',{name:/통째로 바꾸기/})).toBeChecked();
    await expect(page.getByRole('radio',{name:/통째로 바꾸기/})).toBeFocused();
    await expect(page.locator('.gi-confirm input')).not.toBeChecked();
    await expect(page.getByRole('button',{name:'2개 적용',exact:true})).toBeDisabled();
    assert.equal(recorded(paths.preview).at(-1).body.mode,'replace');
    const previewResponse=await page.request.post(`${origin}${paths.preview}`,{headers:{'X-Webmail-CSRF':fake.state.csrf},data:recorded(paths.preview).at(-1).body});
    const preview=await previewResponse.json();
    await page.locator('.gi-confirm input').check();
    await page.getByRole('button',{name:'2개 적용',exact:true}).click();
    await expect(page.locator('#filters-title')).toHaveText('필터와 규칙');
    const request=recorded(paths.apply).at(-1);
    assert.deepEqual(request.body,{xml,fileName:'mailFilters.xml',mode:'replace',confirm:true,expect:preview.expect});
    assert.match(request.body.expect.planSha256,/^[a-f0-9]{64}$/);noNull(request.body);
    assert.equal(request.csrf,'synthetic-csrf-token');assert.equal(fake.state.rules.doc.rules.length,2);
    assert.equal(fake.state.rules.importInfo.dropped.length,1);assert.equal(fake.state.rules.importInfo.undo.available,true);
    await context.close();
  });
  await t.test('new account omits mode and absent expect keys; active script warning must be confirmed',async()=>{
    for(const state of ['none','import_pending','inactive_other']) {
      const {page,context}=await pageFor({state});await pick(page);
      if(state==='inactive_other')await expect(page.getByRole('radio',{name:/뒤에 덧붙이기/})).toBeChecked();
      else assert.equal(Object.hasOwn(recorded(paths.preview).at(-1).body,'mode'),false);
      if(state!=='none')await expect(page.locator('.gi-confirm')).toContainText('rainloop.user');
      await page.locator('.gi-confirm input').check();await page.getByRole('button',{name:'2개 적용',exact:true}).click();
      await expect(page.locator('#filters-title')).toHaveText('필터와 규칙');
      noNull(recorded(paths.apply).at(-1).body);await context.close();
    }
  });
  await t.test('zero applicable items hides apply button',async()=>{
    const {page,context}=await pageFor();
    fake.state.importPreview={items:[gmailImportFixture()[2]],counts:{same:0,changed:0,no:1},plan:{mode:'append',existing:5,applied:0,total:5,newFolders:[],replacesUndo:false},expect:{xmlSha256:'a'.repeat(64),mode:'append',rev:7,planSha256:'b'.repeat(64)}};
    await pick(page);await expect(page.getByRole('button',{name:/\d+개 적용/})).toHaveCount(0);await expect(page.locator('.gi-confirm')).toHaveCount(0);
    assert.equal(recorded(paths.apply).length,0);await expect(page.getByRole('link',{name:'취소',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'취소',exact:true}).click();await expect(page.locator('#filters-title')).toHaveText('필터와 규칙');await context.close();
  });
  await t.test('changed file resets consent, XML size and UTF-8 errors never submit',async()=>{
    const {page,context}=await pageFor();await pick(page);await page.locator('.gi-confirm input').check();
    await expect(page.locator('.gi-pick')).toHaveCount(0);
    await page.getByRole('link',{name:'취소',exact:true}).click();
    await page.getByRole('link',{name:'Gmail 필터 가져오기',exact:true}).click();
    await pick(page,{...file,name:'second.xml'});await expect(page.locator('.gi-confirm input')).not.toBeChecked();
    await page.getByRole('link',{name:'취소',exact:true}).click();
    await page.getByRole('link',{name:'Gmail 필터 가져오기',exact:true}).click();
    const before=recorded(paths.preview).length;
    await page.getByLabel('Gmail 필터 파일 고르기',{exact:true}).setInputFiles({...file,buffer:Buffer.alloc(512*1024+1,32)});
    await expect(page.getByRole('alert')).toContainText('512KiB');await expect(page.locator('.gi-table')).toHaveCount(0);
    await page.getByLabel('Gmail 필터 파일 고르기',{exact:true}).setInputFiles({...file,buffer:Buffer.from([0xff,0xfe])});
    await expect(page.getByRole('alert')).toContainText('UTF-8');assert.equal(recorded(paths.preview).length,before);await context.close();
  });
  await t.test('409 invalidates old consent and offers fresh preview without a write retry',async()=>{
    const {page,context}=await pageFor();await pick(page);await page.locator('.gi-confirm input').check();
    fake.state.rules.rev++;
    await page.getByRole('button',{name:'2개 적용',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('미리보기 뒤 필터 상태가 바뀌었어요.');await expect(page.locator('.gi-confirm')).toHaveCount(0);
    assert.equal(recorded(paths.apply).length,1);
    await page.getByRole('button',{name:'미리보기 다시 불러오기',exact:true}).click();
    await expect(page.locator('.gi-confirm input')).not.toBeChecked();assert.equal(recorded(paths.apply).length,1);await context.close();
  });
  await t.test('keyboard entry, file picker, confirmation and apply',async()=>{
    const {page,context}=await pageFor({route:'filters'});
    async function tabTo(selector) {
      for(let i=0;i<80;i++) {
        await page.keyboard.press('Tab');
        if(await page.evaluate(selector=>document.activeElement.matches(selector),selector))return;
      }
      assert.fail(`keyboard did not reach ${selector}`);
    }
    await tabTo('a[href="#filters/import"]');await page.keyboard.press('Enter');
    await expect(page.getByRole('heading',{name:'Gmail 필터 가져오기',exact:true})).toBeVisible();
    await tabTo('input[type=file]');
    const picker=page.waitForEvent('filechooser');await page.keyboard.press('Enter');await (await picker).setFiles(file);
    await expect(page.locator('.gi-table')).toBeVisible();
    await tabTo('.gi-confirm input');await page.keyboard.press('Space');
    await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'취소',exact:true})).toBeFocused();
    await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'2개 적용',exact:true})).toBeFocused();
    await page.keyboard.press('Enter');await expect(page.locator('#filters-title')).toHaveText('필터와 규칙');
    await expect(page.locator('.gi-result')).toContainText('2개를 반영했어요');
    await tabTo('.gi-result button');await page.keyboard.press('Enter');
    await expect(page.locator('.gi-undo')).toBeVisible();
    await expect(page.locator('.gi-undo button').first()).toBeFocused();
    await page.keyboard.press('Tab');await expect(page.locator('.gi-undo button').last()).toBeFocused();
    await page.keyboard.press('Shift+Tab');await expect(page.locator('.gi-undo button').first()).toBeFocused();
    await page.keyboard.press('Tab');await page.keyboard.press('Enter');
    await expect(page.locator('.gi-result')).toContainText('되돌렸어요.');
    await expect(page.locator('.gi-result button')).toHaveCount(0);await context.close();
  });
  await t.test('delayed apply blocks cancel/filter links, refreshes parent and preserves other routes',async()=>{
    for(const leave of [false,true]) {
      const {page,context}=await pageFor();await pick(page);await page.locator('.gi-confirm input').check();
      let release;
      const gate=new Promise(resolve=>{release=resolve;});
      await page.route(`**${paths.apply}`,async route=>{await gate;await route.continue();});
      const before=recorded('/api/rules').filter(request=>request.method==='GET').length;
      await page.getByRole('button',{name:'2개 적용',exact:true}).click();
      const cancel=page.getByRole('link',{name:'취소',exact:true});await expect(cancel).toHaveAttribute('aria-disabled','true');
      await cancel.focus();await page.keyboard.press('Enter');assert.equal(new URL(page.url()).hash,'#filters/import');
      const links=page.locator('.set-head a[href="#filters"]');await expect(links).toHaveCount(2);
      for(let i=0;i<2;i++) {await expect(links.nth(i)).toHaveAttribute('aria-disabled','true');await links.nth(i).focus();await page.keyboard.press('Enter');assert.equal(new URL(page.url()).hash,'#filters/import');}
      if(leave) {await page.evaluate(()=>{location.hash='filters/vacation';});await expect(page.locator('.gi-body')).toHaveCount(0);}
      const applied=page.waitForResponse(response=>response.url().endsWith(paths.apply));release();await applied;
      await expect.poll(()=>recorded('/api/rules').filter(request=>request.method==='GET').length).toBe(before+1);
      if(leave)assert.equal(new URL(page.url()).hash,'#filters/vacation');
      else {await expect(page.locator('#filters-title')).toHaveText('필터와 규칙');await expect(page.locator('.rules .rule')).toHaveCount(7);}
      await context.close();
    }
  });
  async function applyFile(page) {
    await pick(page);await page.locator('.gi-confirm input').check();
    await page.getByRole('button',{name:'2개 적용',exact:true}).click();
    await expect(page.locator('#filters-title')).toHaveText('필터와 규칙');
    await expect(page.locator('.gi-result')).toContainText('2개를 반영했어요');
  }
  await t.test('result, preserved exclusions, undo warnings and undo with exact at/CSRF',async()=>{
    const {page,context}=await pageFor();await applyFile(page);
    await expect(page.locator('.gi-result')).toContainText('1개는 버렸어요');
    await expect(page.locator('.gi-result')).toContainText('새로 만든 폴더 1개는 되돌려도 남아요');
    await page.locator('.gi-dropped summary').click();
    await expect(page.locator('.gi-dropped li')).toContainText('포함하는 단어: body:example · 별표');
    await expect(page.locator('.gi-dropped li')).toContainText('본문 조건은 옮길 수 없어요');
    const at=fake.state.rules.importInfo.at;
    await page.locator('.gi-result button').click();
    await expect(page.locator('.gi-undo')).toContainText('적용 뒤 바꾼 차단 주소·부재중도 함께 돌아가요');
    await expect(page.locator('.gi-undo')).toContainText('새로 만든 폴더는 남아요');
    await page.locator('.gi-undo button').last().click();
    await expect(page.locator('.gi-result')).toContainText('되돌렸어요');
    await expect(page.locator('.rules .rule')).toHaveCount(5);
    await expect(page.locator('.gi-dropped')).toHaveCount(0);
    assert.deepEqual(recorded(paths.undo).at(-1).body,{at});
    assert.equal(recorded(paths.undo).at(-1).csrf,fake.state.csrf);
    assert.ok(fake.state.folders.some(folder=>folder.path==='신규 폴더'));await context.close();
  });
  await t.test('a second import replaces undo and undo does not revive the older record',async()=>{
    const {page,context}=await pageFor();await applyFile(page);
    const firstAt=fake.state.rules.importInfo.at;
    await page.getByRole('link',{name:'Gmail 필터 가져오기',exact:true}).click();await pick(page);
    await expect(page.locator('.gi-notes')).toContainText('이전에 가져온 필터의 되돌리기 기록은 이번 가져오기로 바뀌어요');
    await page.locator('.gi-confirm input').check();await page.getByRole('button',{name:'2개 적용',exact:true}).click();
    await expect(page.locator('.rules .rule')).toHaveCount(9);
    const secondAt=fake.state.rules.importInfo.at;assert.notEqual(firstAt,secondAt);
    await page.locator('.gi-result button').click();await page.locator('.gi-undo button').last().click();
    await expect(page.locator('.gi-result')).toContainText('되돌렸어요');await expect(page.locator('.rules .rule')).toHaveCount(7);
    await expect(page.locator('.gi-result button')).toHaveCount(0);await expect(page.locator('.gi-dropped')).toHaveCount(0);
    assert.deepEqual(recorded(paths.undo).at(-1).body,{at:secondAt});assert.equal(fake.state.rules.importInfo,undefined);
    await context.close();
  });
  await t.test('UNDO_EDITED requires a fresh explicit check before acceptEdits retry',async()=>{
    const {page,context}=await pageFor();await applyFile(page);
    // A concurrent edit after the last GET must still require confirmation.
    fake.state.rules.importInfo.undo.edited=true;
    await page.locator('.gi-result button').click();await page.locator('.gi-undo button').last().click();
    await expect(page.locator('.gi-undo-edited')).toContainText('고친 내용도 사라져요');
    await expect(page.locator('.gi-undo-edited input')).not.toBeChecked();
    await expect(page.locator('.gi-undo button').last()).toBeDisabled();
    assert.equal(recorded(paths.undo).length,1);assert.equal(Object.hasOwn(recorded(paths.undo)[0].body,'acceptEdits'),false);
    const editedAxe=await new AxeBuilder({page}).include('.gi-undo').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(editedAxe.violations.map(item=>item.id),[]);
    await page.screenshot({path:`${captures}/gmail-undo-edited-1280-light.png`,fullPage:true});
    await page.locator('.gi-undo-edited input').check();await page.locator('.gi-undo button').last().click();
    await expect(page.locator('.gi-result')).toContainText('되돌렸어요');
    assert.equal(recorded(paths.undo).length,2);assert.equal(recorded(paths.undo)[1].body.acceptEdits,true);
    noNull(recorded(paths.undo)[1].body);await context.close();
  });
  await t.test('GET importInfo keeps undo after reload, edited warning is shown early, unavailable hides it',async()=>{
    const {page,context}=await pageFor();await applyFile(page);
    fake.state.rules.importInfo.undo.edited=true;
    await page.reload();await expect(page.locator('.gi-result button')).toBeVisible();await page.locator('.gi-result button').click();
    await expect(page.locator('.gi-undo-edited')).toBeVisible();await expect(page.locator('.gi-undo button').last()).toBeDisabled();
    await page.keyboard.press('Escape');await expect(page.locator('.gi-undo')).not.toBeVisible();
    fake.state.rules.importInfo.undo.available=false;fake.state.rules.importInfo.droppedTruncated=2;
    await page.reload();await expect(page.locator('.rules .rule')).toHaveCount(7);
    await expect(page.locator('.gi-result button')).toHaveCount(0);await expect(page.locator('.gi-dropped')).toBeVisible();await expect(page.locator('.gi-dropped summary')).toContainText('외 2개');
    assert.equal(recorded(paths.undo).length,0);await context.close();
  });
  await t.test('UNDO_SOURCE_CHANGED explains the conflict and does not show undo success',async()=>{
    const {page,context}=await pageFor();await applyFile(page);
    fake.state.rulesError={code:'UNDO_SOURCE_CHANGED',message:'synthetic source conflict'};
    await page.locator('.gi-result button').click();await page.locator('.gi-undo button').last().click();
    await expect(page.locator('.gi-undo [role=alert]')).toContainText('돌아갈 서버 필터가 다른 곳에서 바뀌었어요');
    await expect(page.locator('.gi-undo [role=alert]')).toContainText('덮어쓰지 않았어요');
    await expect(page.locator('.gi-result')).not.toContainText('되돌렸어요');assert.equal(recorded(paths.undo).length,1);await context.close();
  });
  await t.test('write failure only claims unchanged filters when restored is exactly true',async()=>{
    for(const restored of [true,false,undefined]) {
      const {page,context}=await pageFor();await pick(page);await page.locator('.gi-confirm input').check();
      fake.state.rulesError={code:'IMPORT_WRITE_FAILED',message:'synthetic write failure',detail:{...(restored===undefined?{}:{restored})}};
      await page.getByRole('button',{name:'2개 적용',exact:true}).click();
      if(restored===true)await expect(page.getByRole('alert')).toContainText('필터는 그대로예요');
      else {await expect(page.getByRole('alert')).toContainText('돌아갔는지 확인할 수 없어요');await expect(page.getByRole('alert')).not.toContainText('필터는 그대로예요');}
      await expect(page.locator('.gi-confirm input')).not.toBeChecked();await context.close();
    }
  });
  await t.test('folder failure names the failed folder and any created folders',async()=>{
    for(const created of [[],['부모 폴더']]) {
      const {page,context}=await pageFor();await pick(page);await page.locator('.gi-confirm input').check();
      fake.state.rulesError={code:'FOLDER_CREATE_FAILED',message:'synthetic folder failure',detail:{folder:'부모 폴더/새 폴더',created}};
      await page.getByRole('button',{name:'2개 적용',exact:true}).click();
      await expect(page.getByRole('alert')).toContainText('‘부모 폴더/새 폴더’ 폴더를 만들지 못해 적용하지 않았어요');
      if(created.length)await expect(page.getByRole('alert')).toContainText('이미 만든 폴더 1개(부모 폴더)는 남아 있어요');
      await context.close();
    }
  });
  await t.test('newer_version shows read-only rules and blocks import, edits and undo',async()=>{
    const {page,context}=await pageFor({state:'newer_version',route:'filters'});
    await expect(page.locator('.rules-banner')).toContainText('새 버전 웹메일에서 만든 필터예요. 지금은 볼 수만 있어요');
    await expect(page.getByRole('list',{name:'필터 규칙 (읽기 전용)',exact:true})).toBeVisible();
    await expect(page.locator('.rules .rule')).toHaveCount(5);await expect(page.locator('.rules .ops')).toHaveCount(0);
    await expect(page.locator('a[href="#filters/import"],a[href="#rule"]')).toHaveCount(0);
    fake.state.rules.importInfo={at:'2026-10-20T00:00:00Z',source:{kind:'gmail-xml',name:'mailFilters.xml'},mode:'append',dropped:[],undo:{available:true,edited:false}};
    await page.reload();await expect(page.locator('.rules-banner')).toContainText('볼 수만 있어요');
    await expect(page.locator('.gi-result button')).toHaveCount(0);
    await page.evaluate(()=>{location.hash='filters/import';});await expect(page.locator('.rules-banner')).toContainText('볼 수만 있어요');
    await expect(page.locator('input[type=file]')).toHaveCount(0);assert.equal(recorded(paths.preview).length,0);await context.close();
  });
  await t.test('partial server import sends report.planSha256 and preserves unconvertible and no exclusions',async()=>{
    const {page,context}=await pageFor({state:'import_pending',route:'filters'});
    fake.state.rules.importReport.items.push({n:4,summary:'보낸 사람 blocked@example.com → 별표',status:'no',reason:'합성 미지원 조건',changes:[]});
    await page.reload();await expect(page.locator('.rules-banner')).toContainText('반영할 수 있는 규칙만 가져와요');
    await expect(page.locator('.gi-tr-no')).toHaveCount(2);
    await page.locator('.gi-confirm input').check();await page.getByRole('button',{name:'2개 적용',exact:true}).click();
    await expect(page.locator('.gi-result')).toContainText('기존 필터 2개를 반영했어요 · 2개는 버렸어요');
    assert.deepEqual(recorded('/api/rules/import').at(-1).body,{confirm:true,sourceName:'rainloop.user',sourceSha256:'a'.repeat(64),planSha256:'b'.repeat(64)});
    await page.locator('.gi-dropped summary').click();await expect(page.locator('.gi-dropped li')).toHaveCount(2);
    await expect(page.locator('.gi-dropped')).toContainText('body@example.com → 별표');
    await expect(page.locator('.gi-dropped')).toContainText('blocked@example.com → 별표');
    await context.close();
  });
  await t.test('server preview conflict offers reload and blocks retry until refreshed',async()=>{
    const {page,context}=await pageFor({state:'import_pending',route:'filters'});
    await page.locator('.gi-confirm input').check();fake.state.rules.importReport.planSha256='c'.repeat(64);
    await page.getByRole('button',{name:'2개 적용',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('미리보기 뒤 필터 상태가 바뀌었어요');
    await expect(page.getByRole('button',{name:'2개 적용',exact:true})).toBeDisabled();
    fake.state.rulesError=null;await page.getByRole('button',{name:'다시 불러오기',exact:true}).click();
    await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.locator('.gi-confirm input')).not.toBeChecked();await context.close();
  });
  await t.test('applied result and undo dialog 1280/390 light/dark: overflow zero and axe zero',async()=>{
    for(const width of [1280,390])for(const mode of ['light','dark']) {
      const {page,context,errors}=await pageFor({width,mode});await applyFile(page);
      await page.locator('.gi-dropped summary').click();await page.locator('.filters-view .scroll').evaluate(el=>{el.scrollTop=0;});await page.evaluate(()=>document.fonts.ready);
      const overflow=()=>page.evaluate(()=>({page:document.documentElement.scrollWidth-innerWidth,scroll:document.querySelector('.filters-view .scroll').scrollWidth-document.querySelector('.filters-view .scroll').clientWidth}));
      assert.deepEqual(await overflow(),{page:0,scroll:0},`${width} ${mode} result overflow`);
      const axe=await new AxeBuilder({page}).include('.gi-result').include('.gi-dropped').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      assert.deepEqual(axe.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.failureSummary)})),[],`${width} ${mode} result axe`);
      await page.screenshot({path:`${captures}/gmail-result-${width}-${mode}.png`,fullPage:true});
      await page.locator('.gi-result button').click();
      const dialogAxe=await new AxeBuilder({page}).include('.gi-undo').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      assert.deepEqual(dialogAxe.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.failureSummary)})),[],`${width} ${mode} undo axe`);
      const dialogOverflow=await page.locator('.gi-undo').evaluate(el=>({overflow:el.scrollWidth-el.clientWidth,right:el.getBoundingClientRect().right}));
      assert.equal(dialogOverflow.overflow,0);assert.ok(dialogOverflow.right<=width);
      await page.screenshot({path:`${captures}/gmail-undo-${width}-${mode}.png`,fullPage:true});
      await page.locator('.gi-undo button').last().click();await expect(page.locator('.gi-result')).toContainText('되돌렸어요');
      await page.locator('.filters-view .scroll').evaluate(el=>{el.scrollTop=0;});
      await page.screenshot({path:`${captures}/gmail-undone-${width}-${mode}.png`,fullPage:true});
      assert.deepEqual(errors,[]);await context.close();
    }
  });
  await t.test('1280/768/800/390 light/dark: no overflow, container layout, axe including contrast',async()=>{
    for(const width of [1280,768,800,390])for(const mode of ['light','dark']) {
      const {page,context,errors}=await pageFor({width,mode});await pick(page);await page.evaluate(()=>document.fonts.ready);
      const overflow=await page.evaluate(()=>({page:document.documentElement.scrollWidth-innerWidth,scroll:document.querySelector('.filters-view .scroll').scrollWidth-document.querySelector('.filters-view .scroll').clientWidth,table:document.querySelector('.gi-tablewrap').scrollWidth-document.querySelector('.gi-tablewrap').clientWidth}));
      assert.deepEqual(overflow,{page:0,scroll:0,table:0},`${width} ${mode} overflow`);
      const layout=await page.locator('.gi-tablewrap').evaluate(el=>({width:el.clientWidth,row:getComputedStyle(el.querySelector('.gi-tr')).display}));
      assert.equal(layout.row,layout.width<=720?'grid':'table-row');
      const axe=await new AxeBuilder({page}).include('.gi-body').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      assert.deepEqual(axe.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>({target:node.target,summary:node.failureSummary}))})),[],`${width} ${mode} axe`);
      await page.screenshot({path:`${captures}/gmail-import-${width}-${mode}.png`,fullPage:true});
      await page.locator('.gi-apply').scrollIntoViewIfNeeded();
      await page.locator('.gi-confirm input').check();
      await expect(page.getByRole('button',{name:'2개 적용',exact:true})).toBeEnabled();
      const consentAxe=await new AxeBuilder({page}).include('.gi-body').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      assert.deepEqual(consentAxe.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.failureSummary)})),[],`${width} ${mode} consent axe`);
      await page.screenshot({path:`${captures}/gmail-import-${width}-${mode}-apply.png`,fullPage:true});
      assert.deepEqual(errors,[]);await context.close();
    }
  });
});
