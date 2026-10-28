// Write-only in the constrained implementation lane. Run after explicit browser approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

const ref = Buffer.from(JSON.stringify(['Templates', 1, 9])).toString('base64url');
const signatureId = 'S'.repeat(32), at = '2026-10-28T00:00:00.000Z';
const item = { owner: 'user@example.com', id: '00000000-0000-4000-8000-000000000001', ref, name: '견적 안내', subject: '{{고객사}} 안내', updatedAt: at, hasAttachments: true, size: 400, inShared: false };
const publicRef = Buffer.from(JSON.stringify(['PublicTemplates/1', 1, 1])).toString('base64url');
const company = { ...item, owner: 'public', id: '1', ref: publicRef, name: '회사 공용 합성' };
const publicDetail = { ...company, html: '<p>{{받는사람이름}} 님, 공용 본문</p>', text: '공용 본문', attachments: [{ part: '11', name: 'company.txt', type: 'text/plain', size: 3 }] };
const source = `/api/messages/${ref}/parts/2?inline=1`;
const detail = { ...item, html: `<p>{{받는사람이름}} 님, {{고객사}} 안내입니다.</p><img src="${source}"><blockquote>{{인용}}</blockquote>`, text: '{{고객사}}', attachments: [{ part: '2', name: 'example.png', size: 68, type: 'image/png' }] };
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7H8AAAAASUVORK5CYII=','base64');
const quote = { ref: 'synthetic-original', messageId: '<original@example.invalid>', from: [{ name: '첫 사람', address: 'first@example.invalid' }], to: [{ address: 'user@example.com' }], cc: [], subject: '원래 제목', html: '<p>답장 원문 {{원문변수}}</p>', date: at, attachments: [] };

await test('compose templates: approved A picker, save, variables and send guard', async t => {
  const fake = createFakeApi({ authenticated: true });
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../web', import.meta.url)), logLevel: 'error', plugins: [preact(), { name: 'templates-compose-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close()); t.after(() => fake.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  async function open({ width = 1280, mode = 'light', kind, listError = false, empty = false, revoked = false, conflict = false, listGate, withPublic = false, publicUnavailable = false, publicPinned = false } = {}) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }), errors = [], requests = [];
    page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(mode => localStorage.setItem('webmail-prefs', JSON.stringify({ theme: 'ink', mode })), mode);
    await page.route('**/api/prefs', async route => route.request().method() === 'GET' ? route.fulfill({ json: { ...fake.state.prefs, mode } }) : route.fallback());
    await page.route('**/api/signatures', route => route.fulfill({ json: { revision: 'synthetic', items: [{ id: signatureId, name: '합성 서명', html: '<p>합성 서명</p>', createdAt: at, updatedAt: at }], defaults: { 'user@example.com': { newDefault: signatureId, replyDefault: signatureId } }, usedBytes: 20, maxBytes: 262144, notices: [] } }));
    await page.route('**/api/signatures/normalize', route => route.fulfill({ json: { html: route.request().postDataJSON().html } }));
    await page.route('**/api/templates**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname, body = request.postData() ? request.postDataJSON() : null;
      requests.push({ path, method: request.method(), body });
      if (request.method() !== 'GET') assert.equal(request.headers()['x-webmail-csrf'], fake.state.csrf);
      if (path === '/api/templates' && request.method() === 'GET') {
        if (listGate) await listGate;
        return listError ? route.fulfill({ status: 503, json: { error: { code: 'MAIL_UNAVAILABLE', message: '합성 목록 실패' } } }) : route.fulfill({ json: { mine: empty ? [] : [item], shared: [], public: withPublic && !publicUnavailable ? [company] : [], ...(publicUnavailable ? { publicUnavailable: true } : {}), pins: publicPinned ? [{owner:'public',id:'1'}] : [], limits: { max: 200 } } });
      }
      if (path === `/api/templates/${publicRef}/attachments-to-compose`) return route.fulfill({ json: { uploads: [{ id: 'public-upload', name: 'company.txt', size: 3 }], html: publicDetail.html } });
      if (path === `/api/templates/${publicRef}` && request.method() === 'GET') return route.fulfill({ json: publicDetail });
      if (path.endsWith('/attachments-to-compose')) return route.fulfill({ json: { uploads: [{ id: 'synthetic-upload', name: 'example.png', size: image.length }], html: detail.html.replaceAll(source, 'cid:wm-template-v1.synthetic-copy@template.invalid') } });
      if (request.method() === 'GET') return revoked ? route.fulfill({ status: 404, json: { error: { code: 'TEMPLATE_NOT_FOUND', message: '더 이상 볼 수 없어요' } } }) : route.fulfill({ json: detail });
      if (request.method() === 'PUT' && conflict) return route.fulfill({ status: 409, json: { error: { code: 'TEMPLATE_CONFLICT', message: '다른 곳에서 바뀌었어요' } } });
      return route.fulfill({ status: request.method() === 'POST' ? 201 : 200, json: { ...item, name: body.name, subject: body.subject } });
    });
    await page.route(`**${source}`, route => route.fulfill({ contentType: 'image/png', body: image }));
    await page.route('**/api/drafts', route => route.fulfill({ json: { draftRef: 'synthetic-draft' } }));
    await page.route('**/api/send', route => { requests.push({ path: '/api/send', body: route.request().postDataJSON() }); return route.fulfill({ json: { status: 'sent', ok: true, sentCopySavedTo: 'sent', rejected: [], warnings: [] } }); });
    if (kind) {
      await page.goto(origin + '/#inbox');
      await expect(page.locator('.compose-btn')).toBeVisible();
      await page.evaluate(async ({ kind, quote }) => { const { composeSeed } = await import('/src/state/compose.js'); const { navigate } = await import('/src/router.js'); composeSeed.value = { kind, message: quote }; navigate('compose'); }, { kind, quote });
    } else await page.goto(origin + '/#compose');
    const body = page.frameLocator('iframe.compose-editor').locator('body');
    await expect(body).toHaveAttribute('contenteditable', 'true');
    const templateButton = page.locator('.tplA-open');
    async function choose() { await templateButton.click(); await page.getByRole('option', { name: item.name, exact: true }).click(); }
    async function sourceHtml() { await page.getByRole('button', { name: 'HTML 원문', exact: true }).click(); const value = await page.getByRole('textbox', { name: 'HTML 원문 편집' }).inputValue(); await page.getByRole('button', { name: 'HTML 원문', exact: true }).click(); return value; }
    async function closeVariables() { const dialog = page.locator('dialog.tplA-vardlg'); if (await dialog.isVisible()) await dialog.getByRole('button', { name: '닫기', exact: true }).click(); }
    return { page, body, requests, errors, templateButton, choose, sourceHtml, closeVariables };
  }
  for (const width of [1280, 768, 375]) for (const mode of ['light', 'dark']) await t.test(`picker and variable surface ${width} ${mode}`, async () => {
    const c = await open({ width, mode });
    try {
      await c.choose();
      if (width <= 760) {
        const dialog = c.page.locator('dialog.tplA-vardlg'); await expect(dialog).toBeVisible();
        await dialog.getByRole('textbox', { name: '고객사', exact: true }).fill('합성 회사');
        await dialog.getByRole('button', { name: '닫기', exact: true }).click();
        await expect(c.page.getByRole('button', { name: '빈칸 채우기', exact: true })).toBeVisible();
        await expect(c.page.locator('.tplA-strip .ins')).toBeHidden();
      } else {
        await expect(c.page.locator('.tplA-strip')).toBeVisible();
        await c.page.locator('.tplA-strip').getByRole('textbox', { name: '고객사', exact: true }).fill('합성 회사');
        await expect(c.page.getByRole('button', { name: '빈칸 채우기', exact: true })).toBeHidden();
      }
      await expect(c.body).toContainText('합성 회사 안내입니다.'); await expect(c.body).toContainText('합성 서명');
      await expect(c.body.locator('img').first()).toHaveAttribute('src', /^blob:/);
      assert.match(await c.sourceHtml(), /cid:wm-template-v1\.synthetic-copy@template\.invalid/);
      assert.deepEqual(c.errors, []);
      if (process.env.TEMPLATES_CAPTURE_DIR) { await mkdir(process.env.TEMPLATES_CAPTURE_DIR, { recursive: true }); await c.page.screenshot({ path: `${process.env.TEMPLATES_CAPTURE_DIR}/compose-templates-${width}-${mode}.png` }); }
    } finally { await c.page.close(); }
  });
  await t.test('T ignores typing and IME; picker search, arrow keys, Enter, Esc and focus return', async () => {
    const c = await open(); try {
      const subject = c.page.getByRole('textbox', { name: '제목', exact: true }); await subject.fill('typed'); await subject.press('t'); await expect(c.page.locator('dialog.tplA-pickdlg')).toHaveCount(0);
      await c.templateButton.dispatchEvent('keydown', { key: 't', isComposing: true, bubbles: true }); await expect(c.page.locator('dialog.tplA-pickdlg')).toHaveCount(0);
      await c.templateButton.focus(); await c.page.keyboard.press('t');
      const search = c.page.getByRole('combobox', { name: '템플릿 찾기' }); await expect(search).toBeFocused();
      await search.fill('없는 이름'); await expect(c.page.getByText('찾는 템플릿이 없어요.', { exact: true })).toBeVisible();
      await search.fill('견적'); await search.press('ArrowDown'); await expect(c.page.getByRole('option', { name: item.name })).toHaveAttribute('aria-selected', 'true');
      await search.press('Escape'); await expect(c.templateButton).toBeFocused();
      await c.templateButton.click(); await c.page.getByRole('combobox', { name: '템플릿 찾기' }).press('Enter');
      await expect(c.page.locator('.tplA-strip')).toBeVisible();
    } finally { await c.page.close(); }
  });
  await t.test('mobile close and Esc keep values; explicit cancel restores the opening snapshot', async () => {
    const c = await open({ width: 375 }); try {
      await c.choose(); const dialog = c.page.locator('dialog.tplA-vardlg');
      await dialog.getByRole('textbox', { name: '고객사', exact: true }).fill('유지할 회사'); await c.page.keyboard.press('Escape');
      const opener = c.page.getByRole('button', { name: '빈칸 채우기', exact: true }); await expect(opener).toBeFocused(); await opener.click();
      await expect(dialog.getByRole('textbox', { name: '고객사', exact: true })).toHaveValue('유지할 회사');
      await dialog.getByRole('textbox', { name: '고객사', exact: true }).fill('버릴 회사'); await dialog.getByRole('button', { name: '취소', exact: true }).click();
      await expect(c.body).toContainText('유지할 회사'); await expect(c.body).not.toContainText('버릴 회사');
      await opener.click(); await expect(dialog.getByRole('textbox', { name: '고객사', exact: true })).toHaveValue('유지할 회사');
    } finally { await c.page.close(); }
  });
  await t.test('reply replace preserves subject, recipients, quote and signature; warning blocks send until an explicit choice', async () => {
    const c = await open({ kind: 'reply' }); try {
      await c.body.evaluate(body => { const p = body.ownerDocument.createElement('p'); p.textContent = '작성한 문장'; body.prepend(p); body.dispatchEvent(new Event('input', { bubbles: true })); });
      await c.choose(); const confirm = c.page.getByRole('dialog', { name: '이미 쓴 내용이 있어요' }); await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: '넣기', exact: true }).click();
      await expect(c.page.getByRole('textbox', { name: '제목', exact: true })).toHaveValue('Re: 원래 제목');
      await expect(c.body).toContainText('답장 원문'); await expect(c.body).toContainText('합성 서명'); await expect(c.body).not.toContainText('작성한 문장');
      await c.page.getByRole('button', { name: '보내기', exact: true }).click();
      const warning = c.page.getByRole('dialog', { name: '빈 변수 1개가 있어요' }); await expect(warning).toBeVisible();
      assert.equal(c.requests.some(request => request.path === '/api/send'), false);
      await warning.getByRole('button', { name: '채우러 가기', exact: true }).click();
      const field = c.page.locator('.tplA-strip').getByRole('textbox', { name: '고객사', exact: true }); await expect(field).toBeFocused(); await field.fill('합성 회사');
      await c.page.getByRole('button', { name: '보내기', exact: true }).click();
      await expect.poll(() => c.requests.filter(request => request.path === '/api/send').length).toBe(1);
      const sent = c.requests.find(request => request.path === '/api/send').body;
      assert.equal(sent.subject, 'Re: 원래 제목'); assert.equal(sent.inReplyTo, quote.messageId); assert.deepEqual(sent.to, quote.from);
      assert.ok(sent.html.includes('{{원문변수}}')); assert.deepEqual(sent.attachmentIds, ['synthetic-upload']);
    } finally { await c.page.close(); }
  });
  await t.test('send anyway is explicit and the native warning traps Tab, supports Esc and restores focus', async () => {
    const c = await open({ kind: 'reply' }); try {
      await c.choose(); await c.page.getByRole('button', { name: '보내기', exact: true }).click();
      const warning = c.page.getByRole('dialog', { name: '빈 변수 1개가 있어요' }); await expect(warning).toBeVisible();
      for (let index = 0; index < 5; index++) { await c.page.keyboard.press('Tab'); assert.equal(await warning.evaluate(dialog => dialog.contains(dialog.ownerDocument.activeElement)), true); }
      await c.page.keyboard.press('Escape'); await expect(c.page.getByRole('button', { name: '보내기', exact: true })).toBeFocused();
      assert.equal(c.requests.some(request => request.path === '/api/send'), false);
      await c.page.getByRole('button', { name: '보내기', exact: true }).click(); await warning.getByRole('button', { name: '그대로 보내기', exact: true }).click();
      await expect.poll(() => c.requests.filter(request => request.path === '/api/send').length).toBe(1);
      assert.ok(c.requests.find(request => request.path === '/api/send').body.html.includes('{{고객사}}'));
    } finally { await c.page.close(); }
  });
  await t.test('save new/overwrite excludes signature and quotes, keeps filled values and preserves input on 409', async () => {
    const c = await open({ kind: 'reply', conflict: true }); try {
      await c.choose(); await c.page.locator('.tplA-strip').getByRole('textbox', { name: '고객사', exact: true }).fill('채운 회사');
      await c.page.getByRole('button', { name: '템플릿으로 저장', exact: true }).click(); const dialog = c.page.getByRole('dialog', { name: '템플릿으로 저장', exact: true });
      await expect(dialog.getByText('채운 값은 그대로 저장돼요', { exact: true })).toBeVisible(); await dialog.getByRole('textbox', { name: '새 템플릿 이름' }).fill('합성 새 템플릿');
      await dialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect.poll(() => c.requests.filter(request => request.path === '/api/templates' && request.method === 'POST').length).toBe(1);
      const saved = c.requests.find(request => request.path === '/api/templates' && request.method === 'POST').body;
      assert.ok(saved.html.includes('채운 회사')); assert.ok(!saved.html.includes('합성 서명')); assert.ok(!saved.html.includes('답장 원문')); assert.deepEqual(saved.attachments, [{ uploadId: 'synthetic-upload' }]);
      await c.page.getByRole('button', { name: '템플릿으로 저장', exact: true }).click(); await dialog.getByRole('radio', { name: /^기존 템플릿 덮어쓰기/ }).check(); await dialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect(dialog.getByText('다른 곳에서 바뀌었어요', { exact: true })).toBeVisible(); await expect(dialog).toBeVisible();
      assert.equal(c.requests.find(request => request.method === 'PUT' && request.path.startsWith('/api/templates/')).body.baseUid, 9);
    } finally { await c.page.close(); }
  });
  for (const options of [{ empty: true, text: '템플릿이 없어요' }, { listError: true, text: '합성 목록 실패' }, { revoked: true, text: '더 이상 볼 수 없어요' }]) await t.test(`picker state: ${options.text}`, async () => {
    const c = await open(options); try { await c.templateButton.click(); await expect(c.page.getByText(options.text, { exact: true })).toBeVisible(); if (options.listError) await expect(c.page.getByRole('button', { name: '다시 시도' })).toBeVisible(); } finally { await c.page.close(); }
  });
  await t.test('pending list has a loading status before any result arrives', async () => {
    let release; const listGate = new Promise(resolve => { release = resolve; }); const c = await open({ listGate });
    try { await c.templateButton.click(); await expect(c.page.locator('.tpl-loading')).toBeVisible(); release(); await expect(c.page.getByRole('option', { name: item.name })).toBeVisible(); } finally { release(); await c.page.close(); }
  });
  for (const publicPinned of [false, true]) await t.test(`company picker group/pin and ordinary attachment insertion; pinned=${publicPinned}`, async () => {
    const c = await open({ withPublic: true, publicPinned }); try {
      await c.templateButton.click(); const group = c.page.getByRole('group', { name: publicPinned ? '고정' : '회사 공용', exact: true }); await expect(group.getByRole('option', { name: company.name, exact: true })).toBeVisible();
      await group.getByRole('option', { name: company.name, exact: true }).click(); await c.closeVariables(); await expect(c.page.getByText('company.txt', { exact: true })).toBeVisible(); assert.equal(c.requests.filter(call => call.path === `/api/templates/${publicRef}/attachments-to-compose`).length, 1);
      const html = await c.sourceHtml(); assert.ok(html.includes('공용 본문')); assert.equal(html.includes('cid:wm-template-v1.'), false); assert.ok(html.includes('합성 서명'));
    } finally { await c.page.close(); }
  });
  await t.test('company partial-load warning keeps personal picker results available', async () => {
    const c = await open({ publicUnavailable: true }); try { await c.templateButton.click(); await expect(c.page.getByText('회사 공용 템플릿을 불러오지 못했어요', { exact: true })).toBeVisible(); await expect(c.page.getByRole('option', { name: item.name, exact: true })).toBeVisible(); } finally { await c.page.close(); }
  });

});
