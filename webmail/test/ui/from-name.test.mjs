import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

await test('sender names settings and composer use synthetic mail only', async t => {
  const fake = createFakeApi({ authenticated: true });
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../web', import.meta.url)), logLevel: 'error', plugins: [preact(), { name: 'from-name-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close()); t.after(() => fake.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] }); t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const captures = process.env.FROM_NAME_CAPTURE_DIR || '/tmp/webmail-from-name-captures';
  await mkdir(captures, { recursive: true });
  await t.test('row and default saves preserve newer dark mode and other unsaved input', async () => {
    fake.state.prefs.mode = 'system'; fake.state.prefs.defaultFrom = null; fake.state.prefs.fromNames = {};
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(origin + '/#filters/from');
      const own = page.locator('[id="from-name-user@example.com"]'), alias = page.locator('[id="from-name-sales@example.com"]');
      await expect(own).toBeVisible();
      await page.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
      await expect.poll(() => fake.state.prefs.mode).toBe('dark');
      await alias.fill('아직 저장하지 않은 별칭');
      const literal = '새 발송 이름';
      await own.fill(literal);
      await page.getByRole('button', { name: 'user@example.com 이름 저장', exact: true }).click();
      await expect(page.locator('.from-addresses .say').filter({ hasText: 'user@example.com' })).toContainText(literal);
      assert.equal(fake.state.prefs.mode, 'dark');
      await expect(alias).toHaveValue('아직 저장하지 않은 별칭');
      const nameRequest = fake.state.requests.filter(item => item.path === '/api/prefs' && item.method === 'PUT').at(-1);
      assert.deepEqual(nameRequest.body, { fromNames: { 'user@example.com': literal } });
      await page.getByRole('button', { name: '라이트 모드로 전환', exact: true }).click();
      await expect.poll(() => fake.state.prefs.mode).toBe('light');
      await page.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
      await expect.poll(() => fake.state.prefs.mode).toBe('dark');
      await page.getByRole('button', { name: 'sales@example.com 기본으로', exact: true }).click();
      await expect.poll(() => fake.state.prefs.defaultFrom).toBe('sales@example.com');
      assert.equal(fake.state.prefs.mode, 'dark');
      await expect(alias).toHaveValue('아직 저장하지 않은 별칭');
      const defaultRequest = fake.state.requests.filter(item => item.path === '/api/prefs' && item.method === 'PUT').at(-1);
      assert.deepEqual(defaultRequest.body, { defaultFrom: 'sales@example.com' });
      await page.goto(origin + '/#compose');
      await page.getByRole('button', { name: '보낸 사람 선택' }).click();
      await expect(page.getByRole('option').filter({ hasText: 'user@example.com' })).toContainText(literal);
    } finally { await page.close(); }
  });
  await t.test('legacy encoded-word name is flagged and rejected until corrected', async () => {
    fake.state.authenticated = true;
    const literal = '=?UTF-8?B?SGVsbG8=?=';
    fake.state.prefs.fromNames = { 'user@example.com': literal };
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(origin + '/#filters/from');
      const own = page.locator('[id="from-name-user@example.com"]');
      await expect(own).toHaveValue(literal);
      await expect(page.locator('.from-name-edit').first()).toContainText('이름에 =? 문자 조합은 쓸 수 없어요');
      await own.fill('Team =?UTF-8?B?SGVsbG8=?=');
      await page.getByRole('button', { name: 'user@example.com 이름 저장', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('이름에 =? 문자 조합은 쓸 수 없어요');
      assert.equal(fake.state.prefs.fromNames['user@example.com'], literal);
      await own.fill('고친 이름');
      await page.getByRole('button', { name: 'user@example.com 이름 저장', exact: true }).click();
      await expect(page.locator('.from-addresses .say').first()).toContainText('고친 이름');
      await expect(page.locator('.from-name-edit').first()).not.toContainText('고쳐 주세요');
    } finally { await page.close(); }
  });
  for (const width of [1280, 768, 375]) await t.test(`names save, clear, failure and composer at ${width}`, async () => {
    fake.state.authenticated = true; fake.state.prefs.defaultFrom = null; fake.state.prefs.fromNames = {};
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(origin + '/#filters/from');
      await expect(page.getByRole('link', { name: '보낸 사람 주소', exact: true })).toHaveAttribute('aria-current', 'page');
      for (const [address, name] of [['user@example.com', '내 발송 이름'], ['sales@example.com', '영업 담당자'], ['support@example.org', '지원 담당자']]) {
        const field = page.locator(`[id="from-name-${address}"]`);
        await field.fill(name);
        await page.getByRole('button', { name: `${address} 이름 저장`, exact: true }).click();
        await expect(page.getByRole('status')).toContainText('저장했어요.');
        await expect(page.locator('.from-addresses .say').filter({ hasText: address })).toContainText(name);
        assert.equal(fake.state.prefs.fromNames[address], name);
      }
      await expect(page.locator('.from-addresses')).toHaveCount(1);
      assert.equal(await page.locator('.from-addresses').evaluate(el => el.scrollWidth <= el.clientWidth), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `${captures}/settings-${width}.png`, fullPage: true });
      await page.goto(origin + '/#compose');
      await expect(page.getByRole('button', { name: '보낸 사람 선택' })).toContainText('내 발송 이름');
      await page.getByRole('button', { name: '보낸 사람 선택' }).click();
      await expect(page.getByRole('option').filter({ hasText: 'sales@example.com' })).toContainText('영업 담당자');
      await expect(page.getByRole('option').filter({ hasText: 'support@example.org' })).toContainText('지원 담당자');
      await page.screenshot({ path: `${captures}/picker-${width}.png`, fullPage: true });
      await page.keyboard.press('Escape');
      await page.goto(origin + '/#filters/from');
      await expect(page.getByRole('link', { name: '보낸 사람 주소', exact: true })).toHaveAttribute('aria-current', 'page');
      const own = page.locator('[id="from-name-user@example.com"]');
      await own.fill('');
      await page.getByRole('button', { name: 'user@example.com 이름 저장', exact: true }).click();
      await expect(page.locator('.from-addresses .say').filter({ hasText: 'user@example.com' })).toContainText('이서윤');
      await page.route('**/api/prefs', route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, json: { error: { code: 'DIRECTORY_UNAVAILABLE', message: '주소 정보를 조회할 수 없어요.' } } }) : route.fallback());
      await own.fill('실패한 이름');
      await page.getByRole('button', { name: 'user@example.com 이름 저장', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('주소 정보를 조회할 수 없어요.');
      assert.equal(fake.state.prefs.fromNames['user@example.com'], undefined);
      assert.deepEqual(errors, []);
    } finally { fake.state.prefsError = null; await page.close(); }
  });
});
