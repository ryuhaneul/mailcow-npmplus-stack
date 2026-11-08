import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { authPolicyConfig, decideAuthPolicy, createAuthPolicyListener } from '../../server/admin/auth-policy.js';
const config = { bind: '127.0.0.2', peer: '127.0.0.1', relay: '127.0.0.3', sogo: '127.0.0.4', port: 10041 };
const request = { login: 'user@example.test', requested_username: 'user@example.test', protocol: 'imap', remote: '198.51.100.20', real_remote: '198.51.100.20', tls: true };
function fixture() {
  const rows = new Map([['user@example.test', { enabled: true, ips: ['198.51.100.0/24'] }]]), reads = [];
  return { rows, reads, store: { async read(target) { reads.push(target); return rows.get(target) ?? { enabled: false, ips: [] }; } } };
}
test('auth policy config is disabled only when all four addresses are absent and needs no archive key', () => {
  assert.deepEqual(authPolicyConfig(), { bind: '', peer: '', relay: '', sogo: '', port: 10041 });
  const env = { AUTH_POLICY_BIND: '192.0.2.10', AUTH_POLICY_PEER: '192.0.2.11', AUTH_POLICY_TRUSTED_RELAY: '192.0.2.12', AUTH_POLICY_TRUSTED_SOGO: '192.0.2.13', MAILCOW_IPV4_NETWORK: '192.0.2' };
  assert.equal(authPolicyConfig(env).bind, env.AUTH_POLICY_BIND);
  for (const patch of [{ AUTH_POLICY_PEER: '' }, { AUTH_POLICY_BIND: '0.0.0.0' }, { AUTH_POLICY_TRUSTED_RELAY: '192.0.2.11' }, { AUTH_POLICY_TRUSTED_SOGO: '198.51.100.3' }, { AUTH_POLICY_BIND: '192.0.2.0' }, { AUTH_POLICY_PEER: '192.0.2.255' }]) assert.throws(() => authPolicyConfig({ ...env, ...patch }));
});
test('auth policy: 12 protocol/flag/network combinations and empty list', async () => {
  for (const protocol of ['imap', 'pop3', 'smtp']) for (const enabled of [false, true]) for (const inside of [false, true]) {
    const f = fixture(); f.rows.get(request.requested_username).enabled = enabled;
    const result = await decideAuthPolicy({ ...request, protocol, remote: inside ? request.remote : '203.0.113.5', real_remote: inside ? request.remote : '203.0.113.5' }, { config, store: f.store });
    assert.equal(result.http, 200); assert.equal(result.status, enabled && !inside ? -1 : 0); assert.equal(f.reads.length, 1);
  }
  const f = fixture(); f.rows.get(request.requested_username).ips = [];
  assert.equal((await decideAuthPolicy(request, { config, store: f.store })).status, -1);
});
test('auth policy: exact real peer exemptions, spoofed login/remote, master target, local and Sieve paths', async () => {
  const f = fixture();
  for (const real_remote of [config.relay, config.sogo, '::ffff:127.0.0.3']) assert.equal((await decideAuthPolicy({ ...request, remote: '203.0.113.5', real_remote }, { config, store: f.store })).status, 0);
  assert.equal(f.reads.length, 0);
  for (const protocol of ['sieve', 'lmtp', 'doveadm']) assert.equal((await decideAuthPolicy({ ...request, protocol, remote: '', real_remote: '' }, { config, store: f.store })).status, 0);
  for (const patch of [{ real_remote: '127.0.0.5', remote: '203.0.113.5' }, { login: 'mailstack-webmail', remote: config.relay, real_remote: '203.0.113.5' }, { login: 'master@mailcow.local', remote: '203.0.113.5', real_remote: '203.0.113.5' }]) assert.equal((await decideAuthPolicy({ ...request, ...patch }, { config, store: f.store })).status, -1);
  assert.ok(f.reads.every(target => target === request.requested_username));
  for (const patch of [{ remote: undefined }, { real_remote: '' }, { remote: 'bad' }, { real_remote: 'bad' }]) assert.equal((await decideAuthPolicy({ ...request, ...patch }, { config, store: f.store })).status, -1);
  f.rows.get(request.requested_username).enabled = false;
  assert.equal((await decideAuthPolicy({ ...request, remote: '', real_remote: '' }, { config, store: f.store })).status, 0);
});
test('auth policy: IPv6/mapped normalization and DB failures never become a reject', async () => {
  const f = fixture(); f.rows.get(request.requested_username).ips = ['2001:db8::/48', '198.51.100.20'];
  for (const remote of ['2001:db8::5', '::ffff:198.51.100.20']) assert.equal((await decideAuthPolicy({ ...request, remote, real_remote: remote }, { config, store: f.store })).status, 0);
  assert.equal((await decideAuthPolicy({ ...request, remote: '2001:db9::1' }, { config, store: f.store })).status, -1);
  f.rows.get(request.requested_username).ips = ['bad/cidr'];
  assert.deepEqual(await decideAuthPolicy(request, { config, store: f.store }), { http: 503, reason: 'INVALID_ALLOWLIST' });
  for (const reason of ['DB_TIMEOUT', 'DB_UNAVAILABLE']) {
    const result = await decideAuthPolicy(request, { config, store: { async read() { throw Object.assign(Error('synthetic sensitive detail'), { reason }); } } });
    assert.deepEqual(result, { http: 503, reason });
  }
  for (const patch of [{ requested_username: '' }, { requested_username: 'bad' }, { protocol: 1 }, { device_id: 'mailstack-webmail' }]) assert.equal((await decideAuthPolicy({ ...request, ...patch }, { config, store: f.store })).http, 400);
});
function post(body, { localAddress = config.peer, path = '/auth-policy?command=allow', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: config.bind, port: config.port, path, method: 'POST', localAddress, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let data = ''; res.on('data', value => { data += value; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }));
    }); req.on('error', reject); req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}
test('real HTTP: peer isolation, fresh DB reads, 200/-1 versus 503, exact log counts and masking', async t => {
  const f = fixture(), logs = [];
  const listener = createAuthPolicyListener({ config, store: f.store, logger: { info: record => logs.push(record), warn: record => logs.push(record) } });
  await listener.start(); t.after(() => listener.stop());
  const denied = await post({ ...request, remote: '203.0.113.3' }); assert.equal(denied.status, 200); assert.deepEqual(denied.body, { status: -1 });
  const blockedPeer = await post(request, { localAddress: '127.0.0.9', headers: { 'x-forwarded-for': config.peer } }); assert.equal(blockedPeer.status, 403); assert.equal(blockedPeer.headers['www-authenticate'], undefined);
  assert.equal((await post(request, { path: '/auth-policy?command=report' })).status, 400);
  assert.equal((await post('{')).status, 400);
  f.store.read = async () => { throw Object.assign(Error(request.requested_username + ' ' + request.remote), { reason: 'DB_TIMEOUT' }); };
  const failed = await post(request); assert.equal(failed.status, 503); assert.deepEqual(failed.body, { error: 'POLICY_UNAVAILABLE' });
  f.store.read = async () => ({ enabled: false, ips: [] }); assert.deepEqual((await post(request)).body, { status: 0 });
  assert.deepEqual(logs, [{ code: 'AUTH_POLICY_DENY', reason: 'IP_NOT_ALLOWED' }, { code: 'AUTH_POLICY_FAIL_OPEN', reason: 'DB_TIMEOUT' }]);
  assert.ok(!JSON.stringify(logs).includes(request.requested_username)); assert.ok(!JSON.stringify(logs).includes(request.remote));
  try { const large = await post('x'.repeat(4097)); assert.equal(large.status, 400); } catch (error) { assert.equal(error.code, 'ECONNRESET'); }
});
test('real HTTP: a stalled body is closed at the body deadline and the listener stops cleanly', async t => {
  const f = fixture(), listener = createAuthPolicyListener({ config, store: f.store });
  await listener.start(); t.after(() => listener.stop());
  const socket = connect({ host: config.bind, port: config.port, localAddress: config.peer }); socket.on('error', () => {}); t.after(() => socket.destroy());
  await once(socket, 'connect'); const started = performance.now();
  const closed = once(socket, 'close'); socket.write('POST /auth-policy?command=allow HTTP/1.1\r\nHost: policy\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
  await closed; assert.ok(performance.now() - started < 2000); assert.equal(f.reads.length, 0);
});
