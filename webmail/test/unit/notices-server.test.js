import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeNotice } from '../../server/notices/sanitize.js';
import { createNoticesStore } from '../../server/notices/store.js';
import { createNoticesService } from '../../server/admin/services/notices.js';
import { createApp } from '../../server/app.js';
import { createAdminApp } from '../../server/admin/app.js';
import { loadAdminConfig } from '../../server/admin/config.js';

const draft = overrides => ({ title: 'Synthetic notice', bodyHtml: '<p>Hello <strong>reader</strong></p>', category: 'info', audienceAll: true, domains: [], pinned: false, publish: false, ...overrides });
const origin = 'https://newmail.example.test', adminOrigin = 'https://mailadmin.example.test';
const dbError = code => Object.assign(new Error('synthetic storage failure (must not leave the server)'), { code });
const version = tick => `2026-10-28 05:00:00.${String(tick).padStart(6, '0')}`;

// This models SQL statements and transaction boundaries only. Real MariaDB
// locking, grants and concurrent snapshots still require the separate VM gate.
function database() {
  let state = { rows: [], domains: [], reads: {}, counter: 0, nextId: 1, tick: 0 };
  let queue = Promise.resolve();
  const events = [], faults = { code: null, mutation: false, grants: false, sql: null };
  const permissions = {
    webmail: { notices: 'SELECT', notice_domains: 'SELECT', notice_reads: 'SELECT, INSERT, UPDATE' },
    admin: { notices: 'SELECT, INSERT, UPDATE, DELETE', notice_domains: 'SELECT, INSERT, UPDATE, DELETE', notice_counter: 'SELECT, UPDATE' },
  };
  const visibleRows = (data, domain) => data.rows.filter(row => row.state === 'published' && (row.audience_all === 1 || data.domains.some(item => item.notice_id === row.id && item.domain === domain)));
  function pool(role) {
    function check(sql) {
      if (faults.code) throw dbError(faults.code);
      if (role === 'admin' && /notice_reads|mailcow\./.test(sql)) throw dbError('ER_TABLEACCESS_DENIED_ERROR');
      if (role === 'webmail' && /notice_counter/.test(sql)) throw dbError('ER_TABLEACCESS_DENIED_ERROR');
    }
    async function query(sql) {
      check(sql); assert.equal(sql, 'SHOW GRANTS FOR CURRENT_USER()');
      const rows = Object.entries(permissions[role]).map(([table, held]) => ({ grant: `GRANT ${faults.grants && table === (role === 'admin' ? 'notice_counter' : 'notice_reads') ? 'SELECT' : held} ON \`mailstack_webmail\`.\`${table}\` TO 'synthetic'@'synthetic'` }));
      return [rows, []];
    }
    async function execute(sql, args = [], data = state, connection) {
      check(sql); events.push({ sql, args: [...args], role });
      if (sql.includes('LIMIT 0')) return [[], []];
      if (sql === 'SELECT id,next_seq FROM mailstack_webmail.notice_counter WHERE id = 1') return [[{ id: 1, next_seq: data.counter }], []];
      if (/^(INSERT|UPDATE|DELETE)/.test(sql)) {
        if (faults.mutation || faults.sql && sql.includes(faults.sql)) throw dbError('ER_TABLEACCESS_DENIED_ERROR');
        assert.ok(connection, 'all writes require a transaction');
        if (role === 'webmail') assert.match(sql, /^INSERT INTO mailstack_webmail.notice_reads /);
      }
      if (sql.startsWith('SELECT last_seen_seq')) return [[...(data.reads[args[0]] === undefined ? [] : [{ last_seen_seq: data.reads[args[0]] }])], []];
      if (sql.startsWith('SELECT COUNT(*) AS unread_count')) return [[{ unread_count: visibleRows(data, args[0]).filter(row => row.publish_seq > args[1]).length }], []];
      if (sql.startsWith('SELECT COALESCE(MAX(n.publish_seq)')) return [[{ max_seq: Math.max(0, ...visibleRows(data, args[0]).map(row => row.publish_seq)) }], []];
      if (sql.startsWith('INSERT INTO mailstack_webmail.notice_reads')) {
        data.reads[args[0]] = Math.max(data.reads[args[0]] ?? 0, args[1]); return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('SELECT n.*')) {
        assert.match(sql, /n\.state = 'published' AND \(n\.audience_all = 1 OR EXISTS/);
        let rows = visibleRows(data, args[0]).sort((a,b) => b.publish_seq - a.publish_seq);
        if (sql.includes('n.pinned = 1')) rows = rows.filter(row => row.pinned === 1);
        if (sql.includes('n.pinned = 0')) rows = rows.filter(row => row.pinned === 0);
        if (sql.includes('n.publish_seq < ?')) rows = rows.filter(row => row.publish_seq < args[1]);
        if (sql.includes('LIMIT 51')) rows = rows.slice(0,51);
        if (sql.includes('LIMIT 5') && !sql.includes('LIMIT 51')) rows = rows.slice(0,5);
        return [structuredClone(rows), []];
      }
      if (sql.startsWith('SELECT domain FROM')) return [data.domains.filter(row => row.notice_id === Number(args[0])).sort((a,b) => a.domain.localeCompare(b.domain)).map(row => ({ domain: row.domain })), []];
      if (sql.startsWith('SELECT * FROM mailstack_webmail.notices')) {
        const rows = sql.includes('WHERE id = ?') ? data.rows.filter(row => row.id === Number(args[0])) : data.rows.filter(row => !sql.includes('WHERE state = ?') || row.state === args[0]).sort((a,b) => b.id-a.id);
        if (sql.includes('FOR UPDATE')) assert.ok(connection);
        return [structuredClone(rows), []];
      }
      if (sql.startsWith('INSERT INTO mailstack_webmail.notices ')) {
        const id = data.nextId++;
        data.rows.push({ id, title: args[0], body_html: args[1], category: args[2], audience_all: args[3], pinned: args[4], state: 'draft', updated_by: args[5], publish_seq: null, published_at: null, created_at: version(++data.tick), updated_at: version(data.tick) });
        return [{ insertId: id, affectedRows: 1 }, []];
      }
      if (sql.startsWith('DELETE FROM mailstack_webmail.notice_domains')) { data.domains = data.domains.filter(row => row.notice_id !== args[0]); return [{ affectedRows: 1 }, []]; }
      if (sql.startsWith('INSERT INTO mailstack_webmail.notice_domains')) { data.domains.push({ notice_id: args[0], domain: args[1] }); return [{ affectedRows: 1 }, []]; }
      if (sql.startsWith('DELETE FROM mailstack_webmail.notices')) { data.rows = data.rows.filter(row => row.id !== args[0]); data.domains = data.domains.filter(row => row.notice_id !== args[0]); return [{ affectedRows: 1 }, []]; }
      if (sql.startsWith('UPDATE mailstack_webmail.notice_counter')) {
        assert.equal(sql, 'UPDATE mailstack_webmail.notice_counter SET next_seq = LAST_INSERT_ID(next_seq + 1) WHERE id = 1');
        connection.lastId = ++data.counter; return [{ affectedRows: 1 }, []];
      }
      if (sql === 'SELECT LAST_INSERT_ID() AS seq') return [[{ seq: connection.lastId }], []];
      if (sql.startsWith('UPDATE mailstack_webmail.notices')) {
        const row = data.rows.find(item => item.id === Number(args.at(-1))); assert.ok(row);
        if (sql.includes('title = ?')) Object.assign(row, { title: args[0], body_html: args[1], category: args[2], audience_all: args[3], pinned: args[4], updated_by: args[5] });
        else if (sql.includes('publish_seq = ?')) { row.publish_seq = Number(args[0]); row.published_at = connection.timeZone === '+00:00' ? '2026-10-28 06:00:00' : '2026-10-28 15:00:00'; }
        else {
          if (sql.includes("state = 'published'")) row.state = 'published';
          if (sql.includes("state = 'hidden'")) row.state = 'hidden';
          if (sql.includes('pinned = 1')) row.pinned = 1;
          if (sql.includes('pinned = 0')) row.pinned = 0;
          row.updated_by = args[0];
        }
        row.updated_at = version(++data.tick); return [{ affectedRows: 1 }, []];
      }
      throw new Error(`unsupported synthetic SQL: ${sql}`);
    }
    return {
      execute, query, async end() {},
      async getConnection() {
        let unlock, local, begun = false;
        const connection = {
          lastId: 0, timeZone: 'Asia/Seoul',
          async query(sql) {
            check(sql); assert.equal(sql, "SET time_zone = '+00:00'");
            this.timeZone = '+00:00'; events.push({ sql, role });
            return [[], []];
          },
          async beginTransaction() {
            assert.equal(this.timeZone, '+00:00', 'server timezone must be UTC before reading or writing timestamps');
            const previous = queue; queue = new Promise(resolve => { unlock = resolve; }); await previous;
            local = structuredClone(state); begun = true; events.push({ transaction: 'begin', role });
          },
          execute: (sql,args) => execute(sql,args,local,connection),
          async commit() { state = local; events.push({ transaction: 'commit', role }); },
          async rollback() { events.push({ transaction: 'rollback', role }); },
          release() { if (begun) unlock(); events.push({ transaction: 'release', role }); },
        };
        return connection;
      },
    };
  }
  const admin = createNoticesStore({ db: pool('admin'), mode: 'admin' });
  const user = createNoticesStore({ db: pool('webmail') });
  const auditRows = [];
  const audit = { async run(entry, operation) { auditRows.push(entry); return operation({ id: 'synthetic-audit' }); } };
  const domains = { async list() { return { items: [{ domain: 'example.test', active: true }, { domain: 'other.test', active: true }, { domain: 'inactive.test', active: false }] }; } };
  const service = createNoticesService({ store: admin, domains, audit });
  const save = (data = {}, id) => service.save({ session: {}, actor: 'admin', ip: '192.0.2.4', id: id === undefined ? undefined : String(id), data: draft(data) });
  const change = (row, action) => service.change({ session: {}, actor: 'admin', ip: '192.0.2.4', id: String(row.id), data: { updatedAt: row.updatedAt }, action });
  return { admin, user, service, pool, faults, events, auditRows, save, change, get state() { return state; } };
}

for (const [name, html] of [
  ['allowed formatting', '<p>Hello<br><strong>bold</strong><b>b</b><em>e</em><i>i</i></p><ul><li>item</li></ul><ol><li>n</li></ol>'],
  ['safe links', '<p><a href="https://example.test/path">https</a><a href="http://example.test">http</a><a href="mailto:a@example.test">mail</a></p>'],
]) test(`notices sanitizer preserves ${name} and is idempotent`, () => {
  const clean = sanitizeNotice(html); assert.equal(clean.empty, false); assert.deepEqual(sanitizeNotice(clean.bodyHtml), clean);
  if (name === 'safe links') { assert.equal((clean.bodyHtml.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length,3); }
  else assert.equal(clean.bodyHtml, html);
});
test('notices sanitizer strips active content, attributes, unsupported tags and unsafe URI schemes', () => {
  const clean = sanitizeNotice('<script>alert(1)</script><style>x{}</style><iframe src="https://example.test"></iframe><p href="https://example.test" style="color:red" class="x" onclick="bad()" data-x="y" aria-label="bad">ok<img src=x onerror=bad()></p><svg onload="bad()"></svg><a href="javascript:alert(1)">js</a><a href="data:text/html,bad">data</a><a href="/relative">relative</a><a href="//example.test">protocol-relative</a><a href="jav&#x61;script:bad">entity</a>');
  assert.doesNotMatch(clean.bodyHtml, /script|style|iframe|img|svg|onclick|onerror|onload|data-x|aria-label|class=|href=/i);
  assert.match(clean.bodyHtml, /<p>ok<\/p>/);
});
for (const html of ['', '<p><br></p>', '<p>&nbsp; \u200b</p>', '<script>hidden</script><img src=x>']) test(`notices sanitizer detects empty text ${JSON.stringify(html)}`, () => assert.equal(sanitizeNotice(html).empty,true));

test('notices store: audience, ordering, pins, recent five, lowercased watermark and HTML re-sanitization', async () => {
  const f=database();
  await f.save({ publish: false, title: 'draft' });
  const hidden=await f.save({ publish:true,title:'hidden' }); await f.change(hidden,'hide');
  const foreign=await f.save({ publish:true,title:'foreign',audienceAll:false,domains:['other.test'] });
  const pinned=await f.save({ publish:true,title:'pinned',pinned:true });
  const targeted=await f.save({ publish:true,title:'targeted',audienceAll:false,domains:['EXAMPLE.TEST','example.test'] });
  for(let n=0;n<6;n++) await f.save({ publish:true,title:`recent ${n}` });
  const list=await f.user.list('Reader@EXAMPLE.TEST');
  assert.equal(list.enabled,true); assert.equal(list.unreadCount,8); assert.equal(list.pinned.length,1); assert.equal(list.items.length,5);
  assert.equal(list.pinned[0].id,pinned.id); assert.ok(list.items.every(row=>!row.pinned));
  assert.deepEqual(list.items.map(row=>row.title),['recent 5','recent 4','recent 3','recent 2','recent 1']);
  const all=await f.user.list('reader@example.test',{scope:'all'}); assert.equal(all.items.length,8);
  assert.ok(all.items.some(row=>row.id===targeted.id)); assert.ok(!all.items.some(row=>row.id===foreign.id));
  f.state.rows.find(row=>row.id===pinned.id).body_html='<p onclick="bad()">ok<img src=x></p>';
  assert.equal((await f.user.list('reader@example.test')).pinned[0].bodyHtml,'<p>ok</p>');
  await f.user.seen('Reader@EXAMPLE.TEST',list.maxSeq); assert.equal(f.state.reads['reader@example.test'],list.maxSeq);
  assert.equal((await f.user.unread('reader@example.test')).unreadCount,0);
  assert.ok((await f.user.list('reader@example.test')).items.every(row=>!row.unread));
});

test('notices store: all-page cursor is exclusive, includes pins once, 50 rows then remainder', async () => {
  const f=database(); for(let n=0;n<53;n++) await f.save({publish:true,pinned:n%4===0});
  const first=await f.user.list('reader@example.test',{scope:'all'});
  assert.equal(first.items.length,50); assert.equal(first.nextBefore,4);
  const last=await f.user.list('reader@example.test',{scope:'all',before:first.nextBefore});
  assert.deepEqual(last.items.map(row=>row.seq),[3,2,1]); assert.equal(last.nextBefore,null);
  assert.equal(new Set([...first.items,...last.items].map(row=>row.id)).size,53);
});

test('notices store: capped seen, concurrent maxima, new publication while open, no foreign owner writes', async () => {
  const f=database(); await f.save({publish:true}); const opened=await f.user.list('reader@example.test');
  const newer=await f.save({publish:true});
  assert.deepEqual(await f.user.seen('reader@example.test',opened.maxSeq),{unreadCount:1});
  await Promise.all([f.user.seen('Reader@EXAMPLE.TEST',newer.seq),f.user.seen('reader@example.test',0)]);
  assert.equal(f.state.reads['reader@example.test'],newer.seq);
  const foreign=await f.save({publish:true,audienceAll:false,domains:['other.test']});
  await f.user.seen('reader@example.test',Number.MAX_SAFE_INTEGER);
  assert.equal(f.state.reads['reader@example.test'],newer.seq); assert.ok(foreign.seq>newer.seq);
  assert.deepEqual(Object.keys(f.state.reads),['reader@example.test']);
  assert.equal((await f.user.unread('other@other.test')).unreadCount,3);
});

test('notices store: first publish serializes counter, edit/hide/republish preserve seq/time; deletions never reset counter', async () => {
  const f=database(); const rows=await Promise.all(Array.from({length:10},()=>f.save({publish:true})));
  assert.deepEqual(rows.map(row=>row.seq).sort((a,b)=>a-b),[1,2,3,4,5,6,7,8,9,10]);
  const original=rows[0]; let row=await f.save({title:'edited',updatedAt:original.updatedAt},original.id);
  assert.equal(row.seq,original.seq); assert.equal(row.publishedAt,original.publishedAt);
  await f.user.seen('reader@example.test',10);
  row=await f.change(row,'hide'); row=await f.change(row,'publish');
  assert.equal(row.seq,original.seq); assert.equal(row.publishedAt,original.publishedAt); assert.equal((await f.user.unread('reader@example.test')).unreadCount,0);
  row=await f.change(row,'pin'); assert.equal(row.pinned,true); row=await f.change(row,'unpin'); assert.equal(row.pinned,false);
  for(const item of f.state.rows.slice()) await f.change(await f.admin.adminGet(item.id),'delete');
  assert.equal(f.state.rows.length,0); assert.equal(f.state.counter,10);
  assert.equal((await f.save({publish:true})).seq,11);
  const lockAt=f.events.findIndex(event=>event.sql?.endsWith('WHERE id = ? FOR UPDATE'));
  assert.ok(lockAt>=0); assert.ok(f.events.some(event=>event.sql==='SELECT LAST_INSERT_ID() AS seq'));
});

test('notices UTC session: 15:00 Asia/Seoul publication is 06:00Z for admin and webmail', async () => {
  const f=database(); const row=await f.save({publish:true});
  assert.equal(row.publishedAt,'2026-10-28T06:00:00Z');
  assert.equal((await f.admin.adminGet(row.id)).publishedAt,row.publishedAt);
  assert.equal((await f.user.list('reader@example.test')).items[0].publishedAt,row.publishedAt);
  for(const role of ['admin','webmail']) {
    const events=f.events.filter(event=>event.role===role);
    const begins=events.filter(event=>event.transaction==='begin');
    assert.ok(begins.length>0);
    assert.equal(events.filter(event=>event.sql==="SET time_zone = '+00:00'").length,begins.length);
    for(const [index,event] of events.entries())if(event.transaction==='begin')assert.equal(events[index-1].sql,"SET time_zone = '+00:00'");
  }
});

test('notices optimistic lock preserves microseconds and rejects a stale second edit within one second', async () => {
  const f=database(); const initial=await f.save();
  const first=await f.save({updatedAt:initial.updatedAt,title:'first'},initial.id);
  assert.equal(first.updatedAt.slice(0,19),initial.updatedAt.slice(0,19)); assert.notEqual(first.updatedAt,initial.updatedAt);
  assert.match(first.updatedAt,/\.\d{6}Z$/);
  await assert.rejects(f.save({updatedAt:initial.updatedAt,title:'stale'},initial.id),{statusCode:409,code:'CONFLICT'});
  await assert.rejects(f.change(initial,'publish'),{statusCode:409,code:'CONFLICT'});
  assert.equal((await f.admin.adminGet(initial.id)).title,'first');
});

test('notices transaction rolls back row/domain/counter mutations and releases connection on failure', async () => {
  const f=database(), original=structuredClone(f.state);
  f.faults.sql='SET publish_seq = ?';
  await assert.rejects(f.save({publish:true,audienceAll:false,domains:['example.test']}),{statusCode:503,code:'NOTICES_UNAVAILABLE'});
  assert.ok(f.events.some(event=>event.sql?.startsWith('INSERT INTO mailstack_webmail.notice_domains')));
  assert.ok(f.events.some(event=>event.sql?.startsWith('UPDATE mailstack_webmail.notice_counter')));
  assert.deepEqual(f.state,original); assert.ok(f.events.some(event=>event.transaction==='rollback')); assert.equal(f.events.at(-1).transaction,'release');
  f.faults.sql=null; assert.equal((await f.save({publish:true})).seq,1);
});

test('notices validation rejects invalid title, empty sanitized body, category, booleans and inactive/unknown target domains', async () => {
  const f=database();
  for(const data of [{title:''},{title:'x'.repeat(201)},{bodyHtml:'<script>bad</script><img src=x>'},{bodyHtml:'<p><br></p>'},{category:'bad'},{audienceAll:'true'},{pinned:1},{publish:'yes'},{audienceAll:false,domains:[]},{audienceAll:false,domains:['inactive.test']},{audienceAll:false,domains:['unknown.test']},{domains:['bad domain']},{title:'\ud800'}]) {
    await assert.rejects(f.save(data),{statusCode:422,code:'INVALID_INPUT'});
  }
  const row=await f.save({title:'  A\u0000B\nC  ',domains:['other.test']}); assert.equal(row.title,'ABC'); assert.deepEqual(row.domains,[]);
  assert.equal(f.state.rows.length,1); assert.equal(f.auditRows.length,1);
  assert.equal(f.auditRows[0].after.bodyHtml,undefined); assert.equal(f.auditRows[0].after.title,undefined);
  assert.deepEqual(f.service.preview({data:{bodyHtml:'<script>x</script>'}}),{bodyHtml:'',empty:true});
});

for(const code of ['ER_BAD_DB_ERROR','ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR','ER_TABLEACCESS_DENIED_ERROR','ER_ACCESS_DENIED_ERROR']) test(`notices unavailable ${code}: feature disabled, writes fail safely`, async () => {
  const f=database(); f.faults.code=code;
  assert.deepEqual(await f.user.unread('reader@example.test'),{enabled:false,unreadCount:0});
  assert.equal((await f.user.list('reader@example.test')).enabled,false);
  assert.deepEqual(await f.admin.adminList(),{enabled:false,items:[]});
  await assert.rejects(f.save(),{statusCode:503,code:'NOTICES_UNAVAILABLE'});
});
test('notices missing write grants disables both features even when all SELECT probes succeed', async () => {
  const f=database(); f.faults.grants=true;
  assert.equal(await f.admin.ready(),false); assert.equal(await f.user.ready(),false);
  assert.deepEqual(await f.user.unread('reader@example.test'),{enabled:false,unreadCount:0});
});

async function httpFixture(t) {
  const f=database(), dir=await mkdtemp(join(tmpdir(),'notices-server-'));
  const config={adminHostname:'mailadmin.example.test',publicHostnames:['newmail.example.test'],sessionIdleMin:60,sessionMaxHours:8,trustProxy:['127.0.0.0/8'],logLevel:'silent',auditDir:join(dir,'audit')};
  const client={ async login({username}) { return {state:'ready',username}; }, async logout() {}, async call(_session,_method,path) {
    if(path==='/api/v1/get/status/version') return {version:'synthetic'};
    if(path==='/api/v1/get/domain/all') return [{domain_name:'example.test',active:1},{domain_name:'other.test',active:1},{domain_name:'inactive.test',active:0}];
    if(['/api/v1/get/alias-domain/all','/api/v1/get/mailbox/all','/api/v1/get/alias/all'].includes(path)) return [];
    throw new Error(`unexpected synthetic mailcow path ${path}`);
  }};
  const admin=await createAdminApp({config,logger:false,staticDir:'/nonexistent-notices-static',auth:{client},notices:{store:f.admin}});
  const web=await createApp({config,logger:false,staticDir:'/nonexistent-notices-static',auth:{tempRoot:join(dir,'sessions'),verifyLogin:async()=>({})},notices:{store:f.user}});
  web.directory.mailboxName=async email=>email;
  t.after(async()=>{await web.close();await admin.close();await rm(dir,{recursive:true,force:true});});
  const login=await admin.inject({method:'POST',url:'/api/admin/auth/login',headers:{origin:adminOrigin},payload:{username:'admin',password:'synthetic-password'}});
  assert.equal(login.statusCode,200,login.body);
  const adminHeaders={origin:adminOrigin,cookie:login.headers['set-cookie'].split(';')[0],'x-mailadmin-csrf':login.json().csrf};
  async function webLogin(email='reader@example.test') {
    const response=await web.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{email,password:'synthetic-password'}});
    assert.equal(response.statusCode,200,response.body);
    return {origin,cookie:response.headers['set-cookie'].split(';')[0],'x-webmail-csrf':response.json().csrf};
  }
  const webHeaders=await webLogin();
  const request=(app,headers)=>(method,url,payload,overrides={})=>app.inject({method,url,headers:{...headers,...overrides},...(payload===undefined?{}:{payload})});
  return {...f,db:f,admin,web,adminHeaders,webHeaders,webLogin,adminRequest:request(admin,adminHeaders),webRequest:request(web,webHeaders)};
}
function failure(response,status,code) {
  assert.equal(response.statusCode,status,response.body); assert.equal(response.json().error.code,code,response.body);
  assert.deepEqual(Object.keys(response.json().error).sort(),['code','message']);
  assert.equal(response.headers['www-authenticate'],undefined); assert.equal(response.headers['cache-control'],'no-store');
}
const adminRoot='/api/admin/notices';
test('notices HTTP: every admin route requires a session; every change requires CSRF and origin',async t=>{
  const f=await httpFixture(t);
  const routes=[['GET',adminRoot],['GET',`${adminRoot}/1`],['POST',adminRoot],['PUT',`${adminRoot}/1`],['POST',`${adminRoot}/preview`],['DELETE',`${adminRoot}/1`],...['publish','hide','pin','unpin'].map(action=>['POST',`${adminRoot}/1/${action}`])];
  for(const [method,url] of routes) {
    const payload=method==='GET'?undefined:{};
    const denied=await f.admin.inject({method,url,headers:{origin:adminOrigin,authorization:'Basic synthetic'},...(payload===undefined?{}:{payload})});
    failure(denied,403,'NO_SESSION');
    if(method!=='GET') {
      failure(await f.adminRequest(method,url,payload,{'x-mailadmin-csrf':''}),403,'CSRF');
      failure(await f.adminRequest(method,url,payload,{origin:'https://foreign.test'}),403,'BAD_ORIGIN');
    }
  }
  assert.equal(f.db.state.rows.length,0);
});
test('notices HTTP: web session/CSRF, ignored Authorization and client audience/owner forgery',async t=>{
  const f=await httpFixture(t);
  for(const [method,url,payload] of [['GET','/api/notices/unread'],['GET','/api/notices?scope=recent'],['GET','/api/notices?scope=all'],['POST','/api/notices/seen',{upTo:0}]]) {
    failure(await f.web.inject({method,url,headers:{origin,authorization:'Bearer synthetic'},...(payload===undefined?{}:{payload})}),403,'NO_SESSION');
  }
  failure(await f.webRequest('POST','/api/notices/seen',{upTo:0},{'x-webmail-csrf':''}),403,'CSRF');
  failure(await f.webRequest('POST','/api/notices/seen',{upTo:0},{origin:'https://foreign.test'}),403,'BAD_ORIGIN');
  await f.save({publish:true,audienceAll:false,domains:['other.test']});
  const result=await f.webRequest('GET','/api/notices?scope=recent&domain=other.test&email=other@other.test',undefined,{authorization:'Basic ignored'});
  assert.equal(result.statusCode,200,result.body); assert.equal(result.json().items.length,0); assert.equal(result.json().unreadCount,0);
  failure(await f.webRequest('POST','/api/notices/seen',{upTo:1,email:'other@other.test'}),422,'INVALID_INPUT');
  assert.deepEqual(f.db.state.reads,{});
  assert.equal((await f.webRequest('POST','/api/notices/seen',{upTo:Number.MAX_SAFE_INTEGER})).statusCode,200);
  assert.deepEqual(f.db.state.reads,{'reader@example.test':0});
});
for(const [raw,canonical] of [
  ['2026-10-28 06:00:00','2026-10-28T06:00:00.000000Z'],
  ['2026-10-28 06:00:00.000000','2026-10-28T06:00:00.000000Z'],
  ['2026-10-28 06:00:00.123456','2026-10-28T06:00:00.123456Z'],
])test(`notices HTTP: binary DATETIME ${raw} version round-trips unchanged`,async t=>{
  const f=await httpFixture(t); const created=await f.save();
  f.db.state.rows.find(row=>row.id===created.id).updated_at=raw;
  const read=await f.adminRequest('GET',`${adminRoot}/${created.id}`);assert.equal(read.statusCode,200,read.body);
  assert.equal(read.json().updatedAt,canonical);
  const list=await f.adminRequest('GET',adminRoot);assert.equal(list.json().items[0].updatedAt,canonical);
  const change=await f.adminRequest('PUT',`${adminRoot}/${created.id}`,draft({updatedAt:read.json().updatedAt,title:'changed'}));
  assert.equal(change.statusCode,200,change.body);assert.match(change.json().updatedAt,/\.\d{6}Z$/);
  failure(await f.adminRequest('PUT',`${adminRoot}/${created.id}`,draft({updatedAt:read.json().updatedAt,title:'stale'})),409,'CONFLICT');
});

test('notices HTTP: complete admin CRUD, publish/hide/pin states, contract and audit; web enabled/unread/seen',async t=>{
  const f=await httpFixture(t);
  const preview=await f.adminRequest('POST',`${adminRoot}/preview`,{bodyHtml:'<p onclick="bad()">preview<img src=x></p>'});
  assert.deepEqual(preview.json(),{bodyHtml:'<p>preview</p>',empty:false});
  failure(await f.adminRequest('POST',adminRoot,draft({bodyHtml:'<script>empty</script>'})),422,'INVALID_INPUT');
  failure(await f.adminRequest('POST',adminRoot,draft({audienceAll:false,domains:['inactive.test']})),422,'INVALID_INPUT');
  const create=await f.adminRequest('POST',adminRoot,draft({audienceAll:false,domains:['EXAMPLE.TEST'],bodyHtml:'<p onclick="bad()">hello</p>'}));
  assert.equal(create.statusCode,200,create.body); let row=create.json(); assert.equal(row.state,'draft'); assert.equal(row.bodyHtml,'<p>hello</p>');
  assert.deepEqual(row.domains,['example.test']); assert.match(row.updatedAt,/\.\d{6}Z$/);
  let list=await f.adminRequest('GET',`${adminRoot}?state=draft`); assert.equal(list.json().enabled,true); assert.equal(list.json().items.length,1);
  assert.equal(list.json().items[0].bodyHtml,undefined);
  let change=await f.adminRequest('PUT',`${adminRoot}/${row.id}`,draft({title:'edited',audienceAll:false,domains:['example.test'],updatedAt:row.updatedAt}));
  assert.equal(change.statusCode,200,change.body); const stale=row;row=change.json();
  failure(await f.adminRequest('PUT',`${adminRoot}/${row.id}`,draft({updatedAt:stale.updatedAt})),409,'CONFLICT');
  assert.equal(stale.updatedAt.slice(0,19),row.updatedAt.slice(0,19));
  change=await f.adminRequest('POST',`${adminRoot}/${row.id}/publish`,{updatedAt:row.updatedAt}); assert.equal(change.statusCode,200,change.body); row=change.json();
  assert.equal(row.state,'published'); assert.equal(row.seq,1); const firstPublished=row.publishedAt;
  assert.deepEqual((await f.webRequest('GET','/api/notices/unread')).json(),{enabled:true,unreadCount:1});
  const recent=await f.webRequest('GET','/api/notices?scope=recent');
  assert.deepEqual(Object.keys(recent.json()).sort(),['enabled','items','maxSeq','pinned','unreadCount']);
  assert.deepEqual(Object.keys(recent.json().items[0]).sort(),['bodyHtml','category','id','pinned','publishedAt','seq','title','unread']);
  for(const action of ['pin','unpin','hide','publish']) {
    change=await f.adminRequest('POST',`${adminRoot}/${row.id}/${action}`,{updatedAt:row.updatedAt}); assert.equal(change.statusCode,200,change.body); row=change.json();
    assert.equal(row.seq,1); assert.equal(row.publishedAt,firstPublished);
  }
  assert.deepEqual((await f.webRequest('POST','/api/notices/seen',{upTo:recent.json().maxSeq})).json(),{unreadCount:0});
  const all=await f.webRequest('GET','/api/notices?scope=all'); assert.deepEqual(Object.keys(all.json()).sort(),['items','nextBefore']);
  assert.equal(all.json().items[0].unread,false);
  const detail=(await f.adminRequest('GET',`${adminRoot}/${row.id}`)).json();
  assert.equal(detail.title,'edited'); assert.deepEqual(Object.keys(detail).sort(),['audienceAll','bodyHtml','category','domains','id','pinned','publishedAt','state','title','updatedAt']);
  const history=await f.admin.audit.read();
  assert.ok(history.rows.some(item=>item.action==='notice.create'));
  assert.ok(history.rows.some(item=>item.action==='notice.publish'));
  assert.ok(!JSON.stringify(history).includes('bodyHtml')); assert.ok(!JSON.stringify(history).includes('<p>'));
  assert.deepEqual((await f.adminRequest('DELETE',`${adminRoot}/${row.id}`,{updatedAt:row.updatedAt})).json(),{ok:true});
  assert.deepEqual((await f.adminRequest('GET',adminRoot)).json(),{enabled:true,items:[]});
  failure(await f.adminRequest('GET',`${adminRoot}/${row.id}`),404,'NOT_FOUND');
  const next=await f.adminRequest('POST',adminRoot,draft({publish:true})); assert.equal(next.json().seq,2);
});
test('notices HTTP: invalid pagination, seen and admin filters fail without mutation',async t=>{
  const f=await httpFixture(t);
  for(const url of ['/api/notices?scope=bad','/api/notices?scope=all&before=0','/api/notices?scope=all&before=1.5','/api/notices?before=1','/api/notices?scope=all&before=99999999999999999999']) failure(await f.webRequest('GET',url),422,'INVALID_INPUT');
  for(const payload of [{},[],{upTo:-1},{upTo:'1'},{upTo:1.1},{upTo:Number.MAX_SAFE_INTEGER+1}]) failure(await f.webRequest('POST','/api/notices/seen',payload),422,'INVALID_INPUT');
  failure(await f.adminRequest('GET',`${adminRoot}?state=bad`),422,'INVALID_INPUT');
  failure(await f.adminRequest('GET',`${adminRoot}/bad`),422,'INVALID_INPUT');
  failure(await f.adminRequest('POST',`${adminRoot}/preview`,{}),422,'INVALID_INPUT');
  assert.equal(f.db.state.rows.length,0); assert.deepEqual(f.db.state.reads,{});
});
for(const failureCode of ['ER_NO_SUCH_TABLE','ER_TABLEACCESS_DENIED_ERROR']) test(`notices HTTP: ${failureCode} disables features while both apps remain healthy`,async t=>{
  const f=await httpFixture(t); f.faults.code=failureCode;
  assert.equal((await f.web.inject('/healthz')).statusCode,200); assert.equal((await f.admin.inject('/healthz')).statusCode,200);
  assert.equal((await f.webRequest('GET','/api/auth/session')).statusCode,200); assert.equal((await f.adminRequest('GET','/api/admin/auth/session')).statusCode,200);
  assert.deepEqual((await f.webRequest('GET','/api/notices/unread')).json(),{enabled:false,unreadCount:0});
  assert.deepEqual((await f.adminRequest('GET',adminRoot)).json(),{enabled:false,items:[]});
  failure(await f.adminRequest('POST',adminRoot,draft()),503,'NOTICES_UNAVAILABLE');
});

test('notices admin config: optional DB settings preserve old env startup and configured values',async()=>{
  const env={ADMIN_MODE:'true',ADMIN_HOSTNAME:'mailadmin.example.test',ADMIN_SESSION_IDLE_MIN:'60',ADMIN_SESSION_MAX_HOURS:'8',
    MAILCOW_UI_URL:'https://nginx-mailcow:8443',MAILCOW_UI_SERVERNAME:'mail.example.test',IMAP_HOST:'dovecot-mailcow',SMTP_HOST:'postfix-mailcow',MAIL_TLS_SERVERNAME:'mail.example.test',
    MAIL_TLS_MODE:'verify',MAIL_TLS_PIN_FILE:'',DOMAIN:'example.test',TRUST_PROXY:'192.0.2.0/24',DOCKERAPI_URL:'https://dockerapi:443',DOVEADM_URL:'',DOVEADM_KEY:'',TRUSTED_SENDER_FILE:'',RELAY_FILES:'',
    MAILCOW_IPV4_NETWORK:'192.0.2',MAILCOW_IPV6_NETWORK:'',AUTOEXPUNGE_DAYS:'',LOGO_DIR:'',AUDIT_DIR:'/data/audit',LOG_LEVEL:'silent'};
  assert.equal(loadAdminConfig(env).dbHost,''); assert.equal(loadAdminConfig(env).dbPassword,'');
  const disabled=createNoticesStore({config:loadAdminConfig(env),mode:'admin'});
  assert.equal(await disabled.ready(),false); assert.deepEqual(await disabled.adminList(),{enabled:false,items:[]}); await disabled.close();
  const config=loadAdminConfig({...env,DB_HOST:'mysql-mailcow',DB_NAME:'mailstack_webmail',DB_USER:'webmail_notices_admin',DB_PASSWORD:'synthetic-password'});
  assert.equal(config.dbHost,'mysql-mailcow'); assert.equal(config.dbName,'mailstack_webmail'); assert.equal(config.dbUser,'webmail_notices_admin'); assert.equal(config.dbPassword,'synthetic-password');
  for(const [key,value] of [['DB_HOST','bad host'],['DB_NAME','bad-name'],['DB_USER','bad\nuser'],['DB_PASSWORD','bad\npassword']]) assert.throws(()=>loadAdminConfig({...env,[key]:value}),new RegExp(key));
});
