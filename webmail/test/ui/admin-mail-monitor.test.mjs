// Authored for the consolidated UI gate. Run only in its approved browser environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';
const captures=process.env.MAIL_MONITOR_CAPTURE_DIR||'/tmp/mail-monitor-ui';
await test('monitor settings, shared overview cards, all states and responsive approved layout',async t=>{
 const fake=createFakeAdminApi();
 const server=await createServer({root:fileURLToPath(new URL('../../web',import.meta.url)),configFile:fileURLToPath(new URL('../../web/vite.admin.config.js',import.meta.url)),logLevel:'error',plugins:[{name:'monitor-fixture',configureServer(s){s.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
 await server.listen();t.after(()=>server.close());const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});t.after(()=>browser.close());await mkdir(captures,{recursive:true});
 const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 async function open(width=1280,mode='light',hash='settings/monitor',route){const context=await browser.newContext({viewport:{width,height:1000},colorScheme:mode,timezoneId:'America/Los_Angeles'});t.after(()=>context.close());const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));if(route)await route(page);await page.goto(origin+'/#'+hash);await page.evaluate(()=>document.fonts.ready);return {page,errors,context};}
 for(const width of [1280,768,375])for(const mode of ['light','dark']){
  const {page,errors,context}=await open(width,mode);await expect(page.locator('.current-cards .metric-card')).toHaveCount(5);await expect(page.getByText('bulk@example.com',{exact:false}).first()).toBeVisible();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${captures}/monitor-${width}-${mode}.png`,fullPage:true});assert.deepEqual(errors,[]);await context.close();
 }
 let view=await open();let page=view.page;
 await page.getByRole('textbox',{name:'추가할 메일 주소'}).fill('bad');await page.getByRole('button',{name:'추가',exact:true}).click();await expect(page.getByText('메일 주소 형식을 확인하세요.')).toBeVisible();
 await page.getByRole('textbox',{name:'추가할 메일 주소'}).fill('new-ops@example.net');await page.getByRole('button',{name:'추가',exact:true}).click();
 await page.getByRole('spinbutton',{name:'계정당 발송 수 5분 기준값',exact:true}).fill('51');await page.getByRole('button',{name:'변경 확인',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('dialog').getByText('51통',{exact:true})).toBeVisible();
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'변경 확인',exact:true})).toBeFocused();assert.equal(fake.state.monitor.writes.length,0);
 await page.getByRole('button',{name:'변경 확인',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'저장',exact:true}).click();await expect(page.getByText('감시 설정을 저장했습니다.')).toBeVisible();assert.equal(fake.state.monitor.writes.at(-1).rules.account[0].threshold,51);assert.ok(fake.state.monitor.writes.at(-1).recipients.includes('new-ops@example.net'));
 fake.state.monitor.writeError={status:409,code:'CHANGED_ELSEWHERE',message:'synthetic conflict'};await page.getByRole('spinbutton',{name:'같은 이상 반복 억제 시간'}).fill('61');await page.getByRole('button',{name:'변경 확인',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'저장',exact:true}).click();await expect(page.getByRole('dialog').getByText('다른 곳에서 설정이 바뀌었습니다. 현재 값을 다시 읽어 주세요.')).toBeVisible();await page.screenshot({path:captures+'/monitor-conflict.png',fullPage:true});fake.state.monitor.writeError=null;await page.getByRole('button',{name:'현재 설정 다시 읽기'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await view.context.close();
 for(const mode of ['warmup','partial','disabled']){fake.state.monitor.mode=mode;view=await open();await expect(view.page.getByText(mode==='disabled'?'감시 꺼짐 · 설정으로':mode==='warmup'?'수집 중 · 감시 창 준비 중':'로그 일부 누락 · 확인 불가',{exact:false}).first()).toBeVisible();await view.page.screenshot({path:`${captures}/monitor-${mode}.png`,fullPage:true});await view.context.close();}
 fake.state.monitor.mode='complete';fake.state.monitor.readError={status:503,code:'MONITOR_STORE_UNAVAILABLE'};view=await open();await expect(view.page.getByRole('alert').first()).toBeVisible();await view.context.close();fake.state.monitor.readError=null;
 let release;const gate=new Promise(resolve=>{release=resolve;});view=await open(1280,'light','settings/monitor',async p=>p.route('**/api/admin/monitor',async route=>{await gate;await route.continue();}));await expect(view.page.getByText('불러오는 중…').first()).toBeVisible();release();await expect(view.page.getByText('항목별 알림 기준')).toBeVisible();await view.context.close();
 view=await open(1280,'light','overview');await expect(view.page.locator('.current-cards .metric-card')).toHaveCount(5);await view.page.locator('.current-cards a').first().click();await expect(view.page).toHaveURL(/#settings\/monitor$/);await expect(view.page.getByText('항목별 알림 기준')).toBeVisible();assert.deepEqual(view.errors,[]);
});
