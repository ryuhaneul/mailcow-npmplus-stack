import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { connect } from 'node:net';
import { createBouncePolicy, createBouncePolicyListener, bounceAddress } from '../../server/admin/bounce-policy.js';
const T = Date.parse('2026-11-05T10:00:00.000Z');
function fixture() {
  let time = T; const policy = createBouncePolicy({ now:()=>time });
  const row = {recipient:'User+tag@example.net',internalExcluded:false,manual:null,autoUntil:new Date(T+3600000).toISOString()};
  const state = { recipients:[row] }, settings = {bounceAuto:{enabled:true}};
  const fields={request:'smtpd_access_policy',protocol_state:'RCPT',policy_context:'mailstack-bounce',recipient:row.recipient};
  return { policy, row, state, settings, fields, time:v=>{time=v;}, ready:()=>{policy.setDomains(['example.com','alias.example.com']);policy.publish(state,settings);} };
}
test('exact recipient, case, plus and IDNA; manual takes priority; internal and unsupported addresses never reject',()=>{
  const f=fixture();assert.equal(f.policy.action(f.fields),'DUNNO');f.ready();assert.match(f.policy.action(f.fields),/^450 4\.7\.1 /);
  for(const recipient of ['user+tag@example.net','User@example.net','User+tag@sub.example.net'])assert.equal(f.policy.action({...f.fields,recipient}),'DUNNO');
  assert.match(f.policy.action({...f.fields,recipient:'User+tag@EXAMPLE.NET'}),/^450 /);
  f.row.manual={until:null};f.ready();assert.match(f.policy.action(f.fields),/^550 5\.7\.1 /);
  f.settings.bounceAuto.enabled=false;f.ready();assert.match(f.policy.action(f.fields),/^550 /);
  f.row.manual=null;f.ready();assert.equal(f.policy.action(f.fields),'DUNNO');
  assert.deepEqual(bounceAddress('User+tag@bücher.example'),{recipient:'User+tag@xn--bcher-kva.example',domain:'xn--bcher-kva.example',supported:true});
  assert.equal(bounceAddress('"name here"@example.net').supported,false);
  assert.equal(bounceAddress('이름@example.net').supported,false);
  assert.equal(bounceAddress('a@example.net\nRCPT=bad'),null);
  for(const recipient of ['a@example.com','a@alias.example.com','a@localhost','a@foo.localhost']){f.state.recipients=[{...f.row,recipient,manual:{until:null}}];f.ready();assert.equal(f.policy.action({...f.fields,recipient}),'DUNNO');}
  f.state.recipients=[{...f.row,recipient:'a@sub.example.com',manual:{until:null}}];f.ready();assert.match(f.policy.action({...f.fields,recipient:'a@sub.example.com'}),/^550 /);
});
test('TTL expires immediately, domain cache is five minutes, failure stays fail-open until successful refresh',()=>{
  const f=fixture();f.row.autoUntil=new Date(T+60000).toISOString();f.ready();
  f.time(T+60000);assert.equal(f.policy.action(f.fields),'DUNNO');
  f.row.manual={until:null};f.ready();f.time(T+360000);assert.equal(f.policy.action(f.fields),'DUNNO');
  f.ready();assert.match(f.policy.action(f.fields),/^550 /);f.policy.invalidate('DOMAINS_UNAVAILABLE');
  f.policy.publish(f.state,f.settings);assert.equal(f.policy.action(f.fields),'DUNNO');assert.equal(f.policy.status().available,false);
  f.ready();assert.match(f.policy.action(f.fields),/^550 /);f.policy.invalidate('STORE_UNAVAILABLE');assert.equal(f.policy.action(f.fields),'DUNNO');
  f.ready();for(const patch of [{protocol_state:'DATA'},{request:'other'},{policy_context:''}])assert.equal(f.policy.action({...f.fields,...patch}),'DUNNO');
});
const frame=recipient=>`request=smtpd_access_policy\nprotocol_state=RCPT\npolicy_context=mailstack-bounce\nrecipient=${recipient}\n\n`;
test('actual TCP handles split and pipelined requests and closes cleanly',async t=>{
  const f=fixture();f.ready();const listener=createBouncePolicyListener({config:{bind:'127.0.0.2',peer:'127.0.0.1',port:10040},policy:f.policy});
  await listener.start();t.after(()=>listener.stop());
  const socket=connect({host:'127.0.0.2',port:10040,localAddress:'127.0.0.1'});socket.on('error',()=>{});await once(socket,'connect');t.after(()=>socket.destroy());
  let data='';socket.on('data',chunk=>{data+=chunk;});
  const request=frame(f.row.recipient);socket.write(request.slice(0,19));socket.write(request.slice(19)+frame('good@example.net'));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('response timeout')),1000);const check=()=>{if(data.split('\n\n').length===3){clearTimeout(timer);socket.off('data',check);resolve();}};socket.on('data',check);check();});
  assert.equal(data,'action=450 4.7.1 MAILSTACK_RCPT_SUPPRESSED Recipient temporarily suppressed; retry later\n\naction=DUNNO\n\n');
});
function fakeListener() {
  let accept;const timers=[];const server=new EventEmitter();server.listen=(_port,_bind,fn)=>fn();server.close=fn=>fn();
  const f=fixture();f.ready();const listener=createBouncePolicyListener({config:{bind:'192.0.2.241',peer:'192.0.2.253',port:10040},policy:f.policy,netServer:fn=>{accept=fn;return server;},setTimeout:(fn,ms)=>{const timer={fn,ms,unref(){}};timers.push(timer);return timer;},clearTimeout:timer=>{if(timer)timer.cancelled=true;}});
  const socket=(peer='192.0.2.253')=>{const s=new EventEmitter();s.remoteAddress=peer;s.responses=[];s.setTimeout=(ms,fn)=>{s.idle={ms,fn};};s.write=text=>{s.responses.push(text);return true;};s.destroy=()=>{s.destroyed=true;s.emit('close');};accept(s);return s;};
  return {listener,socket,timers};
}
test('peer, frame size, duplicate fields, control characters and request deadline are bounded',async()=>{
  const f=fakeListener();await f.listener.start();
  assert.equal(f.socket('192.0.2.1').destroyed,true);
  for(const text of ['a='.padEnd(16385,'x'),'recipient=a\r\n\r\n','x=bad\u0000\n\n']){const s=f.socket();s.emit('data',Buffer.from(text));assert.equal(s.destroyed,true);}
  const duplicate=f.socket();duplicate.emit('data',Buffer.from(frame('a@example.net').replace('recipient=','request=duplicate\nrecipient=')));assert.deepEqual(duplicate.responses,['action=DUNNO\n\n']);duplicate.destroy();
  const stalled=f.socket();stalled.emit('data',Buffer.from('request='));const timer=f.timers.findLast(t=>!t.cancelled);assert.equal(timer.ms,1000);timer.fn();assert.equal(stalled.destroyed,true);
  const idle=f.socket();assert.equal(idle.idle.ms,30000);idle.idle.fn();assert.equal(idle.destroyed,true);
  const sockets=Array.from({length:64},()=>f.socket());assert.equal(sockets.at(-1).destroyed,undefined);assert.equal(f.socket().destroyed,true);
  await f.listener.stop();assert.ok(sockets.every(s=>s.destroyed));
});
test('config limits policy to distinct mailcow-network addresses and requires collection prerequisites',async()=>{
  const {loadAdminConfig}=await import('../../server/admin/config.js');
  const env={ADMIN_MODE:'true',ADMIN_HOSTNAME:'admin.example.com',ADMIN_SESSION_IDLE_MIN:'60',ADMIN_SESSION_MAX_HOURS:'8',MAILCOW_UI_URL:'https://mailcow.example.com/',MAILCOW_UI_SERVERNAME:'mail.example.com',IMAP_HOST:'dovecot',SMTP_HOST:'postfix',MAIL_TLS_SERVERNAME:'mail.example.com',MAIL_TLS_MODE:'verify',MAIL_TLS_PIN_FILE:'',DOMAIN:'example.com',TRUST_PROXY:'192.0.2.2/32',DOCKERAPI_URL:'https://dockerapi:443',DOVEADM_URL:'',DOVEADM_KEY:'',TRUSTED_SENDER_FILE:'',RELAY_FILES:'',MAILCOW_IPV4_NETWORK:'192.0.2',MAILCOW_IPV6_NETWORK:'',AUTOEXPUNGE_DAYS:'',LOGO_DIR:'',AUDIT_DIR:'/data/audit',LOG_LEVEL:'silent'};
  assert.deepEqual(loadAdminConfig(env).bouncePolicy,{bind:'',peer:'',port:10040});
  const configured={...env,MAILCOW_API_KEY:'synthetic',LOG_ARCHIVE_URL:'http://archive:9200/',LOG_ARCHIVE_KEY:'synthetic',BOUNCE_POLICY_BIND:'192.0.2.241',BOUNCE_POLICY_PEER:'192.0.2.253'};
  assert.deepEqual(loadAdminConfig(configured).bouncePolicy,{bind:'192.0.2.241',peer:'192.0.2.253',port:10040});
  for(const patch of [{BOUNCE_POLICY_BIND:'0.0.0.0'},{BOUNCE_POLICY_PEER:''},{BOUNCE_POLICY_PEER:'192.0.2.241'},{BOUNCE_POLICY_PEER:'198.51.100.253'},{BOUNCE_POLICY_PORT:'25'},{LOG_ARCHIVE_KEY:''},{MAILCOW_API_KEY:''}])assert.throws(()=>loadAdminConfig({...configured,...patch}));
});
