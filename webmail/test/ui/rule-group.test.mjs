import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createFakeApi } from '../../web/dev/fake-api.js';
import { validateDocument, minimumDocumentVersion } from '../../server/sieve/model.js';
import { rulesFixture } from '../../web/dev/fake-rules.js';
const captures=process.env.RULE_GROUP_CAPTURE_DIR || '/tmp/webmail-rule-group-captures';
const fake=createFakeApi({authenticated:true});
const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'rule-group-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
await server.listen();
const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
await mkdir(captures,{recursive:true});
const leaf=value=>({field:'subject',op:'has',value});
const group=(match='any',count=2)=>({match,conditions:Array.from({length:count},(_,i)=>leaf(`조건 ${i+1}`))});
const base=conditions=>({id:'group001',enabled:true,match:'all',conditions,actions:{read:true},stop:false});
await test('condition group editor',async t=>{
  t.after(async()=>{await browser.close();await server.close();});
  async function open(rule=base([leaf('견적')]),width=1280,mode='light') {
    const context=await browser.newContext({viewport:{width,height:900}});
    await context.addInitScript(mode=>localStorage.setItem('webmail-prefs',JSON.stringify({theme:'ink',mode})),mode);
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const fixture=rulesFixture('ok',{doc:{...rulesFixture().doc,v:minimumDocumentVersion([rule]),rules:[rule]}});
    await page.route('**/api/prefs',route=>route.fulfill({json:{...fake.state.prefs,theme:'ink',mode}}));
    await page.route('**/api/rules',route=>route.request().method()==='GET'?route.fulfill({json:fixture}):route.fulfill({json:{rev:8}}));
    await page.route('**/api/rules/preview',route=>route.fulfill({json:{count:0,items:[],scanned:24,limited:false,partial:false}}));
    await page.goto(`${origin}/#rule/group001`);
    await expect(page.getByRole('heading',{name:'규칙 수정',exact:true})).toBeVisible();
    await expect(page.locator('.cond').first()).toBeVisible();await expect(page.locator('html')).toHaveAttribute('data-mode',mode);return {page,context,errors};
  }
  async function save(page) {
    const apply=page.getByRole('checkbox',{name:/이미 받은 메일/});await expect(apply).toBeEnabled();await apply.uncheck();
    const request=page.waitForRequest(req=>req.method()==='PUT'&&new URL(req.url()).pathname==='/api/rules');
    await page.getByRole('button',{name:'규칙 저장',exact:true}).click();const doc=(await request).postDataJSON().doc;
    validateDocument(doc,{checkPolicy:false});
    assert.equal(doc.v,minimumDocumentVersion(doc.rules));return doc.rules[0];
  }
  const combination=page=>page.getByRole('group',{name:'묶음 1 조건 결합',exact:true});
  await t.test('newer-version banner reports only the actual active filter',async()=>{
    for(const [activeName,label,message] of [['webmail-rules','active','필터는 서버에서 계속 동작해요.'],[null,'inactive','필터가 꺼져 있어요'],['legacy','other','필터가 다른 프로그램에서 바뀌었어요']]) {
      for(const width of [1280,768,375]) {
        const context=await browser.newContext({viewport:{width,height:900}});
        const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
        const fixture=rulesFixture('newer_version',{activeName,activeScript:activeName,prevAvailable:false});
        await page.route('**/api/rules',route=>route.fulfill({json:fixture}));
        await page.goto(`${origin}/#filters`);
        await expect(page.locator('.rules-banner')).toHaveText(`새 버전 웹메일에서 만든 필터예요. 지금은 볼 수만 있어요. ${message}`);
        if(activeName!=='webmail-rules')await expect(page.locator('.rules-banner')).not.toContainText('계속 동작');
        await expect(page.locator('.rules-banner button')).toHaveCount(0);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await page.evaluate(()=>document.fonts.ready);
        await page.screenshot({path:`${captures}/newer-version-${label}-${width}.png`});
        assert.deepEqual(errors,[]);await context.close();
      }
    }
  });
  await t.test('flat rules retain condition rows, labels and saved request',async()=>{
    const {page,context,errors}=await open();await expect(page.locator('.rule-condition-group')).toHaveCount(0);
    await expect(page.getByLabel('1번 조건 값',{exact:true})).toHaveValue('견적');
    assert.deepEqual((await save(page)).conditions,[leaf('견적')]);assert.deepEqual(errors,[]);await context.close();
  });
  await t.test('existing-mail result reports skipped priority matches only when present',async()=>{
    for (const [width,skipped] of [[1280,2],[768,2],[375,2],[375,0]]) {
      const {page,context,errors}=await open(base([leaf('견적')]),width);
      await page.route('**/api/rules/apply-existing',route=>route.fulfill({json:{matched:3,moved:0,trashed:0,flagged:3-skipped,failed:[],...(skipped?{skipped}:{})}}));
      await expect(page.getByRole('button',{name:'규칙 저장',exact:true})).toBeEnabled();
      await expect(page.getByRole('checkbox',{name:/이미 받은 메일/})).toBeChecked();
      await page.getByRole('button',{name:'규칙 저장',exact:true}).click();
      await expect(page.locator('.toast.rule-result')).toContainText('기존 메일 3통 일치');
      if(skipped) await expect(page.locator('.toast.rule-result')).toContainText('위 규칙에 먼저 해당돼 2통은 건너뛰었어요');
      else await expect(page.locator('.toast.rule-result')).not.toContainText('건너뛰었어요');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if(skipped) await page.screenshot({path:`${captures}/existing-priority-skipped-${width}.png`,fullPage:true});
      assert.deepEqual(errors,[]);await context.close();
    }
  });
  await t.test('body editor blocks existing-mail application, saves/reopens v2 and never polls unavailable preview',async()=>{
    for (const width of [1280,768,375]) {
      const {page,context,errors}=await open(base([{field:'subject',op:'eq',value:'견적'}]),width);
      let savedDoc,previews=0,applications=0;
      await page.route('**/api/rules/preview',route=>{previews++;const body=route.request().postDataJSON().rule.conditions.some(c=>c.field==='body'||c.conditions?.some(c=>c.field==='body'));return route.fulfill({json:body?{state:'body_unavailable',partial:false}:{count:0,items:[],scanned:24,limited:false,partial:false}});});
      await page.route('**/api/rules',route=>{
        if(route.request().method()==='PUT'){savedDoc=route.request().postDataJSON().doc;return route.fulfill({json:{rev:8}});}
        return savedDoc?route.fulfill({json:rulesFixture('ok',{doc:savedDoc,rev:8})}):route.fallback();
      });
      await page.route('**/api/rules/apply-existing',route=>{applications++;return route.fulfill({json:{matched:0,moved:0,trashed:0,flagged:0,failed:[]}});});
      await page.getByLabel('1번 조건 항목',{exact:true}).selectOption('body');
      await expect(page.getByLabel('1번 조건 방식',{exact:true})).toHaveValue('has');
      assert.deepEqual(await page.getByLabel('1번 조건 방식',{exact:true}).locator('option').allTextContents(),['포함','포함 안 됨']);
      await page.getByLabel('1번 조건 방식',{exact:true}).selectOption('not');
      await expect(page.locator('.preview header')).toContainText('본문 조건은 미리 셀 수 없어요');
      await expect(page.locator('.preview')).toHaveAttribute('aria-busy','false');
      const checked=page.locator('.save-row input[type=checkbox]');await expect(checked).not.toBeChecked();await expect(checked).toBeDisabled();
      await expect(page.locator('.save-row')).toContainText('본문 조건은 새로 오는 메일부터 적용돼요');
      const before=previews;await page.waitForTimeout(1700);assert.equal(previews,before);
      await expect(page.getByRole('button',{name:'규칙 저장',exact:true})).toBeEnabled();
      await page.getByRole('button',{name:'규칙 저장',exact:true}).click();
      await expect(page.locator('.toast')).toContainText('규칙을 저장했어요');
      assert.equal(applications,0);assert.equal(savedDoc.v,2);validateDocument(savedDoc,{checkPolicy:false});
      assert.deepEqual(savedDoc.rules[0].conditions,[{field:'body',op:'not',value:'견적'}]);
      await expect(page.locator('.rules .say')).toContainText('본문에 견적이 없으면');
      await page.goto(`${origin}/#rule/group001`);
      await expect(page.getByLabel('1번 조건 항목',{exact:true})).toHaveValue('body');
      await expect(page.getByLabel('1번 조건 방식',{exact:true})).toHaveValue('not');
      await expect(page.locator('.preview header')).toContainText('본문 조건은 미리 셀 수 없어요');
      await page.locator('.toast button').click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:`${captures}/body-editor-${width}.png`,fullPage:true});
      await page.locator('.rule-builder-view .scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});
      await page.screenshot({path:`${captures}/body-editor-${width}-bottom.png`,fullPage:true});
      assert.deepEqual((await new AxeBuilder({page}).include('.rule-builder-view').analyze()).violations,[]);
      await page.getByLabel('1번 조건 항목',{exact:true}).selectOption('subject');
      await expect(page.locator('.preview header')).toContainText('통 · 지금 조건에 맞는 메일');
      await expect(checked).toBeChecked();await expect(checked).toBeEnabled();
      assert.equal(applications,0);
      assert.deepEqual(errors,[]);await context.close();
    }
  });
  await t.test('first-match policy has no stop checkbox for either stored stop value',async()=>{
    for (const stop of [false,true]) {
      const {page,context}=await open({...base([leaf('견적')]),stop});
      await expect(page.getByRole('checkbox',{name:'이후 규칙 멈춤'})).toHaveCount(0);
      await expect(page.locator('.rule-note').filter({hasText:'위에서부터 처음 맞는 규칙 하나만 적용'})).toBeVisible();
      assert.equal((await save(page)).stop,stop);
      await context.close();
    }
  });
  await t.test('create group and save canonical nested request also used for preview',async()=>{
    const {page,context}=await open();await page.getByRole('button',{name:'묶음 추가',exact:true}).click();
    await expect(page.getByRole('group',{name:'묶음 1',exact:true})).toBeVisible();
    await page.getByLabel('묶음 1의 1번 조건 값',{exact:true}).fill('발주');await page.getByLabel('묶음 1의 2번 조건 값',{exact:true}).fill('견적');
    const preview=page.waitForRequest(req=>req.url().endsWith('/api/rules/preview')&&req.postDataJSON().rule.conditions.length===2);
    const saved=await save(page);assert.deepEqual(saved.conditions,[leaf('견적'),{match:'any',conditions:[leaf('발주'),leaf('견적')]}]);
    assert.deepEqual((await preview).postDataJSON().rule.conditions,saved.conditions);await context.close();
  });
  await t.test('same conjunction flattens saved rule while retaining draft box',async()=>{
    const {page,context}=await open(base([leaf('견적'),group()]));
    await combination(page).getByRole('button',{name:'모두 맞을 때',exact:true}).click();await expect(page.locator('.rule-condition-group')).toHaveCount(1);
    assert.deepEqual((await save(page)).conditions,[leaf('견적'),...group().conditions]);await context.close();
  });
  await t.test('outer conjunction toggles and saves with opposite child conjunction',async()=>{
    const {page,context}=await open(base([leaf('견적'),group()]));
    await combination(page).getByRole('button',{name:'모두 맞을 때',exact:true}).click();
    await page.getByRole('group',{name:'조건 결합',exact:true}).getByRole('button',{name:'하나라도 맞을 때',exact:true}).click();
    const saved=await save(page);assert.equal(saved.match,'any');assert.deepEqual(saved.conditions,[leaf('견적'),group('all')]);await context.close();
  });
  await t.test('single remaining group is promoted to root',async()=>{
    const {page,context}=await open(base([leaf('견적'),group()]));await page.getByRole('button',{name:'1번 조건 빼기',exact:true}).click();
    const saved=await save(page);assert.equal(saved.match,'any');assert.deepEqual(saved.conditions,group().conditions);await context.close();
  });
  await t.test('normalization exceeding ten root children blocks save with shared message',async()=>{
    const {page,context}=await open(base([leaf('견적'),group('any',10)]));await combination(page).getByRole('button',{name:'모두 맞을 때',exact:true}).click();
    await expect(page.getByRole('button',{name:'규칙 저장',exact:true})).toBeDisabled();await expect(page.getByRole('status')).toContainText('조건 묶음 모양을 확인');await context.close();
  });
  await t.test('root ten, child ten, total twenty and child minimum two limits',async()=>{
    for(const conditions of [Array.from({length:10},(_,i)=>leaf(`조건 ${i}`)),[group('any',10),group('any',10)]]) {
      const {page,context}=await open(base(conditions));await expect(page.getByRole('button',{name:'조건 추가',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'묶음 추가',exact:true})).toBeDisabled();
      for(const button of await page.getByRole('button',{name:'이 묶음에 조건 추가',exact:true}).all())await expect(button).toBeDisabled();await context.close();
    }
    const {page,context}=await open(base([leaf('견적'),group()]));await expect(page.getByRole('button',{name:'묶음 1의 1번 조건 빼기',exact:true})).toBeDisabled();await context.close();
  });
  await t.test('pattern rejects question mark and permits escaped question mark',async()=>{
    const {page,context}=await open();await page.getByLabel('1번 조건 방식',{exact:true}).selectOption('matches');await page.getByLabel('1번 조건 값',{exact:true}).fill('*견?적*');
    await expect(page.locator('#rule-pattern-note')).toContainText('?는 사용할 수 없어요');await expect(page.getByRole('button',{name:'규칙 저장',exact:true})).toBeDisabled();await expect(page.getByRole('status')).toContainText('물음표');
    await page.getByLabel('1번 조건 값',{exact:true}).fill('*견\\?적*');assert.equal((await save(page)).conditions[0].op,'matches');await context.close();
  });
  await t.test('summary keeps group parentheses, both conjunctions and address/subject patterns in editor and list',async()=>{
    for(const match of ['all','any']) {
      const rule={...base([{match:match==='all'?'any':'all',conditions:[leaf('견적'),leaf('발주')]},{field:'from',op:'matches',value:'noreply-*@ci.example.com'},{field:'to',op:'matches',value:'team*@example.com'},{field:'subject',op:'matches',value:'*소식*'}]),match};
      const {page,context,errors}=await open(rule);
      const inner=match==='all'?' 또는 ':' 그리고 ',outer=match==='all'?' 그리고 ':' 또는 ';
      const expected=`(제목에 견적이 있으면${inner}제목에 발주이 있으면)${outer}보낸 사람 주소가 패턴 noreply-*@ci.example.com에 맞으면${outer}받는 사람(To·Cc) 주소가 패턴 team*@example.com에 맞으면${outer}제목이 패턴 *소식*에 맞으면 → 읽음으로 표시`;
      await expect(page.locator('.summary')).toHaveText(`이렇게 동작합니다${expected}`);
      await page.evaluate(()=>{location.hash='filters';});await expect(page.locator('.rules .say')).toHaveText(expected);
      assert.deepEqual(errors,[]);await context.close();
    }
  });
  await t.test('client saved minimum version agrees with server for identical feature fixtures',async()=>{
    const pattern={field:'subject',op:'matches',value:'*소식*'};
    const fixtures=[[leaf('견적')],[{field:'from',op:'start',value:'team'},{field:'attachment',op:'has',value:''}],[pattern],[leaf('견적'),group()],[leaf('견적'),{match:'any',conditions:[pattern,leaf('발주')]}]];
    assert.deepEqual(fixtures.map(conditions=>minimumDocumentVersion([base(conditions)])),[1,1,2,2,2]);
    for(const conditions of fixtures) {
      const {page,context}=await open(base(conditions));await save(page);await context.close();
    }
  });
  await t.test('keyboard only: add, toggle, edit, remove, restore focus and save',async()=>{
    const {page,context}=await open();
    async function tabTo(target){for(let i=0;i<100;i++){if(await target.evaluate(el=>el===document.activeElement))return;await page.keyboard.press('Tab');}assert.fail('keyboard target not reached');}
    await tabTo(page.getByRole('button',{name:'묶음 추가',exact:true}));await page.keyboard.press('Enter');
    const all=combination(page).getByRole('button',{name:'모두 맞을 때',exact:true});await expect(all).toBeFocused();await page.keyboard.press('Enter');await expect(all).toHaveAttribute('aria-pressed','true');
    await page.keyboard.press('Tab');await page.keyboard.press('Enter');
    await tabTo(page.getByRole('button',{name:'이 묶음에 조건 추가',exact:true}));await page.keyboard.press('Enter');await expect(page.getByLabel('묶음 1의 3번 조건 항목',{exact:true})).toBeFocused();
    await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.type('긴급');await page.keyboard.press('Tab');await page.keyboard.press('Enter');await expect(page.getByLabel('묶음 1의 2번 조건 항목',{exact:true})).toBeFocused();
    await tabTo(page.getByLabel('묶음 1의 1번 조건 값',{exact:true}));await page.keyboard.type('발주');await tabTo(page.getByLabel('묶음 1의 2번 조건 값',{exact:true}));await page.keyboard.type('견적');
    await tabTo(page.getByRole('button',{name:'묶음 1 빼기',exact:true}));await page.keyboard.press('Enter');await expect(page.getByLabel('1번 조건 항목',{exact:true})).toBeFocused();
    await tabTo(page.getByRole('checkbox',{name:/이미 받은 메일/}));await page.keyboard.press('Space');await tabTo(page.getByRole('button',{name:'규칙 저장',exact:true}));
    const request=page.waitForRequest(req=>req.method()==='PUT'&&req.url().endsWith('/api/rules'));await page.keyboard.press('Enter');assert.deepEqual((await request).postDataJSON().doc.rules[0].conditions,[leaf('견적')]);await context.close();
  });
  await t.test('light/dark, desktop/mobile/tablet: no overflow, zero axe violations',async()=>{
    for(const [width,mode] of [[1280,'light'],[1280,'dark'],[390,'light'],[390,'dark'],[375,'light'],[768,'light']]) {
      const {page,context,errors}=await open(base([group(),{match:'any',conditions:[{field:'subject',op:'matches',value:'*소식*'},leaf('발주')]}]),width,mode);await expect(page.getByRole('button',{name:'규칙 저장',exact:true})).toBeEnabled();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('.rule-builder-view .scroll').evaluate(el=>el.scrollWidth>el.clientWidth),false);
      assert.deepEqual((await new AxeBuilder({page}).include('.rule-builder-view').analyze()).violations,[]);
      await page.screenshot({path:`${captures}/rule-group-${width}-${mode}.png`,fullPage:true});
      await page.locator('.rule-builder-view .scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});
      await page.screenshot({path:`${captures}/rule-group-${width}-${mode}-bottom.png`,fullPage:true});assert.deepEqual(errors,[]);await context.close();
    }
  });
});
