import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';

const captures = process.env.FTS_CAPTURE_DIR || '/tmp/webmail-fts-captures';
const measuredAt = '2026-10-20T18:00:00.000Z';
const empty = { enabled: false, window: { start: '03:00', end: '06:00', timeZone: 'Asia/Seoul' }, lastRun: null, indexBlocked: false, remoteUnknown: null, snapshot: null, folders: [], damaged: false };
const rows = Array.from({ length: 20 }, (_, index) => ({ user: `person${index}@example.test`, mailbox: index === 0 ? `프로젝트/아주 긴 한글 폴더 이름 ${'상세자료'.repeat(30)}` : `합성 폴더 ${index}`, messages: 1000, indexed: 800 + index, unindexed: 200 - index, shards: 2, status: 'ok', reason: null, measuredAt: new Date(Date.parse(measuredAt) + index * 1000).toISOString() }));
const complete = { ...empty, enabled: true, lastRun: { day: '2026-10-21', status: 'done', startedAt: measuredAt, finishedAt: '2026-10-20T18:20:00Z' }, snapshot: { measuredAt, totals: { messages: 20000, indexed: 16190, unindexed: 3810, unmeasured: 0, excluded: 0 }, top20: rows }, folders: rows.map(row => ({ ...row, result: 'done', error: null })) };
const states = {
  disabled: empty,
  complete,
  blocked: { ...complete, indexBlocked: true, remoteUnknown: { user: null, mailbox: null, at: measuredAt, reason: 'restart' }, lastRun: { ...complete.lastRun, status: 'unknown' } },
  damaged: { ...empty, enabled: true, damaged: true },
  incomplete: { ...complete, lastRun: { ...complete.lastRun, status: 'cutoff' }, snapshot: { ...complete.snapshot, incomplete: true } },
};
await test('FTS overview synthetic responses, independent errors and responsive captures', async t => {
  const fake = createFakeAdminApi();
  const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), logLevel: 'error', plugins: [{ name: 'fts-test-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  t.after(() => browser.close()); await mkdir(captures, { recursive: true });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`, diagnostics = [];
  async function open(data, width = 1280, status = 200) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'light' });
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/api/admin/fts-status', route => { requests.push(route.request().method()); return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) }); });
    await page.clock.setFixedTime(new Date('2026-10-21T18:30:00Z'));
    await page.goto(`${origin}/admin.html#overview`);
    await expect(page.locator('[data-status-card=queue] .value')).toContainText('9');
    const card = page.locator('[data-fts-status]');
    await expect(card.getByText('검색 색인', { exact: true })).toBeVisible();
    return { page, context, card, errors, requests };
  }
  for (const [name, data] of Object.entries(states)) for (const width of [1280, 768, 375]) await t.test(`${name} ${width}`, async () => {
    const { page, context, card, errors, requests } = await open(data, width);
    try {
      await expect(card.getByText(name === 'disabled' ? '꺼짐' : '켜짐', { exact: true })).toBeVisible();
      if (name === 'disabled' || name === 'damaged') { await expect(card.getByText('미측정', { exact: true })).toHaveCount(3); assert.doesNotMatch(await card.innerText(), /0통|0개/); }
      if (name === 'blocked') await expect(card.getByText('종료 확인 필요 — 수동 복구', { exact: true })).toBeVisible();
      if (name === 'incomplete') {
        await expect(card).toContainText('측정 미완료');
        await expect(card).toContainText('측정하지 못한 폴더의 수와 잔량은 알 수 없습니다.');
        await expect(card).not.toContainText('3,810통');
      }
      if (name === 'blocked') await expect(card).toContainText('앱 재시작 뒤 남은 잠금');
      await expect(card).toContainText('폴더별 마지막 측정 합계');
      if (name === 'damaged') await expect(card.getByRole('alert')).toContainText('상태 손상');
      if (name === 'complete' || name === 'blocked') {
        await expect(card.getByText('오래된 측정', { exact: true })).toBeVisible();
        await expect(card).toContainText('3,810통');
        await expect(card).toContainText('10월 23일 금요일 · 03:00 KST');
      }
      await card.locator('summary').click();
      if (data.snapshot) {
        await expect(card.locator('tbody tr')).toHaveCount(20);
        assert.deepEqual(await card.locator('tbody tr td:first-child').allTextContents(), rows.map(row => row.user));
        await expect(card.locator('tbody tr').first()).toContainText(rows[0].mailbox);
        const scroll = card.locator('.table-wrap');
        assert.equal(await scroll.evaluate(element => element.scrollWidth > element.clientWidth), true);
        assert.equal(await scroll.evaluate(element => { element.scrollLeft = element.scrollWidth; const moved = element.scrollLeft > 0; element.scrollLeft = 0; return moved; }), true);
      } else await expect(card.getByText('아직 측정한 정보가 없습니다.', { exact: true })).toBeVisible();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${captures}/${name}-${width}.png`, fullPage: true });
      assert.deepEqual(errors, []); assert.deepEqual(requests, ['GET']);
      diagnostics.push({ name, width, errors, requests });
    } finally { await context.close(); }
  });
  for (const width of [1280, 375]) await t.test(`partial account listing failure and exclusions ${width}`, async () => {
    const issueRows = [
      { user: 'partial@example.test', mailbox: null, messages: null, indexed: null, unindexed: null, status: 'unmeasured', result: 'unmeasured', reason: 'measurement-failed' },
      { user: 'partial@example.test', mailbox: '별표*폴더', messages: null, indexed: null, unindexed: null, status: 'excluded', result: 'excluded', reason: 'wildcard-name' },
      { user: 'partial@example.test', mailbox: '연결 실패', messages: 4, indexed: 0, unindexed: 4, status: 'ok', result: 'failed', error: 'DOVEADM_UNAVAILABLE' },
    ];
    const data = { ...complete, lastRun: { ...complete.lastRun, status: 'failed' }, folders: [...complete.folders, ...issueRows], snapshot: { ...complete.snapshot, totals: { ...complete.snapshot.totals, unmeasured: 1, excluded: 1 } } };
    const { page, card, context, errors, requests } = await open(data, width);
    try {
      await expect(card.getByText('일부 실패', { exact: true })).toBeVisible();
      await expect(card).toContainText('측정된 폴더만의 합계'); await expect(card).toContainText('전체 대상 22개 · 측정 성공 21개 · 측정 실패 1개 · 제외 1개');
      await card.locator('summary').click();
      await expect(card.locator('table').last()).toContainText('이름에 * 또는 % 가 있어 자동 색인 제외');
      await expect(card.locator('table').last()).toContainText('서버 연결 불가');
      const nullRow = card.locator('table').last().locator('tbody tr').first();
      await expect(nullRow).toContainText('폴더 목록 확인 불가');
      await page.screenshot({ path: `${captures}/partial-${width}.png`, fullPage: true });
      await expect(nullRow).toContainText('미측정'); assert.doesNotMatch(await nullRow.innerText(), /\b0\b/);
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/admin/fts-status')), page.getByRole('button', { name: '새로고침', exact: true }).click()]);
      await expect(card.getByText('일부 실패', { exact: true })).toBeVisible(); assert.deepEqual(requests, ['GET', 'GET']); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  for (const remeasured of [false, true]) for (const width of [1280, 768, 375]) await t.test(`manual recovery remeasured=${remeasured} ${width}`, async () => {
    const recovered = { user: 'operator-test@example.test', mailbox: 'Imported', messages: remeasured ? 20001 : null,
      indexed: remeasured ? 20001 : null, unindexed: remeasured ? 0 : null, status: remeasured ? 'ok' : 'unmeasured',
      result: 'unknown', error: 'manual-unlock', measuredAt: remeasured ? measuredAt : null };
    const data = { ...complete, lastRun: { ...complete.lastRun, status: 'failed' }, folders: [recovered],
      snapshot: { measuredAt, totals: { messages: remeasured ? 20001 : 0, indexed: remeasured ? 20001 : 0,
        unindexed: 0, unmeasured: remeasured ? 0 : 1, excluded: 0 }, top20: [] } };
    const { page, card, context, errors } = await open(data, width);
    try {
      await expect(card).not.toContainText('현재 폴더'); await expect(card).not.toContainText('20,000통');
      await expect(card.getByText('일부 실패', { exact: true })).toBeVisible();
      if (remeasured) await expect(card).toContainText('0통');
      else { await expect(card).not.toContainText('0통'); await expect(card).toContainText('측정 실패 1개'); }
      await card.locator('summary').click(); await expect(card).toContainText('수동 복구 · 실행 결과 미확인');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${captures}/manual-${remeasured ? 'remeasured' : 'unmeasured'}-${width}.png`, fullPage: true });
      assert.deepEqual(errors, []); diagnostics.push({ name: `manual-${remeasured}`, width, errors });
    } finally { await context.close(); }
  });
  for (const [status, expected] of [['running', '종료 시각 초과·마무리 중'], ['cutoff', '시간 창 종료']]) await t.test(status, async () => {
    const { card, context, errors } = await open({ ...complete, lastRun: { ...complete.lastRun, status, finishedAt: status === 'running' ? null : complete.lastRun.finishedAt } });
    try { await expect(card.getByText(expected, { exact: true })).toBeVisible(); assert.deepEqual(errors, []); } finally { await context.close(); }
  });
  await t.test('FTS request error leaves other overview areas visible and retry reads cache', async () => {
    const { page, card, context, requests } = await open({ error: { code: 'SYNTHETIC_FTS_FAILED' } }, 375, 502);
    try {
      await expect(card.getByRole('alert')).toContainText('검색 색인 상태를 불러오지 못했습니다');
      await expect(page.getByText('451 synthetic',{ exact: false })).toBeVisible();
      await page.unroute('**/api/admin/fts-status');
      await page.route('**/api/admin/fts-status', route => { requests.push(route.request().method()); return route.fulfill({ json: empty }); });
      await card.getByRole('button', { name: '다시 시도' }).click();
      await expect(card.getByText('미실행', { exact: true })).toBeVisible(); assert.deepEqual(requests, ['GET', 'GET']);
    } finally { await context.close(); }
  });
  await writeFile(`${captures}/browser-diagnostics.json`, `${JSON.stringify(diagnostics, null, 2)}\n`);
});
