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
  { user: owner, id: 'anyone', mailbox: 'INBOX', rights: ['lookup'] },
  { user: owner, id: 'staff=mail', mailbox: 'Archive', rights: ['lookup', 'read', '-write'] },
  { user: owner, id: 'authenticated', mailbox: 'Archive/2026', rights: [] },
  { user: owner, id: grantee, mailbox: 'MySharedNotes', rights: ['read'] },
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
    await assert.rejects(shares.list({}), error => error === failure);
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
    res.end(JSON.stringify([['doveadmResponse', state.response, tag]]));
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
    if (command === 'mailboxList') return [{ mailbox: 'INBOX' }];
    assert.equal(command, 'aclGet');
    return grants.has(args.user) ? [{ id: `user=${grantee}`, global: '', rights: 'lookup read' }] : [];
  } };
  const app = await createAdminApp({ config: { ...(on ? enabled : {}), adminHostname: 'mailadmin.example.com', trustProxy: [], auditDir: dir }, logger: false, auth: { client: mailcowFixture() }, dockerapi, doveadm });
  t.after(() => app.close());
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  const denied = await app.inject('/api/admin/shares'); assert.equal(denied.statusCode, 403); assert.equal(denied.headers['www-authenticate'], undefined);
  const item = async () => (await app.shares.list({})).items.find(row => row.owner === owner);
  const change = async grant => app.shares.change({ session: {}, actor: 'admin', ip: '192.0.2.1', owner, grantee, grant, etag: (await item()).etag });
  await change(true);
  assert.deepEqual((await app.accounts.detail({}, owner)).refs.shares, [{ owner, grantee, rights: ['lookup', 'read'] }]);
  await change(false); assert.deepEqual((await item()).grantees, []);
  assert.equal(calls.filter(call => call === 'docker-set').length, 1); assert.equal(calls.filter(call => call === 'docker-delete').length, 1);
  assert.equal(calls.includes('docker-read'), !on); assert.equal(calls.includes('aclGet'), on);
});
