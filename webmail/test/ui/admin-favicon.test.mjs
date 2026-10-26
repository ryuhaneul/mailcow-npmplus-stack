import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createAdminApp } from '../../server/admin/app.js';
import { createApp } from '../../server/app.js';
import { faviconCsp } from '../../server/favicon-store.js';
const captures = process.env.FAVICON_CAPTURE_DIR || '/tmp/webmail-favicon-captures';
const svg = marker => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" style="fill:rgb(33,133,113)"/><text x="8" y="23" fill="white" font-size="21">${marker}</text></svg>`);
await test('favicon actual built UI and SVG browser security', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'synthetic-favicon-browser-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { publicHostnames: ['mail.example.com'], adminHostname: 'mailadmin.example.com', trustProxy: [], sessionIdleMin: 60, sessionMaxHours: 8, logoDir: dir, auditDir: join(dir, 'audit') };
  const client = { async call() { return { version: 'synthetic' }; }, async login({ username }) { return { username, state: 'ready' }; }, async logout() {} };
  const admin = await createAdminApp({ config, logger: false, auth: { client } }), web = await createApp({ config, logger: false });
  await admin.listen({ host: '127.0.0.1', port: 0 }); await web.listen({ host: '127.0.0.1', port: 0 }); t.after(() => admin.close()); t.after(() => web.close());
  const adminOrigin = `http://127.0.0.1:${admin.server.address().port}`, webOrigin = `http://127.0.0.1:${web.server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] }); t.after(() => browser.close()); await mkdir(captures, { recursive: true });
  const login = await admin.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'synthetic-admin', password: 'synthetic-only' } }); assert.equal(login.statusCode, 200);
  const [cookieName, cookieValue] = login.headers['set-cookie'].split(';')[0].split('=');
  async function contextFor(width = 1280, mode = 'light') {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: mode });
    await context.addCookies([{ name: cookieName, value: cookieValue, url: adminOrigin }]);
    // Local HTTP fixture supplies the configured HTTPS management Origin; server guard remains active.
    await context.route('**/api/admin/**', async route => { const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://mailadmin.example.com' } }); await route.fulfill({ response }); }); return context;
  }
  async function settings(context) {
    const page = await context.newPage(); await page.goto(`${adminOrigin}/admin.html#logo`); await expect(page.getByRole('heading', { name: '웹메일 로고', exact: true })).toBeVisible();
    const section = page.locator('[data-favicon-settings]'); await expect(section.getByLabel('탭 아이콘 올리기')).toBeVisible(); return { page, section };
  }
  await t.test('upload preview/save/delete/revert, next-load tab links on both screens, errors and keyboard', async () => {
    const context = await contextFor(); try {
      const { page, section } = await settings(context); await expect(section).toContainText('등록된 탭 아이콘 없음'); await expect(section.getByRole('button', { name: '탭 아이콘 저장', exact: true })).toBeDisabled();
      await section.getByLabel('탭 아이콘 올리기').setInputFiles({ name: 'synthetic-invalid.png', mimeType: 'image/png', buffer: Buffer.from('truncated') }); await expect(section.getByRole('alert')).toContainText('정사각형');
      await section.getByLabel('탭 아이콘 올리기').setInputFiles({ name: 'synthetic-icon.svg', mimeType: 'image/svg+xml', buffer: svg('S') });
      await expect(section.locator('img')).toHaveCount(4); for (const image of await section.locator('img').all()) await expect.poll(() => image.evaluate(el => el.naturalWidth)).toBeGreaterThan(0);
      await section.getByRole('button', { name: '탭 아이콘 저장', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(section.getByRole('status')).toContainText('반영했습니다'); await expect(section).toContainText('SVG · 0.2 KB');
      for (const [origin, name] of [[adminOrigin, 'admin'], [webOrigin, 'index']]) {
        const tabContext = await browser.newContext(); await tabContext.addCookies([{ name: cookieName, value: cookieValue, url: adminOrigin }]);
        const tab = await tabContext.newPage(); await tab.goto(`${origin}/${name}.html`); await expect(tab.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.ico');
        const response = await tab.request.get(`${origin}/favicon.ico`); assert.equal(response.status(), 200); assert.deepEqual(await response.body(), svg('S')); await tab.reload(); assert.equal((await tab.request.get(`${origin}/favicon.ico`)).status(), 200); await tabContext.close();
      }
      await section.getByRole('button', { name: '탭 아이콘 삭제', exact: true }).click(); await expect(section.getByRole('status')).toContainText('삭제했습니다'); await expect(section).toContainText('등록된 탭 아이콘 없음');
      for (const origin of [adminOrigin, webOrigin]) assert.equal((await page.request.get(`${origin}/favicon.ico`)).status(), 404);
      await section.getByRole('button', { name: '이전 탭 아이콘으로 되돌리기' }).click(); await expect(section.getByRole('status')).toContainText('반영했습니다'); await expect(section).toContainText('SVG · 0.2 KB');
      for (const origin of [adminOrigin, webOrigin]) assert.deepEqual(await (await page.request.get(`${origin}/favicon.ico`)).body(), svg('S'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    } finally { await context.close(); }
  });
  for (const width of [1280,768,375]) for (const mode of ['light','dark']) await t.test(`favicon section ${width} ${mode}, no overflow and exact preview sizes`, async () => {
    const context = await contextFor(width, mode); try {
      const { page, section } = await settings(context), toggle = page.getByRole('button', { name: mode === 'dark' ? '다크 모드로 전환' : '라이트 모드로 전환' }); if (await toggle.count()) await toggle.click();
      await expect(page.locator('html')).toHaveAttribute('data-mode', mode); await expect(section.locator('img')).toHaveCount(4);
      await section.scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${captures}/favicon-${width}-${mode}.png`, fullPage: true }); await section.screenshot({ path: `${captures}/favicon-section-${width}-${mode}.png` });
      for (const image of await section.locator('img').all()) { const box = await image.boundingBox(), size = Number(await image.getAttribute('width')); assert.equal(box.width, size); assert.equal(box.height, size); }
      const upload = section.getByLabel('탭 아이콘 올리기'); await upload.focus(); assert.equal(await upload.evaluate(el => document.activeElement === el), true);
      await page.keyboard.press('Tab'); await expect(section.getByRole('button', { name: '이전 탭 아이콘으로 되돌리기' })).toBeFocused();
    } finally { await context.close(); }
  });
  await t.test('malicious SVG preview and direct public navigation: zero scripts, dialogs, external requests; inline style renders', async () => {
    const context = await contextFor(); let external = 0, dialogs = 0;
    const externalServer = createServer((_request, response) => { external++; response.end('synthetic external resource'); });
    await new Promise(resolve => externalServer.listen(0, '127.0.0.1', resolve));
    const externalOrigin = `http://127.0.0.1:${externalServer.address().port}`;
    const bytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" onload="document.documentElement.setAttribute('data-executed','event');alert('event');fetch('${externalOrigin}/event')"><style>@import url('${externalOrigin}/css');</style><script>document.documentElement.setAttribute('data-executed','script');alert('script');fetch('${externalOrigin}/script')</script><image href="${externalOrigin}/image"/><rect width="32" height="32" style="fill:rgb(33,133,113)"/></svg>`);
    context.on('page', page => page.on('dialog', dialog => { dialogs++; dialog.dismiss(); }));
    try {
      const { page, section } = await settings(context);
      await section.getByLabel('탭 아이콘 올리기').setInputFiles({ name: 'synthetic-security.svg', mimeType: 'image/svg+xml', buffer: bytes }); await expect(section.locator('img')).toHaveCount(4); await expect.poll(() => section.locator('img').first().evaluate(el => el.naturalWidth)).toBeGreaterThan(0);
      await section.getByRole('button', { name: '탭 아이콘 저장', exact: true }).click(); await expect(section.getByRole('status')).toContainText('반영했습니다');
      const pre = await admin.inject({ method: 'POST', url: '/api/admin/favicon/preview', headers: { cookie: `${cookieName}=${cookieValue}`, origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': login.json().csrf }, payload: { mime: 'image/svg+xml', dataBase64: bytes.toString('base64') } }); assert.equal(pre.statusCode, 200);
      for (const [label, url] of [['preview', `${adminOrigin}${pre.json().url}`], ['admin', `${adminOrigin}/favicon.ico`], ['webmail', `${webOrigin}/favicon.ico`]]) {
        // Playwright auto-aborts /favicon.ico when request interception is active.
        // A separate context exercises direct navigation without interception.
        const directContext = await browser.newContext();
        await directContext.addCookies([{ name: cookieName, value: cookieValue, url: adminOrigin }]);
        directContext.on('page', tab => tab.on('dialog', dialog => { dialogs++; dialog.dismiss(); }));
        const direct = await directContext.newPage(), response = await direct.goto(url); assert.equal(response.status(), 200); assert.equal(response.headers()['content-security-policy'], faviconCsp); assert.equal(response.headers()['x-content-type-options'], 'nosniff'); assert.deepEqual(await response.body(), bytes);
        assert.equal(await direct.locator('svg').getAttribute('data-executed'), null); assert.equal(await direct.locator('rect').evaluate(el => getComputedStyle(el).fill), 'rgb(33, 133, 113)');
        await direct.screenshot({ path: `${captures}/svg-security-${label}.png` }); await directContext.close();
      }
      assert.equal(dialogs, 0); assert.equal(external, 0);
    } finally { await context.close(); await new Promise(resolve => externalServer.close(resolve)); }
  });
});
