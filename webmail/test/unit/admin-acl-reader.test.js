import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAclReader } from '../../server/admin/acl-reader.js';
import { createDoveadm } from '../../server/admin/doveadm.js';
import { createSharesService } from '../../server/admin/services/shares.js';
import { createAccountsService } from '../../server/admin/services/accounts.js';
import { createAdminApp } from '../../server/admin/app.js';
import { AppError } from '../../server/errors.js';

const owner = 'owner@example.com', grantee = 'user@example.com';
const enabled = { doveadmUrl: 'http://dovecot:12346', doveadmKey: 'synthetic-acl-key' };
const folders = ['INBOX', 'Archive', 'Archive/2026', 'Shared/other@example.com/INBOX', 'MySharedNotes'];
const acl = {
  INBOX: [{ id: `user=${grantee}`, global: '', rights: 'lookup read' }, { id: 'anyone', global: 'global', rights: 'lookup' }],
  Archive: [{ id: 'group=staff=mail', global: '', rights: 'lookup  read -write' }],
  'Archive/2026': [{ id: 'authenticated', global: '', rights: '' }],
  MySharedNotes: [{ id: `user=${grantee}`, global: 'global', rights: 'read' }],
};
const owned = [
  { user: owner, id: grantee, mailbox: 'INBOX', rights: ['lookup', 'read'] },
  { user: owner, id: 'anyone', mailbox: 'INBOX', rights: ['global', 'lookup'] },
  { user: owner, id: 'group=staff=mail', mailbox: 'Archive', rights: ['lookup', 'read', '-write'] },
  { user: owner, id: 'authenticated', mailbox: 'Archive/2026', rights: [] },
  { user: owner, id: grantee, mailbox: 'MySharedNotes', rights: ['global', 'read'] },
];

test('ACL reader: owned rows match dockerapi, excluding Shared/ with sequential folders and global rows retained', async () => {
  const calls = []; let active = 0, peak = 0;
  const dockerapi = { async getAcl(who) {
    assert.equal(who, owner);
    return [...owned, { user: 'other@example.com', id: owner, mailbox: 'INBOX', rights: ['lookup', 'read'] }];
  } };
  const doveadm = { async call(command, args) {
    calls.push({ command, args }); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return command === 'mailboxList' ? folders.map(mailbox => ({ mailbox })) : acl[args.mailbox];
  } };
  const legacy = createAclReader({ dockerapi, doveadm, config: {} });
  const reader = createAclReader({ dockerapi, doveadm, config: enabled });
  assert.deepEqual(await reader.getAcl(owner), (await legacy.getAcl(owner)).filter(row => row.user === owner));
  assert.equal(peak, 1);
  assert.deepEqual(calls, [{ command: 'mailboxList', args: { user: owner } }, ...folders.filter(mailbox => !mailbox.startsWith('Shared/')).map(mailbox => ({ command: 'aclGet', args: { user: owner, mailbox } }))]);
});

test('ACL reader: received namespace root and descendants are skipped, user folders remain', async () => {
  const calls = [];
  const reader = createAclReader({ config: enabled, dockerapi: { getAcl() { assert.fail('no fallback'); } }, doveadm: { async call(command, args) {
    if (command === 'mailboxList') return ['INBOX', 'Shared', 'Shared/other@example.com', 'Shared/other@example.com/INBOX', 'MySharedDocs'].map(mailbox => ({ mailbox }));
    calls.push(args.mailbox);
    if (args.mailbox === 'Shared') throw new AppError(502, 'DOVEADM_REJECTED', "Can't open mailbox Shared");
    return [];
  } } });
  assert.deepEqual(await reader.getAcl(grantee), []);
  assert.deepEqual(calls, ['INBOX', 'MySharedDocs']);
});

for (const config of [{}, { doveadmUrl: enabled.doveadmUrl }, { doveadmKey: enabled.doveadmKey }]) {
  test(`ACL reader: incomplete config ${Object.keys(config)} calls only dockerapi and returns it unchanged`, async () => {
    let calls = 0;
    const rows = [{ user: 'other@example.com', id: owner, mailbox: 'INBOX', rights: ['read'] }];
    const reader = createAclReader({ config, doveadm: { call() { assert.fail('doveadm disabled'); } }, dockerapi: { async getAcl(who) { calls++; assert.equal(who, owner); return rows; } } });
    assert.equal(await reader.getAcl(owner), rows); assert.equal(calls, 1);
  });
}

function mailcowFixture() {
  const boxes = [owner, grantee].map(username => ({ username, active: 1, quota: 1024 ** 3, quota_used: 0, messages: 0, attributes: {}, sender_acl: [] }));
  return { async call(_session, method, path) {
    assert.equal(method, 'GET');
    if (path.endsWith('/status/version')) return { version: 'synthetic' };
    if (path.endsWith('/mailbox/all')) return boxes;
    if (path.startsWith('/api/v1/get/mailbox/')) return boxes.find(row => row.username === decodeURIComponent(path.split('/').at(-1))) ?? {};
    return [];
  } };
}

for (const failure of [new AppError(502, 'DOVEADM_REJECTED', '거부'), new AppError(503, 'DOVEADM_UNAVAILABLE', '시간 초과'), new AppError(404, 'NOT_FOUND', '없는 사용자')]) {
  test(`ACL reader: later folder ${failure.code} rejects all; accounts warn and stop preview; shares reject`, async () => {
    const calls = [];
    const reader = createAclReader({ config: enabled, dockerapi: { getAcl() { assert.fail('no fallback'); } }, doveadm: { async call(command, args) {
      calls.push({ command, args });
      if (command === 'mailboxList') return ['INBOX', 'Archive', 'Later'].map(mailbox => ({ mailbox }));
      if (args.mailbox === 'Archive') throw failure;
      return acl.INBOX;
    } } });
    await assert.rejects(reader.getAcl(owner), error => error === failure);
    assert.deepEqual(calls.map(row => row.args.mailbox).filter(Boolean), ['INBOX', 'Archive']);
    const mailcow = mailcowFixture(), history = { register() {} };
    const accounts = createAccountsService({ mailcow, dockerapi: reader, history });
    const detail = await accounts.detail({}, owner);
    assert.deepEqual(detail.refs.shares, []); assert.equal(detail.warnings[0].code, 'SHARES_PARTIAL');
    await assert.rejects(accounts.deletePreview({}, owner), { statusCode: 502, code: 'SHARES_UNAVAILABLE' });
    const shares = createSharesService({ mailcow, dockerapi: reader, history });
    await assert.rejects(shares.get({}, owner), error => error === failure);
  });
}

test('ACL reader: mailbox listing failure is propagated without fallback or ACL calls', async () => {
  const failure = new AppError(404, 'NOT_FOUND', '없는 사용자'); let calls = 0;
  const reader = createAclReader({ config: enabled, dockerapi: { getAcl() { assert.fail('no fallback'); } }, doveadm: { async call(command) { calls++; assert.equal(command, 'mailboxList'); throw failure; } } });
  await assert.rejects(reader.getAcl(owner), error => error === failure); assert.equal(calls, 1);
});

async function httpFixture(t) {
  const requests = [], state = { response: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/doveadm/v1');
    const [[command, args, tag]] = JSON.parse(Buffer.concat(chunks)); requests.push({ command, args });
    assert.equal(req.headers.authorization, `X-Dovecot-API ${Buffer.from(enabled.doveadmKey).toString('base64')}`);
    res.end(JSON.stringify([[state.type ?? 'doveadmResponse', state.response, tag]]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, state, client: createDoveadm({ config: { ...enabled, doveadmUrl: `http://127.0.0.1:${server.address().port}` } }) };
}

test('doveadm aclGet: bad inputs get 422 with zero HTTP; only user/mailbox accepted; writes remain denied', async t => {
  const f = await httpFixture(t);
  for (const args of [undefined, {}, { user: owner }, { user: owner, mailbox: '' }, { user: owner, mailbox: '  ' }, { user: owner, mailbox: 1 }, { user: owner, mailbox: 'a'.repeat(1001) }, { user: '*@example.com', mailbox: 'INBOX' }, { user: 'user?@example.com', mailbox: 'INBOX' }, ...['query', 'allUsers', 'socketPath', 'userFile', 'matchMe'].map(key => ({ user: owner, mailbox: 'INBOX', [key]: true }))]) {
    await assert.rejects(f.client.call('aclGet', args), { statusCode: 422, code: 'INVALID_INPUT' });
  }
  assert.equal(f.requests.length, 0);
  f.state.response = acl.INBOX;
  assert.deepEqual(await f.client.call('aclGet', { user: owner, mailbox: 'Archive/2026' }), acl.INBOX);
  assert.deepEqual(f.requests, [{ command: 'aclGet', args: { user: owner, mailbox: 'Archive/2026' } }]);
  await f.client.call('aclGet', { user: owner, mailbox: 'a'.repeat(1000) });
  for (const command of ['aclSet', 'aclDelete']) await assert.rejects(f.client.call(command, { user: owner, mailbox: 'INBOX' }), { statusCode: 422, code: 'DOVEADM_COMMAND_NOT_ALLOWED' });
  for (const command of ['mailboxList', 'quotaGet', 'quotaRecalc']) await assert.rejects(f.client.call(command, { user: owner, mailbox: 'INBOX' }), { statusCode: 422 });
  assert.equal(f.requests.length, 2);
});

test('doveadm: aclGet exit 68 alone is MAILBOX_NOT_FOUND; other failures retain their meaning', async t => {
  const f = await httpFixture(t);
  f.state.type = 'error';
  f.state.response = { type: 'exitCode', exitCode: 68 };
  await assert.rejects(f.client.call('aclGet', { user: owner, mailbox: 'Projects' }), { statusCode: 404, code: 'MAILBOX_NOT_FOUND' });
  for (const command of ['mailboxList', 'quotaGet', 'quotaRecalc', 'search', 'expunge']) {
    await assert.rejects(f.client.call(command, { user: owner, ...(['search', 'expunge'].includes(command) ? { query: [] } : {}) }), { statusCode: 502, code: 'DOVEADM_REJECTED' });
  }
  f.state.response = { type: 'exitCode', exitCode: 67 };
  await assert.rejects(f.client.call('aclGet', { user: owner, mailbox: 'Projects' }), { statusCode: 404, code: 'NOT_FOUND' });
  for (const response of [{ type: 'unAuthorized' }, { type: 'exitCode', exitCode: 75 }, { type: 'exitCode', exitCode: '68' }]) {
    f.state.response = response;
    await assert.rejects(f.client.call('aclGet', { user: owner, mailbox: 'Projects' }), { statusCode: 502, code: 'DOVEADM_REJECTED' });
  }
  const count = f.requests.length;
  await assert.rejects(f.client.call('mailboxStatus', { user: owner, field: ['guid'], mailboxMask: ['*'] }), { statusCode: 422, code: 'DOVEADM_COMMAND_NOT_ALLOWED' });
  assert.equal(f.requests.length, count);
});

for (const on of [true, false]) test(`admin app: shares/accounts use ${on ? 'doveadm reader' : 'dockerapi fallback'}; writes remain dockerapi`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'webmail-acl-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const grants = new Set(), calls = [];
  const dockerapi = {
    async getAcl(who) { calls.push('docker-read'); return grants.has(who) ? [{ user: who, id: grantee, mailbox: 'INBOX', rights: ['lookup', 'read'] }] : []; },
    async setAcl(who, id) { calls.push('docker-set'); assert.equal(id, grantee); grants.add(who); },
    async deleteAcl(who, id) { calls.push('docker-delete'); assert.equal(id, grantee); grants.delete(who); },
  };
  const doveadm = { async call(command, args) {
    assert.ok(on); calls.push(command);
    if (command === 'mailboxList') return (args.user === grantee && grants.has(owner) ? ['INBOX', 'Shared', `Shared/${owner}`, `Shared/${owner}/INBOX`, 'Projects', 'Projects/Branch', 'Projects/Branch/Leaf'] : ['INBOX', 'Projects', 'Projects/Branch', 'Projects/Branch/Leaf']).map(mailbox => ({ mailbox }));
    assert.equal(command, 'aclGet');
    if (args.mailbox === 'Projects/Branch/Leaf') return [];
    if (['Projects', 'Projects/Branch'].includes(args.mailbox)) throw new AppError(404, 'MAILBOX_NOT_FOUND', 'synthetic doveadm exit 68');
    if (args.mailbox === 'Shared') throw new AppError(502, 'DOVEADM_REJECTED', "Can't open mailbox Shared");
    return grants.has(args.user) ? [{ id: `user=${grantee}`, global: '', rights: 'lookup read' }] : [];
  } };
  const app = await createAdminApp({ config: { ...(on ? enabled : {}), adminHostname: 'mailadmin.example.com', trustProxy: [], sessionIdleMin: 60, sessionMaxHours: 8, auditDir: dir }, logger: false, auth: { client: { ...mailcowFixture(), async login({ username }) { return { username, state: 'ready' }; } } }, dockerapi, doveadm });
  t.after(() => app.close());
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  const denied = await app.inject('/api/admin/shares'); assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
  const item = async () => app.shares.get({}, owner);
  const change = async grant => app.shares.change({ session: {}, actor: 'admin', ip: '192.0.2.1', owner, grantee, grant, etag: (await item()).etag });
  await change(true);
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://mailadmin.example.com' }, payload: { username: 'admin', password: 'synthetic' } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { origin: 'https://mailadmin.example.com', cookie: login.headers['set-cookie'].split(';')[0], 'x-mailadmin-csrf': login.json().csrf };
  const shares = await app.inject({ url: '/api/admin/shares', headers });
  assert.equal(shares.statusCode, 200, shares.body);
  const preview = await app.inject({ method: 'POST', url: `/api/admin/mailboxes/${grantee}/delete-preview`, headers, payload: {} });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual((await app.accounts.detail({}, owner)).refs.shares, [{ owner, grantee, mailbox: 'INBOX', rights: ['lookup', 'read'] }]);
  await change(false); assert.deepEqual((await item()).grantees, []);
  assert.equal(calls.filter(call => call === 'docker-set').length, 1); assert.equal(calls.filter(call => call === 'docker-delete').length, 1);
  assert.equal(calls.includes('docker-read'), !on); assert.equal(calls.includes('aclGet'), on);
});

for (const on of [false, true]) test(`global INBOX ACL: ${on ? 'doveadm' : 'dockerapi'} rename preview rejects with 409 and zero writes`, async () => {
  let writes = 0;
  const globalAcl = { user: owner, id: grantee, mailbox: 'INBOX', rights: ['global', 'lookup', 'read'] };
  const dockerapi = {
    async getAcl(who) { return who === owner ? [globalAcl] : []; },
    async setAcl() { writes++; },
    async deleteAcl() { writes++; },
  };
  const doveadm = { async call(command, args) {
    if (command === 'mailboxList') return [{ mailbox: 'INBOX' }];
    assert.equal(command, 'aclGet');
    return args.user === owner ? [{ id: `user=${grantee}`, global: 'global', rights: 'lookup read' }] : [];
  } };
  const reader = createAclReader({ config: on ? enabled : {}, dockerapi, doveadm });
  const original = mailcowFixture();
  const mailcow = { async call(session, method, path, body) {
    if (method !== 'GET') writes++;
    return original.call(session, method, path, body);
  } };
  const accounts = createAccountsService({ mailcow, dockerapi: { ...dockerapi, getAcl: reader.getAcl }, history: { register() {} }, teams: {} });
  await assert.rejects(accounts.rename({ session: {}, actor: 'admin', ip: '192.0.2.1', addr: grantee, data: { action: 'preview', newLocal: 'new', keepOldAsAlias: true } }), { statusCode: 409, code: 'ACL_UNSUPPORTED' });
  assert.equal(writes, 0);
  assert.deepEqual(await reader.getAcl(owner), [globalAcl]);
});

test('ACL reader: missing or non-string global rejects the whole result after a valid row', async () => {
  for (const global of [undefined, null, false, 0, {}, []]) {
    const row = { id: `user=${grantee}`, rights: 'lookup read' };
    if (global !== undefined) row.global = global;
    const reader = createAclReader({ config: enabled, dockerapi: { getAcl() { assert.fail('no fallback'); } }, doveadm: { async call(command) {
      return command === 'mailboxList' ? [{ mailbox: 'INBOX' }] : [acl.INBOX[0], row];
    } } });
    await assert.rejects(reader.getAcl(owner), { statusCode: 502, code: 'DOVEADM_REJECTED' });
  }
});


test('ACL reader: domain group and matching user remain distinct, including Templates tree', async () => {
  const names = ['Templates', 'Templates/공유', 'Templates/공유/깊이', 'Templates-old'];
  const reader = createAclReader({ config: enabled, dockerapi: {}, doveadm: { async call(command, args) {
    if (command === 'mailboxList') return names.map(mailbox => ({ mailbox }));
    assert.ok(names.includes(args.mailbox));
    return ['user=example.com', 'group=example.com', 'anyone', 'authenticated', '-user=example.com'].map(id => ({ id, global: '', rights: 'lookup read' }));
  } } });
  const rows = await reader.getAcl(owner);
  assert.equal(rows.length, 20);
  for (const mailbox of names) assert.deepEqual(rows.filter(row => row.mailbox === mailbox).map(row => row.id), ['example.com', 'group=example.com', 'anyone', 'authenticated', '-user=example.com']);
});
