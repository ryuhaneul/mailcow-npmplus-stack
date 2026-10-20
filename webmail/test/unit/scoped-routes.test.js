import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { encodeRef } from '../../server/mail/ref.js';

const origin = 'https://newmail.example.com';
const scope = { view: 'inbox', folder: '', quick: 'unread', q: '', in: '' };
const prepareBody = { selectionKey: 'synthetic-selection-001', scope, action: 'seen', cursor: null };
const prepareUrl = '/api/messages/selections', executeUrl = '/api/messages/actions/scope';

class RouteImap extends EventEmitter {
  constructor(options, state) {
    super(); this.options = options; this.state = state;
    this.enabled = new Set(); this.capabilities = new Map([['MOVE', true]]);
  }
  async connect() { this.usable = true; }
  close() { this.usable = false; }
  async logout() { this.close(); }
  async getMailboxLock(path) {
    this.mailbox = { path, uidValidity: BigInt(this.state.validity), uidNext: this.state.count + 1 };
    return { release() {} };
  }
  async list() { return ['INBOX', 'Projects', 'Trash', 'Junk'].map(path => ({ path, flags: new Set() })); }
  async exec(command, attributes, { untagged } = {}) {
    const state = this.state;
    if (command === 'MYRIGHTS') untagged.MYRIGHTS({ attributes: [attributes[0], { value: 'lrswite' }] });
    if (command === 'UID SORT') {
      state.searches++;
      const unseen = JSON.stringify(attributes).includes('UNSEEN');
      const uids = Array.from({ length: state.count }, (_, i) => i + 1).filter(uid => !unseen || !state.seen.has(uid));
      untagged.SORT({ attributes: uids.map(uid => ({ value: String(uid) })) });
    }
    if (command === 'UID STORE' || command === 'UID MOVE') {
      state.mutations.push({ command, attributes });
      if (state.unknown) throw new Error('synthetic lost acknowledgement');
      for (const uid of attributes[0].value.split(',').map(Number)) state.seen.add(uid);
      if (state.replaceAfterMutation) state.validity++;
    }
    return { response: { command: 'OK' }, next() {} };
  }
  async *fetch(range, query, options) {
    this.state.fetches.push({ range, query, options });
    if (this.state.fetchFailure) { this.state.fetchFailure = false; throw new Error('synthetic fetch transport failure'); }
    for (const uid of range.split(',').map(Number)) yield {
      uid, envelope: { subject: `synthetic mail ${uid}` }, internalDate: new Date(0),
      flags: new Set(this.state.seen.has(uid) ? ['\\Seen'] : []), size: 10, headers: Buffer.from(''),
    };
  }
  async messageFlagsAdd(range, flags, options) {
    this.state.legacy.push({ range, flags, options }); return true;
  }
}

async function fixture(t, count = 3) {
  const state = { count, validity: 123, seen: new Set(), mutations: [], legacy: [], searches: 0, fetches: [] };
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-scoped-routes-'));
  const config = { publicHostnames: ['newmail.example.com'], trustProxy: ['127.0.0.0/8'], logLevel: 'silent', sessionIdleMin: 480, sessionMaxHours: 24, imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com' };
  const app = await createApp({ config, logger: false, auth: { tempRoot, clientFactory: options => new RouteImap(options, state) } });
  app.directory.mailboxName = async email => email;
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  async function login(email = 'user@example.com') {
    const result = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { email, password: 'synthetic-route-password' } });
    assert.equal(result.statusCode, 200);
    return { origin, cookie: result.headers['set-cookie'].split(';')[0], 'x-webmail-csrf': result.json().csrf };
  }
  const headers = await login();
  const post = (url, payload, requestHeaders = headers) => app.inject({ method: 'POST', url, headers: requestHeaders, payload });
  const get = (url, requestHeaders = headers) => app.inject({ url, headers: requestHeaders });
  async function prepare(body = prepareBody) {
    const response = await post(prepareUrl, body);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().phase, 'ready');
    return response.json();
  }
  return { app, state, headers, login, post, get, prepare };
}
function assertError(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code);
  assert.equal(typeof response.json().error.message, 'string');
  assert.equal(response.headers['www-authenticate'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
}
const execution = ready => ({ scope, cursor: ready.cursor, action: 'seen' });
const failuresUrl = ready => `/api/messages/selections/${ready.selectionId}/failed`;

test('scoped HTTP: health, ready, execution, replay, empty failures and list cache invalidation', async t => {
  const f = await fixture(t);
  assert.equal((await f.get('/healthz')).statusCode, 200);
  assert.equal((await f.get('/api/messages?quick=unread')).json().total, 3);
  const ready = await f.prepare();
  assert.equal(ready.initialTotal, 3); assert.equal(ready.cutoff.kind, 'uid-fences');
  assert.equal(f.state.mutations.length, 0);
  const response = await f.post(executeUrl, execution(ready));
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  const receipt = response.json();
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.nextCursor, null);
  assert.deepEqual(receipt.totals, { processed: 3, skipped: 0, failed: 0 });
  assert.equal(receipt.batchId, `${ready.selectionId}:0`);
  assert.deepEqual((await f.post(executeUrl, execution(ready))).json(), receipt);
  assert.equal(f.state.mutations.length, 1);
  const listed = await f.get('/api/messages?quick=unread');
  assert.equal(listed.json().total, 0); assert.equal(listed.json().items.length, 0);
  const failures = await f.get(failuresUrl(ready));
  assert.equal(failures.statusCode, 200);
  assert.deepEqual(failures.json(), { total: 0, page: 1, pageSize: 50, items: [] });
});

test('scoped HTTP: same preparation key replays ready without a new search', async t => {
  const f = await fixture(t), ready = await f.prepare(), searches = f.state.searches;
  assert.deepEqual(await f.prepare(), ready); assert.equal(f.state.searches, searches);
});

test('scoped HTTP: move target is bound at preparation and mismatched execution changes nothing', async t => {
  const f = await fixture(t);
  const ready = await f.prepare({ ...prepareBody, action: 'move', target: 'Projects' });
  assertError(await f.post(executeUrl, { ...execution(ready), action: 'move', target: 'Trash' }), 409, 'SCOPE_CURSOR_MISMATCH');
  assert.equal(f.state.mutations.length, 0);
  const response = await f.post(executeUrl, { ...execution(ready), action: 'move', target: 'Projects' });
  assert.equal(response.statusCode, 200); assert.equal(response.json().totals.processed, 3);
  assert.equal(f.state.mutations[0].command, 'UID MOVE');
  assert.equal(f.state.mutations[0].attributes[1].value, 'Projects');
});

test('scoped HTTP: failure metadata and failed-only retry preserve original refs and separate totals', async t => {
  const f = await fixture(t), ready = await f.prepare();
  f.state.fetchFailure = true;
  const response = await f.post(executeUrl, execution(ready));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().totals, { processed: 0, skipped: 0, failed: 3 });
  assert.ok(response.json().failed.every(item => item.retryable && item.code === 'MAIL_UNAVAILABLE'));
  const before = f.state.mutations.length;
  const failures = await f.get(failuresUrl(ready) + '?page=2&pageSize=2');
  assert.equal(failures.statusCode, 200); assert.equal(failures.json().total, 3);
  assert.equal(failures.json().page, 2); assert.equal(failures.json().pageSize, 2);
  assert.equal(failures.json().items.length, 1);
  assert.equal(failures.json().items[0].subject, 'synthetic mail 3');
  assert.equal(failures.json().items[0].ref, encodeRef('INBOX', 123, 3));
  assert.equal(f.state.mutations.length, before);
  const searches = f.state.searches;
  const retried = await f.prepare({ ...prepareBody, selectionKey: 'synthetic-retry-001', selectionId: ready.selectionId, retry: 'failed' });
  assert.notEqual(retried.selectionId, ready.selectionId); assert.equal(retried.initialTotal, 3);
  assert.equal(f.state.searches, searches);
  const result = await f.post(executeUrl, execution(retried));
  assert.equal(result.statusCode, 200); assert.deepEqual(result.json().totals, { processed: 3, skipped: 0, failed: 0 });
  assert.equal((await f.get(failuresUrl(ready))).json().total, 3);
});

test('scoped HTTP: unknown outcome is a 200 failure and failed-only retry excludes it', async t => {
  const f = await fixture(t), ready = await f.prepare(); f.state.unknown = true;
  const response = await f.post(executeUrl, execution(ready));
  assert.equal(response.statusCode, 200);
  assert.ok(response.json().failed.every(item => item.code === 'ACTION_OUTCOME_UNKNOWN' && !item.retryable));
  const retried = await f.prepare({ ...prepareBody, selectionKey: 'synthetic-unknown-retry', selectionId: ready.selectionId, retry: 'failed' });
  assert.equal(retried.initialTotal, 0);
  assert.equal((await f.post(executeUrl, execution(retried))).json().totals.failed, 0);
  assert.equal(f.state.mutations.length, 1);
});

test('scoped HTTP: partial STALE_SCOPE serializes error.detail and replays the same 409 receipt', async t => {
  const f = await fixture(t, 51), ready = await f.prepare();
  await f.get('/api/messages?quick=unread');
  f.state.replaceAfterMutation = true;
  const response = await f.post(executeUrl, execution(ready));
  assertError(response, 409, 'STALE_SCOPE');
  const body = response.json(); assert.deepEqual(Object.keys(body), ['error']);
  const detail = body.error.detail;
  assert.equal(detail.state, 'stopped'); assert.equal(detail.reason, 'stale_scope');
  assert.equal(detail.nextCursor, null); assert.equal(detail.selectionId, ready.selectionId);
  assert.deepEqual(detail.totals, { processed: 50, skipped: 0, failed: 0 });
  assert.equal(detail.remainingEstimate, 1);
  const replay = await f.post(executeUrl, execution(ready));
  assertError(replay, 409, 'STALE_SCOPE'); assert.deepEqual(replay.json(), body);
  assert.equal(f.state.mutations.length, 1);
  // Return to the original validity so cache invalidation cannot be masked by a validity change.
  f.state.validity = 123;
  assert.equal((await f.get('/api/messages?quick=unread')).json().total, 1);
});

const postRequests = [
  ['prepare', prepareUrl, prepareBody],
  ['execute', executeUrl, { scope, action: 'seen', cursor: 'x'.repeat(43) }],
  ['failed retry', prepareUrl, { ...prepareBody, selectionId: 'x'.repeat(43), retry: 'failed' }],
];
for (const [name, url, payload] of postRequests) {
  for (const rejection of ['no session', 'no CSRF', 'bad CSRF', 'no Origin', 'bad Origin']) {
    test(`scoped HTTP ${name}: ${rejection} rejects before mailbox access`, async t => {
      const f = await fixture(t), headers = { ...f.headers };
      if (rejection === 'no session') delete headers.cookie;
      if (rejection === 'no CSRF') delete headers['x-webmail-csrf'];
      if (rejection === 'bad CSRF') headers['x-webmail-csrf'] = 'synthetic-invalid';
      if (rejection === 'no Origin') delete headers.origin;
      if (rejection === 'bad Origin') headers.origin = 'https://other.example.com';
      const code = rejection === 'no session' ? 'NO_SESSION' : rejection.includes('CSRF') ? 'CSRF' : 'BAD_ORIGIN';
      assertError(await f.post(url, payload, headers), 403, code);
      assert.equal(f.state.searches, 0); assert.equal(f.state.mutations.length, 0);
    });
  }
}

test('scoped HTTP: failure GET requires a session and uses cookie auth without mutation CSRF', async t => {
  const f = await fixture(t), ready = await f.prepare();
  assertError(await f.get(failuresUrl(ready), {}), 403, 'NO_SESSION');
  assert.equal((await f.get(failuresUrl(ready), { cookie: f.headers.cookie })).statusCode, 200);
  assertError(await f.get(failuresUrl(ready) + '?page=0'), 400, 'LIST_QUERY_INVALID');
});

test('scoped HTTP: foreign session cursor, failure ID and retry cannot access another selection', async t => {
  const f = await fixture(t), ready = await f.prepare(), other = await f.login('other@example.com');
  assertError(await f.post(executeUrl, execution(ready), other), 409, 'SCOPE_CURSOR_MISMATCH');
  assertError(await f.get(failuresUrl(ready), other), 409, 'SCOPE_EXPIRED');
  assertError(await f.post(prepareUrl, { ...prepareBody, selectionKey: 'synthetic-foreign-retry', selectionId: ready.selectionId, retry: 'failed' }, other), 409, 'SCOPE_EXPIRED');
  assert.equal(f.state.mutations.length, 0);
});

test('scoped HTTP: scope/action tampering, invalid cursor and refs mixing retain plain error envelope', async t => {
  const f = await fixture(t), ready = await f.prepare();
  for (const body of [{ ...execution(ready), scope: { ...scope, quick: 'all' } }, { ...execution(ready), action: 'flag' }]) {
    const response = await f.post(executeUrl, body);
    assertError(response, 409, 'SCOPE_CURSOR_MISMATCH');
    assert.deepEqual(Object.keys(response.json().error).sort(), ['code', 'message']);
  }
  assertError(await f.post(executeUrl, { ...execution(ready), cursor: 'invalid' }), 400, 'SCOPE_CURSOR_INVALID');
  assertError(await f.post(prepareUrl, { ...prepareBody, refs: [] }), 400, 'SCOPE_CURSOR_INVALID');
  assertError(await f.post(prepareUrl, { ...prepareBody, action: 'invalid' }), 422, 'INVALID_ACTION');
  assert.equal(f.state.mutations.length, 0);
});

test('scoped HTTP: logout discards selection and all scoped routes return 403', async t => {
  const f = await fixture(t), ready = await f.prepare();
  assert.equal((await f.post('/api/auth/logout', {})).statusCode, 204);
  assertError(await f.post(prepareUrl, prepareBody), 403, 'SESSION_EXPIRED');
  assertError(await f.post(executeUrl, execution(ready)), 403, 'SESSION_EXPIRED');
  assertError(await f.get(failuresUrl(ready)), 403, 'SESSION_EXPIRED');
  assert.equal(f.state.mutations.length, 0);
});

test('scoped HTTP: legacy refs endpoint retains success, bounds, partial failure and plain errors', async t => {
  const f = await fixture(t), ref = encodeRef('INBOX', 123, 1), shared = encodeRef('Shared/synthetic@example.com', 123, 2);
  const url = '/api/messages/actions';
  const response = await f.post(url, { refs: [ref, shared], action: 'seen' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { done: 1, failed: [{ ref: shared, code: 'FOLDER_READONLY' }] });
  assert.deepEqual(f.state.legacy, [{ range: '1', flags: ['\\Seen'], options: { uid: true } }]);
  assert.equal(f.state.mutations.length, 0);
  for (const refs of [[], Array(1001).fill(ref)]) {
    const rejected = await f.post(url, { refs, action: 'seen' });
    assert.equal(rejected.statusCode, 422);
    assert.deepEqual(Object.keys(rejected.json().error).sort(), ['code', 'message']);
  }
  assertError(await f.post(url, { refs: [shared], action: 'seen' }), 403, 'FOLDER_READONLY');
  const { ['x-webmail-csrf']: omitted, ...headers } = f.headers;
  assertError(await f.post(url, { refs: [ref], action: 'seen' }, headers), 403, 'CSRF');
});
