// Write-only during constrained implementation; no browser/server is started unless explicitly run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

const ref = (path, uid) => Buffer.from(JSON.stringify([path, 1, uid])).toString('base64url');
const ownRef = ref('Templates', 1), sharedRef = ref('Shared/other@example.com/Templates/공유', 2), at = '2026-10-28T00:00:00.000Z';
const own = { owner: 'user@example.com', id: '00000000-0000-4000-8000-000000000001', ref: ownRef, name: '내 합성 템플릿', subject: '{{고객사}} 안내', updatedAt: at, hasAttachments: true, size: 300, inShared: false };
const shared = { ...own, owner: 'other@example.com', id: '00000000-0000-4000-8000-000000000002', ref: sharedRef, name: '공유 합성 템플릿', inShared: true };
const publicRef = ref('PublicTemplates/1', 1), company = { ...own, owner: 'public', id: '1', ref: publicRef, name: '회사 공용 합성 템플릿', subject: '공용 안내', inShared: false };
const publicDetail = { ...company, html: '<p>회사 공용 본문</p>', text: '회사 공용 본문', attachments: [{ part: '11', name: 'company.txt', type: 'text/plain', size: 3 }] };
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7H8AAAAASUVORK5CYII=','base64');
const content = item => ({ ...item, html: `<p>{{받는사람이름}} 님, {{고객사}} 안내입니다.</p><img src="/api/messages/${item.ref}/parts/2?inline=1">`, text: '{{고객사}}', attachments: [{ part: '2', name: 'example.png', size: bytes.length, type: 'image/png' }] });

await test('templates management: approved A list/edit/share/read-only flows', async t => {
  const fake = createFakeApi({ authenticated: true });
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../web', import.meta.url)), logLevel: 'error', plugins: [preact(), { name: 'templates-page-api', configureServer(server) { server.middlewares.use(fake.middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); t.after(() => server.close()); t.after(() => fake.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] }); t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  async function open({ width = 1280, mode = 'light', empty = false, failList = false, listGate, conflict = false, shareError, withdrawn = false, maximum = false, pinError = false, withPublic = false, publicUnavailable = false, pins = [] } = {}) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }), requests = [], errors = [];
    const state = { mine: empty ? [] : maximum ? Array.from({ length: 200 }, (_, index) => ({ ...own, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, ref: ref('Templates', index + 1), name: index ? `합성 ${index}` : own.name })) : [{ ...own }], shared: empty ? [] : [{ ...shared }], public: withPublic && !publicUnavailable ? [company] : [], pins: [...pins], share: { domainAll: false, domain: 'example.com', users: ['member@example.com'], inboxReaders: ['inbox-reader@example.com'] }, details: new Map([[ownRef, content(own)], [sharedRef, content(shared)], [publicRef, publicDetail]]) };
    let uid = 1000;
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/prefs', async route => {
      const request = route.request();
      if (request.method() === 'PUT') {
        requests.push({ path: '/api/prefs', method: 'PUT', body: request.postDataJSON() });
        if (pinError) return route.fulfill({ status: 503, json: { error: { code: 'MAIL_UNAVAILABLE', message: '합성 고정 실패' } } });
        if (request.postDataJSON().templatePins) state.pins = request.postDataJSON().templatePins;
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({ json: { ...fake.state.prefs, mode, templatePins: state.pins } });
    });
    await page.route('**/api/templates**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname, method = request.method(), body = request.postData() ? request.postDataJSON() : undefined;
      requests.push({ path, method, body });
      if (method !== 'GET') assert.equal(request.headers()['x-webmail-csrf'], fake.state.csrf);
      if (path === '/api/templates' && method === 'GET') { if (listGate) await listGate; return failList ? route.fulfill({ status: 503, json: { error: { code: 'MAIL_UNAVAILABLE', message: '합성 목록 실패' } } }) : route.fulfill({ json: { mine: state.mine, shared: state.shared, public: state.public, ...(publicUnavailable ? { publicUnavailable: true } : {}), pins: state.pins, limits: { max: 200 } } }); }
      if (path === '/api/templates/share') {
        if (method === 'GET') return route.fulfill({ json: state.share });
        if (shareError) return route.fulfill({ status: 422, json: { error: { code: shareError, message: shareError === 'TEMPLATE_SHARE_CONFLICT' ? '기존 수동 공유 권한과 겹쳐요: user=alias@example.com' : '공유할 활성 메일 계정을 확인해 주세요.' } } });
        state.share = { ...state.share, ...body }; return route.fulfill({ json: state.share });
      }
      const token = decodeURIComponent(path.split('/')[3]);
      if (path.endsWith('/attachments-to-compose') && token === publicRef) return route.fulfill({ json: { uploads: [{ id: 'public-upload', name: 'company.txt', size: 3 }], html: publicDetail.html } });
      if (path.endsWith('/attachments-to-compose')) { const detail = state.details.get(token); return route.fulfill({ json: { uploads: [{ id: 'copied-upload', name: 'example.png', size: bytes.length }], html: detail.html.replaceAll(`/api/messages/${token}/parts/2?inline=1`, 'cid:wm-template-v1.synthetic-copy@template.invalid') } }); }
      if (path.endsWith('/copy')) { const value = { ...own, id: '00000000-0000-4000-8000-000000000099', ref: ref('Templates', ++uid), name: token === publicRef ? company.name : shared.name }; state.mine.push(value); state.details.set(value.ref, content(value)); return route.fulfill({ status: 201, json: value }); }
      if (method === 'GET') return withdrawn && token === sharedRef ? route.fulfill({ status: 404, json: { error: { code: 'TEMPLATE_NOT_FOUND', message: '더 이상 볼 수 없어요' } } }) : route.fulfill({ json: state.details.get(token) || content(state.mine.find(item => item.ref === token)) });
      if (method === 'DELETE') { state.mine = state.mine.filter(item => item.ref !== token); return route.fulfill({ json: { ok: true } }); }
      if (method === 'PUT' && conflict) return route.fulfill({ status: 409, json: { error: { code: 'TEMPLATE_CHANGED', message: '다른 곳에서 바뀌었어요. 다시 열어 주세요.' } } });
      const previous = state.mine.find(item => item.ref === token), moving = path.endsWith('/move');
      const value = { ...(previous || own), ref: ref(moving && body.shared ? 'Templates/공유' : 'Templates', ++uid), id: previous?.id || `00000000-0000-4000-8000-${String(uid).padStart(12, '0')}`, name: body.name || previous?.name || '새 템플릿', subject: body.subject ?? previous?.subject ?? '', inShared: moving ? body.shared : body.shared };
      state.mine = previous ? state.mine.map(item => item.ref === token ? value : item) : [...state.mine, value]; const html = body.html || content(value).html; state.details.set(value.ref, { ...content(value), html: token ? html.replaceAll(token, value.ref) : html });
      return route.fulfill({ status: method === 'POST' && !moving ? 201 : 200, json: value });
    });
    await page.route('**/api/messages/*/parts/*', route => route.fulfill({ body: bytes, contentType: 'image/png' }));
    await page.route('**/api/drafts', route => route.fulfill({ json: { draftRef: 'synthetic-draft' } }));
    await page.goto(origin + '/#templates'); await expect(page.getByRole('heading', { name: '템플릿', exact: true })).toBeVisible();
    return { page, requests, errors, state };
  }
  const row = (page, name) => page.locator('.tplA-row').filter({ hasText: name });
  for (const width of [1280, 768, 375]) for (const mode of ['light', 'dark']) await t.test(`list/edit/share layout ${width} ${mode}`, async () => {
    const c = await open({ width, mode }); try {
      await expect(row(c.page, own.name)).toBeVisible(); await row(c.page, own.name).click(); await expect(c.page.getByRole('textbox', { name: '이름', exact: true })).toHaveValue(own.name);
      await c.page.getByRole('textbox', { name: '이름', exact: true }).fill('수정한 템플릿');
      await expect(c.page.getByRole('button', { name: '공유 폴더에 넣기', exact: true })).toBeDisabled(); await expect(c.page.getByText('먼저 저장해 주세요', { exact: true })).toBeVisible();
      await c.page.getByRole('button', { name: '저장', exact: true }).click(); await expect(c.page.getByRole('button', { name: '공유 폴더에 넣기', exact: true })).toBeEnabled();
      await c.page.getByRole('button', { name: '공유 폴더에 넣기', exact: true }).click(); await expect(c.page.getByRole('button', { name: '공유 폴더에서 빼기', exact: true })).toBeEnabled();
      if (width <= 1100) await c.page.getByRole('button', { name: '목록', exact: true }).click();
      await c.page.locator('.tplA-sf').getByRole('button', { name: '공유 설정', exact: true }).click(); const dialog = c.page.getByRole('dialog', { name: '공유 폴더 공유 설정' }); await expect(dialog).toBeVisible();
      await expect(dialog.locator('.tplA-inbox .rm')).toHaveCount(0); await expect(dialog.getByText('inbox-reader@example.com', { exact: true }).first()).toBeVisible();
      assert.deepEqual(c.errors, []);
      if (process.env.TEMPLATES_CAPTURE_DIR) { await mkdir(process.env.TEMPLATES_CAPTURE_DIR, { recursive: true }); await c.page.screenshot({ path: `${process.env.TEMPLATES_CAPTURE_DIR}/templates-page-${width}-${mode}.png` }); }
    } finally { await c.page.close(); }
  });
  await t.test('search, pin ordering and failed preference rollback preserve the open editor', async () => {
    const c = await open({ pinError: true }); try {
      await c.page.getByRole('textbox', { name: '템플릿 찾기', exact: true }).fill('없는 이름'); await expect(c.page.getByText('찾는 템플릿이 없어요.', { exact: true })).toBeVisible(); await c.page.getByRole('textbox', { name: '템플릿 찾기', exact: true }).fill('');
      await row(c.page, own.name).click(); await c.page.getByRole('button', { name: '고정', exact: true }).click(); await expect(c.page.getByRole('button', { name: '고정 해제', exact: true })).toBeVisible();
      await expect(c.page.getByText('합성 고정 실패', { exact: true })).toBeVisible(); await expect(c.page.getByRole('button', { name: '고정', exact: true })).toBeVisible();
      await expect(c.page.getByRole('textbox', { name: '이름', exact: true })).toHaveValue(own.name);
    } finally { await c.page.close(); }
  });
  await t.test('share save submits only chosen domain/users; inherited readers are immutable and focus returns', async () => {
    const c = await open(); try {
      await c.page.locator('.tplA-sf').getByRole('button', { name: '공유 설정', exact: true }).click(); const dialog = c.page.getByRole('dialog', { name: '공유 폴더 공유 설정' });
      await dialog.getByRole('checkbox', { name: '같은 도메인 전체에 공유' }).check(); await dialog.getByRole('textbox', { name: '사람 지정', exact: true }).fill('합성 사람 <new@example.com>'); await dialog.getByRole('button', { name: '추가', exact: true }).click();
      await dialog.getByRole('button', { name: '저장', exact: true }).click(); await expect(dialog).toHaveCount(0);
      await expect(c.page.locator('.tplA-sf').getByRole('button', { name: '공유 설정', exact: true })).toBeFocused();
      const put = c.requests.find(request => request.path === '/api/templates/share' && request.method === 'PUT'); assert.deepEqual(put.body, { domainAll: true, users: ['member@example.com', 'new@example.com'] });
    } finally { await c.page.close(); }
  });
  for (const code of ['TEMPLATE_SHARE_INVALID', 'TEMPLATE_SHARE_CONFLICT']) await t.test(`share error retains chosen addresses: ${code}`, async () => {
    const c = await open({ shareError: code }); try {
      await c.page.locator('.tplA-sf').getByRole('button', { name: '공유 설정', exact: true }).click(); const dialog = c.page.getByRole('dialog', { name: '공유 폴더 공유 설정' });
      await dialog.getByRole('textbox', { name: '사람 지정', exact: true }).fill('alias@example.com'); await dialog.getByRole('button', { name: '추가', exact: true }).click(); await dialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect(dialog.getByRole('alert')).toHaveText(code === 'TEMPLATE_SHARE_CONFLICT' ? '기존 수동 공유 권한과 겹쳐요: user=alias@example.com' : '공유할 활성 메일 계정을 확인해 주세요.');
      await expect(dialog.getByText('alias@example.com', { exact: true }).first()).toBeVisible(); assert.deepEqual(c.state.share.users, ['member@example.com']);
      await c.page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    } finally { await c.page.close(); }
  });
  await t.test('shared view has no writable controls/source mutations and copy creates an owned editor', async () => {
    const c = await open(); try {
      await row(c.page, shared.name).click(); const view = c.page.locator('.template-readonly'); await expect(view.getByText(/님이 공유한 템플릿 · 읽기 전용/)).toBeVisible();
      await expect(view.locator('input,textarea,[contenteditable=true]')).toHaveCount(0); assert.equal(await c.page.frameLocator('iframe.tpl-read-frame').locator('body').evaluate(body => body.isContentEditable), false);
      await view.getByRole('button', { name: '내 템플릿으로 복사', exact: true }).click(); await expect(c.page.getByRole('textbox', { name: '이름', exact: true })).toHaveValue(shared.name);
      assert.deepEqual(c.requests.filter(request => request.path.includes(sharedRef) && request.method !== 'GET').map(request => [request.method, request.path]), [['POST', `/api/templates/${sharedRef}/copy`]]);
      assert.equal(c.state.shared[0].ref, sharedRef);
    } finally { await c.page.close(); }
  });
  await t.test('shared template opens a new composition and imports the selected template exactly once', async () => {
    const c = await open(); try {
      await row(c.page, shared.name).click(); await c.page.locator('.template-readonly').getByRole('button', { name: '이 템플릿으로 메일 쓰기', exact: true }).click();
      await expect(c.page.locator('.composer .tplA-strip')).toBeVisible(); await expect(c.page.locator('.composer').getByRole('textbox', { name: '제목', exact: true })).toHaveValue(shared.subject);
      assert.equal(c.requests.filter(request => request.path === `/api/templates/${sharedRef}/attachments-to-compose`).length, 1);
    } finally { await c.page.close(); }
  });
  await t.test('dirty exit asks only for actual changes; conflict keeps input until explicit reload', async () => {
    const c = await open({ conflict: true }); try {
      await row(c.page, own.name).click(); const name = c.page.getByRole('textbox', { name: '이름', exact: true }); await name.fill('보존할 수정');
      c.page.once('dialog', dialog => dialog.dismiss()); await c.page.locator('a[href="#inbox"]').first().click(); await expect(name).toHaveValue('보존할 수정');
      await c.page.getByRole('button', { name: '저장', exact: true }).click(); await expect(c.page.getByRole('alert')).toContainText('다른 곳에서 먼저 바뀌었어요'); await expect(name).toHaveValue('보존할 수정');
      c.page.once('dialog', dialog => dialog.accept()); await c.page.getByRole('button', { name: '다시 불러오기', exact: true }).click(); await expect(name).toHaveValue(own.name);
    } finally { await c.page.close(); }
  });
  await t.test('new template creation keeps literal variables through the HTML source mode', async () => {
    const c = await open(); try {
      await c.page.getByRole('button', { name: '새 템플릿', exact: true }).click(); const name = c.page.getByRole('textbox', { name: '이름', exact: true }); await expect(name).toBeFocused(); await name.fill('새 합성 안내');
      await c.page.getByRole('textbox', { name: '제목', exact: true }).fill('{{고객사}} 새 제목'); await c.page.getByRole('button', { name: 'HTML 원문', exact: true }).click(); await c.page.getByRole('textbox', { name: 'HTML 원문 편집', exact: true }).fill('<p>{{고객사}} 새 안내</p>');
      await c.page.getByRole('button', { name: '저장', exact: true }).click(); await expect(row(c.page, '새 합성 안내')).toBeVisible();
      const created = c.requests.find(request => request.path === '/api/templates' && request.method === 'POST').body; assert.equal(created.html, '<p>{{고객사}} 새 안내</p>'); assert.equal(created.subject, '{{고객사}} 새 제목'); assert.equal('baseUid' in created, false);
    } finally { await c.page.close(); }
  });
  await t.test('deletion requires confirmation and carries the opened baseUid', async () => {
    const c = await open(); try {
      await row(c.page, own.name).click(); c.page.once('dialog', dialog => dialog.dismiss()); await c.page.getByRole('button', { name: '삭제', exact: true }).click(); assert.equal(c.requests.some(request => request.method === 'DELETE'), false);
      c.page.once('dialog', dialog => dialog.accept()); await c.page.getByRole('button', { name: '삭제', exact: true }).click(); await expect(row(c.page, own.name)).toHaveCount(0); assert.deepEqual(c.requests.find(request => request.method === 'DELETE').body, { baseUid: 1 });
    } finally { await c.page.close(); }
  });
  for (const options of [{ empty: true, text: '템플릿이 없어요' }, { failList: true, text: '합성 목록 실패' }, { withdrawn: true, text: '더 이상 볼 수 없어요' }]) await t.test(`state: ${options.text}`, async () => {
    const c = await open(options); try { if (options.withdrawn) await row(c.page, shared.name).click(); await expect(c.page.getByText(options.text, { exact: true })).toBeVisible(); } finally { await c.page.close(); }
  });
  await t.test('200-item list scrolls and blocks additional creation/copy', async () => {
    const c = await open({ maximum: true }); try { await expect(c.page.locator('.tplA-row')).toHaveCount(201); await expect(c.page.getByRole('button', { name: '새 템플릿', exact: true })).toBeDisabled(); await row(c.page, shared.name).click(); await expect(c.page.getByRole('button', { name: '내 템플릿으로 복사', exact: true })).toBeDisabled(); } finally { await c.page.close(); }
  });
  await t.test('pending metadata request displays a skeleton before results', async () => {
    let release; const listGate = new Promise(resolve => { release = resolve; }); const c = await open({ listGate });
    try { await expect(c.page.locator('.tpl-list-skeleton')).toHaveCount(4); release(); await expect(row(c.page, own.name)).toBeVisible(); } finally { release(); await c.page.close(); }
  });
  await t.test('company group is read-only, pins exact public ID and copies to an owned editor', async () => {
    const c = await open({ withPublic: true }); try {
      await row(c.page, company.name).click(); await expect(c.page.getByText('회사 공용 템플릿 · 읽기 전용', { exact: true })).toBeVisible();
      await expect(c.page.locator('iframe[title="회사 공용 템플릿 본문"]')).toBeVisible(); await expect(c.page.getByRole('button', { name: '저장', exact: true })).toHaveCount(0); await expect(c.page.getByRole('button', { name: '삭제', exact: true })).toHaveCount(0);
      await c.page.getByRole('button', { name: '고정', exact: true }).click(); await expect.poll(() => c.state.pins).toEqual([{ owner: 'public', id: '1' }]);
      await c.page.getByRole('button', { name: '내 템플릿으로 복사', exact: true }).click(); await expect(c.page.getByLabel('이름', { exact: true })).toHaveValue(company.name); assert.equal(c.requests.filter(call => call.path === `/api/templates/${publicRef}/copy`).length, 1);
    } finally { await c.page.close(); }
  });
  await t.test('company use opens compose once with ordinary attachments and unchanged body', async () => {
    const c = await open({ withPublic: true }); try {
      await row(c.page, company.name).click(); await c.page.getByRole('button', { name: '이 템플릿으로 메일 쓰기', exact: true }).click();
      await expect(c.page.locator('.composer')).toBeVisible(); await expect(c.page.getByText('company.txt', { exact: true })).toBeVisible(); assert.equal(c.requests.filter(call => call.path === `/api/templates/${publicRef}/attachments-to-compose`).length, 1);
    } finally { await c.page.close(); }
  });
  await t.test('partial company load warns, keeps mailbox rows and preserves public pins on personal pin change', async () => {
    const c = await open({ publicUnavailable: true, pins: [{ owner: 'public', id: '1' }] }); try {
      await expect(c.page.getByText('회사 공용 템플릿을 불러오지 못했어요', { exact: true })).toBeVisible(); await row(c.page, own.name).click(); await c.page.getByRole('button', { name: '고정', exact: true }).click();
      await expect.poll(() => c.state.pins).toEqual([{ owner: 'public', id: '1' }, { owner: own.owner, id: own.id }]); await expect(row(c.page, shared.name)).toBeVisible();
    } finally { await c.page.close(); }
  });

});
