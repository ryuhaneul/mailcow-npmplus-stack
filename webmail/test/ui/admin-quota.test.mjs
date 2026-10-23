import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';
const captures = process.env.QUOTA_CAPTURE_DIR || '/tmp/webmail-quota-captures';
await test('quota admin: dashboard, complete list, inline limits and conflict recovery', async t => {
  const fake = createFakeAdminApi(), initial = structuredClone(fake.state);
  const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), logLevel: 'error', plugins: [{ name: 'quota-test-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] }); t.after(() => browser.close());
  await mkdir(captures, { recursive: true });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  async function open(hash = 'quota', width = 1280) {
    Object.assign(fake.state, structuredClone(initial));
    const base = fake.state.accounts.items[0];
    fake.state.accounts.items = [
      { ...base, name: '합성 구성원', usedBytes: 19 * 1024 ** 3 },
      { ...fake.state.accounts.items[1], usedBytes: 40 * 1024 ** 3 },
      { ...fake.state.accounts.items[2], usedBytes: 17.98 * 1024 ** 3 },
      { ...fake.state.accounts.items[3], usedBytes: 3 * 1024 ** 3 },
      { ...base, address: 'unlimited@example.com', name: '합성 무제한', quotaGb: 0, usedBytes: 99 * 1024 ** 3 },
      { ...base, address: 'extra@example.com', name: '합성 추가', usedBytes: 12 * 1024 ** 3 },
      { ...base, address: 'small@example.com', name: '합성 보관', usedBytes: 1024 },
    ];
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'light' }), page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/admin.html#${hash}`); await expect(page.locator(`[data-admin-page=${hash}]`)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return { page, context, errors };
  }
  await t.test('dashboard top five rank by percentage and navigate to existing account detail', async () => {
    const { page, context, errors } = await open('home');
    try {
      await expect(page.locator('.quota-top-item')).toHaveCount(5);
      await expect(page.locator('.quota-top-item').first()).toContainText('admin@example.com');
      await expect(page.locator('.top-quota')).not.toContainText('unlimited@example.com');
      await expect(page.locator('.quota-top-item meter')).toHaveCount(5);
      await page.locator('.quota-top-item').first().click(); await expect(page.locator('.detail-head')).toContainText('admin@example.com');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('complete list, kind labels, raw thresholds, search and all three sorting modes', async () => {
    const { page, context, errors } = await open();
    try {
      await expect(page.locator('.quota-item')).toHaveCount(7);
      const unlimited = page.locator('[data-quota-address="unlimited@example.com"]');
      await expect(unlimited).toContainText('무제한'); await expect(unlimited.locator('meter')).toHaveCount(0); await expect(unlimited.locator('.warn,.danger')).toHaveCount(0);
      await expect(page.locator('[data-quota-address="team@example.com"]')).toContainText('팀');
      await expect(page.locator('[data-quota-address="admin@example.com"]')).toContainText('관리');
      await expect(page.locator('[data-quota-address="off@example.com"] .quota-usage')).toHaveClass(/warn/);
      await expect(page.locator('[data-quota-address="person@example.com"] .quota-usage')).toHaveClass(/danger/);
      await page.getByLabel('정렬', { exact: true }).selectOption('used'); await expect(page.locator('.quota-item').first()).toHaveAttribute('data-quota-address', 'unlimited@example.com');
      await page.getByLabel('정렬', { exact: true }).selectOption('name'); await expect(page.locator('.quota-item').first()).toContainText('합성 관리');
      await page.getByLabel('계정 검색').fill('TEAM@'); await expect(page.locator('.quota-item')).toHaveCount(1);
      await page.getByLabel('계정 검색').fill('[missing]'); await expect(page.getByText('일치하는 메일함이 없습니다. 검색어를 바꿔 보세요.')).toBeVisible();
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('inline positive limit PATCH only sends quotaGb/etag, rejects blank/zero, and reloads on 409', async () => {
    const { page, context, errors } = await open();
    try {
      const item = page.locator('[data-quota-address="person@example.com"]'), bodies = [];
      await page.route('**/api/admin/mailboxes/person%40example.com', route => { if (route.request().method() === 'PATCH') bodies.push(route.request().postDataJSON()); return route.continue(); });
      await page.getByRole('button', { name: 'person@example.com 한도 수정', exact: true }).click();
      for (const value of ['', '0']) { await page.getByLabel('person@example.com 한도 (GB)', { exact: true }).fill(value); await item.getByRole('button', { name: '저장', exact: true }).click(); await expect(item.getByRole('alert')).toContainText('0보다 큰'); }
      assert.equal(bodies.length, 0);
      await page.getByLabel('person@example.com 한도 (GB)', { exact: true }).fill('25');
      fake.state.accounts.patchError = { status: 409, code: 'CHANGED_ELSEWHERE', message: '합성 충돌' };
      await item.getByRole('button', { name: '저장', exact: true }).click(); await expect(item.getByRole('alert')).toContainText('다시 읽고 확인해 주세요'); await expect(item.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
      fake.state.accounts.patchError = null; fake.state.accounts.items[0].quotaGb = 30; fake.state.accounts.version++;
      await page.getByRole('button', { name: '현재 값 다시 읽기' }).click();
      await page.getByRole('button', { name: 'person@example.com 한도 수정', exact: true }).click(); await expect(page.getByLabel('person@example.com 한도 (GB)', { exact: true })).toHaveValue('30');
      await page.getByLabel('person@example.com 한도 (GB)', { exact: true }).fill('40'); await item.getByRole('button', { name: '저장', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('용량 한도를 저장했습니다.'); await expect(item).toContainText('40 GB');
      assert.deepEqual(bodies, [{ quotaGb: 25, etag: 'synthetic-account-1' }, { quotaGb: 40, etag: 'synthetic-account-2' }]); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('list is not truncated at fifty accounts and request failure retries independently', async () => {
    const { page, context, errors } = await open();
    try {
      fake.state.accounts.items = Array.from({ length: 95 }, (_, i) => ({ ...fake.state.accounts.items[0], address: `person${i}@example.com` }));
      await page.getByRole('button', { name: '새로고침', exact: true }).click(); await expect(page.locator('.quota-item')).toHaveCount(95);
      await page.route('**/api/admin/quota', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_QUOTA_FAILED', message: '합성 용량 조회 실패' } }) }));
      await page.getByRole('button', { name: '새로고침', exact: true }).click(); await expect(page.locator('[data-error-code=SYNTHETIC_QUOTA_FAILED]')).toBeVisible();
      await page.unroute('**/api/admin/quota'); await page.getByRole('button', { name: '다시 시도', exact: true }).click(); await expect(page.locator('.quota-item')).toHaveCount(95); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  for (const width of [1280, 768, 375]) await t.test(`home, quota and inline edit captures ${width}`, async () => {
    const { page, context, errors } = await open('home', width);
    try {
      await expect(page.locator('.quota-top-item')).toHaveCount(5); await page.screenshot({ path: `${captures}/home-${width}.png`, fullPage: true });
      await page.getByRole('link', { name: '쿼터 관리', exact: true }).click(); await expect(page.locator('.quota-item')).toHaveCount(7);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${captures}/quota-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: 'person@example.com 한도 수정', exact: true }).click(); await expect(page.getByLabel('person@example.com 한도 (GB)', { exact: true })).toHaveValue('20');
      await page.screenshot({ path: `${captures}/quota-edit-${width}.png`, fullPage: true }); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
});
