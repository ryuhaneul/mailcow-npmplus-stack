import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';
import { rulesFixture } from '../../web/dev/fake-rules.js';

const captures = process.env.RULES_LIMIT_CAPTURE_DIR || '/tmp/webmail-rules-limit-captures';
const fake = createFakeApi({ authenticated: true });
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../web', import.meta.url)), logLevel: 'error',
  plugins: [preact(), { name: 'rules-limit-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
await mkdir(captures, { recursive: true });
function reset(count) {
  const fixture = rulesFixture();
  fixture.doc.rules = Array.from({ length: count }, (_, i) => ({ id: `r${String(i).padStart(7, '0')}`, enabled: true, match: i % 2 ? 'all' : 'any',
    conditions: [{ field: ['subject', 'from', 'to'][i % 3], op: ['has', 'not', 'eq', 'start'][i % 4], value: `Synthetic ${i}` }],
    actions: [{ read: true }, { star: true }, { trash: true }][i % 3], stop: i % 7 === 0 }));
  fake.state.rules = fixture;
  fake.state.rulesError = null;
  fake.state.requests = [];
  fake.state.rulePreview = { count: 0, items: [], scanned: 0, limited: false, partial: false };
}
await test('500-rule list, builder limits and script size guidance', async t => {
  t.after(async () => { await browser.close(); await server.close(); });
  await t.test('list render, arrow ordering, drag ordering, toggle and reload at 100 and 500 rules', async st => {
    reset(5);
    const warmup = await browser.newPage();
    await warmup.goto(`${origin}/#filters`);
    await expect(warmup.locator('.rules > .rule')).toHaveCount(5);
    await warmup.close();
    for (const count of [100, 500]) {
      reset(count);
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      const start = performance.now();
      await page.goto(`${origin}/#filters`);
      const rows = page.locator('.rules > .rule');
      await expect(rows).toHaveCount(count);
      const rendered = performance.now();
      await page.getByRole('button', { name: '2번 규칙 위로', exact: true }).click();
      await expect(rows.first()).toContainText('Synthetic 1');
      await expect(page.getByRole('switch', { name: '1번 규칙 켜기', exact: true })).toBeEnabled();
      const ordered = performance.now();
      await rows.first().locator('.grip').dragTo(rows.nth(1));
      await expect(rows.first()).toContainText('Synthetic 0');
      await expect(page.getByRole('switch', { name: '1번 규칙 켜기', exact: true })).toBeEnabled();
      const dragged = performance.now();
      await page.getByRole('switch', { name: '1번 규칙 켜기', exact: true }).click();
      await expect(rows.first()).toHaveClass(/off/);
      await page.reload();
      await expect(rows).toHaveCount(count);
      await expect(rows.first()).toHaveClass(/off/);
      assert.equal(fake.state.rules.doc.rules.length, count);
      assert.deepEqual(errors, []);
      st.diagnostic(`${count} rules: navigation+render=${(rendered-start).toFixed(1)}ms, arrow+save+reload=${(ordered-rendered).toFixed(1)}ms, drag+save+reload=${(dragged-ordered).toFixed(1)}ms (local fake API, Playwright)`);
      await page.close();
    }
  });
  await t.test('499 allows creating rule 500; 500 disables creation, while editing remains available', async () => {
    reset(499);
    const page = await browser.newPage();
    await page.goto(`${origin}/#rule`);
    await page.locator('.cond input').first().fill('Synthetic last');
    await page.locator('#rule-move').uncheck();
    await page.locator('#rule-read').check();
    await expect(page.getByRole('checkbox', { name: /이미 받은 메일/ })).toBeEnabled();
    await page.getByRole('checkbox', { name: /이미 받은 메일/ }).uncheck();
    await expect(page.getByRole('button', { name: '규칙 저장', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '규칙 저장', exact: true }).click();
    await expect(page.locator('.rules > .rule')).toHaveCount(500);
    assert.equal(fake.state.rules.doc.rules.length, 500);
    for (const width of [1280, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/#rule`);
      await expect(page.getByText('규칙은 최대 500개까지 저장할 수 있어요.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '규칙 저장', exact: true })).toBeDisabled();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.getByText('규칙은 최대 500개까지 저장할 수 있어요.', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${captures}/limit-${width}.png`, animations: 'disabled' });
    }
    await page.goto(`${origin}/#rule/r0000000`);
    await expect(page.getByRole('checkbox', { name: /이미 받은 메일/ })).toBeEnabled();
    await expect(page.getByRole('button', { name: '규칙 저장', exact: true })).toBeEnabled();
    await page.close();
  });
  await t.test('1MB error is shown in Korean in the builder and list', async () => {
    reset(500);
    fake.state.rulesError = { code: 'RULES_INVALID', message: '필터 스크립트는 1MB 이하여야 해요.', path: '$', reason: 'script_too_large' };
    const page = await browser.newPage();
    await page.goto(`${origin}/#rule/r0000000`);
    await expect(page.getByRole('checkbox', { name: /이미 받은 메일/ })).toBeEnabled();
    await page.getByRole('checkbox', { name: /이미 받은 메일/ }).uncheck();
    await page.getByRole('button', { name: '규칙 저장', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('필터 스크립트는 1MB 이하여야 해요.');
    await page.goto(`${origin}/#filters`);
    await page.getByRole('switch', { name: '1번 규칙 켜기', exact: true }).click();
    await expect(page.locator('.rules-error')).toContainText('필터 스크립트는 1MB 이하여야 해요.');
    await page.screenshot({ path: `${captures}/script-size-error.png` });
    await page.close();
  });
});
