import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

await test('send outcome UI uses synthetic mail and never connects to a real server', async t => {
  const fake = createFakeApi({ authenticated: true });
  fake.state.prefs.layout = { pane: 'right', density: 'normal', compose: 'full' };
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../web', import.meta.url)), logLevel: 'error', plugins: [preact(), { name: 'send-outcome-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close()); t.after(() => fake.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] }); t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const sentRef = fake.state.mail.find(item => item.folder === 'Sent').ref;
  const sent = { status: 'sent', ok: true, sentCopySavedTo: 'sent', sentCopyRef: sentRef };
  const unknown = { status: 'unknown', reason: 'SMTP_OUTCOME_UNKNOWN' };
  async function open({ width = 1280, send = sent, lookup = sent, saveError = false, accelerateTimeout = false, sendGate, attachment = false } = {}) {
    fake.state.authenticated = true;
    const page = await browser.newPage({ viewport: { width, height: 900 } }), sends = [], lookups = [], saves = [], errors = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    if (accelerateTimeout) await page.addInitScript(() => {
      window.sendDeadlines = []; const original = AbortSignal.timeout;
      AbortSignal.timeout = function (ms) { window.sendDeadlines.push(ms); return original.call(this, ms === 90000 || ms === 15000 ? 100 : ms); };
    });
    await page.route('**/api/send', async route => {
      sends.push(route.request().postDataJSON());
      if(sendGate)await sendGate;
      if (send === 'lost') return route.abort('failed');
      if (send === 'timeout') { await new Promise(resolve => setTimeout(resolve, 300)); try { await route.fulfill({ json: sent }); } catch {} return; }
      return route.fulfill(send.error ? { status: ['CSRF','BAD_ORIGIN'].includes(send.error.code)?403:502, json: send } : { json: send });
    });
    await page.route('**/api/send/*', route => {
      lookups.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)));
      const value = typeof lookup === 'function' ? lookup(lookups.length) : lookup;
      if (value === 'lost') return route.abort('failed');
      if (value === 'expired') return route.fulfill({ status: 403, json: { error: { code: 'SESSION_EXPIRED', message: '다시 로그인해 주세요.' } } });
      return route.fulfill({ json: value });
    });
    await page.route('**/api/drafts', route => {
      saves.push(route.request().postDataJSON());
      return saveError ? route.fulfill({ status: 503, json: { error: { code: 'MAIL_UNAVAILABLE', message: '메일 서버에 연결할 수 없어요.' } } }) : route.fallback();
    });
    await page.goto(origin + '/#compose');
    const body = page.frameLocator('iframe.compose-editor').locator('body');
    await expect(body).toHaveAttribute('contenteditable', 'true');
    await page.getByRole('combobox', { name: '받는 사람 추가', exact: true }).fill('recipient@example.com');
    await page.locator('#compose-subject').fill('합성 발송 시험');
    await body.fill('합성 본문');
    if(attachment){await page.getByLabel('첨부 파일 선택',{exact:true}).setInputFiles({name:'retained.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic attachment')});await expect(page.locator('.drop .att').filter({hasText:'retained.txt'})).toContainText('20B');}

    await page.getByRole('button', { name: '보내기', exact: true }).click();
    return { page, body, sends, lookups, saves, errors, result: page.locator('.compose-result'), sendButton: page.getByRole('button', { name: '보내기', exact: true }) };
  }
  async function capture(c, name, width) {
    if (process.env.SEND_STATUS_CAPTURE_DIR) {
      await mkdir(process.env.SEND_STATUS_CAPTURE_DIR, { recursive: true });
      await c.page.screenshot({ path: `${process.env.SEND_STATUS_CAPTURE_DIR}/${name}-${width}.png`, fullPage: true });
    }
    assert.equal(await c.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(c.errors, []);
  }
  for (const width of [1280, 768, 375]) {
    await t.test(`sent result includes copy location and direct message link at ${width}`, async () => {
      const c = await open({ width });
      try {
        await expect(c.result).toContainText('보냈어요'); await expect(c.result).toContainText('보낸편지함에 사본을 저장했어요.');
        await expect(c.sendButton).toBeDisabled(); await expect(c.page.getByRole('alert')).toHaveCount(0);
        const link = c.page.getByRole('link', { name: '보낸 메일 보기' }); await expect(link).toHaveAttribute('href', `#read/${encodeURIComponent(sentRef)}`);
        await capture(c, 'sent', width);
        await link.click(); await expect(c.page.locator('.composer')).toHaveCount(0); await expect(c.page.locator('.reader')).toBeVisible();
        assert.equal(c.saves.length, 0); assert.equal(c.sends.length, 1);
      } finally { await c.page.close(); }
    });
    await t.test(`not_sent result has a Korean reason and permits retry at ${width}`, async () => {
      const error = { code: 'SMTP_REJECTED', message: '메일 서버가 보내기를 거절했어요.', smtpMessage: '550 synthetic rejection' };
      const c = await open({ width, send: { error }, lookup: { status: 'not_sent', error } });
      try {
        await expect(c.result).toContainText('안 보냈어요'); await expect(c.result).toContainText(error.message); await expect(c.result).toContainText(error.smtpMessage);
        await expect(c.result.locator('p')).toHaveText([error.message, `서버 응답: ${error.smtpMessage}`, '내용을 확인하고 다시 보내 주세요.']);
        await expect(c.sendButton).toBeEnabled(); await expect(c.page.locator('#compose-subject')).toBeEnabled();
        assert.deepEqual(c.lookups, [c.sends[0].composeId]); await capture(c, 'not-sent', width);
      } finally { await c.page.close(); }
    });
    await t.test(`lost response keeps checking, locks send and resolves with one explicit lookup at ${width}`, async () => {
      const c = await open({ width, send: 'lost', lookup: count => count === 1 ? { status: 'checking' } : sent });
      try {
        await expect(c.result).toContainText('아직 보내는 중이에요'); await expect(c.sendButton).toBeDisabled();
        await expect(c.page.locator('#compose-subject')).toBeDisabled(); await expect(c.page.getByRole('button', { name: '확인했는데 없으면 다시 보내기' })).toHaveCount(0);
        await capture(c, 'checking', width); await c.page.getByRole('button', { name: '다시 확인', exact: true }).click();
        await expect(c.result).toContainText('보냈어요'); assert.equal(c.sends.length, 1); assert.deepEqual(c.lookups, [c.sends[0].composeId, c.sends[0].composeId]);
      } finally { await c.page.close(); }
    });
    await t.test(`unknown delivery allows only checked retry with explicit duplicate-risk confirmation at ${width}`, async () => {
      const c = await open({ width, send: unknown, lookup: unknown });
      try {
        await expect(c.result).toContainText('발송 여부 확인 필요'); await expect(c.result).toContainText('보낸편지함·임시보관함을 확인해 주세요'); await expect(c.sendButton).toBeDisabled();
        await capture(c, 'unknown', width);
        const retry = c.page.getByRole('button', { name: '확인했는데 없으면 다시 보내기', exact: true });
        c.page.once('dialog', async dialog => { assert.equal(dialog.message(), '받는 사람에게 같은 메일이 두 번 갈 수 있어요. 다시 보낼까요?'); await dialog.dismiss(); });
        await retry.click(); assert.equal(c.sends.length, 1);
        await c.page.route('**/api/send', route => { c.sends.push(route.request().postDataJSON()); return route.fulfill({ json: sent }); });
        c.page.once('dialog', dialog => dialog.accept()); await retry.click(); await expect(c.result).toContainText('보냈어요');
        assert.equal(c.sends.length, 2); assert.notEqual(c.sends[0].composeId, c.sends[1].composeId); assert.equal(c.sends[0].html, c.sends[1].html);
      } finally { await c.page.close(); }
    });
  }
  await t.test('lost response followed by lookup shows success and never emits a send failure', async () => {
    const c = await open({ send: 'lost' });
    try { await expect(c.result).toContainText('보냈어요'); await expect(c.page.getByRole('alert')).toHaveCount(0); assert.equal(c.sends.length, 1); assert.equal(c.lookups.length, 1); } finally { await c.page.close(); }
  });
  await t.test('failed status lookup remains unknown and cannot resend without an authoritative outcome', async () => {
    const c = await open({ send: 'lost', lookup: 'lost' });
    try {
      await expect(c.result).toContainText('발송 여부 확인 필요'); await expect(c.sendButton).toBeDisabled();
      await expect(c.page.getByRole('button', { name: '확인했는데 없으면 다시 보내기' })).toHaveCount(0);
      await expect(c.page.getByRole('button', { name: '쓰기 창 닫기' })).toBeEnabled();
      await c.page.waitForTimeout(3500); assert.equal(c.lookups.length, 1); assert.equal(c.saves.length, 0);
      await c.page.getByRole('button', { name: '다시 확인', exact: true }).click(); await expect.poll(() => c.lookups.length).toBe(2);
    } finally { await c.page.close(); }
  });
  await t.test('all copy failures never autosave or show a red send error; manual recovery stays available', async () => {
    const c = await open({ send: { status: 'sent', ok: true, sentCopySavedTo: null, warnings: ['SENT_COPY_FAILED'] }, saveError: true });
    try {
      await expect(c.result).toContainText('보냈어요'); await expect(c.result).toContainText('임시 저장을 눌러 다시 저장해 주세요');
      await c.body.fill('합성 복구 본문'); await c.page.waitForTimeout(3500); assert.equal(c.saves.length, 0);
      await expect(c.page.getByRole('alert')).toHaveCount(0); await expect(c.sendButton).toBeDisabled();
      await c.page.getByRole('button', { name: '임시 저장', exact: true }).click();
      await expect(c.result).toContainText('사본을 임시 저장하지 못했어요'); await expect(c.page.getByRole('button',{name:'임시 저장',exact:true})).toBeVisible(); await expect(c.result).toContainText('보냈어요'); await expect(c.page.getByRole('alert')).toHaveCount(0);
      assert.equal(c.sends.length, 1); assert.equal(c.saves.length, 1); assert.deepEqual(c.errors, []);
    } finally { await c.page.close(); }
  });
  await t.test('Drafts fallback remains one sent result with the correct copy location', async () => {
    const c = await open({ send: { status: 'sent', ok: true, sentCopySavedTo: 'drafts', warnings: ['SENT_COPY_FAILED'] } });
    try { await expect(c.result).toContainText('보냈어요'); await expect(c.result).toContainText('사본을 임시보관함에 남겨 두었어요'); await expect(c.page.getByRole('alert')).toHaveCount(0); await expect(c.page.getByRole('button', { name: '임시 저장', exact: true })).toHaveCount(0); } finally { await c.page.close(); }
  });
  await t.test('request deadline moves to status lookup while the original request may still complete', async () => {
    const c = await open({ send: 'timeout', lookup: { status: 'checking' }, accelerateTimeout: true });
    try {
      await expect.poll(() => c.lookups.length).toBe(1); await expect(c.result).toContainText('아직 보내는 중이에요'); await expect(c.sendButton).toBeDisabled();
      assert.deepEqual(await c.page.evaluate(() => window.sendDeadlines), [90000, 15000]); await c.page.waitForTimeout(350); assert.equal(c.sends.length, 1);
    } finally { await c.page.close(); }
  });
  await t.test('session expiry preserves a generic unknown-delivery notice through same-user login', async () => {
    const c = await open({ send: 'lost', lookup: count => count === 1 ? 'expired' : {status:'unknown',reason:'NOT_FOUND'} });
    try {
      await expect(c.page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
      await expect(c.page.locator('.login-card [role=status]')).toContainText('보낸편지함·임시보관함을 확인해 주세요');
      await expect(c.page.locator('.login-card')).not.toContainText('합성 발송 시험');
      await c.page.getByRole('textbox', { name: '메일 주소', exact: true }).fill('user@example.com'); await c.page.getByLabel('암호', { exact: true }).fill('example-password'); await c.page.getByRole('button', { name: '로그인', exact: true }).click();
      await expect(c.page.locator('.toast')).toContainText('보낸편지함·임시보관함을 확인해 주세요'); assert.equal(c.sends.length, 1);
    } finally { await c.page.close(); }
  });
  await t.test('another account login clears the previous account unknown-delivery notice', async () => {
    const c = await open({ send: 'lost', lookup: count => count === 1 ? 'expired' : {status:'unknown',reason:'NOT_FOUND'} });
    try {
      await expect(c.page.locator('.login-card [role=status]')).toContainText('보낸편지함·임시보관함을 확인해 주세요');
      await c.page.route('**/api/auth/login', route => route.fulfill({ json: { user: { email: 'other@example.com', name: '합성 사용자' }, csrf: 'other-synthetic-csrf', expiresAt: Date.now() + 3600000 } }));
      await c.page.getByRole('textbox', { name: '메일 주소', exact: true }).fill('other@example.com'); await c.page.getByLabel('암호', { exact: true }).fill('example-password'); await c.page.getByRole('button', { name: '로그인', exact: true }).click();
      await expect(c.page.locator('.mailview')).toBeVisible(); await expect(c.page.locator('.toast')).toHaveCount(0);
    } finally { await c.page.close(); }
  });
  await t.test('unknown result can inspect both folders and return without losing the model or key', async () => {
    const c = await open({ width: 375, send: unknown, lookup: unknown });
    try {
      await expect(c.result).toContainText('발송 여부 확인 필요');
      const key = c.sends[0].composeId;
      await c.page.getByRole('button', { name: '보낸편지함 확인', exact: true }).click();
      await expect(c.page.locator('.composer')).toBeHidden();
      const notice = c.page.getByRole('button', { name: '발송 결과 확인 중인 메일이 있어요 확인하기' });
      await expect(notice).toBeVisible(); assert.equal(new URL(c.page.url()).hash, '#f/Sent');
      await notice.click(); await expect(c.result).toContainText('발송 여부 확인 필요');
      await expect(c.page.locator('#compose-subject')).toHaveValue('합성 발송 시험'); await expect(c.body).toHaveText('합성 본문');
      await c.page.getByRole('button', { name: '임시보관함 확인', exact: true }).click();
      await expect(notice).toBeVisible(); assert.equal(new URL(c.page.url()).hash, '#f/Drafts');
      await c.page.evaluate(async () => { const { startCompose } = await import('/src/state/compose.js'); startCompose('new', { subject: 'must not replace original' }); });
      await expect(c.result).toContainText('발송 여부 확인 필요'); await expect(c.page.locator('#compose-subject')).toHaveValue('합성 발송 시험');
      await c.page.getByRole('button', { name: '다시 확인', exact: true }).click(); await expect.poll(() => c.lookups.length).toBe(1);
      assert.equal(c.lookups[0], key); assert.equal(c.sends.length, 1); assert.equal(c.saves.length, 0);
    } finally { await c.page.close(); }
  });
  await t.test('unknown result restores only its key and hashed account after reload, never mail content', async () => {
    const c = await open({ send: unknown, lookup: unknown });
    try {
      await expect(c.result).toContainText('발송 여부 확인 필요');
      const record = await c.page.evaluate(() => JSON.parse(sessionStorage.getItem('webmail.pending-sends'))[0]);
      assert.deepEqual(Object.keys(record).sort(), ['accountHash', 'composeId', 'recordedAt']); assert.match(record.accountHash, /^[a-f0-9]{64}$/); assert.equal(record.composeId, c.sends[0].composeId);
      assert.equal(JSON.stringify(record).includes('recipient@example.com'), false); assert.equal(JSON.stringify(record).includes('user@example.com'), false); assert.equal(JSON.stringify(record).includes('합성'), false);
      await c.page.reload(); await expect(c.result).toContainText('발송 여부 확인 필요');
      assert.deepEqual(c.lookups, [record.composeId]); assert.equal(c.sends.length, 1);
      await expect(c.page.locator('iframe.compose-editor')).toHaveCount(0); await expect(c.page.getByRole('button', { name: '확인했는데 없으면 다시 보내기' })).toHaveCount(0);
      await expect(c.page.getByRole('button', { name: '보낸편지함 확인' })).toBeVisible();
      await c.page.route('**/api/send/*', route => route.fulfill({ json: sent }));
      await c.page.getByRole('button', { name: '다시 확인', exact: true }).click(); await expect(c.result).toContainText('보냈어요');
      assert.equal(await c.page.evaluate(() => sessionStorage.getItem('webmail.pending-sends')), null);
    } finally { await c.page.close(); }
  });
  await t.test('missing server receipt restores a generic notice, clears storage, and does not guess delivery', async () => {
    const c = await open({ send: unknown, lookup: { status: 'unknown', reason: 'NOT_FOUND' } });
    try {
      await expect(c.result).toContainText('발송 여부 확인 필요'); await c.page.reload();
      await expect(c.result).toContainText('발송 여부 확인 필요'); await expect(c.result).toContainText('보낸편지함·임시보관함을 확인해 주세요');
      assert.equal(await c.page.evaluate(() => sessionStorage.getItem('webmail.pending-sends')), null); assert.equal(c.sends.length, 1);
      await expect(c.result).not.toContainText('보냈어요'); await expect(c.result).not.toContainText('안 보냈어요');
    } finally { await c.page.close(); }
  });
  await t.test('restored unknown can finish checking only after confirmation and does not open a new composition', async () => {
    const c = await open({ send: unknown, lookup: unknown });
    try {
      await expect(c.result).toContainText('발송 여부 확인 필요'); await c.page.reload(); await expect(c.result).toContainText('발송 여부 확인 필요');
      const finish = c.page.getByRole('button', { name: '확인 끝내기', exact: true });
      c.page.once('dialog', dialog => dialog.dismiss()); await finish.click(); await expect(c.result).toBeVisible();
      assert.notEqual(await c.page.evaluate(() => sessionStorage.getItem('webmail.pending-sends')), null);
      c.page.once('dialog', async dialog => { assert.equal(dialog.message(), '보낸편지함에 메일이 없으면 임시보관함 사본이나 새 메일로 다시 보내 주세요'); await dialog.accept(); });
      await finish.click(); await expect(c.page.locator('.composer')).toHaveCount(0); assert.equal(await c.page.evaluate(() => sessionStorage.getItem('webmail.pending-sends')), null);
      await expect(c.page.locator('.pending-send-notice')).toHaveCount(0); assert.equal(c.sends.length, 1); assert.equal(c.saves.length, 0);
    } finally { await c.page.close(); }
  });
  await t.test('reload under another account deletes the stored marker without querying the previous key', async () => {
    const c = await open({ send: unknown, lookup: unknown });
    try {
      await expect(c.result).toContainText('발송 여부 확인 필요');
      await c.page.route('**/api/auth/session', route => route.fulfill({ json: { user: { email: 'other@example.com', name: '합성 사용자' }, csrf: 'other-csrf', expiresAt: Date.now() + 3600000 } }));
      await c.page.goto(origin + '/#inbox'); await c.page.reload(); await expect(c.page.locator('.mailview')).toBeVisible();
      await expect(c.page.locator('.composer')).toHaveCount(0); await expect(c.page.locator('.pending-send-notice')).toHaveCount(0); await expect(c.page.locator('.toast')).toHaveCount(0);
      assert.equal(await c.page.evaluate(() => sessionStorage.getItem('webmail.pending-sends')), null); assert.equal(c.lookups.length, 0); assert.equal(c.sends.length, 1);
    } finally { await c.page.close(); }
  });

  await t.test('restored receipt lookup works when compose dependencies are unavailable', async () => {
    const c = await open({ send: unknown, lookup: sent });
    try {
      await expect(c.result).toContainText('발송 여부 확인 필요');
      for(const path of ['compose/identities','signatures','signature-images','rules'])await c.page.route(`**/api/${path}`,route=>route.fulfill({status:503,json:{error:{code:'MAIL_UNAVAILABLE',message:'합성 작성 서비스 중단'}}}));
      await c.page.reload(); await expect(c.result).toContainText('보냈어요'); await expect(c.result).toContainText('보낸편지함에 사본을 저장했어요');
      await expect(c.page.getByRole('alert')).toHaveCount(0); assert.equal(c.lookups.length,1); assert.equal(c.sends.length,1);
      await c.result.getByRole('button',{name:'닫기',exact:true}).click();await expect(c.page.locator('.composer')).toHaveCount(0);
    } finally { await c.page.close(); }
  });

  for(const code of ['CSRF','BAD_ORIGIN'])await t.test(`explicit pre-handler ${code} refusal is not_sent even without a server receipt`, async () => {
    const c=await open({send:{error:{code,message:'요청을 확인할 수 없어요. 화면을 새로 고친 뒤 다시 시도해 주세요.'}},lookup:{status:'unknown',reason:'NOT_FOUND'}});
    try {
      await expect(c.result).toContainText('안 보냈어요');await expect(c.sendButton).toBeEnabled();assert.equal(c.lookups.length,0);
      assert.equal(await c.page.evaluate(()=>sessionStorage.getItem('webmail.pending-sends')),null);assert.equal(c.sends.length,1);
    } finally {await c.page.close();}
  });

  for(const outcome of ['sent','not_sent'])await t.test(`hidden ${outcome} result stays in a persistent notice and opens the original result panel`, async () => {
    let release;const sendGate=new Promise(resolve=>release=resolve),error={code:'SMTP_REJECTED',message:'메일 서버가 보내기를 거절했어요.'};
    const c=await open({send:outcome==='sent'?sent:{error},lookup:outcome==='sent'?sent:{status:'not_sent',error},sendGate});
    try {
      await expect.poll(()=>c.sends.length).toBe(1);await c.page.evaluate(async()=>{const {navigate}=await import('/src/router.js');navigate('f/Sent');});
      await expect(c.page.locator('.pending-send-notice')).toBeVisible();release();
      const notice=c.page.locator('.send-result-notice');await expect(notice).toContainText(outcome==='sent'?'메일을 보냈어요':'보내지 못했어요');
      await expect(c.page.locator('.pending-send-notice')).toHaveCount(0);await expect(c.page.locator('.composer')).toBeHidden();assert.equal(new URL(c.page.url()).hash,'#f/Sent');
      if(outcome==='not_sent')await expect(notice).toHaveClass(/error/);
      await c.page.evaluate(async()=>{const {toast}=await import('/src/state/toast.js');toast.value={kind:'info',message:'합성 다른 알림'};});
      await c.page.waitForTimeout(1200);await expect(notice).toBeVisible();await capture(c,`hidden-${outcome}`,1280);
      await notice.getByRole('button',{name:'결과 보기',exact:true}).click();await expect(notice).toHaveCount(0);
      await expect(c.result).toContainText(outcome==='sent'?'보냈어요':'안 보냈어요');await expect(c.page.locator('#compose-subject')).toHaveValue('합성 발송 시험');
      assert.equal(c.sends.length,1);
    } finally {release();await c.page.close();}
  });
  await t.test('dismissing a hidden successful result with no remaining work also clears the composition', async () => {
    let release;const sendGate=new Promise(resolve=>release=resolve),c=await open({sendGate});
    try {
      await expect.poll(()=>c.sends.length).toBe(1);await c.page.evaluate(async()=>{const {navigate}=await import('/src/router.js');navigate('f/Sent');});release();
      const notice=c.page.locator('.send-result-notice');await expect(notice).toContainText('메일을 보냈어요');await notice.getByRole('button',{name:'닫기',exact:true}).click();
      await expect(c.page.locator('.composer')).toHaveCount(0);await expect(notice).toHaveCount(0);assert.equal(c.sends.length,1);
    } finally {release();await c.page.close();}
  });

  await t.test('dismissing a hidden sent notice preserves a composition that still needs manual copy recovery', async () => {
    let release;const sendGate=new Promise(resolve=>release=resolve),c=await open({width:375,sendGate,send:{status:'sent',ok:true,sentCopySavedTo:null,warnings:['SENT_COPY_FAILED']}});
    try {
      await expect.poll(()=>c.sends.length).toBe(1);await c.page.evaluate(async()=>{const {navigate}=await import('/src/router.js');navigate('f/Sent');});release();
      const notice=c.page.locator('.send-result-notice');await expect(notice).toContainText('메일을 보냈어요 · 사본 저장이 필요해요');await notice.getByRole('button',{name:'닫기',exact:true}).click();
      await c.page.evaluate(async()=>{const {startCompose}=await import('/src/state/compose.js');startCompose('new');});
      await expect(c.page.locator('#compose-subject')).toHaveValue('합성 발송 시험');await expect(c.body).toHaveText('합성 본문');await expect(c.page.getByRole('button',{name:'임시 저장',exact:true})).toBeVisible();
      await c.page.getByRole('button',{name:'임시 저장',exact:true}).click();await expect(c.result).toContainText('보낸 메일은 나갔어요. 작성 내용의 복구본을 임시보관함에 저장했어요');
      await capture(c,'manual-recovery',375);assert.equal(c.sends.length,1);
    } finally {release();await c.page.close();}
  });

  await t.test('real unknown model has no finish action and failed close preserves body and attachment until confirmed', async () => {
    const c=await open({send:unknown,lookup:unknown,saveError:true,attachment:true});
    try {
      await expect(c.result).toContainText('발송 여부 확인 필요');
      await expect(c.page.getByRole('button',{name:'확인 끝내기',exact:true})).toHaveCount(0);
      await expect(c.page.getByRole('button',{name:'쓰기 창 닫기'})).toBeEnabled();
      let dismissed=false;c.page.once('dialog',async dialog=>{assert.equal(dialog.message(),'이 내용은 계정에 남아 있지 않아요. 그래도 닫을까요?');await dialog.dismiss();dismissed=true;});
      await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();
      await expect.poll(()=>c.saves.length).toBe(1);await expect(c.body).toHaveText('합성 본문');
      await expect(c.page.locator('#compose-subject')).toHaveValue('합성 발송 시험');await expect(c.page.locator('.drop .att')).toContainText('retained.txt');assert.deepEqual(c.saves[0].attachmentIds,c.sends[0].attachmentIds);
      await expect.poll(()=>dismissed).toBe(true);await expect(c.page.getByRole('button',{name:'쓰기 창 닫기'})).toBeEnabled();
      c.page.once('dialog',dialog=>dialog.accept());await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();
      await expect(c.page.locator('.composer')).toHaveCount(0);await expect(c.page.locator('.detached-send-notice')).toContainText('1통');
      assert.equal(c.sends.length,1);
    }finally{await c.page.close();}
  });
  await t.test('copy pending retains receipt and model when close save fails, then closes after saving', async () => {
    const c=await open({send:'lost',lookup:{status:'sent',copyPending:true},saveError:true,attachment:true});
    try {
      await expect(c.result).toContainText('보냈어요');
      assert.match(await c.page.evaluate(()=>sessionStorage.getItem('webmail.pending-sends')),new RegExp(c.sends[0].composeId));
      c.page.once('dialog',dialog=>dialog.dismiss());await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();
      await expect.poll(()=>c.saves.length).toBe(1);await expect(c.body).toHaveText('합성 본문');await expect(c.page.locator('.drop .att')).toContainText('retained.txt');assert.deepEqual(c.saves[0].attachmentIds,c.sends[0].attachmentIds);
      assert.match(await c.page.evaluate(()=>sessionStorage.getItem('webmail.pending-sends')),new RegExp(c.sends[0].composeId));
      await c.page.unroute('**/api/drafts');await c.page.route('**/api/drafts',route=>{c.saves.push(route.request().postDataJSON());return route.fallback();});
      await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(c.page.locator('.composer')).toHaveCount(0);
      assert.equal(c.saves.length,2);assert.equal(c.sends.length,1);
    }finally{await c.page.close();}
  });
  for(const outcome of [unknown,{status:'sent',copyPending:true}])await t.test(`lookup failure preserves authoritative ${outcome.status} outcome and actions`, async()=>{
    const c=await open({send:outcome,lookup:'lost'});
    try{
      await expect(c.result).toContainText(outcome.status==='sent'?'보냈어요':'발송 여부 확인 필요');
      await c.page.getByRole('button',{name:'다시 확인',exact:true}).click();
      await expect(c.result).toContainText('결과를 다시 확인하지 못했어요 — 잠시 뒤 다시 확인');
      await expect(c.result).toContainText(outcome.status==='sent'?'보냈어요':'발송 여부 확인 필요');
      if(outcome.status==='unknown')await expect(c.page.getByRole('button',{name:'확인했는데 없으면 다시 보내기',exact:true})).toBeVisible();
      await c.page.route('**/api/send/*',route=>route.fulfill({json:outcome.status==='sent'?sent:unknown}));await c.page.getByRole('button',{name:'다시 확인',exact:true}).click();await expect(c.result).not.toContainText('결과를 다시 확인하지 못했어요');
    }finally{await c.page.close();}
  });
  for(const width of [1280,768,375])await t.test(`closing unknown preserves its record across a new successful send and detached lookup at ${width}`, async()=>{
    const c=await open({width,send:unknown,lookup:sent,attachment:true});
    try{
      await expect(c.result).toContainText('발송 여부 확인 필요');const key=c.sends[0].composeId;
      await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(c.page.locator('.composer')).toHaveCount(0);
      assert.equal(c.saves.length,1);assert.match(c.saves[0].html,/합성 본문/);assert.equal(c.saves[0].attachmentIds.length,1);assert.deepEqual(c.saves[0].attachmentIds,c.sends[0].attachmentIds);
      await expect(c.page.locator('.detached-send-notice')).toContainText('1통');
      await c.page.evaluate(async()=>{const {startCompose}=await import('/src/state/compose.js');startCompose('new');});
      await expect(c.body).toHaveAttribute('contenteditable','true');await c.body.fill('두 번째 메일');
      await c.page.getByRole('combobox',{name:'받는 사람 추가',exact:true}).fill('second@example.com');
      await c.page.locator('#compose-subject').fill('두 번째 제목');
      await c.page.route('**/api/send',route=>{c.sends.push(route.request().postDataJSON());return route.fulfill({json:sent});});
      await c.sendButton.click();await expect(c.result).toContainText('보냈어요');
      const records=await c.page.evaluate(()=>JSON.parse(sessionStorage.getItem('webmail.pending-sends')));
      assert.deepEqual(records.map(item=>item.composeId),[key]);
      await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(c.page.locator('.composer')).toHaveCount(0);
      await capture(c,'detached-pending',width);await c.page.locator('.detached-send-notice').getByRole('button',{name:'다시 확인',exact:true}).click();
      await expect(c.page.locator('.detached-send-notice')).toContainText('보냈어요');await capture(c,'detached-sent',width);
      assert.deepEqual(c.lookups,[key]);assert.equal(c.sends.length,2);
      assert.equal(await c.page.evaluate(()=>sessionStorage.getItem('webmail.pending-sends')),null);
    }finally{await c.page.close();}
  });

  await t.test('receipt storage migrates legacy metadata, caps at twenty and removes only the confirmed key',async()=>{
    const c=await open();
    try{
      await expect(c.result).toContainText('보냈어요');
      const evidence=await c.page.evaluate(async()=>{
        const state=await import('/src/state/compose.js');
        for(let index=0;index<22;index++){await state.rememberSendAttempt(`synthetic-${index}`,'user@example.com');state.detachSendAttempt(`synthetic-${index}`);}
        const capped=JSON.parse(sessionStorage.getItem('webmail.pending-sends'));
        state.clearSendAttempt('synthetic-10');const remaining=JSON.parse(sessionStorage.getItem('webmail.pending-sends'));
        sessionStorage.removeItem('webmail.pending-sends');sessionStorage.setItem('webmail.pending-send',JSON.stringify({composeId:'legacy-synthetic',accountHash:capped[0].accountHash}));
        await state.restoreSendAttempt('user@example.com');
        const migrated=JSON.parse(sessionStorage.getItem('webmail.pending-sends')),legacy=sessionStorage.getItem('webmail.pending-send');
        await state.restoreSendAttempt('other@example.com');
        return {capped,remaining,migrated,legacy,other:sessionStorage.getItem('webmail.pending-sends'),detached:state.detachedSendAttempts.value};
      });
      assert.equal(evidence.capped.length,20);assert.equal(evidence.capped[0].composeId,'synthetic-2');assert.equal(evidence.capped.at(-1).composeId,'synthetic-21');
      assert.equal(evidence.remaining.length,19);assert.equal(evidence.remaining.some(item=>item.composeId==='synthetic-10'),false);
      assert.deepEqual(Object.keys(evidence.migrated[0]).sort(),['accountHash','composeId','recordedAt']);assert.equal(evidence.migrated[0].composeId,'legacy-synthetic');
      assert.equal(evidence.legacy,null);assert.equal(evidence.other,null);assert.deepEqual(evidence.detached,[]);
    }finally{await c.page.close();}
  });
  for(const outcome of [{status:'not_sent',error:{message:'합성 SMTP 거절'}},{status:'unknown',reason:'NOT_FOUND'}])await t.test(`detached lookup clears only resolved ${outcome.status} record and shows accurate guidance`,async()=>{
    const c=await open({send:unknown,lookup:outcome});
    try{
      await expect(c.result).toContainText('발송 여부 확인 필요');await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(c.page.locator('.composer')).toHaveCount(0);
      await c.page.locator('.detached-send-notice').getByRole('button',{name:'다시 확인',exact:true}).click();
      const notice=c.page.locator('.detached-send-notice');await expect(notice).toContainText(outcome.status==='not_sent'?'임시보관함에 저장된 메일을 열어 다시 보내 주세요':'보낸편지함·임시보관함을 확인해 주세요');
      if(outcome.status==='unknown')await expect(notice).not.toContainText('보냈어요');else await expect(notice).toContainText('안 보냈어요');assert.equal(await c.page.evaluate(()=>sessionStorage.getItem('webmail.pending-sends')),null);assert.equal(c.sends.length,1);
    }finally{await c.page.close();}
  });

  await t.test('detached receipts are queried sequentially without sending and an unresolved key survives',async()=>{
    const c=await open({send:unknown,lookup:unknown});
    try{
      await expect(c.result).toContainText('발송 여부 확인 필요');const first=c.sends[0].composeId;
      await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(c.page.locator('.composer')).toHaveCount(0);
      await c.page.evaluate(async()=>{const {startCompose}=await import('/src/state/compose.js');startCompose('new');});
      await expect(c.body).toHaveAttribute('contenteditable','true');await c.body.fill('다른 합성 본문');
      await c.page.getByRole('combobox',{name:'받는 사람 추가',exact:true}).fill('other@example.com');await c.page.locator('#compose-subject').fill('다른 합성 제목');
      await c.sendButton.click();await expect(c.result).toContainText('발송 여부 확인 필요');const second=c.sends[1].composeId;
      await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(c.page.locator('.composer')).toHaveCount(0);
      const notice=c.page.locator('.detached-send-notice');await expect(notice).toContainText('2통');
      let active=0,maxActive=0;const queried=[];
      await c.page.route('**/api/send/*',async route=>{
        const key=decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));queried.push(key);active++;maxActive=Math.max(maxActive,active);
        await new Promise(resolve=>setTimeout(resolve,50));await route.fulfill({json:key===first?sent:unknown});active--;
      });
      await notice.getByRole('button',{name:'다시 확인',exact:true}).click();await expect(notice).toContainText('1통');
      await expect(notice.getByRole('button',{name:'다시 확인',exact:true})).toBeEnabled();assert.deepEqual(queried,[first,second]);assert.equal(maxActive,1);assert.equal(c.sends.length,2);
      assert.deepEqual(await c.page.evaluate(()=>JSON.parse(sessionStorage.getItem('webmail.pending-sends')).map(record=>record.composeId)),[second]);
      await c.page.route('**/api/send/*',route=>route.abort('failed'));await notice.getByRole('button',{name:'다시 확인',exact:true}).click();
      await expect(notice).toContainText('결과를 다시 확인하지 못했어요');await expect(notice).toContainText('보냈어요');await expect(notice).toContainText('1통');
      c.page.once('dialog',dialog=>dialog.dismiss());await notice.getByRole('button',{name:'확인 끝내기',exact:true}).click();await expect(notice).toContainText('1통');
      c.page.once('dialog',dialog=>dialog.accept());await notice.getByRole('button',{name:'확인 끝내기',exact:true}).click();await expect(notice).toHaveCount(0);
      assert.equal(await c.page.evaluate(()=>sessionStorage.getItem('webmail.pending-sends')),null);assert.equal(c.sends.length,2);
    }finally{await c.page.close();}
  });

  await t.test('pending copy confirmation releases its receipt and closes without an extra recovery save',async()=>{
    const c=await open({send:'lost',lookup:count=>count===1?{status:'sent',copyPending:true}:sent});
    try{
      await expect(c.result).toContainText('사본 저장 결과를 확인 중');
      await c.page.getByRole('button',{name:'다시 확인',exact:true}).click();await expect(c.result).toContainText('보낸편지함에 사본을 저장했어요');
      assert.equal(await c.page.evaluate(()=>sessionStorage.getItem('webmail.pending-sends')),null);
      await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(c.page.locator('.composer')).toHaveCount(0);assert.equal(c.saves.length,0);assert.equal(c.sends.length,1);
    }finally{await c.page.close();}
  });

  await t.test('legacy ok-only result has unknown copy location and close saves before asking to abandon',async()=>{
    const c=await open({send:{ok:true},saveError:true,attachment:true});
    try{
      await expect(c.result).toContainText('보냈어요');await expect(c.result).toContainText('사본 저장 위치를 확인하지 못했어요');await expect(c.result).not.toContainText('보낸편지함에 사본을 저장했어요');
      let dismissed=false;c.page.once('dialog',async dialog=>{assert.equal(dialog.message(),'이 내용은 계정에 남아 있지 않아요. 그래도 닫을까요?');await dialog.dismiss();dismissed=true;});
      await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect.poll(()=>c.saves.length).toBe(1);await expect(c.body).toHaveText('합성 본문');await expect(c.page.locator('.drop .att')).toContainText('retained.txt');
      await expect.poll(()=>dismissed).toBe(true);await expect(c.page.getByRole('button',{name:'쓰기 창 닫기'})).toBeEnabled();
      c.page.once('dialog',dialog=>dialog.accept());await c.page.getByRole('button',{name:'쓰기 창 닫기'}).click();await expect(c.page.locator('.composer')).toHaveCount(0);assert.equal(c.saves.length,2);assert.equal(c.sends.length,1);
    }finally{await c.page.close();}
  });
  await t.test('a second manual recovery keeps intervening edits and exposes the latest saved reference',async()=>{
    const c=await open({send:{status:'sent',sentCopySavedTo:null},attachment:true});let release;
    const gate=new Promise(resolve=>release=resolve);
    try{
      await expect(c.result).toContainText('임시 저장을 눌러 다시 저장해 주세요');
      await c.page.unroute('**/api/drafts');await c.page.route('**/api/drafts',async route=>{
        c.saves.push(route.request().postDataJSON());const index=c.saves.length;if(index===1)await gate;
        await route.fulfill({json:{draftRef:index===1?'first-synthetic-copy':'latest-synthetic-copy'}});
      });
      await c.page.getByRole('button',{name:'임시 저장',exact:true}).click();await expect.poll(()=>c.saves.length).toBe(1);await c.body.fill('두 번째 복구 본문');release();
      const save=c.page.getByRole('button',{name:'임시 저장',exact:true});await expect(save).toBeEnabled();await save.click();
      await expect(c.result).toContainText('작성 내용의 복구본을 임시보관함에 저장했어요');await expect(c.result.getByRole('link',{name:'임시보관함의 사본 보기'})).toHaveAttribute('href','#read/latest-synthetic-copy');
      assert.equal(c.saves.length,2);assert.equal(c.saves[1].draftRef,'first-synthetic-copy');assert.match(c.saves[1].html,/두 번째 복구 본문/);assert.deepEqual(c.saves[1].attachmentIds,c.sends[0].attachmentIds);assert.equal(c.sends.length,1);
    }finally{release();await c.page.close();}
  });

});
