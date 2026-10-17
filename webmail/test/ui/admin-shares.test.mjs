import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createFakeAdminApi } from '../../web/dev/fake-admin-api.js';
import { subfolderAclWarning } from '../../web/src/admin/pages/accounts.js';
const captures = process.env.SHARED_ADMIN_CAPTURE_DIR || '/tmp/webmail-shared-admin-captures';
const oldId = '33333333333333333333333333333333', newId = '44444444444444444444444444444444';
await test('shared admin folder grants, residual cleanup and history guidance', async t => {
 const fake = createFakeAdminApi(), initial = structuredClone(fake.state);
 const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: fileURLToPath(new URL('../../web/vite.admin.config.js', import.meta.url)), logLevel: 'error', plugins: [{ name: 'shared-admin-test-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
 await server.listen(); t.after(() => server.close());
 const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
 t.after(() => browser.close()); await mkdir(captures, { recursive: true });
 const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
 async function open(hash = 'shares/person%40example.com', width = 1280, prepare = () => {}) {
  Object.assign(fake.state, structuredClone(initial)); prepare(fake.state);
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'light' }), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.goto(`${origin}/admin.html#${hash}`);
  await expect(page.locator('[data-admin-page]')).toBeAttached(); return { page, context, errors };
 }
 for (const width of [1280, 768, 390, 375]) await t.test(`whole mailbox scope, shared and residual grants ${width}`, async () => {
  const { page, context, errors } = await open(undefined, width, state => { state.shares.wholeMailbox = true; });
  try {
   await expect(page.locator('.detail-head .chip')).toHaveText('메일함 전체 · 읽기 전용');
   await expect(page.locator('.account-detail')).toContainText('메일함 전체를 읽을 수 있습니다.');
   await expect(page.locator('.mini-row')).toHaveCount(2);
   await expect(page.locator('.mini-row').filter({ hasText: 'other@example.com' }).getByRole('button')).toHaveText('빼기');
   await expect(page.locator('.mini-row').filter({ hasText: 'residual@example.com' })).toContainText('남은 권한 2개 폴더');
   await expect(page.locator('.mini-row').filter({ hasText: 'residual@example.com' }).getByRole('button')).toHaveText('정리');
   await page.screenshot({ path: `${captures}/admin-shares-${width}-light.png`, fullPage: true });
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); assert.deepEqual(errors, []);
  } finally { await context.close(); }
 });
 await t.test('inbox scope and disabled subfolder ACL warning', async () => {
  const { page, context, errors } = await open(undefined, 1280, state => { state.shares.warnings = ['SUBFOLDER_ACL_UNCHECKED']; });
  try {
   await expect(page.locator('.detail-head .chip')).toHaveText('받은편지함 · 읽기 전용');
   await expect(page.locator('.account-detail')).toContainText('받은편지함을 읽을 수 있습니다.');
   await expect(page.getByText(subfolderAclWarning, { exact: true })).toBeVisible();
   await page.getByRole('button', { name: '빼기', exact: true }).click();
   await expect(page.locator('dialog')).toContainText('받은편지함 읽기 권한과 다른 폴더에 남은 권한을 모두 뺍니다.');
   await page.getByRole('button', { name: '공유 빼기', exact: true }).click();
   await expect(page.locator('.mini-row')).toHaveCount(1); assert.deepEqual(fake.state.shares.items[1].grantees, []); assert.deepEqual(errors, []);
  } finally { await context.close(); }
 });
 await t.test('residual cleanup confirms all folders and uses DELETE with current etag', async () => {
  const { page, context, errors } = await open();
  try {
   let body; await page.route('**/api/admin/shares/person%40example.com', route => { body = route.request().postDataJSON(); return route.continue(); });
   await page.getByRole('button', { name: '정리', exact: true }).click(); await expect(page.locator('dialog')).toContainText('남은 권한을 모두 지워요');
   await page.getByRole('button', { name: '남은 권한 정리', exact: true }).click(); await expect(page.locator('dialog')).toHaveCount(0);
   await expect(page.locator('.mini-row')).toHaveCount(1); await expect(page.locator('.mini-row')).not.toContainText('residual@example.com');
   assert.deepEqual(body, { grantee: 'residual@example.com', etag: 'share-person-1' });
   assert.equal(fake.state.requests.filter(row => row.method === 'DELETE' && row.path === '/api/admin/shares/person%40example.com').length, 1); assert.deepEqual(errors, []);
  } finally { await context.close(); }
 });
 await t.test('giving an existing residual grantee adds inbox and clears residual label', async () => {
  const { page, context, errors } = await open(undefined, 1280, state => { state.accounts.items.push({ ...state.accounts.items[0], address: 'residual@example.com', name: '합성 남은 권한' }); });
  try {
   await page.getByRole('button', { name: '읽기 공유 주기', exact: true }).click(); await page.getByLabel('공유받을 사람', { exact: true }).selectOption('residual@example.com');
   await page.getByRole('button', { name: '읽기 공유 추가', exact: true }).click();
   const row = page.locator('.mini-row').filter({ hasText: 'residual@example.com' }); await expect(row.getByRole('button')).toHaveText('빼기'); await expect(row).not.toContainText('남은 권한');
   assert.deepEqual(fake.state.shares.items[1].grants.find(row => row.grantee === 'residual@example.com').folders.map(row => row.mailbox), ['프로젝트', '프로젝트/2026', 'INBOX']); assert.deepEqual(errors, []);
  } finally { await context.close(); }
 });
 await t.test('legacy history shows reason in list and detail without a revert action', async () => {
  const { page, context, errors } = await open(`history/${oldId}`);
  try {
   const reason = fake.state.history.find(row => row.id === oldId).revertReason;
   await expect(page.locator('.list-pane')).toContainText(reason); await expect(page.locator('.account-detail')).toContainText(reason);
   await expect(page.getByRole('button', { name: '이 변경 되돌리기', exact: true })).toHaveCount(0);
   await page.screenshot({ path: `${captures}/admin-history-old-1280.png`, fullPage: true }); assert.deepEqual(errors, []);
  } finally { await context.close(); }
 });
 await t.test('new history can revert and shows skipped folder count in result and saved record', async () => {
  const { page, context, errors } = await open(`history/${newId}`);
  try {
   await page.getByRole('button', { name: '이 변경 되돌리기', exact: true }).click(); await page.getByRole('button', { name: '되돌리기 실행', exact: true }).click();
   await expect(page.locator('dialog')).toHaveCount(0); await expect(page.locator('.account-detail')).toContainText('없어진 폴더 1개는 건너뛰었어요');
   await page.getByRole('link', { name: '되돌리기 변경 기록', exact: true }).click(); await expect(page.locator('.account-detail')).toContainText('없어진 폴더 1개는 건너뛰었어요'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
 });
 for (const hash of ['accounts/person%40example.com', 'flow/delete/person%40example.com', 'flow/leave/person%40example.com']) await t.test(`folder references and account warning in ${hash}`, async () => {
  const { page, context, errors } = await open(hash, 1280, state => {
   state.accountRefs.shares.push({ owner: 'team@example.com', grantee: 'person@example.com', mailbox: '거래처/2026', rights: ['lookup', 'read'] });
   state.accounts.warnings = [{ code: 'SUBFOLDER_ACL_UNCHECKED', message: subfolderAclWarning }];
  });
  try {
   if (hash.startsWith('flow/')) await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
   const rows = page.getByRole('table', { name: '읽기 공유', exact: true }).locator('tbody tr');
   await expect(rows).toHaveCount(2); await expect(rows.first()).not.toContainText('INBOX'); await expect(rows.last()).toContainText('거래처/2026');
   await expect(page.getByText(subfolderAclWarning, { exact: true })).toBeVisible(); assert.deepEqual(errors, []);
  } finally { await context.close(); }
 });
});
