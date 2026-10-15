import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { get } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionService } from '../../server/mail/actions.js';
import { createEventService } from '../../server/mail/events.js';
import { encodeRef, decodeRef, assertUidValidity } from '../../server/mail/ref.js';
import { createApp } from '../../server/app.js';

const ref = (path = 'INBOX', uid = 7) => encodeRef(path, 123, uid);
class ActionImap extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; this.enabled = new Set(); this.capabilities = new Map(); this.calls = []; this.access = new Map(); this.usable = false; this.archive = 'Saved'; this.total = 3; this.unseen = 2; this.usage = 100; this.limit = 1000; }
  async connect() { this.usable = true; }
  close() { this.usable = false; this.emit('close'); }
  async logout() { this.close(); }
  async getMailboxLock(path) { this.mailbox = { path, uidValidity: 123n }; return { release() {} }; }
  async mailboxOpen(path) { this.mailbox = { path, uidValidity: 123n }; }
  async idle() { return new Promise(() => {}); }
  async exec(command, attrs, {untagged} = {}) {
    if (command === 'MYRIGHTS') untagged.MYRIGHTS({attributes:[attrs[0],{value:this.access.get(attrs[0].value) ?? 'lrswite'}]});
    else this.calls.push([command,attrs]);
    return {next:()=>{ if(command==='UID EXPUNGE') this.calls.push(['next']); }};
  }
  async fetchOne(uid) { return this.missing ? false : {uid}; }
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
  const imap = {async withRef(_session, token, operation) { const value = decodeRef(token); await client.getMailboxLock(value.path); assertUidValidity(client,value); return operation(client); }};
  return {client,service:createActionService({imap})};
}
for (const [action,method,flag] of [['seen','add','\\Seen'],['unseen','remove','\\Seen'],['flag','add','\\Flagged'],['unflag','remove','\\Flagged']]) test(`action ${action}: expected UID flag call`, async()=>{
  const f=fixture(); assert.deepEqual(await f.service.run({}, {refs:[ref()],action}),{done:1,failed:[]}); assert.deepEqual(f.client.calls,[[method,7,[flag],{uid:true}]]);
});
for (const [action,target] of [['move','Projects/합성'],['archive','Saved'],['trash','Trash'],['spam','Junk'],['notspam','INBOX']]) test(`action ${action}: expected original-folder UID MOVE`,async()=>{
  const f=fixture(); const token=ref('Projects/원본',9); assert.equal((await f.service.run({}, {refs:[token],action,target})).done,1); assert.equal(f.client.mailbox.path,'Projects/원본'); assert.deepEqual(f.client.calls,[['move',9,target,{uid:true}]]);
});
test('action delete-forever: Trash and Junk use Deleted plus UID EXPUNGE only',async()=>{
  const f=fixture(); assert.equal((await f.service.run({}, {refs:[ref('Trash'),ref('Junk',8)],action:'delete-forever'})).done,2);
  assert.deepEqual(f.client.calls.slice(0,3),[['add',7,['\\Deleted'],{uid:true}],['UID EXPUNGE',[{type:'SEQUENCE',value:'7'}]],['next']]);
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
  assert.equal((await f.service.run({}, {refs:[ref()],action:'archive'})).done,1); assert.deepEqual(f.client.calls,[['create','Archive'],['move',7,'Archive',{uid:true}]]);
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
