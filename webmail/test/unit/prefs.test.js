import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { createPrefsService, MAX_PREFS_BYTES, PREFS_ENTRY } from '../../server/prefs.js';
import { SIGNATURES_ENTRY } from '../../server/signatures.js';
import { SIGNATURE_IMAGES_ENTRY } from '../../server/signature-images.js';
import { withSignatureStoreLock } from '../../server/signature-store-lock.js';
import { sanitizeComposeHtml } from '../../server/mail/sanitize.js';

const config = {
  publicHostnames: ['newmail.example.com'], trustProxy: ['127.0.0.0/8'], logLevel: 'silent', sessionIdleMin: 480, sessionMaxHours: 24,
  imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com',
  defaultTheme: 'olive', defaultMode: 'dark',
};
const defaults = () => ({ theme: 'olive', mode: 'dark', accent: {}, layout: null, folderColors: {}, pinnedFolders: [], pinPosition: 'mine', sharedView: {}, imageAllow: [], signatures: {}, fromNames: {}, defaultFrom: null });
class PrefsImap extends EventEmitter {
  constructor(options) { super(); this.options = options; this.enabled = new Set(); this.capabilities = new Map(); this.usable = false; this.value = null; this.metadata = new Map(); this.calls = []; }
  async connect() { this.usable = true; }
  close() { this.usable = false; }
  async logout() { this.close(); }
  async getMailboxLock(path) { assert.equal(path, 'INBOX'); return { release() {} }; }
  async exec(command, args, options) {
    this.calls.push({ command, args });
    if (this.fail) throw new Error('synthetic-private-value');
    if (command === 'GETMETADATA') {
      const key = args.at(-1).value;
      assert.deepEqual(args.at(-2), { type: 'STRING', value: '' });
      if (args.length === 3) assert.deepEqual(args[0], [{ type: 'ATOM', value: 'MAXSIZE' }, { type: 'ATOM', value: String(key === PREFS_ENTRY ? MAX_PREFS_BYTES : 262144) }]);
      assert.ok([PREFS_ENTRY, SIGNATURES_ENTRY].includes(key));
      const value = key === PREFS_ENTRY ? this.value : this.metadata.get(key) ?? null;
      options.untagged.METADATA({ attributes: [{ value: '' }, [{ value: key }, { value: value === null ? null : Buffer.from(value) }]] });
    } else {
      assert.equal(command, 'SETMETADATA');
      assert.deepEqual(args[0], { type: 'STRING', value: '' });
      await this.beforeSet?.(args);
      for (let i = 0; i < args[1].length; i += 2) {
        const key = args[1][i].value;
        assert.ok([PREFS_ENTRY, SIGNATURES_ENTRY].includes(key));
        assert.equal(args[1][i + 1].type, 'LITERAL');
        assert.ok(Buffer.isBuffer(args[1][i + 1].value));
        const value = args[1][i + 1].value.toString('utf8');
        if (key === PREFS_ENTRY) this.value = value;
        else this.metadata.set(key, value);
      }
    }
    return { next() {} };
  }
}
async function fixture(t) {
  let client;
  const tempRoot = await mkdtemp(join(tmpdir(), 'webmail-prefs-test-'));
  const app = await createApp({ config, logger: false, auth: { tempRoot, clientFactory: options => (client = new PrefsImap(options)) } });
  app.directory.mailboxName = async email => email;
  app.directory.identities = async () => ({ identities: [{ address: 'user@example.com' }, { address: 'alias@example.com' }, { address: 'delegated@example.com' }] });
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
  const expected = { ...doc, imageAllow: ['sender@example.com'], signatures: {}, defaultFrom: 'alias@example.com' };
  assert.deepEqual(JSON.parse(f.client.value), expected); assert.deepEqual(f.session.prefs, expected);
  status(await f.request('GET'), 200); assert.deepEqual(f.session.prefs, expected);
  assert.deepEqual(f.client.calls.map(call => call.command), ['GETMETADATA', 'GETMETADATA', 'GETMETADATA', 'SETMETADATA', 'GETMETADATA']);
});
test('prefs: requested signature scripts, handlers and links cannot replace the stored mirror', async t => {
  const f = await fixture(t);
  const html = '<script>alert(1)</script><img src="https://images.example.com/logo.png" onerror="alert(2)"><a href="javascript:alert(3)">Contact</a>';
  status(await f.request('PUT', { ...defaults(), signatures: { 'user@example.com': { html, auto: true } } }), 204);
  assert.deepEqual(JSON.parse(f.client.value).signatures, {});
  assert.deepEqual(f.session.prefs.signatures, {});
  const response = await f.request('GET'); status(response, 200);
  assert.deepEqual(response.json().signatures, {});
});
test('prefs: stored business card mirror survives non-signature settings save', async t => {
  const f = await fixture(t);
  const html = '<table cellpadding="4"><tr><td style="color:#123456;font-weight:bold">Example Team<br><a href="mailto:user@example.com">user@example.com</a></td><td><img src="https://images.example.com/card.png" width="80" alt="Card"><img src="https://newmail.example.com/api/messages/private/parts/1"></td></tr></table>';
  f.client.value = JSON.stringify({ ...defaults(), signatures: { 'user@example.com': { html: sanitizeComposeHtml(html, { publicHostnames: config.publicHostnames }), auto: false } } });
  status(await f.request('PUT', { ...defaults(), signatures: {} }), 204);
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
test('prefs: rejects empty document, non-objects and malformed JSON 422', async t => {
  const f = await fixture(t);
  status(await f.request('PUT', {}), 422);
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
  doc.signatures['user@example.com'].html += 'x';
  assert.equal(Buffer.byteLength(JSON.stringify(doc)), MAX_PREFS_BYTES + 1);
  const response = await f.request('PUT', doc); status(response, 413);
  assert.deepEqual(response.json().error, { code: 'PREFS_TOO_LARGE', message: '설정은 64KB까지 저장할 수 있어요.' });
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

test('prefs sharedView: round trip, owner normalization, deduplication and account session storage', async t => {
  const f = await fixture(t);
  const sharedView = { ' Sales@EXAMPLE.COM ': { mode: 'custom', folders: ['Shared/sales@example.com/Archive', 'Shared/sales@example.com/Archive', 'Shared/sales@example.com/거래처/2026'], hidden: true } };
  status(await f.request('PUT', { ...defaults(), sharedView }), 204);
  const expected = { 'sales@example.com': { mode: 'custom', folders: ['Shared/sales@example.com/Archive', 'Shared/sales@example.com/거래처/2026'], hidden: true } };
  assert.deepEqual(JSON.parse(f.client.value).sharedView, expected);
  const response = await f.request('GET'); status(response, 200); assert.deepEqual(response.json().sharedView, expected); assert.deepEqual(f.session.prefs.sharedView, expected);
});
for (const mode of ['inbox', 'all', 'custom']) test(`prefs sharedView: ${mode} accepted`, async t => {
  const f = await fixture(t);
  status(await f.request('PUT', { ...defaults(), sharedView: { 'sales@example.com': { mode, folders: [], hidden: false } } }), 204);
});
const ownerView = patch => ({ 'sales@example.com': { mode: 'custom', folders: [], hidden: false, ...patch } });
for (const [label, sharedView] of [
  ['null', null], ['array', []], ['invalid owner', { invalid: { mode: 'all', folders: [], hidden: false } }],
  ['invalid mode', ownerView({ mode: 'other' })], ['hidden type', ownerView({ hidden: 1 })], ['folders type', ownerView({ folders: {} })],
  ['extra property', ownerView({ extra: true })], ['missing property', { 'sales@example.com': { mode: 'all', folders: [] } }],
  ['another owner path', ownerView({ folders: ['Shared/support@example.com/INBOX'] })],
  ['owner prefix collision', ownerView({ folders: ['Shared/sales@example.com.evil/INBOX'] })],
  ['personal path', ownerView({ folders: ['INBOX'] })], ['owner root', ownerView({ folders: ['Shared/sales@example.com'] })],
  ['empty relative path', ownerView({ folders: ['Shared/sales@example.com/'] })], ['path type', ownerView({ folders: [42] })],
  ['path control character', ownerView({ folders: ['Shared/sales@example.com/a\n'] })],
  ['path length 1025', ownerView({ folders: ['Shared/sales@example.com/' + 'x'.repeat(1025 - 'Shared/sales@example.com/'.length)] })],
  ['501 paths', ownerView({ folders: Array.from({ length: 501 }, (_, i) => `Shared/sales@example.com/${i}`) })],
  ['101 owners', Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`u${i}@example.com`, { mode: 'inbox', folders: [], hidden: false }]))],
]) test(`prefs sharedView: rejects ${label} without METADATA write`, async t => {
  const f = await fixture(t);
  status(await f.request('PUT', { ...defaults(), sharedView }), 422);
  assert.equal(f.client.calls.length, 0); assert.equal(f.session.prefs, undefined);
});
test('prefs sharedView: count/length caps accepted at 100 owners, 500 paths, 1024 chars', async t => {
  const f = await fixture(t);
  for (const sharedView of [
    Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`u${i}@example.com`, { mode: 'inbox', folders: [], hidden: false }])),
    ownerView({ folders: Array.from({ length: 500 }, (_, i) => `Shared/sales@example.com/${i}`) }),
    ownerView({ folders: ['Shared/sales@example.com/' + 'x'.repeat(1024 - 'Shared/sales@example.com/'.length)] }),
  ]) status(await f.request('PUT', { ...defaults(), sharedView }), 204);
});
test('prefs sharedView: total 64KB cap still applies below individual caps', async t => {
  const f = await fixture(t);
  const folders = Array.from({ length: 70 }, (_, i) => `Shared/sales@example.com/${i}${'x'.repeat(990)}`);
  status(await f.request('PUT', { ...defaults(), sharedView: ownerView({ folders }) }), 413);
  assert.equal(f.client.calls.length, 0);
});
test('prefs sharedView: old document without field loads defaults; invalid field discarded like other fields', async t => {
  const f = await fixture(t);
  const old = defaults(); delete old.sharedView;
  f.client.value = JSON.stringify(old);
  let response = await f.request('GET'); status(response, 200); assert.deepEqual(response.json(), defaults());
  f.client.value = JSON.stringify({ ...defaults(), theme: 'amber', sharedView: ownerView({ folders: ['Shared/other@example.com/INBOX'] }) });
  response = await f.request('GET'); status(response, 200);
  assert.deepEqual(response.json(), { ...defaults(), theme: 'amber' });
});

test('prefs mirror: no-list legacy bytes survive stale requests, without migration or image lookups', async t => {
  const f = await fixture(t);
  const mirror = { 'user@example.com': { html: '<p>원문 & data<img src="data:image/png;base64,YQ=="></p>', auto: true } };
  f.client.value = JSON.stringify({ ...defaults(), signatures: mirror });
  const response = await f.request('PUT', { ...defaults(), mode: 'light', signatures: { 'user@example.com': { html: '<p>stale</p>', auto: false } } });
  status(response, 204); assert.equal(response.body, ''); assert.equal(response.headers.etag, undefined);
  assert.deepEqual(JSON.parse(f.client.value), { ...defaults(), mode: 'light', signatures: mirror });
  assert.deepEqual(f.session.prefs.signatures, mirror); assert.equal(f.client.metadata.has(SIGNATURES_ENTRY), false);
  const writes = f.client.calls.filter(call => call.command === 'SETMETADATA');
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].args[1], [{ type: 'STRING', value: PREFS_ENTRY }, { type: 'LITERAL', value: Buffer.from(f.client.value) }]);
  assert.ok(f.client.calls.every(call => !JSON.stringify(call.args).includes(SIGNATURE_IMAGES_ENTRY)));
});

test('prefs mirror: synchronized list defaults and other settings survive a stale prefs PUT', async t => {
  const f = await fixture(t);
  f.app.directory.identities = async session => { assert.equal(session.email, 'user@example.com'); return { identities: [{ address: session.email, kind: 'self' }] }; };
  const first = await f.app.inject({ url: '/api/signatures', headers: f.headers }); status(first, 200);
  const saved = await f.app.inject({ method: 'PUT', url: '/api/signatures', headers: { ...f.headers, 'if-match': first.json().revision }, payload: {
    items: [{ id: 'client-new', name: '합성 업무', html: '<p>최신 서명</p>' }], defaults: { 'user@example.com': { newDefault: 'client-new', replyDefault: null } },
  } }); status(saved, 200);
  const listBefore = f.client.metadata.get(SIGNATURES_ENTRY), mirror = JSON.parse(f.client.value).signatures;
  f.client.calls.length = 0;
  const settings = { ...defaults(), theme: 'terra', accent: { olive: 3 }, folderColors: { INBOX: 2 }, defaultFrom: 'user@example.com', signatures: { 'user@example.com': { html: '<p>stale</p>', auto: false } } };
  status(await f.request('PUT', settings), 204);
  assert.deepEqual(JSON.parse(f.client.value), { ...settings, signatures: mirror });
  assert.equal(f.client.metadata.get(SIGNATURES_ENTRY), listBefore);
  const writes = f.client.calls.filter(call => call.command === 'SETMETADATA'); assert.equal(writes.length, 1); assert.equal(writes[0].args[1].length, 2);
  assert.deepEqual(f.session.prefs, JSON.parse(f.client.value));
});

test('prefs mirror: migration and pending legacy edits are preserved; importing makes old list revision stale', async t => {
  const f = await fixture(t);
  const original = { 'user@example.com': { html: '<p>원래 거울</p>', auto: true } };
  f.client.value = JSON.stringify({ ...defaults(), signatures: original });
  const list = await f.app.inject({ url: '/api/signatures', headers: f.headers }); status(list, 200);
  const migrated = f.client.metadata.get(SIGNATURES_ENTRY);
  status(await f.request('PUT', { ...defaults(), mode: 'light' }), 204);
  assert.deepEqual(JSON.parse(f.client.value).signatures, original); assert.equal(f.client.metadata.get(SIGNATURES_ENTRY), migrated);
  const edited = { 'user@example.com': { html: '<p>구판 수정</p>', auto: false } };
  f.client.value = JSON.stringify({ ...JSON.parse(f.client.value), signatures: edited });
  f.client.calls.length = 0;
  status(await f.request('PUT', { ...defaults(), theme: 'amber', signatures: original }), 204);
  assert.deepEqual(JSON.parse(f.client.value), { ...defaults(), theme: 'amber', signatures: edited });
  const storedList = JSON.parse(f.client.metadata.get(SIGNATURES_ENTRY));
  assert.equal(storedList.items.length, 2); assert.equal(storedList.items[1].html, edited['user@example.com'].html);
  assert.deepEqual(storedList.defaults, list.json().defaults);
  assert.equal(storedList.mirror.lastWrittenHash, null);
  const writes = f.client.calls.filter(call => call.command === 'SETMETADATA');
  assert.deepEqual(writes.map(call => call.args[1].filter((_, index) => index % 2 === 0).map(arg => arg.value)), [[SIGNATURES_ENTRY], [PREFS_ENTRY]]);
  const stale = await f.app.inject({ method: 'PUT', url: '/api/signatures', headers: { ...f.headers, 'if-match': list.json().revision }, payload: { items: [], defaults: {} } });
  status(stale, 409); assert.equal(stale.json().error.code, 'SIGNATURE_CONFLICT');
});

test('prefs mirror: final combined 64KiB boundary and overflow preserve state without SET', async t => {
  const f = await fixture(t);
  const doc = { ...defaults(), signatures: { 'user@example.com': { html: '', auto: false } } };
  doc.signatures['user@example.com'].html = 'x'.repeat(MAX_PREFS_BYTES - Buffer.byteLength(JSON.stringify(doc)));
  f.client.value = JSON.stringify(doc); const before = f.client.value;
  status(await f.request('PUT', defaults()), 204); assert.equal(f.client.value, before);
  f.client.calls.length = 0;
  const response = await f.request('PUT', { ...defaults(), folderColors: { INBOX: 7 } }); status(response, 413);
  assert.equal(response.json().error.code, 'PREFS_TOO_LARGE'); assert.equal(f.client.value, before);
  assert.deepEqual(f.session.prefs, doc); assert.equal(f.client.calls.filter(call => call.command === 'SETMETADATA').length, 0);
});

test('prefs mirror: account queue includes prepare, SET completion and session update across sessions', async t => {
  const f = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  let prepared = 0, inSet = 0;
  const service = createPrefsService({ config, imap: { async withMailbox(session, path, operation) { assert.equal(path, 'INBOX'); return operation(f.client); } }, signatures: {
    async preparePrefs({ session, client, prefs }) {
      prepared++; assert.strictEqual(client, f.client);
      await assert.rejects(withSignatureStoreLock(session.email, () => {}), { code: 'SIGNATURE_STORE_REENTRANT' });
      return { prefs: { ...prefs, signatures: {} }, mirrorSync: false };
    },
  } });
  f.client.beforeSet = async () => { inSet++; if (inSet === 1) { entered(); await gate; } };
  const one = { email: 'USER@example.com' }, two = { email: 'user@example.com' };
  const first = service.put(one, { ...defaults(), mode: 'light' }); await ready;
  const second = service.put(two, { ...defaults(), theme: 'amber' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(prepared, 1); assert.equal(inSet, 1); assert.equal(two.prefs, undefined);
  release(); await Promise.all([first, second]); assert.equal(prepared, 2); assert.equal(inSet, 2);
  assert.equal(one.prefs.mode, 'light'); assert.equal(two.prefs.theme, 'amber'); assert.equal(JSON.parse(f.client.value).theme, 'amber');
});

test('prefs mirror: divergent prepared mirror logs only account and hashes, preserves actual and writes prefs alone', async t => {
  const f = await fixture(t), entries = [];
  const actual = { 'user@example.com': { html: '<p>synthetic-private-content</p>', auto: false } };
  f.client.value = JSON.stringify({ ...defaults(), signatures: actual });
  const service = createPrefsService({ config, imap: { async withMailbox(_session, _path, operation) { return operation(f.client); } }, logger: { info(value, message) { entries.push({ value, message }); } }, signatures: {
    async preparePrefs({ prefs }) { return { prefs: { ...prefs, signatures: {} }, mirrorSync: true }; },
  } });
  await service.put({ email: 'user@example.com' }, defaults());
  assert.deepEqual(JSON.parse(f.client.value).signatures, actual); assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0].value), ['email', 'actualHash', 'preparedHash']);
  assert.match(entries[0].value.actualHash, /^[a-f0-9]{64}$/); assert.match(entries[0].value.preparedHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(entries), /synthetic-private-content|html|base64/);
  assert.deepEqual(f.client.calls.filter(c => c.command === 'SETMETADATA').map(c => c.args[1].map(arg => arg.type)), [['STRING', 'LITERAL']]);
});

test('prefs mirror: corrupt/oversized stored data and failed SET preserve stored bytes and cached session', async t => {
  const f = await fixture(t); const beforeSession = defaults(); f.session.prefs = beforeSession;
  for (const raw of ['{broken', JSON.stringify({ ...defaults(), signatures: { invalid: { html: '', auto: true } } }), JSON.stringify({ ...defaults(), signatures: {}, padding: 'x'.repeat(MAX_PREFS_BYTES) })]) {
    f.client.value = raw; f.client.calls.length = 0;
    const response = await f.request('PUT', defaults()); status(response, 503); assert.equal(response.json().error.code, 'SIGNATURES_INVALID');
    assert.equal(f.client.value, raw); assert.strictEqual(f.session.prefs, beforeSession); assert.equal(f.client.calls.filter(c => c.command === 'SETMETADATA').length, 0);
  }
  f.client.value = JSON.stringify(defaults()); f.client.beforeSet = async () => { throw new Error('synthetic-private-failure'); };
  const response = await f.request('PUT', { ...defaults(), theme: 'terra' }); status(response, 503); assert.equal(response.json().error.code, 'MAIL_UNAVAILABLE');
  assert.equal(f.client.value, JSON.stringify(defaults())); assert.strictEqual(f.session.prefs, beforeSession); assert.doesNotMatch(response.body, /synthetic-private-failure/);
});

test('prefs fromNames: normalize allowed addresses, remove blank and unauthorized names, preserve old-client saves', async t => {
  const f = await fixture(t);
  const doc = { ...defaults(), fromNames: { ' USER@EXAMPLE.COM ': ' 내 이름 ', 'alias@example.com': '별칭', 'delegated@example.com': '권한 이름', 'other@example.com': '금지', 'blank@example.com': '' } };
  status(await f.request('PUT', doc), 204);
  const expected = { 'user@example.com': '내 이름', 'alias@example.com': '별칭', 'delegated@example.com': '권한 이름' };
  assert.deepEqual(JSON.parse(f.client.value).fromNames, expected);
  const oldClient = defaults(); delete oldClient.fromNames;
  status(await f.request('PUT', oldClient), 204);
  assert.deepEqual(JSON.parse(f.client.value).fromNames, expected);
  f.app.directory.identities = async () => ({ identities: [{ address: 'user@example.com' }] });
  const response = await f.request('GET'); status(response, 200);
  assert.deepEqual(response.json().fromNames, { 'user@example.com': '내 이름' });
  status(await f.request('PUT', { ...defaults(), fromNames: { 'user@example.com': '  ' } }), 204);
  assert.deepEqual(JSON.parse(f.client.value).fromNames, {});
});
for (const name of ['x'.repeat(65), 'a\r\nBcc: hidden@example.com', 'a\tname', 'a\0name', 'a\x7fname', 'a\u0085name', 'a\u2028name', '\ud800', 12]) test(`prefs fromNames: reject invalid name ${JSON.stringify(name)}`, async t => {
  const f = await fixture(t);
  status(await f.request('PUT', { ...defaults(), fromNames: { 'user@example.com': name } }), 422);
  assert.equal(f.client.value, null); assert.equal(f.client.calls.length, 0);
});
test('prefs fromNames: 64 Unicode characters accepted; directory outage leaves preferences unchanged', async t => {
  const f = await fixture(t), fromNames = { 'user@example.com': '😀'.repeat(64) };
  status(await f.request('PUT', { ...defaults(), fromNames }), 204);
  assert.deepEqual(JSON.parse(f.client.value).fromNames, fromNames);
  const before = f.client.value, cached = f.session.prefs;
  f.app.directory.identities = async () => { throw new Error('synthetic-directory-failure'); };
  status(await f.request('PUT', { ...defaults(), fromNames: { 'user@example.com': '새 이름' } }), 503);
  assert.equal(f.client.value, before); assert.strictEqual(f.session.prefs, cached);
});


test('prefs partial sender updates merge into latest stored document and preserve other address names', async t => {
  const f = await fixture(t);
  status(await f.request('PUT', { ...defaults(), mode: 'dark', fromNames: { 'alias@example.com': 'Existing Alias' } }), 204);
  f.session.prefs = defaults(); // Stale session data must never be the merge base.
  status(await f.request('PUT', { fromNames: { 'user@example.com': 'New Self' } }), 204);
  assert.equal(JSON.parse(f.client.value).mode, 'dark');
  assert.deepEqual(JSON.parse(f.client.value).fromNames, { 'alias@example.com': 'Existing Alias', 'user@example.com': 'New Self' });
  status(await f.request('PUT', { defaultFrom: 'alias@example.com' }), 204);
  assert.equal(JSON.parse(f.client.value).mode, 'dark');
  assert.equal(JSON.parse(f.client.value).defaultFrom, 'alias@example.com');
  status(await f.request('PUT', { fromNames: { 'user@example.com': '', 'other@example.com': 'Forbidden' } }), 204);
  assert.deepEqual(JSON.parse(f.client.value).fromNames, { 'alias@example.com': 'Existing Alias' });
  for (const patch of [{}, { defaultFrom: 'alias@example.com', extra: true }, { fromNames: { 'user@example.com': 'bad\r\nBcc: hidden@example.com' } }]) status(await f.request('PUT', patch), 422);
});


test('prefs fromNames rejects encoded-word markers with guidance and exposes legacy values for correction', async t => {
  const f = await fixture(t), name = '=?UTF-8?B?SGVsbG8=?=';
  f.client.value = JSON.stringify({ ...defaults(), fromNames: { 'user@example.com': name } });
  const before = f.client.value;
  for (const payload of [{ fromNames: { 'user@example.com': name } }, { ...defaults(), fromNames: { 'user@example.com': name } }]) {
    const response = await f.request('PUT', payload);
    status(response, 422); assert.equal(response.json().error.message, '이름에 =? 문자 조합은 쓸 수 없어요');
  }
  assert.equal(f.client.value, before);
  const loaded = await f.request('GET'); status(loaded, 200);
  assert.equal(loaded.json().fromNames['user@example.com'], name);
});


test('prefs field updates preserve concurrent sender names and add image permissions atomically', async t => {
  const f = await fixture(t);
  status(await f.request('PUT', defaults()), 204);
  status(await f.request('PUT', { fromNames: { 'user@example.com': 'Concurrent Name' } }), 204);
  status(await f.request('PUT', { mode: 'dark' }), 204);
  status(await f.request('PUT', { imageAllowAdd: [' Sender@EXAMPLE.COM '] }), 204);
  let stored = JSON.parse(f.client.value);
  assert.equal(stored.mode, 'dark'); assert.equal(stored.fromNames['user@example.com'], 'Concurrent Name');
  assert.deepEqual(stored.imageAllow, ['sender@example.com']); assert.equal('imageAllowAdd' in stored, false);
  status(await f.request('PUT', { folderColors: { INBOX: 1 }, sharedView: {}, accent: { ink: 2 } }), 204);
  status(await f.request('PUT', { folderColors: {}, accent: {} }), 204);
  stored = JSON.parse(f.client.value); assert.deepEqual(stored.folderColors, {}); assert.deepEqual(stored.accent, {});
  const service = createPrefsService({ config, imap: { withMailbox: async (_session, _path, run) => run(f.client) }, directory: f.app.directory });
  const first = { email: 'user@example.com', prefs: defaults() }, second = { email: 'user@example.com', prefs: defaults() };
  await Promise.all([service.put(first, { fromNames: { 'alias@example.com': 'Alias Name' }, imageAllowAdd: ['one@example.com'] }), service.put(second, { mode: 'light', imageAllowAdd: ['two@example.com'] })]);
  stored = JSON.parse(f.client.value);
  assert.equal(stored.fromNames['user@example.com'], 'Concurrent Name'); assert.equal(stored.fromNames['alias@example.com'], 'Alias Name');
  assert.equal(stored.mode, 'light'); assert.deepEqual(stored.imageAllow, ['sender@example.com', 'one@example.com', 'two@example.com']);
  for (const patch of [{ imageAllowAdd: ['invalid'] }, { imageAllowAdd: Array.from({ length: 501 }, (_, i) => `u${i}@example.com`) }, { mode: 'dark', unknown: 1 }]) status(await f.request('PUT', patch), 422);
  status(await f.request('PUT', { imageAllow: Array.from({ length: 500 }, (_, i) => `u${i}@example.com`) }), 204);
  const before = f.client.value;
  status(await f.request('PUT', { imageAllowAdd: ['overflow@example.com'] }), 422); assert.equal(f.client.value, before);
  const oldClient = defaults(); delete oldClient.fromNames;
  status(await f.request('PUT', oldClient), 204);
  stored = JSON.parse(f.client.value); assert.deepEqual(stored.imageAllow, []); assert.equal(stored.mode, 'dark');
  assert.equal(stored.fromNames['user@example.com'], 'Concurrent Name');
});
