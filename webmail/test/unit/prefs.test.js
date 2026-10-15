import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { createPrefsService, MAX_PREFS_BYTES, PREFS_ENTRY } from '../../server/prefs.js';
import { sanitizeComposeHtml } from '../../server/mail/sanitize.js';

const config = {
  publicHostnames: ['newmail.example.com'], trustProxy: ['127.0.0.0/8'], logLevel: 'silent', sessionIdleMin: 480, sessionMaxHours: 24,
  imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com',
  defaultTheme: 'olive', defaultMode: 'dark',
};
const defaults = () => ({ theme: 'olive', mode: 'dark', accent: {}, layout: null, folderColors: {}, imageAllow: [], signatures: {}, defaultFrom: null });
class PrefsImap extends EventEmitter {
  constructor(options) { super(); this.options = options; this.enabled = new Set(); this.capabilities = new Map(); this.usable = false; this.value = null; this.calls = []; }
  async connect() { this.usable = true; }
  close() { this.usable = false; }
  async logout() { this.close(); }
  async getMailboxLock(path) { assert.equal(path, 'INBOX'); return { release() {} }; }
  async exec(command, args, options) {
    this.calls.push({ command, args });
    if (this.fail) throw new Error('synthetic-private-value');
    assert.deepEqual(args[0], { type: 'STRING', value: '' });
    if (command === 'GETMETADATA') {
      assert.deepEqual(args[1], { type: 'STRING', value: PREFS_ENTRY });
      options.untagged.METADATA({ attributes: [args[0], [{ value: PREFS_ENTRY }, { value: this.value === null ? null : Buffer.from(this.value) }]] });
    } else {
      assert.equal(command, 'SETMETADATA');
      assert.deepEqual(args[1][0], { type: 'STRING', value: PREFS_ENTRY });
      assert.equal(args[1][1].type, 'LITERAL');
      assert.ok(Buffer.isBuffer(args[1][1].value));
      this.value = args[1][1].value.toString('utf8');
    }
    return { next() {} };
  }
}
async function fixture(t) {
  let client;
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-prefs-test-'));
  const app = await createApp({ config, logger: false, auth: { tempRoot, clientFactory: options => (client = new PrefsImap(options)) } });
  t.after(async () => { await app.close(); await rm(tempRoot, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://newmail.example.com' }, payload: { email: 'user@example.com', password: 'synthetic-password' } });
  assert.equal(login.statusCode, 200);
  const token = login.cookies[0].value;
  const headers = { cookie: `webmail_sid=${token}`, origin: 'https://newmail.example.com', 'x-webmail-csrf': login.json().csrf };
  const request = (method, payload) => app.inject({ method, url: '/api/prefs', headers, payload });
  return { app, client, headers, request, session: await app.sessions.get(token) };
}
function status(response, expected) { assert.equal(response.statusCode, expected, response.body); assert.equal(response.headers['www-authenticate'], undefined); }

test('prefs: config defaults, missing METADATA and session cache; health smoke', async t => {
  const f = await fixture(t);
  status(await f.app.inject('/healthz'), 200);
  const response = await f.request('GET'); status(response, 200);
  assert.deepEqual(response.json(), defaults()); assert.deepEqual(f.session.prefs, defaults());
  assert.equal(response.headers['cache-control'], 'no-store');
});
test('prefs: full document METADATA round trip, address normalization and session update', async t => {
  const f = await fixture(t);
  const doc = { ...defaults(), theme: 'terra', mode: 'system', accent: { ink: 0, olive: 6, terra: '#abC123' }, layout: { pane: 'right', density: 'compact', compose: 'drawer' }, folderColors: { 'Projects/견적': 7 }, imageAllow: [' Sender@EXAMPLE.COM ', 'sender@example.com'], signatures: { ' USER@EXAMPLE.COM ': { html: '<script>raw signature</script>', auto: true } }, defaultFrom: ' Alias@EXAMPLE.COM ' };
  status(await f.request('PUT', doc), 204);
  const expected = { ...doc, imageAllow: ['sender@example.com'], signatures: { 'user@example.com': { html: '', auto: true } }, defaultFrom: 'alias@example.com' };
  assert.deepEqual(JSON.parse(f.client.value), expected); assert.deepEqual(f.session.prefs, expected);
  status(await f.request('GET'), 200); assert.deepEqual(f.session.prefs, expected);
  assert.deepEqual(f.client.calls.map(call => call.command), ['SETMETADATA', 'GETMETADATA']);
});
test('prefs: signature scripts, event handlers and javascript links are sanitized before storage', async t => {
  const f = await fixture(t);
  const html = '<script>alert(1)</script><img src="https://images.example.com/logo.png" onerror="alert(2)"><a href="javascript:alert(3)">Contact</a>';
  status(await f.request('PUT', { ...defaults(), signatures: { 'user@example.com': { html, auto: true } } }), 204);
  const saved = JSON.parse(f.client.value).signatures['user@example.com'];
  assert.equal(saved.html, sanitizeComposeHtml(html, { publicHostnames: config.publicHostnames }));
  assert.doesNotMatch(saved.html, /script|onerror|javascript:/i);
  assert.equal(saved.auto, true);
  assert.deepEqual(f.session.prefs.signatures['user@example.com'], saved);
  const response = await f.request('GET'); status(response, 200);
  assert.deepEqual(response.json().signatures['user@example.com'], saved);
});
test('prefs: signature business card formatting and image host policy match sending', async t => {
  const f = await fixture(t);
  const html = '<table cellpadding="4"><tr><td style="color:#123456;font-weight:bold">Example Team<br><a href="mailto:user@example.com">user@example.com</a></td><td><img src="https://images.example.com/card.png" width="80" alt="Card"><img src="https://newmail.example.com/api/messages/private/parts/1"></td></tr></table>';
  status(await f.request('PUT', { ...defaults(), signatures: { 'user@example.com': { html, auto: false } } }), 204);
  const saved = JSON.parse(f.client.value).signatures['user@example.com'].html;
  assert.equal(saved, sanitizeComposeHtml(html, { publicHostnames: config.publicHostnames }));
  assert.match(saved, /<table cellpadding="4">/);
  assert.match(saved, /style="color:.*font-weight: bold;/);
  assert.match(saved, /mailto:user@example.com/);
  assert.match(saved, /src="https:\/\/images\.example\.com\/card\.png"/);
  assert.doesNotMatch(saved, /newmail\.example\.com|\/api\//);
  assert.equal(f.session.prefs.signatures['user@example.com'].html, saved);
});
for (const [label, patch] of [
  ['theme', { theme: 'unknown' }], ['mode', { mode: 'auto' }], ['unknown top-level', { extra: true }],
  ['accent unknown theme', { accent: { other: 0 } }], ['accent below range', { accent: { ink: -1 } }], ['accent above range', { accent: { ink: 7 } }], ['accent fraction', { accent: { ink: 1.5 } }], ['accent hex', { accent: { ink: '#fff' } }],
  ['layout pane', { layout: { pane: 'left', density: 'normal', compose: 'float' } }], ['layout missing', { layout: { pane: 'none' } }], ['layout unknown', { layout: { pane: 'none', density: 'normal', compose: 'full', extra: 1 } }], ['layout density', { layout: { pane: 'none', density: 'wide', compose: 'full' } }], ['layout compose', { layout: { pane: 'none', density: 'normal', compose: 'other' } }],
  ['folder color', { folderColors: { INBOX: 8 } }], ['folder fraction', { folderColors: { INBOX: 0.5 } }], ['folder empty path', { folderColors: { '': 0 } }],
  ['image domain', { imageAllow: ['example.com'] }], ['image address', { imageAllow: ['x@@example.com'] }], ['image count', { imageAllow: Array.from({ length: 501 }, (_, i) => `u${i}@example.com`) }],
  ['signature address', { signatures: { invalid: { html: '', auto: false } } }], ['signature html', { signatures: { 'user@example.com': { html: 1, auto: true } } }], ['signature auto', { signatures: { 'user@example.com': { html: '', auto: 'true' } } }], ['signature extra', { signatures: { 'user@example.com': { html: '', auto: true, extra: 0 } } }],
  ['defaultFrom', { defaultFrom: '@example.com' }],
]) test(`prefs: rejects invalid ${label} without saving`, async t => {
  const f = await fixture(t); status(await f.request('PUT', { ...defaults(), ...patch }), 422); assert.equal(f.client.calls.length, 0); assert.equal(f.session.prefs, undefined);
});
test('prefs: every top-level field required, objects only and malformed JSON 422', async t => {
  const f = await fixture(t);
  for (const key of Object.keys(defaults())) { const doc = defaults(); delete doc[key]; status(await f.request('PUT', doc), 422); }
  for (const body of ['[]', 'null', '{broken', '']) status(await f.app.inject({ method: 'PUT', url: '/api/prefs', headers: { ...f.headers, 'content-type': 'application/json' }, payload: body }), 422);
  assert.equal(f.client.calls.length, 0);
});
test('prefs: 64KB UTF-8 boundary accepted; larger body rejected without changing session or METADATA', async t => {
  const f = await fixture(t);
  const doc = { ...defaults(), signatures: { 'user@example.com': { html: '', auto: false } } };
  const room = MAX_PREFS_BYTES - Buffer.byteLength(JSON.stringify(doc));
  doc.signatures['user@example.com'].html = '가'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3);
  assert.equal(Buffer.byteLength(JSON.stringify(doc)), MAX_PREFS_BYTES);
  status(await f.request('PUT', doc), 204);
  const before = f.client.value;
  doc.signatures['user@example.com'].html += 'x'; status(await f.request('PUT', doc), 413);
  assert.equal(f.client.value, before); assert.deepEqual(f.session.prefs, JSON.parse(before));
});
test('prefs: authentication, CSRF and origin failures are 403 without METADATA', async t => {
  const f = await fixture(t);
  status(await f.app.inject('/api/prefs'), 403);
  status(await f.app.inject({ method: 'PUT', url: '/api/prefs', headers: { ...f.headers, 'x-webmail-csrf': 'wrong' }, payload: defaults() }), 403);
  status(await f.app.inject({ method: 'PUT', url: '/api/prefs', headers: { ...f.headers, origin: 'https://other.example.com' }, payload: defaults() }), 403);
  assert.equal(f.client.calls.length, 0);
});
test('prefs: tolerant GET discards invalid fields, retains valid fields and never logs values', async t => {
  const f = await fixture(t);
  f.client.value = JSON.stringify({ theme: 'amber', mode: 'bad', accent: { ink: 7 }, imageAllow: [' SENDER@EXAMPLE.COM '], unknown: 'synthetic-private-value' });
  const response = await f.request('GET'); status(response, 200);
  assert.deepEqual(response.json(), { ...defaults(), theme: 'amber', imageAllow: ['sender@example.com'] });
  for (const raw of ['{broken', 'null', '[]', 'x'.repeat(MAX_PREFS_BYTES + 1)]) { f.client.value = raw; status(await f.request('GET'), 200); assert.deepEqual(f.session.prefs, defaults()); }
  const warnings = [], service = createPrefsService({ config, logger: { warn(...args) { warnings.push(args); } }, imap: { async withMailbox(_session, _path, run) { return run(f.client); } } });
  f.client.value = JSON.stringify({ unknown: 'synthetic-private-value' }); await service.get({});
  assert.equal(warnings.length, 1); assert.ok(!JSON.stringify(warnings).includes('synthetic-private-value')); assert.ok(!JSON.stringify(warnings).includes('unknown'));
});
test('prefs: server failure is 503, cached preferences unchanged', async t => {
  const f = await fixture(t); await f.request('GET'); const before = f.session.prefs; f.client.fail = true;
  for (const method of ['GET', 'PUT']) { const response = await f.request(method, method === 'PUT' ? defaults() : undefined); status(response, 503); assert.ok(!response.body.includes('synthetic-private-value')); assert.strictEqual(f.session.prefs, before); }
});
