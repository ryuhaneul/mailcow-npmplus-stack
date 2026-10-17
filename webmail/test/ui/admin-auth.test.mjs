import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';
const messages = JSON.parse(await readFile(new URL('../fixtures/admin-auth.json', import.meta.url)));
const captures = process.env.AF02_CAPTURE_DIR || '/tmp/webmail-af02-captures';
await test('AF02 admin login/TOTP/locked/copy and keyboard flows', async t => {
  const fake = createFakeAdminApi();
  const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), logLevel: 'error', plugins: [{ name: 'af02-test-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] }); t.after(() => browser.close()); await mkdir(captures, { recursive: true });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  async function open({ width = 1280, mode = 'password', session = null, hash = 'home' } = {}) {
    fake.state.failure = null; fake.state.session = session; fake.state.auth = { mode, loginError: null, totpError: null };
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    await page.clock.install(); await page.goto(`${origin}/admin.html#${hash}`);
    await expect(page.locator('h1')).toHaveText(session?.step === 'totp' ? '2단계 인증' : '메일 관리에 로그인');
    return { page, context };
  }
  async function password(page) {
    await expect(page.getByLabel('관리자 아이디', { exact: true })).toBeFocused();
    await page.keyboard.type('synthetic-admin'); await page.keyboard.press('Tab');
    await expect(page.getByLabel('암호', { exact: true })).toBeFocused();
    await page.keyboard.type('synthetic-password'); await page.keyboard.press('Enter');
  }
  await t.test('password-only keyboard login reaches home; password cleared before response', async () => {
    const { page, context } = await open(); try {
      let release; const wait = new Promise(resolve => { release = resolve; });
      await page.route('**/api/admin/auth/login', async route => { assert.deepEqual(route.request().postDataJSON(), { username: 'synthetic-admin', password: 'synthetic-password' }); await wait; await route.continue(); });
      await password(page); await expect(page.getByLabel('암호', { exact: true })).toHaveValue(''); await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeDisabled(); release();
      await expect(page.locator('[data-admin-page=home]')).toBeAttached();
      assert.ok(!JSON.stringify(fake.state.requests).includes('synthetic-password'));
    } finally { await context.close(); }
  });
  await t.test('initial expired deep link returns to its original screen after login', async () => {
    const { page, context } = await open({ hash: 'accounts/person%40example.com' }); try { await password(page); await expect(page.locator('[data-admin-page=accounts]')).toBeAttached(); assert.equal(new URL(page.url()).hash, '#accounts/person%40example.com'); } finally { await context.close(); }
  });
  await t.test('TOTP keyboard flow and custom CSRF header reaches home', async () => {
    const { page, context } = await open({ mode: 'totp' }); try { await password(page); await expect(page.getByLabel('인증 코드')).toBeFocused(); await page.keyboard.type('123456'); await page.keyboard.press('Enter'); await expect(page.locator('[data-admin-page=home]')).toBeAttached(); assert.equal(fake.state.requests.findLast(row => row.path.endsWith('/totp')).csrf, 'synthetic-admin-csrf'); } finally { await context.close(); }
  });
  await t.test('one TOTP failure restarts password step with reason and clears code', async () => {
    const { page, context } = await open({ mode: 'totp' }); try { fake.state.auth.totpError = { code: 'TOTP_FAILED', restart: true, remainingAttempts: 4, message: '인증 코드를 확인하고 처음부터 다시 로그인해 주세요.' }; await password(page); await page.getByLabel('인증 코드').fill('123456'); await page.getByRole('button', { name: '인증하고 로그인' }).click(); await expect(page.locator('h1')).toHaveText('메일 관리에 로그인'); await expect(page.getByRole('alert')).toContainText('인증 코드를 확인하고 처음부터 다시 로그인해 주세요.'); await expect(page.getByRole('alert')).toContainText('남은 시도 4회'); await expect(page.getByLabel('관리자 아이디')).toBeFocused(); assert.equal(await page.getByLabel('인증 코드').count(), 0); } finally { await context.close(); }
  });
  for (const mode of ['password', 'totp']) await t.test(`${mode} rate limit returns locked password form and countdown then unlocks`, async () => {
    const { page, context } = await open({ mode }); try {
      const error = { status: 429, code: 'RATE_LIMITED', retryAfter: 298, message: '반복된 실패로 5분 뒤 다시 시도할 수 있습니다.' };
      if (mode === 'password') fake.state.auth.loginError = error; else fake.state.auth.totpError = error;
      await password(page); if (mode === 'totp') { await page.getByLabel('인증 코드').fill('123456'); await page.keyboard.press('Enter'); }
      await expect(page.locator('h1')).toHaveText('메일 관리에 로그인'); await expect(page.getByRole('alert')).toContainText('남은 시간 04:58'); await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeDisabled();
      await page.clock.runFor(2000); await expect(page.getByRole('alert')).toContainText('남은 시간 04:56'); await page.clock.runFor(296000); await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeEnabled();
      if (mode === 'totp') { assert.equal(fake.state.session.step, 'totp'); assert.ok(!fake.state.requests.some(row => row.path.endsWith('/logout'))); }
    } finally { await context.close(); }
  });
  for (const code of ['ADMIN_PENDING_ACTION', 'ADMIN_2FA_UNSUPPORTED', 'MAILCOW_UNAVAILABLE']) await t.test(`${code} uses exact approved copy and no invented link`, async () => {
    const { page, context } = await open(); try { fake.state.auth.loginError = { status: code === 'MAILCOW_UNAVAILABLE' ? 503 : 403, code, message: 'upstream text' }; await password(page); await expect(page.getByRole('alert').locator('p').first()).toHaveText(messages[code]); assert.equal(await page.getByRole('link', { name: 'mailcow 관리 화면' }).count(), 0); } finally { await context.close(); }
  });
  await t.test('MAILCOW_SESSION_LOST shows approved notice and returns to previous screen after login', async () => {
    const { page, context } = await open(); try { await password(page); await page.locator('#nav a[href="#accounts"]').click(); fake.state.failure = { code: 'MAILCOW_SESSION_LOST', message: 'upstream text' }; await page.evaluate(async () => { const { adminApi } = await import('/src/admin/api.js'); try { await adminApi('/api/admin/status'); } catch {} }); await expect(page.getByRole('alert').locator('p').first()).toHaveText(messages.MAILCOW_SESSION_LOST); fake.state.failure = null; await password(page); await expect(page.locator('[data-admin-page=accounts]')).toBeAttached(); await expect(page.locator('.account-item')).toHaveCount(4); } finally { await context.close(); }
  });
  await t.test('pending action fallback only allows supplied http(s) links', async () => {
    const { page, context } = await open(); try { fake.state.auth.loginError = { code: 'ADMIN_PENDING_ACTION', fallbackUrl: 'https://mailcow.example.com/', message: 'upstream' }; await password(page); await expect(page.getByRole('link', { name: 'mailcow 관리 화면' })).toHaveAttribute('href', 'https://mailcow.example.com/'); fake.state.auth.loginError.fallbackUrl = 'javascript:alert(1)'; await password(page); assert.equal(await page.getByRole('link', { name: 'mailcow 관리 화면' }).count(), 0); } finally { await context.close(); }
  });
  await t.test('five-minute pending expiry returns to password and other-account cancels locally', async () => {
    const { page, context } = await open({ session: { step: 'totp', user: { username: 'synthetic-admin' }, csrf: 'synthetic-csrf', expiresAt: new Date(Date.now() + 300000).toISOString() } }); try { await page.clock.runFor(301000); await expect(page.locator('h1')).toHaveText('메일 관리에 로그인'); await expect(page.getByRole('alert')).toContainText('로그인이 만료됐어요. 다시 로그인해 주세요.'); } finally { await context.close(); }
    const second = await open({ mode: 'totp' }); try { await password(second.page); await second.page.getByRole('button', { name: '다른 계정으로 로그인' }).click(); await expect(second.page.getByLabel('관리자 아이디')).toBeFocused(); } finally { await second.context.close(); }
  });
  for (const width of [1280, 768, 390, 375]) for (const state of ['login', 'totp', 'locked', 'pending']) await t.test(`capture ${state} ${width} and no demo controls`, async () => {
    const { page, context } = await open({ width, mode: state === 'totp' ? 'totp' : 'password' }); try {
      if (state === 'locked') fake.state.auth.loginError = { status: 429, code: 'RATE_LIMITED', retryAfter: 298 };
      if (state === 'pending') fake.state.auth.loginError = { code: 'ADMIN_PENDING_ACTION' };
      if (state !== 'login') { await password(page); await expect(page.locator(state === 'totp' ? '#totp' : '[role=alert]')).toBeVisible(); }
      for (const name of ['아이디·암호', '2단계 인증 없음', '실패 예시']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${captures}/${state}-${width}.png` });
    } finally { await context.close(); }
  });
});
