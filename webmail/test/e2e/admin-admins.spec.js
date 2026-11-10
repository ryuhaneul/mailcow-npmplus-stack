import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';

test.use({ browserName: 'chromium', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (process.env.PLAYWRIGHT_BROWSERS_PATH ? resolve(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1228/chrome-linux64/chrome') : undefined), args: ['--no-sandbox'] } });
test.setTimeout(180000);
const root = fileURLToPath(new URL('../../web/dist-admin/', import.meta.url));
const captures = process.env.ADMIN_ACCOUNTS_CAPTURE_DIR || fileURLToPath(new URL('../../test-results/admin-accounts/', import.meta.url));
const secret = 'SyntheticBrowserCredential732!';
const initialRows = () => [
  { username: 'admin', active: true, tfaActive: true, created: '2026-09-08 09:30:00', forceTfa: false, forcePwUpdate: false, etag: 'opaque-admin' },
  { username: 'operations', active: true, tfaActive: true, created: '2026-10-12 14:00:00', forceTfa: false, forcePwUpdate: false, etag: 'opaque-operations' },
  { username: 'archive', active: false, tfaActive: false, created: '2026-10-27 18:00:00', forceTfa: false, forcePwUpdate: false, etag: 'opaque-archive' },
];
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
test('built administrator overview dialogs, contracts, keyboard, responsive light and dark captures', async ({ browser }) => {
  const fake = createFakeAdminApi(); fake.state.session.user.username = 'admin';
  let rows = initialRows(), failure, hold, serial = 0;
  const calls = [], results = [], errors = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (path === '/api/admin/fts-status') return send({ enabled: false, window: { start: '03:00', end: '06:00' }, folders: [], lastRun: null, snapshot: null });
      if (path === '/api/admin/monitor/status') return send({ enabled: false });
      if (path === '/api/admin/admins' || path.startsWith('/api/admin/admins/')) {
        if (req.method === 'GET') return send({ items: rows });
        let raw = ''; for await (const part of req) raw += part;
        const body = JSON.parse(raw), entry = { method: req.method, path, keys: Object.keys(body), csrf: req.headers['x-mailadmin-csrf'], etag: body.etag };
        calls.push(entry); const waiting = hold; if (waiting) await waiting.promise;
        if (failure) return send({ error: failure }, failure.status);
        const name = decodeURIComponent(path.split('/')[4] || '');
        if (req.method === 'POST' && path === '/api/admin/admins') { expect(body.password).toBe(secret); expect(body.password2).toBe(secret); rows = [...rows, { ...initialRows()[2], username: body.username, active: body.active, etag: `new-${++serial}` }]; }
        else if (req.method === 'DELETE') rows = rows.filter(r => r.username !== name);
        else if (req.method === 'PATCH') rows = rows.map(r => r.username === name ? { ...r, active: body.active, etag: `change-${++serial}` } : r);
        else { expect(body.password).toBe(secret); expect(body.password2).toBe(secret); }
        return send({ ok: true });
      }
      await fake.middleware(req, res, async () => {
        const file = resolve(root, '.' + (path === '/' ? '/admin.html' : path));
        if (!file.startsWith(root)) throw new Error('invalid path');
        try { const data = await readFile(file); res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(data); }
        catch { res.writeHead(404); res.end(); }
      });
    } catch (error) { errors.push(error.message); if (!res.writableEnded) send({ error: { code: 'FIXTURE_ERROR', message: 'synthetic' } }, 500); }
  });
  await mkdir(captures, { recursive: true });
  let context;
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const width of [1280, 768, 375]) for (const mode of ['light', 'dark']) {
      rows = initialRows(); failure = null; hold = null;
      context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: mode });
      await context.addInitScript(mode => localStorage.setItem('webmail-admin-prefs', JSON.stringify({ theme: 'ink', mode, accent: {} })), mode);
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/admin.html#overview`);
      const section = page.locator('[data-admin-accounts]'), region = section.getByRole('region');
      await expect(section.locator('tbody tr')).toHaveCount(3); await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
      await expect(page.getByRole('button', { name: '내 암호 변경', exact: true })).toBeVisible();
      const take = async state => {
        const metrics = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, dialogs: [...document.querySelectorAll('dialog[open]')].map(d => ({ width: d.clientWidth, scrollWidth: d.scrollWidth })), table: (() => { const n = document.querySelector('[data-admin-accounts] .table-wrap'); return { width: n.clientWidth, scrollWidth: n.scrollWidth, scrollLeft: n.scrollLeft }; })() }));
        expect(metrics.scrollWidth).toBeLessThanOrEqual(width);
        for (const d of metrics.dialogs) expect(d.scrollWidth).toBeLessThanOrEqual(d.width);
        await page.screenshot({ path: resolve(captures, `overview-${state}-${width}-${mode}.png`), fullPage: true });
        results.push({ state, width, mode, ...metrics });
      };
      await section.scrollIntoViewIfNeeded();
      for (const cell of await section.locator('td,th').all()) await expect(cell).toHaveCSS('white-space', 'nowrap');
      await take('list');
      if (width === 375) {
        await region.evaluate(n => { n.scrollLeft = n.scrollWidth; });
        const button = section.getByRole('button', { name: 'operations 암호 재설정', exact: true });
        const b = await button.boundingBox(), r = await region.boundingBox(); expect(b.x).toBeGreaterThanOrEqual(r.x); expect(b.x + b.width).toBeLessThanOrEqual(r.x + r.width + 1);
        await take('scrolled-actions');
      }
      await section.getByRole('button', { name: '관리자 추가', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '관리자 추가', exact: true }); await expect(dialog).toBeVisible();
      const border = await dialog.getByLabel('암호', { exact: true }).evaluate(n => ({ width: getComputedStyle(n).borderWidth, style: getComputedStyle(n).borderStyle })); expect(border).toEqual({ width: '1px', style: 'solid' });
      await take('add'); await dialog.getByRole('button', { name: '취소', exact: true }).click();
      const reset = section.getByRole('button', { name: 'operations 암호 재설정', exact: true }); await reset.click();
      dialog = page.getByRole('dialog', { name: '암호 재설정', exact: true }); await take('reset');
      await dialog.getByLabel('새 암호', { exact: true }).fill(secret); await dialog.getByLabel('새 암호 확인', { exact: true }).fill(secret);
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(reset).toBeFocused();
      await reset.click(); dialog = page.getByRole('dialog'); await expect(dialog.getByLabel('새 암호', { exact: true })).toHaveValue('');
      await dialog.getByRole('button', { name: '취소', exact: true }).click();
      await section.getByRole('button', { name: 'operations 삭제', exact: true }).click(); dialog = page.getByRole('dialog', { name: '관리자 삭제', exact: true }); await take('delete');
      await expect(dialog.getByRole('button', { name: '관리자 삭제', exact: true })).toBeDisabled(); await dialog.getByRole('button', { name: '취소', exact: true }).click();
      await section.getByRole('button', { name: 'operations 끄기', exact: true }).click(); dialog = page.getByRole('dialog', { name: '관리자 끄기', exact: true }); await take('toggle');
      const cancel = dialog.getByRole('button', { name: '취소', exact: true }); await cancel.focus(); await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: '끄기', exact: true })).toBeFocused(); await page.keyboard.press('Tab'); await expect(cancel).toBeFocused();
      failure = { status: 403, code: 'ADMIN_SELF_ACTION', message: '본인 계정은 끄거나 삭제할 수 없습니다.' }; await dialog.getByRole('button', { name: '끄기', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('본인 계정'); await take('self-error'); await cancel.click();
      failure = { status: 409, code: 'LAST_ACTIVE_ADMIN', message: '마지막 활성 관리자는 끄거나 삭제할 수 없습니다. 다른 관리자 계정을 먼저 켜 주세요.' };
      await section.getByRole('button', { name: 'operations 끄기', exact: true }).click(); dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: '끄기', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('마지막 활성'); await take('last-error'); await dialog.getByRole('button', { name: '다시 읽기', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(section.locator('tbody tr')).toHaveCount(3);
      failure = null;
      await section.getByRole('button', { name: '관리자 추가', exact: true }).click(); dialog = page.getByRole('dialog');
      await dialog.getByLabel('아이디', { exact: true }).fill('new-admin'); await dialog.getByLabel('암호', { exact: true }).fill(secret); await dialog.getByLabel('암호 확인', { exact: true }).fill(secret);
      let release; hold = { promise: new Promise(done => { release = done; }) }; const before = calls.length;
      try {
        await dialog.getByRole('button', { name: '추가', exact: true }).click(); await expect(dialog.getByRole('button', { name: '처리 중…', exact: true })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel('암호', { exact: true })).toHaveValue(''); expect(calls.length).toBe(before + 1);
      } finally { hold = null; release(); }
      await expect(dialog).toHaveCount(0); await expect(section.locator('tbody tr')).toHaveCount(4); await expect(section.getByRole('status')).toContainText('추가했습니다');
      expect(await page.evaluate(value => JSON.stringify(localStorage).includes(value) || JSON.stringify(sessionStorage).includes(value), secret)).toBe(false);
      await context.close(); context = null;
    }
    expect(errors).toEqual([]);
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
    await writeFile(resolve(dirname(captures), 'browser-verification.json'), JSON.stringify({ build: 'actual admin production bundle with synthetic local HTTP fixtures', browser: 'chromium-1228', workers: 1, captureRounds: 1, results, errors, cleanedUp: true, calls }, null, 2));
  }
});
