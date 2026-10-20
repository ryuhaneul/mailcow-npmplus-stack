import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { get } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScopedActionService } from '../../server/mail/scoped-actions.js';
import { createActionService } from '../../server/mail/actions.js';
import { createImapPool } from '../../server/mail/imap-pool.js';
import { createEventService } from '../../server/mail/events.js';
import { encodeRef, scopedBatchState } from '../../server/mail/ref.js';
import { createApp } from '../../server/app.js';

const ref = (path = 'INBOX', uid = 7) => encodeRef(path, 123, uid);
class ActionImap extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; this.enabled = new Set(); this.capabilities = new Map(); this.calls = []; this.access = new Map(); this.usable = false; this.archive = 'Saved'; this.locks = []; this.rightsQueries = []; this.fetches = []; this.total = 3; this.unseen = 2; this.usage = 100; this.limit = 1000; }
  async connect() { this.usable = true; }
  close() { this.usable = false; this.emit('close'); }
  async logout() { this.close(); }
  async getMailboxLock(path) { this.locks.push(path); this.mailbox = { path, uidValidity: 123n }; return { release() {} }; }
  async mailboxOpen(path) { this.mailbox = { path, uidValidity: 123n }; }
  async idle() { return new Promise(() => {}); }
  async exec(command, attrs, {untagged} = {}) {
    if (command === 'MYRIGHTS') { this.rightsQueries.push(attrs[0].value); untagged.MYRIGHTS({attributes:[attrs[0],{value:this.access.get(attrs[0].value) ?? 'lrswite'}]}); }
    else this.calls.push([command,attrs]);
    return {next:()=>{ if(command==='UID EXPUNGE') this.calls.push(['next']); }};
  }
  async *fetch(range, query, options) { this.fetches.push({ range, query, options }); for (const uid of range.split(',').map(Number)) if (!this.missing && !this.missingUids?.has(uid)) yield {uid}; }
  async list() { return this.archive ? [{path:this.archive,specialUse:'\\Archive'}] : this.existingArchive ? [{path:'Archive'}] : []; }
  async mailboxCreate(path) { this.calls.push(['create',path]); return true; }
  async messageMove(...args) { this.calls.push(['move',...args]); if(this.reject) throw new Error('synthetic failure'); return true; }
  async messageFlagsAdd(...args) { this.calls.push(['add',...args]); return !this.reject; }
  async messageFlagsRemove(...args) { this.calls.push(['remove',...args]); return true; }
  async status(path, query) { this.statusQuery = {path,query}; return {messages:this.total,unseen:this.unseen}; }
  async getQuota() { return {storage:{usage:this.usage,limit:this.limit}}; }
}
function fixture() {
  const client = new ActionImap();
  const imap = {async withMailbox(_session, path, operation) { const lock = await client.getMailboxLock(path); try { return await operation(client); } finally { lock.release(); } }};
  return {client,service:createActionService({imap})};
}
for (const [action,method,flag] of [['seen','add','\\Seen'],['unseen','remove','\\Seen'],['flag','add','\\Flagged'],['unflag','remove','\\Flagged']]) test(`action ${action}: expected UID flag call`, async()=>{
  const f=fixture(); assert.deepEqual(await f.service.run({}, {refs:[ref()],action}),{done:1,failed:[]}); assert.deepEqual(f.client.calls,[[method,'7',[flag],{uid:true}]]);
});
for (const [action,target] of [['move','Projects/합성'],['archive','Saved'],['trash','Trash'],['spam','Junk'],['notspam','INBOX']]) test(`action ${action}: expected original-folder UID MOVE`,async()=>{
  const f=fixture(); const token=ref('Projects/원본',9); assert.equal((await f.service.run({}, {refs:[token],action,target})).done,1); assert.equal(f.client.mailbox.path,'Projects/원본'); assert.deepEqual(f.client.calls,[['move','9',target,{uid:true}]]);
});
test('action delete-forever: Trash and Junk use Deleted plus UID EXPUNGE only',async()=>{
  const f=fixture(); assert.equal((await f.service.run({}, {refs:[ref('Trash'),ref('Junk',8)],action:'delete-forever'})).done,2);
  assert.deepEqual(f.client.calls.slice(0,3),[['add','7',['\\Deleted'],{uid:true}],['UID EXPUNGE',[{type:'SEQUENCE',value:'7'}]],['next']]);
});
test('action validation: permanent deletion outside Trash/Junk rejects entire batch before mutation',async()=>{
  const f=fixture(); await assert.rejects(f.service.run({}, {refs:[ref('Trash'),ref()],action:'delete-forever'}),{statusCode:422}); assert.deepEqual(f.client.calls,[]);
});
test('action validation: array bounds, unknown action, invalid ref and forbidden/invalid move target',async()=>{
  const f=fixture();
  for(const body of [null,{refs:[],action:'seen'},{refs:Array(1001).fill(ref()),action:'seen'},{refs:[ref()],action:'bad'}]) await assert.rejects(f.service.run({},body),{statusCode:422});
  await assert.rejects(f.service.run({}, {refs:['invalid'],action:'seen'}),{statusCode:400});
  for(const target of ['Shared','Shared/user@example.com/folder','WebmailVirtual/AllMail','INBOX\r\n','']) await assert.rejects(f.service.run({}, {refs:[ref()],action:'move',target}),{statusCode:422});
  await assert.rejects(f.service.run({}, {refs:[ref('WebmailVirtual/AllMail')],action:'seen'}),{statusCode:422}); assert.equal(f.client.calls.length,0);
});
test('actions: shared readonly, source and target rights; all readonly gives 403',async()=>{
  const f=fixture(); await assert.rejects(f.service.run({}, {refs:[ref('Shared/user@example.com')],action:'seen'}),{statusCode:403,code:'FOLDER_READONLY'});
  f.client.access.set('INBOX','lr'); for(const action of ['seen','unseen','flag','unflag','move']) await assert.rejects(f.service.run({}, {refs:[ref()],action,target:'Projects'}),{statusCode:403});
  f.client.access.set('INBOX','lrswite'); f.client.access.set('Projects','lr'); await assert.rejects(f.service.run({}, {refs:[ref()],action:'move',target:'Projects'}),{statusCode:403}); assert.equal(f.client.calls.length,0);
});
test('actions: per-ref partial failure, stale ref and missing UID',async()=>{
  const f=fixture(); const shared=ref('Shared/user@example.com');
  assert.deepEqual(await f.service.run({}, {refs:[ref(),shared],action:'seen'}),{done:1,failed:[{ref:shared,code:'FOLDER_READONLY'}]});
  const stale=encodeRef('INBOX',124,7); assert.deepEqual((await f.service.run({}, {refs:[stale],action:'seen'})).failed,[{ref:stale,code:'STALE_REF'}]);
  f.client.missing=true; assert.equal((await f.service.run({}, {refs:[ref()],action:'seen'})).failed[0].code,'MESSAGE_NOT_FOUND');
});
test('actions: archive creates fallback once, reuses existing fallback and trash no-op',async()=>{
  const f=fixture(); f.client.archive=null;
  assert.equal((await f.service.run({}, {refs:[ref()],action:'archive'})).done,1); assert.deepEqual(f.client.calls,[['create','Archive'],['move','7','Archive',{uid:true}]]);
  f.client.calls=[]; f.client.existingArchive=true; await f.service.run({}, {refs:[ref()],action:'archive'}); assert.equal(f.client.calls[0][0],'move');
  f.client.calls=[]; assert.equal((await f.service.run({}, {refs:[ref('Trash')],action:'trash'})).done,1); assert.deepEqual(f.client.calls,[]);
});
test('actions: failed server call remains per-ref failure without error contents',async()=>{
  const f=fixture(); f.client.reject=true; assert.equal((await f.service.run({}, {refs:[ref()],action:'seen'})).failed[0].code,'MAIL_REJECTED');
  assert.equal((await f.service.run({}, {refs:[ref()],action:'move',target:'Projects'})).failed[0].code,'MAIL_UNAVAILABLE');
});
function eventFixture() {
  const client=new ActionImap(); let listener,stops=0,time=0,destroyed=0; const session={connection:{}};
  const imap={watch(_session,callback){listener=callback;return()=>stops++;},async withMailbox(_session,path,operation){assert.equal(path,'INBOX');return operation(client);}};
  const sessions={expiresAt:()=>new Date(100000).toISOString(),async destroy(value){assert.equal(value,session);destroyed++;session.connection=null;}};
  const service=createEventService({imap,sessions,now:()=>time,logger:{warn(){}}});
  return {client,session,open:()=>service.open(session),event:()=>listener(),stops:()=>stops,destroyed:()=>destroyed,advance:ms=>{time+=ms;}};
}
test('SSE: initial mailbox/quota payloads, changes deduplicated, watch cleanup',async()=>{
  const f=eventFixture();const stream=f.open();let text='';stream.on('data',chunk=>{text+=chunk;});
  await nextTurn();assert.match(text,/event: mailbox\ndata: {"path":"INBOX","unseen":2,"total":3}/);assert.match(text,/event: quota\ndata: {"usedBytes":100,"limitBytes":1000}/);
  const before=text;f.event();await nextTurn();assert.equal(text,before);
  f.client.total=4;f.client.unseen=3;f.client.usage=200;f.event();await nextTurn();assert.match(text,/{"path":"INBOX","unseen":3,"total":4}/);assert.match(text,/"usedBytes":200/);
  const closed=once(stream,'close');stream.destroy();await closed;assert.equal(f.stops(),1);
});
test('SSE: mailbox changes without a QUOTA response emit no quota override', async t => {
  const f = eventFixture(); f.client.getQuota = async () => ({ path: 'INBOX' });
  const stream = f.open(); t.after(() => stream.destroy());
  let text = ''; stream.on('data', chunk => { text += chunk; });
  await nextTurn(); assert.match(text, /event: mailbox/); assert.doesNotMatch(text, /event: quota/);
  f.client.total = 4; f.event(); await nextTurn();
  assert.match(text, /"total":4/); assert.doesNotMatch(text, /event: quota/);
});
test('SSE: exact 25-second ping interval and expiry event/close',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const f=eventFixture();const stream=f.open();let text='';stream.on('data',chunk=>{text+=chunk;});await nextTurn();
  t.mock.timers.tick(24999);await nextTurn();assert.ok(!text.includes(': ping'));
  t.mock.timers.tick(1);await nextTurn();assert.equal(text.match(/: ping/g).length,1);
  f.advance(100000);const closed=once(stream,'close');t.mock.timers.tick(25000);await closed;assert.match(text,/event: session\ndata: {"state":"expired"}/);assert.equal(f.stops(),1);assert.equal(f.destroyed(),1);
});
test('SSE: revoked session produces expired event; slow-reader buffer stays bounded',async()=>{
  const f=eventFixture();const stream=f.open();let text='';stream.on('data',chunk=>{text+=chunk;});await nextTurn();f.session.connection=null;const closed=once(stream,'close');f.event();await closed;assert.match(text,/state":"expired/);assert.equal(f.stops(),1);
  const g=eventFixture();const slow=g.open();await nextTurn();slow.write('x'.repeat(65536));g.client.total=5;const ended=once(slow,'close');g.event();await ended;assert.equal(g.stops(),1);
});
test('SSE: concurrent notifications coalesce while IMAP refresh is pending',async()=>{
  const f=eventFixture();let release,count=0;const original=f.client.status.bind(f.client);f.client.status=async(...args)=>{count++;if(count===1) await new Promise(resolve=>{release=resolve;});return original(...args);};
  const stream=f.open();stream.resume();await nextTurn();for(let i=0;i<10;i++) f.event();release();await nextTurn();assert.equal(count,2);stream.destroy();
});
test('HTTP routes: actions require Origin/CSRF; SSE headers, mailbox event, monitor cleanup',{timeout:5000},async t=>{
  const clients=[];const tempRoot=await mkdtemp(join(tmpdir(),'webmail-w07-test-'));
  const config={publicHostnames:['newmail.example.com'],trustProxy:['127.0.0.0/8'],logLevel:'silent',sessionIdleMin:480,sessionMaxHours:24,imapHost:'imap.example.com',imapPort:993,mailTlsMode:'verify',mailTlsServername:'mail.example.com'};
  const app=await createApp({config,logger:false,auth:{tempRoot,clientFactory:options=>{const client=new ActionImap(options);clients.push(client);return client;}}});
  let eventsRequest;
  t.after(async()=>{eventsRequest?.destroy();await app.close();await rm(tempRoot,{recursive:true,force:true});});
  await app.listen({host:'127.0.0.1',port:0});const base=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base+'/api/events')).status,403);
  const logged=await fetch(base+'/api/auth/login',{method:'POST',headers:{origin:'https://newmail.example.com','content-type':'application/json'},body:JSON.stringify({email:'user@example.com',password:'synthetic-actions-password'})});assert.equal(logged.status,200);const session=await logged.json();
  const headers={cookie:logged.headers.get('set-cookie').split(';')[0],origin:'https://newmail.example.com','content-type':'application/json'};
  const body=JSON.stringify({refs:[ref()],action:'seen'});
  assert.equal((await fetch(base+'/api/messages/actions',{method:'POST',headers,body})).status,403);
  const action=await fetch(base+'/api/messages/actions',{method:'POST',headers:{...headers,'x-webmail-csrf':session.csrf},body});assert.equal(action.status,200);assert.deepEqual(await action.json(),{done:1,failed:[]});
  // A fetch abort may open a replacement pooled socket with no HTTP request,
  // which server.close() must wait to time out. Keep this SSE client unpooled.
  eventsRequest=get(base+'/api/events',{headers:{cookie:headers.cookie},agent:false});
  const [events]=await once(eventsRequest,'response');assert.equal(events.statusCode,200);
  assert.match(events.headers['content-type'],/^text\/event-stream/);assert.equal(events.headers['cache-control'],'no-store');assert.equal(events.headers['x-accel-buffering'],'no');assert.equal(events.headers['www-authenticate'],undefined);assert.equal(events.headers['x-content-type-options'],'nosniff');
  const [chunk]=await once(events,'data');assert.match(chunk.toString(),/event: mailbox/);assert.equal(clients.length,2);
  const closed=once(clients[1],'close');eventsRequest.destroy();await closed;assert.equal(clients[1].usable,false);assert.equal(clients[0].usable,true);
});

test('actions: 1000 refs share one lock, rights query, existence FETCH and UID STORE', async () => {
  const f = fixture();
  const refs = Array.from({ length: 1000 }, (_, i) => ref('INBOX', i + 1));
  assert.deepEqual(await f.service.run({}, { refs, action: 'seen' }), { done: 1000, failed: [] });
  assert.deepEqual(f.client.locks, ['INBOX']); assert.deepEqual(f.client.rightsQueries, ['INBOX']);
  assert.equal(f.client.fetches.length, 1); assert.deepEqual(f.client.fetches[0].query, { uid: true });
  assert.deepEqual(f.client.fetches[0].options, { uid: true });
  assert.deepEqual(f.client.calls, [['add', Array.from({ length: 1000 }, (_, i) => i + 1).join(','), ['\\Seen'], { uid: true }]]);
});

test('actions: mixed validity and missing UID fail only those refs in the same folder', async () => {
  const f = fixture(); f.client.missingUids = new Set([2]);
  const stale = encodeRef('INBOX', 124, 3), missing = ref('INBOX', 2);
  const result = await f.service.run({}, { refs: [ref('INBOX', 1), missing, stale, ref('INBOX', 4)], action: 'move', target: 'Projects' });
  assert.equal(result.done, 2);
  assert.deepEqual(result.failed, [{ ref: stale, code: 'STALE_REF' }, { ref: missing, code: 'MESSAGE_NOT_FOUND' }]);
  assert.deepEqual(f.client.calls, [['move', '1,4', 'Projects', { uid: true }]]);
  assert.deepEqual(f.client.rightsQueries, ['INBOX', 'Projects']);
  assert.equal(f.client.fetches[0].range, '1,2,4');
});

test('actions: interleaved source folders get one lock and UID set each', async () => {
  const f = fixture();
  const result = await f.service.run({}, { refs: [ref('INBOX', 1), ref('Other', 2), ref('INBOX', 3)], action: 'move', target: 'Projects' });
  assert.deepEqual(result, { done: 3, failed: [] });
  assert.deepEqual(f.client.locks, ['INBOX', 'Other']);
  assert.deepEqual(f.client.rightsQueries, ['INBOX', 'Projects', 'Other', 'Projects']);
  assert.equal(f.client.fetches.length, 2);
  assert.deepEqual(f.client.calls, [['move', '1,3', 'Projects', { uid: true }], ['move', '2', 'Projects', { uid: true }]]);
});

test('actions: readonly source group fails without blocking a writable group', async () => {
  const f = fixture(); f.client.access.set('Other', 'lr');
  const tokens = [ref('Other', 1), ref('INBOX', 2), ref('Other', 3)];
  assert.deepEqual(await f.service.run({}, { refs: tokens, action: 'seen' }), {
    done: 1, failed: [tokens[0], tokens[2]].map(ref => ({ ref, code: 'FOLDER_READONLY' })),
  });
  assert.deepEqual(f.client.calls, [['add', '2', ['\\Seen'], { uid: true }]]);
});

for (const [action, code] of [['seen', 'MAIL_REJECTED'], ['move', 'MAIL_UNAVAILABLE']]) {
  test(`actions: ${action} command failure reports every ref in that UID set`, async () => {
    const f = fixture(); f.client.reject = true;
    const refs = [ref('INBOX', 1), ref('INBOX', 2)];
    assert.deepEqual(await f.service.run({}, { refs, action, target: 'Projects' }), { done: 0, failed: refs.map(ref => ({ ref, code })) });
    assert.equal(f.client.calls.length, 1);
  });
}

test('actions: grouped permanent delete stores Deleted and expunges the same UID set', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.run({}, { refs: [ref('Trash', 1), ref('Trash', 2)], action: 'delete-forever' }), { done: 2, failed: [] });
  assert.deepEqual(f.client.calls, [['add', '1,2', ['\\Deleted'], { uid: true }], ['UID EXPUNGE', [{ type: 'SEQUENCE', value: '1,2' }]], ['next']]);
});

const scopedActions = ['seen', 'unseen', 'flag', 'unflag', 'move', 'archive', 'trash', 'spam', 'notspam', 'delete-forever'];
const movingActions = ['move', 'archive', 'trash', 'spam', 'notspam'];
function scopedFixture(action = 'seen') {
  const client = new ActionImap();
  client.capabilities.set('MOVE', true);
  client.list = async () => ['INBOX', 'Trash', 'Junk', 'Saved', 'Projects', 'Projects/합성'].map(path => ({ path }));
  client.exec = async (command, attrs, options) => {
    if (command === 'MYRIGHTS') {
      client.rightsQueries.push(attrs[0].value);
      options.untagged.MYRIGHTS({ attributes: [attrs[0], { value: client.access.get(attrs[0].value) ?? 'lrswite' }] });
    } else if (command === 'UID SEARCH') {
      client.sortCalls ??= []; client.sortCalls.push(attrs);
      options.untagged.SEARCH({ attributes: (client.matches ?? [7, 8]).filter(uid => !client.missingUids?.has(uid)).map(value => ({ value: String(value) })) });
    } else {
      client.calls.push([command, attrs]);
      await client.mutation?.(command, attrs);
    }
    return { response: { command: 'OK' }, next() {} };
  };
  let remainingMs = 50000;
  const budget = { remainingMs: () => remainingMs };
  const outcomes = [];
  const options = {
    refs: [ref(action === 'delete-forever' ? 'Trash' : 'INBOX')], action,
    resolvedTarget: action === 'archive' ? 'Saved' : 'Projects',
    resolvedScope: { filters: [], imap: [], searching: false }, budget,
    onOutcome: outcome => outcomes.push(outcome),
  };
  const imap = { async withMailbox(_session, path, operation, received) {
    assert.equal(received.budget, budget);
    const lock = await client.getMailboxLock(path);
    try { return await operation(client); } finally { lock.release(); }
  } };
  const service = createActionService({ imap });
  return { client, budget, options, outcomes, service, run: () => service.runScopedGroup({}, options), time: value => { remainingMs = value; } };
}
function assertScopedPartition(result, refs, outcomes) {
  const settled = [...result.processed, ...result.skipped, ...result.failed.map(row => row.ref), ...result.unknown.map(row => row.ref)];
  assert.deepEqual([...settled, ...result.remaining].sort(), [...refs].sort());
  assert.equal(new Set([...settled, ...result.remaining]).size, refs.length);
  assert.equal(new Set(outcomes.map(row => row.ref)).size, outcomes.length);
  assert.deepEqual(outcomes.map(row => row.ref).sort(), settled.sort());
  for (const status of ['processed', 'skipped', 'failed', 'unknown']) {
    assert.deepEqual(outcomes.filter(row => row.status === status).map(row => row.ref).sort(), result[status].map(row => typeof row === 'string' ? row : row.ref).sort());
  }
}
for (const action of scopedActions) {
  test(`scoped ${action}: native UID command success and disjoint outcome`, async () => {
    const f = scopedFixture(action);
    const result = await f.run();
    assert.deepEqual(result, { processed: f.options.refs, skipped: [], failed: [], unknown: [], remaining: [], reason: 'complete' });
    assertScopedPartition(result, f.options.refs, f.outcomes);
    const sequence = { type: 'SEQUENCE', value: '7' };
    if (movingActions.includes(action)) {
      const target = { move: 'Projects', archive: 'Saved', trash: 'Trash', spam: 'Junk', notspam: 'INBOX' }[action];
      // notspam originates in INBOX in this fixture, and is a verified no-op.
      assert.deepEqual(f.client.calls, action === 'notspam' ? [] : [['UID MOVE', [sequence, { type: 'ATOM', value: target }]]]);
    } else {
      const flag = action === 'delete-forever' ? '\\Deleted' : ['seen', 'unseen'].includes(action) ? '\\Seen' : '\\Flagged';
      const operation = ['unseen', 'unflag'].includes(action) ? '-FLAGS' : '+FLAGS';
      const expected = [['UID STORE', [sequence, { type: 'ATOM', value: operation }, [{ type: 'ATOM', value: flag }]]]];
      if (action === 'delete-forever') expected.push(['UID EXPUNGE', [sequence]]);
      assert.deepEqual(f.client.calls, expected);
      assert.equal(f.client.calls[0][1][2][0].value.codePointAt(0), 92, 'system flag atom starts with a literal backslash');
    }
  });
  test(`scoped ${action}: missing UID and changed condition are skipped`, async () => {
    const f = scopedFixture(action), path = action === 'delete-forever' ? 'Trash' : 'INBOX';
    f.options.refs = [ref(path, 7), ref(path, 8), ref(path, 9)];
    f.client.missingUids = new Set([7]); f.client.matches = [8, 1000];
    f.options.resolvedScope.imap = [{ seen: false }];
    const result = await f.run();
    assert.deepEqual(result.skipped, [ref(path, 7), ref(path, 9)]);
    assert.deepEqual(result.processed, [ref(path, 8)]);
    assert.equal(f.client.sortCalls.length, 1);
    assert.deepEqual(f.client.sortCalls[0].slice(0, 2), [{ type: 'ATOM', value: 'UID' }, { type: 'SEQUENCE', value: '7:9' }]);
    assertScopedPartition(result, f.options.refs, f.outcomes);
  });
  test(`scoped ${action}: source ACL denial is a confirmed failure`, async () => {
    const f = scopedFixture(action);
    f.client.access.set(action === 'delete-forever' ? 'Trash' : 'INBOX', 'lr');
    const result = await f.run();
    assert.deepEqual(result.failed, [{ ref: f.options.refs[0], code: 'FOLDER_READONLY', retryable: false }]);
    assert.deepEqual(f.client.calls, []);
    assertScopedPartition(result, f.options.refs, f.outcomes);
  });
  test(`scoped ${action}: MOVE capability only required for moving actions`, async () => {
    const f = scopedFixture(action); f.client.capabilities.clear();
    const result = await f.run();
    if (movingActions.includes(action)) {
      assert.deepEqual(result.failed, [{ ref: f.options.refs[0], code: 'MOVE_UNSUPPORTED', retryable: false }]);
      assert.deepEqual(f.client.calls, []);
    } else assert.deepEqual(result.processed, f.options.refs);
    assertScopedPartition(result, f.options.refs, f.outcomes);
  });
  test(`scoped ${action}: below start threshold leaves candidates unsettled`, async () => {
    const f = scopedFixture(action);
    if (action === 'notspam') f.options.refs = [ref('Junk')];
    f.time(9999);
    const result = await f.run();
    assert.deepEqual(result.remaining, f.options.refs); assert.equal(result.reason, 'budget');
    assert.deepEqual(f.client.calls, []);
    assertScopedPartition(result, f.options.refs, f.outcomes);
  });
  test(`scoped ${action}: unconfirmed mutation is unknown and never retryable`, async () => {
    const f = scopedFixture(action);
    if (action === 'notspam') f.options.refs = [ref('Junk')];
    f.client.mutation = async () => { throw new Error('synthetic disconnected command'); };
    const result = await f.run();
    assert.deepEqual(result.unknown, [{ ref: f.options.refs[0], code: 'ACTION_OUTCOME_UNKNOWN', retryable: false }]);
    assert.deepEqual(result.failed, []); assert.equal(f.client.calls.length, 1);
    assertScopedPartition(result, f.options.refs, f.outcomes);
  });
}

test('scoped: notspam from Junk and UTF-8 destination use native MOVE without library fallback', async () => {
  const f = scopedFixture('notspam'); f.options.refs = [ref('Junk')];
  assert.deepEqual((await f.run()).processed, f.options.refs);
  assert.equal(f.client.calls[0][0], 'UID MOVE');
  assert.equal(f.client.calls[0][1][1].value, 'INBOX');
  const g = scopedFixture('move'); g.client.enabled.add('UTF8=ACCEPT'); g.options.resolvedTarget = 'Projects/합성';
  assert.deepEqual((await g.run()).processed, g.options.refs);
  assert.equal(g.client.calls[0][1][1].value, 'Projects/합성');
});
test('scoped: source folder filters use every resolved path; no mutation or condition broadening', async () => {
  const f = scopedFixture(); f.options.resolvedScope.filters = ['INBOX', 'Other'];
  const result = await f.run(); assert.deepEqual(result.skipped, f.options.refs); assert.deepEqual(f.client.calls, []);
  assertScopedPartition(result, f.options.refs, f.outcomes);
});
test('scoped: shared source and revoked destination insert rights fail before mutation', async () => {
  const f = scopedFixture(); f.options.refs = [ref('Shared/synthetic@example.com')];
  assert.equal((await f.run()).failed[0].code, 'FOLDER_READONLY'); assert.deepEqual(f.client.calls, []);
  for (const action of movingActions) {
    const g = scopedFixture(action); if (action === 'notspam') g.options.refs = [ref('Junk')];
    const target = { move: 'Projects', archive: 'Saved', trash: 'Trash', spam: 'Junk', notspam: 'INBOX' }[action];
    g.client.access.set(target, 'lr');
    assert.equal((await g.run()).failed[0].code, 'FOLDER_READONLY'); assert.deepEqual(g.client.calls, []);
  }
});
test('scoped: missing/nonselectable archive target fails without creating a folder', async () => {
  for (const rows of [[], [{ path: 'Saved', flags: new Set(['\\Noselect']) }]]) {
    const f = scopedFixture('archive'); f.client.list = async () => rows;
    assert.equal((await f.run()).failed[0].code, 'FOLDER_NOT_ALLOWED'); assert.deepEqual(f.client.calls, []);
  }
});
test('scoped: stale identity stops entire group, including mixed validity, before any mutation', async () => {
  const f = scopedFixture(); f.options.refs = [ref(), encodeRef('INBOX', 124, 8)];
  await assert.rejects(f.run(), { statusCode: 409, code: 'STALE_SCOPE' });
  assert.deepEqual(f.client.calls, []); assert.deepEqual(f.client.rightsQueries, []); assert.deepEqual(f.outcomes, []);
});
test('scoped: validation rejects unsafe destinations, virtual sources, multiple folders and duplicate refs', async () => {
  const f = scopedFixture('move');
  for (const target of ['', 'Shared/x', 'WebmailVirtual/AllMail', 'x\r\n']) {
    f.options.resolvedTarget = target; await assert.rejects(f.run(), { code: 'FOLDER_NOT_ALLOWED' });
  }
  f.options.resolvedTarget = 'Projects';
  f.options.refs = [ref('WebmailVirtual/AllMail')]; await assert.rejects(f.run(), { code: 'FOLDER_NOT_ALLOWED' });
  for (const refs of [[ref(), ref('Other')], [ref(), ref()]]) {
    f.options.refs = refs; await assert.rejects(f.run(), { code: 'INVALID_ACTION' });
  }
  const g = scopedFixture('delete-forever'); g.options.refs = [ref()];
  await assert.rejects(g.run(), { code: 'DELETE_NOT_ALLOWED' }); assert.deepEqual(g.client.calls, []);
  assert.deepEqual(f.client.calls, []);
});
test('scoped: first minimum probe allows start-margin equality, larger caller reserve remains enforced', async () => {
  const f = scopedFixture(); f.time(10000); assert.equal((await f.run()).processed.length, 1);
  const above = scopedFixture(); above.time(10001); assert.equal((await above.run()).processed.length, 1);
  const g = scopedFixture(); g.options.minStartRemainingMs = 15000; g.time(14999);
  assert.deepEqual((await g.run()).remaining, g.options.refs); assert.deepEqual(g.client.calls, []);
});
test('scoped: read checks consume the same budget; no mutation starts after ACL or search delay', async () => {
  for (const stage of ['rights', 'search']) {
    const f = scopedFixture(); const exec = f.client.exec;
    f.options.resolvedScope.imap = [{ flagged: true }];
    f.client.exec = async (...args) => {
      const result = await exec(...args);
      if (args[0] === (stage === 'rights' ? 'MYRIGHTS' : 'UID SEARCH')) f.time(9999);
      return result;
    };
    const result = await f.run(); assert.deepEqual(result.remaining, f.options.refs); assert.equal(result.reason, 'budget');
    assert.deepEqual(f.client.calls, []); assertScopedPartition(result, f.options.refs, f.outcomes);
  }
});
test('scoped: pre-command budget exhaustion preserves already skipped refs', async () => {
  const f = scopedFixture(); f.options.refs = [ref('INBOX', 7), ref('INBOX', 8)]; f.client.missingUids = new Set([7]);
  f.options.onOutcome = outcome => { f.outcomes.push(outcome); if (outcome.status === 'skipped') f.time(0); };
  const result = await f.run();
  assert.deepEqual(result.skipped, [ref('INBOX', 7)]); assert.deepEqual(result.remaining, [ref('INBOX', 8)]);
  assert.deepEqual(f.client.calls, []); assert.equal(result.reason, 'budget'); assertScopedPartition(result, f.options.refs, f.outcomes);
});
test('scoped: Deleted ACK followed by EXPUNGE failure is unknown for the whole remaining set', async () => {
  const f = scopedFixture('delete-forever'); f.options.refs.push(ref('Trash', 8));
  f.client.mutation = async command => { if (command === 'UID EXPUNGE') throw new Error('synthetic expunge failure'); };
  const result = await f.run(); assert.equal(f.client.calls.length, 2); assert.equal(result.unknown.length, 2);
  assertScopedPartition(result, f.options.refs, f.outcomes);
});
test('scoped: admitted delete unit finishes EXPUNGE after STORE even below request reserve', async () => {
  const f = scopedFixture('delete-forever'); f.client.mutation = async () => f.time(9999);
  const result = await f.run(); assert.equal(f.client.calls.length, 2); assert.equal(result.unknown.length, 0); assert.equal(result.processed.length, 1);
  assert.equal(result.reason, 'complete'); assertScopedPartition(result, f.options.refs, f.outcomes);
});
test('scoped: missing or BYE ACK and explicit server rejection cannot claim success', async () => {
  for (const response of [undefined, { command: 'BYE' }]) {
    const f = scopedFixture(); const exec = f.client.exec;
    f.client.exec = async (...args) => {
      const result = await exec(...args); if (args[0] === 'UID STORE') result.response = response; return result;
    };
    assert.equal((await f.run()).unknown.length, 1);
  }
  const f = scopedFixture(); f.client.mutation = async () => { throw Object.assign(new Error('synthetic NO'), { responseStatus: 'NO' }); };
  assert.equal((await f.run()).unknown.length, 1);
});
test('scoped: partial application before command failure never retries a subset automatically', async () => {
  const f = scopedFixture('move'); f.options.refs.push(ref('INBOX', 8)); let applied;
  f.client.mutation = async (_command, attrs) => { applied = attrs[0].value.split(/[,:]/)[0]; throw new Error('synthetic partial application'); };
  const result = await f.run(); assert.equal(applied, '7'); assert.equal(result.unknown.length, 2);
  assert.equal(f.client.calls.length, 1); assertScopedPartition(result, f.options.refs, f.outcomes);
});
test('scoped: read transport failure is retryable failed, not unknown; session errors propagate before sending', async () => {
  const f = scopedFixture(); const exec = f.client.exec; f.client.exec = async (...args) => { if (args[0] === 'UID SEARCH') throw new Error('synthetic search failed'); return exec(...args); };
  const result = await f.run(); assert.deepEqual(result.failed, [{ ref: ref(), code: 'MAIL_UNAVAILABLE', retryable: true }]);
  assertScopedPartition(result, f.options.refs, f.outcomes);
  const g = scopedFixture(); const next = g.client.exec; g.client.exec = async (...args) => { if (args[0] === 'UID SEARCH') throw Object.assign(new Error('synthetic expiry'), { code: 'SESSION_EXPIRED' }); return next(...args); };
  await assert.rejects(g.run(), { code: 'SESSION_EXPIRED' }); assert.deepEqual(g.client.calls, []);
});

for (const action of ['seen', 'move', 'delete-forever']) test(`scoped ${action}: sent mutation survives request/proxy deadline with no close and confirms ACK`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = scopedFixture(action); let release, started, commands = 0, closed = 0;
  const commandStarted = new Promise(resolve => { started = resolve; });
  const timeouts = [];
  f.client.socket = { timeout: 60000, setTimeout(ms) { this.timeout = ms; timeouts.push(ms); } };
  const close = f.client.close.bind(f.client); f.client.close = () => { closed++; close(); };
  f.client.mutation = async () => { if (++commands === 1) { started(); await new Promise(resolve => { release = resolve; }); } };
  const pool = createImapPool({
    config: { imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com' },
    destroySession: async () => {}, clientFactory: () => f.client,
  });
  const logged = await pool.verifyLogin({ email: 'synthetic@example.com', password: Buffer.from('synthetic-password') });
  const running = createActionService({ imap: pool }).runScopedGroup({ connection: logged.connection }, f.options);
  let completed = false; running.then(() => { completed = true; });
  await commandStarted;
  f.time(0); t.mock.timers.tick(65000); await nextTurn();
  assert.equal(completed, false); assert.equal(closed, 0); assert.equal(f.client.usable, true);
  assert.equal(f.client.socket.timeout, 120000);
  release(); const result = await running;
  assert.deepEqual(result.processed, f.options.refs); assert.equal(result.unknown.length, 0);
  assert.equal(closed, 0); assert.deepEqual(timeouts, [120000, 60000]);
  assert.equal(commands, action === 'delete-forever' ? 2 : 1);
  assertScopedPartition(result, f.options.refs, f.outcomes);
  await logged.connection.logout();
});
test('scoped: 120-second mutation cap closes once, records unknown and rejects late continuation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = scopedFixture('delete-forever'); let release, started, closed = 0;
  const commandStarted = new Promise(resolve => { started = resolve; });
  const close = f.client.close.bind(f.client); f.client.close = () => { closed++; close(); };
  f.client.mutation = async () => { started(); await new Promise(resolve => { release = resolve; }); };
  const pool = createImapPool({
    config: { imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com' },
    destroySession: async () => {}, clientFactory: () => f.client,
  });
  const logged = await pool.verifyLogin({ email: 'synthetic@example.com', password: Buffer.from('synthetic-password') });
  const running = createActionService({ imap: pool }).runScopedGroup({ connection: logged.connection }, f.options);
  await commandStarted; f.time(0); t.mock.timers.tick(50000); await nextTurn(); assert.equal(closed, 0);
  t.mock.timers.tick(70000); const result = await running;
  assert.equal(closed, 1); assert.equal(result.unknown.length, 1); assert.equal(result.unknown[0].retryable, false);
  release(); await nextTurn(); assert.deepEqual(f.client.calls.map(call => call[0]), ['UID STORE']);
  assertScopedPartition(result, f.options.refs, f.outcomes);
  await logged.connection.logout();
});
test('scoped: a completed ACK and outcome survive deadline exhaustion immediately afterward', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = scopedFixture();
  const pool = createImapPool({
    config: { imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com' },
    destroySession: async () => {}, clientFactory: () => f.client,
  });
  const logged = await pool.verifyLogin({ email: 'synthetic@example.com', password: Buffer.from('synthetic-password') });
  f.options.onOutcome = outcome => { f.outcomes.push(outcome); f.time(0); };
  const result = await createActionService({ imap: pool }).runScopedGroup({ connection: logged.connection }, f.options);
  assert.deepEqual(result.processed, f.options.refs); assert.deepEqual(result.unknown, []);
  assertScopedPartition(result, f.options.refs, f.outcomes);
  await logged.connection.logout();
});
test('scoped: native MOVE is available with active IMAP4rev2 without a separate MOVE token', async () => {
  const f = scopedFixture('move'); f.client.capabilities.clear(); f.client.enabled.add('IMAP4REV2');
  const result = await f.run(); assert.deepEqual(result.processed, f.options.refs);
  assert.equal(f.client.calls[0][0], 'UID MOVE'); assertScopedPartition(result, f.options.refs, f.outcomes);
});


test('scoped service: MOVE ACK after proxy deadline is retained for same-cursor receipt replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = scopedFixture('move'); const exec = f.client.exec, lock = f.client.getMailboxLock.bind(f.client);
  f.client.exec = async (command, attributes, options) => {
    if (command === 'UID SORT') { options.untagged.SORT({ attributes: [{ value: '7' }] }); return { next() {} }; }
    return exec(command, attributes, options);
  };
  f.client.getMailboxLock = async (...args) => { const held = await lock(...args); f.client.mailbox.uidNext = 8; return held; };
  let closed = 0, entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const close = f.client.close.bind(f.client); f.client.close = () => { closed++; close(); };
  const pool = createImapPool({
    config: { imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com' },
    destroySession: async () => {}, clientFactory: () => f.client,
  });
  const logged = await pool.verifyLogin({ email: 'synthetic@example.com', password: Buffer.from('synthetic-password') });
  t.after(() => logged.connection.logout());
  const session = { connection: logged.connection, scanAbort: new AbortController() };
  const service = createScopedActionService({ imap: pool });
  const body = { selectionKey: 'synthetic-late-move', scope: {}, action: 'move', target: 'Projects' };
  const ready = await service.prepare(session, body, { budget: f.budget });
  f.client.mutation = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const request = { scope: {}, action: 'move', target: 'Projects', cursor: ready.cursor };
  const running = service.execute(session, request, { budget: f.budget });
  let responded = false; running.then(() => { responded = true; });
  await started; f.time(0); t.mock.timers.tick(65000); await nextTurn();
  assert.equal(responded, false); assert.equal(closed, 0);
  await assert.rejects(service.execute(session, request, { budget: f.budget }), { code: 'SCOPE_BUSY' });
  release(); const receipt = await running;
  assert.deepEqual(receipt.totals, { processed: 1, skipped: 0, failed: 0 });
  assert.equal(receipt.state, 'completed');
  const count = f.client.calls.length;
  assert.deepEqual(await service.execute(session, request, { budget: f.budget }), receipt);
  assert.equal(f.client.calls.length, count); assert.equal(closed, 0);
});


for (const remaining of [42000, 42001]) test(`scoped adaptive admission: ${remaining}ms applies strict reserve after a prior mutation`, async () => {
  const f = scopedFixture('move');
  f.options.batchState = { ...scopedBatchState('move'), lastMs: 20000, lastCount: 1 };
  f.options.checks = { rights: new Map(), folders: null, mutationsStarted: 1 };
  f.time(remaining);
  const result = await f.run();
  assert.equal(result.processed.length, remaining > 42000 ? 1 : 0);
  assert.equal(result.remaining.length, remaining > 42000 ? 0 : 1);
  assert.equal(f.client.calls.length, remaining > 42000 ? 1 : 0);
});


for (const action of ['seen', 'move']) for (const remaining of [9999, 10000, 10001, 37999, 38000, 38001, 50000]) test(`minimum probe ${action}: first mutation with ${remaining}ms remaining ignores an oversized old estimate`, async () => {
  const f = scopedFixture(action);
  f.options.refs = Array.from({ length: 100 }, (_, index) => ref('INBOX', index + 1));
  f.client.matches = Array.from({ length: 100 }, (_, index) => index + 1);
  f.options.batchState = { ...scopedBatchState(action), lastMs: 60000, lastCount: 50 };
  f.time(remaining); f.client.mutation = async () => f.time(0);
  const result = await f.run();
  assert.equal(result.processed.length, remaining >= (action === 'seen' ? 10000 : 38000) ? 50 : 0);
  assert.equal(result.remaining.length, remaining >= (action === 'seen' ? 10000 : 38000) ? 50 : 100);
  assert.equal(f.client.calls.length, remaining >= (action === 'seen' ? 10000 : 38000) ? 1 : 0);
  if (remaining >= (action === 'seen' ? 10000 : 38000)) assert.equal(f.client.calls[0][1][0].value, '1:50');
  assertScopedPartition(result, f.options.refs, f.outcomes);
});

test('minimum probe: another source group cannot force a second mutation in the same request', async () => {
  const f = scopedFixture('move');
  f.options.batchState = { ...scopedBatchState('move'), lastMs: 60000, lastCount: 1 };
  f.options.checks = { rights: new Map(), folders: null, mutationsStarted: 1 };
  const result = await f.run();
  assert.equal(result.processed.length, 0); assert.deepEqual(result.remaining, f.options.refs);
  assert.equal(f.client.calls.length, 0);
});


for (const action of scopedActions) for (const remaining of [37999, 38000, 38001]) test(`stall allowance ${action}: remaining ${remaining}ms`, async () => {
  const f = scopedFixture(action);
  if (action === 'notspam') f.options.refs = [ref('Junk')];
  f.time(remaining);
  const result = await f.run();
  const protectedAction = movingActions.includes(action) || action === 'delete-forever';
  const allowed = !protectedAction || remaining >= 38000;
  assert.equal(result.processed.length, allowed ? 1 : 0);
  assert.equal(result.remaining.length, allowed ? 0 : 1);
  assert.equal(f.client.calls.length, allowed ? action === 'delete-forever' ? 2 : 1 : 0);
  assertScopedPartition(result, f.options.refs, f.outcomes);
});
for (const action of ['seen', 'unseen', 'flag', 'unflag']) for (const remaining of [10000, 10001]) test(`flags preserve start reserve ${action}: ${remaining}ms after prior mutation`, async () => {
  const f = scopedFixture(action);
  f.options.checks = { rights: new Map(), folders: null, mutationsStarted: 1 };
  f.time(remaining); const result = await f.run();
  assert.equal(result.processed.length, remaining > 10000 ? 1 : 0);
  assert.equal(f.client.calls.length, remaining > 10000 ? 1 : 0);
});
