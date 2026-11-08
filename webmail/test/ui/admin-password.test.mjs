import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';

const output = process.env.ADMIN_PASSWORD_CAPTURE_DIR || '/tmp/admin-password-captures';
const root = fileURLToPath(new URL('../../web/dist-admin/', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
await test('administrator password dialog in the built application', async t => {
  await mkdir(output, { recursive: true });
  const fake = createFakeAdminApi(), errors = [], results = [];
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/admin/')) return fake.middleware(req, res, () => { res.writeHead(404); res.end(); });
    try {
      const path = new URL(req.url, 'http://localhost').pathname, target = resolve(root, `.${path === '/' ? '/admin.html' : path}`);
      if (!target.startsWith(root)) throw new Error('path');
      const body = await readFile(target); res.writeHead(200, { 'content-type': mime[extname(target)] || 'application/octet-stream' }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const width of [1280, 375]) for (const mode of ['light', 'dark']) await t.test(`${width}px ${mode}: keyboard, errors, busy state and success`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: mode });
      try {
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (response.status() >= 400 && !response.url().includes('/api/')) errors.push(`${response.status()} ${response.url()}`); });
        await page.addInitScript(mode => localStorage.setItem('webmail-admin-prefs', JSON.stringify({ theme: 'ink', mode, accent: {} })), mode);
        let result = 'current', requests = 0, release, hold;
        await page.route('**/api/admin/auth/password', async route => {
          requests++;
          assert.deepEqual(route.request().postDataJSON(), { currentPassword: 'synthetic-current', password: 'synthetic-new', password2: 'synthetic-new' });
          assert.equal(route.request().headers()['x-mailadmin-csrf'], 'synthetic-admin-csrf');
          if (hold) await hold;
          const status = result === 'current' ? 403 : result === 'policy' ? 422 : 200;
          const body = result === 'current' ? { error: { code: 'AUTH_FAILED', message: '현재 암호가 맞지 않습니다.', remainingAttempts: 4 } } : result === 'policy' ? { error: { code: 'MAILCOW_REJECTED', message: 'mailcow가 요청을 거절했어요(password_complexity).' } } : { ok: true };
          await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        });
        await page.goto(`${origin}/admin.html#home`);
        const trigger = page.getByRole('button', { name: '내 암호 변경', exact: true });
        await expect(trigger).toBeVisible();
        await expect(page.getByRole('button', { name: mode === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환' })).toBeVisible();
        await expect(page.getByRole('link', { name: '보기 설정' })).toBeVisible();
        const topOverflow = await page.locator('.top').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
        assert.ok(topOverflow.scrollWidth <= topOverflow.width);
        const dialog = page.getByRole('dialog', { name: '내 암호 변경' }), current = page.getByLabel('현재 암호', { exact: true }), next = page.getByLabel('새 암호', { exact: true }), confirm = page.getByLabel('새 암호 확인', { exact: true });
        await trigger.click(); await expect(current).toBeFocused();
        for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('dialog'))), true); }
        await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
        await trigger.click(); await expect(current).toBeFocused();
        assert.equal(await current.getAttribute('autocomplete'), 'current-password'); assert.equal(await next.getAttribute('autocomplete'), 'new-password');
        async function capture(state) {
          await page.evaluate(() => document.fonts.ready);
          const metrics = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, dialogWidth: document.querySelector('dialog').clientWidth, dialogScrollWidth: document.querySelector('dialog').scrollWidth, focus: document.activeElement.id || document.activeElement.textContent, passwordValues: [...document.querySelectorAll('input[type=password]')].filter(input => input.value).length }));
          assert.ok(metrics.scrollWidth <= width); assert.ok(metrics.dialogScrollWidth <= metrics.dialogWidth); assert.equal(metrics.passwordValues, 0);
          await page.screenshot({ path: `${output}/${state}-${width}-${mode}.png` }); results.push({ state, width, mode, ...metrics });
        }
        async function fill() { await current.fill('synthetic-current'); await next.fill('synthetic-new'); await confirm.fill('synthetic-new'); }
        await capture('input');
        await fill(); await confirm.press('Enter'); await expect(page.getByRole('alert')).toContainText('현재 암호가 맞지 않습니다.'); await expect(current).toBeFocused(); await capture('current-error');
        result = 'policy'; await fill(); await confirm.press('Enter'); await expect(page.getByRole('alert')).toContainText('password_complexity'); await expect(next).toBeFocused(); await capture('policy-error');
        const count = requests; await fill(); await confirm.fill('synthetic-mismatch'); await confirm.press('Enter'); await expect(confirm).toBeFocused(); await expect(page.getByRole('alert')).toContainText('일치하지 않습니다.'); assert.equal(requests, count);
        result = 'success'; hold = new Promise(resolve => { release = resolve; }); await fill(); await confirm.press('Enter');
        await expect(page.getByRole('button', { name: '변경 중…' })).toBeDisabled();
        await expect(current).toHaveValue(''); await expect(next).toHaveValue(''); await expect(confirm).toHaveValue('');
        await page.keyboard.press('Escape'); await expect(dialog).toBeVisible(); await dialog.locator('form').evaluate(form => form.requestSubmit()); assert.equal(requests, count + 1);
        release(); await expect(page.getByRole('status')).toContainText('암호를 변경했습니다.'); await expect(dialog.locator('input')).toHaveCount(0); await capture('success');
        await page.getByRole('button', { name: '확인', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
        await trigger.click(); await expect(current).toHaveValue(''); await expect(next).toHaveValue(''); await page.getByRole('button', { name: '취소', exact: true }).click(); await expect(trigger).toBeFocused();
        assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.toLowerCase().includes('password'))), false);
      } finally { await context.close(); }
    });
    assert.deepEqual(errors, []); assert.equal(results.length, 16);
  } finally {
    await browser?.close(); if (server.listening) await new Promise(resolve => server.close(resolve));
    await writeFile(`${output}/verification.json`, JSON.stringify({ browser: 'chromium-1228', workers: 1, captureRounds: 1, builtApplication: true, results, errors, cleanedUp: true }, null, 2));
  }
});
