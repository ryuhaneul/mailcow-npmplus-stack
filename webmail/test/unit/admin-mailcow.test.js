import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailcowClient, MailcowAuthLost } from '../../server/admin/mailcow-client.js';

let tempRoot, key, cert;
const html = {};
const passwordText = 'synthetic-admin-password!';
const logs = [];
const logger = { warn: (data, message) => logs.push(JSON.stringify({ ...data, message })) };
before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'webmail-a02-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tempRoot, 'key.pem'), '-out', join(tempRoot, 'cert.pem'), '-days', '1', '-subj', '/CN=mailcow.example.com', '-addext', 'subjectAltName=DNS:mailcow.example.com'], { stdio: 'ignore' });
  key = await readFile(join(tempRoot, 'key.pem')); cert = await readFile(join(tempRoot, 'cert.pem'));
  for (const name of ['login', 'totp', 'unsupported', 'totp-missing-id']) html[name] = await readFile(new URL(`../fixtures/admin/${name}.html`, import.meta.url), 'utf8');
});
after(async () => {
  assert.ok(!logs.join('\n').includes(passwordText));
  if (process.env.ADMIN_CLIENT_TEST_LOG) await writeFile(process.env.ADMIN_CLIENT_TEST_LOG, logs.join('\n') + '\n');
  await rm(tempRoot, { recursive: true, force: true });
});

async function fakeMailcow(t, mode = 'plain') {
  const calls = [], states = new Map();
  const options = { mode };
  let serial = 0;
  const server = https.createServer({ key, cert }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const form = new URLSearchParams(raw);
    const sid = /MCSESSID=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    calls.push({ path: req.url, method: req.method, headers: req.headers, raw, form });
    const page = text => { res.setHeader('content-type', 'text/html'); res.end(text); };
    const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
    const redirect = path => { res.statusCode = 302; res.setHeader('location', path); res.end(); };
    const setSession = state => {
      const id = `synthetic-${++serial}`;
      states.set(id, state);
      res.setHeader('set-cookie', `MCSESSID=${id}; path=/; secure; HttpOnly; SameSite=Lax`);
      return id;
    };
    if (req.url === '/admin') { res.statusCode = 301; res.setHeader('location', '/admin/'); return res.end(); }
    if (req.url === '/' && form.get('logout') === '1') {
      if (sid) states.delete(sid);
      if (options.logoutHangs) return;
      if (options.logoutFails) { res.statusCode = 503; return res.end(); }
      return redirect('/admin');
    }
    if (req.url === '/admin/' && req.method === 'GET') {
      setSession({ state: 'login' });
      if (mode === 'initial-redirect') { res.statusCode = 301; res.setHeader('location', '/admin/'); return res.end(); }
      if (mode === 'initial-hang') return;
      if (mode === 'initial-large') return page('x'.repeat(2 * 1024 * 1024 + 1));
      if (mode === 'bad-initial') return page('<p>Unexpected page</p>');
      if (mode === 'total-timeout') { setTimeout(() => page(html.login), 14_000).unref(); return; }
      return page(html.login);
    }
    if (req.url === '/admin/' && form.has('pass_user')) {
      assert.equal(form.get('pass_user'), passwordText);
      assert.ok(states.has(sid));
      if (['bad-password', 'domain-admin'].includes(mode)) return page(html.login);
      if (['totp', 'totp-pending', 'totp-pending-slash', 'totp-bad-redirect', 'totp-not-admin'].includes(mode)) {
        states.get(sid).state = 'totp';
        return page(html.totp);
      }
      if (mode === 'unsupported') return page(html.unsupported);
      if (mode === 'totp-missing-id') return page(html['totp-missing-id']);
      if (mode === 'unexpected-login') return page('<p>Unexpected page</p>');
      const state = states.get(sid);
      states.delete(sid);
      setSession({ ...state, state: 'ready' });
      if (mode === 'pending') return redirect('/admin');
      if (mode === 'pending-slash') return redirect('/admin/');
      if (mode === 'external-redirect') return redirect('https://outside.example.com/admin/dashboard');
      if (mode === 'total-timeout') { setTimeout(() => redirect('/admin/dashboard'), 14_000).unref(); return; }
      return redirect('/admin/dashboard');
    }
    if (req.url === '/admin/' && form.has('verify_tfa_login')) {
      assert.equal(form.get('id'), '2');
      assert.equal(form.get('verify_tfa_login'), '1');
      assert.equal(form.get('tfa_method'), 'totp');
      assert.equal(states.get(sid)?.state, 'totp');
      if (form.get('token') !== '123456') { states.get(sid).state = 'login'; return page(html.login); }
      states.get(sid).state = 'ready';
      if (mode === 'totp-pending') return redirect('/admin');
      if (mode === 'totp-pending-slash') return redirect('/admin/');
      if (mode === 'totp-bad-redirect') return redirect('https://outside.example.com/admin/dashboard');
      return redirect('/admin/dashboard');
    }
    if (req.url === '/api/v1/get/status/version') {
      if (mode === 'version-empty') return res.end();
      if (mode === 'not-admin' || mode === 'totp-not-admin') return json({ type: 'error', msg: 'access denied' });
      if (mode === 'version-missing') return json({ name: 'synthetic' });
      if (mode === 'total-timeout') { setTimeout(() => json({ version: '2026-09a' }), 14_000).unref(); return; }
      return json({ version: '2026-09a' });
    }
    if (req.url.startsWith('/api/v1/')) {
      assert.equal(states.get(sid)?.state, 'ready');
      if (options.apiHang) return;
      if (options.apiLarge) return res.end('x'.repeat(2 * 1024 * 1024 + 1));
      if (options.apiStatus) res.statusCode = options.apiStatus;
      if (options.apiRaw !== undefined) return res.end(options.apiRaw);
      return json(options.apiData ?? { items: ['synthetic'] });
    }
    res.statusCode = 404; res.end('unexpected path');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const config = { mailcowUiUrl: `https://127.0.0.1:${server.address().port}`, mailcowUiServername: 'mailcow.example.com', mailTlsMode: 'pin', mailTlsPinFile: join(tempRoot, 'cert.pem') };
  const client = createMailcowClient({ config, logger });
  const login = async (username = '  ADMIN  ', ip = '203.0.113.7') => {
    const password = Buffer.from(passwordText);
    try { return await client.login({ username, password, ip }); }
    finally { assert.ok(password.every(byte => byte === 0)); }
  };
  return { calls, states, options, config, client, login };
}
function logoutCount(fake) { return fake.calls.filter(call => call.path === '/' && call.form.has('logout')).length; }

function assertHeaders(calls, ip = '203.0.113.7') {
  for (const call of calls) {
    assert.equal(call.headers.host, 'mailcow.example.com');
    assert.equal(call.headers['user-agent'], 'mailstack-webmail-admin');
    assert.equal(call.headers['x-forwarded-for'], ip);
    assert.equal(call.headers['sec-fetch-dest'], undefined);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers['x-api-key'], undefined);
    assert.equal(call.headers['x-mailadmin-csrf'], undefined);
    assert.ok(!call.raw.includes('csrf_token'));
  }
}

test('admin client: password-only login normalizes username, rotates cookie and checks superadmin', async t => {
  const fake = await fakeMailcow(t);
  const session = await fake.login();
  assert.equal(session.state, 'ready'); assert.equal(session.username, 'admin');
  assert.deepEqual(session.lastReturn, []); assert.ok(session.mailcowSeenAt <= Date.now());
  assert.equal(fake.calls[1].form.get('login_user'), 'admin');
  assert.deepEqual(fake.calls.map(call => call.path), ['/admin/', '/admin/', '/api/v1/get/status/version']);
  assert.notEqual(fake.calls[1].headers.cookie, fake.calls[2].headers.cookie);
  await fake.client.logout(session); await fake.client.logout(session);
  assert.equal(logoutCount(fake), 1); assert.equal(session.state, 'closed');
  assert.equal(session.jar.getCookieStringSync(fake.config.mailcowUiUrl), '');
  assert.equal(fake.states.size, 0); assertHeaders(fake.calls);
});

for (const mode of ['pending', 'pending-slash']) test(`admin client: ${mode} rejected before administrator API even if API would allow writes`, async t => {
  const fake = await fakeMailcow(t, mode);
  await assert.rejects(fake.login(), { statusCode: 403, code: 'ADMIN_PENDING_ACTION', fallbackUrl: 'https://mailcow.example.com/admin/' });
  assert.equal(logoutCount(fake), 1); assert.ok(!fake.calls.some(call => call.path.startsWith('/api/')));
});
for (const mode of ['bad-password', 'domain-admin', 'unsupported', 'totp-missing-id', 'unexpected-login', 'initial-redirect', 'bad-initial', 'external-redirect', 'not-admin', 'version-missing', 'version-empty']) {
  test(`admin client: ${mode} denies login, wipes password and logs out once`, async t => {
    const fake = await fakeMailcow(t, mode);
    const code = ['bad-password', 'domain-admin'].includes(mode) ? 'AUTH_FAILED' : ['unsupported', 'totp-missing-id'].includes(mode) ? 'ADMIN_2FA_UNSUPPORTED' : ['not-admin', 'version-missing', 'version-empty'].includes(mode) ? 'NOT_ADMIN' : 'MAILCOW_UNAVAILABLE';
    await assert.rejects(fake.login(), { code, statusCode: code === 'MAILCOW_UNAVAILABLE' ? 503 : 403 });
    assert.equal(logoutCount(fake), 1);
    assert.ok(!fake.calls.some(call => call.path === '/admin' || call.path === '/admin/dashboard'));
  });
}

test('admin client: TOTP modal takes precedence over login inputs and reads unnamed hidden row id', async t => {
  const fake = await fakeMailcow(t, 'totp');
  const session = await fake.login();
  assert.equal(session.state, 'totp'); assert.equal(session.totpId, '2');
  assert.equal(fake.calls.length, 2);
  assert.equal(await fake.client.totp(session, '123456'), session);
  assert.equal(session.state, 'ready');
  const form = fake.calls[2].form;
  assert.deepEqual([...form], [['verify_tfa_login', '1'], ['tfa_method', 'totp'], ['token', '123456'], ['id', '2']]);
  await fake.client.logout(session); assert.equal(logoutCount(fake), 1); assertHeaders(fake.calls);
});

test('admin client: one wrong TOTP destroys pending state and requires a fresh password login', async t => {
  const fake = await fakeMailcow(t, 'totp');
  const session = await fake.login();
  await assert.rejects(fake.client.totp(session, '654321'), { statusCode: 403, code: 'TOTP_FAILED', restart: true });
  assert.equal(session.state, 'closed'); assert.equal(session.jar.getCookieStringSync(fake.config.mailcowUiUrl), '');
  await assert.rejects(fake.client.totp(session, '123456'), MailcowAuthLost);
  await fake.client.logout(session); assert.equal(logoutCount(fake), 1);
});

for (const mode of ['totp-pending', 'totp-pending-slash', 'totp-not-admin', 'totp-bad-redirect']) test(`admin client: ${mode} cannot finish TOTP`, async t => {
  const fake = await fakeMailcow(t, mode); const session = await fake.login();
  const code = mode.startsWith('totp-pending') ? 'ADMIN_PENDING_ACTION' : mode === 'totp-not-admin' ? 'NOT_ADMIN' : 'MAILCOW_UNAVAILABLE';
  await assert.rejects(fake.client.totp(session, '123456'), { code });
  assert.equal(logoutCount(fake), 1); assert.equal(session.state, 'closed');
});

test('admin client: malformed credentials and TOTP do not submit credentials to mailcow', async t => {
  const fake = await fakeMailcow(t, 'totp');
  for (const username of ['', ' ']) await assert.rejects(fake.login(username), { statusCode: 422 });
  assert.equal(fake.calls.length, 0);
  const session = await fake.login();
  for (const value of ['', '12345', '1234567', 'abcdef', 123456]) await assert.rejects(fake.client.totp(session, value), { statusCode: 422 });
  assert.equal(fake.calls.length, 2); assert.equal(session.state, 'totp');
  await fake.client.logout(session);
});

test('admin client: JSON GET and POST preserve payload, UA and XFF without form CSRF fields', async t => {
  const fake = await fakeMailcow(t); const session = await fake.login();
  const body = { items: ['user@example.com'], attr: { active: '1' } };
  const before = session.mailcowSeenAt; session.mailcowSeenAt = 0;
  assert.deepEqual(await fake.client.call(session, 'GET', '/api/v1/get/mailbox/all'), { items: ['synthetic'] });
  assert.ok(session.mailcowSeenAt >= before);
  fake.options.apiData = { type: 'success', msg: 'Task completed' };
  await fake.client.call(session, 'POST', '/api/v1/edit/mailbox', body);
  const post = fake.calls.at(-1); assert.equal(post.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(post.raw), body);
  await fake.client.logout(session); assertHeaders(fake.calls);
});

for (const [name, options] of [
  ['empty', { apiRaw: '' }], ['whitespace', { apiRaw: ' ' }], ['HTML', { apiRaw: '<html>login</html>' }],
  ['unauthorized', { apiStatus: 401, apiData: {} }], ['forbidden', { apiStatus: 403, apiData: {} }],
  ['authentication failed', { apiData: { type: 'error', msg: 'authentication failed' } }],
  ['access denied', { apiData: [{ type: 'error', msg: ['access_denied'] }] }],
]) test(`admin client: ${name} is MailcowAuthLost and never updates successful-seen time`, async t => {
  const fake = await fakeMailcow(t); const session = await fake.login();
  Object.assign(fake.options, options); const seenAt = session.mailcowSeenAt;
  await assert.rejects(fake.client.call(session, 'GET', '/api/v1/get/mailbox/all'), error => error instanceof MailcowAuthLost && error.statusCode === 403 && error.code === 'MAILCOW_SESSION_LOST');
  assert.equal(session.mailcowSeenAt, seenAt); await fake.client.logout(session);
});

test('admin client: write baseline includes login success, excludes prior danger, resets when prefix changes', async t => {
  const fake = await fakeMailcow(t); const session = await fake.login();
  const login = { type: 'success', msg: ['logged_in_as', 'admin'] };
  const success = { type: 'success', msg: ['mailbox_modified', 'user@example.com'] };
  const danger = { type: 'danger', msg: ['mailbox_invalid', 'user@example.com'] };
  fake.options.apiData = [login, success];
  assert.deepEqual(await fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {}), [login, success]);
  fake.options.apiData = [login, success, danger];
  await assert.rejects(fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {}), { statusCode: 422, code: 'MAILCOW_REJECTED', mailcowMessageKey: 'mailbox_invalid' });
  fake.options.apiData = [login, success, danger, success];
  await fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {});
  // A GET array must not replace the write-response baseline.
  fake.options.apiData = [{ type: 'danger', msg: 'synthetic_get_row' }];
  await fake.client.call(session, 'GET', '/api/v1/get/mailbox/all');
  fake.options.apiData = [login, success, danger, success];
  await fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {});
  fake.options.apiData = [{ type: 'danger', msg: 'new_failure' }];
  await assert.rejects(fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {}), { code: 'MAILCOW_REJECTED', mailcowMessageKey: 'new_failure' });
  fake.options.apiData = [success];
  await fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {});
  await fake.client.logout(session);
});

test('admin client: sessions have independent cookies, baselines and fixed forwarding IPs', async t => {
  const fake = await fakeMailcow(t);
  const first = await fake.login('admin', '192.0.2.7'); const second = await fake.login('other', '198.51.100.8');
  assert.notEqual(first.jar.getCookieStringSync(fake.config.mailcowUiUrl), second.jar.getCookieStringSync(fake.config.mailcowUiUrl));
  fake.options.apiData = [{ type: 'danger', msg: 'first_failure' }];
  await assert.rejects(fake.client.call(first, 'POST', '/api/v1/edit/mailbox', {}), { statusCode: 422 });
  await assert.rejects(fake.client.call(second, 'POST', '/api/v1/edit/mailbox', {}), { statusCode: 422 });
  assert.equal(fake.calls.at(-2).headers['x-forwarded-for'], '192.0.2.7');
  assert.equal(fake.calls.at(-1).headers['x-forwarded-for'], '198.51.100.8');
  await fake.client.logout(first); await fake.client.logout(second);
  assert.equal(logoutCount(fake), 2);
});

test('admin client: rejected remote messages and logout failures do not leak secrets into errors or logs', async t => {
  const fake = await fakeMailcow(t); const session = await fake.login();
  fake.options.apiData = [{ type: 'danger', msg: `server echoed ${passwordText}` }];
  await assert.rejects(fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {}), error => error.code === 'MAILCOW_REJECTED' && !error.message.includes(passwordText));
  const before = logs.length; fake.options.logoutFails = true;
  await fake.client.logout(session); await fake.client.logout(session);
  assert.equal(logoutCount(fake), 1); assert.equal(session.state, 'closed');
  assert.equal(logs.length, before + 1); assert.match(logs.at(-1), /MAILCOW_LOGOUT_FAILED/);
});

for (const stage of ['initial-large', 'api-large']) test(`admin client: ${stage} rejects responses over 2MB`, async t => {
  const fake = await fakeMailcow(t, stage);
  if (stage === 'initial-large') await assert.rejects(fake.login(), { code: 'MAILCOW_UNAVAILABLE' });
  else {
    const session = await fake.login(); fake.options.apiLarge = true;
    await assert.rejects(fake.client.call(session, 'GET', '/api/v1/get/mailbox/all'), { code: 'MAILCOW_UNAVAILABLE' });
    await fake.client.logout(session);
  }
  assert.equal(logoutCount(fake), 1);
});

test('admin client: TLS pin validates certificate hostname', async t => {
  const fake = await fakeMailcow(t);
  const client = createMailcowClient({ config: { ...fake.config, mailcowUiServername: 'wrong.example.com' }, logger });
  const password = Buffer.from(passwordText);
  await assert.rejects(client.login({ username: 'admin', password, ip: '203.0.113.7' }), { code: 'MAILCOW_UNAVAILABLE' });
  assert.ok(password.every(byte => byte === 0)); assert.equal(fake.calls.length, 0);
});

test('admin client: upstream API redirect is not followed', async t => {
  const fake = await fakeMailcow(t); const session = await fake.login();
  fake.options.apiStatus = 302; fake.options.apiData = {};
  await assert.rejects(fake.client.call(session, 'GET', '/api/v1/get/mailbox/all'), { statusCode: 502 });
  assert.equal(fake.calls.length, 4); await fake.client.logout(session);
});

test('admin client: request deadline aborts a hanging API within 15 seconds', async t => {
  const fake = await fakeMailcow(t); const session = await fake.login();
  fake.options.apiHang = true;
  const start = Date.now();
  await assert.rejects(fake.client.call(session, 'GET', '/api/v1/get/mailbox/all'), { statusCode: 503, code: 'MAILCOW_UNAVAILABLE' });
  assert.ok(Date.now() - start >= 14_500 && Date.now() - start < 17_000);
  await fake.client.logout(session); assert.equal(logoutCount(fake), 1);
});

test('admin client: whole login deadline caps multiple requests that each finish within 15 seconds', async t => {
  const fake = await fakeMailcow(t, 'total-timeout');
  const start = Date.now();
  await assert.rejects(fake.login(), { statusCode: 503, code: 'MAILCOW_UNAVAILABLE' });
  assert.ok(Date.now() - start >= 39_500 && Date.now() - start < 42_000);
  assert.equal(logoutCount(fake), 1);
});


test('admin client: logout deadline warns once and clears local state after 15 seconds', async t => {
  const fake = await fakeMailcow(t); const session = await fake.login();
  fake.options.logoutHangs = true;
  const before = logs.length; const start = Date.now();
  await fake.client.logout(session);
  assert.ok(Date.now() - start >= 14_500 && Date.now() - start < 17_000);
  assert.equal(session.state, 'closed');
  assert.equal(session.jar.getCookieStringSync(fake.config.mailcowUiUrl), '');
  assert.equal(logs.length, before + 1); assert.match(logs.at(-1), /MAILCOW_LOGOUT_FAILED/);
  await fake.client.logout(session); assert.equal(logoutCount(fake), 1);
});


test('admin client: object error and danger reject without changing the write baseline', async t => {
  const fake = await fakeMailcow(t); const session = await fake.login();
  const baseline = [{ type: 'success', msg: 'previous_success' }];
  fake.options.apiData = baseline;
  await fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {});
  for (const [type, msg, key] of [['error', 'Cannot edit item', null], ['danger', ['mailbox_invalid'], 'mailbox_invalid']]) {
    fake.options.apiData = { type, msg };
    await assert.rejects(fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {}), { statusCode: 422, code: 'MAILCOW_REJECTED', mailcowMessageKey: key });
    assert.deepEqual(session.lastReturn, baseline);
  }
  await fake.client.logout(session);
});

test('admin client: object success preserves baseline and other object shapes return bad gateway', async t => {
  const fake = await fakeMailcow(t); const session = await fake.login();
  const baseline = [{ type: 'success', msg: 'previous_success' }];
  fake.options.apiData = baseline;
  await fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {});
  fake.options.apiData = { type: 'success', msg: 'Task completed' };
  assert.deepEqual(await fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {}), fake.options.apiData);
  assert.deepEqual(session.lastReturn, baseline);
  for (const data of [{}, { type: 'unknown', msg: 'synthetic' }]) {
    fake.options.apiData = data;
    await assert.rejects(fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {}), { statusCode: 502, code: 'MAILCOW_REJECTED' });
    assert.deepEqual(session.lastReturn, baseline);
  }
  await fake.client.logout(session);
});

for (const type of ['error', 'danger']) test(`admin client: array ${type} rejects only newly appended messages`, async t => {
  const fake = await fakeMailcow(t); const session = await fake.login();
  const rejected = { type, msg: ['mailbox_invalid'] };
  fake.options.apiData = [rejected];
  await assert.rejects(fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {}), { statusCode: 422, code: 'MAILCOW_REJECTED', mailcowMessageKey: 'mailbox_invalid' });
  fake.options.apiData = [rejected, { type: 'success', msg: 'mailbox_modified' }];
  await fake.client.call(session, 'POST', '/api/v1/edit/mailbox', {});
  await fake.client.logout(session);
});
