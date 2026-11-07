import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';
const captures=process.env.OTP_CAPTURE_DIR||'/tmp/otp-ui';
await test('A OTP screens, pending preload boundary, dialogs and responsive states',async t=>{
 const fake=createFakeApi({authenticated:true}),admin=createFakeAdminApi(),root=fileURLToPath(new URL('../../web',import.meta.url));
 const web=await createServer({configFile:false,root,logLevel:'error',plugins:[preact(),{name:'otp-public-fixture',configureServer:s=>{s.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
 const management=await createServer({root,configFile:fileURLToPath(new URL('../../web/vite.admin.config.js',import.meta.url)),logLevel:'error',plugins:[{name:'otp-admin-fixture',configureServer:s=>{s.middlewares.use(admin.middleware);}}],server:{host:'127.0.0.1',port:0}});
 await web.listen();await management.listen();t.after(()=>web.close());t.after(()=>management.close());t.after(()=>fake.close());
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());await mkdir(captures,{recursive:true});
 const origin=`http://127.0.0.1:${web.httpServer.address().port}`,adminOrigin=`http://127.0.0.1:${management.httpServer.address().port}`;
 const defaults={step:'done',enabled:false,registeredAt:null,forced:false,version:'a'.repeat(32),policyRevision:'0',draft:null,error:null};
 async function open(screen,width=1280,mode='light',prepare){
  Object.assign(fake.state.otp,defaults,{enabled:screen==='on'||screen==='otp',registeredAt:screen==='on'||screen==='otp'?'2026-11-01T00:00:00.000Z':null,step:screen==='otp'?'otp':screen==='forced'?'enroll':'done',forced:screen==='forced'});fake.state.prefs.mode=mode;fake.state.prefs.theme='ink';fake.state.authenticated=true;fake.state.requests.length=0;
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:mode});const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  if(prepare)await prepare(page);
  const isAdmin=['policy','account'].includes(screen);
  await page.goto(isAdmin?adminOrigin+'/admin.html#'+(screen==='policy'?'settings/otp':'accounts/person%40example.com'):origin+'/#otp');
  if(screen==='enrollment'){await page.getByRole('button',{name:'2단계 인증 켜기',exact:true}).click();await expect(page.locator('.qr')).toBeVisible();}
  else if(screen==='forced')await expect(page.locator('.qr')).toBeVisible();
  else if(screen==='otp')await expect(page.getByRole('button',{name:'인증하고 로그인',exact:true})).toBeVisible();
  else if(screen==='policy')await expect(page.locator('[data-admin-otp="policy"]')).toBeVisible();
  else if(screen==='account')await expect(page.locator('[data-admin-otp="account"] .kv')).toBeVisible();
  else await expect(page.locator('.otp-state')).toBeVisible();
  await page.evaluate(()=>document.fonts.ready);
  return {page,context,errors};
 }
 for(const width of [1280,768,375])for(const mode of ['light','dark'])for(const screen of ['off','enrollment','on','otp','forced','policy','account']){
  const view=await open(screen,width,mode);
  assert.equal(await view.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${screen} ${width} ${mode} overflow`);
  if(['otp','forced'].includes(screen))assert.equal(fake.state.requests.some(row=>row.path==='/api/prefs'||row.path==='/api/messages'||row.path==='/api/compose/identities'),false);
  if(mode==='light'&&width!==768)await view.page.screenshot({path:`${captures}/${screen}-${width}-${mode}.png`,fullPage:true});
  assert.deepEqual(view.errors,[]);await view.context.close();
 }
 // Self-service enrollment, error focus, local rate-limit timer, cancellation and disable.
 let view=await open('enrollment');let page=view.page;
 fake.state.otp.error='OTP_INVALID';await page.getByLabel('6자리 인증 코드').fill('123456');await page.getByRole('button',{name:'확인하고 켜기',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'다음 코드'})).toBeVisible();await expect(page.getByLabel('6자리 인증 코드')).toBeFocused();
 fake.state.otp.error='OTP_RATE_LIMITED';await page.getByLabel('6자리 인증 코드').fill('123456');await page.getByRole('button',{name:'확인하고 켜기',exact:true}).click();await expect(page.getByText(/초 뒤 다시 시도/)).toBeVisible();await expect(page.getByRole('button',{name:'확인하고 켜기',exact:true})).toBeDisabled();fake.state.otp.error=null;
 await page.getByRole('button',{name:'취소',exact:true}).click();await expect(page.getByRole('button',{name:'2단계 인증 켜기',exact:true})).toBeVisible();assert.equal(fake.state.otp.draft,null);
 await page.getByRole('button',{name:'2단계 인증 켜기',exact:true}).click();await page.getByLabel('6자리 인증 코드').fill('123456');await page.getByRole('button',{name:'확인하고 켜기',exact:true}).click();await expect(page.locator('.otp-badge')).toHaveText('켜짐');
 await page.getByLabel('현재 인증 코드').fill('123456');await page.getByRole('button',{name:'인증하고 끄기',exact:true}).click();await expect(page.locator('.otp-badge')).toHaveText('꺼짐');await view.context.close();
 // Required users cannot defer registration; already registered forced users cannot disable.
 view=await open('forced');assert.equal(await view.page.getByRole('button',{name:/나중에|건너뛰기|취소/}).count(),0);await view.context.close();
 fake.state.otp.forced=true;view=await open('on');fake.state.otp.forced=true;await view.page.reload();await expect(view.page.getByText('관리자가 2단계 인증을 필수로 설정했어요. 필수 적용 중에는 끌 수 없습니다.')).toBeVisible();await expect(view.page.getByRole('button',{name:'2단계 인증 끄기',exact:true})).toBeDisabled();await view.context.close();
 // Native dialog focus return and the required OFF explanation.
 view=await open('policy');page=view.page;const toggle=page.getByRole('checkbox',{name:'전체 강제',exact:true});await toggle.click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(toggle).toBeFocused();assert.equal(admin.state.otp.writes.length,0);
 await toggle.click();await page.getByRole('button',{name:'필수 적용 켜기',exact:true}).click();await expect(page.getByText('2단계 인증 정책을 저장했습니다.')).toBeVisible();await toggle.click();await expect(page.getByRole('dialog').getByText('이미 등록한 사용자의 2단계 인증은 유지됩니다')).toBeVisible();await page.screenshot({path:`${captures}/policy-off-confirm-1280-light.png`,fullPage:true});await page.getByRole('button',{name:'필수 적용 해제',exact:true}).click();await expect(toggle).not.toBeChecked();await view.context.close();
 view=await open('account');page=view.page;const reset=page.locator('[data-admin-otp="account"]').getByRole('button',{name:'초기화',exact:true});await reset.click();await expect(page.getByRole('dialog').getByText('전체 필수 적용 중이면 다음 로그인 때 다시 등록해야 합니다.')).toBeVisible();await page.keyboard.press('Escape');await expect(reset).toBeFocused();
 await reset.click();await page.getByRole('dialog').getByRole('button',{name:'초기화',exact:true}).click();await expect(page.locator('[data-admin-otp="account"]').getByText('미등록',{exact:true})).toBeVisible();await view.context.close();
 // Busy controls prevent duplicate mutation and Escape cannot close a running dialog.
 view=await open('enrollment');page=view.page;let releaseCode,codeRequests=0;const codeGate=new Promise(resolve=>{releaseCode=resolve;});
 await page.route('**/api/otp/enrollment/confirm',async route=>{codeRequests++;await codeGate;await route.continue();});await page.getByLabel('6자리 인증 코드').fill('123456');await page.getByRole('button',{name:'확인하고 켜기',exact:true}).click();await expect(page.getByRole('button',{name:'등록 중…',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'취소',exact:true})).toBeDisabled();assert.equal(codeRequests,1);releaseCode();await expect(page.locator('.otp-badge')).toHaveText('켜짐');await view.context.close();
 view=await open('policy');page=view.page;let releasePolicy,policyRequests=0;const policyGate=new Promise(resolve=>{releasePolicy=resolve;});
 await page.route('**/api/admin/otp/policy',async route=>{if(route.request().method()==='PUT'){policyRequests++;await policyGate;}await route.continue();});await page.getByRole('checkbox',{name:'전체 강제',exact:true}).click();await page.getByRole('button',{name:'필수 적용 켜기',exact:true}).click();await expect(page.getByRole('dialog').getByRole('button',{name:'변경 중…',exact:true})).toBeDisabled();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('dialog').getByRole('button',{name:'취소',exact:true})).toBeDisabled();assert.equal(policyRequests,1);releasePolicy();await expect(page.getByRole('dialog')).toHaveCount(0);await view.context.close();
 // Expired registration removes QR/key; the next attempt starts with a new view.
 view=await open('enrollment',1280,'light',async page=>page.route('**/api/otp/enrollment',async route=>{const response=await route.fetch();const value=await response.json();await route.fulfill({json:{...value,expiresAt:new Date(Date.now()+1500).toISOString()}});}));await expect(view.page.getByText('등록 시간이 지났어요. 새 QR 코드로 다시 시작해 주세요.')).toBeVisible();assert.equal(await view.page.locator('.qr').count(),0);assert.equal(await view.page.locator('.manual-key').count(),0);await view.context.close();
 // Query outage cannot masquerade as zero/unregistered or leave controls enabled.
 admin.state.otp.error='OTP_UNAVAILABLE';view=await openError('settings/otp');await expect(view.page.getByRole('alert')).toBeVisible();assert.equal(await view.page.getByRole('checkbox',{name:'전체 강제'}).count(),0);await view.context.close();
 async function openError(hash){const context=await browser.newContext({viewport:{width:375,height:900}}),page=await context.newPage();await page.goto(adminOrigin+'/admin.html#'+hash);return{page,context};}
});
