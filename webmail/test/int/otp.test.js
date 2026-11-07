// Dedicated synthetic account only. No secret, request body or response body is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const selectedAccount = !process.env.WEBMAIL_INT_GROUP || process.env.WEBMAIL_INT_GROUP.split(',').includes('account');
const enabled = process.env.WEBMAIL_INT === '1' && process.env.WEBMAIL_INT_OTP === '1' && selectedAccount;
const required = name => { assert.ok(process.env[name], `${name} 필요`); return process.env[name]; };
function counterCode(key, step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const char of key.replace(/=+$/, '').toUpperCase()) { const index = alphabet.indexOf(char); assert.ok(index >= 0, 'Base32 형식'); bits += index.toString(2).padStart(5, '0'); }
  const bytes = Buffer.from(bits.match(/.{8}/g).map(value => parseInt(value, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', bytes).update(counter).digest(); bytes.fill(0);
  const offset = digest[19] & 15; const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(value).padStart(6, '0');
}
function client(base, origin, apiKey) {
  let cookie = '', csrf = '';
  return async (method, path, body) => {
    const response = await fetch(new URL(path, base), { method, redirect: 'manual', signal: AbortSignal.timeout(60000),
      headers: { origin, ...(apiKey ? { 'x-mailadmin-api-key': apiKey } : { cookie, 'x-webmail-csrf': csrf }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.notEqual(response.status, 401, '앱 인증 challenge 금지'); assert.equal(response.headers.has('www-authenticate'), false);
    const value = response.status === 204 ? null : await response.json();
    if (response.ok && value?.csrf) { cookie = (response.headers.get('set-cookie') || cookie).split(';')[0]; csrf = value.csrf; }
    return { status: response.status, value };
  };
}
test('[account] OTP 격리 VM: 두 등록 경쟁, 재사용 거부, 기본 암호 유지, 동일 step 경쟁 및 관리자 정리', {
  skip: !enabled ? '미실행 — WEBMAIL_INT=1 및 WEBMAIL_INT_OTP=1, account 그룹 필요' : false, timeout: 180000,
}, async () => {
  const base = required('WEBMAIL_INT_URL'), origin = required('WEBMAIL_INT_ORIGIN');
  const address = required('WEBMAIL_INT_OTP_EMAIL'), password = required('WEBMAIL_INT_PASSWORD');
  const admin = client(required('WEBMAIL_INT_OTP_ADMIN_URL'), required('WEBMAIL_INT_OTP_ADMIN_ORIGIN'), required('WEBMAIL_INT_OTP_ADMIN_KEY'));
  const path = `/api/admin/otp/accounts/${encodeURIComponent(address)}`;
  const before = await admin('GET', path), policy = await admin('GET', '/api/admin/otp/policy');
  assert.equal(before.status, 200); assert.equal(before.value.enabled, false, '전용 계정은 미등록이어야 함');
  assert.equal(policy.status, 200); assert.equal(policy.value.forceAll, false, '기존 필수 정책이 있으면 중단');
  let changed = false;
  try {
    const first = client(base, origin), second = client(base, origin), login = request => request('POST', '/api/auth/login', { email: address, password });
    for (const request of [first, second]) { const result = await login(request); assert.equal(result.status, 200); assert.equal(result.value.step, 'done'); }
    const drafts = await Promise.all([first, second].map(request => request('POST', '/api/otp/enrollment', {})));
    assert.ok(drafts.every(result => result.status === 200), '두 등록 초안 발급');
    const step = Math.floor(Date.now() / 30000); changed = true;
    const results = await Promise.all([first, second].map((request, i) => request('POST', '/api/otp/enrollment/confirm', { draftId: drafts[i].value.draftId, code: counterCode(drafts[i].value.manualKey, step) })));
    assert.equal(results.filter(result => result.status === 200).length, 1, '등록 성공1');
    assert.ok(results.filter(result => result.status !== 200).every(result => [403,409].includes(result.status)), '후발 덮어쓰기 거부');
    const winner = results.findIndex(result => result.status === 200), seed = drafts[winner].value.manualKey;
    const pending = client(base, origin), logged = await login(pending); assert.equal(logged.status, 200); assert.equal(logged.value.step, 'otp');
    assert.equal((await pending('POST', '/api/auth/otp', { code: counterCode(seed, step) })).status, 403, '등록 확인 코드 재사용 거부');
    // Next time step avoids falsely treating a consumed confirmation code as a new code.
    await new Promise(resolve => setTimeout(resolve, (step + 1) * 30000 - Date.now() + 100));
    const verify = await Promise.all(Array.from({ length: 20 }, () => pending('POST', '/api/auth/otp', { code: counterCode(seed, step + 1) })));
    assert.equal(verify.filter(result => result.status === 200).length, 1, '동일 step 성공1');
    assert.ok(verify.every(result => [200,403,429].includes(result.status)), '나머지 검증 거부');
    const state = await admin('GET', path); assert.equal(state.value.enabled, true, '등록 상태 유지');
    assert.equal((await admin('POST', path + '/reset', { version: state.value.version, confirm: true })).status, 200);
    changed = false;
  } catch (error) {
    // Assertion diagnostics must never include secret-bearing response objects.
    throw new Error(error?.code === 'ERR_ASSERTION' ? `OTP 통합 단언 실패: ${error.message.split('\n')[0]}` : 'OTP 통합 연결/프로토콜 실패 (원문 생략)');
  } finally {
    if (changed) { const current = await admin('GET', path); assert.equal(current.status, 200, '정리 상태 조회'); assert.equal((await admin('POST', path + '/reset', { version: current.value.version, confirm: true })).status, 200, 'OTP 등록 원복'); }
  }
});
