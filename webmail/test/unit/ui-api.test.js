import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../web/src/api.js';
import { session } from '../../web/src/state/session.js';
import { toast } from '../../web/src/state/toast.js';
import { parseRoute } from '../../web/src/router.js';
import { quotaView } from '../../web/src/format.js';

function mock(t, handler) {
  const previous = globalThis.fetch;
  session.value = null; toast.value = null;
  globalThis.fetch = handler;
  t.after(() => {globalThis.fetch=previous;session.value=null;toast.value=null;});
}
const user = {user:{email:'user@example.com',name:'예시 사용자'},csrf:'synthetic-csrf',expiresAt:1};
test('API: login/session retain CSRF, credentials are same-origin, mutation sends custom header', async t => {
  const requests=[];
  mock(t, async (path,options) => {requests.push({path,...options});return path.endsWith('logout') ? new Response(null,{status:204}) : Response.json(user);});
  await api('/api/auth/login',{method:'POST',body:{email:'user@example.com',password:'synthetic-password'}});
  assert.deepEqual(session.value,user);
  assert.equal(requests[0].credentials,'same-origin');
  assert.equal(requests[0].headers.get('X-Webmail-CSRF'),null);
  await api('/api/auth/session');
  await api('/api/folders',{method:'PATCH',body:{name:'예시'}});
  assert.equal(requests[1].credentials,'same-origin');
  assert.equal(requests[1].headers.get('X-Webmail-CSRF'),null);
  assert.equal(requests[2].headers.get('X-Webmail-CSRF'),user.csrf);
  assert.deepEqual(JSON.parse(requests[2].body),{name:'예시'});
  assert.equal(await api('/api/auth/logout',{method:'POST'}),null);
  assert.equal(session.value,null);
});
test('API: error code/message remain intact and ordinary failures keep session', async t => {
  const failure={code:'AUTH_FAILED',message:'메일 주소나 암호가 맞지 않아요.'};
  mock(t,async()=>Response.json({error:failure},{status:403}));
  session.value=user;
  await assert.rejects(api('/api/folders'),error=>{assert.deepEqual(error,failure);return true;});
  assert.equal(session.value,user);
});
test('API: NO_SESSION clears session without a login notice', async t => {
  mock(t,async()=>Response.json({error:{code:'NO_SESSION',message:'로그인이 필요해요.'}},{status:403}));
  session.value=user;toast.value={kind:'session-expired',message:'old notice'};
  await assert.rejects(api('/api/folders'));
  assert.equal(session.value,null);assert.equal(toast.value,null);
});
test('API: SESSION_EXPIRED clears session and sets the approved notice; password-change notice wins', async t => {
  mock(t,async()=>Response.json({error:{code:'SESSION_EXPIRED',message:'expired'}},{status:403}));
  session.value=user;
  await assert.rejects(api('/api/folders'));
  assert.equal(session.value,null);
  assert.equal(toast.value.message,'로그인이 만료됐어요. 다시 로그인해 주세요.');
  toast.value={kind:'password-changed',message:'암호를 바꿨어요.'};
  await assert.rejects(api('/api/folders'));
  assert.equal(toast.value.kind,'password-changed');
});
test('router: all approved routes and encoded folder names resolve without losing separators', () => {
  for(const name of ['inbox','allmail','spam','search','read','compose','filters','rule','storage','password','settings','keys'])assert.equal(parseRoute(`#${name}/example`).name,name);
  assert.equal(parseRoute('#f/Shared%2Fuser%40example.com%2FINBOX').value,'Shared/user@example.com/INBOX');
  assert.equal(parseRoute('#f/%EA%B1%B0%EB%9E%98%EC%B2%98').title,'거래처');
  assert.equal(parseRoute('#unknown').name,'inbox');
});
test('quota: warning boundaries use actual ratio at 80% and 95%, including unlimited quota', () => {
  for(const [used,level] of [[79,'ok'],[80,'warn'],[94,'warn'],[95,'crit'],[105,'crit']])assert.equal(quotaView({quota:{usedBytes:used,limitBytes:100}}).level,level);
  assert.equal(quotaView({quota:{usedBytes:10,limitBytes:0}}).limit,'무제한');
  assert.equal(quotaView(null),null);
});

test('logout: failed server request still clears local session and retains the error notice', async t => {
  const { logout } = await import('../../web/src/api.js');
  mock(t,async()=>Response.json({error:{code:'MAIL_UNAVAILABLE',message:'메일 서버에 연결할 수 없어요.'}},{status:503}));
  session.value=user;
  await logout();
  assert.equal(session.value,null);
  assert.deepEqual(toast.value,{kind:'error',message:'메일 서버에 연결할 수 없어요.'});
});
