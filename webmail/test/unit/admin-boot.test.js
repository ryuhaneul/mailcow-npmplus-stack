import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAdminApp } from '../../server/admin/app.js';
import { loadAdminConfig } from '../../server/admin/config.js';
import { createApp } from '../../server/app.js';
import { AppError } from '../../server/errors.js';

const env = {
  ADMIN_MODE: 'true', ADMIN_HOSTNAME: 'mailadmin.example.com', ADMIN_SESSION_IDLE_MIN: '60', ADMIN_SESSION_MAX_HOURS: '8',
  MAILCOW_UI_URL: 'https://nginx-mailcow:8443', MAILCOW_UI_SERVERNAME: 'mailcow.example.com',
  IMAP_HOST: 'dovecot-mailcow', SMTP_HOST: 'postfix-mailcow', MAIL_TLS_SERVERNAME: 'mail.example.com',
  MAIL_TLS_MODE: 'verify', MAIL_TLS_PIN_FILE: '', DOMAIN: 'example.com', TRUST_PROXY: '192.0.2.0/24',
  DOCKERAPI_URL: 'https://dockerapi:443', DOVEADM_URL: '', DOVEADM_KEY: '', RELAY_FILES: '',
  MAILCOW_IPV4_NETWORK: '192.0.2', MAILCOW_IPV6_NETWORK: '2001:db8::/64', AUTOEXPUNGE_DAYS: '30',
  LOGO_DIR: '/brand', AUDIT_DIR: '/data/audit', LOG_LEVEL: 'silent',
};
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";
async function fixture(t, options = {}) {
  const app = await createAdminApp({ config: loadAdminConfig(env), logger: false, staticDir: '/nonexistent-admin-fixture', ...options });
  t.after(() => app.close());
  return app;
}

for (const [key, value] of [
  ['ADMIN_HOSTNAME', undefined], ['ADMIN_HOSTNAME', 'https://example.com'],
  ['ADMIN_SESSION_IDLE_MIN', '181'], ['ADMIN_SESSION_MAX_HOURS', '0'],
  ['MAILCOW_UI_URL', 'http://example.com'], ['MAIL_TLS_PIN_FILE', '/synthetic.pem'],
  ['TRUST_PROXY', '192.0.2.1/33'], ['AUDIT_DIR', undefined],
]) {
  test(`admin boot: invalid ${key} (${value === undefined ? 'missing' : 'format'}) fails startup`, () => {
    const invalid = { ...env, [key]: value };
    if (value === undefined) delete invalid[key];
    assert.throws(() => loadAdminConfig(invalid), new RegExp(key));
    const result = spawnSync(process.execPath, ['server/index.js'], { env: invalid, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /서버 시작에 실패/);
    assert.ok(!result.stderr.includes('synthetic.pem'));
  });
}

test('admin config: all environment keys required, including empty optional features', () => {
  for (const key of Object.keys(env)) {
    const invalid = { ...env };
    delete invalid[key];
    assert.throws(() => loadAdminConfig(invalid), new RegExp(key));
  }
  const config = loadAdminConfig(env);
  assert.equal(config.sessionIdleMin, 60);
  assert.equal(config.sessionMaxHours, 8);
  assert.equal(config.autoexpungeDays, 30);
  assert.deepEqual(config.trustProxy, ['192.0.2.0/24']);
  assert.ok(Object.isFrozen(config));
});

test('admin health: no authentication and exact security headers', async t => {
  const app = await fixture(t);
  const response = await app.inject('/healthz');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  assert.equal(response.headers['content-security-policy'], csp);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
});

test('admin errors: thrown and directly sent auth failures become forbidden without challenge', async t => {
  const app = await fixture(t);
  app.get('/test-thrown', () => { throw new AppError(401, 'AUTH_FAILED', '접근할 수 없어요.'); });
  app.get('/test-direct', (_request, reply) => reply.code(401).header('WWW-Authenticate', 'Basic realm="synthetic"').send('denied'));
  app.get('/test-success', (_request, reply) => reply.header('WWW-Authenticate', 'synthetic').send({ ok: true }));
  for (const path of ['/test-thrown', '/test-direct', '/test-success']) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, path === '/test-success' ? 200 : 403);
    assert.equal(response.headers['www-authenticate'], undefined);
    assert.equal(response.headers['content-security-policy'], csp);
    if (response.statusCode === 403) assert.equal(response.json().error.code, 'AUTH_FAILED');
  }
});

test('admin routes: JSON API 404, public endpoints absent and no-store', async t => {
  const app = await fixture(t);
  for (const path of ['/api/admin/auth/session', '/api/auth/session', '/api/messages', '/api', '/missing']) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, path === '/api/admin/auth/session' ? 403 : 404);
    assert.equal(response.json().error.code, path === '/api/admin/auth/session' ? 'NO_SESSION' : 'NOT_FOUND');
    if (path.startsWith('/api')) assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('admin static: admin.html root and SPA fallback, JSON API exclusion', async t => {
  const staticDir = await mkdtemp(join(tmpdir(), 'webmail-a01-static-'));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const html = '<!doctype html><title>example.com admin</title>';
  await writeFile(join(staticDir, 'admin.html'), html);
  await writeFile(join(staticDir, 'index.html'), '<title>wrong public entry</title>');
  const app = await fixture(t, { staticDir });
  for (const url of ['/', '/accounts', '/accounts/deep']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, html);
    assert.equal(response.headers['content-security-policy'], csp);
  }
  const missingApi = await app.inject('/api/admin/missing');
  assert.equal(missingApi.statusCode, 404);
  assert.match(missingApi.headers['content-type'], /application\/json/);
  assert.equal(missingApi.json().error.code, 'NOT_FOUND');
  assert.equal((await app.inject({ method: 'POST', url: '/missing' })).statusCode, 404);
});

test('public routes: no registered admin paths and admin session is JSON 404', async t => {
  const app = await createApp({ logger: false, staticDir: '/nonexistent-public-fixture', config: {
    publicHostnames: ['mail.example.com'], trustProxy: ['192.0.2.0/24'], sessionIdleMin: 60, sessionMaxHours: 8,
    imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com',
    dbHost: 'db.example.com', dbName: 'example', dbUser: 'example', dbPassword: 'synthetic-admin-boot',
  } });
  t.after(() => app.close());
  await app.ready();
  assert.ok(!app.printRoutes({ commonPrefix: false }).includes('/api/admin'));
  const response = await app.inject('/api/admin/auth/session');
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'NOT_FOUND');
  assert.equal(response.headers['content-security-policy'], "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
});

test('admin config: fixed paths, hostname, URL and network formats rejected', () => {
  for (const [key, values] of Object.entries({
    ADMIN_MODE: ['false', 'TRUE'], DOMAIN: ['https://example.com', '-example.com'],
    IMAP_HOST: ['https://dovecot', 'dovecot:993'], SMTP_HOST: ['postfix:465', '-postfix'], MAIL_TLS_SERVERNAME: ['mail.example.com:993', 'mail example.com'],
    MAILCOW_UI_SERVERNAME: ['example.com:443'], MAILCOW_UI_URL: ['https://example.com/path', 'https://user:synthetic@example.com'],
    DOCKERAPI_URL: ['https://example.com:443'], RELAY_FILES: ['/tmp/extra.cf,/tmp/options.inc', '/run/relay/extra.cf,/run/relay/options.inc'],
    LOGO_DIR: ['/tmp/brand'], AUDIT_DIR: ['/tmp/audit'], LOG_LEVEL: ['invalid'],
    MAILCOW_IPV4_NETWORK: ['192.0.2.0/24', '192.0.256', '0192.0.2'],
    MAILCOW_IPV6_NETWORK: ['2001:db8::', '2001:db8::/129', '192.0.2.0/24'],
    TRUST_PROXY: ['true', 'example.com', '2001:db8::/129'], AUTOEXPUNGE_DAYS: ['0', '366', 'NaN'],
    ADMIN_SESSION_IDLE_MIN: ['0', '1.5'], ADMIN_SESSION_MAX_HOURS: ['9007199254740992'],
  })) {
    for (const value of values) assert.throws(() => loadAdminConfig({ ...env, [key]: value }), new RegExp(key));
  }
  assert.throws(() => loadAdminConfig({ ...env, ADMIN_SESSION_IDLE_MIN: '61', ADMIN_SESSION_MAX_HOURS: '1' }), /ADMIN_SESSION_MAX_HOURS/);
  assert.throws(() => loadAdminConfig({ ...env, MAIL_TLS_MODE: 'pin' }), /MAIL_TLS_PIN_FILE/);
  assert.throws(() => loadAdminConfig({ ...env, MAIL_TLS_MODE: 'pin', MAIL_TLS_PIN_FILE: '/nonexistent-admin-pin.pem' }), /MAIL_TLS_PIN_FILE/);
});

test('admin config: optional feature pairs and mailcow networks retain agreed formats', () => {
  for (const pair of [
    { DOVEADM_URL: 'http://dovecot:12346' }, { DOVEADM_KEY: 'synthetic-doveadm-key' },
    { DOVEADM_URL: 'https://dovecot:12346', DOVEADM_KEY: 'synthetic-doveadm-key' },
    { DOVEADM_URL: 'http://dovecot:65536', DOVEADM_KEY: 'synthetic-doveadm-key' },
    { DOVEADM_URL: 'http://dovecot:0', DOVEADM_KEY: 'synthetic-doveadm-key' },
  ]) assert.throws(() => loadAdminConfig({ ...env, ...pair }), /DOVEADM_/);
  const config = loadAdminConfig({ ...env, DOVEADM_URL: 'http://dovecot:12346', DOVEADM_KEY: 'synthetic-doveadm-key',
    RELAY_FILES: '/run/relay/postfix/extra.cf,/run/relay/rspamd/options.inc', TRUST_PROXY: '192.0.2.1,2001:db8::/32', AUTOEXPUNGE_DAYS: '' });
  assert.equal(config.doveadmUrl, 'http://dovecot:12346');
  assert.equal(config.doveadmKey, 'synthetic-doveadm-key');
  assert.deepEqual(config.relayFiles, ['/run/relay/postfix/extra.cf', '/run/relay/rspamd/options.inc']);
  assert.equal(config.mailcowIpv4Network, '192.0.2');
  assert.equal(config.mailcowIpv6Network, '2001:db8::/64');
  assert.equal(config.autoexpungeDays, null);
  assert.equal(loadAdminConfig({ ...env, MAILCOW_IPV6_NETWORK: '' }).mailcowIpv6Network, '');
});

test('admin config: optional read-only rspamd map directory defaults and absolute-path validation', () => {
  assert.equal(loadAdminConfig(env).rspamdMapDir, '/rspamd_custom_maps');
  assert.equal(loadAdminConfig({ ...env, ADMIN_RSPAMD_MAP_DIR: '/synthetic/maps' }).rspamdMapDir, '/synthetic/maps');
  for (const value of ['', 'relative/maps', '/bad\0path']) assert.throws(() => loadAdminConfig({ ...env, ADMIN_RSPAMD_MAP_DIR: value }), /ADMIN_RSPAMD_MAP_DIR/);
});

test('admin config: existing mail connection environment names are retained for status TLS SNI', () => {
  const result = loadAdminConfig({ ...env, IMAP_HOST: 'Dovecot-Mailcow', SMTP_HOST: 'Postfix-Mailcow', MAIL_TLS_SERVERNAME: 'Mail.Example.Com' });
  assert.equal(result.imapHost, 'dovecot-mailcow'); assert.equal(result.smtpHost, 'postfix-mailcow'); assert.equal(result.mailTlsServername, 'mail.example.com');
});

test('admin config: empty LOGO_DIR disables logo management', () => { assert.equal(loadAdminConfig({ ...env, LOGO_DIR: '' }).logoDir, ''); });

test('admin Starflow static assets permit only same-origin frames while root/API/assets keep ancestry blocked', async t => {
  const staticDir = await mkdtemp(join(tmpdir(), 'webmail-admin-starflow-'));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  await writeFile(join(staticDir, 'admin.html'), '<title>synthetic admin</title>');
  await cp(new URL('../../web/public/starflow/', import.meta.url), join(staticDir, 'starflow'), { recursive: true });
  const app = await fixture(t, { staticDir });
  for (const file of ['index.html', 'stars.js', 'stars.css']) {
    const response = await app.inject(`/starflow/${file}?v=synthetic`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, await readFile(new URL(`../../web/public/starflow/${file}`, import.meta.url), 'utf8'));
    assert.equal(response.headers['content-security-policy'], csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
  }
  for (const path of ['/', '/api/admin/auth/session', '/assets/synthetic.js', '/starflow-other/index.html', '/api/admin/missing?next=/starflow/index.html', '/starflow/../api/admin/auth/session', '/starflow/%2e%2e/api/admin/auth/session', '/starflow/%2e%2e%2fapi/admin/auth/session', '/starflow/%3f%2f..%2f..%2fapi/admin/auth/session']) {
    const response = await app.inject(path);
    assert.equal(response.headers['content-security-policy'], csp, path);
  }
});

test('admin config: whole-mailbox sharing defaults false and only accepts literal booleans', () => {
  assert.equal(loadAdminConfig(env).wholeMailbox, false);
  assert.equal(loadAdminConfig({ ...env, SHARE_WHOLE_MAILBOX: 'false' }).wholeMailbox, false);
  assert.equal(loadAdminConfig({ ...env, SHARE_WHOLE_MAILBOX: 'true' }).wholeMailbox, true);
  for (const value of ['', 'TRUE', '1', 'yes', true]) assert.throws(() => loadAdminConfig({ ...env, SHARE_WHOLE_MAILBOX: value }), /SHARE_WHOLE_MAILBOX/);
});
