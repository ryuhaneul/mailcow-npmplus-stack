import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { AppError, installErrors } from '../../server/errors.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createAudit } from '../../server/admin/audit.js';
import { createOtpAdminService } from '../../server/admin/services/otp.js';
import routes from '../../server/admin/routes/otp.js';
import { installAdminGuard } from '../../server/admin/guard.js';
import { loadAdminConfig } from '../../server/admin/config.js';
const email = 'user@example.com', token = 'mak_v1_'+'A'.repeat(43), version = 'a'.repeat(32);
const human = { origin: 'https://mailadmin.example.com', 'x-mailadmin-csrf': 'synthetic', cookie: 'mailadmin_sid=synthetic' };
async function fixture(t, { permission = 'full', auditFs } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'admin-otp-'));t.after(() => rm(dir, { recursive: true, force: true }));
  const rows = new Map([[email, { email, enabled: true, version, registeredAt: '2026-11-01T00:00:00.000Z' }]]);
  const options = {}, calls = [];let policy = { forceAll: false, revision: '0', updatedAt: null, updatedBy: '' }, mailboxes = [{ username: email }, { username: 'off@example.com', active: 0 }];
  const missing = addr => ({ email: addr, enabled: false, version: null, registeredAt: null });
  const store = {
    async getPolicy() { if(options.postCommitReadError&&calls.includes('policy'))throw new AppError(503,'OTP_UNAVAILABLE','합성 후속 조회 장애'); return { ...policy }; },
    async listRegistrations() { return [...rows.values()].filter(row => row.enabled); },
    async readAccountStatus(addr) { return rows.get(addr) ?? missing(addr); },
    async setPolicy({ forceAll, revision, actor }) {
      calls.push('policy'); if (revision !== policy.revision) throw new AppError(409,'CONFLICT','합성 충돌');
      if (policy.forceAll === forceAll) return { ...policy, unchanged: true };
      policy = { ...policy, forceAll, revision: String(BigInt(revision)+1n), updatedBy: actor };return policy;
    },
    async reset({ email: addr, version: expected }) {
      calls.push('reset'); const row = rows.get(addr); if ((row?.version ?? null) !== expected) throw new AppError(409,'OTP_STATE_CHANGED','합성 세대 충돌');
      if (!row) return { ...missing(addr), unchanged: true };
      const saved = { ...missing(addr), version: randomBytes(16).toString('hex') };rows.set(addr,saved);return saved;
    },
    async cleanup({ email: addr, version: expected }) { calls.push('cleanup');const row=rows.get(addr);if((row?.version??null)!==expected)throw new AppError(409,'OTP_STATE_CHANGED','합성 충돌');rows.delete(addr);return {unchanged:!row}; },
  };
  const mailcow = { createApiContext: () => ({}), async call(_session, _method, path) {
    if(path.endsWith('/status/version')) return {version:'synthetic'};
    if(options.mailboxError)throw new AppError(503,'MAILCOW_UNAVAILABLE','합성 목록 장애');
    return structuredClone(mailboxes);
  } };
  const audit=createAudit({dir,...(auditFs?{fs:auditFs}:{})}),service=createOtpAdminService({store,mailcow,audit,lock:createResourceLock()});
  const app=Fastify({logger:false});installErrors(app);await app.register(cookie);
  installAdminGuard(app,{config:{adminHostname:'mailadmin.example.com',mailcowApiKey:'synthetic'},sessions:{get:async()=>({state:'ready',csrf:'synthetic',username:'human',mailcow:{}}),destroy:async()=>{}},client:mailcow,
    apiKeys:{authenticate:async raw=>raw===token?{ok:true,item:{id:'synthetic',name:'automation',permission}}:{ok:false,reason:'UNKNOWN_KEY'},recordUse:async()=>{}}});
  await app.register(routes,{service});t.after(()=>app.close());
  const inject=(method,url,payload,headers=human)=>app.inject({method,url,payload,headers});
  return {app,service,audit,rows,options,calls,inject,setMailboxes:value=>{mailboxes=value;}};
}
const policyPath='/api/admin/otp/policy',resetPath=`/api/admin/otp/accounts/${email}/reset`;
const keyHeaders={'x-mailadmin-api-key':token};
test('L12 human and full key policy/reset succeed, audits identify the principal and reveal metadata only',async t=>{
 for(const [headers,actor] of [[human,'human'],[keyHeaders,'API 키: automation']]){
  const f=await fixture(t);
  const saved=await f.inject('PUT',policyPath,{forceAll:true,revision:'0',confirm:true},headers);assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().forceAll,true);
  const reset=await f.inject('POST',resetPath,{version,confirm:true},headers);assert.equal(reset.statusCode,200,reset.body);assert.notEqual(reset.json().version,version);
  const records=(await f.audit.read()).rows,intents=records.filter(row=>row.phase==='intent');assert.deepEqual(intents.map(row=>row.actor),[actor,actor]);assert.deepEqual(intents.map(row=>row.action),['webmail-otp.policy','webmail-otp.reset']);
  assert.equal(records.length,4);for(const field of ['secret_ciphertext','nonce','tag','manualKey','seed','qrDataUrl'])assert.equal(JSON.stringify(records).includes(field),false);
 }
});
test('L12 read key can GET but policy/reset fail before store mutation or audit',async t=>{
 const f=await fixture(t,{permission:'read'});
 for(const path of [policyPath,`/api/admin/otp/accounts/${email}`])assert.equal((await f.inject('GET',path,undefined,keyHeaders)).statusCode,200);
 for(const [method,path,payload]of[['PUT',policyPath,{forceAll:true,revision:'0',confirm:true}],['POST',resetPath,{version,confirm:true}]]){const r=await f.inject(method,path,payload,keyHeaders);assert.equal(r.statusCode,403);assert.equal(r.headers['www-authenticate'],undefined);}
 assert.deepEqual(f.calls,[]);assert.equal((await f.audit.read()).rows.length,0);
});
test('L12 Origin, CSRF and strict body validation reject before mutation',async t=>{
 const f=await fixture(t);for(const h of [{...human,origin:'https://other.example.com'},{...human,'x-mailadmin-csrf':'wrong'}])assert.equal((await f.inject('PUT',policyPath,{forceAll:true,revision:'0',confirm:true},h)).statusCode,403);
 for(const body of [{forceAll:'true',revision:'0',confirm:true},{forceAll:true,revision:'0',confirm:false},{forceAll:true,revision:'0',confirm:true,extra:1}])assert.equal((await f.inject('PUT',policyPath,body)).statusCode,422);
 assert.deepEqual(f.calls,[]);
});
test('policy counts intersect actual mailboxes including inactive, and concurrent stale revision loses',async t=>{
 const f=await fixture(t);f.rows.set('gone@example.com',{email:'gone@example.com',enabled:true,version,registeredAt:'2026-11-01'});
 const before=await f.inject('GET',policyPath);assert.deepEqual(before.json().counts,{total:2,registered:1,unregistered:1});
 assert.equal((await f.inject('PUT',policyPath,{forceAll:true,revision:'0',confirm:true})).statusCode,200);
 assert.equal((await f.inject('PUT',policyPath,{forceAll:false,revision:'0',confirm:true})).statusCode,409);
 const same=await f.inject('PUT',policyPath,{forceAll:true,revision:'1',confirm:true});assert.equal(same.json().revision,'1');assert.equal(same.json().unchanged,true);assert.equal(f.rows.get(email).enabled,true);
});
test('L13 orphan reset cleans old row; reused current mailbox resets to fresh generation and rejects old ABA token',async t=>{
 const f=await fixture(t);f.setMailboxes([]);
 assert.equal((await f.inject('POST',resetPath,{version,confirm:true})).statusCode,200);assert.equal(f.rows.has(email),false);
 assert.equal((await f.audit.read()).rows[0].action,'webmail-otp.cleanup');
 f.setMailboxes([{username:email}]);f.rows.set(email,{email,enabled:false,registeredAt:null,version:'b'.repeat(32)});
 assert.equal((await f.inject('POST',resetPath,{version,confirm:true})).statusCode,409);assert.equal(f.rows.get(email).version,'b'.repeat(32));
 assert.equal((await f.inject('POST',resetPath,{version:'b'.repeat(32),confirm:true})).statusCode,200);assert.notEqual(f.rows.get(email).version,'b'.repeat(32));
});
test('mailbox list outage is an error, never zero counts or orphan deletion',async t=>{
 const f=await fixture(t);f.options.mailboxError=true;
 assert.equal((await f.inject('GET',policyPath)).statusCode,503);assert.equal((await f.inject('POST',resetPath,{version,confirm:true})).statusCode,503);assert.equal(f.rows.get(email).enabled,true);assert.deepEqual(f.calls,[]);
});
test('audit intent failure blocks change; result failure reports applied-but-unrecorded',async t=>{
 for(const phase of ['intent','result']){
  let opens=0;const f=await fixture(t,{auditFs:{mkdir:async()=>{},open:async()=>{opens++;if(phase==='intent'||opens===2)throw new Error('synthetic');return{chmod:async()=>{},stat:async()=>({size:0}),writeFile:async()=>{},sync:async()=>{},close:async()=>{}};}}});
  const response=await f.inject('POST',resetPath,{version,confirm:true});assert.equal(response.statusCode,500);assert.equal(response.json().error.code,phase==='intent'?'AUDIT_UNAVAILABLE':'AUDIT_RESULT_UNAVAILABLE');assert.equal(f.rows.get(email).enabled,phase==='intent');
 }
});

test('L12 a management API key never substitutes for a public webmail session',async t=>{
 const {createApp}=await import('../../server/app.js');
 const dir=await mkdtemp(join(tmpdir(),'otp-public-key-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const app=await createApp({config:{publicHostnames:['newmail.example.com'],trustProxy:[],sessionIdleMin:60,sessionMaxHours:8},logger:false,staticDir:'/nonexistent-otp',auth:{tempRoot:dir}});t.after(()=>app.close());
 const response=await app.inject({url:'/api/otp',headers:keyHeaders});assert.equal(response.statusCode,403);assert.equal(response.json().error.code,'NO_SESSION');assert.equal(response.headers['www-authenticate'],undefined);
});

test('concurrent policy confirmations and reset versions each admit one write',async t=>{
 const f=await fixture(t);
 const policies=await Promise.all([true,false].map(forceAll=>f.inject('PUT',policyPath,{forceAll,revision:'0',confirm:true})));
 assert.deepEqual(policies.map(row=>row.statusCode).sort(),[200,409]);
 const resets=await Promise.all([1,2].map(()=>f.inject('POST',resetPath,{version,confirm:true})));
 assert.deepEqual(resets.map(row=>row.statusCode).sort(),[200,409]);
 const results=(await f.audit.read()).rows.filter(row=>row.phase==='result'&&row.result==='ok'&&row.detail?.after);
 assert.equal(results.length,1);assert.equal(results[0].detail.after.version,f.rows.get(email).version);
});

test('D1 committed policy stays audited ok when follow-up read fails',async t=>{
 const f=await fixture(t);f.options.postCommitReadError=true;
 const response=await f.inject('PUT',policyPath,{forceAll:true,revision:'0',confirm:true});assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().forceAll,true);assert.equal(response.json().revision,'1');assert.equal(response.json().result,'partial');assert.equal(response.json().warnings[0].code,'OTP_STATUS_UNAVAILABLE');
 const records=(await f.audit.read()).rows;assert.deepEqual(records.map(row=>row.phase),['intent','result']);assert.equal(records[1].result,'ok');assert.equal(records[0].actor,'human');assert.equal(records[0].after.forced,true);
 f.options.postCommitReadError=false;assert.equal((await f.inject('GET',policyPath)).json().forceAll,true);assert.deepEqual(f.calls,['policy']);
});
