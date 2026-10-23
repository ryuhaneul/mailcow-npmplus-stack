import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

const ref = uid => Buffer.from(JSON.stringify(['Drafts',1,uid])).toString('base64url');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7H8AAAAASUVORK5CYII=','base64');
const signatureId = 'S'.repeat(32), cid = 'logo@synthetic.invalid';
function draft(uid) {
  const draftRef=ref(uid);
  return {draftRef,composeFrom:'sales@example.com',fromChanged:false,from:[{address:'sales@example.com'}],to:[{address:'recipient@example.com'}],cc:[{address:'copy@example.com'}],bcc:[{address:'hidden@example.com'}],subject:'이어 쓸 합성 메일',html:`<p>작성 중인 본문</p><div class="sig">저장된 서명</div><img src="cid:${cid}" alt="임시 메일 로고"><blockquote><img src="cid:${cid}" alt="인용 로고"></blockquote>`,inReplyTo:'<reply@synthetic.invalid>',references:'<parent@synthetic.invalid>',attachments:[{ref:draftRef,partId:'2',filename:'same.txt',size:12,contentType:'text/plain'},{ref:draftRef,partId:'3',filename:'logo.png',size:image.length,contentType:'image/png',cid,inline:true},{ref:draftRef,partId:'4',filename:'same.txt',size:13,contentType:'text/plain'}]};
}
function row(message) {
  return {ref:message.draftRef,folder:'Drafts',folderName:'임시보관함',from:{address:'sales@example.com',name:'예시 영업팀'},to:message.to,subject:message.subject,preview:'작성 중인 본문',date:'2026-10-23T00:00:00.000Z',size:1024,seen:true,flagged:false,answered:false,hasAttachment:true};
}

await test('draft resume browser flows with synthetic API only',async t=>{
  const fake=createFakeApi({authenticated:true});
  fake.state.prefs.layout={pane:'right',density:'normal',compose:'full'};
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'draft-resume-api',configureServer(server){server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
  await server.listen();t.after(()=>server.close());t.after(()=>fake.close());
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  let uid=2000;
  async function scenario(width=1280,sender={}){
    const initial={...draft(++uid),...sender},messages=new Map([[initial.draftRef,initial]]),requests=[],errors=[];
    fake.state.mail=fake.state.mail.filter(item=>item.folder!=='Drafts');fake.state.mail.push(row(initial));
    async function open(){
      const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/api/signatures',route=>route.fulfill({json:{revision:'R'.repeat(32),items:[{id:signatureId,name:'기본 서명',html:'<p>새 기본 서명</p>'}],defaults:{'user@example.com':{newDefault:signatureId,replyDefault:signatureId},'sales@example.com':{newDefault:signatureId,replyDefault:signatureId}},usedBytes:100,maxBytes:262144,notices:[]}}));
      await page.route('**/api/drafts/*',route=>{
        const token=decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)),message=messages.get(token);requests.push({path:'load',ref:token});
        return route.fulfill(message?{json:message}:{status:404,json:{error:{code:'MESSAGE_NOT_FOUND',message:'technical missing ref'}}});
      });
      await page.route('**/api/messages/*/parts/*',route=>route.fulfill({contentType:'image/png',body:image}));
      await page.route('**/api/drafts',route=>{
        const body=route.request().postDataJSON();requests.push({path:'save',body});
        const previous=messages.get(body.draftRef);
        if(!previous)return route.fulfill({status:404,json:{error:{code:'MESSAGE_NOT_FOUND',message:'technical missing ref'}}});
        const draftRef=ref(++uid),forwardParts=body.forwardParts.map((part,index)=>({previousRef:part.ref,previousPartId:part.partId,ref:draftRef,partId:`${index+5}`,size:previous.attachments.find(file=>file.ref===part.ref&&file.partId===part.partId).size}));
        const saved={...previous,...body,from:[{address:body.from}],draftRef,attachments:body.forwardParts.map((part,index)=>({...previous.attachments.find(file=>file.ref===part.ref&&file.partId===part.partId),ref:draftRef,partId:forwardParts[index].partId}))};
        messages.delete(body.draftRef);messages.set(draftRef,saved);fake.state.mail=fake.state.mail.filter(item=>item.ref!==body.draftRef);fake.state.mail.push(row(saved));
        return route.fulfill({json:{draftRef,forwardParts}});
      });
      await page.route('**/api/send',route=>{
        const body=route.request().postDataJSON();requests.push({path:'send',body});
        if(!messages.has(body.draftRef))return route.fulfill({status:404,json:{error:{code:'MESSAGE_NOT_FOUND',message:'technical missing ref'}}});
        messages.delete(body.draftRef);fake.state.mail=fake.state.mail.filter(item=>item.ref!==body.draftRef);return route.fulfill({json:{ok:true}});
      });
      await page.goto(origin+'/#f/Drafts');await expect(page.locator('.m[data-ref]')).toHaveCount(1);
      await page.locator('.m[data-ref] .sj').click();
      const body=page.frameLocator('iframe.compose-editor').locator('body');await expect(body).toHaveAttribute('contenteditable','true');
      return {page,body};
    }
    return {initial,messages,requests,errors,open};
  }
  for(const width of [1280,768,375])await t.test(`list opens composer and restores fields, CID images and existing signature at ${width}`,async()=>{
    const s=await scenario(width),{page,body}=await s.open();
    try{
      await expect(page.getByRole('heading',{name:'임시 메일 이어 쓰기'})).toBeVisible();await expect(page.locator('.reader')).toHaveCount(0);
      await expect(page.getByRole('button',{name:'보낸 사람 선택'})).toContainText('sales@example.com');await expect(page.locator('#compose-subject')).toHaveValue(s.initial.subject);
      for(const address of ['recipient@example.com','copy@example.com','hidden@example.com'])await expect(page.locator('.c-inner')).toContainText(address);
      assert.equal(await body.evaluate(node=>{const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});node.dispatchEvent(event);return event.defaultPrevented;}),false);await body.press('Escape');await expect(page.locator('.composer')).toBeVisible();await expect(page.getByRole('button',{name:'임시 저장',exact:true})).toHaveCount(0);await expect(body).toContainText('작성 중인 본문');await expect(body.locator('.sig')).toHaveCount(1);await expect(body).not.toContainText('새 기본 서명');await expect(page.getByRole('button',{name:'서명: 없음'})).toBeVisible();
      await expect.poll(()=>body.locator('img').evaluateAll(imgs=>imgs.length===2&&imgs.every(img=>img.complete&&img.naturalWidth>0&&img.src.startsWith('blob:')))).toBe(true);
      await expect(page.locator('.drop .att')).toHaveCount(3);assert.equal(s.requests.filter(item=>item.path==='save').length,0);
      if(process.env.DRAFT_RESUME_CAPTURE_DIR){await mkdir(process.env.DRAFT_RESUME_CAPTURE_DIR,{recursive:true});await page.screenshot({path:`${process.env.DRAFT_RESUME_CAPTURE_DIR}/draft-resume-${width}.png`,fullPage:true});}
      await page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(page.locator('.composer')).toHaveCount(0);assert.equal(s.messages.size,1);assert.equal(s.requests.filter(item=>item.path==='save').length,0);assert.deepEqual(s.errors,[]);
    }finally{await page.close();}
  });
  await t.test('decoded sizes allow an exact-limit upload; unknown sizes stay conservative until save remaps them',async()=>{
    const previousLimit=fake.state.config.attachMaxMb;fake.state.config.attachMaxMb=1;
    try{
      for(const unknown of [false,true]){
        const s=await scenario();s.initial.html='<p>첨부 크기 시험</p>';s.initial.attachments=[{...s.initial.attachments[0],filename:'large.bin',size:unknown?1048576:786432,...(unknown?{sizeKnown:false}:{})}];
        const {page}=await s.open();
        try{
          if(unknown){
            await expect(page.locator('.drop .att')).toContainText('크기 미확인');await expect(page.locator('.compose-grants').filter({hasText:'첨부'})).toContainText('크기 확인 필요');
            await page.getByLabel('첨부 파일 선택',{exact:true}).setInputFiles({name:'blocked.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(1)});await expect(page.getByRole('alert')).toContainText('붙일 수 없어요');
            await page.route('**/api/drafts',route=>{const body=route.request().postDataJSON(),draftRef=ref(++uid);return route.fulfill({json:{draftRef,forwardParts:[{previousRef:body.draftRef,previousPartId:'2',ref:draftRef,partId:'5',size:786432}]}});});
            await page.locator('#compose-subject').fill('크기 재확인');await expect(page.getByRole('status').filter({hasText:'임시 저장됨'})).toBeVisible({timeout:8000});
          }
          await expect(page.locator('.drop .att')).toContainText('768KB');await expect(page.locator('.drop .att')).not.toContainText('크기 미확인');
          const uploads=fake.state.requests.filter(item=>item.path==='/api/attachments').length;
          await page.getByLabel('첨부 파일 선택',{exact:true}).setInputFiles({name:'quarter.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(262144)});
          await expect(page.locator('.drop .att')).toHaveCount(2);await expect(page.locator('.drop .att').filter({hasText:'quarter.bin'})).toContainText('256KB');assert.equal(fake.state.requests.filter(item=>item.path==='/api/attachments').length,uploads+1);
          await page.getByLabel('첨부 파일 선택',{exact:true}).setInputFiles({name:'overflow.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(1)});await expect(page.getByRole('alert')).toContainText('붙일 수 없어요');await expect(page.locator('.drop .att')).toHaveCount(2);assert.deepEqual(s.errors,[]);
        }finally{await page.close();}
      }
    }finally{fake.state.config.attachMaxMb=previousLimit;}
  });
  await t.test('plain draft inherits the Korean editor font and preserves whitespace at all viewports',async()=>{
    for(const width of [1280,768,375]){
      const s=await scenario(width,{html:'<pre style="font-family:inherit">한글  공백\n  다음 줄</pre>',attachments:[]}),{page,body}=await s.open();
      try{
        await expect(body.locator('pre')).toHaveText('한글  공백\n  다음 줄',{useInnerText:false});
        const style=await body.locator('pre').evaluate(async node=>{await node.ownerDocument.fonts.ready;return {font:getComputedStyle(node).fontFamily,body:getComputedStyle(node.ownerDocument.body).fontFamily,space:getComputedStyle(node).whiteSpace,text:node.textContent,koreanFont:node.ownerDocument.fonts.check('15px Pretendard','한글')};});
        assert.equal(style.font,style.body);assert.match(style.font,/Pretendard/);assert.equal(style.space,'pre');assert.equal(style.text,'한글  공백\n  다음 줄');assert.equal(style.koreanFont,true);
        if(process.env.DRAFT_RESUME_CAPTURE_DIR){await mkdir(process.env.DRAFT_RESUME_CAPTURE_DIR,{recursive:true});await page.screenshot({path:`${process.env.DRAFT_RESUME_CAPTURE_DIR}/draft-plain-${width}.png`,fullPage:true});}assert.deepEqual(s.errors,[]);
      }finally{await page.close();}
    }
  });
  await t.test('unsupported draft opens the reader with an explanation and never saves',async()=>{
    const s=await scenario(),message=s.initial;
    const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(7000);
    try{
      await page.route('**/api/drafts/*',route=>route.fulfill({status:422,json:{error:{code:'DRAFT_UNSUPPORTED',message:'다른 프로그램에서 만든 임시 메일이라 웹메일에서 이어 쓸 수 없어요'}}}));
      await page.goto(origin+'/#f/Drafts');await page.locator('.m[data-ref] .sj').click();await expect(page.locator('.reader')).toBeVisible();await expect(page.locator('.composer')).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'다른 프로그램에서 만든 임시 메일이라'})).toBeVisible();assert.equal(fake.state.requests.some(item=>item.path==='/api/drafts'&&item.method==='PUT'&&item.body?.draftRef===message.draftRef),false);assert.ok(fake.state.mail.some(item=>item.ref===message.draftRef));
    }finally{await page.close();}
  });
  await t.test('native autosave network error retains a visible message',async()=>{
    const s=await scenario(),{page}=await s.open();
    try{await page.route('**/api/drafts',route=>route.abort('failed'));await page.locator('#compose-subject').fill('네트워크 오류 시험');await expect(page.getByRole('alert')).toHaveText(/Failed to fetch|NetworkError|연결|저장/,{timeout:8000});assert.equal(s.messages.size,1);}finally{await page.close();}
  });
  await t.test('Drafts fallback notice allows closing after an immediate send with edited body and a new attachment',async()=>{
    const s=await scenario(),{page,body}=await s.open();
    try{
      let sent;
      await page.route('**/api/send',route=>{sent=route.request().postDataJSON();return route.fulfill({json:{ok:true,warnings:['SENT_COPY_FAILED'],sentCopySavedTo:'drafts'}});});
      await body.evaluate(node=>{node.querySelector('p').textContent='자동 저장 전 최신 본문';node.dispatchEvent(new Event('input',{bubbles:true}));});
      await page.getByLabel('첨부 파일 선택',{exact:true}).setInputFiles({name:'latest.txt',mimeType:'text/plain',buffer:Buffer.from('latest attachment')});await expect(page.locator('.drop .att').filter({hasText:'latest.txt'})).toContainText('17B');
      await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'보낸 그대로의 사본을 임시보관함에 남겨 두었어요'})).toBeVisible();assert.match(sent.html,/최신 본문/);assert.equal(sent.attachmentIds.length,1);assert.equal(s.requests.filter(item=>item.path==='save').length,0);
      await expect(page.getByRole('button',{name:'임시 저장',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(page.locator('.composer')).toHaveCount(0);assert.deepEqual(s.errors,[]);
    }finally{await page.close();}
  });
  await t.test('all copy failures allow manual recovery and cancelled closes retain the composer at every viewport',async()=>{
    for(const width of [1280,768,375]){
      const s=await scenario(width),{page,body}=await s.open();let canSave=false;
      try{
        await page.route('**/api/drafts',route=>canSave?route.fallback():route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'합성 저장 실패'}}}));
        let sends=0;await page.route('**/api/send',route=>{sends++;return route.fulfill({json:{ok:true,warnings:['SENT_COPY_FAILED'],sentCopySavedTo:null}});});
        await body.evaluate(node=>{node.querySelector('p').textContent='복구할 최신 본문';node.dispatchEvent(new Event('input',{bubbles:true}));});
        await page.locator('#compose-bcc').fill('latest-hidden@example.com');
        await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'임시 저장을 눌러 다시 저장해 주세요'})).toBeVisible();await expect(body).toHaveAttribute('contenteditable','true');await expect(page.getByRole('button',{name:'보내기',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'임시 메일 삭제'})).toBeDisabled();
        const dialogs=[];const cancel=async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();};page.on('dialog',cancel);
        await page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(page.locator('.composer')).toBeVisible();
        await page.locator('.compose-dim').dispatchEvent('click');await expect(page.locator('.composer')).toBeVisible();
        await body.press('Escape');await expect.poll(()=>dialogs.length).toBe(3);assert.ok(dialogs.every(message=>message==='이 내용은 계정에 남아 있지 않아요. 그래도 닫을까요?'));assert.equal(sends,1);
        if(process.env.DRAFT_RESUME_CAPTURE_DIR){await mkdir(process.env.DRAFT_RESUME_CAPTURE_DIR,{recursive:true});await page.screenshot({path:`${process.env.DRAFT_RESUME_CAPTURE_DIR}/draft-send-recovery-${width}.png`,fullPage:true});}
        canSave=true;await page.getByRole('button',{name:'임시 저장',exact:true}).click();await expect(page.getByRole('button',{name:'임시 저장',exact:true})).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'임시 저장을 눌러'})).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'임시 저장됨'})).toBeVisible();assert.equal(s.messages.size,1);assert.match([...s.messages.values()][0].html,/복구할 최신 본문/);assert.ok([...s.messages.values()][0].bcc.some(item=>item.address==='latest-hidden@example.com'));
        await page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(page.locator('.composer')).toHaveCount(0);assert.equal(dialogs.length,3);assert.equal(sends,1);assert.deepEqual(s.errors,[]);
      }finally{await page.close();}
    }
  });
  await t.test('all copy failures continue autosave without another SMTP send',async()=>{
    const s=await scenario(),{page,body}=await s.open();let sends=0;
    try{
      await page.route('**/api/send',route=>{sends++;return route.fulfill({json:{ok:true,warnings:['SENT_COPY_FAILED'],sentCopySavedTo:null}});});
      await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.getByRole('button',{name:'임시 저장',exact:true})).toBeVisible();
      await body.evaluate(node=>{node.querySelector('p').textContent='자동 저장 복구 본문';node.dispatchEvent(new Event('input',{bubbles:true}));});
      await expect(page.getByRole('status').filter({hasText:'임시 저장됨'})).toBeVisible({timeout:8000});await expect(page.getByRole('button',{name:'임시 저장',exact:true})).toHaveCount(0);assert.equal(s.messages.size,1);assert.match([...s.messages.values()][0].html,/자동 저장 복구 본문/);assert.equal(sends,1);
    }finally{await page.close();}
  });
  await t.test('confirmed close after all copy failures skips saving and retains temporary uploads',async()=>{
    const s=await scenario(),{page}=await s.open();
    try{
      const deletes=[];await page.route('**/api/attachments/*',route=>{if(route.request().method()==='DELETE')deletes.push(route.request().url());return route.fallback();});
      await page.getByLabel('첨부 파일 선택',{exact:true}).setInputFiles({name:'retained.txt',mimeType:'text/plain',buffer:Buffer.from('retain on close')});await expect(page.locator('.drop .att').filter({hasText:'retained.txt'})).toContainText('15B');
      await page.route('**/api/send',route=>route.fulfill({json:{ok:true,warnings:['SENT_COPY_FAILED'],sentCopySavedTo:null}}));await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.getByRole('button',{name:'임시 저장',exact:true})).toBeVisible();
      page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'닫기',exact:true}).click();await expect(page.locator('.composer')).toHaveCount(0);assert.equal(s.requests.filter(item=>item.path==='save').length,0);assert.deepEqual(deletes,[]);assert.equal(s.messages.size,1);assert.deepEqual(s.errors,[]);
    }finally{await page.close();}
  });
  await t.test('authorized manual sender is kept and revoked sender fallback is announced',async()=>{
    for(const fallback of [false,true]){
      const composeFrom=fallback?'user@example.com':'manual@example.net';
      const s=await scenario(1280,{composeFrom,fromChanged:fallback,from:[{address:fallback?'revoked@synthetic.invalid':composeFrom}]}),{page}=await s.open();
      try{
        await expect(page.getByRole('button',{name:'보낸 사람 선택'})).toContainText(composeFrom);
        if(fallback)await expect(page.getByRole('status').filter({hasText:'보내는 주소를 기본 주소로 바꿨어요.'})).toBeVisible();
        else{await expect(page.getByRole('textbox',{name:'보낸 사람 직접 입력'})).toHaveValue(composeFrom);await expect(page.getByText('보내는 주소를 기본 주소로 바꿨어요.',{exact:true})).toHaveCount(0);}
        await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.locator('.composer')).toHaveCount(0);assert.equal(s.requests.find(item=>item.path==='send').body.from,composeFrom);assert.deepEqual(s.errors,[]);
      }finally{await page.close();}
    }
  });
  await t.test('two autosaves remap refs without losing CID payloads; send deletes draft',async()=>{
    const s=await scenario(),{page,body}=await s.open();
    try{
      for(let index=1;index<=2;index++){
        await body.evaluate((body,index)=>{body.querySelector('p').textContent=`추가 작성 ${index}`;body.dispatchEvent(new Event('input',{bubbles:true}));},index);
        await expect.poll(()=>s.requests.filter(item=>item.path==='save').length,{timeout:8000}).toBe(index);
        await expect(page.getByRole('status').filter({hasText:'임시 저장됨'})).toBeVisible();
        const saved=s.requests.filter(item=>item.path==='save').at(-1).body;assert.equal(saved.html.includes('blob:'),false);assert.equal((saved.html.match(/cid:logo@synthetic.invalid/g)||[]).length,2);assert.equal(saved.forwardParts.length,3);assert.equal(s.messages.size,1);
        if(index===1)assert.equal(saved.draftRef,s.initial.draftRef);else assert.notEqual(saved.draftRef,s.initial.draftRef);
        await expect.poll(()=>body.locator('img').evaluateAll(imgs=>imgs.every(img=>img.complete&&img.naturalWidth>0))).toBe(true);
      }
      await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.locator('.composer')).toHaveCount(0);
      const sent=s.requests.find(item=>item.path==='send').body;assert.equal(s.messages.size,0);assert.equal(sent.forwardParts.length,3);assert.ok(sent.forwardParts.every(part=>part.ref===sent.draftRef));assert.equal(sent.bcc[0].address,'hidden@example.com');assert.equal(sent.inReplyTo,s.initial.inReplyTo);assert.equal(sent.references,s.initial.references);assert.match(sent.html,/추가 작성 2/);assert.match(sent.html,/cid:logo@synthetic.invalid/);assert.doesNotMatch(sent.html,/blob:|새 기본 서명/);assert.deepEqual(s.errors,[]);
    }finally{await page.close();}
  });
  await t.test('two tabs show a Korean stale draft message for save and send; same draft opened again reuses composer',async()=>{
    const s=await scenario(),first=await s.open(),second=await s.open();
    try{
      await first.page.evaluate(async ref=>{const {startCompose}=await import('/src/state/compose.js');startCompose('draft',{ref});},s.initial.draftRef);
      await expect(first.page.locator('.composer')).toHaveCount(1);await expect(first.body).toHaveAttribute('contenteditable','true');assert.equal(s.requests.filter(item=>item.path==='load').length,2);
      await first.page.locator('#compose-subject').fill('첫 탭 변경');await expect.poll(()=>s.requests.filter(item=>item.path==='save').length,{timeout:8000}).toBe(1);await expect(first.page.getByRole('status').filter({hasText:'임시 저장됨'})).toBeVisible();
      await second.page.getByRole('button',{name:'보내기',exact:true}).click();await expect(second.page.getByRole('alert')).toHaveText('임시 메일이 다른 창에서 변경되었거나 삭제됐어요. 임시보관함에서 다시 열어 주세요.');
      await second.page.locator('#compose-subject').fill('두 번째 탭 변경');await expect.poll(()=>s.requests.filter(item=>item.path==='save').length,{timeout:8000}).toBe(2);await expect(second.page.getByRole('alert')).toContainText('임시보관함에서 다시 열어 주세요.');assert.equal(s.messages.size,1);assert.deepEqual(s.errors,[]);
    }finally{await first.page.close();await second.page.close();}
  });
  await t.test('discard trashes the resumed draft and closing after editing saves the current ref',async()=>{
    const s=await scenario(),{page,body}=await s.open();
    try{
      await page.locator('#compose-subject').fill('닫기 저장');await page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(page.locator('.composer')).toHaveCount(0);
      assert.equal(s.requests.filter(item=>item.path==='save').length,1);assert.equal(s.messages.size,1);assert.equal([...s.messages.values()][0].subject,'닫기 저장');
      await expect(page.locator('.m[data-ref]')).toHaveCount(1);await page.locator('.m[data-ref] .sj').click();await expect(body).toHaveAttribute('contenteditable','true');
      await page.getByRole('button',{name:'임시 메일 삭제'}).click();await expect(page.locator('.composer')).toHaveCount(0);
      const action=fake.state.requests.findLast(item=>item.path==='/api/messages/actions');assert.equal(action.body.action,'trash');assert.equal(action.body.refs[0],[...s.messages.keys()][0]);assert.ok(fake.state.mail.some(item=>item.folder==='Trash'&&item.subject==='닫기 저장'));assert.deepEqual(s.errors,[]);
    }finally{await page.close();}
  });
  await t.test('ordinary inbox and shared Drafts rows still open the reader with click and keyboard',async()=>{
    const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(7000);
    try{
      const shared={...row(draft(++uid)),ref:Buffer.from(JSON.stringify(['Shared/sales@example.com/Drafts',1,uid])).toString('base64url'),folder:'Shared/sales@example.com/Drafts',subject:'공유 임시 메일',hasAttachment:false};fake.state.mail.push(shared);
      await page.goto(origin+'/#inbox');await expect(page.locator('.m[data-ref]').first()).toBeVisible();await page.locator('.m[data-ref] .sj').first().click();await expect(page.locator('.reader')).toBeVisible();await expect(page.locator('.composer')).toHaveCount(0);
      await page.goto(origin+'/#f/'+encodeURIComponent(shared.folder));const sharedRow=page.locator('.m[data-ref]');await expect(sharedRow).toHaveCount(1);await sharedRow.focus();await page.keyboard.press('Enter');await expect(page.locator('.reader')).toContainText('공유 임시 메일');await expect(page.locator('.composer')).toHaveCount(0);
    }finally{await page.close();}
  });
});
