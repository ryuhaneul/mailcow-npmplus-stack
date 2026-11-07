import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOtpStore} from '../../server/security/otp-store.js';
import {hotp,parseOtpKey} from '../../server/security/otp.js';

// Transactional SQL fixture: validates query predicates and serializes transactions.
// Actual MariaDB lock/grant semantics are Gate D-live, not claimed by this fixture.
function fixture() {
  const state={rows:new Map(),rule:{id:1,force_all:0,revision:'0',updated_at:'2026-11-07 00:00:00',updated_by:'migration'},log:[],released:0,rolledBack:0,fail:null,tail:Promise.resolve()};
  const copy = value => value ? {...value,...Object.fromEntries(Object.entries(value).filter(([,v])=>Buffer.isBuffer(v)).map(([k,v])=>[k,Buffer.from(v)]))}:value;
  async function execute({sql,timeout},args=[]) {
    assert.equal(timeout,5000);state.log.push({sql,args});if(state.fail&&sql.includes(state.fail))throw Error('synthetic confidential database failure');
    let row;
    if(sql.startsWith('INSERT IGNORE')) {if(!state.rows.has(args[0]))state.rows.set(args[0],{email:args[0],version:Buffer.from(args[1]),registered_at:null,last_step:'-1',secret_ciphertext:null,nonce:null,tag:null,key_version:null});return[{affectedRows:1}];}
    if(sql.startsWith('SELECT')&&sql.includes('otp_policy')&&!sql.includes(' JOIN '))return[[copy(state.rule)]];
    if(sql.startsWith('SELECT')&&sql.includes(' JOIN ')){row=state.rows.get(args[0]);return[[...(row?[{...copy(row),force_all:state.rule.force_all,revision:state.rule.revision}]:[])]];}
    if(sql.startsWith('SELECT')){if(sql.includes('WHERE email=?'))return[[...(state.rows.has(args[0])?[copy(state.rows.get(args[0]))]:[])]];return[[...state.rows.values()].filter(r=>r.registered_at!==null).map(copy)];}
    if(sql.startsWith('UPDATE')&&sql.includes('otp_policy')){if(state.rule.revision!==args[2])return[{affectedRows:0}];state.rule={...state.rule,force_all:args[0],updated_by:args[1],revision:String(BigInt(state.rule.revision)+1n)};return[{affectedRows:1}];}
    if(sql.startsWith('UPDATE')&&sql.includes('registered_at=UTC_TIMESTAMP')){
      row=state.rows.get(args[6]);if(!row||!row.version.equals(args[7])||row.registered_at!==null)return[{affectedRows:0}];
      Object.assign(row,{secret_ciphertext:args[0],nonce:args[1],tag:args[2],key_version:args[3],last_step:args[4],version:args[5],registered_at:'2026-11-07 00:01:00.000000'});return[{affectedRows:1}];
    }
    if(sql.startsWith('UPDATE')){
      row=state.rows.get(args[1]);if(!row||!row.version.equals(args[2])||(sql.includes('last_step<?')&&BigInt(row.last_step)>=BigInt(args[3])))return[{affectedRows:0}];
      if(sql.includes('secret_ciphertext=NULL'))Object.assign(row,{secret_ciphertext:null,nonce:null,tag:null,key_version:null,registered_at:null,last_step:'-1',version:args[0]});else row.last_step=args[0];return[{affectedRows:1}];
    }
    if(sql.startsWith('DELETE')){row=state.rows.get(args[0]);if(!row||!row.version.equals(args[1]))return[{affectedRows:0}];state.rows.delete(args[0]);return[{affectedRows:1}];}
    assert.fail('Unexpected SQL');
  }
  const db={execute,async getConnection(){let unlock;const prior=state.tail;state.tail=new Promise(r=>unlock=r);await prior;const backup={rows:new Map([...state.rows].map(([k,v])=>[k,copy(v)])),rule:copy(state.rule)};return{execute,async query({sql,timeout}){assert.equal(timeout,5000);state.log.push({sql,args:[]});if(state.fail&&sql.includes(state.fail))throw Error('synthetic private failure');if(sql==='ROLLBACK'){state.rows=backup.rows;state.rule=backup.rule;state.rolledBack++;}},release(){state.released++;unlock();},destroy(){}};},async end(){state.closed=true;}};
  let now=3000000;
  return {state,web:createOtpStore({db,now:()=>now}),admin:createOtpStore({db,mode:'admin'}),advance:ms=>{now+=ms;},now:()=>now};
}
const seed=Buffer.from('12345678901234567890');const key=parseOtpKey('b'.repeat(64),1);
async function account(f,email='user@example.test') {const session={email};const row=await f.web.ensureAccount(session);session.otpVersion=row.version;return session;}
async function enrollment(f,session) {const access=await f.web.readAccess(session);const draft={seed,baseVersion:access.version,policyRevision:access.policyRevision,expiresAt:f.now()+300000};return{draft,code:hotp(seed,BigInt(Math.floor(f.now()/30000))),...key};}

test('OTP store guard reads account PK and joined policy in one query',async()=>{
 const f=fixture(),s=await account(f);f.state.log=[];const row=await f.web.readAccess(s);assert.equal(row.enabled,false);assert.match(row.version,/^[a-f0-9]{32}$/);assert.equal(f.state.log.length,1);assert.match(f.state.log[0].sql,/JOIN .*otp_policy/);assert.match(f.state.log[0].sql,/WHERE a.email=\?/);assert.deepEqual(f.state.log[0].args,[s.email]);
});
test('OTP store requires owned session context and enforces store roles',async()=>{
 const f=fixture();await assert.rejects(f.web.readAccess('other@example.test'),{statusCode:403});await assert.rejects(f.web.readAccess({email:' USER@example.test '}),{statusCode:403});await assert.rejects(f.web.reset({email:'user@example.test',version:null}),{statusCode:403});await assert.rejects(f.admin.readAccess({email:'user@example.test'}),{statusCode:403});assert.equal(f.state.log.length,0);
});
test('OTP concurrent registration first wins; later draft cannot overwrite',async()=>{
 const f=fixture(),a=await account(f),b=await account(f),args=await enrollment(f,a);const before=a.otpVersion;
 const results=await Promise.allSettled([f.web.confirmEnrollment(a,args),f.web.confirmEnrollment(b,args)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'OTP_STATE_CHANGED');
 const saved=await f.web.readAccess(a);assert.notEqual(saved.version,before);assert.equal(saved.lastStep,'100');assert.equal(saved.enabled,true);assert.equal(f.state.released,2);assert.equal(f.state.rolledBack,1);
});
test('OTP enrollment consumes its confirmation step, then concurrent verification consumes once',async()=>{
 const f=fixture(),s=await account(f),registered=await f.web.confirmEnrollment(s,await enrollment(f,s));s.otpVersion=registered.version;
 await assert.rejects(f.web.verify(s,{code:hotp(seed,100n),...key}),{code:'OTP_INVALID'});f.advance(30000);
 const results=await Promise.allSettled(Array.from({length:20},()=>f.web.verify(s,{code:hotp(seed,101n),...key})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.web.readAccess(s)).lastStep,'101');
});
test('OTP forced disable refuses before consuming; normal disable clears atomically',async()=>{
 const f=fixture(),s=await account(f),r=await f.web.confirmEnrollment(s,await enrollment(f,s));s.otpVersion=r.version;f.advance(30000);
 await f.admin.setPolicy({forceAll:true,revision:'0',actor:'Synthetic admin'});
 await assert.rejects(f.web.disable(s,{code:hotp(seed,101n),...key}),{code:'OTP_FORCED'});assert.equal((await f.web.readAccess(s)).lastStep,'100');
 await f.admin.setPolicy({forceAll:false,revision:'1',actor:'Synthetic admin'});const off=await f.web.disable(s,{code:hotp(seed,101n),...key});assert.equal(off.enabled,false);assert.notEqual(off.version,r.version);assert.equal((await f.web.readAccess(s)).envelope,null);
});
test('OTP stale policy, expired draft and invalid code do not persist any seed',async()=>{
 for(const type of ['policy','expired','invalid']){const f=fixture(),s=await account(f),args=await enrollment(f,s);if(type==='policy')await f.admin.setPolicy({forceAll:true,revision:'0',actor:'Synthetic admin'});if(type==='expired')f.advance(300000);if(type==='invalid')args.code='bad';await assert.rejects(f.web.confirmEnrollment(s,args));assert.equal((await f.web.readAccess(s)).envelope,null);assert.equal(f.state.rolledBack,1);}
});
test('OTP reset replaces generation even when unregistered; delete/recreate prevents ABA',async()=>{
 const f=fixture(),s=await account(f),old=s.otpVersion;const reset=await f.admin.reset({email:s.email,version:old});assert.notEqual(reset.version,old);await assert.rejects(f.web.confirmEnrollment(s,{...(await enrollment(f,s))}),{code:'OTP_STATE_CHANGED'});
 await f.admin.cleanup({email:s.email,version:reset.version});assert.equal(await f.web.readAccess(s),null);const next=await account(f);assert.notEqual(next.otpVersion,old);assert.notEqual(next.otpVersion,reset.version);await assert.rejects(f.web.verify(s,{code:'123456',...key}),{code:'OTP_STATE_CHANGED'});
});
test('OTP policy CAS preserves enabled users and stale policy updates conflict',async()=>{
 const f=fixture(),s=await account(f);await f.web.confirmEnrollment(s,await enrollment(f,s));await f.admin.setPolicy({forceAll:true,revision:'0',actor:'API 키: Synthetic'});await f.admin.setPolicy({forceAll:false,revision:'1',actor:'Synthetic admin'});assert.equal((await f.web.readAccess(s)).enabled,true);
 await assert.rejects(f.admin.setPolicy({forceAll:true,revision:'0',actor:'Synthetic'}),{statusCode:409});const p=await f.admin.setPolicy({forceAll:false,revision:'2',actor:'Synthetic'});assert.equal(p.unchanged,true);assert.equal(p.revision,'2');
});
test('OTP SQL errors roll back, release and never expose the original message',async()=>{
 const f=fixture(),s=await account(f);f.state.fail='UPDATE';await assert.rejects(f.web.confirmEnrollment(s,await enrollment(f,s)),e=>e.code==='OTP_UNAVAILABLE'&&!e.message.includes('confidential'));assert.equal(f.state.released,1);assert.equal(f.state.rolledBack,1);assert.equal((await f.web.readAccess(s)).enabled,false);
 f.state.fail='COMMIT';await assert.rejects(f.admin.reset({email:s.email,version:s.otpVersion}),{code:'OTP_UNAVAILABLE'});assert.equal(f.state.released,2);assert.equal((await f.web.readAccess(s)).version,s.otpVersion);
});
test('OTP admin status/reset missing row and metadata-only reads never select ciphertext',async()=>{
 const f=fixture();assert.equal((await f.admin.readAccountStatus('missing@example.test')).version,null);assert.equal((await f.admin.reset({email:'missing@example.test',version:null})).unchanged,true);assert.deepEqual(await f.admin.listRegistrations(),[]);assert.ok(f.state.log.filter(x=>x.sql.startsWith('SELECT')&&x.sql.includes('otp_accounts')).every(x=>!x.sql.includes('secret_ciphertext')));await f.admin.close();assert.equal(f.state.closed,true);
});
