import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { api, acceptAuthSession, checkServerSession, handleAuthFailure } from '../../web/src/api.js';
import { session, sessionReady, verifiedSession, authUnavailable, authGeneration, advanceAuthGeneration, sessionResourceEpoch } from '../../web/src/state/session.js';
import { loadSessionPrefs, prefs, updatePrefs } from '../../web/src/state/prefs.js';
import { signatureRequest } from '../../web/src/signatures.js';
import { getSignatureImageContent } from '../../web/src/signature-images.js';
const auth = (step = 'done', csrf = 'synthetic') => ({ step, user: { email: 'user@example.com', name: '예시' }, csrf, expiresAt: '2030-01-01T00:00:00.000Z', otp: { enabled: step === 'otp', version: '0'.repeat(32), registeredAt: null, forced: step === 'enroll', policyRevision: '0' } });
function setup(t, handler) {
  const previous = globalThis.fetch, storage = globalThis.localStorage;
  advanceAuthGeneration(); session.value = null; sessionReady.value = false; authUnavailable.value = false;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.fetch = handler;
  t.after(async () => { await immediate(); advanceAuthGeneration(); session.value = null; sessionReady.value = false; authUnavailable.value = false; globalThis.fetch = previous; globalThis.localStorage = storage; });
}

test('L15 initial pending restore and focus never load prefs; only done is accepted', async t => {
  for (const step of ['otp', 'enroll']) {
    const requests = [];
    setup(t, async path => { requests.push(path); return Response.json(auth(step)); });
    await api('/api/auth/session'); await loadSessionPrefs(); await checkServerSession();
    assert.deepEqual(requests, ['/api/auth/session', '/api/auth/session']);
    assert.equal(session.value.step, step); assert.equal(sessionReady.value, false); assert.equal(verifiedSession.value, null);
  }
});

test('L15 pending transition replaces owner/epoch/generation; a late prefs result cannot revive ready', async t => {
  let resolvePrefs;
  setup(t, path => path === '/api/prefs' ? new Promise(resolve => { resolvePrefs = resolve; }) : Promise.resolve(Response.json(auth('enroll'))));
  acceptAuthSession(auth()); const owner = session.value, generation = authGeneration, epoch = sessionResourceEpoch.value;
  const pending = loadSessionPrefs();
  handleAuthFailure({ code: 'OTP_REQUIRED', step: 'enroll', expiresAt: '2030-01-01T00:00:00.000Z' });
  assert.notEqual(session.value, owner); assert.ok(authGeneration > generation); assert.ok(sessionResourceEpoch.value > epoch);
  resolvePrefs(Response.json({ theme: 'amber', mode: 'dark' })); await pending; await immediate();
  assert.equal(sessionReady.value, false); assert.equal(session.value.step, 'enroll'); assert.equal(verifiedSession.value, null);
});

test('L15 old generation auth response cannot overwrite newer pending session', async t => {
  let resolveSession;
  setup(t, () => new Promise(resolve => { resolveSession = resolve; }));
  acceptAuthSession(auth());
  const old = api('/api/auth/session');
  const pending = auth('otp', 'replacement'); acceptAuthSession(pending);
  resolveSession(Response.json(auth('done', 'old'))); await old;
  assert.equal(session.value, pending); assert.equal(sessionReady.value, false);
});

test('L16 unavailable hides ready resources; recovered session GET must re-load prefs', async t => {
  const requests = [];
  setup(t, async path => { requests.push(path); return Response.json(path === '/api/auth/session' ? auth() : { theme: 'ink', mode: 'light', accent: {} }); });
  acceptAuthSession(auth()); sessionReady.value = true;
  handleAuthFailure({ code: 'OTP_UNAVAILABLE' });
  assert.equal(authUnavailable.value, true); assert.equal(sessionReady.value, false); assert.equal(verifiedSession.value, null);
  await checkServerSession();
  assert.deepEqual(requests, ['/api/auth/session', '/api/prefs']); assert.equal(sessionReady.value, true); assert.equal(authUnavailable.value, false);
});

test('unknown/missing auth step fails closed rather than becoming ready', async t => {
  setup(t, async () => Response.json({ user: { email: 'user@example.com' }, csrf: 'synthetic' }));
  await assert.rejects(api('/api/auth/session'), { code: 'OTP_UNAVAILABLE' });
  assert.equal(sessionReady.value, false); assert.equal(authUnavailable.value, true);
});

test('L15 OTP success and enrollment/disable accept new done identity, no implicit prefs preload', async t => {
  for (const path of ['/api/auth/otp', '/api/otp/enrollment/confirm', '/api/otp/disable']) {
    const requests = [];
    setup(t, async url => { requests.push(url); return Response.json(auth('done', 'new')); });
    acceptAuthSession(auth('otp')); const owner = session.value;
    await api(path, { method: 'POST', body: { code: '123456' } });
    assert.equal(session.value.step, 'done'); assert.notEqual(session.value, owner); assert.equal(sessionReady.value, false); assert.deepEqual(requests, [path]);
  }
});

test('L15 direct signature JSON/binary fetches route OTP failures into the common gate', async t => {
  for (const request of [() => signatureRequest('/api/signatures'), () => getSignatureImageContent('A'.repeat(32))]) {
    setup(t, async path => path === '/api/auth/session' ? Response.json(auth('enroll')) : Response.json({ error: { code: 'OTP_REQUIRED', step: 'enroll', expiresAt: '2030-01-01T00:00:00.000Z', message: '등록해 주세요.' } }, { status: 403 }));
    acceptAuthSession(auth()); sessionReady.value = true;
    await assert.rejects(request(), { code: 'OTP_REQUIRED' }); await immediate();
    assert.equal(session.value.step, 'enroll'); assert.equal(sessionReady.value, false);
  }
});

test('L15 pending preferences never start a save request', async t => {
  const requests = [];
  setup(t, async path => { requests.push(path); return Response.json({}); });
  acceptAuthSession(auth('enroll')); sessionReady.value = true;
  updatePrefs({ mode: 'dark' });
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(requests.length, 0); assert.equal(prefs.value.mode, 'dark');
});

test('expired pending and reset explain password reauthentication even during silent restore', async t => {
  const { toast } = await import('../../web/src/state/toast.js');
  setup(t, async () => Response.json({}));
  acceptAuthSession(auth('enroll'));
  handleAuthFailure({ code: 'OTP_PENDING_EXPIRED' }, { notify: false });
  assert.equal(session.value, null); assert.equal(toast.value.message, '등록 시간이 지나 다시 로그인해야 해요.');
  acceptAuthSession(auth());
  handleAuthFailure({ code: 'SESSION_EXPIRED', message: '인증 설정이 바뀌었어요. 다시 로그인해 주세요.' }, { notify: false });
  assert.equal(session.value, null); assert.equal(toast.value.message, '인증 설정이 바뀌었어요. 다시 로그인해 주세요.');
  toast.value = null;
});
