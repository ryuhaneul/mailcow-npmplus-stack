import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

const assetA='A'.repeat(32),assetB='B'.repeat(32),revision='R'.repeat(32),at='2026-10-20T12:00:00.000Z';
const sigA='S'.repeat(32),sigB='T'.repeat(32),sigC='U'.repeat(32);
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7H8AAAAASUVORK5CYII=','base64');
const cid=id=>`cid:wm-sig-v1.${id}@signature.invalid`;
const items=[
  {id:sigA,name:'외부 연락용',html:`<p>예시 담당자</p><img src="${cid(assetA)}" alt="예시 로고" width="40"><img src="${cid(assetA)}" alt="두 번째 로고" width="40">`},
  {id:sigB,name:'짧은 서명',html:`<p>예시 팀</p><img src="${cid(assetB)}" alt="팀 로고" width="40">`},
  {id:sigC,name:'글자 서명',html:'<p>감사합니다.</p>'},
].map(item=>({...item,createdAt:at,updatedAt:at}));
const signatures={revision,items,defaults:{'user@example.com':{newDefault:sigA,replyDefault:sigB},'sales@example.com':{newDefault:sigC,replyDefault:null}},usedBytes:2048,maxBytes:262144,notices:[]};
const images={revision,images:[assetA,assetB].map(id=>({id,name:'example.png',contentType:'image/png',size:bytes.length,width:1,height:1})),usedBytes:bytes.length*2,maxBytes:1048576,maxFileBytes:204800,maxCount:20};
const quote=`<p>인용 본문</p><img src="cid:received@example.com" alt="수신 이미지"><img src="${cid(assetA)}" alt="인용 서명 이미지">`;
const message={ref:Buffer.from(JSON.stringify(['INBOX',1,3])).toString('base64url'),messageId:'<example-message@example.com>',from:[{name:'예시 보낸 사람',address:'sender@example.com'}],to:[{address:'user@example.com'}],cc:[],subject:'합성 제목',html:quote,date:at,attachments:[]};

await test('Composer signature menu, snapshots and token payloads',async t=>{
  const fake=createFakeApi({authenticated:true});
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'signature-compose-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
  await server.listen();t.after(()=>server.close());t.after(()=>fake.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  async function open(options={}){
    const page=await browser.newPage({viewport:{width:options.width||1280,height:900}}),errors=[],consoleErrors=[],requests=[],contents=[];
    page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
    await page.route('**/api/signatures',route=>route.fulfill({status:options.failList?503:200,json:options.failList?{error:{code:'SIGNATURE_SAVE_RETRY',message:'합성 실패'}}:options.signatures||signatures}));
    await page.route('**/api/signature-images',route=>route.fulfill({status:options.failImages?503:200,json:options.failImages?{error:{code:'MAIL_UNAVAILABLE',message:'합성 실패'}}:images}));
    await page.route('**/api/signature-images/*/content',async route=>{
      contents.push(route.request().url());
      if(options.imageGate)await options.imageGate;
      return route.fulfill(options.failContent?{status:404,json:{error:{code:'SIGNATURE_IMAGE_NOT_FOUND',message:'합성 이미지 없음'}}}:{status:200,contentType:'image/png',body:bytes});
    });
    let draftUid=1000;
    await page.route('**/api/drafts',async route=>{
      requests.push({path:'draft',body:route.request().postDataJSON()});
      if(options.draftGate)await options.draftGate;
      await route.fulfill({status:200,json:{draftRef:Buffer.from(JSON.stringify(['Drafts',1,++draftUid])).toString('base64url')}});
    });
    await page.route('**/api/send',route=>{
      requests.push({path:'send',body:route.request().postDataJSON()});
      return route.fulfill(options.sendError?{status:422,json:{error:{code:options.sendError,message:'technical signature error'}}}:{status:200,json:{ok:true,rejected:[],warnings:[]}});
    });
    if(options.kind){
      await page.goto(origin);
      await expect(page.locator('.mailview')).toBeVisible();
      await page.evaluate(async({kind,message})=>{const {composeSeed}=await import('/src/state/compose.js');const {navigate}=await import('/src/router.js');composeSeed.value={kind,message};navigate('compose');},{kind:options.kind,message});
    }else await page.goto(origin+'/#compose');
    const body=page.frameLocator('iframe.compose-editor').locator('body');
    if(options.waitReady!==false)await expect(body).toHaveAttribute('contenteditable','true');
    const button=page.getByRole('button',{name:/^서명: /}),source=page.getByRole('textbox',{name:'HTML 원문 편집',exact:true});
    async function choose(name){await button.click();await page.getByRole('menuitemradio',{name,exact:true}).click();}
    async function html(){await page.getByRole('button',{name:'HTML 원문',exact:true}).click();const value=await source.inputValue();await page.getByRole('button',{name:'HTML 원문',exact:true}).click();return value;}
    async function recipient(){await page.getByRole('combobox',{name:'받는 사람 추가',exact:true}).fill('recipient@example.com');}
    return {page,body,button,source,choose,html,recipient,requests,contents,errors,consoleErrors};
  }
  function payload(body,id=assetA){
    assert.deepEqual(Object.keys(body).sort(),['from','to','cc','bcc','subject','html','signatureImages','attachmentIds',...(body.draftRef?['draftRef']:[])].sort());
    assert.equal(body.signatureImages.length,1);const [entry]=body.signatureImages;
    assert.deepEqual(Object.keys(entry).sort(),['assetId','token']);assert.equal(entry.assetId,id);
    assert.match(entry.token,new RegExp(`^cid:wm-compose-v1\\.[A-Za-z0-9_-]{32}\\.${id}@signature\\.invalid$`));
    assert.equal((body.html.match(new RegExp(entry.token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length,id===assetA?2:1);
    assert.equal(body.html.includes('blob:'),false);assert.equal(body.html.includes('cid:wm-sig-v1.'),false);
  }
  for(const width of [1280,390])await t.test(`initial image projection waits without broken frames or console errors at ${width}`,async()=>{
    let release;const imageGate=new Promise(resolve=>release=resolve),c=await open({width,imageGate,waitReady:false});
    try{
      await expect.poll(()=>c.contents.length).toBe(1);
      await expect(c.page.locator('iframe.compose-editor')).toHaveCount(0);
      await expect(c.page.getByRole('status').filter({hasText:'보낼 주소를 불러오는 중…'})).toBeVisible();
      assert.deepEqual(c.consoleErrors,[]);assert.deepEqual(c.errors,[]);
      if(process.env.SIGNATURE_COMPOSE_CAPTURE_DIR){await mkdir(process.env.SIGNATURE_COMPOSE_CAPTURE_DIR,{recursive:true});await c.page.screenshot({path:`${process.env.SIGNATURE_COMPOSE_CAPTURE_DIR}/compose-initial-pending-${width}.png`});}
      release();
      await expect(c.body).toHaveAttribute('contenteditable','true');
      await expect(c.body.locator('img')).toHaveCount(2);
      await expect(c.body.locator('img').first()).toHaveAttribute('src',/^blob:/);
      await expect.poll(()=>c.body.locator('img').evaluateAll(imgs=>imgs.every(img=>img.complete&&img.naturalWidth>0))).toBe(true);
      assert.deepEqual(c.consoleErrors,[]);assert.deepEqual(c.errors,[]);
      if(process.env.SIGNATURE_COMPOSE_CAPTURE_DIR)await c.page.screenshot({path:`${process.env.SIGNATURE_COMPOSE_CAPTURE_DIR}/compose-initial-ready-${width}.png`});
      await c.body.evaluate(body=>{body.prepend(Object.assign(body.ownerDocument.createElement('p'),{textContent:'지연 뒤 본문'}));body.dispatchEvent(new Event('input',{bubbles:true}));});
      await c.recipient();await c.page.getByRole('button',{name:'보내기',exact:true}).click();
      await expect.poll(()=>c.requests.filter(r=>r.path==='send').length).toBe(1);
      const sent=c.requests.find(r=>r.path==='send').body;payload(sent);assert.match(sent.html,/지연 뒤 본문/);
    }finally{release();await c.page.close();}
  });
  await t.test('initial image mapping failure opens without signature and keeps writing and sending usable',async()=>{
    const c=await open({failContent:true});try{
      await expect(c.page.getByRole('alert')).toHaveText('서명을 불러오지 못했어요. 서명 없이 작성할 수 있어요.');
      await expect(c.button).toHaveText('서명: 없음');await expect(c.body.locator('.sig')).toHaveCount(0);await expect(c.body.locator('img')).toHaveCount(0);
      assert.equal(c.consoleErrors.some(message=>message.includes('ERR_UNKNOWN_URL_SCHEME')),false);
      await c.body.fill('이미지 실패 뒤 본문');await c.recipient();await c.page.getByRole('button',{name:'보내기',exact:true}).click();
      await expect.poll(()=>c.requests.filter(r=>r.path==='send').length).toBe(1);
      const sent=c.requests.find(r=>r.path==='send').body;assert.deepEqual(sent.signatureImages,[]);assert.match(sent.html,/이미지 실패 뒤 본문/);assert.doesNotMatch(sent.html,/wm-compose-v1|blob:/);assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();}
  });
  await t.test('new default projects only registered images; rich editing and send retain exact manifest tokens',async()=>{
    const c=await open();try{
      await expect(c.button).toHaveText('서명: 외부 연락용');await expect(c.body.locator('img').first()).toHaveAttribute('src',/^blob:/);
      await expect(c.page.locator('.compose-grants[role=status]')).toContainText(`${bytes.length}B`);
      assert.equal(c.contents.length,1);
      await c.body.evaluate(body=>{const p=body.ownerDocument.createElement('p');p.textContent='내 본문';body.prepend(p);body.dispatchEvent(new Event('input',{bubbles:true}));});
      const html=await c.html();assert.match(html,/<p>내 본문<\/p>/);assert.equal(html.includes('blob:'),false);assert.match(html,/cid:wm-compose-v1\./);
      await c.recipient();await c.page.getByRole('button',{name:'보내기',exact:true}).click();
      await expect.poll(()=>c.requests.filter(r=>r.path==='send').length).toBe(1);
      payload(c.requests.find(r=>r.path==='send').body);assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();}
  });
  await t.test('menu Enter, Space and Down opening focus; arrows wrap, Home/End, selection, Escape and Tab',async()=>{
    const c=await open();try{
      for(const key of ['Enter','Space','ArrowDown']){
        await c.button.focus();await c.page.keyboard.press(key);await expect(c.page.getByRole('menuitemradio',{name:'외부 연락용',exact:true})).toBeFocused();
        await c.page.keyboard.press('Home');await expect(c.page.getByRole('menuitemradio',{name:'없음',exact:true})).toBeFocused();
        await c.page.keyboard.press('ArrowUp');await expect(c.page.getByRole('menuitemradio',{name:'글자 서명',exact:true})).toBeFocused();
        await c.page.keyboard.press('ArrowDown');await expect(c.page.getByRole('menuitemradio',{name:'없음',exact:true})).toBeFocused();
        await c.page.keyboard.press('End');await expect(c.page.getByRole('menuitemradio',{name:'글자 서명',exact:true})).toBeFocused();
        await c.page.keyboard.press('ArrowUp');await expect(c.page.getByRole('menuitemradio',{name:'짧은 서명',exact:true})).toBeFocused();
        await c.page.keyboard.press('Escape');await expect(c.button).toBeFocused();await expect(c.page.getByRole('menu')).toHaveCount(0);
      }
      await c.button.press('Enter');
      if(process.env.SIGNATURE_COMPOSE_CAPTURE_DIR){await mkdir(process.env.SIGNATURE_COMPOSE_CAPTURE_DIR,{recursive:true});await c.page.screenshot({path:`${process.env.SIGNATURE_COMPOSE_CAPTURE_DIR}/compose-menu-unstyled-1280.png`});}
      await c.page.keyboard.press('End');await c.page.keyboard.press('Enter');await expect(c.button).toHaveText('서명: 글자 서명');await expect(c.button).toBeFocused();
      await c.button.press('Space');await c.page.keyboard.press('Home');await c.page.keyboard.press('Space');await expect(c.button).toHaveText('서명: 없음');await expect(c.button).toBeFocused();
      await c.button.press('Enter');await c.page.keyboard.press('Tab');await expect(c.page.getByRole('menu')).toHaveCount(0);await expect(c.page.getByRole('button',{name:'찾아보기',exact:true})).toBeFocused();
      await c.button.click();await c.page.getByRole('textbox',{name:'제목',exact:true}).click();await expect(c.page.getByRole('menu')).toHaveCount(0);await expect(c.page.getByRole('textbox',{name:'제목',exact:true})).toBeFocused();
      await c.button.click();await c.body.click();await expect(c.page.getByRole('menu')).toHaveCount(0);assert.equal(await c.page.evaluate(()=>document.activeElement.tagName),'IFRAME');assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();}
  });
  await t.test('direct signature edits confirm; cancel preserves HTML, confirm replaces only signature and updates bytes',async()=>{
    const c=await open();try{
      await expect(c.body.locator('img').first()).toHaveAttribute('src',/^blob:/);
      await c.body.evaluate(body=>{body.prepend(Object.assign(body.ownerDocument.createElement('p'),{textContent:'고유 본문'}));body.querySelector('.sig p').textContent='이 메일에서 고침';body.dispatchEvent(new Event('input',{bubbles:true}));});
      await expect(c.page.locator('.compose-signature-bar')).toContainText('이 메일에서 수정함');const before=await c.html();
      await c.choose('짧은 서명');const dialog=c.page.getByRole('dialog',{name:'수정한 서명을 바꿀까요?'});await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'취소',exact:true})).toBeFocused();
      await c.page.keyboard.press('Escape');await expect(c.button).toBeFocused();assert.equal(await c.html(),before);
      await c.choose('짧은 서명');await dialog.getByRole('button',{name:'바꾸기',exact:true}).click();await expect(c.button).toBeFocused();await expect(c.body).toContainText('고유 본문');await expect(c.body).toContainText('예시 팀');await expect(c.body).not.toContainText('이 메일에서 고침');
      await c.choose('없음');await expect(c.body).toHaveText('고유 본문');await expect(c.page.locator('.compose-grants[role=status]')).toContainText('0B');assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();}
  });
  await t.test('dirty sender change cancellation preserves sender, HTML and manifest; confirmation uses new address default',async()=>{
    const c=await open();try{
      await c.body.evaluate(body=>{body.querySelector('.sig p').textContent='직접 고침';body.dispatchEvent(new Event('input',{bubbles:true}));});
      const before=await c.html();
      async function changeFrom(){await c.page.getByRole('button',{name:'보낸 사람 선택',exact:true}).click();await c.page.getByRole('option').filter({hasText:'sales@example.com'}).click();}
      await changeFrom();let dialog=c.page.getByRole('dialog');await dialog.getByRole('button',{name:'취소',exact:true}).click();await expect(c.button).toBeFocused();await expect(c.page.getByRole('button',{name:'보낸 사람 선택'})).toContainText('user@example.com');assert.equal(await c.html(),before);
      await changeFrom();await dialog.getByRole('button',{name:'바꾸기',exact:true}).click();await expect(c.button).toBeFocused();await expect(c.page.getByRole('button',{name:'보낸 사람 선택'})).toContainText('sales@example.com');await expect(c.button).toHaveText('서명: 글자 서명');await expect(c.page.locator('.compose-grants[role=status]')).toContainText('0B');
      await c.recipient();await c.page.getByRole('button',{name:'보내기',exact:true}).click();await expect.poll(()=>c.requests.length).toBeGreaterThan(0);const body=c.requests.at(-1).body;assert.equal(body.from,'sales@example.com');assert.deepEqual(body.signatureImages,[]);assert.match(body.html,/감사합니다/);assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();}
  });
  for(const kind of ['reply','replyall','forward'])await t.test(`${kind} chooses reply default and preserves quoted mail when replacing`,async()=>{
    const c=await open({kind});try{
      await expect(c.button).toHaveText('서명: 짧은 서명');const before=await c.body.locator('blockquote').innerHTML();
      await c.choose('외부 연락용');assert.equal(await c.body.locator('blockquote').innerHTML(),before);await expect(c.body.locator('blockquote img').first()).toHaveAttribute('src','cid:received@example.com');await expect(c.body.locator('blockquote img').last()).toHaveAttribute('src',cid(assetA));
      await c.page.getByRole('button',{name:'보낸 사람 선택'}).click();await c.page.getByRole('option').filter({hasText:'sales@example.com'}).click();await expect(c.button).toHaveText('서명: 없음');assert.equal(await c.body.locator('blockquote').innerHTML(),before);assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();}
  });
  await t.test('switching retains a signature image copied into the body and counts unique assets once',async()=>{
    const c=await open();try{
      await expect(c.body.locator('img').first()).toHaveAttribute('src',/^blob:/);
      await c.body.evaluate(body=>{const p=body.ownerDocument.createElement('p');p.append(body.querySelector('img').cloneNode());body.prepend(p);body.dispatchEvent(new Event('input',{bubbles:true}));});
      await c.choose('짧은 서명');await expect(c.page.locator('.compose-grants[role=status]')).toContainText(`${bytes.length*2}B`);
      await c.recipient();await c.page.getByRole('button',{name:'보내기',exact:true}).click();await expect.poll(()=>c.requests.filter(r=>r.path==='send').length).toBe(1);
      const body=c.requests.find(r=>r.path==='send').body;assert.deepEqual(body.signatureImages.map(({assetId})=>assetId),[assetA,assetB]);
      for(const entry of body.signatureImages){assert.ok(body.html.includes(`src="${entry.token}"`));assert.equal(body.html.split(entry.token).length-1,1);}
      assert.equal(body.html.includes('blob:'),false);assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();}
  });
  await t.test('upload capacity includes signature bytes; selecting None releases the same capacity',async()=>{
    const oldLimit=fake.state.config.attachMaxMb;fake.state.config.attachMaxMb=1;
    const c=await open();try{
      const file={name:'example.txt',mimeType:'text/plain',buffer:Buffer.alloc(1024**2-bytes.length+1,65)},before=fake.state.requests.filter(r=>r.path==='/api/attachments').length;
      await c.page.getByLabel('첨부 파일 선택',{exact:true}).setInputFiles(file);await expect(c.page.getByRole('alert')).toContainText('한 메일의 첨부는 모두 합쳐 1MB까지예요');assert.equal(fake.state.requests.filter(r=>r.path==='/api/attachments').length,before);
      await c.choose('없음');await c.page.getByLabel('첨부 파일 선택',{exact:true}).setInputFiles(file);await expect.poll(()=>fake.state.requests.filter(r=>r.path==='/api/attachments').length).toBe(before+1);await expect(c.page.locator('.compose-filename')).toHaveText('example.txt');assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();fake.state.config.attachMaxMb=oldLimit;}
  });
  await t.test('draft A response does not replace B; send waits then submits latest B HTML and matching manifest',async()=>{
    let release;const draftGate=new Promise(resolve=>release=resolve),c=await open({draftGate});
    try{
      await c.page.getByRole('textbox',{name:'제목',exact:true}).fill('스냅샷');await c.recipient();
      await expect.poll(()=>c.requests.filter(r=>r.path==='draft').length,{timeout:7000}).toBe(1);payload(c.requests[0].body);
      await c.choose('짧은 서명');await expect(c.body).toContainText('예시 팀');
      await c.page.getByRole('button',{name:'보내기',exact:true}).click();assert.equal(c.requests.filter(r=>r.path==='send').length,0);release();
      await expect.poll(()=>c.requests.filter(r=>r.path==='send').length).toBe(1);const latest=c.requests.find(r=>r.path==='send').body;payload(latest,assetB);assert.ok(latest.draftRef);assert.match(latest.html,/예시 팀/);assert.equal(latest.html.includes('예시 담당자'),false);assert.equal(latest.signatureImages[0].token.split('.')[1],c.requests[0].body.signatureImages[0].token.split('.')[1]);assert.deepEqual(c.errors,[]);
    }finally{release();await c.page.close();}
  });
  for(const code of ['SIGNATURE_IMAGE_NOT_FOUND','SIGNATURE_INVALID'])await t.test(`422 ${code} explains failure and retains composition`,async()=>{
    const c=await open({sendError:code});try{
      const before=await c.html();await c.recipient();await c.page.getByRole('button',{name:'보내기',exact:true}).click();
      await expect(c.page.getByRole('alert')).toHaveText(code==='SIGNATURE_IMAGE_NOT_FOUND'?'서명 이미지가 보관함에 없어요. 다시 넣어 주세요.':'서명 이름과 기본 서명 설정을 확인해 주세요.');assert.equal(await c.html(),before);await expect(c.button).toHaveText('서명: 외부 연락용');assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();}
  });
  for(const fail of ['failList','failImages'])await t.test(`${fail}: signature API failure still opens a usable empty composer`,async()=>{
    const c=await open({[fail]:true});try{
      await expect(c.button).toHaveText('서명: 없음');await expect(c.page.getByRole('alert')).toHaveText('서명을 불러오지 못했어요. 서명 없이 작성할 수 있어요.');await expect(c.body.locator('.sig')).toHaveCount(0);
      await c.body.fill('서명 없이 작성');await c.recipient();await c.page.getByRole('button',{name:'보내기',exact:true}).click();await expect.poll(()=>c.requests.filter(r=>r.path==='send').length).toBe(1);assert.deepEqual(c.requests.at(-1).body.signatureImages,[]);assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();}
  });
  await t.test('empty signature list offers a focused None item',async()=>{
    const c=await open({signatures:{...signatures,items:[],defaults:{}}});try{
      await c.button.press('Enter');await expect(c.page.getByRole('menuitemradio')).toHaveCount(1);await expect(c.page.getByRole('menuitemradio',{name:'없음'})).toBeFocused();await c.page.keyboard.press('Escape');await expect(c.button).toBeFocused();
      assert.deepEqual(c.errors,[]);
    }finally{await c.page.close();}
  });
});
