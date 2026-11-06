import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';

await test('admin login IP exceptions: list, add and delete using the Relay layout on desktop and mobile', async t => {
  const fake = createFakeAdminApi();
  const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)),
    configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), logLevel: 'error',
    plugins: [{ name: 'login-ips-api', configureServer(server) { server.middlewares.use(fake.middleware); } }],
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const captures = process.env.ADMIN_LOGIN_IPS_CAPTURE_DIR || '/tmp/admin-login-ips-captures';
  await mkdir(captures, { recursive: true });
  for (const width of [1280, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: 'light' });
    try {
      await context.addInitScript(() => localStorage.setItem('webmail-admin-prefs', JSON.stringify({ theme: 'ink', mode: 'light', accent: {} })));
      const page = await context.newPage(), calls = [], errors = [];
      let rows = [{ ip: '192.0.2.10', note: '합성 사무실 네트워크', actor: 'synthetic-admin', date: '2026-11-06T00:00:00Z' }];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/admin/auth/session', route => route.fulfill({ json: { ...fake.state.session, features: fake.state.features } }));
      await page.route('**/api/admin/login-ips**', async route => {
        const request = route.request(), method = request.method(); calls.push(method);
        if (method === 'GET') return route.fulfill({ json: { items: rows } });
        assert.equal(request.headers()['x-mailadmin-csrf'], fake.state.session.csrf);
        assert.equal(request.headers().authorization, undefined);
        if (method === 'POST') {
          const body = request.postDataJSON();
          rows.push({ ...body, actor: 'synthetic-admin', date: '2026-11-06T00:00:00Z' });
        } else if (method === 'DELETE') {
          const ip = decodeURIComponent(new URL(request.url()).pathname.slice('/api/admin/login-ips/'.length));
          rows = rows.filter(row => row.ip !== ip);
        } else assert.fail(`Unexpected ${method}`);
        return route.fulfill({ json: { ok: true } });
      });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/admin.html#login-ips`);
      const list = page.getByRole('region', { name: '웹메일 로그인 예외 IP 목록', exact: true });
      await expect(list).toContainText('192.0.2.10');
      await expect(page.getByRole('heading', { name: '웹메일 로그인 예외 IP', exact: true })).toBeVisible();
      await page.screenshot({ path: `${captures}/login-ips-${width}-light.png`, fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByRole('button', { name: 'IP 추가', exact: true }).click();
      const add = page.getByRole('dialog', { name: '로그인 예외 IP 추가' });
      await expect(add).toBeVisible();
      await add.getByLabel('IP 주소·CIDR', { exact: true }).fill('2001:db8::/48');
      await add.getByLabel('메모 (선택)', { exact: true }).fill('합성 IPv6 대역');
      await add.getByRole('button', { name: '추가', exact: true }).click();
      await expect(add).not.toBeVisible(); await expect(list).toContainText('2001:db8::/48');
      await list.getByRole('link').filter({ hasText: '2001:db8::/48' }).click();
      await page.getByRole('button', { name: '예외 IP 삭제', exact: true }).click();
      const remove = page.getByRole('dialog', { name: '로그인 예외 IP 삭제' });
      await expect(remove).toContainText('2001:db8::/48');
      await page.keyboard.press('Escape'); await expect(remove).not.toBeVisible();
      assert.equal(calls.includes('DELETE'), false);
      await page.getByRole('button', { name: '예외 IP 삭제', exact: true }).click();
      await remove.getByRole('button', { name: '삭제', exact: true }).click();
      await expect(remove).not.toBeVisible(); await expect(list).not.toContainText('2001:db8::/48');
      assert.equal(calls.filter(method => method === 'POST').length, 1);
      assert.equal(calls.filter(method => method === 'DELETE').length, 1);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});
