import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';

const captures = process.env.EXTFWD_CAPTURE_DIR || '/tmp/extfwd-captures';
const guard = 'if header :contains "X-Spam-Flag" "YES" { stop; }';
const redirect = 'require ["copy"];\nredirect :copy "outside@example.net";\n';
const warning = '외부로 전달하는 필터는 맨 앞에 스팸 메일 전달 제외 줄이 있어야 저장할 수 있어요.';
test('administrator filter external forwarding preview', async t => {
  const fake = createFakeAdminApi();
  const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), logLevel: 'error', plugins: [{ name: 'filter-test-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  t.after(() => browser.close()); await mkdir(captures, { recursive: true });
  async function open(width = 1280) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } }), page = await context.newPage(), errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    const row = { id: '1', type: 'prefilter', active: true, description: '합성 관리자 필터', script: 'keep;\n', etag: 'filter-1' };
    await page.route('**/api/admin/domains', route => route.fulfill({ json: { items: [{ domain: 'example.com', active: true }] } }));
    await page.route('**/api/admin/alias-domains', route => route.fulfill({ json: { items: [{ aliasDomain: 'alias.example.com', targetDomain: 'example.com', active: true }] } }));
    await page.route('**/api/admin/filters/**', route => {
      if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); writes.push(body); Object.assign(row, { script: body.script, etag: 'filter-2' }); return route.fulfill({ json: row }); }
      return route.fulfill({ json: { address: 'person@example.com', items: [row] } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/admin.html#filters/person%40example.com/admin`);
    await expect(page.getByLabel('Sieve 스크립트', { exact: true })).toHaveValue('keep;\n');
    return { page, context, errors, writes };
  }
  async function preview(page, script) {
    await page.getByLabel('Sieve 스크립트', { exact: true }).fill(script);
    await page.getByRole('button', { name: '차이 미리보기·저장', exact: true }).click();
    return page.getByRole('dialog');
  }
  for (const [name, script, external, warn] of [
    ['internal and alias', 'redirect :copy "person@example.com"; redirect :copy "person@alias.example.com";', false, false],
    ['external without guard', redirect, true, true],
    ['guard before redirect', `require ["copy"];\n${guard}\nredirect :copy "outside@example.net";`, true, false],
    ['guard after redirect', `${redirect}${guard}`, true, true],
    ['guard nested in other condition', `if false { ${guard} }\n${redirect}`, true, true],
  ]) await t.test(name, async () => {
    const { page, context, errors } = await open();
    try { const dialog = await preview(page, script); await expect(dialog.getByText('외부로 전달: outside@example.net', { exact: true })).toHaveCount(external ? 1 : 0); await expect(dialog.getByText(warning, { exact: false })).toHaveCount(warn ? 1 : 0); await expect(dialog.getByRole('button', { name: '스팸 메일 전달 제외 넣기' })).toHaveCount(warn ? 1 : 0); if (warn) await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeDisabled(); else await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeEnabled(); assert.deepEqual(errors, []); }
    finally { await context.close(); }
  });
  await t.test('missing guard blocks administrator save without insertion', async () => {
    const { page, context, writes } = await open();
    try { const dialog = await preview(page, redirect); await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeDisabled(); assert.deepEqual(writes, []); }
    finally { await context.close(); }
  });
  await t.test('move redirect retains confirmation', async () => {
    const { page, context, writes } = await open();
    try { const script = `${guard}\nredirect "outside@example.net";`; const dialog = await preview(page, script); await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeDisabled(); await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: '저장', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); assert.deepEqual(writes, [{ etag: 'filter-1', script, confirmMove: true }]); }
    finally { await context.close(); }
  });
  await t.test('server EXTERNAL_SPAM_GUARD response shows blocking message and insertion action', async () => {
    const { page, context } = await open();
    try {
      await page.route('**/api/admin/filters/**/1', route => route.fulfill({ status: 422, json: { error: { code: 'EXTERNAL_SPAM_GUARD', message: warning } } }));
      const dialog = await preview(page, 'redirect :copy "person@example.com";');
      await dialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect(dialog.locator('[data-error-code=EXTERNAL_SPAM_GUARD]')).toHaveText(warning);
      await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
      await dialog.getByRole('button', { name: '스팸 메일 전달 제외 넣기' }).click();
      await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
    } finally { await context.close(); }
  });
  for (const width of [1280, 768, 390, 375]) await t.test(`insertion and captures ${width}`, async () => {
    const { page, context, errors, writes } = await open(width);
    try {
      const dialog = await preview(page, redirect);
      await page.evaluate(() => document.fonts.ready);
      await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
      await page.screenshot({ path: `${captures}/external-warning-${width}.png`, fullPage: true });
      await dialog.getByRole('button', { name: '스팸 메일 전달 제외 넣기' }).click();
      await expect(dialog.getByRole('button', { name: '스팸 메일 전달 제외 넣기' })).toHaveCount(0);
      await expect(dialog.getByText(warning, { exact: false })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
      const expected = `require ["copy"];\n${guard}\nredirect :copy "outside@example.net";\n`;
      await expect(page.getByLabel('Sieve 스크립트', { exact: true })).toHaveValue(expected);
      await page.screenshot({ path: `${captures}/external-guard-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await dialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      assert.deepEqual(writes, [{ etag: 'filter-1', script: expected }]); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
});
