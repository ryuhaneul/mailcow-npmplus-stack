import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import nodemailer from 'nodemailer';
import libmime from 'libmime';
import { AppError, installErrors } from '../../server/errors.js';
import { createResourceLock, etag } from '../../server/admin/lock.js';
import { createAudit } from '../../server/admin/audit.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { installAdminGuard } from '../../server/admin/guard.js';
import notificationRoutes from '../../server/admin/routes/quota-notifications.js';
import { createQuotaNotificationStore, defaultQuotaNotifications, validateQuotaNotifications, emptyQuotaNotificationState } from '../../server/admin/quota-notification-state.js';
import { createQuotaNotificationMailer, quotaNotificationMessage } from '../../server/admin/quota-notification-mail.js';
import { createQuotaNotificationsService, quotaNotificationTargets } from '../../server/admin/services/quota-notifications.js';
import { createQuotaNotificationScheduler } from '../../server/admin/quota-notification-scheduler.js';
const GB = 1024 ** 3, sender = 'notice@example.com', address = 'person@example.com';
const settings = { enabled: true, sender, threshold: 90, intervalMinutes: 60 };
const mailbox = (percent = 90, extra = {}) => ({ username: address, quota: 10 * GB, quota_used: percent / 100 * 10 * GB, active: 1, ...extra });
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'quota-notifications-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = Date.UTC(2026, 9, 23), fail = null;
  const store = createQuotaNotificationStore({ dir: join(dir, 'notifications') }), lock = createResourceLock(), audit = createAudit({ dir: join(dir, 'audit'), now: () => time });
  const history = createHistoryService({ audit, lock }), config = { mailcowApiKey: 'synthetic', smtpHost: 'postfix.example.com', mailTlsMode: 'verify', mailTlsServername: 'mail.example.com' };
  const rows = [mailbox()], sent = [], calls = [];
  const mailcow = { createApiContext: value => { assert.deepEqual(value, { permission: 'read' }); return {}; }, async call(...args) { calls.push(args); if (args[2].endsWith('/domain/all')) return [{ domain_name: 'example.com' }]; if (fail === 'collection') throw new Error('synthetic private error'); return structuredClone(rows); } };
  const send = async (from, row) => { assert.ok((await store.readState()).accounts[row.username].pendingAt); if (fail) throw fail; sent.push({ from, to: row.username }); };
  const service = (overrides = {}) => createQuotaNotificationsService({ store, mailcow, config, audit, lock, history, send, now: () => time, ...overrides });
  await store.saveSettings(settings);
  return { dir, store, audit, history, config, rows, sent, calls, service, now: () => time, advance: ms => { time += ms; }, fail: value => { fail = value; } };
}
test('quota notifications: 89.9/90/100 boundaries, unlimited and inactive exclusions', () => {
  const rows = [mailbox(89.9, { username: 'below@example.com' }), mailbox(90), mailbox(100, { username: 'full@example.com' }), mailbox(100, { username: 'unlimited@example.com', quota: 0 }), mailbox(100, { username: 'off@example.com', active: 0 }), mailbox(100, { username: 'receiving@example.com', active: 2 })];
  assert.deepEqual(quotaNotificationTargets(rows, settings, {}, Date.now()).map(row => row.username), ['full@example.com', address]);
  assert.equal(quotaNotificationTargets(rows, { ...settings, sender: '' }, {}, Date.now()).length, 0);
  assert.equal(quotaNotificationTargets(rows, { ...settings, enabled: false }, {}, Date.now()).length, 0);
  assert.equal(quotaNotificationTargets([mailbox(100, { username: 'person@example.com\r\nBcc: victim@example.com' })], settings, {}, Date.now()).length, 0);
});
test('quota notifications: threshold dips preserve last actual send, exact interval permits next send and restart deduplicates', async t => {
  const f = await fixture(t); await f.service().runOnce(); const first = (await f.store.readState()).accounts[address].lastSentAt;
  f.advance(30 * 60_000); f.rows[0] = mailbox(89.9); await f.service().runOnce();
  assert.equal((await f.store.readState()).accounts[address].lastSentAt, first);
  f.advance(29 * 60_000); f.rows[0] = mailbox(90); await f.service().runOnce(); assert.equal(f.sent.length, 1);
  f.advance(60_000); await f.service().runOnce(); assert.equal(f.sent.length, 2);
  await f.service().runOnce(); assert.equal(f.sent.length, 2);
  assert.ok(f.calls.some(call => call[2] === '/api/v1/get/mailbox/all'));
});
test('quota notifications: explicit send rejection is not a send timestamp and retries on next check', async t => {
  const f = await fixture(t); f.fail(Object.assign(new Error('synthetic secret'), { explicit: true, code: 'SMTP_REJECTED' }));
  await f.service().runOnce(); const row = (await f.store.readState()).accounts[address];
  assert.equal(row.lastSentAt, null); assert.equal(row.pendingAt, null); assert.equal(row.lastFailure.code, 'SMTP_REJECTED');
  f.advance(300_000); f.fail(null); await f.service().runOnce(); assert.equal(f.sent.length, 1); assert.equal((await f.store.readState()).accounts[address].lastFailure, null);
  const records = (await f.history.list()).items; assert.ok(records.some(row => row.summary.includes('쿼터 알림 발송 0건/실패 1건'))); assert.ok(records.some(row => row.summary.includes('쿼터 알림 발송 1건/실패 0건')));
  assert.ok(!JSON.stringify(await f.audit.read()).includes('synthetic secret'));
});
test('quota notifications: interrupted pending and ambiguous SMTP outcomes use attempt timestamp without immediate replay', async t => {
  const f = await fixture(t), state = emptyQuotaNotificationState(), attempted = new Date(f.now()).toISOString();
  state.accounts[address] = { lastSentAt: null, pendingAt: attempted, lastFailure: null }; await f.store.saveState(state);
  f.advance(300_000); await f.service().runOnce(); assert.equal(f.sent.length, 0);
  let row = (await f.store.readState()).accounts[address]; assert.equal(row.lastSentAt, attempted); assert.equal(row.lastFailure.code, 'UNCONFIRMED');
  f.advance(55 * 60_000); f.fail(new Error('response lost')); await f.service().runOnce(); row = (await f.store.readState()).accounts[address];
  assert.equal(row.lastSentAt, new Date(f.now()).toISOString()); assert.equal(row.lastFailure.code, 'UNCONFIRMED');
  f.fail(null); f.advance(300_000); await f.service().runOnce(); assert.equal(f.sent.length, 0);
  f.advance(55 * 60_000); await f.service().runOnce(); assert.equal(f.sent.length, 1);
});
test('quota notifications: no sender/disabled never collects or sends; collection failure is safe and visible', async t => {
  const f = await fixture(t);
  for (const value of [{ ...settings, sender: '' }, { ...settings, enabled: false }]) { await f.store.saveSettings(value); await f.service().runOnce(); }
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  await f.store.saveSettings(settings); f.fail('collection'); await f.service().runOnce();
  assert.equal((await f.store.readState()).lastRunFailure.code, 'COLLECTION_FAILED'); assert.equal(f.sent.length, 0);
});
test('quota notifications: cap of 200 defers overflow fairly even when previous attempts failed', async t => {
  const f = await fixture(t); f.rows.splice(0, 1, ...Array.from({ length: 205 }, (_, i) => mailbox(95, { username: `user${String(i).padStart(3, '0')}@example.com` })));
  f.fail(Object.assign(new Error(), { explicit: true, code: 'SEND_FAILED' })); await f.service().runOnce();
  assert.equal(Object.keys((await f.store.readState()).accounts).length, 200);
  f.advance(300_000); f.fail(null); await f.service().runOnce(); assert.equal(f.sent.length, 200);
  assert.equal(f.sent[0].to, 'user200@example.com'); assert.ok(f.sent.some(row => row.to === 'user204@example.com'));
});
test('quota notifications: shutdown prevents starting a recipient', async t => {
  const f = await fixture(t); assert.equal((await f.service().runOnce({ stopped: () => true })).sent, 0); assert.equal(f.sent.length, 0);
});
test('quota notifications: interval starts at SMTP completion rather than collection start', async t => {
  const f = await fixture(t); let count = 0;
  const service = f.service({ send: async () => { count++; f.advance(60_000); } });
  const started = f.now(); await service.runOnce();
  assert.equal((await f.store.readState()).accounts[address].lastSentAt, new Date(started + 60_000).toISOString());
  f.advance(59 * 60_000); await service.runOnce(); assert.equal(count, 1);
  f.advance(60_000); await service.runOnce(); assert.equal(count, 2);
});
test('quota notifications: disabling settings mid-run stops before the next account', async t => {
  const f = await fixture(t); f.rows.push(mailbox(95, { username: 'second@example.com' })); let count = 0;
  await f.service({ send: async () => { count++; await f.store.saveSettings({ ...settings, enabled: false }); } }).runOnce();
  assert.equal(count, 1); assert.equal(Object.keys((await f.store.readState()).accounts).length, 1);
});
for (const patch of [{ sender: 'bad' }, { sender: 'a@example.com\r\nBcc:x@example.com' }, { sender: 'a@-bad.com' }, { sender: 'a@example..com' }, { threshold: 49 }, { threshold: 100 }, { threshold: 90.5 }, { intervalMinutes: 14 }, { intervalMinutes: 1441 }, { enabled: 1 }, { surprise: true }]) test(`quota notification settings reject ${JSON.stringify(patch)}`, () => assert.throws(() => validateQuotaNotifications({ ...settings, ...patch }), { statusCode: 422 }));
test('quota notifications: settings save validates etag, audits changes and warns for unmanaged domains', async t => {
  const f = await fixture(t), service = f.service(); let before = await service.view({});
  await service.save({ session: {}, actor: 'synthetic admin', ip: '192.0.2.1', data: { ...settings, sender: 'notice@other.example.com', etag: before.etag } });
  before = await service.view({}); assert.ok(before.warnings.some(text => text.includes('管理') || text.includes('관리 도메인')));
  await assert.rejects(service.save({ session: {}, data: { ...settings, etag: 'stale' } }), { statusCode: 409 });
  assert.ok((await f.history.list()).items.some(row => row.action === 'quota.notifications.settings'));
  await f.store.saveSettings({ ...settings, sender: '' }); assert.equal((await service.view({})).effectiveEnabled, false);
});
test('quota notification store: defaults, 0600 files, atomic replacement and corrupt state fail closed', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'quota-store-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createQuotaNotificationStore({ dir }); assert.deepEqual(await store.readSettings(), defaultQuotaNotifications);
  await store.saveSettings(settings); await store.saveState(emptyQuotaNotificationState());
  for (const name of ['settings','state']) assert.equal((await fs.stat(join(dir, `${name}.json`))).mode & 0o777, 0o600);
  const broken = createQuotaNotificationStore({ dir, fs: { ...fs, rename: async () => { throw new Error('disk failure'); } } });
  await assert.rejects(broken.saveSettings({ ...settings, threshold: 95 }), { code: 'QUOTA_NOTIFICATION_STORE_UNAVAILABLE' }); assert.deepEqual(await store.readSettings(), settings);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['settings.json','state.json']);
  await fs.writeFile(join(dir, 'state.json'), '{'); await assert.rejects(store.readState(), { code: 'QUOTA_NOTIFICATION_STORE_UNAVAILABLE' });
});
test('quota notification store: persistence failure after SMTP acceptance retains pending and restart suppresses duplicates', async t => {
  const f = await fixture(t), native = f.store.saveState; let writes = 0;
  f.store.saveState = async state => { if (++writes === 2) throw new Error('disk unavailable'); return native(state); };
  await assert.rejects(f.service().runOnce()); assert.equal(f.sent.length, 1);
  f.store.saveState = native; await f.service().runOnce(); assert.equal(f.sent.length, 1); assert.equal((await f.store.readState()).accounts[address].lastFailure.code, 'UNCONFIRMED');
});
test('quota scheduler: first check is 5 minutes later, no replay/overlap, stop waits for in-flight work', async () => {
  let callback, release, calls = 0, cancelled = 0;
  const scheduler = createQuotaNotificationScheduler({ service: { runOnce: async () => { calls++; await new Promise(resolve => { release = resolve; }); } }, setInterval: (fn, ms) => { assert.equal(ms, 300_000); callback = fn; return 7; }, clearInterval: value => { assert.equal(value, 7); cancelled++; } });
  scheduler.start(); scheduler.start(); assert.equal(calls, 0); callback(); callback(); assert.equal(calls, 1);
  const stopping = scheduler.stop(); assert.equal(cancelled, 1); release(); await stopping; await scheduler.tick(); assert.equal(calls, 1);
});
test('quota notification MIME: encoded Korean subject, own recipient only and safe headers', async () => {
  const message = quotaNotificationMessage(sender, mailbox(90, { name: 'OTHER ACCOUNT SECRET', sender_acl: ['other@example.com'] }));
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const result = await transport.sendMail(message), raw = result.message.toString();
  assert.match(raw, /^From: notice@example.com$/m); assert.match(raw, /^To: person@example.com$/m);
  const subject = raw.match(/^Subject: ([\s\S]*?)(?=\n[^ \t])/m)[1].replace(/\r?\n[ \t]+/g, ' ');
  assert.equal(libmime.decodeWords(subject.trim()), '[메일함 용량 경고] 사용률 90.0%');
  assert.match(message.text, /휴지통/); assert.match(message.text, /큰 첨부/); assert.match(message.text, /관리자/); assert.match(message.text, /답장하지/); assert.ok(!JSON.stringify(message).includes('OTHER ACCOUNT SECRET')); assert.ok(!JSON.stringify(message).includes('other@example.com'));
  for (const value of ['bad\r\nBcc: victim@example.com', 'bad@example.com\nX-Test: injected']) { assert.throws(() => quotaNotificationMessage(value, mailbox()), { statusCode: 422 }); assert.throws(() => quotaNotificationMessage(sender, mailbox(90, { username: value })), { statusCode: 422 }); }
});
test('quota notification SMTP: port 25 STARTTLS with shared TLS checks, no AUTH, explicit and ambiguous error classification', async () => {
  const config = { smtpHost: 'postfix.example.com', mailTlsMode: 'verify', mailTlsServername: 'mail.example.com' }; let options, closed = 0, error;
  const send = createQuotaNotificationMailer({ config, transportFactory: value => { options = value; return { sendMail: async () => { if (error) throw error; return { accepted: [address], rejected: [] }; }, close: () => { closed++; } }; } });
  await send(sender, mailbox()); assert.equal(options.port, 25); assert.equal(options.requireTLS, true); assert.equal(options.auth, undefined); assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.tls.servername, config.mailTlsServername);
  for (const [failure, explicit] of [[{ responseCode: 554 },true],[{ command: 'CONN' },true],[{ command: 'DATA' },false]]) { error = failure; await assert.rejects(send(sender, mailbox()), value => value.explicit === explicit && !value.message.includes('undefined')); }
  assert.equal(closed, 4);
});
for (const permission of ['read','full']) test(`quota notification HTTP: ${permission} key permissions and settings round trip`, async t => {
  const f = await fixture(t), app = Fastify(); t.after(() => app.close()); installErrors(app); await app.register(cookie);
  installAdminGuard(app, { config: { adminHostname: 'admin.example.com', mailcowApiKey: 'synthetic' }, sessions: { get: async () => { throw new AppError(403, 'NO_SESSION', '로그인 필요'); } }, client: { createApiContext: () => ({}), call: async () => ({ version: 'synthetic' }) }, apiKeys: { authenticate: async () => ({ ok: true, item: { id: 'synthetic', name: 'quota', permission } }), recordUse: async () => {} } });
  await app.register(notificationRoutes, { service: f.service() }); const headers = { 'x-mailadmin-api-key': `mak_v1_${'A'.repeat(43)}` };
  const response = await app.inject({ url: '/api/admin/quota/notifications', headers }); assert.equal(response.statusCode, 200);
  const write = await app.inject({ url: '/api/admin/quota/notifications', method: 'PUT', headers, payload: { ...settings, threshold: 95, etag: response.json().etag } });
  assert.equal(write.statusCode, permission === 'full' ? 200 : 403, write.body); assert.equal(write.headers['www-authenticate'], undefined); assert.equal((await f.store.readSettings()).threshold, permission === 'full' ? 95 : 90);
  assert.equal((await app.inject('/api/admin/quota/notifications')).statusCode, 403);
});
