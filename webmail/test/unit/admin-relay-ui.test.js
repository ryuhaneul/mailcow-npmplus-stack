import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('relay UI describes reload and asynchronous filter application, retaining request compatibility', async () => {
  const flow = await readFile(new URL('../../web/src/admin/flows/RelayChange.jsx', import.meta.url), 'utf8');
  const page = await readFile(new URL('../../web/src/admin/pages/Relay.jsx', import.meta.url), 'utf8');
  assert.match(flow, /confirmRestart: true/);
  for (const source of [flow, page]) { assert.doesNotMatch(source, /재시작|SMTP가 끊/); assert.match(source, /다시 읽/); assert.match(source, /최대 1분/); }
});

test('relay browser: add/remove copy, confirmation contract, result and pending state', { skip: process.env.RELAY_UI_BROWSER !== 'true' }, async t => {
  const { createServer } = await import('vite');
  const { chromium, expect } = await import('@playwright/test');
  const { createFakeAdminApi } = await import('../../web/dev/fake-admin-api.js');
  const fake = createFakeAdminApi();
  const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), logLevel: 'error', plugins: [{ name: 'relay-api-fixture', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const captures = process.env.RELAY_CAPTURE_DIR || '/tmp/relay-captures'; await mkdir(captures, { recursive: true });
  for (const width of [1280, 768, 375]) await t.test(`reload flow ${width}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 1000 } }), page = await context.newPage();
    const data = { items: [], etag: 'before', consistent: true }; let submitted;
    await page.route('**/api/admin/relay**', async route => {
      const req = route.request();
      if (req.url().endsWith('/recent')) return route.fulfill({ json: { ip: '203.0.113.8', count: 0, lastSeen: null, examples: [], n: 1000, range: {}, notice: '최근 로그 1000줄 안에서' } });
      if (req.method() === 'POST') { submitted = req.postDataJSON(); data.items.push({ ip: '203.0.113.8', note: '합성 장비' }); data.etag = 'after'; return route.fulfill({ json: { result: 'ok', auditId: 'a'.repeat(32), etag: 'after' } }); }
      return route.fulfill({ json: data });
    });
    await page.route('**/api/admin/history?**', route => route.fulfill({ json: { items: [] } }));
    try {
      await page.goto(`${origin}/admin.html#flow/relay`);
      await expect(page.getByLabel('IP 주소')).toBeVisible();
      await expect(page.locator('body')).not.toContainText('재시작');
      await expect(page.locator('body')).toContainText('스팸 필터 반영은 최대 1분 걸려요');
      await page.getByLabel('IP 주소').fill('203.0.113.8'); await page.getByLabel('설명', { exact: true }).fill('합성 장비');
      await page.getByRole('button', { name: '변경 미리보기' }).click();
      await expect(page.locator('body')).toContainText('새 목록 저장 · 설정 다시 읽기');
      await page.getByRole('button', { name: '실행 확인으로' }).click();
      await page.getByRole('checkbox').nth(0).check(); await page.getByRole('checkbox').nth(1).check();
      await page.getByRole('button', { name: '실행하기' }).click();
      await expect(page.locator('.ac-result')).toContainText('다시 읽기 완료');
      await expect(page.locator('.ac-result')).toContainText('최대 1분'); assert.equal(submitted.confirmRestart, true);
      await page.screenshot({ path: `${captures}/relay-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.evaluate(() => { location.hash = 'flow/removeRelay/203.0.113.8'; });
      await expect(page.locator('h1')).toHaveText('릴레이 IP 빼기');
      await expect(page.locator('body')).toContainText('다시 읽습니다'); await expect(page.locator('body')).not.toContainText('재시작');
      data.consistent = false; data.notice = '파일 방식으로 전환 중이에요. 전환이 끝난 뒤 다시 시도해 주세요.';
      await page.reload();
      await expect(page.locator('body')).toContainText(data.notice);
      await expect(page.getByRole('button', { name: '변경 미리보기' })).toBeDisabled();
    } finally { await context.close(); }
  });
});
