import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOtpSeed, newOtpVersion, encodeBase32, decodeBase32, hotp, matchTotp, parseOtpKey, encryptOtpSeed, decryptOtpSeed, otpEnrollmentQr } from '../../server/security/otp.js';
import { createOtpRateLimiter } from '../../server/security/ratelimit.js';

const seed = Buffer.from('12345678901234567890'); // RFC public test vector, not a credential.
const vectors = [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']];
for (const [seconds, expected] of vectors) test(`OTP RFC6238 SHA1 vector at ${seconds}`, () => {
  const step = BigInt(Math.floor(seconds / 30));
  assert.equal(hotp(seed, step, 8), expected);
  assert.equal(hotp(seed, step), expected.slice(-6));
  assert.equal(matchTotp(seed, expected.slice(-6), { now: seconds * 1000 }), step);
});
test('OTP Base32 canonical encoding and random seed/generation shapes', () => {
  assert.equal(encodeBase32(seed), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(decodeBase32(encodeBase32(seed)), seed);
  for (const value of ['a','A','AAA=','0','MZ']) assert.throws(() => decodeBase32(value), { code: 'OTP_UNAVAILABLE' });
  assert.equal(createOtpSeed().length, 20); assert.match(newOtpVersion(), /^[a-f0-9]{32}$/);
  assert.notEqual(newOtpVersion(), newOtpVersion());
});
test('OTP windows, boundary, leading zero, formatting and replay rejection', () => {
  const step = 100000n, now = Number(step) * 30000;
  for (const delta of [-1n,0n,1n]) assert.equal(matchTotp(seed, hotp(seed, step + delta), { now }), step + delta);
  for (const delta of [-2n,2n]) assert.equal(matchTotp(seed, hotp(seed, step + delta), { now }), null);
  assert.equal(matchTotp(seed, hotp(seed, step), { now, lastStep: step }), null);
  assert.equal(matchTotp(seed, '005924', { now: 1234567890000 }), 41152263n);
  for (const code of [123456,'12345','1234567',' 123456','１２３４５６']) assert.equal(matchTotp(seed, code, { now }), null);
  assert.equal(matchTotp(seed, hotp(seed, step), { now: now - 1 }), step);
  assert.equal(matchTotp(seed, hotp(seed, 0n), { now: 0 }), 0n);
});
test('OTP key shape and version fail closed without including values', () => {
  for (const args of [[undefined,1],['a'.repeat(63),1],['g'.repeat(64),1],['a'.repeat(64),undefined],['a'.repeat(64),2]]) {
    assert.throws(() => parseOtpKey(...args), error => !error.message.includes('a'.repeat(64)));
  }
  assert.equal(parseOtpKey('a'.repeat(64),'1').key.length,32);
});
test('OTP AES-GCM round trip and independent nonces', () => {
  const args = { seed, email:'user@example.test', version:newOtpVersion(), ...parseOtpKey('b'.repeat(64),1) };
  const envelope = encryptOtpSeed(args), other = encryptOtpSeed(args);
  assert.equal(envelope.secret_ciphertext.length,20); assert.equal(envelope.nonce.length,12); assert.equal(envelope.tag.length,16);
  assert.notDeepEqual(envelope.nonce,other.nonce); assert.notDeepEqual(envelope.secret_ciphertext,seed);
  assert.deepEqual(decryptOtpSeed({ ...args,envelope }),seed);
});
test('OTP AES-GCM rejects altered ciphertext, nonce, tag, email, generation and key version', () => {
  const args = { seed, email:'user@example.test', version:newOtpVersion(), ...parseOtpKey('b'.repeat(64),1) };
  const envelope = encryptOtpSeed(args);
  for (const field of ['secret_ciphertext','nonce','tag']) {
    const changed = { ...envelope, [field]:Buffer.from(envelope[field]) }; changed[field][0] ^= 1;
    assert.throws(() => decryptOtpSeed({ ...args,envelope:changed }), { statusCode:503,code:'OTP_UNAVAILABLE' });
  }
  for (const patch of [{email:'other@example.test'},{version:newOtpVersion()},{keyVersion:2},{key:Buffer.alloc(32)}]) assert.throws(() => decryptOtpSeed({ ...args,envelope,...patch }), { statusCode:503,code:'OTP_UNAVAILABLE' });
  assert.throws(() => decryptOtpSeed({ ...args,envelope:{...envelope,nonce:Buffer.alloc(11)} }),{code:'OTP_UNAVAILABLE'});
});
test('OTP QR is local SVG data and includes a manual key without external calls', async () => {
  const result = await otpEnrollmentQr({seed,email:'user@example.test',issuer:'Example Mail'});
  assert.equal(result.manualKey,encodeBase32(seed)); assert.match(result.qrDataUrl,/^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(result.qrDataUrl.split(',')[1],'base64').toString(),/^<svg/);
});
test('OTP account reservations admit at most five concurrent validations', () => {
  let time=0; const limiter=createOtpRateLimiter({now:()=>time}); let admitted=0;
  for(let i=0;i<20;i++){try{limiter.reserve('192.0.2.10','user@example.test');admitted++;}catch(error){assert.equal(error.statusCode,429);assert.equal(error.retryAfter,300);}}
  assert.equal(admitted,5); time=299999;assert.throws(()=>limiter.reserve('192.0.2.10','user@example.test'),{statusCode:429});
  time=300000;assert.doesNotThrow(()=>limiter.reserve('192.0.2.10','user@example.test'));
  time=1000000;limiter.sweep();assert.doesNotThrow(()=>limiter.reserve('192.0.2.10','user@example.test'));
});
test('OTP per-IP budget applies across accounts, including login-exception addresses', () => {
  const limiter=createOtpRateLimiter();
  for(let i=0;i<30;i++)limiter.reserve('192.0.2.10',`user${i}@example.test`);
  assert.throws(()=>limiter.reserve('192.0.2.10','other@example.test'),{statusCode:429});
  assert.doesNotThrow(()=>limiter.reserve('192.0.2.11','other@example.test'));
});
test('OTP success releases only its reservation, retaining other failures', () => {
  const limiter=createOtpRateLimiter();
  for(let i=0;i<4;i++)limiter.reserve('192.0.2.10','user@example.test');
  const release=limiter.reserve('192.0.2.10','user@example.test');release();release();
  limiter.reserve('192.0.2.10','user@example.test');assert.throws(()=>limiter.reserve('192.0.2.10','user@example.test'),{statusCode:429});
});
