// Written for the browser-capable gate. Do not run on the constrained host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';
import { sanitizeNotice } from '../../server/notices/sanitize.js';

const captures=process.env.ADMIN_NOTICES_CAPTURE_DIR||'/tmp/admin-notices-captures';
const originalTime='2026-10-27T08:20:00Z',version='2026-10-28T05:00:00.123456Z';
const fixture=()=>[
  {id:1,title:'11월 2일 새벽 점검',bodyHtml:'<p><strong>11월 2일 새벽</strong>에 메일 서버 점검이 있어요.</p>',category:'maintenance',audienceAll:true,domains:[],pinned:true,state:'published',publishedAt:originalTime,updatedAt:version},
  {id:2,title:'필터에 본문 조건 추가',bodyHtml:'<p>본문 조건을 추가할 수 있어요.</p>',category:'update',audienceAll:true,domains:[],pinned:false,state:'published',publishedAt:originalTime,updatedAt:version},
  {id:3,title:'다크 모드 색 조정',bodyHtml:'<p>다크 모드 색을 조정했어요.</p>',category:'update',audienceAll:false,domains:['example.test'],pinned:false,state:'hidden',publishedAt:originalTime,updatedAt:version},
  {id:4,title:'준비 중인 공지',bodyHtml:'<p>임시 본문이에요.</p>',category:'info',audienceAll:true,domains:[],pinned:false,state:'draft',publishedAt:null,updatedAt:version},
];
await test('admin notices A: list, editor, microsecond contract and leave protection',async t=>{
  const fake=createFakeAdminApi();
  const server=await createServer({root:fileURLToPath(new URL('../../web',import.meta.url)),configFile:fileURLToPath(new URL('../../web/vite.admin.config.js',import.meta.url)),logLevel:'error',plugins:[{name:'admin-notices-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0,hmr:false}});
  await server.listen();t.after(()=>server.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());
  await mkdir(captures,{recursive:true});const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  async function open({width=1280,mode='light',hash='notices',enabled=true,rows=fixture(),holdSave=false,baseUrl=origin}={}) {
    const context=await browser.newContext({viewport:{width,height:1000},colorScheme:mode}),page=await context.newPage(),errors=[],requests=[];
    await context.addInitScript(mode=>localStorage.setItem('webmail-admin-prefs',JSON.stringify({theme:'ink',mode,accent:{}})),mode);
    page.on('pageerror',error=>errors.push(error.message));
    const state={rows:structuredClone(rows),enabled},resultVersion=()=>`2026-10-28T05:00:00.${String(++tick).padStart(6,'0')}Z`;
    let tick=123456,releaseSave;const gate=new Promise(resolve=>{releaseSave=resolve;});
    if(baseUrl!==origin)await page.route('**/api/admin/auth/session',route=>route.fulfill({json:{...fake.state.session,features:fake.state.features}}));
    await page.route('**/api/admin/domains',route=>route.fulfill({json:{items:[{domain:'example.test',active:true},{domain:'other.test',active:true},{domain:'inactive.test',active:false}]}}));
    await page.route('**/api/admin/notices**',async route=>{
      const req=route.request(),url=new URL(req.url()),body=req.method()==='GET'?undefined:req.postDataJSON();requests.push({path:url.pathname+url.search,method:req.method(),body});
      const fail=(status,code,message)=>route.fulfill({status,json:{error:{code,message}}});
      if(url.pathname.endsWith('/preview'))return route.fulfill({json:sanitizeNotice(body.bodyHtml)});
      if(req.method()==='GET'&&url.pathname==='/api/admin/notices')return route.fulfill({json:{enabled:state.enabled,items:state.enabled?state.rows.filter(row=>!url.searchParams.get('state')||url.searchParams.get('state')==='all'||row.state===url.searchParams.get('state')).map(({bodyHtml,...row})=>row):[]}});
      const parts=url.pathname.split('/'),id=Number(parts[4]),row=state.rows.find(row=>row.id===id),action=parts[5];
      if(req.method()==='GET')return row?route.fulfill({json:row}):fail(404,'NOT_FOUND','공지를 찾을 수 없어요.');
      assert.equal(req.headers()['x-mailadmin-csrf'],fake.state.session.csrf);assert.equal(req.headers().authorization,undefined);
      if(!state.enabled)return fail(503,'NOTICES_UNAVAILABLE','공지 저장소 준비 안 됨');
      if(row&&body.updatedAt!==row.updatedAt)return fail(409,'CONFLICT','다른 변경이 있어요. 공지를 다시 불러와 주세요.');
      if(holdSave)await gate;
      if(req.method()==='DELETE'){state.rows=state.rows.filter(row=>row.id!==id);return route.fulfill({json:{ok:true}});}
      if(action){if(action==='hide')row.state='hidden';if(action==='publish'){row.state='published';row.publishedAt??=originalTime;}if(action==='pin')row.pinned=true;if(action==='unpin')row.pinned=false;row.updatedAt=resultVersion();return route.fulfill({json:row});}
      const clean=sanitizeNotice(body.bodyHtml);if(clean.empty)return fail(422,'INVALID_INPUT','본문을 입력해 주세요.');
      const value={...(row||{id:Math.max(0,...state.rows.map(row=>row.id))+1,state:'draft',publishedAt:null}),title:body.title,bodyHtml:clean.bodyHtml,category:body.category,audienceAll:body.audienceAll,domains:body.audienceAll?[]:body.domains,pinned:body.pinned,updatedAt:resultVersion()};
      if(body.publish){value.state='published';value.publishedAt??=originalTime;}
      if(row)Object.assign(row,value);else state.rows.push(value);
      return route.fulfill({json:value});
    });
    const documentResponse=await page.goto(`${baseUrl.replace(/\/$/,'')}/admin.html#${hash}`);await expect(page.locator('[data-admin-page]')).toBeVisible();
    return {page,context,state,requests,errors,releaseSave,documentResponse,close:()=>context.close()};
  }
  const body=page=>page.frameLocator('iframe[title="서식 편집기"]').getByRole('textbox',{name:'본문'});
  async function fillBody(page,html='<p>새 공지 본문</p>') {
    await body(page).evaluate((node,value)=>{node.innerHTML=value;node.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));},html);
  }
  async function write(page,title='합성 새 공지') {await page.getByLabel('제목',{exact:true}).fill(title);await fillBody(page);}
  await t.test('menu order/group, four filters, empty filter, pin and hide/re-publish requests',async()=>{
    const f=await open();try{
      const nav=await f.page.locator('#nav a').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')));assert.equal(nav.indexOf('#notices'),nav.indexOf('#public-templates')-1);assert.equal(nav.indexOf('#public-templates'),nav.indexOf('#logo')-1);
      await expect(f.page.getByRole('button',{name:'전체',exact:true})).toHaveAttribute('aria-pressed','true');await expect(f.page.locator('.na-tr[data-id]')).toHaveCount(4);
      await f.page.getByRole('button',{name:'임시',exact:true}).click();await expect(f.page.locator('.na-tr[data-id]')).toHaveCount(1);await expect(f.page.locator('.na-tr[data-id] .ttl')).toHaveText('준비 중인 공지');
      await f.page.getByRole('button',{name:'숨김',exact:true}).click();await expect(f.page.locator('.na-tr[data-id="3"]')).toBeVisible();await f.page.locator('.na-tr[data-id="3"]').getByRole('button',{name:'다시 게시',exact:true}).click();await expect(f.page.getByText('이 상태의 공지가 없어요.',{exact:true})).toBeVisible();
      await f.page.getByRole('button',{name:'게시 중',exact:true}).click();const row=f.page.locator('.na-tr[data-id="2"]');await row.getByRole('button',{name:'위로 고정',exact:true}).click();await expect(row.getByRole('button',{name:'고정 해제',exact:true})).toHaveAttribute('aria-pressed','true');
      await row.getByRole('button',{name:'숨기기',exact:true}).click();await expect(row).toHaveCount(0);
      assert.ok(f.requests.some(call=>call.path==='/api/admin/notices?state=draft'));assert.ok(f.requests.some(call=>call.path==='/api/admin/notices/2/pin'&&call.body.updatedAt===version));assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  await t.test('new editor validates title/body/domains and reuses exactly six formatting commands',async()=>{
    const f=await open({hash:'notices/new'});try{
      await expect(f.page.locator('h1')).toHaveText('새 공지');await expect(f.page.locator('.fmt button')).toHaveCount(6);
      for(const label of ['굵게','기울임','링크','글머리 목록','번호 목록','문단'])await expect(f.page.getByRole('button',{name:label,exact:true})).toBeVisible();
      await expect(f.page.getByRole('button',{name:'그림 넣기',exact:true})).toHaveCount(0);await expect(f.page.getByRole('button',{name:'HTML 원문',exact:true})).toHaveCount(0);
      await f.page.getByRole('button',{name:'게시',exact:true}).click();await expect(f.page.getByText('제목을 입력해 주세요.',{exact:true})).toBeVisible();await expect(f.page.getByText('본문을 입력해 주세요.',{exact:true})).toBeVisible();
      await write(f.page);await f.page.getByLabel('도메인 지정',{exact:true}).check();await f.page.getByRole('button',{name:'게시',exact:true}).click();await expect(f.page.getByText('대상 도메인을 1개 이상 선택해 주세요.',{exact:true})).toBeVisible();
      await expect(f.page.getByLabel('inactive.test',{exact:true})).toHaveCount(0);await f.page.getByLabel('example.test',{exact:true}).check();await f.page.getByRole('button',{name:'임시 저장',exact:true}).click();await expect(f.page.locator('[data-admin-page=notices]')).toBeVisible();
      await expect(f.page.getByRole('status')).toContainText('임시 저장했어요.');const saved=f.state.rows.find(row=>row.title==='합성 새 공지');assert.equal(saved.state,'draft');assert.deepEqual(saved.domains,['example.test']);
      const calls=f.requests.filter(call=>call.method==='POST');assert.equal(calls.at(-2).path,'/api/admin/notices/preview');assert.equal(calls.at(-1).path,'/api/admin/notices');assert.equal(calls.at(-1).body.publish,false);assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  await t.test('server preview removes active HTML, save passes cleaned body, version stays microsecond, publication timestamp stays first',async()=>{
    const f=await open({hash:'notices/1'});try{
      await fillBody(f.page,'<p onclick="bad()">safe<img src=x></p>');await f.page.getByRole('button',{name:'미리보기',exact:true}).click();await expect(f.page.locator('.pv .nbody')).toHaveText('safe');await expect(f.page.locator('.pv img,.pv [onclick]')).toHaveCount(0);
      await expect(f.page.locator('.pv .when')).toContainText(/\d{2}:\d{2}:\d{2}/);await expect(f.page.locator('.pv .when')).not.toContainText('123456');
      await f.page.getByRole('button',{name:'쓰기',exact:true}).click();await f.page.getByLabel('제목',{exact:true}).fill('수정한 제목');await f.page.getByRole('button',{name:'저장',exact:true}).click();await expect(f.page.locator('[data-admin-page=notices]')).toBeVisible();
      const put=f.requests.find(call=>call.method==='PUT');assert.equal(put.body.updatedAt,version);assert.equal(put.body.bodyHtml,'<p>safe</p>');assert.equal(f.state.rows.find(row=>row.id===1).publishedAt,originalTime);
      assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  await t.test('reused editor preserves Enter as p and Shift+Enter as br through server sanitization',async()=>{
    const f=await open({hash:'notices/new'});try{
      await f.page.getByLabel('제목',{exact:true}).fill('문단과 줄바꿈');await body(f.page).fill('첫 문단');
      await body(f.page).press('End');await body(f.page).press('Enter');await body(f.page).pressSequentially('둘째 문단');await body(f.page).press('Shift+Enter');await body(f.page).pressSequentially('같은 문단 줄바꿈');
      await f.page.getByRole('button',{name:'임시 저장',exact:true}).click();await expect(f.page.locator('[data-admin-page=notices]')).toBeVisible();
      const saved=f.state.rows.find(row=>row.title==='문단과 줄바꿈');assert.ok(saved.bodyHtml.includes('<p>'));assert.ok(saved.bodyHtml.includes('<br>'));assert.ok(!saved.bodyHtml.includes('<div>'));
      assert.ok(saved.bodyHtml.includes('첫 문단'));assert.ok(saved.bodyHtml.includes('둘째 문단'));assert.ok(saved.bodyHtml.includes('같은 문단 줄바꿈'));
    }finally{await f.close();}
  });
  await t.test('save locks every editor action; success clears leave protection',async()=>{
    const f=await open({hash:'notices/new',holdSave:true});try{
      await write(f.page);await f.page.getByRole('button',{name:'게시',exact:true}).click();await expect(f.page.getByLabel('제목',{exact:true})).toBeDisabled();await expect(f.page.getByRole('button',{name:'취소',exact:true})).toBeDisabled();await expect(f.page.getByRole('button',{name:'미리보기',exact:true})).toBeDisabled();
      assert.equal(await body(f.page).getAttribute('contenteditable'),'false');f.releaseSave();await expect(f.page.locator('[data-admin-page=notices]')).toBeVisible();
      let questions=0;f.page.on('dialog',async dialog=>{questions++;await dialog.dismiss();});await f.page.locator('#nav a[href="#history"]').click();await expect(f.page).toHaveURL(/#history$/);assert.equal(questions,0);
    }finally{f.releaseSave();await f.close();}
  });
  await t.test('unsaved menu/hash/back/reload require confirmation, cancel preserves fields, delete needs explicit dialog',async()=>{
    const f=await open();try{
      await f.page.locator('.na-tr[data-id="1"]').getByRole('button',{name:'수정',exact:true}).click();await f.page.getByLabel('제목',{exact:true}).fill('저장 전 제목');let allow=false,questions=0;
      f.page.on('dialog',async dialog=>{questions++;if(allow)await dialog.accept();else await dialog.dismiss();});
      await f.page.goBack();await expect(f.page).toHaveURL(/#notices\/1$/);
      await f.page.locator('#nav a[href="#history"]').click();await expect(f.page).toHaveURL(/#notices\/1$/);await expect(f.page.getByLabel('제목',{exact:true})).toHaveValue('저장 전 제목');
      await f.page.evaluate(()=>{location.hash='accounts';});await expect(f.page).toHaveURL(/#notices\/1$/);
      await f.page.evaluate(()=>{history.pushState(null,'','#history');history.back();});await expect(f.page).toHaveURL(/#notices\/1$/);
      await f.page.reload().catch(()=>{});await expect(f.page.getByLabel('제목',{exact:true})).toHaveValue('저장 전 제목');assert.ok(questions>=3);
      await f.page.getByRole('button',{name:'삭제',exact:true}).click();const dialog=f.page.getByRole('dialog',{name:'공지 삭제',exact:true});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'취소',exact:true}).click();assert.equal(f.state.rows.length,4);
      await f.page.getByRole('button',{name:'삭제',exact:true}).click();await dialog.getByRole('button',{name:'삭제',exact:true}).click();await expect(f.page.locator('[data-admin-page=notices]')).toBeVisible();assert.equal(f.state.rows.length,3);assert.equal(f.requests.find(call=>call.method==='DELETE').body.updatedAt,version);
      assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  await t.test('feature unavailable and true empty/filter-empty states are distinct',async()=>{
    let f=await open({enabled:false});try{await expect(f.page.getByText('공지 저장소 준비 안 됨',{exact:true})).toBeVisible();await expect(f.page.getByRole('link',{name:'새 공지',exact:true})).toHaveAttribute('aria-disabled','true');}finally{await f.close();}
    f=await open({rows:[]});try{await expect(f.page.getByText('아직 공지가 없어요.',{exact:true})).toBeVisible();await f.page.getByRole('button',{name:'임시',exact:true}).click();await expect(f.page.getByText('이 상태의 공지가 없어요.',{exact:true})).toBeVisible();}finally{await f.close();}
  });
  await t.test('built admin CSP loads the emitted editor stylesheet and semantic formatting survives sanitization',{skip:!process.env.ADMIN_NOTICES_BUILT_URL},async()=>{
    const f=await open({hash:'notices/new',mode:'dark',baseUrl:process.env.ADMIN_NOTICES_BUILT_URL});const policyErrors=[];
    f.page.on('console',message=>{if(message.type()==='error'&&/content security policy|style-src/i.test(message.text()))policyErrors.push(message.text());});
    try{
      const csp=f.documentResponse.headers()['content-security-policy'];assert.ok(csp.includes("style-src 'self'"));assert.ok(!csp.includes("'unsafe-inline'"));
      await expect(body(f.page)).toBeVisible();
      const frame=await f.page.locator('iframe[title="서식 편집기"]').elementHandle();
      const styled=await frame.evaluate(node=>{const doc=node.contentDocument,link=doc.querySelector('link[rel=stylesheet]');return {href:link?.getAttribute('href'),loaded:Boolean(link?.sheet),rules:link?.sheet?.cssRules.length,inline:doc.querySelectorAll('style').length,font:getComputedStyle(doc.body).fontSize};});
      assert.match(styled.href,/\/assets\/.*\.css/);assert.equal(styled.loaded,true);assert.ok(styled.rules>0);assert.equal(styled.inline,0);assert.equal(styled.font,'14px');
      await fillBody(f.page,'<p>서식 확인</p>');await body(f.page).press('Control+a');await f.page.getByRole('button',{name:'굵게',exact:true}).click();await f.page.getByRole('button',{name:'기울임',exact:true}).click();
      const html=await body(f.page).evaluate(node=>node.innerHTML);assert.ok(!html.includes('style='));assert.match(html,/<(?:b|strong)[ >]/);assert.match(html,/<(?:i|em)[ >]/);
      await f.page.getByRole('button',{name:'미리보기',exact:true}).click();await expect(f.page.locator('.pv .nbody')).toHaveText('서식 확인');await expect(f.page.locator('.pv .nbody b,.pv .nbody strong')).toHaveCount(1);await expect(f.page.locator('.pv .nbody i,.pv .nbody em')).toHaveCount(1);
      assert.deepEqual(policyErrors,[]);assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  for(const width of [1280,1024,901,768,375])for(const mode of ['light','dark'])await t.test(`A list ${width} ${mode}: column alignment, pin contrast and capture`,async()=>{
    const f=await open({width,mode});try{
      await expect(f.page.locator('.na-tr[data-id]')).toHaveCount(4);
      if(width>760&&width<=1180){
        const header=await f.page.locator('.na-tr.th [role=columnheader]').nth(4).boundingBox(),cell=await f.page.locator('.na-tr[data-id="1"] .c-st').boundingBox();assert.ok(Math.abs(header.x-cell.x)<=1);
        assert.equal(await f.page.locator('.na-tr.th').evaluate(el=>getComputedStyle(el).gridTemplateColumns),await f.page.locator('.na-tr[data-id="1"]').evaluate(el=>getComputedStyle(el).gridTemplateColumns));
      }
      await expect(f.page.locator('.pinbtn[aria-pressed="true"]')).toHaveCount(1);await f.page.screenshot({path:`${captures}/list-${width}-${mode}.png`});assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  for(const width of [1280,1024,901,768,375])for(const mode of ['light','dark'])await t.test(`A editor ${width} ${mode}: preview tabs, mobile two-column footer and accessibility`,async()=>{
    const f=await open({width,mode,hash:'notices/1'});try{
      await expect(body(f.page)).toBeVisible();await f.page.getByRole('button',{name:'미리보기',exact:true}).click();await expect(f.page.locator('.pv')).toBeVisible();
      if(width===375){const columns=await f.page.locator('.na-foot').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);assert.equal(columns,2);}
      assert.deepEqual((await new AxeBuilder({page:f.page}).include('[data-admin-page=notice-editor]').analyze()).violations,[]);
      await f.page.screenshot({path:`${captures}/editor-preview-${width}-${mode}.png`});await f.page.getByRole('button',{name:'쓰기',exact:true}).click();
      await expect(body(f.page)).toBeVisible();
      const fontLoaded=await body(f.page).evaluate(node=>Promise.race([node.ownerDocument.fonts.ready.then(fonts=>[...fonts].some(font=>font.family==='Pretendard'&&font.status==='loaded')),new Promise((_,reject)=>setTimeout(()=>reject(new Error('notice editor font exceeded 5 seconds')),5000))]));assert.equal(fontLoaded,true,'notice editor Pretendard must be loaded');
      await f.page.screenshot({path:`${captures}/editor-write-${width}-${mode}.png`});assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
});
