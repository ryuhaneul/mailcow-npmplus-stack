import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedPlan, messageId, missingMessages, messageBytes, syntheticMessage } from '../int/seed/plan.mjs';
import { adminTasks, passwordFromEnvironment, seedMailbox, seedSieve } from '../int/seed/run.mjs';

const plan = seedPlan({ domain: 'mail.example.com', prefix: 'int-' });
test('M02 roles cover all eight users and both team mailboxes', () => {
  assert.equal(plan.users.length, 8);
  assert.equal(plan.users[0].messages, 20000);
  assert.equal(plan.users[0].quotaRatio, 0.8);
  assert.equal(new Set(plan.users[0].folders).size, 12);
  assert.ok(plan.users[0].folders.every(folder => /[가-힣]/u.test(folder)));
  assert.deepEqual(plan.users[1].senderAcl, ['int-team-sales@mail.example.com', 'int-team-support@mail.example.com', '@mail.example.com']);
  assert.equal(plan.users[2].aliases.length, 2);
  assert.deepEqual(plan.users[3].share, { owner: plan.users[0].email, folder: 'INBOX', rights: 'lr' });
  assert.equal(plan.users[4].twoFactor, true);
  assert.deepEqual(plan.users.slice(5).map(user => user.sieve.name), ['seed-gmail2sieve', 'rainloop.user', 'seed-unknown']);
  assert.equal(plan.teams.length, 2);
  const admin = adminTasks(plan);
  assert.equal(admin.requests.length, 3);
  assert.deepEqual(admin.requests[0].body, { items: [plan.users[1].email], attr: { sender_acl: plan.users[1].senderAcl } });
  assert.deepEqual(admin.requests.slice(1).map(request => request.body), plan.users[2].aliases.map(address => ({
    address, goto: plan.users[2].email, active: '1', sogo_visible: '1', sender_allowed: '1',
  })));
  assert.deepEqual(admin.manual[0].desired, plan.users[3].share);
  assert.ok(admin.requests.every(request => request.check && request.policy));
  assert.ok(admin.manual.every(item => item.desired && item.check && item.skip));
});

test('seed plan rejects address injection and invalid prefixes', () => {
  for (const domain of ['x@y.example', 'a..example', 'a.example/extra']) assert.throws(() => seedPlan({ domain }));
  assert.throws(() => seedPlan({ domain: 'example.com', prefix: 'x;bad' }));
});
test('deterministic Message-IDs make resumed runs fill only missing entries', () => {
  const email = plan.users[0].email;
  assert.deepEqual(missingMessages(email, [messageId(email, 1), messageId(email, 3)], 3), [2]);
  assert.deepEqual(missingMessages(email, Array.from({ length: 20000 }, (_, n) => messageId(email, n + 1))), []);
  assert.equal(missingMessages(email, ['<unrelated@example.com>']).length, 20000);
  const message = syntheticMessage(email, 2, 2048);
  assert.equal(message.length, 2048);
  assert.ok(message.includes(Buffer.from(messageId(email, 2))));
  assert.ok(message.includes(Buffer.from('견적')));
  assert.equal(messageBytes({ usedBytes: 1000, limitBytes: 100000, missingCount: 20 }), 3950);
  assert.throws(() => messageBytes({ usedBytes: 0, limitBytes: 0, missingCount: 1 }));
});

function mailbox(existing = []) {
  const state = { ids: [...existing], created: [], appended: 0, released: 0, used: 0 };
  return { state,
    list: async () => ['시험폴더01', ...state.created].map(path => ({ path })), mailboxCreate: async folder => state.created.push(folder),
    getMailboxLock: async () => ({ release: () => state.released++ }),
    search: async () => state.ids.map((_, n) => n + 1), fetchAll: async () => state.ids.map(id => ({ envelope: { messageId: id } })),
    getQuota: async () => ({ storage: { usage: state.used, limit: 100000 } }),
    append: async (folder, message) => { state.appended++; state.used += message.length; state.ids.push(/Message-ID: (.+)\r\n/.exec(message.toString())[1]); return { uid: state.ids.length }; },
  };
}
test('seedMailbox creates only missing folders and APPENDs only missing messages across two runs', async () => {
  const user = { ...plan.users[0], messages: 3 };
  const client = mailbox([messageId(user.email, 1)]);
  await seedMailbox(client, user, () => {});
  assert.equal(client.state.appended, 2);
  assert.equal(client.state.created.length, 11);
  await seedMailbox(client, user, () => {});
  assert.equal(client.state.appended, 2);
  assert.equal(client.state.created.length, 11);
  assert.equal(client.state.released, 2);
});
test('quota stop reports usage, limit and existing seed count without APPEND', async () => {
  const client = mailbox(); client.state.used = 81000; const logs = [];
  await seedMailbox(client, { ...plan.users[0], messages: 3 }, value => logs.push(JSON.parse(value)));
  assert.equal(client.state.appended, 0);
  assert.equal(logs[0].usedBytes, 81000); assert.equal(logs[0].limitBytes, 100000); assert.equal(logs[0].seedCount, 0);
});
test('Sieve is idempotent and never overwrites conflicting scripts or other active filters', async () => {
  const source = 'keep;'; const user = plan.users[5]; let writes = 0; let active = false;
  const client = { listScripts: async () => [{ name: user.sieve.name, active }], getScript: async () => source, setActive: async () => { active = true; }, putScript: async () => writes++ };
  assert.equal(await seedSieve(client, user, source), 'activated');
  assert.equal(await seedSieve(client, user, source), 'skipped'); assert.equal(writes, 0);
  await assert.rejects(seedSieve(client, user, 'discard;'), /내용이 다릅니다/);
  client.listScripts = async () => [{ name: 'unrelated', active: true }];
  await assert.rejects(seedSieve(client, user, source), /다른 활성/);
});
test('password is accepted only through environment or a mode-600 file', async () => {
  assert.equal(await passwordFromEnvironment({ WEBMAIL_SEED_PASSWORD: 'synthetic-password' }), 'synthetic-password');
  const dir = await mkdtemp(join(tmpdir(), 'webmail-seed-test-')); const path = join(dir, 'password');
  try {
    await writeFile(path, 'synthetic-password\n', { mode: 0o600 });
    assert.equal(await passwordFromEnvironment({ WEBMAIL_SEED_PASSWORD_FILE: path }), 'synthetic-password');
    await chmod(path, 0o644); await assert.rejects(passwordFromEnvironment({ WEBMAIL_SEED_PASSWORD_FILE: path }), /600/);
    await assert.rejects(passwordFromEnvironment({}));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
