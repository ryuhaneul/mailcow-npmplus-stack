import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { createPasswordService } from '../../server/mailcow/password.js';
import { createRateLimiter } from '../../server/security/ratelimit.js';
import { createApp } from '../../server/app.js';
import { logOptions } from '../../server/log.js';

const current = 'synthetic-current-password!';
const next = 'synthetic-next-password!';
const csrf = 'a'.repeat(64);
let tempRoot, key, cert;
const collected=[];
const logger={info:data=>collected.push(JSON.stringify(data)),warn:data=>collected.push(JSON.stringify(data))};
before(async()=>{
  tempRoot=await mkdtemp(join(tmpdir(),'webmail-w15-test-'));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(tempRoot,'key.pem'),'-out',join(tempRoot,'cert.pem'),'-days','1','-subj','/CN=mail.example.com','-addext','subjectAltName=DNS:mail.example.com'],{stdio:'ignore'});
  key=await readFile(join(tempRoot,'key.pem'));cert=await readFile(join(tempRoot,'cert.pem'));
});
after(async()=>{
  if(process.env.WEBMAIL_PASSWORD_TEST_LOG) await writeFile(process.env.WEBMAIL_PASSWORD_TEST_LOG,collected.join('\n')+'\n');
  await rm(tempRoot,{recursive:true,force:true});
});
async function mailcow(t, mode='success') {
  const calls=[],states=new Map();let serial=0;
  const server=https.createServer({key,cert},async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const form=new URLSearchParams(Buffer.concat(chunks).toString());
    const cookie=req.headers.cookie||'';const sid=/PHPSESSID=([^;]+)/.exec(cookie)?.[1];
    calls.push({path:req.url,method:req.method,cookie,form,headers:req.headers});
    const html=body=>{res.setHeader('content-type','text/html');res.end(body);};
    if(req.url==='/'&&req.method==='GET'){
      const id='synthetic-'+(++serial);states.set(id,{});res.setHeader('set-cookie',`PHPSESSID=${id}; Secure; HttpOnly; Path=/`);
      return html(mode==='bad-login-form'?'<html>changed</html>':'<form method="post"><input name="login_user"><input type="password" name="pass_user"></form>');
    }
    if(form.has('logout')){if(sid) states.delete(sid);res.statusCode=302;res.setHeader('location','/');return res.end();}
    if(req.url==='/'&&req.method==='POST'){
      assert.ok(states.has(sid));assert.equal(form.get('pass_user'),current);
      states.get(sid).email=form.get('login_user');
      if(mode==='2fa') return html('<div id="ConfirmTFAModal"><input name="verify_tfa_login"></div>');
      if(mode==='hang') return;
      res.statusCode=302;res.setHeader('location',mode==='external-redirect'?'https://untrusted.example.org/':'/SOGo/so/');return res.end();
    }
    if(req.url==='/user'){
      if(mode==='2fa-user') return html('<div id="ConfirmTFAModal"></div>');
      const email=mode==='wrong-user'?'other@example.com':states.get(sid)?.email;
      const token=mode==='missing-csrf'?'':mode==='inline-csrf'?`<script>var request = {csrf_token: '${csrf}'};</script>`:mode==='hidden-csrf'?`<input type="hidden" name="csrf_token" value="${csrf}">`:`<script>$('<input type="hidden" value="${csrf}">').attr('name', 'csrf_token').appendTo('form');</script>`;
      return html(`<li class="logged-in-as"><b class="username-lia">${email?.replace(/&/g,'&amp;')}</b></li>${token}`);
    }
    if(req.url==='/api/v1/edit/self'){
      assert.ok(states.has(sid));assert.equal(form.get('csrf_token'),csrf);assert.equal(form.get('items'),'null');
      const attrs=JSON.parse(form.get('attr'));assert.deepEqual(Object.keys(attrs).sort(),['user_new_pass','user_new_pass2','user_old_pass']);assert.equal(attrs.user_old_pass,current);assert.equal(attrs.user_new_pass,next);assert.equal(attrs.user_new_pass2,next);
      res.setHeader('content-type','application/json');
      if(mode==='bad-json') return res.end('<html>changed</html>');
      if(mode==='wrong-success') return res.end(JSON.stringify([{type:'success',msg:'Task completed'}]));
      if(mode==='bad-address-shape') return res.end(JSON.stringify([{type:'success',msg:['mailbox_modified',{}]}]));
      if(mode==='policy') return res.end(JSON.stringify([{type:'danger',msg:'password_complexity'}]));
      if(mode==='policy-sensitive') return res.end(JSON.stringify([{type:'danger',msg:'server echoed '+next}]));
      return res.end(JSON.stringify([{type:'success',msg:['mailbox_modified',states.get(sid).email.replace(/&/g,'&amp;')]}]));
    }
    assert.fail('Unexpected redirect/endpoint: '+req.url);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const config={mailcowUiUrl:`https://127.0.0.1:${server.address().port}`,mailcowUiServername:'mail.example.com',mailcowPublicUrl:'https://mail.example.com',mailTlsMode:'pin',mailTlsPinFile:join(tempRoot,'cert.pem'),mailTlsServername:'imap.example.com'};
  return {config,calls,states,server};
}
function service(config, overrides={}) {
  const session={email:'user@example.com',password:Buffer.from(current),ip:'198.51.100.7'};const terminated=[];
  return {session,terminated,service:createPasswordService({config,logger,rateLimiter:createRateLimiter(),sessions:{async destroyAllFor(email){terminated.push(email);}},...overrides})};
}
const body=()=>({current,next,next2:next});
for(const mode of ['success','inline-csrf','hidden-csrf','external-redirect'])test(`password proxy: ${mode}, fixed paths/Host, logout and full account session destruction`,async t=>{
  const fake=await mailcow(t,mode);const f=service(fake.config);const input={...body(),email:'victim@example.org',username:'victim@example.org'};
  assert.deepEqual(await f.service.change(f.session,input),{relogin:true});assert.deepEqual(f.terminated,['user@example.com']);assert.equal(input.current,undefined);assert.equal(input.next,undefined);
  assert.deepEqual(fake.calls.map(call=>call.path),['/','/','/user','/api/v1/edit/self','/']);assert.equal(fake.calls[1].form.get('login_user'),'user@example.com');assert.ok(fake.calls.every(call=>call.headers.host==='mail.example.com'&&call.headers['user-agent']==='mailstack-webmail'&&!call.headers.authorization&&!call.headers['x-api-key']));assert.equal(fake.states.size,0);
});
test('password: wrong current, mismatch, same and malformed never contact mailcow',async t=>{
  const fake=await mailcow(t);const f=service(fake.config);
  for(const [input,code,statusCode] of [[{...body(),current:'wrong-current'},'CURRENT_WRONG',403],[{...body(),next2:'different'},'PW_MISMATCH',422],[{current,next:current,next2:current},'PW_SAME',422],[{next,next2:next},'PW_FORMAT',422]]) await assert.rejects(f.service.change(f.session,input),{code,statusCode});
  assert.equal(fake.calls.length,0);assert.equal(f.terminated.length,0);
});
test('password: sixth attempt is 429 without contacting mailcow',async t=>{
  const fake=await mailcow(t);const f=service(fake.config);
  for(let i=0;i<5;i++) await assert.rejects(f.service.change(f.session,{...body(),current:'wrong'}),{statusCode:403});
  await assert.rejects(f.service.change(f.session,body()),{statusCode:429,retryAfter:3600});assert.equal(fake.calls.length,0);
});
for(const mode of ['2fa','2fa-user'])test(`password: ${mode} returns 403 and public fallback, no edit request`,async t=>{
  const fake=await mailcow(t,mode);const f=service(fake.config);await assert.rejects(f.service.change(f.session,body()),{statusCode:403,code:'MAILCOW_2FA',fallbackUrl:'https://mail.example.com'});assert.ok(fake.calls.at(-1).form.has('logout'));assert.ok(!fake.calls.some(call=>call.path.includes('edit')));assert.equal(f.terminated.length,0);
});
for(const mode of ['bad-login-form','wrong-user','missing-csrf','bad-json','wrong-success','bad-address-shape'])test(`password: ${mode} fails closed with 503 and fallback`,async t=>{
  const fake=await mailcow(t,mode);const f=service(fake.config);await assert.rejects(f.service.change(f.session,body()),{statusCode:503,fallbackUrl:'https://mail.example.com'});assert.ok(fake.calls.at(-1).form.has('logout'));assert.equal(fake.states.size,0);assert.equal(f.terminated.length,0);
  if(mode==='wrong-user') assert.ok(!fake.calls.some(call=>call.path.includes('edit')));
});
for(const mode of ['policy','policy-sensitive'])test(`password: ${mode} is 422 with safe policy message and logout`,async t=>{
  const fake=await mailcow(t,mode);const f=service(fake.config);await assert.rejects(f.service.change(f.session,body()),error=>error.code==='PW_POLICY'&&error.statusCode===422&&!error.message.includes(next));assert.ok(fake.calls.at(-1).form.has('logout'));assert.equal(f.terminated.length,0);
});
test('password: concurrent transactions have isolated cookie jars; no cross-request cookie replay',async t=>{
  const fake=await mailcow(t);const f=service(fake.config);const second={...f.session,email:'second@example.org',password:Buffer.from(current)};
  await Promise.all([f.service.change(f.session,body()),f.service.change(second,body())]);const initial=fake.calls.filter(call=>call.path==='/'&&call.method==='GET');assert.equal(initial.length,2);assert.ok(initial.every(call=>call.cookie===''));
  const login=fake.calls.filter(call=>call.form.has('login_user'));assert.equal(new Set(login.map(call=>call.cookie)).size,2);assert.deepEqual(new Set(f.terminated),new Set(['user@example.com','second@example.org']));assert.equal(fake.states.size,0);
  await f.service.change(f.session,body());assert.equal(fake.calls.filter(call=>call.path==='/'&&call.method==='GET').at(-1).cookie,'');
});
test('password: escaped account address in mailcow success response is decoded for identity match',async t=>{
  const fake=await mailcow(t);const f=service(fake.config);f.session.email='user&tag@example.com';assert.deepEqual(await f.service.change(f.session,body()),{relogin:true});assert.deepEqual(f.terminated,['user&tag@example.com']);
});
test('password: request credential Buffers are wiped on success and failure, memory session is preserved on failure',async()=>{
  let buffers;const fake={async change(_email,credentials){buffers=Object.values(credentials);assert.ok(buffers.every(Buffer.isBuffer));}};
  const f=service({}, {proxy:fake});await f.service.change(f.session,body());assert.ok(buffers.every(buffer=>buffer.every(byte=>byte===0)));
  fake.change=async(_email,credentials)=>{buffers=Object.values(credentials);throw new Error('synthetic error');};await assert.rejects(f.service.change(f.session,body()),/synthetic error/);assert.ok(buffers.every(buffer=>buffer.every(byte=>byte===0)));assert.equal(f.session.password.toString(),current);
});
test('password TLS: verify rejects self-signed certificate and incorrect pin hostname fails',async t=>{
  const fake=await mailcow(t);for(const config of [{...fake.config,mailTlsMode:'verify'},{...fake.config,mailcowUiServername:'wrong.example.com'}]){
    await assert.rejects(service(config).service.change(service(config).session,body()),{statusCode:503,code:'MAILCOW_UNAVAILABLE'});
  }assert.equal(fake.calls.length,0);
});
test('password: 15-second total timeout aborts stalled login',async t=>{
  const fake=await mailcow(t,'hang');t.mock.timers.enable({apis:['setTimeout']});
  const f=service(fake.config);const pending=f.service.change(f.session,body());const rejected=assert.rejects(pending,{statusCode:503,code:'MAILCOW_UNAVAILABLE'});
  while(!fake.calls.some(call=>call.form.has('login_user'))) await immediate();
  t.mock.timers.tick(15000);await rejected;assert.equal(f.terminated.length,0);
});
test('HTTP password route: success ends all same-user sessions only; CSRF, fallback and log redaction',async t=>{
  const fake=await mailcow(t);
  const config={...fake.config,publicHostnames:['newmail.example.com'],trustProxy:['127.0.0.0/8'],sessionIdleMin:480,sessionMaxHours:24,logLevel:'info'};
  const localRoot=await mkdtemp(join(tempRoot,'sessions-'));const stream={write:line=>collected.push(line)};
  const app=await createApp({config,logger:{...logOptions('info'),stream},auth:{tempRoot:localRoot,verifyLogin:async({email})=>({name:email,connection:{async logout(){}}})}});
  app.directory.mailboxName = async email => email;
  t.after(()=>app.close());
  const login=async email=>app.inject({method:'POST',url:'/api/auth/login',headers:{origin:'https://newmail.example.com'},payload:{email,password:current}});
  const a=await login('user@example.com'),b=await login('user@example.com'),other=await login('other@example.org');
  const cookie=response=>response.headers['set-cookie'].split(';')[0];
  const headers={cookie:cookie(a),origin:'https://newmail.example.com','x-webmail-csrf':a.json().csrf};
  const missing=await app.inject({method:'POST',url:'/api/password',headers:{cookie:cookie(a),origin:headers.origin},payload:body()});assert.equal(missing.statusCode,403);assert.equal(fake.calls.length,0);
  const changed=await app.inject({method:'POST',url:'/api/password',headers,payload:{...body(),email:'victim@example.org'}});assert.equal(changed.statusCode,200);assert.deepEqual(changed.json(),{relogin:true});assert.match(changed.headers['set-cookie'],/Max-Age=0/);assert.equal(changed.headers['www-authenticate'],undefined);
  for(const logged of [a,b]) assert.equal((await app.inject({url:'/api/auth/session',headers:{cookie:cookie(logged)}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/auth/session',headers:{cookie:cookie(other)}})).statusCode,200);
});
test('password logs: no test passwords appear in collected service/HTTP logs',()=>{
  const text=collected.join('\n');for(const password of [current,next,'wrong-current'])assert.equal(text.split(password).length-1,0);
});
for(const [mode,status,code] of [['2fa',403,'MAILCOW_2FA'],['bad-json',503,'MAILCOW_UNAVAILABLE'],['wrong-current',403,'CURRENT_WRONG']])test(`HTTP password fallback: ${mode} preserves public URL and error format`,async t=>{
  const fake=await mailcow(t,mode);
  const config={...fake.config,publicHostnames:['newmail.example.com'],trustProxy:['127.0.0.0/8'],sessionIdleMin:480,sessionMaxHours:24,logLevel:'info'};
  const localRoot=await mkdtemp(join(tempRoot,'fallback-sessions-'));
  const app=await createApp({config,logger:{...logOptions('info'),stream:{write:line=>collected.push(line)}},auth:{tempRoot:localRoot,verifyLogin:async()=>({name:'user',connection:{async logout(){}}})}});
  app.directory.mailboxName = async email => email;
  t.after(()=>app.close());
  const logged=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:'https://newmail.example.com'},payload:{email:'user@example.com',password:current}});
  const response=await app.inject({method:'POST',url:'/api/password',headers:{cookie:logged.headers['set-cookie'].split(';')[0],origin:'https://newmail.example.com','x-webmail-csrf':logged.json().csrf},payload:mode==='wrong-current'?{...body(),current:'wrong-current'}:body()});
  assert.equal(response.statusCode,status);assert.equal(response.json().error.code,code);assert.equal(response.json().error.fallbackUrl,'https://mail.example.com');assert.equal(response.headers['www-authenticate'],undefined);assert.equal(response.headers['x-content-type-options'],'nosniff');
});
