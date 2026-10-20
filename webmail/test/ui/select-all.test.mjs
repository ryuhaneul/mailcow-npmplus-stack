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

await test('select-all V1: selection and confirmation', async t => {
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
});
