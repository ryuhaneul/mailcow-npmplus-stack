import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, expect } from '@playwright/test';
import { createFakeApi } from '../../web/dev/fake-api.js';

const captures = process.env.SELECT_ALL_CAPTURE_DIR || '/tmp/webmail-select-all-captures';
const actions = ['seen','unseen','flag','unflag','move','archive','trash','spam','notspam','delete-forever'];
const scopeOf = (patch = {}) => ({view:'inbox',folder:'',quick:'all',q:'',in:'',...patch});
const keys = value => Object.keys(value).sort();

// R HTTP contract: scope has exactly five fields; client never supplies refs,
// pagination, UID fences or batch limits to a scoped request.
function assertActionRequest(record, expected) {
  assert.equal(record.method, 'POST');
  assert.equal(record.csrf, 'synthetic-csrf-token');
  const body = record.body;
  assert.deepEqual(keys(body.scope), keys(scopeOf()));
  for (const value of Object.values(body.scope)) assert.equal(typeof value, 'string');
  assert.ok(actions.includes(body.action));
  assert.equal(Object.hasOwn(body, 'target'), body.action === 'move');
  if (body.action === 'move') assert.equal(typeof body.target, 'string');
  const prepare = record.path === '/api/messages/selections';
  const retry = body.retry === 'failed';
  assert.deepEqual(keys(body), [
    'scope','action','cursor', ...(body.action === 'move' ? ['target'] : []),
    ...(prepare ? ['selectionKey'] : []), ...(retry ? ['selectionId','retry'] : []),
  ].sort());
  if (prepare) {
    assert.match(body.selectionKey, /^[A-Za-z0-9_-]{1,128}$/);
    assert.ok(body.cursor === null || typeof body.cursor === 'string');
  } else assert.equal(typeof body.cursor, 'string');
  if (retry) assert.equal(typeof body.selectionId, 'string');
  if (expected) {
    assert.deepEqual(body.scope, expected.scope);
    assert.equal(body.action, expected.action);
    if (body.action === 'move') assert.equal(body.target, expected.target);
    if (Object.hasOwn(expected, 'cursor')) assert.equal(body.cursor, expected.cursor);
  }
}
function assertRefsRequest(record, expected) {
  assert.equal(record.method, 'POST');
  assert.equal(record.csrf, 'synthetic-csrf-token');
  assert.deepEqual(keys(record.body), ['refs','action', ...(record.body.action === 'move' ? ['target'] : [])].sort());
  assert.ok(record.body.refs.length > 0 && record.body.refs.length <= 1000);
  if (expected) assert.deepEqual(record.body, expected);
}
function message(folder, index) {
  return {
    ref: Buffer.from(JSON.stringify([folder,1,index + 1])).toString('base64url'),
    folder, folderName:folder, from:{name:'합성 발신자',address:'sender@example.com'},
    to:[{name:'합성 수신자',address:'user@example.com'}], subject:`합성 견적 ${index + 1}`,
    preview:'회귀 시험용 합성 메일입니다.', date:'2026-10-19T03:00:00.000Z',
    size:1024, seen:index % 2 === 1, flagged:index % 3 === 0,
    answered:false, hasAttachment:index % 2 === 0,
  };
}
function matching(rows, scope) {
  const folder = scope.view === 'spam' ? 'Junk' : scope.view === 'folder' ? scope.folder : 'INBOX';
  const confined = ['Trash','Junk'].includes(folder);
  const virtual = !confined && (scope.view === 'allmail' || scope.q.trim());
  return rows.filter(item => {
    if (virtual ? ['Trash','Junk','Drafts'].includes(item.folder) : item.folder !== folder) return false;
    if (scope.in && item.folder !== scope.in) return false;
    if (scope.quick === 'unread' && item.seen) return false;
    if (scope.quick === 'starred' && !item.flagged) return false;
    if (scope.quick === 'attach' && !item.hasAttachment) return false;
    for (const term of scope.q.trim().split(/\s+/).filter(Boolean)) {
      if (term.startsWith('from:')) { if (!item.from.address.includes(term.slice(5))) return false; }
      else if (term.startsWith('in:')) { if (item.folder !== term.slice(3)) return false; }
      else if (term.startsWith('subject:')) { if (!item.subject.includes(term.slice(8))) return false; }
      else if (!(item.subject + item.preview).includes(term)) return false;
    }
    return true;
  });
}

// All selection APIs live inside this test. V2 can inject gated receipts,
// transport failures and failed pages through handlers without changing fake-api.
async function installSelectionApi(page, {inbox = 1848, handlers = {}} = {}) {
  const model = {
    rows: [['INBOX',inbox],['Trash',51],['Junk',51],['거래처',60]].flatMap(([folder,count]) => Array.from({length:count},(_,i) => message(folder,i))),
    requests: [], errors: [], selections: new Map(),
  };
  await page.route('**/api/messages**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const record = {path,url:request.url(),method:request.method(),csrf:request.headers()['x-webmail-csrf'],body:request.postData() ? request.postDataJSON() : null};
    model.requests.push(record);
    try {
      const reply = json => route.fulfill({json,headers:{'Cache-Control':'no-store'}});
      if (path === '/api/messages' && request.method() === 'GET') {
        const scope = scopeOf(Object.fromEntries([...url.searchParams].filter(([key]) => key in scopeOf())));
        const rows = matching(model.rows,scope), pageNumber = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 50);
        if (handlers.list) return await handlers.list({route,record,model,scope,rows,reply});
        return await reply({total:rows.length,page:pageNumber,pageSize,items:rows.slice((pageNumber - 1) * pageSize,pageNumber * pageSize)});
      }
      if (path === '/api/messages/selections') {
        assertActionRequest(record);
        if (handlers.prepare) return await handlers.prepare({route,record,model,reply});
        const selectionId = `synthetic-selection-${model.selections.size + 1}`;
        const rows = matching(model.rows,record.body.scope);
        const cursor = `${selectionId}-execute-0`;
        model.selections.set(selectionId,{...record.body,rows:structuredClone(rows),cursor});
        return await reply({selectionId,phase:'ready',cursor,totalEstimate:rows.length,initialTotal:rows.length,expiresAt:Date.now()+1800000,cutoff:{kind:'uid-fences',capturedAt:Date.now()}});
      }
      if (path === '/api/messages/actions/scope') {
        assertActionRequest(record);
        if (handlers.execute) return await handlers.execute({route,record,model,reply});
        const entry = [...model.selections.entries()].find(([,value]) => value.cursor === record.body.cursor);
        assert.ok(entry, 'execute must use a prepared cursor');
        const [selectionId, prepared] = entry;
        assertActionRequest(record,prepared);
        const processed = prepared.rows.length;
        return await reply({selectionId,batchId:`${selectionId}:0`,sequence:0,state:'completed',reason:'complete',initialTotal:processed,delta:{processed,skipped:0,failed:0},totals:{processed,skipped:0,failed:0},failed:[],nextCursor:null,remainingEstimate:0,elapsedMs:1});
      }
      if (path === '/api/messages/actions') {
        assertRefsRequest(record);
        if (handlers.refs) return await handlers.refs({route,record,model,reply});
        return await reply({done:record.body.refs.length,failed:[]});
      }
      if (/\/selections\/[^/]+\/failed$/.test(path) && handlers.failed) return await handlers.failed({route,record,model,reply});
      return await route.continue();
    } catch (error) {
      model.errors.push(error);
      await route.fulfill({status:500,json:{error:{code:'TEST_CONTRACT',message:error.message}}});
    }
  });
  model.posts = () => model.requests.filter(record => record.method === 'POST');
  model.prepares = () => model.requests.filter(record => record.path === '/api/messages/selections');
  model.executions = () => model.requests.filter(record => record.path === '/api/messages/actions/scope');
  return model;
}

// Explicit gates keep progress and stop assertions tied to an in-flight request.
function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise,resolve};
}
function ready(selectionId, initialTotal) {
  return {selectionId,phase:'ready',cursor:`${selectionId}-execute-0`,totalEstimate:initialTotal,initialTotal,expiresAt:Date.now()+1800000,cutoff:{kind:'uid-fences',capturedAt:Date.now()}};
}
function receipt(selectionId, sequence, initialTotal, totals, {delta = totals, failed = [], completed = false} = {}) {
  const remainingEstimate = initialTotal - totals.processed - totals.skipped - totals.failed;
  return {selectionId,batchId:`${selectionId}:${sequence}`,sequence,state:completed?'completed':'running',reason:completed?'complete':'batch',initialTotal,delta,totals,failed,nextCursor:completed?null:`${selectionId}-execute-${sequence+1}`,remainingEstimate,elapsedMs:1};
}

await test('select-all: selection, confirmation and recovery', async t => {
  const fake = createFakeApi({authenticated:true});
  const server = await createServer({configFile:false,root:fileURLToPath(new URL('../../web',import.meta.url)),logLevel:'error',plugins:[preact(),{name:'select-all-test-api',configureServer(server) {server.middlewares.use(fake.middleware);}}],server:{host:'127.0.0.1',port:0}});
  await server.listen();
  t.after(async () => {fake.close();await server.close();});
  const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}),args:['--no-sandbox']});
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await mkdir(captures,{recursive:true});
  async function pageFor(t, options = {}) {
    const context = await browser.newContext({viewport:{width:1280,height:900}});
    t.after(() => context.close());
    await context.addInitScript(() => localStorage.setItem('webmail-prefs',JSON.stringify({theme:'ink',mode:'light'})));
    const page = await context.newPage(), errors = [];
    page.on('pageerror',error => errors.push(error.message));
    const model = await installSelectionApi(page, options);
    t.after(() => {assert.deepEqual(model.errors.map(error => error.message),[]);assert.deepEqual(errors,[]);});
    await page.goto(`${origin}/#${options.route || 'inbox'}`);
    await expect(page.locator('.mailview')).toBeVisible();
    await expect(page.locator('.mailview .scroll')).toHaveAttribute('aria-busy','false');
    return {page,model};
  }
  const rowChecks = page => page.locator('.m .cbw[role="checkbox"]');
  async function selectPage(page) {
    await page.locator('.sa-tools').getByRole('button',{name:'모두 선택',exact:true}).click();
  }
  async function selectAll(page) {
    await selectPage(page);
    await page.getByRole('button',{name:/조건에 맞는 메일 .*통 모두 선택/}).click();
  }
  async function waitList(page, action) {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/messages' && response.request().method() === 'GET');
    await action();await response;
    await expect(page.locator('.mailview .scroll')).toHaveAttribute('aria-busy','false');
  }
  function noPosts(model) {assert.deepEqual(model.posts(),[]);}
  async function allCleared(page) {
    await expect(page.locator('.sa-notice')).toHaveCount(0);
    await expect(page.locator('.sa-tools .cnt')).toHaveCount(0);
    await expect(page.locator('.m .cbw[aria-checked="true"]')).toHaveCount(0);
  }

  for (const count of [0,50,51,1848]) await t.test(`${count} messages: page selection and all-selection offer`,async t => {
    const {page,model} = await pageFor(t,{inbox:count});
    await expect(page.locator('.m')).toHaveCount(Math.min(count,50));
    if (!count) {
      await expect(page.locator('.sa-tools').getByRole('button',{name:'모두 선택',exact:true})).toBeDisabled();
      await expect(page.locator('.sa-notice')).toHaveCount(0);
    } else {
      await selectPage(page);
      await expect(page.locator('.m .cbw[aria-checked="true"]')).toHaveCount(Math.min(count,50));
      await expect(page.locator('.sa-notice')).toHaveCount(count > 50 ? 1 : 0);
      if (count > 50) {
        await expect(page.locator('.sa-notice')).toContainText('이 화면 50통 선택됨');
        await page.getByRole('button',{name:`조건에 맞는 메일 ${count.toLocaleString('ko-KR')}통 모두 선택`}).click();
        await expect(page.locator('.sa-notice')).toContainText(`${count.toLocaleString('ko-KR')}통 모두 선택됨`);
      }
    }
    noPosts(model);
  });

  await t.test('partial selection offers no all-selection link; page action uses exact refs',async t => {
    const {page,model} = await pageFor(t);
    const expectedRefs = await rowChecks(page).evaluateAll(elements => elements.slice(0,2).map(element => element.closest('.m').dataset.ref));
    await rowChecks(page).nth(0).click();await rowChecks(page).nth(1).click();
    await expect(page.locator('.sa-tools .cnt')).toHaveText('2통 선택');
    await expect(page.locator('.sa-notice')).toHaveCount(0);
    await page.locator('.sa-tools').getByRole('button',{name:'읽음 표시',exact:true}).click();
    await expect.poll(() => model.posts().length).toBe(1);
    assertRefsRequest(model.posts()[0],{refs:expectedRefs,action:'seen'});
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(model.prepares().length,0);assert.equal(model.executions().length,0);
  });

  await t.test('page selection action stays within the displayed 50 refs',async t => {
    const {page,model} = await pageFor(t);
    const refs = await page.locator('.m').evaluateAll(elements => elements.map(element => element.dataset.ref));
    await selectPage(page);
    await page.locator('.sa-tools').getByRole('button',{name:'보관',exact:true}).click();
    await expect.poll(() => model.posts().length).toBe(1);
    assertRefsRequest(model.posts()[0],{refs,action:'archive'});
    assert.equal(model.prepares().length,0);assert.equal(model.executions().length,0);
  });

  await t.test('all-selection survives same-scope pagination; unchecking becomes current-page minus one',async t => {
    const {page,model} = await pageFor(t);
    await selectAll(page);
    await waitList(page,() => page.getByRole('button',{name:'다음 페이지',exact:true}).click());
    await expect(page.locator('.sa-notice')).toContainText('1,848통 모두 선택됨');
    await expect(page.locator('.m .cbw[aria-checked="true"]')).toHaveCount(50);
    await expect(page.locator('.m').first()).toContainText('합성 견적 51');
    await waitList(page,() => page.getByRole('button',{name:'이전 페이지',exact:true}).click());
    await expect(page.locator('.sa-notice')).toContainText('1,848통 모두 선택됨');
    await waitList(page,() => page.getByRole('button',{name:'다음 페이지',exact:true}).click());
    const currentRefs = await page.locator('.m').evaluateAll(elements => elements.map(element => element.dataset.ref));
    await rowChecks(page).nth(7).click();
    await expect(page.locator('.sa-tools .cnt')).toHaveText('49통 선택');
    await expect(page.locator('.sa-notice')).toHaveCount(0);
    await expect(rowChecks(page).nth(7)).toHaveAttribute('aria-checked','false');
    await expect(page.locator('.m .cbw[aria-checked="true"]')).toHaveCount(49);
    noPosts(model);
    await page.locator('.sa-tools').getByRole('button',{name:'읽음 표시',exact:true}).click();
    await expect.poll(() => model.posts().length).toBe(1);
    assertRefsRequest(model.posts()[0],{refs:currentRefs.filter((_,index) => index !== 7),action:'seen'});
  });

  for (const change of ['folder','query','quick','in']) await t.test(`changing ${change} clears all-selection`,async t => {
    const {page,model} = await pageFor(t,{route:change === 'in' ? 'allmail' : 'inbox'});
    await selectAll(page);
    await waitList(page,async () => {
      if (change === 'folder') await page.locator('a[href="#f/Archive"]').click();
      if (change === 'query') {await page.getByRole('textbox',{name:'메일 검색',exact:true}).fill('from:sender@example.com');await page.getByRole('textbox',{name:'메일 검색',exact:true}).press('Enter');}
      if (change === 'quick') await page.getByRole('group',{name:'빠른 보기'}).getByRole('button',{name:'읽지 않음',exact:true}).click();
      if (change === 'in') await page.getByRole('group',{name:'폴더 거르기'}).getByRole('button',{name:'거래처',exact:true}).click();
    });
    await allCleared(page);noPosts(model);
  });

  await t.test('explicit clear removes all-selection without preparing',async t => {
    const {page,model} = await pageFor(t);
    await selectAll(page);await page.locator('.sa-notice').getByRole('button',{name:'선택 해제',exact:true}).click();
    await allCleared(page);noPosts(model);
  });

  await t.test('confirmation shows count, folder, original query and cutoff; cancel sends zero requests',async t => {
    const q = 'from:sender@example.com in:거래처';
    const {page,model} = await pageFor(t,{route:`search/${encodeURIComponent(q)}`});
    await selectAll(page);noPosts(model);
    await page.locator('.sa-tools').getByRole('button',{name:'삭제',exact:true}).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveText('60통을 휴지통으로 옮길까요?');
    await expect(dialog.locator('dl')).toContainText('60통');
    await expect(dialog.locator('dl')).toContainText('전체편지함 · 스팸·휴지통 제외');
    await expect(dialog.locator('dl')).toContainText(q);
    await expect(dialog).toContainText('확인을 누른 뒤 도착한 메일은 포함 안 돼요.');
    await expect(dialog).toContainText('준비 전 추정치');
    await expect(dialog).toContainText('휴지통에서 다시 꺼낼 수 있어요.');
    noPosts(model);
    await page.screenshot({path:`${captures}/v1-search-confirm.png`});
    await dialog.getByRole('button',{name:'취소',exact:true}).click();
    await expect(dialog).toHaveCount(0);await expect(page.locator('.sa-notice')).toContainText('60통 모두 선택됨');
    noPosts(model);
  });

  await t.test('confirm execution is the first prepare request and matches the R contract',async t => {
    const {page,model} = await pageFor(t);
    await selectAll(page);
    await page.locator('.sa-tools').getByRole('button',{name:'읽음 표시',exact:true}).click();
    await expect(page.getByRole('dialog')).toBeVisible();noPosts(model);
    await page.getByRole('dialog').getByRole('button',{name:'1,848통 읽음 표시',exact:true}).click();
    await expect(page.locator('.sa-result')).toContainText('읽음 표시를 마쳤어요');
    assert.equal(model.prepares().length,1);assert.equal(model.executions().length,1);
    assertActionRequest(model.prepares()[0],{scope:scopeOf(),action:'seen',cursor:null});
    assertActionRequest(model.executions()[0],{scope:scopeOf(),action:'seen',cursor:'synthetic-selection-1-execute-0'});
    assert.deepEqual(model.posts().map(record => record.path),['/api/messages/selections','/api/messages/actions/scope']);
  });

  await t.test('move confirmation includes the chosen destination and sends target only for move',async t => {
    const {page,model} = await pageFor(t,{inbox:51});
    await selectAll(page);
    await page.locator('.sa-tools').getByRole('button',{name:'폴더로 옮기기',exact:true}).click();
    await page.getByRole('menu',{name:'이동할 폴더'}).getByRole('menuitem',{name:'거래처',exact:true}).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('이동할 폴더');await expect(dialog.locator('dd').last()).toHaveText('거래처');noPosts(model);
    await dialog.getByRole('button',{name:'51통 폴더로 옮기기',exact:true}).click();
    await expect(page.locator('.sa-result')).toContainText('폴더로 옮겼어요');
    assertActionRequest(model.prepares()[0],{scope:scopeOf(),action:'move',target:'거래처',cursor:null});
    assertActionRequest(model.executions()[0],{scope:scopeOf(),action:'move',target:'거래처',cursor:'synthetic-selection-1-execute-0'});
  });

  for (const [folder,route,label,view] of [['Trash','f/Trash','휴지통','folder'],['Junk','spam','스팸','spam']]) await t.test(`${label} search stays confined and names permanent deletion with recovery warning`,async t => {
    const {page,model} = await pageFor(t,{route});
    const q = 'from:sender@example.com';
    await waitList(page,async () => {await page.getByRole('textbox',{name:'메일 검색',exact:true}).fill(q);await page.getByRole('textbox',{name:'메일 검색',exact:true}).press('Enter');});
    await expect(page.locator('.sa-context')).toContainText(`검색 범위 ${label} 안에서 검색`);
    await expect(page.locator('.sa-context')).not.toContainText('스팸·휴지통 제외');
    await selectAll(page);
    await expect(page.locator('.sa-tools').getByRole('button',{name:'영구 삭제',exact:true})).toBeVisible();
    await expect(page.locator('.foot')).toContainText('영구 삭제');
    await page.locator('.sa-tools').getByRole('button',{name:'영구 삭제',exact:true}).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading')).toHaveText('51통을 영구 삭제할까요?');
    await expect(dialog).toContainText('복구할 수 없어요.');
    await expect(dialog.locator('dl')).toContainText(`${label} 안에서 검색`);
    await expect(dialog.locator('dl')).toContainText(q);
    await expect(dialog).toContainText('확인을 누른 뒤 도착한 메일은 포함 안 돼요.');
    noPosts(model);
    await page.screenshot({path:`${captures}/v1-${folder.toLowerCase()}-confirm.png`});
    await dialog.getByRole('button',{name:'취소',exact:true}).click();
    noPosts(model);
    const latestList = [...model.requests].reverse().find(record => record.path === '/api/messages');
    assert.ok(latestList);
    const params = new URL(latestList.url).searchParams;
    assert.equal(params.get('view'),view);assert.equal(params.get('folder') || '',view === 'folder' ? folder : '');assert.equal(params.get('q'),q);
  });

  const actionCases = [
    ['seen','읽음 표시','읽음으로 표시할까요?','읽음 표시 중','읽음 표시를 마쳤어요'],
    ['unseen','읽지 않음 표시','읽지 않음으로 표시할까요?','읽지 않음 표시 중','읽지 않음 표시를 마쳤어요'],
    ['flag','별표','별표를 붙일까요?','별표 추가 중','별표를 붙였어요'],
    ['unflag','별표 해제','별표를 해제할까요?','별표 해제 중','별표를 해제했어요'],
    ['move','폴더로 옮기기','다른 폴더로 옮길까요?','폴더로 옮기는 중','폴더로 옮겼어요'],
    ['archive','보관','보관할까요?','보관 중','보관을 마쳤어요'],
    ['trash','휴지통으로 옮기기','휴지통으로 옮길까요?','휴지통으로 옮기는 중','휴지통으로 옮겼어요'],
    ['spam','스팸 신고','스팸으로 신고할까요?','스팸 신고 중','스팸으로 신고했어요'],
    ['notspam','스팸 아님','스팸 아님으로 처리할까요?','스팸 아님 처리 중','스팸 아님으로 처리했어요'],
    ['delete-forever','영구 삭제','영구 삭제할까요?','영구 삭제 중','영구 삭제를 마쳤어요'],
  ];
  async function chooseAction(page, action) {
    if (['unseen','flag','unflag'].includes(action)) {
      await page.locator('.sa-tools').getByRole('button',{name:'더 보기',exact:true}).click();
      await page.locator(`[data-sa-action="${action}"]`).click();
    } else if (action === 'move') {
      await page.locator('[data-sa-action="move"]').click();
      await page.getByRole('menuitem',{name:'거래처',exact:true}).click();
    } else await page.locator(`[data-sa-action="${action}"]`).click();
  }
  async function startAction(page, action = 'seen') {
    await selectAll(page);await chooseAction(page,action);
    await page.getByRole('dialog').locator('button[type="submit"]').click();
  }
  async function progress(page, attempted, total, processed, skipped, failed) {
    const root = page.locator('.sa-progress'), bar = root.getByRole('progressbar');
    await expect(root).toContainText(`시도 ${attempted} / ${total}`);
    await expect(bar).toHaveAttribute('aria-valuenow',String(attempted));
    await expect(bar).toHaveAttribute('aria-valuemax',String(total));
    await expect(bar).toHaveAttribute('aria-valuetext',`${attempted} / ${total}통 시도`);
    await expect(root).toContainText(`처리 ${processed}통 · 건너뜀 ${skipped}통 · 실패 ${failed}통`);
  }
  // Let a completed route response reach the fetch continuation and paint. There
  // is no elapsed-time grace period in the next-request-count assertions.
  async function painted(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }

  for (const [action,label,question,running,done] of actionCases) await t.test(`${action}: confirmation, progress, result and scope contract`,async t => {
    const first = deferred(), second = deferred();
    t.after(() => {first.resolve();second.resolve();});
    let calls = 0;
    const scope = scopeOf(action === 'notspam' ? {view:'spam'} : action === 'delete-forever' ? {view:'folder',folder:'Trash'} : {});
    const expected = {scope,action,...(action === 'move'?{target:'거래처'}:{})};
    const {page,model} = await pageFor(t,{inbox:51,route:action === 'notspam'?'spam':action === 'delete-forever'?'f/Trash':'inbox',handlers:{execute:async ({record,reply}) => {
      const sequence = calls++;
      assertActionRequest(record,{...expected,cursor:`synthetic-selection-1-execute-${sequence}`});
      await (sequence === 0 ? first.promise : second.promise);
      return reply(sequence === 0
        ? receipt('synthetic-selection-1',0,51,{processed:20,skipped:3,failed:0})
        : receipt('synthetic-selection-1',1,51,{processed:48,skipped:3,failed:0},{delta:{processed:28,skipped:0,failed:0},completed:true}));
    }}});
    await selectAll(page);await chooseAction(page,action);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading')).toHaveText(`51통을 ${question}`);
    await expect(dialog.locator('button[type="submit"]')).toHaveText(`51통 ${label}`);
    if (action === 'move') await expect(dialog.locator('dd').last()).toHaveText('거래처');
    noPosts(model);
    await dialog.locator('button[type="submit"]').click();
    await expect.poll(() => calls).toBe(1);
    await expect(page.locator('.sa-progress')).toContainText(running);
    await progress(page,0,51,0,0,0);
    first.resolve();await expect.poll(() => calls).toBe(2);
    await progress(page,23,51,20,3,0);
    if (action === 'move') await page.screenshot({path:`${captures}/v2-move-progress.png`});
    second.resolve();
    const result = page.locator('.sa-result');
    await expect(result).toContainText(done);
    await expect(result.locator('.sa-counts')).toHaveText('처리 48통 · 건너뜀 3통 · 실패 0통');
    await expect(result).toContainText('그새 조건에서 벗어났거나 이미 없어진 메일');
    assert.equal(model.prepares().length,1);assert.equal(model.executions().length,2);
    assertActionRequest(model.prepares()[0],{...expected,cursor:null});
    assert.equal(model.posts().filter(record => record.path === '/api/messages/actions').length,0);
  });

  await t.test('attempted progress includes successes, skips and failures while processed stays successes only',async t => {
    const gate = deferred();t.after(() => gate.resolve());
    let calls = 0;
    const failed = [
      {ref:message('INBOX',110).ref,code:'MAIL_UNAVAILABLE',retryable:true},
      {ref:message('INBOX',111).ref,code:'ACTION_OUTCOME_UNKNOWN',retryable:false},
    ];
    const {page,model} = await pageFor(t,{inbox:120,handlers:{execute:async ({reply}) => {
      const sequence = calls++;
      if (sequence === 0) return reply(receipt('synthetic-selection-1',0,120,{processed:20,skipped:2,failed:2},{failed}));
      await gate.promise;
      return reply(receipt('synthetic-selection-1',1,120,{processed:40,skipped:2,failed:2},{delta:{processed:20,skipped:0,failed:0}}));
    }}});
    await startAction(page);await expect.poll(() => calls).toBe(2);
    await progress(page,24,120,20,2,2);
    await page.screenshot({path:`${captures}/v2-mixed-progress.png`});
    await page.getByRole('button',{name:'멈추기',exact:true}).click();gate.resolve();
    await expect(page.locator('.sa-result .sa-counts')).toHaveText('처리 40통 · 건너뜀 2통 · 실패 2통');
    await painted(page);assert.equal(model.executions().length,2);
  });

  function stoppedFixture() {
    const first = deferred();
    const id = 'synthetic-selection-1';
    let calls = 0;
    return {first,id,get calls() {return calls;},handlers:{execute:async ({model,record,reply}) => {
      const sequence = calls++;
      assertActionRequest(record,{scope:scopeOf(),action:'seen',cursor:`${id}-execute-${sequence}`});
      const failed = [
        {ref:message('INBOX',110).ref,code:'MAIL_UNAVAILABLE',retryable:true},
        {ref:message('INBOX',111).ref,code:'ACTION_OUTCOME_UNKNOWN',retryable:false},
      ];
      if (sequence === 0) {
        await first.promise;
        return reply(receipt(id,0,120,{processed:20,skipped:2,failed:2},{failed}));
      }
      return reply(receipt(id,1,120,{processed:116,skipped:2,failed:2},{delta:{processed:96,skipped:0,failed:0},completed:true}));
    },failed:async ({reply}) => reply({total:2,page:1,pageSize:50,items:[
      {...message('INBOX',110),code:'MAIL_UNAVAILABLE',retryable:true},
      {...message('INBOX',111),code:'ACTION_OUTCOME_UNKNOWN',retryable:false},
    ]})}};
  }
  async function stopAfterFirst(page,model,fixture) {
    await startAction(page);await expect.poll(() => fixture.calls).toBe(1);
    await page.getByRole('button',{name:'멈추기',exact:true}).click();
    await expect(page.locator('.sa-progress')).toContainText('멈추는 중');
    fixture.first.resolve();
    const result = page.locator('.sa-result');
    await expect(result).toContainText('읽음 표시 중단');
    await expect(result.locator('.sa-counts')).toHaveText('처리 20통 · 건너뜀 2통 · 실패 2통');
    await expect(result).toContainText('남은 96통은 처리하지 않았어요.');
    await expect(result.getByRole('button',{name:'남은 것 이어서',exact:true})).toBeVisible();
    await expect(result.getByRole('button',{name:'실패만 다시',exact:true})).toBeVisible();
    await painted(page);assert.equal(model.executions().length,1);
  }

  await t.test('stop sends no next request; resume uses the same record and excludes settled failures',async t => {
    const fixture = stoppedFixture();t.after(() => fixture.first.resolve());
    const {page,model} = await pageFor(t,{inbox:120,handlers:fixture.handlers});
    await stopAfterFirst(page,model,fixture);
    await page.screenshot({path:`${captures}/v2-stopped.png`});
    await page.getByRole('button',{name:'남은 것 이어서',exact:true}).click();
    await expect(page.locator('.sa-result .sa-counts')).toHaveText('처리 116통 · 건너뜀 2통 · 실패 2통');
    await expect(page.locator('#page-title')).toHaveText('실패한 메일');
    await expect(page.locator('.m')).toHaveCount(2);
    assert.equal(model.prepares().length,1);assert.equal(model.executions().length,2);
    assert.equal(model.executions()[1].body.cursor,`${fixture.id}-execute-1`);
    assert.deepEqual(await page.locator('.m').evaluateAll(elements => elements.map(element => element.dataset.ref)),[message('INBOX',110).ref,message('INBOX',111).ref]);
    await expect(page.locator('.sa-result')).toContainText('실제 적용되었을 수 있어요');
    await expect(page.locator('.sa-result')).toContainText('이 메일은 다시 실행하지 않아요');
  });

  await t.test('stopped failures retry through a new record and key, preserving scope/action and excluding unknown',async t => {
    const fixture = stoppedFixture();t.after(() => fixture.first.resolve());
    const handlers = {...fixture.handlers};
    let retry = false;
    handlers.prepare = async ({model,record,reply}) => {
      retry = record.body.retry === 'failed';
      if (!retry) return reply(ready(fixture.id,120));
      assert.equal(record.body.selectionId,fixture.id);
      assert.equal(record.body.cursor,null);
      assert.notEqual(record.body.selectionKey,model.prepares()[0].body.selectionKey);
      return reply(ready('synthetic-retry-2',1));
    };
    handlers.execute = async input => {
      if (!retry) return fixture.handlers.execute(input);
      assertActionRequest(input.record,{scope:scopeOf(),action:'seen',cursor:'synthetic-retry-2-execute-0'});
      return input.reply(receipt('synthetic-retry-2',0,1,{processed:1,skipped:0,failed:0},{completed:true}));
    };
    const {page,model} = await pageFor(t,{inbox:120,handlers});
    await stopAfterFirst(page,model,fixture);
    await page.getByRole('button',{name:'실패만 다시',exact:true}).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading')).toHaveText('1통을 읽음으로 표시할까요?');
    await expect(dialog).toContainText('다시 실행할 수 있는 실패 메일만');
    await expect(dialog).toContainText('결과가 불명확한 메일은 제외해요.');
    assert.equal(model.prepares().length,1);
    await dialog.locator('button[type="submit"]').click();
    await expect(page.locator('.sa-result .sa-counts')).toHaveText('처리 1통 · 건너뜀 0통 · 실패 0통');
    assert.equal(model.prepares().length,2);assert.equal(model.executions().length,2);
    const body = model.prepares()[1].body;
    assertActionRequest(model.prepares()[1],{scope:scopeOf(),action:'seen',cursor:null});
    assert.equal(body.retry,'failed');assert.equal(body.selectionId,fixture.id);
    // The browser sends the server failure-record identity, never a new search
    // result or a client-supplied refs list. Filtering is the server's contract.
    assert.equal(Object.hasOwn(body,'refs'),false);
    assert.equal(model.executions()[1].body.cursor,'synthetic-retry-2-execute-0');
  });

  await t.test('completed failures retry a new record while retaining original search and move destination',async t => {
    const q = 'from:sender@example.com in:INBOX', scope = scopeOf({view:'allmail',q});
    const expected = {scope,action:'move',target:'거래처'};
    let retry = false;
    const failed = {ref:message('INBOX',50).ref,code:'MAIL_UNAVAILABLE',retryable:true};
    const {page,model} = await pageFor(t,{inbox:51,route:`search/${encodeURIComponent(q)}`,handlers:{
      prepare:async ({record,model,reply}) => {
        assertActionRequest(record,{...expected,cursor:null});
        retry = record.body.retry === 'failed';
        if (retry) {
          assert.equal(record.body.selectionId,'synthetic-original');
          assert.notEqual(record.body.selectionKey,model.prepares()[0].body.selectionKey);
        }
        return reply(ready(retry?'synthetic-retry':'synthetic-original',retry?1:51));
      },
      execute:async ({record,reply}) => {
        const id = retry?'synthetic-retry':'synthetic-original';
        assertActionRequest(record,{...expected,cursor:`${id}-execute-0`});
        return reply(receipt(id,0,retry?1:51,{processed:retry?1:50,skipped:0,failed:retry?0:1},{failed:retry?[]:[failed],completed:true}));
      },
      failed:async ({reply}) => reply({total:1,page:1,pageSize:50,items:[{...message('INBOX',50),...failed}]}),
    }});
    await startAction(page,'move');
    await expect(page.locator('#page-title')).toHaveText('실패한 메일');
    await page.getByRole('button',{name:'실패만 다시',exact:true}).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading')).toHaveText('1통을 다른 폴더로 옮길까요?');
    await expect(dialog.locator('dl')).toContainText(q);
    await expect(dialog.locator('dd').last()).toHaveText('거래처');
    assert.equal(model.prepares().length,1);
    await dialog.locator('button[type="submit"]').click();
    await expect(page.locator('.sa-result .sa-counts')).toHaveText('처리 1통 · 건너뜀 0통 · 실패 0통');
    assert.equal(model.prepares().length,2);assert.equal(model.executions().length,2);
    assert.equal(model.prepares()[1].body.retry,'failed');
    assert.equal(model.prepares()[1].body.selectionId,'synthetic-original');
  });

  await t.test('completed failure-only view paginates server failures beyond the original second page',async t => {
    const failures = Array.from({length:52},(_,index) => ({...message('INBOX',index+68),code:'MAIL_UNAVAILABLE',retryable:true}));
    const {page,model} = await pageFor(t,{inbox:120,handlers:{
      execute:async ({reply}) => reply(receipt('synthetic-selection-1',0,120,{processed:68,skipped:0,failed:52},{failed:failures.map(({ref,code,retryable}) => ({ref,code,retryable})),completed:true})),
      failed:async ({record,reply}) => {
        const params = new URL(record.url).searchParams, number = Number(params.get('page'));
        assert.equal(params.get('pageSize'),'50');
        return reply({total:52,page:number,pageSize:50,items:failures.slice((number-1)*50,number*50)});
      },
    }});
    await startAction(page);
    await expect(page.locator('#page-title')).toHaveText('실패한 메일');
    await expect(page.locator('.m')).toHaveCount(50);
    assert.deepEqual(await page.locator('.m').evaluateAll(elements => elements.map(element => element.dataset.ref)),failures.slice(0,50).map(item => item.ref));
    await expect(page.locator(`.m[data-ref="${message('INBOX',110).ref}"]`)).toBeVisible();
    const ordinaryReads = model.requests.filter(record => record.path === '/api/messages').length;
    await page.getByRole('button',{name:'다음 페이지',exact:true}).click();
    await expect(page.locator('.m')).toHaveCount(2);
    assert.deepEqual(await page.locator('.m').evaluateAll(elements => elements.map(element => element.dataset.ref)),failures.slice(50).map(item => item.ref));
    assert.equal(model.requests.filter(record => record.path === '/api/messages').length,ordinaryReads);
    assert.equal(model.requests.filter(record => /\/failed$/.test(record.path)).length,2);
    await page.screenshot({path:`${captures}/v2-failures-page-2.png`});
    await page.getByRole('button',{name:'메일함으로 돌아가기',exact:true}).click();
    await expect(page.locator('#page-title')).toHaveText('받은편지함');
    await expect(page.locator('.sa-result')).toHaveCount(0);
    await expect.poll(() => model.requests.filter(record => record.path === '/api/messages').length).toBe(ordinaryReads+1);
  });

  await t.test('unknown-only result warns, has no retry button, and sends no automatic execution',async t => {
    const failed = {ref:message('INBOX',110).ref,code:'ACTION_OUTCOME_UNKNOWN',retryable:false};
    const {page,model} = await pageFor(t,{inbox:120,handlers:{
      execute:async ({reply}) => reply(receipt('synthetic-selection-1',0,120,{processed:119,skipped:0,failed:1},{failed:[failed],completed:true})),
      failed:async ({reply}) => reply({total:1,page:1,pageSize:50,items:[{...message('INBOX',110),...failed}]}),
    }});
    await startAction(page);
    await expect(page.locator('.sa-result')).toContainText('결과가 불명확한 메일 1통');
    await expect(page.locator('.sa-result')).toContainText('실제 적용되었을 수 있어요');
    await expect(page.locator('.sa-result')).toContainText('이 메일은 다시 실행하지 않아요');
    await expect(page.getByRole('button',{name:'실패만 다시',exact:true})).toHaveCount(0);
    await expect(page.locator('.m')).toContainText('결과 확인 필요');
    await expect(rowChecks(page)).toBeDisabled();
    await painted(page);assert.equal(model.executions().length,1);assert.equal(model.prepares().length,1);
  });

  await t.test('lost response reuses the exact last cursor and assigns cumulative totals once',async t => {
    const id = 'synthetic-selection-1', hits = new Map();
    const {page,model} = await pageFor(t,{inbox:51,handlers:{execute:async ({route,record,reply}) => {
      const cursor = record.body.cursor, count = (hits.get(cursor)||0)+1;hits.set(cursor,count);
      if (cursor === `${id}-execute-0`) return reply(receipt(id,0,51,{processed:20,skipped:0,failed:0}));
      if (cursor === `${id}-execute-1`) {
        if (count === 1) return route.abort('failed');
        return reply(receipt(id,1,51,{processed:40,skipped:0,failed:0},{delta:{processed:20,skipped:0,failed:0}}));
      }
      assert.equal(cursor,`${id}-execute-2`);
      return reply(receipt(id,2,51,{processed:51,skipped:0,failed:0},{delta:{processed:11,skipped:0,failed:0},completed:true}));
    }}});
    await startAction(page);
    await expect(page.locator('.sa-result')).toContainText('응답을 받지 못했어요');
    await expect(page.locator('.sa-result .sa-counts')).toHaveText('처리 20통 · 건너뜀 0통 · 실패 0통');
    assert.equal(model.executions().length,2);
    await page.getByRole('button',{name:'남은 것 이어서',exact:true}).click();
    await expect(page.locator('.sa-result .sa-counts')).toHaveText('처리 40통 · 건너뜀 0통 · 실패 0통');
    await painted(page);assert.equal(model.executions().length,3);
    assert.deepEqual(model.executions()[1].body,model.executions()[2].body);
    await page.getByRole('button',{name:'남은 것 이어서',exact:true}).click();
    await expect(page.locator('.sa-result')).toContainText('읽음 표시를 마쳤어요');
    await expect(page.locator('.sa-result .sa-counts')).toHaveText('처리 51통 · 건너뜀 0통 · 실패 0통');
    assert.equal(model.prepares().length,1);assert.equal(model.executions().length,4);
    assert.deepEqual([...hits.values()],[1,2,1]);
  });

  for (const change of ['condition','screen']) await t.test(`${change} change during execution prevents the next batch`,async t => {
    const gate = deferred();t.after(() => gate.resolve());
    const {page,model} = await pageFor(t,{inbox:120,handlers:{execute:async ({reply}) => {
      await gate.promise;
      return reply(receipt('synthetic-selection-1',0,120,{processed:20,skipped:0,failed:0}));
    }}});
    await startAction(page);await expect.poll(() => model.executions().length).toBe(1);
    if (change === 'condition') {
      await waitList(page,() => page.getByRole('group',{name:'빠른 보기'}).getByRole('button',{name:'읽지 않음',exact:true}).click());
      await allCleared(page);
    } else {
      await page.locator('a.nv[href="#storage"]').click();
      await expect(page.locator('[data-page="storage"]')).toBeVisible();
    }
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/messages/actions/scope');
    gate.resolve();await response;await painted(page);
    assert.equal(model.executions().length,1);assert.equal(model.prepares().length,1);
    if (change === 'condition') await allCleared(page);
    else await expect(page.locator('[data-page="storage"]')).toBeVisible();
  });

});
