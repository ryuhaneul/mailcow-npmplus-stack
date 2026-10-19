import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';

const captures = process.env.ADMIN_TRUSTED_CAPTURE_DIR || '/tmp/webmail-admin-trusted-captures';
await test('trusted admin list and fake API contract', async t => {
  const fake = createFakeAdminApi(), initial = structuredClone(fake.state);
  const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), logLevel: 'error', plugins: [{ name: 'trusted-admin-test-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  t.after(() => browser.close()); await mkdir(captures, { recursive: true });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const reset = () => Object.assign(fake.state, structuredClone(initial));
  async function open({ hash = 'trusted', width = 1280, mode = 'light', prepare = () => {} } = {}) {
    reset(); prepare(fake.state);
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: mode });
    await context.addInitScript(mode => localStorage.setItem('webmail-admin-prefs', JSON.stringify({ theme: 'ink', mode, accent: {} })), mode);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/admin.html#${hash}`);
    await expect(page.locator('[data-admin-page=trusted]')).toBeVisible();
    return { page, context, errors };
  }
  await t.test('list, selected detail, counts, range, no records and plus icon', async () => {
    const { page, context, errors } = await open();
    try {
      const detail = page.getByRole('region', { name: '신뢰 발신자 상세' });
      await expect(page.locator('h1')).toHaveText('신뢰 발신 장비');
      await expect(page.locator('.list-meta')).toHaveText('발신자 2개짝 7개');
      await expect(page.locator('.account-item')).toHaveCount(2);
      await expect(detail.locator('h2')).toHaveText('cdpmanager@example.com');
      await expect(detail.locator('tbody tr')).toHaveCount(6);
      await expect(detail.locator('.ts-range')).toHaveText('최근 로그 기준: 10월 19일 월요일 · 09:12 ~ 12:58 (약 4시간) · 1,840줄');
      await expect(detail.locator('dl')).toContainText('264통 · 마지막 10월 19일 월요일 · 12:52');
      await expect(detail.locator('tr').filter({ hasText: '192.0.2.7' })).toContainText('기록 없음');
      await expect(detail.locator('tr').filter({ hasText: '192.0.2.7' })).toContainText('범위 안 기록 없음');
      await expect(detail.locator('dl')).not.toContainText('추가한 사람');
      await expect(page.locator('#admin-i-plus path')).toHaveAttribute('d', 'M12 5v14M5 12h14');
      await expect(page.getByRole('button', { name: '발신자 추가' }).locator('use')).toHaveAttribute('href', '#admin-i-plus');
      const nav = await page.locator('#nav a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
      assert.equal(nav.indexOf('#trusted'), nav.indexOf('#relay') + 1);
      await expect(page.locator('#nav a[href="#trusted"] use')).toHaveAttribute('href', '#admin-i-shield');
      await page.locator('.account-item').filter({ hasText: 'alert@example.net' }).click();
      await expect(detail.locator('h2')).toHaveText('alert@example.net');
      await expect(detail.locator('dl')).toContainText('없음');
      await expect(detail).toContainText('이 발신자는 IP 가 하나뿐이에요.');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('empty list has a helpful empty state', async () => {
    const { page, context } = await open({ prepare: state => { state.trusted.senders = []; } });
    try { await expect(page.locator('.ts-empty')).toContainText('신뢰 발신 장비가 없어요.'); await expect(page.locator('.account-split')).toHaveCount(0); }
    finally { await context.close(); }
  });
  for (const transportError of [false, true]) await t.test(`recent failure stays distinct from zero; transport error ${transportError}`, async () => {
    const { page, context } = await open({ hash: 'trusted/cdpmanager%40example.com', prepare: state => { state.trusted.recent = { range: null, failed: true, counts: {} }; } });
    try {
      if (transportError) { await page.route('**/api/admin/trusted/recent', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'READ_FAILED', message: '합성 로그 오류' } }) })); await page.reload(); }
      await expect(page.locator('.account-detail')).toContainText('최근 로그를 읽지 못했어요.');
      await expect(page.locator('.account-detail tbody')).toContainText('확인 불가');
      await expect(page.locator('.account-detail')).not.toContainText('기록 없음');
      await expect(page.locator('.list-pane')).toContainText('최근 로그 확인 불가');
    } finally { await context.close(); }
  });
  await t.test('no log range is a successful empty observation', async () => {
    const { page, context } = await open({ prepare: state => { state.trusted.recent = { range: null, failed: false, counts: {} }; } });
    try { await expect(page.locator('.ts-range')).toContainText('조회 범위 안에 기록이 없어요.'); await expect(page.locator('.account-detail dl')).toContainText('기록 없음'); }
    finally { await context.close(); }
  });
  await t.test('epoch seconds from server logs keep KST range and latest time', async () => {
    const { page, context } = await open({ prepare: state => {
      state.trusted.recent.range.from = Date.parse(state.trusted.recent.range.from) / 1000;
      state.trusted.recent.range.to = Date.parse(state.trusted.recent.range.to) / 1000;
      Object.values(state.trusted.recent.counts).forEach(value => { value.lastSeen = Date.parse(value.lastSeen) / 1000; });
    } });
    try { await expect(page.locator('.ts-range')).toHaveText('최근 로그 기준: 10월 19일 월요일 · 09:12 ~ 12:58 (약 4시간) · 1,840줄'); await expect(page.locator('.account-detail dl')).toContainText('264통 · 마지막 10월 19일 월요일 · 12:52'); }
    finally { await context.close(); }
  });
  await t.test('feature off hides menu, page and all trusted APIs', async () => {
    reset(); fake.state.features.trusted = false;
    const context = await browser.newContext(), page = await context.newPage();
    try {
      await page.goto(`${origin}/admin.html#trusted/cdpmanager%40example.com`);
      await expect(page.locator('[data-admin-page=home]')).toBeVisible();
      await expect(page.locator('#nav a[href="#trusted"]')).toHaveCount(0);
      await expect(page.locator('[data-admin-page=trusted]')).toHaveCount(0);
      await page.evaluate(() => { location.hash = 'flow/trusted/add'; }); await expect(page.locator('[data-admin-page=home]')).toBeVisible(); await expect(page.locator('[data-admin-page=flow-trusted]')).toHaveCount(0);
      assert.equal((await fetch(`${origin}/api/admin/trusted`)).status, 404);
    } finally { await context.close(); }
  });
  for (const width of [1280, 768, 390, 375]) for (const mode of ['light', 'dark']) await t.test(`list/detail ${width} ${mode} has no overflow and keyboard selection`, async () => {
    const { page, context, errors } = await open({ width, mode });
    try {
      await expect(page.locator('.account-item').first()).toContainText('최근 로그 264통');
      assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth), 0);
      const link = page.locator('.account-item').first(); await link.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('.account-detail')).toBeVisible();
      await expect(page.locator('.account-detail h2')).toHaveText('cdpmanager@example.com');
      assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth), 0);
      assert.equal(await page.locator('.ts-table').evaluate(node => node.scrollWidth - node.clientWidth), 0);
      const action = await page.locator('.ts-table tbody tr').first().locator('button').boundingBox(), table = await page.locator('.ts-table').boundingBox();
      assert.ok(action.x >= table.x && action.x + action.width <= table.x + table.width, 'IP action remains inside the table');
      await page.screenshot({ path: `${captures}/trusted-${width}-${mode}.png`, fullPage: true });
      if (width < 700) { await page.getByRole('link', { name: '← 목록으로', exact: true }).click(); await expect(page.locator('.list-pane')).toBeVisible(); }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  async function start(mode = 'add', options = {}) {
    const view = await open({ hash: `trusted/${encodeURIComponent(options.sender || 'cdpmanager@example.com')}`, ...options });
    const { page } = view;
    if (mode === 'add') await page.getByRole('button', { name: '발신자 추가', exact: true }).click();
    else if (mode === 'addIp') await page.getByRole('button', { name: 'IP 추가', exact: true }).click();
    else if (mode === 'memo') await page.getByRole('button', { name: '수정', exact: true }).click();
    else if (mode === 'removeSender') await page.getByRole('button', { name: '이 발신자 빼기', exact: true }).click();
    else await page.locator('.ts-table tbody tr').filter({ hasText: options.ip || '198.51.100.11' }).getByRole('button', { name: '빼기', exact: true }).click();
    await expect(page.locator('[data-admin-page=flow-trusted]')).toBeVisible();
    await expect(page.getByRole('button', { name: '변경 미리보기', exact: true })).toBeEnabled();
    return view;
  }
  const mutationRequests = () => fake.state.requests.filter(row => row.path.startsWith('/api/admin/trusted/senders') && row.method !== 'GET');
  async function draft(page, { sender = 'backup@example.com', ips = '203.0.113.50\n2001:0DB8::25', memo = '본사 NAS 백업 알림' } = {}) {
    await page.locator('#ts-sender').fill(sender); await page.locator('#ts-ips').fill(ips); await page.locator('#ts-memo').fill(memo);
  }
  async function preview(page) {
    await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    await expect(page.locator('.ac-current')).toHaveText('02미리보기');
    await expect(page.locator('h2')).toBeFocused();
  }
  async function confirm(page) {
    await page.getByRole('button', { name: '실행 확인으로', exact: true }).click();
    await expect(page.getByRole('heading', { name: '실행 전 마지막 확인', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: '실행하기', exact: true })).toBeDisabled();
  }
  async function execute(page) {
    await page.locator('#ts-ack').check(); await page.getByRole('button', { name: '실행하기', exact: true }).click();
    await expect(page.locator('.ac-result h2')).toBeFocused();
    await expect(page.locator('.ac-current')).toHaveText('04결과');
  }
  await t.test('add sender: four stages, Space focus, readback, audit link, etag and exactly one null-free request', async () => {
    const { page, context, errors } = await start(); const bodies = [];
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/admin/trusted/senders') bodies.push({ body: request.postDataJSON(), headers: request.headers() }); });
    try {
      await expect(page.getByRole('heading', { name: '신뢰할 발신자와 IP', exact: true })).toBeFocused();
      await draft(page, { sender: 'BACKUP@EXAMPLE.COM' }); await preview(page);
      await expect(page.locator('.ac-diff')).toContainText('backup@example.com 새로 더하기'); await expect(page.locator('.ac-diff')).toContainText('2001:db8::25'); assert.equal(mutationRequests().length, 0);
      await confirm(page); const checkbox = page.locator('#ts-ack'), run = page.getByRole('button', { name: '실행하기', exact: true });
      await checkbox.focus(); await page.keyboard.press('Space'); await expect(checkbox).toBeChecked(); await expect(checkbox).toBeFocused(); await expect(run).toBeEnabled();
      await page.keyboard.press('Space'); await expect(checkbox).not.toBeChecked(); await expect(checkbox).toBeFocused(); await expect(run).toBeDisabled();
      await page.keyboard.press('Space'); await expect(checkbox).toBeChecked(); await expect(checkbox).toBeFocused();
      await page.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      await expect(page.locator('.ac-result h2')).toHaveText('발신자 추가 완료'); await expect(page.locator('.ac-result h2')).toBeFocused(); await expect(page.locator('.ac-result')).toContainText('저장한 목록을 다시 읽어 변경 내용과 일치함을 확인했어요.');
      assert.equal(mutationRequests().length, 1); assert.equal(bodies.length, 1); assert.equal(JSON.stringify(bodies[0].body).includes('null'), false);
      assert.deepEqual(bodies[0].body, { etag: 'trusted-1', sender: 'backup@example.com', memo: '본사 NAS 백업 알림', ips: ['203.0.113.50', '2001:db8::25'] });
      assert.equal(bodies[0].headers['x-mailadmin-csrf'], 'synthetic-admin-csrf'); assert.equal(bodies[0].headers.authorization, undefined);
      const audit = fake.state.history.find(row => row.action === 'trusted.add-sender'); await expect(page.locator('.ac-result')).toContainText('변경 기록에서 되돌릴 수 있습니다.'); await expect(page.locator('.ac-result').getByRole('link', { name: '변경 기록', exact: true })).toHaveAttribute('href', `#history/${audit.id}`);
      await page.getByRole('link', { name: '신뢰 발신 장비 보기', exact: true }).click(); await expect(page.locator('.list-pane')).toContainText('backup@example.com'); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('input errors match approved copy, stay in input and never mutate', async () => {
    const { page, context } = await start();
    try {
      const cases = [
        [{ sender: '' }, 'INVALID_SENDER', '발신자 주소를 넣어 주세요.'],
        [{ sender: 'bad address' }, 'INVALID_SENDER', '메일 주소 형식이 아니에요. 예: alert@example.com'],
        [{ sender: 'cdpmanager@example.com' }, 'EXISTS', '이미 등록된 발신자예요.'],
        [{ ips: '' }, 'INVALID_IP', 'IP 를 한 줄에 하나씩 넣어 주세요.'],
        [{ ips: '198.51.100.0/24' }, 'CIDR_NOT_ALLOWED', '대역은 넣을 수 없어요. IP 를 하나씩 넣어 주세요.'],
        [{ ips: '203.0.113.300' }, 'INVALID_IP', 'IPv4 또는 IPv6 주소 한 개를 넣어 주세요.'],
        [{ ips: Array.from({ length: 51 }, (_, i) => `192.0.2.${i + 1}`).join('\n') }, 'TOO_MANY_IPS', '한 번에 50개까지 넣을 수 있어요. (지금 51개)'],
        [{ ips: '192.0.2.5\n192.0.2.5' }, 'DUPLICATE_IP', '같은 IP 를 두 번 넣었어요.'],
        [{ ips: '2001:0db8::25\n2001:db8::25' }, 'DUPLICATE_IP', '같은 IP 를 두 번 넣었어요.'],
        [{ memo: '가'.repeat(81) }, 'MEMO_TOO_LONG', '용도는 80자까지 넣을 수 있어요. (지금 81자)'],
        [{ memo: '제어\t문자' }, 'MEMO_INVALID', '용도에 줄바꿈이나 제어 문자를 넣을 수 없어요.'],
        [{ memo: '업무\u2028백업\u2029메모' }, 'MEMO_INVALID', '용도에 줄바꿈이나 제어 문자를 넣을 수 없어요.'],
      ];
      for (const [value, code, message] of cases) {
        await draft(page, value); await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
        await expect(page.locator(`[data-error-code="${code}"]`).first()).toContainText(message); await expect(page.locator('.ac-current')).toHaveText('01입력');
      }
      assert.equal(mutationRequests().length, 0);
    } finally { await context.close(); }
  });
  await t.test('50 IPs and 80 Unicode characters are accepted; blank optional memo is omitted', async () => {
    const { page, context } = await start(); let body;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/admin/trusted/senders')) body = request.postDataJSON(); });
    try {
      await draft(page, { ips: Array.from({ length: 50 }, (_, i) => `192.0.2.${i + 1}`).join('\n'), memo: '😀'.repeat(80) }); await preview(page); await expect(page.locator('.ac-diff')).toContainText('더하기 (50개)');
      await page.getByRole('button', { name: '이전', exact: true }).click(); await expect(page.locator('h2')).toBeFocused(); await page.locator('#ts-memo').fill(''); await preview(page); await confirm(page); await execute(page);
      assert.equal(body.ips.length, 50); assert.equal(Object.hasOwn(body, 'memo'), false); assert.equal(fake.state.trusted.senders.find(row => row.sender === 'backup@example.com').memo, '');
    } finally { await context.close(); }
  });
  await t.test('add IP uses fixed sender, rejects an existing pair and preserves memo', async () => {
    const { page, context } = await start('addIp'); let body;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/ips')) body = request.postDataJSON(); });
    try {
      await expect(page.locator('#ts-sender')).toHaveAttribute('readonly', ''); await page.locator('#ts-ips').fill('198.51.100.11'); await page.getByRole('button', { name: '변경 미리보기', exact: true }).click(); await expect(page.locator('[data-error-code=DUPLICATE_PAIR]')).toHaveText('198.51.100.11 이미 있는 짝이에요.');
      await page.locator('#ts-ips').fill('192.0.2.99\n2001:db8::25'); await preview(page); await confirm(page); await execute(page);
      assert.deepEqual(body, { etag: 'trusted-1', ips: ['192.0.2.99', '2001:db8::25'] }); const row = fake.state.trusted.senders.find(row => row.sender === 'cdpmanager@example.com'); assert.equal(row.ips.length, 8); assert.equal(row.memo, '고객사 CDP 백업 리포트');
    } finally { await context.close(); }
  });
  for (const last of [false, true]) await t.test(`remove IP; last IP ${last}`, async () => {
    const sender = last ? 'alert@example.net' : 'cdpmanager@example.com', ip = last ? '203.0.113.99' : '198.51.100.11';
    const { page, context } = await start('remove', { sender, ip, prepare: state => { if (last) state.trusted.senders.find(row => row.sender === sender).memo = '합성 단일 장비'; } }); let body;
    page.on('request', request => { if (request.method() === 'DELETE' && request.url().includes('/ips/')) body = request.postDataJSON(); });
    try {
      await expect(page.locator('.ts-range')).toContainText('최근 로그 기준:'); await expect(page.locator('dl')).toContainText(last ? '23통' : '118통');
      if (last) await expect(page.locator('fieldset')).toContainText('이 발신자의 마지막 IP 예요.');
      await preview(page); if (last) { await expect(page.locator('fieldset')).toContainText('용도 메모도 함께 지워져요.'); await expect(page.locator('.ac-diff')).toContainText('합성 단일 장비'); }
      await confirm(page); await expect(page.getByRole('button', { name: '실행하기', exact: true })).toHaveClass('btn dan'); await execute(page); assert.deepEqual(body, { etag: 'trusted-1' });
      const row = fake.state.trusted.senders.find(row => row.sender === sender); if (last) assert.equal(row, undefined); else { assert.equal(row.ips.length, 5); assert.equal(row.memo, '고객사 CDP 백업 리포트'); }
    } finally { await context.close(); }
  });
  await t.test('remove sender previews every IP and blocks submit before acknowledgement', async () => {
    const { page, context } = await start('removeSender');
    try {
      await expect(page.locator('fieldset')).toContainText('IP 6개가 전부 빠지고 발신자도 목록에서 사라져요.'); await preview(page); await expect(page.locator('.ac-diff .ts-out')).toHaveCount(6); await expect(page.locator('fieldset')).toContainText('용도 메모도 함께 지워져요.'); await page.screenshot({ path: `${captures}/trusted-remove-sender-preview-1280.png`, fullPage: true });
      await confirm(page); await expect(page.locator('.checkline')).toHaveText('이 발신자의 IP 6개가 전부 빠지는 것을 확인했어요.');
      await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); assert.equal(mutationRequests().length, 0);
      const checkbox = page.locator('#ts-ack'); await checkbox.focus(); await page.keyboard.press('Space'); await expect(checkbox).toBeFocused(); await expect(checkbox).toBeChecked();
      await page.getByRole('button', { name: '이전', exact: true }).click(); await expect(page.locator('h2')).toBeFocused(); await confirm(page); await execute(page);
      assert.ok(!fake.state.trusted.senders.some(row => row.sender === 'cdpmanager@example.com')); assert.equal(fake.state.history[0].action, 'trusted.remove-sender');
    } finally { await context.close(); }
  });
  for (const memo of ['합성 장비 용도 변경', '']) await t.test(`memo-only change ${memo ? 'updates' : 'clears'} note and keeps all pairs`, async () => {
    const { page, context } = await start('memo'); let body;
    page.on('request', request => { if (request.method() === 'PATCH') body = request.postDataJSON(); });
    try {
      await expect(page.locator('#ts-memo')).toHaveValue('고객사 CDP 백업 리포트'); const before = structuredClone(fake.state.trusted.senders.find(row => row.sender === 'cdpmanager@example.com').ips); await page.locator('#ts-memo').fill(memo); await preview(page); await expect(page.locator('.ac-diff tbody tr')).toHaveCount(3); await expect(page.locator('fieldset')).toContainText('메모만 바뀌어요. 신뢰 짝과 스팸 점수는 그대로예요.'); await confirm(page); await execute(page);
      assert.deepEqual(body, { etag: 'trusted-1', memo }); const row = fake.state.trusted.senders.find(row => row.sender === 'cdpmanager@example.com'); assert.equal(row.memo, memo); assert.deepEqual([...row.ips].sort(), before.sort());
    } finally { await context.close(); }
  });
  await t.test('409 conflict stops mutation, reread resets preview and uses fresh etag', async () => {
    const { page, context } = await start();
    try {
      await draft(page); await preview(page); await confirm(page); fake.state.trusted.version++;
      await page.locator('#ts-ack').check(); await page.getByRole('button', { name: '실행하기', exact: true }).click(); await expect(page.locator('[data-error-code=CONFLICT]')).toHaveText('다른 곳에서 목록이 바뀌었어요. 다시 읽고 확인해 주세요.'); await expect(page.getByRole('button', { name: '실행하기', exact: true })).toBeDisabled(); assert.ok(!fake.state.trusted.senders.some(row => row.sender === 'backup@example.com'));
      await page.getByRole('button', { name: '다시 읽기', exact: true }).click(); await expect(page.getByRole('button', { name: '변경 미리보기', exact: true })).toBeEnabled(); await preview(page); await confirm(page); await execute(page); assert.equal(fake.state.trusted.version, 3);
    } finally { await context.close(); }
  });
  for (const [code, status, detail, message] of [
    ['INVALID_INPUT', 422, { code: 'DUPLICATE_PAIR' }, '이미 있는 짝이에요.'],
    ['EXISTS', 409, undefined, '이미 등록된 발신자예요.'],
    ['NOT_FOUND', 404, undefined, '발신자 또는 IP 가 목록에 없어요.'],
    ['TRUSTED_FILE_INVALID', 409, undefined, '파일 형식이 올바르지 않아 바꿀 수 없어요.'],
    ['WRITE_FAILED', 502, undefined, '기존 목록은 그대로예요.'],
  ]) await t.test(`server ${code} maps to an actionable message without changing data`, async () => {
    const { page, context } = await start();
    try {
      const before = structuredClone(fake.state.trusted.senders); await draft(page); await preview(page); await confirm(page);
      await page.route('**/api/admin/trusted/senders', route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, message: '합성 서버 오류', ...(detail ? { detail } : {}) } }) }));
      await page.locator('#ts-ack').check(); await page.getByRole('button', { name: '실행하기', exact: true }).click(); await expect(page.locator(`[data-error-code="${code}"]`)).toContainText(message); assert.deepEqual(fake.state.trusted.senders, before); await expect(page.locator('.ac-result')).toHaveCount(0);
      if (code === 'INVALID_INPUT' || code === 'EXISTS') await expect(page.locator('.ac-current')).toHaveText('01입력');
      else await expect(page.getByRole('button', { name: '실행하기', exact: true })).toBeDisabled();
    } finally { await context.close(); }
  });
  await t.test('failed readback after successful save shows result with no mutation retry', async () => {
    const { page, context } = await start();
    try {
      await draft(page); await preview(page); await confirm(page);
      await page.route('**/api/admin/trusted', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'READ_FAILED', message: '합성 재조회 실패' } }) }));
      await execute(page); await expect(page.locator('.ac-result')).toContainText('목록 저장은 완료됐어요.'); await expect(page.locator('.ac-result')).toContainText('저장 뒤 목록을 다시 확인하지 못했어요.'); await expect(page.locator('.ac-result')).not.toContainText('일치함을 확인했어요.'); assert.equal(mutationRequests().length, 1); assert.ok(fake.state.trusted.senders.some(row => row.sender === 'backup@example.com'));
    } finally { await context.close(); }
  });
  for (const width of [1280, 768, 390, 375]) for (const mode of ['light', 'dark']) await t.test(`flow preview ${width} ${mode} has no document/table overflow and keeps focus`, async () => {
    const { page, context, errors } = await start('add', { width, mode });
    try {
      await draft(page); await preview(page);
      assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth), 0); assert.equal(await page.locator('.ac-diff').evaluate(node => node.parentNode.scrollWidth - node.parentNode.clientWidth), 0);
      await page.screenshot({ path: `${captures}/trusted-flow-${width}-${mode}.png`, fullPage: true }); await confirm(page); const checkbox = page.locator('#ts-ack'); await checkbox.focus(); await page.keyboard.press('Space'); await expect(checkbox).toBeFocused(); await expect(checkbox).toBeChecked(); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('fake seven APIs enforce validation, etag, session/CSRF and save full audit snapshots', async () => {
    reset();
    const call = async (path, method = 'GET', body, csrf = 'synthetic-admin-csrf') => {
      const response = await fetch(`${origin}/api/admin/trusted${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Mailadmin-CSRF': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json(), headers: response.headers };
    };
    const get = await call(''); assert.deepEqual(Object.keys(get.value).sort(), ['etag', 'pairs', 'senders']); assert.equal(get.value.pairs, 7);
    const recent = await call('/recent'); assert.deepEqual(Object.keys(recent.value).sort(), ['counts', 'failed', 'range']); assert.deepEqual(Object.keys(recent.value.range).sort(), ['from', 'lines', 'to']);
    let etag = get.value.etag;
    const bad = async (body, code) => { const result = await call('/senders', 'POST', { sender: 'new@example.com', ips: ['192.0.2.60'], etag, ...body }); assert.equal(result.status, 422); assert.equal(result.value.error.code, 'INVALID_INPUT'); assert.equal(result.value.error.detail.code, code); };
    await bad({ sender: 'not an address' }, 'INVALID_SENDER');
    await bad({ sender: 123 }, 'INVALID_SENDER');
    await bad({ ips: ['198.51.100.0/24'] }, 'CIDR_NOT_ALLOWED');
    await bad({ ips: ['203.0.113.300'] }, 'INVALID_IP');
    await bad({ ips: ['192.0.2.01'] }, 'INVALID_IP');
    await bad({ ips: ['2001:0db8::25', '2001:db8::25'] }, 'DUPLICATE_IP');
    await bad({ ips: Array.from({ length: 51 }, (_, i) => `192.0.2.${i + 1}`) }, 'TOO_MANY_IPS');
    await bad({ memo: '가'.repeat(81) }, 'MEMO_TOO_LONG');
    await bad({ memo: '줄\n바꿈' }, 'MEMO_INVALID');
    const addBody = { sender: 'NEW@EXAMPLE.COM', ips: ['2001:0DB8:0:0::25', '192.0.2.60'], memo: '합성 장비', etag };
    assert.equal((await call('/senders', 'POST', addBody, '')).status, 403);
    assert.equal((await call('/senders', 'POST', { ...addBody, etag: 'outdated' })).value.error.code, 'CONFLICT');
    const added = await call('/senders', 'POST', addBody); assert.equal(added.status, 200); assert.deepEqual(Object.keys(added.value).sort(), ['auditId', 'etag', 'result']); etag = added.value.etag;
    assert.deepEqual(fake.state.trusted.senders.find(row => row.sender === 'new@example.com'), { sender: 'new@example.com', memo: '합성 장비', ips: ['192.0.2.60', '2001:db8::25'] });
    assert.equal((await call('/senders', 'POST', { ...addBody, etag })).value.error.code, 'EXISTS');
    const sender = '/senders/new%40example.com';
    assert.equal((await call(`${sender}/ips`, 'POST', { ips: ['192.0.2.60'], etag })).value.error.detail.code, 'DUPLICATE_PAIR');
    const ips = await call(`${sender}/ips`, 'POST', { ips: ['192.0.2.61'], etag }); assert.equal(ips.status, 200); etag = ips.value.etag;
    const memo = await call(sender, 'PATCH', { memo: '', etag }); assert.equal(memo.status, 200); etag = memo.value.etag;
    const removeIp = await call(`${sender}/ips/192.0.2.61`, 'DELETE', { etag }); assert.equal(removeIp.status, 200); etag = removeIp.value.etag;
    fake.state.trusted.writeError = { status: 502, code: 'WRITE_FAILED', message: '합성 저장 실패' };
    const before = structuredClone(fake.state.trusted.senders);
    assert.equal((await call(sender, 'DELETE', { etag })).value.error.code, 'WRITE_FAILED'); assert.deepEqual(fake.state.trusted.senders, before); fake.state.trusted.writeError = null;
    const removed = await call(sender, 'DELETE', { etag }); assert.equal(removed.status, 200); etag = removed.value.etag;
    assert.ok(!fake.state.trusted.senders.some(row => row.sender === 'new@example.com'));
    const last = await call('/senders/alert%40example.net/ips/203.0.113.99', 'DELETE', { etag }); assert.equal(last.status, 200);
    assert.ok(!fake.state.trusted.senders.some(row => row.sender === 'alert@example.net'));
    const audit = fake.state.history.find(row => row.id === last.value.auditId); assert.equal(audit.action, 'trusted.remove-ip'); assert.equal(audit.kind, 'config'); assert.equal(audit.before.version, 1); assert.equal(audit.after.version, 1); assert.equal(audit.summary, '신뢰 발신 장비를 바꿨어요');
    const revert = await fetch(`${origin}/api/admin/history/${audit.id}/revert`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mailadmin-CSRF': 'synthetic-admin-csrf' }, body: '{}' }); assert.equal(revert.status, 200); assert.ok(fake.state.trusted.senders.some(row => row.sender === 'alert@example.net'));
    fake.state.trusted.readError = { status: 409, code: 'TRUSTED_FILE_INVALID', message: '합성 형식 오류' }; assert.equal((await call('')).value.error.code, 'TRUSTED_FILE_INVALID'); fake.state.trusted.readError = null;
    fake.state.session = null; const forbidden = await call(''); assert.equal(forbidden.status, 403); assert.equal(forbidden.headers.get('WWW-Authenticate'), null);
  });
});
