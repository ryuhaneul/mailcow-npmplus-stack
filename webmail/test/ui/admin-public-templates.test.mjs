// Written only. Run at the browser-capable gate after all template stages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';

const version='2026-10-28T07:00:00.123456Z';
const row=()=>({id:1,name:'회사 공용 합성 템플릿',subject:'{{오늘}} 안내',html:'<p>{{이름}} 님께</p>',audienceAll:false,domains:['example.test'],updatedAt:version,hasAttachments:true,attachments:[{id:11,name:'existing.txt',size:3,type:'text/plain'}]});
await test('admin public templates: management A layout and editor reuse',async t=>{
  const fake=createFakeAdminApi(),server=await createServer({root:fileURLToPath(new URL('../../web',import.meta.url)),configFile:fileURLToPath(new URL('../../web/vite.admin.config.js',import.meta.url)),logLevel:'error',plugins:[{name:'public-template-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0,hmr:false}});
  await server.listen();t.after(()=>server.close());
  const browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});t.after(()=>browser.close());
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`,captures=process.env.ADMIN_PUBLIC_TEMPLATES_CAPTURE_DIR||'/tmp/admin-public-templates-captures';await mkdir(captures,{recursive:true});
  async function open({width=1280,mode='light',hash='public-templates',baseUrl=origin,rows=[row()],failure=null}={}) {
    const context=await browser.newContext({viewport:{width,height:950},colorScheme:mode}),page=await context.newPage(),calls=[],errors=[],policy=[];
    await context.addInitScript(mode=>localStorage.setItem('webmail-admin-prefs',JSON.stringify({theme:'ink',mode,accent:{}})),mode);
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&/content security policy|style-src/i.test(message.text()))policy.push(message.text());});
    const state={rows:structuredClone(rows),failure},nextVersion=()=>`2026-10-28T07:00:00.${String(++tick).padStart(6,'0')}Z`;let tick=123456;
    await page.route('**/api/admin/auth/session',route=>route.fulfill({json:{...fake.state.session,features:fake.state.features}}));
    await page.route('**/api/admin/domains',route=>route.fulfill({json:{items:[{domain:'example.test',active:true},{domain:'inactive.test',active:false}]}}));
    await page.route('**/api/admin/public-templates**',async route=>{
      const request=route.request(),url=new URL(request.url()),id=Number(url.pathname.split('/')[4]),current=state.rows.find(item=>item.id===id),body=request.method()==='GET'?undefined:request.postDataJSON();calls.push({method:request.method(),path:url.pathname,body});
      const error=(status,code,message)=>route.fulfill({status,json:{error:{code,message}}});
      if(state.failure&&request.method()!=='GET')return error(state.failure.status,state.failure.code,state.failure.message);
      if(request.method()==='GET')return route.fulfill({json:id?current:{items:state.rows.map(({html,attachments,...item})=>item)}});
      assert.equal(request.headers()['x-mailadmin-csrf'],fake.state.session.csrf);assert.equal(request.headers().authorization,undefined);
      if(current&&body.updatedAt!==current.updatedAt)return error(409,'CONFLICT','다른 곳에서 바뀌었어요.');
      if(request.method()==='DELETE'){state.rows=state.rows.filter(item=>item.id!==id);return route.fulfill({json:{ok:true}});}
      const attachments=[...(current?.attachments||[]).filter(file=>body.keepFileIds.includes(file.id)),...body.newFiles.map((file,index)=>({id:100+index,name:file.name,type:file.type,size:Buffer.from(file.dataBase64,'base64').length}))];
      const value={id:current?.id??2,...body,attachments,hasAttachments:attachments.length>0,updatedAt:nextVersion()};delete value.keepFileIds;delete value.newFiles;
      if(current)Object.assign(current,value);else state.rows.push(value);return route.fulfill({json:value});
    });
    const response=await page.goto(`${baseUrl}/admin.html#${hash}`);await expect(page.locator('[data-admin-page]')).toBeVisible();
    return {page,context,calls,errors,policy,state,response,close:()=>context.close()};
  }
  const body=page=>page.frameLocator('iframe[title="서식 편집기"]').getByRole('textbox',{name:'본문'});
  for(const width of [1280,768,375])for(const mode of ['light','dark'])await t.test(`A list/editor ${width} ${mode}`,async()=>{
    const f=await open({width,mode});try{
      await expect(f.page.getByRole('table',{name:'회사 공용 템플릿 목록'})).toBeVisible();await f.page.screenshot({path:`${captures}/list-${width}-${mode}.png`});
      await f.page.getByRole('button',{name:'수정',exact:true}).click();await expect(body(f.page)).toBeVisible();await expect(f.page.getByLabel('이름',{exact:true})).toHaveValue(row().name);
      await expect(f.page.getByLabel('inactive.test',{exact:true})).toHaveCount(0);await f.page.screenshot({path:`${captures}/editor-${width}-${mode}.png`});assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
  await t.test('create and update preserve variables, domains and attachment manifest',async()=>{
    const f=await open({hash:'public-templates/new'});try{
      await f.page.getByLabel('이름',{exact:true}).fill('새 합성 템플릿');await f.page.getByLabel('제목',{exact:true}).fill('{{오늘}} 안내');await f.page.getByLabel('도메인 지정',{exact:true}).check();await f.page.getByLabel('example.test',{exact:true}).check();
      await f.page.getByLabel('템플릿 첨부 파일 선택',{exact:true}).setInputFiles({name:'new.txt',mimeType:'text/plain',buffer:Buffer.from('new')});
      await f.page.getByRole('button',{name:'저장',exact:true}).click();await expect(f.page.locator('[data-admin-page=public-templates]')).toBeVisible();const call=f.calls.find(call=>call.method==='POST');assert.deepEqual(call.body.keepFileIds,[]);assert.equal(call.body.newFiles[0].dataBase64,'bmV3');assert.deepEqual(call.body.domains,['example.test']);
    }finally{await f.close();}
  });
  await t.test('retained attachment removal is local until save; dirty leave rejects then accepts',async()=>{
    const f=await open({hash:'public-templates/1'});try{
      await f.page.getByRole('button',{name:'existing.txt 빼기',exact:true}).click();assert.equal(f.calls.filter(call=>call.method==='DELETE').length,0);
      f.page.once('dialog',dialog=>dialog.dismiss());await f.page.getByRole('button',{name:'취소',exact:true}).click();await expect(f.page.locator('[data-admin-page=public-template-editor]')).toBeVisible();
      f.page.once('dialog',dialog=>dialog.accept());await f.page.getByRole('button',{name:'취소',exact:true}).click();await expect(f.page.locator('[data-admin-page=public-templates]')).toBeVisible();
    }finally{await f.close();}
  });
  await t.test('409 preserves entered values and reload explicitly refreshes server version',async()=>{
    const f=await open({hash:'public-templates/1',failure:{status:409,code:'CONFLICT',message:'다른 곳에서 바뀌었어요.'}});try{
      await f.page.getByLabel('이름',{exact:true}).fill('내 수정');await f.page.getByRole('button',{name:'저장',exact:true}).click();await expect(f.page.getByRole('alert')).toContainText('입력은 그대로');await expect(f.page.getByLabel('이름',{exact:true})).toHaveValue('내 수정');await expect(f.page.getByRole('button',{name:'저장',exact:true})).toBeDisabled();
      f.page.once('dialog',dialog=>dialog.accept());await f.page.getByRole('button',{name:'다시 불러오기',exact:true}).click();await expect(f.page.getByLabel('이름',{exact:true})).toHaveValue(row().name);
    }finally{await f.close();}
  });
  for(const [code,message]of [['PUBLIC_TEMPLATE_CID','메일에 붙인 이미지는 넣을 수 없어요.'],['PUBLIC_TEMPLATE_IMAGE_URL','그림은 https 주소만 넣을 수 있어요.']])await t.test(`${code} reason remains visible`,async()=>{
    const f=await open({hash:'public-templates/1',failure:{status:422,code,message}});try{await f.page.getByLabel('이름',{exact:true}).fill('수정');await f.page.getByRole('button',{name:'저장',exact:true}).click();await expect(f.page.getByRole('alert')).toContainText(message);await expect(f.page.getByLabel('이름',{exact:true})).toHaveValue('수정');}finally{await f.close();}
  });
  await t.test('delete confirmation supports Escape and returns to list after confirmed delete',async()=>{
    const f=await open({hash:'public-templates/1'});try{
      await f.page.getByRole('button',{name:'삭제',exact:true}).click();await expect(f.page.getByRole('dialog',{name:'템플릿 삭제'})).toBeVisible();await f.page.keyboard.press('Escape');assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
      await f.page.getByRole('button',{name:'삭제',exact:true}).click();await f.page.getByRole('dialog').getByRole('button',{name:'삭제',exact:true}).click();await expect(f.page.locator('[data-admin-page=public-templates]')).toBeVisible();assert.equal(f.calls.find(call=>call.method==='DELETE').body.updatedAt,version);
    }finally{await f.close();}
  });
  await t.test('empty list shows create action',async()=>{const f=await open({rows:[]});try{await expect(f.page.getByText('아직 템플릿이 없어요.',{exact:true})).toBeVisible();await expect(f.page.getByRole('link',{name:'새 템플릿',exact:true})).toBeVisible();}finally{await f.close();}});
  await t.test('built CSP uses an emitted stylesheet without policy relaxation',{skip:!process.env.ADMIN_PUBLIC_TEMPLATES_BUILT_URL},async()=>{
    const f=await open({hash:'public-templates/1',baseUrl:process.env.ADMIN_PUBLIC_TEMPLATES_BUILT_URL});try{
      const policy=f.response.headers()['content-security-policy'];assert.ok(policy.includes("style-src 'self'"));assert.ok(!policy.includes("'unsafe-inline'"));await expect(body(f.page)).toBeVisible();
      const actual=await f.page.locator('iframe[title="서식 편집기"]').evaluate(frame=>{const doc=frame.contentDocument,link=doc.querySelector('link[rel=stylesheet]');return {href:link?.getAttribute('href'),loaded:Boolean(link?.sheet),inline:doc.querySelectorAll('style').length};});assert.match(actual.href,/\/assets\/.*\.css/);assert.equal(actual.loaded,true);assert.equal(actual.inline,0);assert.deepEqual(f.policy,[]);
    }finally{await f.close();}
  });
});
