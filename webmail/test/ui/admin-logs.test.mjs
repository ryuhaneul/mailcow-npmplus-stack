import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';

const captures = process.env.ARCHIVE_CAPTURE_DIR || '/tmp/webmail-admin-logs-captures';
const sourceNames = ['postfix', 'dovecot', 'rspamd', 'php-fpm', 'nginx', 'webmail', 'webmail-admin', 'npmplus'];
const oldest = '2026-10-20T00:00:00Z', newest = '2026-10-21T09:00:00Z';
const statusData = { enabled: true, sources: sourceNames.map(source => ({ source, oldest, newest, lagSeconds: 2, backfillComplete: true, issues: [] })) };
const line = (message = '합성 로그 sender@example.test → recipient@example.test') => ({ time: '2026-10-21T08:30:00Z', source: 'postfix', program: 'postfix/smtp', message });
const complete = { enabled: true, lines: [line()], cursor: null, partialReason: null, incomplete: false, scannedThrough: newest, coverage: { source: 'postfix', oldest, newest, gaps: [] } };
const gaps = { ...complete, incomplete: true, coverage: { ...complete.coverage, gaps: [{ from: '2026-10-21T08:00:00Z', to: '2026-10-21T08:15:00Z', reason: 'synthetic-source-missing' }] } };
const recent = { kind: 'postfix', range: { count: 25, oldest, newest }, lines: [{ ...line('최근 합성 로그'), priority: 'info' }] };
await test('archive logs: KST, cursor, states and responsive UI with synthetic data', async t => {
  const fake = createFakeAdminApi();
  const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), logLevel: 'error', plugins: [{ name: 'archive-log-test-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  t.after(() => browser.close()); await mkdir(captures, { recursive: true });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`, diagnostics = [];
  async function open({ width = 1280, status = statusData, response = complete, handler, timezoneId = 'America/Los_Angeles', statusCode = 200 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'light', timezoneId });
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('the server responded with a status of')) errors.push(message.text()); });
    await page.route('**/api/admin/logs/archive/status', route => route.fulfill({ status: statusCode, json: status }));
    await page.route('**/api/admin/logs/archive?**', async route => {
      const params = new URL(route.request().url()).searchParams; requests.push(Object.fromEntries(params));
      if (handler) return handler(route, params, requests.length);
      return route.fulfill({ json: { ...response, scannedThrough: params.get('to') } });
    });
    await page.route('**/api/admin/logs?**', route => route.fulfill({ json: recent }));
    await page.clock.setFixedTime(new Date('2026-10-21T09:00:00Z'));
    await page.goto(`${origin}/admin.html#logs`);
    await expect(page.locator('[data-admin-page=logs]')).toBeVisible();
    return { page, context, errors, requests };
  }
  const progress = page => page.locator('.archive-search [role=status]');
  async function archiveReady(page) { await expect(progress(page)).toContainText('검색 완료'); }
  async function periodSearch(page) { await page.locator('form').getByRole('button', { name: '기간 검색', exact: true }).click(); }
  for (const [name, response, status] of [['results', complete, statusData], ['gaps', gaps, statusData], ['disabled', complete, { enabled: false, sources: [] }]]) for (const width of [1280, 768, 375]) await t.test(`${name} ${width}`, async () => {
    const { page, context, requests, errors } = await open({ width, response, status });
    try {
      if (name === 'disabled') {
        await expect(page.getByText('기간 검색이 꺼져 있습니다.', { exact: false })).toBeVisible();
        await expect(page.getByRole('button', { name: '기간 검색', exact: true })).toHaveCount(0);
        await expect(page.getByRole('region', { name: '로그 검색 결과', exact: true })).toContainText('최근 합성 로그');
        assert.equal(requests.length, 0);
      } else {
        await archiveReady(page);
        assert.deepEqual(await page.locator('#archive-source option').evaluateAll(options => options.map(option => option.value)), ['postfix', 'dovecot', 'rspamd', 'webmail', 'webmail-admin', 'npmplus']);
        await expect(page.getByLabel('시작 날짜·시각 · KST (UTC+09:00)', { exact: true })).toBeVisible();
        await expect(page.locator('tbody')).toContainText('17:30');
        await expect(page.locator('tbody')).toContainText('sender@example.test');
        if (width === 375) {
          const table = page.getByRole('region', { name: '보관 로그 결과 표', exact: true });
          assert.equal(await table.evaluate(element => element.scrollWidth > element.clientWidth), true);
          await table.focus(); await page.keyboard.press('ArrowRight');
          await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
          await table.evaluate(element => { element.scrollLeft = 0; element.blur(); });
        }
        if (name === 'gaps') { await expect(page.locator('.archive-search .alert.warn')).toHaveCount(2); await expect(page.getByText('수집 빈 구간', { exact: true })).toBeVisible(); await expect(page.getByText('synthetic-source-missing', { exact: false })).toBeVisible(); }
        assert.deepEqual(requests, [{ source: 'postfix', from: '2026-10-21T17:00:00+09:00', to: '2026-10-21T18:00:00+09:00', q: '', limit: '200' }]);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${captures}/${name}-${width}.png`, fullPage: true });
      assert.deepEqual(errors, []); diagnostics.push({ name, width, requests, errors });
    } finally { await context.close(); }
  });
  await t.test('KST explicit offset across browser zones, month boundary and query controls', async () => {
    for (const timezoneId of ['America/Los_Angeles', 'Asia/Seoul', 'UTC']) {
      const { page, context, requests } = await open({ timezoneId });
      try {
        await archiveReady(page);
        await page.locator('#archive-from').fill('2026-09-30T23:50'); await page.locator('#archive-to').fill('2026-10-01T00:10');
        await page.locator('#archive-source').selectOption('npmplus'); await page.locator('#archive-q').fill('[a+b].*'); await page.locator('#archive-limit').fill('1000');
        await periodSearch(page); await archiveReady(page);
        assert.deepEqual(requests.at(-1), { source: 'npmplus', from: '2026-09-30T23:50:00+09:00', to: '2026-10-01T00:10:00+09:00', q: '[a+b].*', limit: '1000' });
      } finally { await context.close(); }
    }
  });
  await t.test('only retained allowlisted sources appear and keyboard submits the labeled controls', async () => {
    const { page, context, requests } = await open({ status: { enabled: true, sources: [statusData.sources[0], { source: 'dovecot', oldest: null, newest: null }, { ...statusData.sources[1], source: 'unknown' }] } });
    try {
      await archiveReady(page); await expect(page.locator('#archive-source option')).toHaveCount(1);
      await page.getByLabel('검색어 (주소·IP·문자열)', { exact: true }).focus(); await page.keyboard.type('keyboard@example.test');
      await page.keyboard.press('Tab'); await expect(page.locator('#archive-from')).toBeFocused();
      await page.getByLabel('요청당 조회 줄 수 (1~1,000)', { exact: true }).focus(); await page.keyboard.press('Enter');
      await archiveReady(page); assert.equal(requests.at(-1).q, 'keyboard@example.test');
    } finally { await context.close(); }
  });
  await t.test('quick ranges, validation, recent kinds/presets and queue keep existing paths', async () => {
    const { page, context, requests, errors } = await open();
    try {
      await archiveReady(page);
      for (const [label, hours] of [['최근 1시간', 1], ['최근 24시간', 24], ['최근 7일', 168]]) {
        await page.getByRole('button', { name: label, exact: true }).click(); await periodSearch(page); await archiveReady(page);
        const sent = requests.at(-1); assert.equal(Date.parse(sent.to) - Date.parse(sent.from), hours * 3600000);
      }
      await page.locator('#archive-from').fill('2026-10-22T09:00'); await periodSearch(page);
      await expect(page.getByRole('alert')).toContainText('시작 시각은'); assert.equal(requests.length, 4);
      await page.locator('#archive-from').fill('2026-01-01T09:00'); await periodSearch(page);
      await expect(page.getByRole('alert')).toContainText('최대 90일'); assert.equal(requests.length, 4);
      await page.getByRole('button', { name: '최근 로그', exact: true }).click();
      await expect(page.locator('#log-kind option')).toHaveCount(7); await expect(page.locator('#log-preset option')).toHaveCount(5);
      await expect(page.getByRole('region', { name: '로그 검색 결과', exact: true })).toContainText('최근 합성 로그');
      await expect(page.getByText('최근 최대 1,000줄 범위에서 검색합니다.', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: '메일 큐', exact: true }).click(); await expect(page.locator('tbody')).toContainText('SYNTHETIC1'); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('cursor appends; filter edits clear rows/cursor; canceled old responses cannot replace new results', async () => {
    let delayed;
    const { page, context, requests } = await open({ handler: (route, params, count) => {
      if (count === 3) { delayed = route; return; }
      return route.fulfill({ json: { ...complete, lines: [line(params.get('cursor') ? '두 번째 합성 로그' : '첫 번째 합성 로그')], cursor: count === 1 ? 'synthetic-cursor' : null, partialReason: count === 1 ? 'limit' : null } });
    } });
    try {
      await archiveReady(page);
      await expect(page.locator('tbody tr')).toHaveCount(2); assert.equal(requests[1].cursor, 'synthetic-cursor');
      await page.locator('#archive-q').fill('changed'); await expect(page.locator('tbody tr')).toHaveCount(0);
      await periodSearch(page); await expect.poll(() => requests.length).toBe(3);
      await page.locator('#archive-q').fill('new'); await periodSearch(page); await archiveReady(page);
      await delayed.fulfill({ json: { ...complete, lines: [line('오래된 응답')] } }).catch(() => {});
      await expect(page.locator('tbody')).not.toContainText('오래된 응답');
      assert.equal(requests[2].cursor, undefined); assert.equal(requests[3].q, 'new');
    } finally { await context.close(); }
  });
  for (const reason of ['limit', 'response_bytes', 'scan_bytes', 'timeout']) await t.test(`zero-match partial ${reason} advances to next cursor`, async () => {
    const { page, context, requests } = await open({ handler: (route, _params, count) => route.fulfill({ json: count === 1 ? { ...complete, lines: [], cursor: 'next-zero', partialReason: reason } : complete }) });
    try {
      await archiveReady(page); await expect(page.locator('tbody tr')).toHaveCount(1);
      await expect(page.getByRole('button', { name: /계속 검색|더 보기/ })).toHaveCount(0);
      await expect(page.getByText('전체 기간의 일치 건수를 뜻하지 않습니다.', { exact: false })).toHaveCount(0);
      assert.equal(requests.at(-1).cursor, 'next-zero');
    } finally { await context.close(); }
  });
  await t.test('progress shows the scanned time and cancel preserves rows while aborting continuation', async () => {
    let delayed;
    const { page, context, requests } = await open({ handler: (route, _params, count) => {
      if (count === 2) { delayed = route; return; }
      return route.fulfill({ json: { ...complete, cursor: 'cancel-cursor', partialReason: 'limit', scannedThrough: '2026-10-21T08:30:00Z' } });
    } });
    try {
      await expect(progress(page)).toContainText('검색 중 · 찾은 로그 1건 · 읽은 구간 50%');
      await expect(progress(page)).toContainText('17:30 (KST)');
      await expect.poll(() => requests.length).toBe(2);
      await page.getByRole('button', { name: '검색 취소' }).click();
      await expect(progress(page)).toContainText('검색 취소됨 · 찾은 로그 1건');
      await delayed.fulfill({ json: { ...complete, lines: [line('취소 이후 응답')] } }).catch(() => {});
      await expect(page.locator('tbody tr')).toHaveCount(1);
      await expect(page.locator('tbody')).not.toContainText('취소 이후 응답');
    } finally { await context.close(); }
  });
  await t.test('429 waits before retrying and timeout retries an unchanged cursor without duplicate rows', async () => {
    const received = [];
    const { page, context, requests } = await open({ handler: (route, params, count) => {
      received.push(performance.now());
      if (count === 2) return route.fulfill({ status: 429, json: { error: { code: 'LOG_QUERY_BUSY', retryAfter: 2, message: 'synthetic busy' } } });
      if (count === 3) return route.fulfill({ json: { ...complete, lines: [], cursor: params.get('cursor'), partialReason: 'timeout' } });
      return route.fulfill({ json: count === 1 ? { ...complete, cursor: 'retry-cursor', partialReason: 'timeout' } : { ...complete, lines: [line('마지막 합성 로그')] } });
    } });
    try {
      await expect(progress(page)).toContainText('다른 검색이 끝나기를 기다리는 중');
      await archiveReady(page); await expect(page.locator('tbody tr')).toHaveCount(2);
      assert.deepEqual(requests.map(request => request.cursor), [undefined, 'retry-cursor', 'retry-cursor', 'retry-cursor']);
      assert.ok(received[2] - received[1] >= 1900);
      await expect(progress(page)).toContainText('읽은 구간 100%');
    } finally { await context.close(); }
  });
  await t.test('an unchanged timeout cursor stops after five retries', async () => {
    const { page, context, requests } = await open({ handler: (route, _params, count) => route.fulfill({ json: { ...complete, lines: count === 1 ? complete.lines : [], cursor: 'stalled', partialReason: 'timeout' } }) });
    try {
      await expect(page.locator('[data-error-code=ARCHIVE_SEARCH_STALLED]')).toBeVisible();
      await expect(page.locator('tbody tr')).toHaveCount(1);
      assert.equal(requests.length, 6);
    } finally { await context.close(); }
  });
  await t.test('expired cursor offers a fresh search, upstream error retries without false empty success', async () => {
    let mode = 'restart';
    const { page, context, requests } = await open({ handler: (route, _params, count) => {
      if (count === 2) return route.fulfill({ status: 410, json: { error: { code: 'ARCHIVE_SEARCH_RESTART', message: 'synthetic expired' } } });
      if (mode === 'failed') return route.fulfill({ status: 502, json: { error: { code: 'ARCHIVE_UNAVAILABLE', message: 'synthetic unavailable' } } });
      return route.fulfill({ json: { ...complete, cursor: count === 1 ? 'expired-cursor' : null } });
    } });
    try {
      await expect(page.locator('[data-error-code=ARCHIVE_SEARCH_RESTART]')).toContainText('다시 검색');
      await page.getByRole('button', { name: '다시 검색', exact: true }).click(); await archiveReady(page); assert.equal(requests.at(-1).cursor, undefined);
      mode = 'failed'; await periodSearch(page); await expect(page.locator('[data-error-code=ARCHIVE_UNAVAILABLE]')).toBeVisible();
      await expect(page.getByText('일치하는 보관 로그가 없습니다.', { exact: true })).toHaveCount(0);
      mode = 'ok'; await page.getByRole('button', { name: '다시 읽기', exact: true }).click(); await archiveReady(page);
    } finally { await context.close(); }
  });
  await t.test('empty, precollection, retention and uncollected sources differ from successful zero matches', async () => {
    const { page, context } = await open({ response: { ...complete, lines: [], incomplete: true } });
    try {
      await archiveReady(page); await page.locator('#archive-from').fill('2026-10-19T12:00'); await periodSearch(page); await archiveReady(page);
      await expect(page.getByText('수집 전 구간을 포함하거나', { exact: false })).toBeVisible();
      await page.locator('#archive-source').selectOption('rspamd');
      await page.locator('#archive-from').fill('2026-10-13T12:00'); await page.locator('#archive-to').fill('2026-10-13T13:00');
      await periodSearch(page); await archiveReady(page);
      await expect(page.getByText('보관 만료 구간을 포함합니다.', { exact: false })).toBeVisible();
    } finally { await context.close(); }
    const empty = await open({ response: { ...complete, lines: [] } });
    try { await archiveReady(empty.page); await expect(empty.page.getByText('일치하는 보관 로그가 없습니다.', { exact: true })).toBeVisible(); } finally { await empty.context.close(); }
    const collecting = await open({ status: { enabled: true, sources: [{ source: 'postfix', oldest: null, newest: null }] } });
    try { await expect(collecting.page.getByText('아직 보관된 로그가 없습니다.', { exact: false })).toBeVisible(); assert.equal(collecting.requests.length, 0); } finally { await collecting.context.close(); }
  });
  await t.test('all 2,303 matches are displayed; stale status and runtime disabled retain recent logs', async () => {
    const matches = Array.from({ length: 2303 }, (_, index) => line(`합성 결과 ${index + 1}`));
    const { page, context, requests } = await open({ handler: (route, params) => {
      if (params.get('q') !== 'bulk') return route.fulfill({ json: complete });
      const offset = Number(params.get('cursor') ?? 0), limit = Number(params.get('limit'));
      const next = offset + limit < matches.length ? String(offset + limit) : null;
      return route.fulfill({ json: { ...complete, lines: matches.slice(offset, offset + limit), cursor: next, partialReason: next ? 'limit' : null } });
    } });
    try {
      await archiveReady(page);
      await page.getByRole('button', { name: '최근 7일', exact: true }).click();
      await page.locator('#archive-q').fill('bulk');
      await page.locator('#archive-limit').fill('750');
      await periodSearch(page);
      await expect(progress(page)).toContainText('검색 완료 · 찾은 로그 2,303건');
      await expect(page.locator('tbody tr')).toHaveCount(2303);
      assert.deepEqual(await page.locator('tbody tr > td:last-child').allTextContents(), matches.map(row => row.message));
      assert.deepEqual(requests.filter(request => request.q === 'bulk').map(request => request.cursor), [undefined, '750', '1500', '2250']);
    } finally { await context.close(); }
    for (const options of [{ response: { enabled: false } }, { statusCode: 502, status: { error: { code: 'ARCHIVE_STATUS_UNAVAILABLE', message: 'synthetic status failure' } } }]) {
      const view = await open(options);
      try { await expect(view.page.getByRole('region', { name: '로그 검색 결과', exact: true })).toContainText('최근 합성 로그'); await expect(view.page.locator('#archive-source')).toHaveCount(0); } finally { await view.context.close(); }
    }
  });
  await writeFile(`${captures}/browser-diagnostics.json`, `${JSON.stringify(diagnostics, null, 2)}\n`);
});
