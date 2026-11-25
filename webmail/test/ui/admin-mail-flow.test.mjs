import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createAccountsService } from '../../server/admin/services/accounts.js';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';

const address = local => `${local}@example.com`;
const sales = address('sales'), tax = address('taxhost3'), member = address('member');
const members = Array.from({ length: 11 }, (_, index) => address(`member-${String(index + 1).padStart(2, '0')}`));
const boxes = [sales, tax, member, address('tax'), address('rose'), address('accounting'), ...members]
  .map(username => ({ username, name: username === sales ? '영업팀' : username === tax ? '세금계산서 수신' : username, quota: 20 * 1024 ** 3, active: 1 }));
const alias = (local, goto, private_comment) => ({ address: address(local), goto, active: 1, private_comment });
const aliases = [
  alias('globalsales', `${sales},${member}`),
  alias('sales-members', members.join(','), 'mailadmin:team-members'),
  ...Array.from({ length: 11 }, (_, index) => alias(`sales-route-${String(index + 1).padStart(2, '0')}`, sales)),
  alias('very-long-sales-alias-that-must-wrap-on-mobile', sales),
];
const filter = (id, username, script_data, filter_type = 'postfilter') => ({ id, username, script_data, filter_type, active: 1 });
const filters = [
  filter(1, tax, 'redirect "tax@example.com"; redirect "globalsales@example.com"; redirect :copy "outside@remote.example.com";'),
  filter(2, address('tax'), 'redirect :copy "accounting@example.com";', 'prefilter'),
  filter(3, sales, 'redirect :copy "sales-members@example.com";', 'prefilter'),
  filter(4, sales, 'redirect :copy "rose@example.com";'),
  filter(5, address('rose'), 'redirect :copy "sales@example.com";'),
  filter(6, address('rose'), 'redirect "${dynamic}";'),
];
const datasets = { 'mailbox/all': boxes, 'alias/all': aliases, 'filters/all': filters, 'domain/all': [{ domain_name: 'example.com', active: 1 }], 'alias-domain/all': [] };
const service = createAccountsService({
  mailcow: { async call(_session, method, path) {
    assert.equal(method, 'GET');
    return datasets[path.slice('/api/v1/get/'.length)];
  } },
  history: { register() {} },
});
const fake = createFakeAdminApi();
const example = fake.state.accounts.items[0];
fake.state.accounts.items = boxes.map(box => ({ ...example, address: box.username, name: box.name, kind: box.username === sales ? 'team' : 'personal' }));

async function api(request, response, next) {
  const url = new URL(request.url, 'http://example.com');
  const match = url.pathname.match(/^\/api\/admin\/mailboxes\/([^/]+)\/flow$/);
  if (url.pathname !== '/api/admin/mailboxes' && !match) return fake.middleware(request, response, next);
  const data = match ? await service.flow({}, decodeURIComponent(match[1])) : await service.list({}, Object.fromEntries(url.searchParams));
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(data));
}

async function geometry(page) {
  return page.evaluate(() => {
    const rects = [...document.querySelectorAll('.mail-flow-card')].map(card => card.getBoundingClientRect());
    const overlaps = rects.flatMap((a, i) => rects.slice(i + 1).filter(b =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
    const outside = [...document.querySelectorAll('.mail-flow-card :is(.chip,.mail-flow-address,.mail-flow-members,.mail-flow-relative)')].filter(element => {
      const card = element.closest('.mail-flow-card').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...element.getClientRects(), ...range.getClientRects()].some(rect =>
        rect.left < card.left - 1 || rect.right > card.right + 1 || rect.top < card.top - 1 || rect.bottom > card.bottom + 1);
    });
    const container = document.querySelector('.mail-flow-chart');
    return {
      page: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      chart: Math.max(0, container.scrollWidth - container.clientWidth),
      outside: outside.map(element => element.textContent), overlaps: overlaps.length,
    };
  });
}

async function contrast(page) {
  return page.evaluate(() => {
    const luminance = color => {
      const rgb = color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(value => {
        const channel = Number(value) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const branch = document.querySelector('.mail-flow-branch');
    const wire = luminance(getComputedStyle(branch, '::before').borderTopColor);
    const backgrounds = ['.main', '.mail-flow-center'].map(selector => luminance(getComputedStyle(document.querySelector(selector)).backgroundColor));
    return backgrounds.map(background => (Math.max(wire, background) + 0.05) / (Math.min(wire, background) + 0.05));
  });
}

await test('account mail flow uses the production graph and renders the approved responsive layout', async t => {
  const server = await createServer({
    root: fileURLToPath(new URL('../../web', import.meta.url)),
    configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)),
    logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'mail-flow-test', configureServer(vite) { vite.middlewares.use(api); } }],
  });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({
    headless: true, args: ['--no-sandbox'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}/admin.html`;
  async function open(t, account, width, mode = 'light') {
    const context = await browser.newContext({ viewport: { width, height: 1050 }, colorScheme: mode });
    t.after(() => context.close());
    await context.addInitScript(value => localStorage.setItem('webmail-admin-prefs', JSON.stringify({ theme: 'ink', mode: value, accent: {} })), mode);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(`${origin}#accounts${account ? `/${encodeURIComponent(account)}` : ''}`);
    if (account) await expect(page.locator('.mail-flow-chart')).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    return page;
  }

  for (const width of [390, 768, 1024, 1440]) await t.test(`sales at ${width}px`, async t => {
    const page = await open(t, sales, width);
    assert.deepEqual(await geometry(page), { page: 0, chart: 0, outside: [], overlaps: 0 });
    const flow = page.getByRole('region', { name: '메일 흐름' });
    await expect(flow.locator('.mail-flow-side.is-out .mail-flow-card.is-cycle')).toContainText('순환 · 여기서 멈춤');
    await expect(flow.locator('.mail-flow-card.is-cycle + .mail-flow-branches')).toHaveCount(0);
    await expect(flow.locator('.mail-flow-card.is-group')).toContainText('구성원 11명');
    await expect(flow.getByText('필터 #6 를 해석하지 못해 이 필터의 전달은 빠졌어요.', { exact: true }).first()).toBeVisible();
    await expect(flow.getByRole('link', { name: '별칭에서 보기' })).toHaveAttribute('href', '#aliases');
    await expect(flow.getByRole('link', { name: '팀에서 보기' })).toHaveAttribute('href', '#teams');
    await expect(flow.getByRole('link', { name: '필터에서 보기' })).toHaveAttribute('href', '#filters');
    const more = flow.getByRole('button', { name: /나머지 \d+개 펼치기/ });
    await expect(more).toHaveCount(1);
    await expect(flow.locator('.mail-flow-side.is-in [title="very-long-sales-alias-that-must-wrap-on-mobile@example.com"]')).toHaveCount(0);
    await more.click();
    await expect(flow.locator('.mail-flow-side.is-in [title="very-long-sales-alias-that-must-wrap-on-mobile@example.com"]')).toBeVisible();
    assert.deepEqual(await geometry(page), { page: 0, chart: 0, outside: [], overlaps: 0 });
  });

  for (const mode of ['light', 'dark']) for (const width of [390, 1440]) await t.test(`taxhost3 ${mode} at ${width}px`, async t => {
    const page = await open(t, tax, width, mode);
    const chart = page.locator('.mail-flow-chart');
    await expect(chart).toHaveCSS('display', width === 1440 ? 'grid' : 'block');
    await expect(chart).toContainText('끝 메일함 14');
    assert.equal(await chart.locator('.mail-flow-card.is-cycle').evaluate(card => getComputedStyle(card, '::after').content), 'none');
    await expect(page.getByText('보관 안 함 · 관리자 필터가 원본을 tax@example.com 로 이동 외 1곳')).toBeVisible();
    await expect(chart.getByText('outside@remote.example.com', { exact: true })).toBeVisible();
    assert.deepEqual(await geometry(page), { page: 0, chart: 0, outside: [], overlaps: 0 });
    const ratios = await contrast(page);
    t.diagnostic(`connector contrast ${ratios.map(value => value.toFixed(2)).join(' / ')}`);
    assert.ok(ratios.every(value => value >= 3), `ratios: ${ratios}`);
  });

  await t.test('alias search shows the complete address, highlights the query and preserves navigation', async t => {
    const page = await open(t, null, 390);
    await page.getByLabel('메일함 이름 또는 주소 검색').fill('GlobalSales');
    await expect(page.locator('.list-meta')).toContainText('메일함 2개 · 별칭 일치');
    const matches = page.locator('.account-alias-match');
    await expect(matches).toHaveCount(2);
    for (const match of await matches.all()) {
      await expect(match).toContainText('globalsales@example.com 로 연결');
      await expect(match.locator('mark')).toHaveText('globalsales');
    }
    await page.locator('.account-item[href="#accounts/sales%40example.com"]').click();
    await expect(page.locator('.mail-flow-center [title="sales@example.com"]')).toBeVisible();
    await expect(page.locator('.kv').getByText('보관함', { exact: true })).toBeVisible();
  });
});
