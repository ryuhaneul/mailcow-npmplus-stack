import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createFakeApi } from '../../web/dev/fake-api.js';
import { createSignatureNormalizer } from '../../server/routes/signatures.js';

const captures=process.env.SIGNATURE_CAPTURE_DIR || '/tmp/webmail-signature-captures';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const assetId='I'.repeat(32), firstId='A'.repeat(32), secondId='B'.repeat(32);
const cid=`cid:wm-sig-v1.${assetId}@signature.invalid`;
const fixture=()=>({revision:'signature-revision-1',items:[{id:firstId,name:'외부 연락용',html:'<p>안녕하세요</p>',createdAt:'2026-10-20T09:00:00.000Z',updatedAt:'2026-10-20T09:00:00.000Z'},{id:secondId,name:'짧은 답장',html:'<p>감사합니다</p>',createdAt:'2026-10-20T09:00:00.000Z',updatedAt:'2026-10-20T09:00:00.000Z'}],defaults:{'user@example.com':{newDefault:firstId,replyDefault:secondId},'team@example.com':{newDefault:null,replyDefault:null}},usedBytes:2048,maxBytes:262144,notices:[{code:'SIGNATURE_LEGACY_IMPORTED',address:'user@example.com',message:'예전 판에서 고친 서명을 추가했어요. 기본 서명은 바꾸지 않았어요.'},{code:'SIGNATURE_LEGACY_DELETED',address:'team@example.com',message:'예전 판에서 지운 서명이 있어요(team@example.com). 목록과 기본 서명은 그대로예요.'}]});
const fake=createFakeApi({authenticated:true});
const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'signature-ui-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0,hmr:false}});
await server.listen();
const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
await mkdir(captures,{recursive:true});
// Same baseline targets established by select-all V3; all other axe nodes fail.
const knownSidebarHashes = [
  ...['compose','inbox','allmail','spam','shared','templates','filters','storage','password','settings'].map(path => `#${path}`),
  ...['Sent','Drafts','Archive','Trash','거래처','하늘 프로젝트','인사·총무','세금계산서','뉴스레터','디자인 리뷰',
    'Shared/sales@example.com/INBOX','Shared/sales@example.com/거래처','Shared/sales@example.com/거래처/2026','Shared/sales@example.com/견적','Shared/support@example.com/INBOX'].map(path => `#f/${encodeURIComponent(path)}`),
];
async function classifyAxeViolations(page, violations) {
  const allowed = await page.evaluate(({violations,knownHashes}) => violations.map(violation => violation.nodes.map(node => {
    if (node.target.length !== 1 || typeof node.target[0] !== 'string') return false;
    const element = document.querySelector(node.target[0]);
    if (!element) return false;
    if (violation.id === 'list') {
      const check = node.none[0], lists = document.querySelectorAll('.mailview ul.list');
      return lists.length === 1 && element === lists[0] && !node.any.length && !node.all.length &&
        node.none.length === 1 && check.id === 'only-listitems' && check.data?.values === '[role=presentation]' &&
        check.relatedNodes.length > 0 && check.relatedNodes.every(related => {
          if (related.target.length !== 1 || typeof related.target[0] !== 'string') return false;
          const row = document.querySelector(related.target[0]);
          return row?.parentElement === element && row.matches('li.grp[role="presentation"]');
        }) && [...element.children].every(child => child.matches('li.grp[role="presentation"]') ||
          (['LI','SCRIPT','TEMPLATE'].includes(child.tagName) && !child.hasAttribute('role')));
    }
    if (violation.id === 'skip-link') {
      const sidebar = document.getElementById('mail-sidebar');
      return element.matches('a[href^="#"]') && sidebar?.contains(element) &&
        !document.body.classList.contains('nav-open') && sidebar.getBoundingClientRect().right <= 0 &&
        knownHashes.includes(element.getAttribute('href')) && node.any.length === 1 &&
        node.any[0].id === 'skip-link' && !node.all.length && !node.none.length;
    }
    return false;
  })),{violations,knownHashes:knownSidebarHashes});
  const select = expected => violations.map((violation,index) => ({...violation,nodes:violation.nodes.filter((_,nodeIndex) => allowed[index][nodeIndex] === expected)})).filter(violation => violation.nodes.length);
  return {knownViolations:select(true),unexpectedViolations:select(false)};
}

await test('signature settings integration',async t=>{
  t.after(async()=>{await browser.close();await server.close();fake.close();});
  async function open({width=1280,mode='light',doc=fixture(),failPut=null,delayUpload=null,delayNormalize=null,failUpload=null,waitReady=true,secure=false}={}) {
    const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[],requests=[],uploads=[],remote=[];
    page.setDefaultTimeout(15000);
    if(secure)await page.routeWebSocket('**',()=>{});
    if(secure)await page.route('https://signature.example.invalid/**',async route=>{const url=new URL(route.request().url());await route.fulfill({response:await route.fetch({url:origin+url.pathname+url.search})});});
    let snapshot=structuredClone(doc),revision=1;
    const library={revision:'image-revision-1',images:[],usedBytes:0,maxBytes:1048576,maxFileBytes:204800,maxCount:20};
    const normalize=createSignatureNormalizer({config:{publicHostnames:['localhost']},images:{read:async()=>({images:Object.fromEntries(library.images.map(image=>[image.id,{}]))})}});
    page.on('request',request=>{if(new URL(request.url()).hostname==='images.example.invalid')remote.push(request.url());});
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await context.addInitScript(mode=>localStorage.setItem('webmail-prefs',JSON.stringify({theme:'ink',mode})),mode);
    await page.route('**/api/prefs',route=>{requests.push({path:'/api/prefs',method:route.request().method()});return route.request().method()==='GET'?route.fulfill({json:{...fake.state.prefs,mode}}):route.fulfill({status:204});});
    await page.route('**/api/signatures',async route=>{
      const req=route.request();requests.push({path:'/api/signatures',method:req.method(),headers:req.headers(),body:req.postDataJSON()});
      if(req.method()==='GET')return route.fulfill({json:snapshot});
      if(failPut)return route.fulfill({status:failPut,json:{error:{code:failPut===428?'SIGNATURE_REVISION_REQUIRED':'SIGNATURE_CONFLICT',message:'다시 불러와 주세요.'}}});
      assert.equal(req.headers()['if-match'],snapshot.revision);assert.equal(req.headers()['x-webmail-csrf'],fake.state.csrf);
      const body=req.postDataJSON();assert.deepEqual(Object.keys(body).sort(),['defaults','items']);
      const idMap={},items=[];
      try { for(const item of body.items){assert.deepEqual(Object.keys(item).sort(),['html','id','name']);const id=item.id.startsWith('client-')?'C'.repeat(31)+String(items.length):item.id;if(id!==item.id)idMap[item.id]=id;items.push({...item,id,html:await normalize({html:item.html}),createdAt:snapshot.items.find(entry=>entry.id===item.id)?.createdAt || '2026-10-20T10:00:00.000Z',updatedAt:'2026-10-20T10:00:00.000Z'});} }
      catch(error){return route.fulfill({status:error.statusCode||422,json:{error:{code:error.code,message:error.message}}});}
      const defaults=Object.fromEntries(Object.entries(body.defaults).map(([address,values])=>[address,Object.fromEntries(Object.entries(values).map(([key,id])=>[key,idMap[id]||id]))]));
      snapshot={...snapshot,revision:`signature-revision-${++revision}`,items,defaults,idMap,notices:[]};return route.fulfill({json:snapshot});
    });
    await page.route('**/api/signatures/normalize',async route=>{
      assert.deepEqual(Object.keys(route.request().postDataJSON()),['html']);assert.equal(route.request().headers()['x-webmail-csrf'],fake.state.csrf);
      if(delayNormalize)await delayNormalize(route.request().postDataJSON().html);
      try{return await route.fulfill({json:{html:await normalize({html:route.request().postDataJSON().html})}});}catch(error){return route.fulfill({status:error.statusCode||422,json:{error:{code:error.code,message:error.message}}});}
    });
    await page.route('**/api/signature-images',async route=>{
      if(route.request().method()==='GET')return route.fulfill({json:library});
      uploads.push(route.request());if(delayUpload)await delayUpload;
      if(failUpload)return route.fulfill({status:failUpload,json:{error:{code:failUpload===413?'SIGNATURE_IMAGE_TOO_LARGE':'SIGNATURE_CONFLICT',message:'이미지 보관함을 다시 불러와 주세요.'}}});
      assert.equal(route.request().headers()['if-match'],library.revision);assert.match(route.request().headers()['content-type'],/^multipart\/form-data; boundary=/);
      const image={id:assetId,name:'clipboard.png',contentType:'image/png',size:png.length,width:1,height:1};library.images=[image];library.revision='image-revision-2';library.usedBytes=png.length;
      return route.fulfill({status:201,json:{revision:library.revision,image,usedBytes:library.usedBytes}});
    });
    await page.route('**/api/signature-images/*/content',route=>route.fulfill({body:png,contentType:'image/png'}));
    await page.route('https://images.example.invalid/**',route=>route.fulfill({body:png,contentType:'image/png'}));
    if(secure)await page.route('https://signature.example.invalid/api/events',route=>route.fulfill({contentType:'text/event-stream',body:': fixture connected\n\n'}));
    await page.goto(`${secure?'https://signature.example.invalid':origin}/#filters`);try{await page.getByRole('link',{name:'서명',exact:true}).click();}catch(error){await page.screenshot({path:`${captures}/open-failure.png`});console.error(JSON.stringify({errors,html:(await page.locator('body').innerText()).slice(0,1000)}));throw error;}
    await expect(page.getByRole('form',{name:'서명 설정'})).toBeVisible();
    if(waitReady && doc.items.length)await expect(page.getByRole('textbox',{name:`${doc.items[0].name} 서명`,exact:true})).toHaveAttribute('contenteditable','true');
    await expect(page.locator('html')).toHaveAttribute('data-mode',mode);
    return {page,context,errors,requests,uploads,remote,snapshot:()=>snapshot};
  }
  async function audit(page,scene) {
    const axe=await new AxeBuilder({page}).analyze(),classified=await classifyAxeViolations(page,axe.violations);
    await writeFile(`${captures}/${scene}.axe.json`,JSON.stringify({...axe,...classified},null,2));assert.deepEqual(classified.unexpectedViolations,[]);
  }
  const source=page=>page.getByRole('textbox',{name:/HTML 원문 편집$/});
  const rich=page=>page.getByRole('textbox',{name:/ 서명$/,exact:false});
  const save=page=>page.getByRole('button',{name:'저장',exact:true});
  async function filePaste(target,size=png.length){await target.evaluate((el,{base64,size})=>{const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([size===bytes.length?bytes:new Uint8Array(size)],'clipboard.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},{base64:png.toString('base64'),size});}
  async function htmlPaste(target,html){await target.evaluate((el,html)=>{const data=new DataTransfer();data.setData('text/html',html);el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},html);}
  await t.test('list, name/copy/delete, independent defaults, canonical save and ID mapping',async()=>{
    const {page,context,requests,snapshot,errors}=await open();
    await expect(page.getByText('예전 판에서 고친 서명을 추가했어요. 기본 서명은 바꾸지 않았어요.',{exact:true})).toBeVisible();await expect(page.getByText(/예전 판에서 지운 서명이 있어요/)).toBeVisible();
    await page.getByRole('button',{name:'새 서명',exact:true}).click();await expect(page.getByLabel('서명 이름',{exact:true})).toBeFocused();await page.getByLabel('서명 이름',{exact:true}).fill('행사 안내');await page.keyboard.press('Enter');
    await page.getByRole('tab',{name:'HTML',exact:true}).click();await source(page).fill('<p>행사 인사</p>');
    await page.getByRole('button',{name:'이름 바꾸기',exact:true}).click();await page.getByLabel('서명 이름',{exact:true}).fill('행사 초대');await page.keyboard.press('Enter');await expect(page.locator('.insert-target strong')).toHaveText('행사 초대');
    await page.getByRole('button',{name:'복제',exact:true}).click();await page.getByLabel('서명 이름',{exact:true}).fill('행사 복사');await page.getByRole('dialog').getByRole('button',{name:'복제',exact:true}).click();
    await page.getByRole('button',{name:'삭제',exact:true}).click();await page.getByRole('button',{name:'서명 삭제',exact:true}).click();await expect(page.getByRole('button',{name:'새 서명',exact:true})).toBeFocused();
    await page.getByRole('button',{name:'행사 초대',exact:true}).click();
    await page.getByRole('button',{name:'주소별 기본값',exact:true}).click();
    await page.getByLabel('user@example.com 새 메일 기본 서명',{exact:true}).selectOption({label:'행사 초대'});await page.getByLabel('user@example.com 답장·전달 기본 서명',{exact:true}).selectOption('');
    await save(page).click();await expect(page.locator('.sig-status')).toHaveText('저장했어요.');
    assert.equal(snapshot().items.length,3);assert.equal(snapshot().defaults['user@example.com'].replyDefault,null);assert.equal(snapshot().defaults['user@example.com'].newDefault,snapshot().items[2].id);assert.ok(!snapshot().items[2].id.startsWith('client-'));
    assert.equal(requests.filter(req=>req.path==='/api/prefs'&&req.method==='PUT').length,0);
    await page.getByRole('button',{name:'서명 편집',exact:true}).click();await expect(page.getByRole('button',{name:'행사 초대',exact:true})).toHaveAttribute('aria-pressed','true');await expect(source(page)).toHaveValue('<p>행사 인사</p>');
    await page.reload();await page.getByRole('link',{name:'서명',exact:true}).click();await expect(page.getByRole('button',{name:'행사 초대',exact:true})).toBeVisible();assert.deepEqual(errors,[]);await context.close();
  });
  await t.test('all-address defaults clear on delete and zero state remains keyboard reachable',async()=>{
    const doc=fixture();doc.items=[doc.items[0]];doc.defaults={'user@example.com':{newDefault:firstId,replyDefault:firstId},'retired@example.com':{newDefault:firstId,replyDefault:firstId}};
    const {page,context,snapshot}=await open({doc});await page.getByRole('button',{name:'삭제',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('2개 주소');await page.screenshot({path:`${captures}/delete-confirmation.png`});await audit(page,'delete-confirmation');await expect(page.getByRole('button',{name:'취소',exact:true})).toBeFocused();
    await page.keyboard.press('Shift+Tab');await expect(page.getByRole('button',{name:'서명 삭제',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'새 서명',exact:true})).toBeFocused();
    await page.getByRole('button',{name:'삭제',exact:true}).click();await page.getByRole('button',{name:'서명 삭제',exact:true}).click();await expect(page.getByText('아직 서명이 없어요. 새 서명을 만들어 주세요.')).toBeVisible();await expect(page.getByRole('button',{name:'새 서명',exact:true})).toBeFocused();await save(page).click();await expect(page.locator('.sig-status')).toHaveText('저장했어요.');assert.deepEqual(snapshot().defaults,{'user@example.com':{newDefault:null,replyDefault:null},'retired@example.com':{newDefault:null,replyDefault:null}});await context.close();
  });
  await t.test('409 and 428 preserve HTML, name, defaults, mode and selection until explicit reload',async()=>{
    for(const status of [409,428]){
      const {page,context}=await open({failPut:status});await page.getByRole('button',{name:'이름 바꾸기',exact:true}).click();await page.getByLabel('서명 이름',{exact:true}).fill('충돌 입력');await page.keyboard.press('Enter');await page.getByRole('button',{name:'주소별 기본값',exact:true}).click();await page.getByLabel('user@example.com 새 메일 기본 서명',{exact:true}).selectOption(secondId);await page.getByRole('button',{name:'서명 편집',exact:true}).click();await page.getByRole('tab',{name:'HTML',exact:true}).click();await source(page).fill('<p>미저장 원문</p>');await source(page).evaluate(el=>el.setSelectionRange(5,7));await save(page).click();await expect(page.getByRole('alert').filter({hasText:'입력은 그대로'})).toBeVisible();await expect(source(page)).toHaveValue('<p>미저장 원문</p>');assert.deepEqual(await source(page).evaluate(el=>[el.selectionStart,el.selectionEnd]),[5,7]);await expect(page.getByRole('tab',{name:'HTML',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('button',{name:'충돌 입력',exact:true})).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'주소별 기본값',exact:true}).click();await expect(page.getByLabel('user@example.com 새 메일 기본 서명',{exact:true})).toHaveValue(secondId);await page.getByRole('button',{name:'서명 편집',exact:true}).click();await page.getByRole('button',{name:'다시 불러오기',exact:true}).click();await expect(rich(page)).toHaveText('안녕하세요');await context.close();
    }
  });
  await t.test('clipboard file uses shared upload revision and inserts at captured rich cursor',async()=>{
    let release;const delayUpload=new Promise(resolve=>release=resolve);const {page,context,uploads,requests,errors}=await open({delayUpload});const editor=rich(page);
    await editor.evaluate(el=>{el.focus();getSelection().collapse(el.firstChild.firstChild,2);});await filePaste(editor);await expect(page.getByText('이미지를 보관함에 올리는 중…',{exact:true})).toBeVisible();await expect(save(page)).toBeDisabled();await page.screenshot({path:`${captures}/paste-working.png`});await audit(page,'paste-working');release();
    await expect(editor.locator('img')).toHaveCount(1);await expect(page.getByText('이미지를 보관함에 추가하고 서명에 넣었어요.')).toBeVisible();await page.screenshot({path:`${captures}/paste-done.png`});assert.equal(uploads.length,1);assert.equal(await editor.evaluate(el=>el.firstChild.childNodes[0].textContent),'안녕');await expect(page.locator('.asset small')).toContainText('1개 서명에서 사용 중');
    await editor.locator('img').click();await page.getByLabel('너비',{exact:true}).fill('240');await page.getByLabel('대체 텍스트',{exact:true}).fill('행사 로고');await save(page).click();await expect(page.locator('.sig-status')).toHaveText('저장했어요.');const body=requests.find(req=>req.method==='PUT'&&req.path==='/api/signatures').body;assert.match(body.items[0].html,new RegExp(cid.replaceAll('.','\\.')));assert.match(body.items[0].html,/width="240"/);assert.match(body.items[0].html,/alt="행사 로고"/);assert.doesNotMatch(body.items[0].html,/blob:|\/api\/|data:/);await editor.locator('img').click();await page.getByRole('button',{name:'이미지 빼기',exact:true}).click();await expect(editor).toBeFocused();await expect(editor.locator('img')).toHaveCount(0);await expect(page.locator('.asset small')).toContainText('사용하지 않는 이미지');assert.deepEqual(errors,[]);await context.close();
  });
  await t.test('file limit and HTML file paste never upload; data HTML preserves original document',async()=>{
    const {page,context,uploads}=await open();await filePaste(rich(page),204801);await expect(page.getByRole('alert')).toContainText('200KiB');assert.equal(uploads.length,0);
    await htmlPaste(rich(page),'<img src="d&#97;ta:image/png;base64,AAAA">');await expect(page.getByRole('alert')).toContainText('이미지는 보관함에서 넣어 주세요.');await expect(rich(page)).toHaveText('안녕하세요');
    await page.getByRole('tab',{name:'HTML',exact:true}).click();await filePaste(source(page));await expect(page.getByRole('alert')).toContainText('서식 편집에서');assert.equal(uploads.length,0);
    const html='<p>원문</p><img src="DATA:image/png;base64,AAAA">';await source(page).fill(html);await page.getByRole('tab',{name:'서식 편집',exact:true}).click();await expect(source(page)).toHaveValue(html);await expect(page.getByRole('tab',{name:'HTML',exact:true})).toHaveAttribute('aria-selected','true');await save(page).click();await expect(source(page)).toHaveValue(html);assert.equal(uploads.length,0);await context.close();
  });
  await t.test('ID-local mode, source caret/scroll, rich cursor and IME retain input; tabs support keyboard',async()=>{
    const {page,context,errors}=await open();const editor=rich(page);await editor.evaluate(el=>{el.focus();getSelection().collapse(el.firstChild.firstChild,2);});await page.keyboard.type('X');
    await page.getByRole('button',{name:'짧은 답장',exact:true}).click();await expect(rich(page)).toHaveText('감사합니다');await page.getByRole('button',{name:'외부 연락용',exact:true}).click();await expect(rich(page)).toHaveText('안녕X하세요');
    await page.getByRole('tab',{name:'서식 편집',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'HTML',exact:true})).toBeFocused();await expect(source(page)).toBeVisible();
    await source(page).fill(Array.from({length:30},(_,i)=>`<p>${i} 원문</p>`).join('\n'));await source(page).evaluate(el=>{el.setSelectionRange(12,16);el.scrollTop=170;});
    await page.getByRole('button',{name:'짧은 답장',exact:true}).click();await page.getByRole('button',{name:'외부 연락용',exact:true}).click();await expect(source(page)).toBeVisible();assert.deepEqual(await source(page).evaluate(el=>[el.selectionStart,el.selectionEnd,el.scrollTop]),[12,16,170]);
    await source(page).evaluate(el=>{el.focus();el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='<p>한글</p>';el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'한글',isComposing:true}));});await expect(page.getByRole('tab',{name:'서식 편집',exact:true})).toBeDisabled();await source(page).evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'한글'})));await expect(source(page)).toHaveValue('<p>한글</p>');await page.getByRole('tab',{name:'HTML',exact:true}).focus();await page.keyboard.press('Home');await expect(page.getByRole('tab',{name:'서식 편집',exact:true})).toHaveAttribute('aria-selected','true');await expect(rich(page)).toHaveText('한글');assert.notEqual(await page.evaluate(()=>document.activeElement.tagName),'BODY');assert.deepEqual(errors,[]);await context.close();
  });
  await t.test('upload aggregate limit and stale revision preserve cursor/input, with manual library reload',async()=>{
    for(const status of [409,413]){
      const {page,context,uploads}=await open({failUpload:status});const editor=rich(page);
      await editor.evaluate(el=>{el.focus();getSelection().collapse(el.firstChild.firstChild,2);});await filePaste(editor);
      await expect(page.getByRole('alert')).toContainText(status===413?'200KiB':'다른 곳에서');await expect(editor).toHaveText('안녕하세요');await expect(editor.locator('img')).toHaveCount(0);assert.equal(uploads.length,1);
      if(status===409){await page.getByRole('button',{name:'이미지 보관함 다시 불러오기',exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);await expect(editor).toBeFocused();}
      await page.getByRole('tab',{name:'HTML',exact:true}).click();await expect(source(page)).toHaveValue('<p>안녕하세요</p>');await context.close();
    }
  });
  await t.test('late initial normalization never replaces newer source, and preview uses server-normalized HTML',async()=>{
    let release;const gate=new Promise(resolve=>release=resolve);
    const {page,context,errors}=await open({waitReady:false,delayNormalize:html=>html==='<p>안녕하세요</p>'?gate:Promise.resolve()});
    await page.getByRole('tab',{name:'HTML',exact:true}).click();const html='<p>새 원문</p><script>window.signatureExecuted=true</script><img alt="" src="javascript:alert(1)" onerror="window.signatureExecuted=true">';await source(page).fill(html);release();
    await page.getByRole('button',{name:'미리보기',exact:true}).click();await expect(page.locator('.mail-paper')).toContainText('새 원문');await expect(page.locator('.mail-paper script')).toHaveCount(0);await page.screenshot({path:`${captures}/preview.png`});await audit(page,'preview');assert.equal(await page.evaluate(()=>window.signatureExecuted),undefined);
    await page.getByRole('button',{name:'편집으로',exact:true}).click();await expect(source(page)).toHaveValue(html);await page.getByRole('tab',{name:'서식 편집',exact:true}).click();await expect(rich(page)).toContainText('새 원문');await expect(rich(page).locator('script')).toHaveCount(0);assert.deepEqual(errors,[]);await context.close();
  });
  await t.test('library URL insertion respects source caret, and rich IME leaves its text node intact',async()=>{
    const {page,context,errors,remote}=await open();await page.getByRole('tab',{name:'HTML',exact:true}).click();await source(page).evaluate(el=>el.setSelectionRange(3,3));
    await page.getByRole('button',{name:'주소(URL)로 넣기',exact:true}).click();await page.getByLabel('이미지 주소',{exact:true}).fill('https://images.example.invalid/logo.png');await audit(page,'url-panel');await page.getByRole('button',{name:'이미지 넣기',exact:true}).click();await expect(source(page)).toHaveValue('<p><img src="https://images.example.invalid/logo.png" alt="" width="160">안녕하세요</p>');await expect(source(page)).toBeFocused();assert.deepEqual(remote,[]);
    await page.getByRole('button',{name:'짧은 답장',exact:true}).click();const editor=rich(page);await expect(editor).toHaveAttribute('contenteditable','true');await editor.evaluate(el=>{el.focus();el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));const node=document.createTextNode('한');el.append(node);el._imeNode=node;getSelection().collapse(node,1);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'한',isComposing:true}));});await expect(page.getByRole('button',{name:'외부 연락용',exact:true})).toBeDisabled();
    assert.equal(await editor.evaluate(el=>el.contains(el._imeNode)),true);await editor.evaluate(el=>{el._imeNode.data='한글';getSelection().collapse(el._imeNode,2);el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'한글'}));});await page.keyboard.type(' done');await expect(editor).toHaveText('감사합니다한글 done');assert.equal(await editor.evaluate(el=>el.contains(el._imeNode)),true);assert.deepEqual(errors,[]);await context.close();
  });
  await t.test('HTTPS rich projection blocks HTTP downloads while retaining canonical URL on edit/save',async()=>{
    const doc=fixture();doc.items[0].html='<p>연락처</p><img src="http://images.example.invalid/logo.png" width="160" alt="회사 로고">';
    const {page,context,snapshot,errors,remote}=await open({doc,secure:true});
    await expect(rich(page).locator('img')).toHaveAttribute('src',/^blob:/);await rich(page).click();await page.keyboard.press('Control+End');await page.keyboard.type(' 수정');await save(page).click();await expect(page.locator('.sig-status')).toHaveText('저장했어요.');assert.match(snapshot().items[0].html,/src="http:\/\/images.example.invalid\/logo.png"/);assert.doesNotMatch(snapshot().items[0].html,/blob:/);assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);await context.close();
  });
  await t.test('legacy data image stays in source and is never silently rendered or imported',async()=>{
    const doc=fixture();const html='<p>예전 원문</p><img src="data:image/png;base64,AAAA">';doc.items[0].html=html;
    const {page,context,uploads}=await open({doc,waitReady:false});await page.getByRole('tab',{name:'HTML',exact:true}).click();await expect(source(page)).toHaveValue(html);await expect(page.getByRole('alert')).toContainText('이미지는 보관함에서 넣어 주세요.');assert.equal(await page.locator('.signature-editors .sig-content img').count(),0);await save(page).click();await expect(source(page)).toHaveValue(html);assert.equal(uploads.length,0);await context.close();
  });
  await t.test('session replacement during paste drops old response and unlocks the fresh editor',async()=>{
    let release;const gate=new Promise(resolve=>release=resolve);const {page,context,uploads}=await open({delayUpload:gate});await filePaste(rich(page));await expect(page.getByText('이미지를 보관함에 올리는 중…',{exact:true})).toBeVisible();
    await page.evaluate(async()=>{const {session}=await import('/src/state/session.js');session.value={...session.value,expiresAt:session.value.expiresAt+1};});
    await expect(save(page)).toBeEnabled();await expect(rich(page)).toHaveAttribute('contenteditable','true');const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/signature-images'&&value.request().method()==='POST');release();await (await response).finished();await page.evaluate(()=>new Promise(requestAnimationFrame));await expect(rich(page)).toHaveText('안녕하세요');await expect(rich(page).locator('img')).toHaveCount(0);assert.equal(uploads.length,1);await expect(save(page)).toBeEnabled();await context.close();
  });
  await t.test('200-byte signature names wrap in selected actions and delete confirmation without overflow',async()=>{
    for(const width of [1280,375]){
      const doc=fixture(),name='x'.repeat(200);doc.items[0].name=name;const {page,context}=await open({doc,width});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('.signature-settings').evaluate(el=>el.scrollWidth>el.clientWidth),false);
      await page.getByRole('button',{name:'삭제',exact:true}).click();assert.equal(await page.getByRole('dialog').evaluate(el=>el.scrollWidth>el.clientWidth),false);await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'새 서명',exact:true})).toBeFocused();await context.close();
    }
  });
  await t.test('light/dark at 1280, 768, 390, 375: zero overflow and zero signature axe violations',async()=>{
    const results=[];
    for(const width of [1280,768,390,375])for(const mode of ['light','dark']){
      const doc=fixture();doc.notices=[];const {page,context,errors}=await open({width,mode,doc});
      for(const scene of ['edit','html','defaults']){
        if(scene==='html')await page.getByRole('tab',{name:'HTML',exact:true}).click();
        if(scene==='defaults')await page.getByRole('button',{name:'주소별 기본값',exact:true}).click();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('.filters-view .scroll').evaluate(el=>el.scrollWidth>el.clientWidth),false);
        const axe=await new AxeBuilder({page}).analyze(),classified=await classifyAxeViolations(page,axe.violations);assert.deepEqual(classified.unexpectedViolations,[]);await writeFile(`${captures}/${scene}-${width}-${mode}.axe.json`,JSON.stringify({...axe,...classified},null,2));
        await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:`${captures}/${scene}-${width}-${mode}.png`,fullPage:true});await page.locator('.filters-view .scroll').evaluate(el=>el.scrollTop=el.scrollHeight);await page.screenshot({path:`${captures}/${scene}-${width}-${mode}-bottom.png`,fullPage:true});await page.locator('.filters-view .scroll').evaluate(el=>el.scrollTop=0);results.push({width,mode,scene,overflow:0,axe:classified.unexpectedViolations.length,known:classified.knownViolations.map(value=>({id:value.id,targets:value.nodes.map(node=>node.target)}))});
      }
      assert.deepEqual(errors,[]);await context.close();
    }
    await writeFile(`${captures}/browser-results.json`,JSON.stringify(results,null,2));
  });
  await t.test('from-address prefs path still saves with original 204 contract',async()=>{
    const {page,context,requests}=await open();await page.getByRole('link',{name:'보낸 사람 주소',exact:true}).click();await page.getByRole('button',{name:'sales@example.com 기본으로',exact:true}).click();await expect(page.getByText('저장했어요.',{exact:true})).toBeVisible();assert.equal(requests.filter(req=>req.path==='/api/prefs'&&req.method==='PUT').length,1);await context.close();
  });
});
