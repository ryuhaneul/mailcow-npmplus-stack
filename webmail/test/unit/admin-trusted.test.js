import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, rm, open, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustedHeader, trustedSender, trustedIp, trustedMemo, trustedIps, parseTrustedSenders, renderTrustedSenders, readTrustedSenders, writeTrustedSenders } from '../../server/admin/trusted-senders.js';
import { createTrustedService } from '../../server/admin/services/trusted.js';
import { createAudit } from '../../server/admin/audit.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createResourceLock } from '../../server/admin/lock.js';

const sender = 'device@example.com', initial = `${trustedHeader}\n`;
async function setup(t, rows = []) {
  const dir = await mkdtemp(join(tmpdir(), 'admin-trusted-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'trusted_senders.map'); await writeFile(path, initial);
  const audit = createAudit({ dir: join(dir, 'audit') }), lock = createResourceLock(), history = createHistoryService({ audit, lock });
  const calls = [], options = { rows };
  const mailcow = { async call(...args) { calls.push(args); if (options.fail) throw new Error('unavailable'); return options.rows; } };
  const service = createTrustedService({ config: { trustedSenderFile: path }, audit, lock, history, mailcow });
  const args = async data => ({ actor: 'admin', ip: '192.0.2.44', sender, data: { etag: (await service.list()).etag, ...data } });
  const add = async (data = {}) => service.addSender(await args({ sender, ips: ['203.0.113.8'], memo: '장비', ...data }));
  return { dir, path, service, audit, history, args, add, calls, options };
}
test('trusted inputs normalize sender and RFC5952 IPv6, reject CIDR, duplicates and request limits', () => {
  assert.equal(trustedSender('DEVICE@Example.COM'), sender);
  assert.equal(trustedIp('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  for (const value of ['203.0.113.08', '256.0.0.1', ' 203.0.113.8', '203.0.113.8 ', 'fe80::1%eth0', '']) assert.throws(() => trustedIp(value), { detail: { code: 'INVALID_IP' } });
  assert.throws(() => trustedIp('203.0.113.0/24'), { detail: { code: 'CIDR_NOT_ALLOWED' } });
  assert.throws(() => trustedIps(['2001:db8::1', '2001:0DB8::1']), { detail: { code: 'DUPLICATE_IP' } });
  assert.throws(() => trustedIps(Array.from({ length: 51 }, (_, n) => `203.0.113.${n}`)), { detail: { code: 'TOO_MANY_IPS' } });
  assert.equal(trustedIps(Array.from({ length: 50 }, (_, n) => `203.0.113.${n}`)).length, 50);
  for (const value of ['bad', '', 'a@@example.com', 'a#b@example.com', 'a|b@example.com', 'a b@example.com', 'a\t@example.com', '"a"@example.com', "a'b@example.com", 'a\x7f@example.com', `${'a'.repeat(243)}@example.com`]) assert.throws(() => trustedSender(value), { detail: { code: 'INVALID_SENDER' } });
});
test('trusted memo rejects CR LF tab controls and counts Unicode characters', () => {
  assert.equal(trustedMemo('가'.repeat(80)).length, 80);
  assert.equal(Array.from(trustedMemo('😀'.repeat(80))).length, 80);
  assert.throws(() => trustedMemo('가'.repeat(81)), { detail: { code: 'MEMO_TOO_LONG' } });
  for (const memo of ['\r', '\nother@example.net|203.0.113.99', '\t', '\0', '\x1f', '\x7f', '\x85', null]) assert.throws(() => trustedMemo(memo), { detail: { code: 'MEMO_INVALID' } });
});
test('trusted file v1 canonical serialization, sorting and empty file', () => {
  const text = renderTrustedSenders([{ sender: 'z@example.com', memo: '', ips: ['2001:0DB8::1'] }, { sender, memo: '백업', ips: ['203.0.113.9', '203.0.113.8'] }]);
  assert.equal(text, `${trustedHeader}\n#@sender ${sender} memo=백업\n${sender}|203.0.113.8\n${sender}|203.0.113.9\n#@sender z@example.com memo=\nz@example.com|2001:db8::1\n`);
  assert.equal(renderTrustedSenders(parseTrustedSenders(text).senders), text);
  assert.deepEqual(parseTrustedSenders(initial).senders, []);
});
for (const [name, text] of Object.entries({
  empty: '', header: '# wrong\n', trailing: initial + '\n', unknown: initial + '# user comment\n', orphan: initial + `${sender}|203.0.113.8\n`,
  noIp: initial + `#@sender ${sender} memo=\n`, cidr: initial + `#@sender ${sender} memo=\n${sender}|203.0.113.0/24\n`,
  uppercase: initial + '#@sender DEVICE@example.com memo=\nDEVICE@example.com|203.0.113.8\n',
  ipv6: initial + `#@sender ${sender} memo=\n${sender}|2001:0DB8::1\n`,
  whitespace: initial + `#@sender ${sender} memo=\n${sender}|203.0.113.8 value\n`,
  duplicate: initial + `#@sender ${sender} memo=\n${sender}|203.0.113.8\n${sender}|203.0.113.8\n`,
  duplicateSender: initial + `#@sender ${sender} memo=\n${sender}|203.0.113.8\n#@sender ${sender} memo=\n${sender}|203.0.113.9\n`,
  mismatched: initial + `#@sender ${sender} memo=\nother@example.com|203.0.113.8\n`,
  injection: initial + `#@sender ${sender} memo=\nother@example.net|203.0.113.99\n`,
  cr: `${trustedHeader}\r\n`,
})) test(`trusted file invalid ${name} blocks the entire file`, () => { assert.throws(() => parseTrustedSenders(text), { statusCode: 409, code: 'TRUSTED_FILE_INVALID' }); });

test('trusted atomic writer sets 0664, syncs before rename, leaves no temporary files', async t => {
  const f = await setup(t), before = await stat(f.path), events = [];
  const fs = { readFile, unlink, async open(path, flags, mode) {
    assert.match(path, /\.trusted_senders\.map\.[a-f0-9]+$/); assert.equal(flags, 'wx'); assert.equal(mode, 0o664);
    const handle = await open(path, flags, mode);
    return { chmod: async mode => { events.push('chmod'); await handle.chmod(mode); }, writeFile: async (...args) => { events.push('write'); await handle.writeFile(...args); }, sync: async () => { events.push('sync'); await handle.sync(); }, close: async () => { events.push('close'); await handle.close(); } };
  }, async rename(from, to) { events.push('rename'); assert.equal((await stat(from)).mode & 0o777, 0o664); await rename(from, to); } };
  await writeTrustedSenders(f.path, [{ sender, memo: '', ips: ['203.0.113.8'] }], (await f.service.list()).etag, fs);
  assert.deepEqual(events, ['chmod', 'write', 'sync', 'close', 'rename']);
  assert.notEqual((await stat(f.path)).ino, before.ino); assert.equal((await stat(f.path)).mode & 0o777, 0o664);
  assert.equal((await readdir(f.dir)).some(name => name.startsWith('.trusted_')), false);
});
test('trusted failed atomic writes and etag drift preserve existing file and clean temp', async t => {
  const f = await setup(t), expected = (await f.service.list()).etag;
  await assert.rejects(writeTrustedSenders(f.path, [], expected, { open, readFile, unlink, rename: async () => { throw new Error('failure'); } }), { statusCode: 502, code: 'WRITE_FAILED' });
  assert.equal(await readFile(f.path, 'utf8'), initial);
  await assert.rejects(writeTrustedSenders(f.path, [], 'stale'), { statusCode: 409, code: 'CONFLICT' });
  assert.deepEqual(await readdir(f.dir), ['trusted_senders.map']);
});
test('trusted service operations record complete snapshots, last IP removes sender and memo', async t => {
  const f = await setup(t), result = await f.add({ sender: 'DEVICE@EXAMPLE.COM' });
  assert.equal(result.result, 'ok'); assert.notEqual(result.etag, parseTrustedSenders(initial).etag);
  await f.service.addIps(await f.args({ ips: ['2001:0DB8::1'] }));
  await f.service.memo(await f.args({ memo: '' })); assert.equal((await f.service.list()).senders[0].memo, '');
  await f.service.memo(await f.args({ memo: '새 용도' }));
  await f.service.removeIp({ ...await f.args(), address: '203.0.113.8' });
  await f.service.removeIp({ ...await f.args(), address: '2001:db8::1' });
  assert.deepEqual((await f.service.list()).senders, []); assert.equal((await f.service.list()).pairs, 0);
  assert.equal(await readFile(f.path, 'utf8'), initial);
  const { rows } = await f.audit.read(), intent = rows.find(row => row.id === result.auditId && row.phase === 'intent');
  assert.deepEqual(intent.before, { version: 1, senders: [] }); assert.deepEqual(intent.after.senders, [{ sender, memo: '장비', ips: ['203.0.113.8'] }]);
  assert.equal(intent.action, 'trusted.add-sender'); assert.equal(intent.kind, 'config'); assert.equal(intent.revertible, true);
});
test('trusted service guards file corruption, injection, duplicate pairs and stale concurrent writers', async t => {
  const f = await setup(t); await f.add();
  const args = await f.args({ ips: ['203.0.113.9'] });
  const writes = await Promise.allSettled([f.service.addIps(args), f.service.addIps(args)]);
  assert.equal(writes.filter(row => row.status === 'fulfilled').length, 1); assert.equal(writes.find(row => row.status === 'rejected').reason.code, 'CONFLICT');
  await assert.rejects(f.service.addIps(await f.args({ ips: ['203.0.113.8'] })), { detail: { code: 'DUPLICATE_PAIR' } });
  const before = await readFile(f.path, 'utf8');
  await assert.rejects(f.service.memo(await f.args({ memo: '\nother@example.net|203.0.113.99' })), { detail: { code: 'MEMO_INVALID' } });
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal((await f.service.list()).senders.some(row => row.sender === 'other@example.net'), false);
  await writeFile(f.path, before + 'garbage\n');
  await assert.rejects(f.service.list(), { code: 'TRUSTED_FILE_INVALID' });
  await assert.rejects(f.service.removeSender({ ...args, data: { etag: args.data.etag } }), { code: 'TRUSTED_FILE_INVALID' });
});
test('trusted history reverts, undoes revert and returns CONFLICT on drift', async t => {
  const f = await setup(t), created = await f.add(), auth = { confirm: true, actor: 'admin', ip: '192.0.2.44', session: {} };
  const record = await f.history.detail(created.auditId); assert.match(record.summary, /신뢰 발신 장비를 바꿨어요/);
  const reverted = await f.history.revert(created.auditId, auth); assert.equal((await f.service.list()).pairs, 0);
  await f.history.revert(reverted.id, auth); assert.equal((await f.service.list()).pairs, 1);
  await f.service.memo(await f.args({ memo: 'changed' }));
  await assert.rejects(f.history.revert(created.auditId, auth), { statusCode: 409, code: 'CONFLICT' });
});
test('trusted audit intent failure prevents write', async t => {
  const f = await setup(t);
  const service = createTrustedService({ config: { trustedSenderFile: f.path }, lock: createResourceLock(), history: { register() {} }, audit: { run() { throw new Error('intent failure'); } } });
  await assert.rejects(service.addSender(await f.args({ sender, ips: ['203.0.113.8'] })), /intent failure/);
  assert.equal(await readFile(f.path, 'utf8'), initial);
});
test('trusted recent uses raw SMTP sender and IP, deduplicates message-id across times, never crosses pairs', async t => {
  const row = (id, smtp, ip, time) => ({ 'message-id': id, sender_smtp: smtp, sender_mime: 'mime@example.net', ip, unix_time: time });
  const noId = row('', sender, '203.0.113.8', 15);
  const f = await setup(t, [row('one', 'DEVICE@EXAMPLE.COM', '203.0.113.8', 10), row('one', sender, '203.0.113.8', 20), row('two', 'other@example.com', '203.0.113.8', 12), row('three', sender, '203.0.113.9', 13), row('empty', '', '203.0.113.8', 9), noId, noId]);
  const result = await f.service.recent({});
  assert.deepEqual(result.range, { from: 9, to: 20, lines: 7 }); assert.equal(result.failed, false);
  assert.deepEqual(result.counts, { [`${sender}|203.0.113.8`]: { count: 2, lastSeen: 20 }, 'other@example.com|203.0.113.8': { count: 1, lastSeen: 12 }, [`${sender}|203.0.113.9`]: { count: 1, lastSeen: 13 } });
  assert.equal(f.calls[0][2], '/api/v1/get/logs/rspamd-history/1000');
  for (const rows of [[], {}]) { f.options.rows = rows; assert.deepEqual(await f.service.recent({}), { range: null, failed: false, counts: {} }); }
  for (const rows of [null, { error: 'denied' }, [null], [{ sender_mime: sender, ip: '203.0.113.8', unix_time: 1 }], [row('x', sender, 'invalid', 1)], [row('x', sender, '203.0.113.8', 'bad')]]) { f.options.rows = rows; assert.deepEqual(await f.service.recent({}), { range: null, failed: true, counts: {} }); }
  f.options.fail = true; assert.deepEqual(await f.service.recent({}), { range: null, failed: true, counts: {} });
});
