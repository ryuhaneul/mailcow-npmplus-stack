import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { createDoveadm } from '../../server/admin/doveadm.js';

const user = 'synthetic@example.test', mailbox = '보관함 / 2026';
const guid = '0123456789abcdef0123456789abcdef';
// Synthetic fixtures matching the installed Dovecot 2.3.21.1 shapes (plan §13).
const responses = {
  user: { userList: [user, 'team@example.test'] },
  index: [],
  mailboxStatus: [{ mailbox, messages: '30', guid, uidvalidity: '1792130254' }],
  ftsFlatcurveStats: [{ mailbox, guid, last_uid: '35', messages: '30', shards: '2', version: '1' }],
  mailboxMetadataGet: [{ value: '\\Junk' }],
};
async function fixture(t) {
  const requests = [], events = new EventEmitter(), state = {};
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/doveadm/v1');
    assert.equal(req.headers.authorization, `X-Dovecot-API ${Buffer.from('synthetic-key').toString('base64')}`);
    const [[command, args, tag]] = JSON.parse(Buffer.concat(chunks));
    requests.push({ command, args }); events.emit('request');
    if (state.mode === 'hang') return;
    if (state.mode === 'disconnect') { res.destroy(); return; }
    if (state.mode === 'oversize') { res.end('x'.repeat(16 * 1024 * 1024 + 1)); return; }
    if (state.mode === 'http') { res.writeHead(500); res.end(); return; }
    if (state.mode === 'invalidJson') { res.end('invalid'); return; }
    res.end(JSON.stringify([[state.type ?? 'doveadmResponse', Object.hasOwn(state, 'value') ? state.value : responses[command] ?? [], state.mode === 'wrongTag' ? 'wrong' : tag]]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = { doveadmUrl: `http://127.0.0.1:${server.address().port}`, doveadmKey: 'synthetic-key' };
  return { requests, state, events, server, config, client: createDoveadm({ config }) };
}

test('FTS dedicated methods send only fixed arguments and parse installed response shapes', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.listUsers(), responses.user.userList);
  assert.deepEqual(await f.client.indexMailbox(user, mailbox), []);
  assert.deepEqual(await f.client.mailboxStatus(user, mailbox), [{ mailbox, guid, messages: 30, uidvalidity: 1792130254 }]);
  assert.deepEqual(await f.client.ftsStats(user, mailbox), [{ mailbox, guid, messages: 30, last_uid: 35, shards: 2, version: 1 }]);
  assert.deepEqual(await f.client.specialUse(user, mailbox), [{ value: '\\Junk' }]);
  assert.deepEqual(f.requests, [
    { command: 'user', args: { userMask: ['*'] } },
    { command: 'index', args: { user, mailboxMask: mailbox } },
    { command: 'mailboxStatus', args: { user, field: ['messages', 'guid', 'uidvalidity'], mailboxMask: [mailbox] } },
    { command: 'ftsFlatcurveStats', args: { user, mailboxMask: [mailbox] } },
    { command: 'mailboxMetadataGet', args: { user, mailbox, key: '/private/specialuse' } },
  ]);
  f.state.value = [{ value: '' }]; assert.deepEqual(await f.client.specialUse(user, 'INBOX'), [{ value: '' }]);
  f.state.value = [];
  assert.deepEqual(await f.client.ftsStats(user, 'Missing'), []);
  assert.deepEqual(await f.client.mailboxStatus(user, 'Missing'), []);
});

test('FTS cannot be reached through generic call; invalid dedicated args perform zero HTTP', async t => {
  const f = await fixture(t);
  for (const command of Object.keys(responses)) await assert.rejects(f.client.call(command, { user }), { code: 'DOVEADM_COMMAND_NOT_ALLOWED', statusCode: 422 });
  for (const args of [[{}], [['*']], [{ userMask: ['*'] }], [undefined]]) await assert.rejects(f.client.listUsers(...args), { code: 'INVALID_INPUT' });
  for (const method of ['indexMailbox', 'mailboxStatus', 'ftsStats', 'specialUse']) {
    for (const args of [[], [user], [user, ''], [user, '  '], [user, 1], [user, ['INBOX']], [user, 'a'.repeat(1001)], ['*@example.test', 'INBOX'], ['a?@example.test', 'INBOX'], [user, 'INBOX', { queue: true }], [{ user, mailbox: 'INBOX' }]]) {
      await assert.rejects(f.client[method](...args), { code: 'INVALID_INPUT', statusCode: 422 });
    }
  }
  for (const method of ['indexMailbox', 'mailboxStatus', 'ftsStats']) for (const folder of ['*', 'Foo%Bar', 'Foo*Bar', '\\*']) await assert.rejects(f.client[method](user, folder), { code: 'INVALID_INPUT' });
  for (const command of ['quotaGet', 'mailboxList', 'search', 'aclGet']) {
    await assert.rejects(f.client.call(command, { user: '*@example.test', query: [] }), { code: 'INVALID_INPUT' });
    await assert.rejects(f.client.call(command, { user, allUsers: true, query: [] }), { code: 'INVALID_INPUT' });
  }
  assert.equal(f.requests.length, 0);
});

test('user object is validated separately; existing and other new commands still require arrays', async t => {
  const f = await fixture(t);
  for (const value of [[], null, 'users', {}, { userList: 'x' }, { userList: ['*@example.test'] }, { userList: [3] }, { userList: [user], extra: true }]) {
    f.state.value = value; await assert.rejects(f.client.listUsers(), { code: 'DOVEADM_REJECTED' });
  }
  f.state.value = { userList: [] }; assert.deepEqual(await f.client.listUsers(), []);
  for (const command of ['mailboxList', 'quotaGet', 'quotaRecalc', 'search', 'expunge', 'aclGet']) {
    await assert.rejects(f.client.call(command, { user, ...(['search', 'expunge'].includes(command) ? { query: [] } : command === 'aclGet' ? { mailbox } : {}) }), { code: 'DOVEADM_REJECTED' });
  }
  for (const method of ['mailboxStatus', 'ftsStats', 'specialUse']) await assert.rejects(f.client[method](user, mailbox), { code: 'DOVEADM_REJECTED' });
  await assert.rejects(f.client.indexMailbox(user, mailbox), { code: 'DOVEADM_INDEX_UNKNOWN' });
});

test('status and stats numeric strings reject nonintegers, negative and unsafe values', async t => {
  const f = await fixture(t);
  for (const [method, command, fields] of [['mailboxStatus', 'mailboxStatus', ['messages', 'uidvalidity']], ['ftsStats', 'ftsFlatcurveStats', ['last_uid', 'messages', 'shards', 'version']]]) {
    for (const field of fields) for (const value of ['-1', '1.2', '1e3', '1x', '', ' ', '+1', '9007199254740992', null, 2, {}, '9'.repeat(400)]) {
      f.state.value = [{ ...responses[command][0], [field]: value }];
      await assert.rejects(f.client[method](user, mailbox), { code: 'DOVEADM_REJECTED' });
    }
    f.state.value = [{ ...responses[command][0], messages: '0' }];
    assert.equal((await f.client[method](user, mailbox))[0].messages, 0);
    for (const row of [null, [], {}, { ...responses[command][0], guid: 'invalid' }, { ...responses[command][0], mailbox: 5 }]) {
      f.state.value = [row]; await assert.rejects(f.client[method](user, mailbox), { code: 'DOVEADM_REJECTED' });
    }
  }
  f.state.value = [{ ...responses.mailboxStatus[0], uidvalidity: '4294967296' }];
  await assert.rejects(f.client.mailboxStatus(user, mailbox), { code: 'DOVEADM_REJECTED' });
  f.state.value = [{ ...responses.mailboxStatus[0], uidvalidity: '4294967295', messages: '9007199254740991' }];
  assert.equal((await f.client.mailboxStatus(user, mailbox))[0].messages, Number.MAX_SAFE_INTEGER);
  for (const value of [[], [{}], [null], [{ value: 1 }], [{ value: '' }, { value: '' }]]) {
    f.state.value = value; await assert.rejects(f.client.specialUse(user, mailbox), { code: 'DOVEADM_REJECTED' });
  }
});

for (const mode of ['disconnect', 'invalidJson', 'wrongTag', 'http', 'oversize']) test(`index ${mode} after sending is unknown; reads keep ordinary failure semantics`, async t => {
  const f = await fixture(t); f.state.mode = mode;
  await assert.rejects(f.client.indexMailbox(user, mailbox), { code: 'DOVEADM_INDEX_UNKNOWN', statusCode: 503 });
  await assert.rejects(f.client.mailboxStatus(user, mailbox), error => ['DOVEADM_REJECTED', 'DOVEADM_UNAVAILABLE'].includes(error.code));
});

test('index timeout at 600 seconds means unknown; server request remains unfinished', async t => {
  const f = await fixture(t); f.state.mode = 'hang';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = once(f.events, 'request');
  let settled = false;
  const pending = f.client.indexMailbox(user, mailbox);
  const checked = assert.rejects(pending, { code: 'DOVEADM_INDEX_UNKNOWN', statusCode: 503 });
  pending.catch(() => { settled = true; });
  await seen;
  t.mock.timers.tick(599_999); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  t.mock.timers.tick(1); await checked;
  assert.equal(f.requests.length, 1);
});

test('index explicit command rejection is known, and connection refusal before sending is unavailable', async t => {
  const f = await fixture(t); f.state.type = 'error';
  for (const [value, code] of [[{ type: 'exitCode', exitCode: 67 }, 'NOT_FOUND'], [{ type: 'exitCode', exitCode: 68 }, 'DOVEADM_REJECTED'], [{ type: 'unAuthorized' }, 'DOVEADM_REJECTED']]) {
    f.state.value = value; await assert.rejects(f.client.indexMailbox(user, mailbox), { code });
  }
  for (const value of [null, [], {}, 'error', { type: '' }, { type: 'exitCode', exitCode: '67' }, { type: 'exitCode', exitCode: -1 }]) {
    f.state.value = value; await assert.rejects(f.client.indexMailbox(user, mailbox), { code: 'DOVEADM_INDEX_UNKNOWN' });
  }
  f.state.type = 'doveadmResponse'; f.state.value = [{ unexpected: true }];
  await assert.rejects(f.client.indexMailbox(user, mailbox), { code: 'DOVEADM_INDEX_UNKNOWN' });
  f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve));
  // A fresh hostname avoids reusing a stale keep-alive connection (which is unknown).
  f.config.doveadmUrl = f.config.doveadmUrl.replace('127.0.0.1', 'localhost');
  await assert.rejects(f.client.indexMailbox(user, mailbox), { code: 'DOVEADM_UNAVAILABLE' });
  await assert.rejects(createDoveadm({ config: {} }).indexMailbox(user, mailbox), { code: 'CLEANUP_DISABLED' });
});
