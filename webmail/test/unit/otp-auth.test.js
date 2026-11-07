import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { createApp } from '../../server/app.js';
import { createEventService } from '../../server/mail/events.js';
import { AppError } from '../../server/errors.js';
import { hotp } from '../../server/security/otp.js';
import { loadConfig } from '../../server/config.js';
import { otpConfig, otpEnv, createOtpFixture } from './helpers/otp-fixture.js';

const origin = 'https://newmail.example.com', email = 'user@example.com', seed = Buffer.alloc(20, 3);
async function fixture(t) {
  let time = 1_800_000_000_000, calls = 0, closed = 0;
  const otp = createOtpFixture({ now: () => time });
  const tempRoot = await mkdtemp(join(tmpdir(), 'otp-auth-'));
  const config = { ...otpConfig, publicHostnames: ['newmail.example.com'], brandName: '예시 메일', trustProxy: [], sessionIdleMin: 480, sessionMaxHours: 24, internalDomains: [] };
  const app = await createApp({ config, otp: { store: otp.store }, logger: false, staticDir: '/nonexistent-otp', auth: { tempRoot, now: () => time,
    loginIps: { async list() { return { items: [{ ip: '198.51.100.1' }] }; } },
    verifyLogin: async () => ({ connection: { async logout() { closed++; } } }) } });
  app.directory.mailboxName = async value => value;
  app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], url: '/api/otp-test-mail', handler: async () => { calls++; return { ok: true }; } });
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  return { app, otp, tempRoot, get calls() { return calls; }, get closed() { return closed; }, get time() { return time; }, advance: ms => { time += ms; },
    code: () => hotp(seed, BigInt(Math.floor(time / 30000))),
    login: (address = email) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '198.51.100.1', headers: { origin }, payload: { email: address, password: 'synthetic-password' } }) };
}
const headers = result => ({ origin, cookie: result.headers['set-cookie'].split(';')[0], 'x-webmail-csrf': result.json().csrf });
const token = result => headers(result).cookie.split('=')[1];
const fail = (response, status, code) => { assert.equal(response.statusCode, status, response.body); assert.equal(response.json().error.code, code); assert.equal(response.headers['www-authenticate'], undefined); };
const post = (f, url, h, payload) => f.app.inject({ method: 'POST', url, headers: h, payload });

test('L07 both pending states block every mail method, Origin/CSRF and wrong OTP flow; no service call', async t => {
  for (const step of ['otp', 'enroll']) {
    const f = await fixture(t);
    if (step === 'otp') f.otp.register(email, seed); else f.otp.force(true);
    const logged = await f.login(), h = headers(logged);
    assert.equal(logged.json().step, step);
    assert.equal(logged.json().otp.enabled, step === 'otp');
    assert.equal(logged.body.includes('envelope'), false);
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await f.app.inject({ method, url: '/api/otp-test-mail?ignored=1', headers: h });
      fail(response, 403, 'OTP_REQUIRED'); assert.equal(response.json().error.step, step);
      assert.equal(response.json().error.expiresAt, logged.json().expiresAt);
    }
    assert.equal(f.calls, 0);
    const url = step === 'otp' ? '/api/auth/otp' : '/api/otp/enrollment';
    fail(await post(f, url, { ...h, origin: 'https://evil.example.com' }, {}), 403, 'BAD_ORIGIN');
    fail(await post(f, url, { ...h, 'x-webmail-csrf': 'wrong' }, {}), 403, 'CSRF');
    fail(await post(f, step === 'otp' ? '/api/otp/enrollment' : '/api/auth/otp', h, {}), 403, 'OTP_REQUIRED');
    assert.equal((await post(f, '/api/auth/logout', h, {})).statusCode, 204);
  }
});

test('L10 pending TTL 299999 accepted, 300000 rejected without renewal and cookie cleared', async t => {
  for (const registered of [true, false]) {
    const f = await fixture(t); if (registered) f.otp.register(email, seed); else f.otp.force(true);
    const logged = await f.login(), h = headers(logged);
    f.advance(299999);
    const current = await f.app.inject({ url: '/api/auth/session', headers: h });
    assert.equal(current.statusCode, 200); assert.equal(current.json().expiresAt, logged.json().expiresAt);
    f.advance(1);
    const expired = await f.app.inject({ url: '/api/auth/session', headers: h });
    fail(expired, 403, 'OTP_PENDING_EXPIRED'); assert.match(expired.headers['set-cookie'], /Max-Age=0/);
  }
});

test('L08 enrollment first session wins, rotates cookie/CSRF while retaining id/password/attachments, other sessions revoked', async t => {
  const f = await fixture(t), a = await f.login(), b = await f.login();
  const ah = headers(a), bh = headers(b), session = await f.app.sessions.get(token(a));
  const identity = session.id, password = session.password;
  await mkdir(join(f.tempRoot, identity), { recursive: true }); await writeFile(join(f.tempRoot, identity, 'example.txt'), 'synthetic');
  const first = await post(f, '/api/otp/enrollment', ah, {}), second = await post(f, '/api/otp/enrollment', bh, {});
  assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200);
  const repeated = await post(f, '/api/otp/enrollment', ah, {}); assert.deepEqual(repeated.json(), first.json());
  const draft = session.enrollmentDraft, draftSeed = draft.seed;
  const code = hotp(draft.seed, BigInt(Math.floor(f.time / 30000)));
  const success = await post(f, '/api/otp/enrollment/confirm', ah, { draftId: first.json().draftId, code });
  assert.equal(success.statusCode, 200, success.body); assert.equal(success.json().step, 'done');
  assert.notEqual(token(success), token(a)); assert.notEqual(success.json().csrf, a.json().csrf);
  assert.equal(session.id, identity); assert.equal(session.password, password); assert.ok(password.some(byte => byte !== 0));
  assert.ok(draftSeed.every(byte => byte === 0)); await access(join(f.tempRoot, identity, 'example.txt'));
  fail(await post(f, '/api/otp/enrollment/confirm', bh, { draftId: second.json().draftId, code }), 403, 'SESSION_EXPIRED');
  fail(await f.app.inject({ url: '/api/auth/session', headers: ah }), 403, 'SESSION_EXPIRED');
  // Enrollment confirmation consumes the current step; the same code cannot log in.
  const next = await f.login(); fail(await post(f, '/api/auth/otp', headers(next), { code }), 403, 'OTP_INVALID');
});

test('L10 force change matrix: ready unregistered transitions; registered ready/otp survives revision; enroll/draft expires', async t => {
  const f = await fixture(t), plain = await f.login();
  f.otp.force(true);
  fail(await f.app.inject({ url: '/api/otp-test-mail', headers: headers(plain) }), 403, 'OTP_REQUIRED');
  assert.equal((await f.app.inject({ url: '/api/auth/session', headers: headers(plain) })).json().step, 'enroll');
  f.otp.force(false);
  fail(await f.app.inject({ url: '/api/auth/session', headers: headers(plain) }), 403, 'SESSION_EXPIRED');
  const draftOwner = await f.login(); await post(f, '/api/otp/enrollment', headers(draftOwner), {});
  f.otp.force(true);
  fail(await f.app.inject({ url: '/api/auth/session', headers: headers(draftOwner) }), 403, 'SESSION_EXPIRED');
  f.otp.register(email, seed);
  const logged = await f.login(), pending = await f.login();
  const success = await post(f, '/api/auth/otp', headers(logged), { code: f.code() }); assert.equal(success.json().step, 'done');
  f.otp.force(false);
  assert.equal((await f.app.inject({ url: '/api/auth/session', headers: headers(pending) })).json().step, 'otp');
  assert.equal((await f.app.inject({ url: '/api/otp-test-mail', headers: headers(success) })).statusCode, 200);
  // Admin reset is observed at the next guard, for both states.
  f.otp.reset(email);
  for (const response of [pending, success]) fail(await f.app.inject({ url: '/api/auth/session', headers: headers(response) }), 403, 'SESSION_EXPIRED');
});

test('L10 ready draft expiry wipes seed, ready session remains valid and can start a fresh draft', async t => {
  const f = await fixture(t), logged = await f.login(), h = headers(logged), session = await f.app.sessions.get(token(logged));
  const begun = await post(f, '/api/otp/enrollment', h, {}), draft = session.enrollmentDraft;
  f.advance(299999); assert.equal((await post(f, '/api/otp/enrollment', h, {})).json().draftId, begun.json().draftId);
  f.advance(1);
  fail(await post(f, '/api/otp/enrollment/confirm', h, { draftId: draft.id, code: '123456' }), 403, 'OTP_SETUP_EXPIRED');
  assert.ok(draft.seed.every(byte => byte === 0));
  assert.equal((await f.app.inject({ url: '/api/auth/session', headers: h })).json().step, 'done');
  assert.notEqual((await post(f, '/api/otp/enrollment', h, {})).json().draftId, draft.id);
});

test('L11 guard status performs exactly one lookup and rejects target injection', async t => {
  const f = await fixture(t), logged = await f.login(), h = headers(logged);
  const before = f.otp.reads;
  assert.equal((await f.app.inject({ url: '/api/otp', headers: h })).statusCode, 200);
  assert.equal(f.otp.reads - before, 1);
  fail(await f.app.inject({ url: '/api/otp?email=other@example.com', headers: h }), 422, 'INVALID_INPUT');
  for (const url of ['/api/otp/enrollment', '/api/otp/enrollment/confirm', '/api/otp/disable']) {
    fail(await post(f, url, h, { email: 'other@example.com', code: '123456', draftId: '0'.repeat(32) }), 422, 'INVALID_INPUT');
  }
  assert.equal(f.otp.rows.has('other@example.com'), false);
});

test('L06 route malformed attempts count, IP exceptions do not exempt OTP, retryAfter JSON/header', async t => {
  const f = await fixture(t); f.otp.register(email, seed);
  const h = headers(await f.login());
  for (let i = 0; i < 5; i++) fail(await post(f, '/api/auth/otp', h, { code: 'x' }), 422, 'INVALID_INPUT');
  const blocked = await post(f, '/api/auth/otp', h, { code: f.code() });
  fail(blocked, 429, 'OTP_RATE_LIMITED'); assert.equal(blocked.json().error.retryAfter, 300); assert.equal(blocked.headers['retry-after'], '300');
  f.advance(300000);
  // Pending lifetime is independent of rate-limit release.
  fail(await post(f, '/api/auth/otp', h, { code: f.code() }), 403, 'OTP_PENDING_EXPIRED');
});

test('L16 fail closed for DB/envelope, login failure cleans ownership, no seed in session response', async t => {
  const f = await fixture(t), logged = await f.login();
  f.otp.unavailable = true;
  fail(await f.app.inject({ url: '/api/otp-test-mail', headers: headers(logged) }), 503, 'OTP_UNAVAILABLE');
  fail(await f.login('other@example.com'), 503, 'OTP_UNAVAILABLE'); assert.equal(f.closed, 1);
  f.otp.unavailable = false;
  f.otp.register(email, seed);
  const registered = await f.login(), row = f.otp.rows.get(email);
  row.envelope.tag[0] ^= 1;
  const broken = await f.app.inject({ url: '/api/auth/session', headers: headers(registered) });
  fail(broken, 503, 'OTP_UNAVAILABLE'); assert.equal(f.calls, 0);
  for (const word of ['manualKey','qrDataUrl','secret_ciphertext','envelope','nonce','tag','seed']) assert.equal(broken.body.includes(word), false);
});

test('L05 manual boot rejects missing, malformed or unsupported OTP key/version', () => {
  // Mandatory key validation runs before other required configuration values.
  for (const env of [{}, { OTP_KEY: otpEnv.OTP_KEY }, { ...otpEnv, OTP_KEY: 'bad' }, { ...otpEnv, OTP_KEY_VERSION: '2' }]) assert.throws(() => loadConfig(env));
});

test('SSE 5s independent check emits enroll/expired/unavailable, pauses data during DB wait and clears watch', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const state of ['enroll', 'expired', 'unavailable']) {
    let action = 'ready', resolveAccess, stopped = 0, checks = 0;
    const session = { state: 'ready', connection: {}, lastSeen: 1 };
    const sessions = { expiresAt: () => new Date(Date.now()+600000).toISOString(), destroy: async () => {}, checkAccess: async () => {
      checks++;
      if (action === 'wait') return new Promise(resolve => { resolveAccess = resolve; });
      if (action === 'expired' || action === 'unavailable') throw new AppError(action === 'unavailable' ? 503 : 403, 'EXAMPLE', '예시');
      session.state = action;
    } };
    const service = createEventService({ sessions, imap: { watch: () => () => { stopped++; }, withMailbox: async (_s,_p,fn) => fn({ noop: async()=>{},status:async()=>({unseen:1,messages:2}),getQuota:async()=>null }) } });
    const stream = service.open(session); let data = ''; stream.on('data', chunk => { data += chunk; });
    await immediate(); data = '';
    action = 'wait'; t.mock.timers.tick(5000); await immediate(); assert.equal(data, ''); assert.ok(resolveAccess);
    action = state;
    // Finish the suspended check, then the next independent 5s inspection sees the change.
    resolveAccess(); await immediate(); t.mock.timers.tick(5000); await immediate();
    assert.match(data, new RegExp(`"state":"${state}"`)); assert.equal(stopped, 1); assert.ok(checks >= 3);
    const total = checks; t.mock.timers.tick(30000); await immediate(); assert.equal(checks, total); stream.destroy();
  }
});

test('rotation never resurrects a destroyed session after enrollment commit', async t => {
  const f = await fixture(t), logged = await f.login(), h = headers(logged), session = await f.app.sessions.get(token(logged));
  const begun = await post(f, '/api/otp/enrollment', h, {}), draft = session.enrollmentDraft;
  const confirm = f.otp.store.confirmEnrollment;
  f.otp.store.confirmEnrollment = async (...args) => { const saved = await confirm(...args); await f.app.sessions.destroy(session); return saved; };
  const code = hotp(draft.seed, BigInt(Math.floor(f.time/30000)));
  fail(await post(f, '/api/otp/enrollment/confirm', h, { draftId: begun.json().draftId, code }), 403, 'SESSION_EXPIRED');
  assert.equal(f.otp.rows.get(email).enabled, true);
});

test('rotate rechecks Map identity after assertAlive yields, and leaves a destroyed session dead', async t => {
  const f = await fixture(t), logged = await f.login(), session = await f.app.sessions.get(token(logged));
  const rotating = f.app.sessions.rotate(session);
  // destroy removes the Map entry synchronously before its cleanup awaits.
  const destroying = f.app.sessions.destroy(session);
  await assert.rejects(rotating, { code: 'SESSION_EXPIRED' }); await destroying;
  await assert.rejects(f.app.sessions.get(token(logged)), { code: 'SESSION_EXPIRED' });
});
