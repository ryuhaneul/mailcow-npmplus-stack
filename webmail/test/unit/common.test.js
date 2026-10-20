import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { Writable } from 'node:stream';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';
import { AppError } from '../../server/errors.js';
import { logOptions } from '../../server/log.js';
import { securityHeaders } from '../../server/security/headers.js';

const env = {
  PUBLIC_HOSTNAMES: 'newmail.example.com,newmail.example.org',
  BRAND_NAME: '메일', ORG_NAME: '', BRAND_MARK: '', DEFAULT_THEME: 'ink', DEFAULT_MODE: 'system',
  INTERNAL_DOMAINS: '', ATTACH_MAX_MB: '25', SESSION_IDLE_MIN: '480', SESSION_MAX_HOURS: '24', AUTOEXPUNGE_DAYS: '30',
  IMAP_HOST: 'dovecot-mailcow', SIEVE_HOST: 'dovecot-mailcow', SMTP_HOST: 'postfix-mailcow',
  MAIL_TLS_SERVERNAME: 'mail.example.com', MAIL_TLS_MODE: 'verify', MAIL_TLS_PIN_FILE: '',
  DB_HOST: 'mysql-mailcow', DB_NAME: 'mailcow', DB_USER: 'webmail_ro', DB_PASSWORD: 'synthetic-db-secret',
  MAILCOW_UI_URL: 'https://nginx-mailcow:8443', MAILCOW_UI_SERVERNAME: 'mailcow.example.com', MAILCOW_PUBLIC_URL: 'https://mailcow.example.com',
  TRUST_PROXY: '172.22.1.0/24', LOG_LEVEL: 'silent',
};

async function fixture(t, options = {}) {
  const app = await createApp({ config: loadConfig(env), logger: false, staticDir: '/nonexistent-webmail-unit-fixture', ...options });
  t.after(() => app.close());
  return app;
}

function assertHeaders(response) {
  for (const [name, value] of Object.entries(securityHeaders)) assert.equal(response.headers[name], value);
  assert.equal(response.headers['www-authenticate'], undefined);
}

test('config: all container keys required, including explicitly empty keys', () => {
  for (const key of Object.keys(env)) {
    const missing = { ...env };
    delete missing[key];
    assert.throws(() => loadConfig(missing), new RegExp(key));
  }
});

test('config: defaults supplied by stack retain types and fixed mail ports', () => {
  const config = loadConfig(env);
  assert.equal(config.attachMaxMb, 25);
  assert.equal(config.sessionIdleMin, 480);
  assert.equal(config.sessionMaxHours, 24);
  assert.deepEqual([config.imapPort, config.sievePort, config.smtpPort], [993, 4190, 587]);
  assert.deepEqual(config.publicHostnames, ['newmail.example.com', 'newmail.example.org']);
  assert.deepEqual(config.internalDomains, []);
  assert.deepEqual(config.trustProxy, ['172.22.1.0/24']);
});

test('config: invalid numbers rejected without printing supplied values', () => {
  for (const key of ['ATTACH_MAX_MB', 'SESSION_IDLE_MIN', 'SESSION_MAX_HOURS']) {
    for (const value of ['0', '-1', '1.5', 'NaN', '1e3', '9007199254740992']) {
      assert.throws(() => loadConfig({ ...env, [key]: value }), new RegExp(key));
    }
  }
  assert.throws(() => loadConfig({ ...env, DB_PASSWORD: '' }), /DB_PASSWORD/);
});

test('config: theme, mode, TLS mode, log level and brand mark checked', () => {
  for (const key of ['DEFAULT_THEME', 'DEFAULT_MODE', 'MAIL_TLS_MODE', 'LOG_LEVEL', 'BRAND_MARK']) {
    assert.throws(() => loadConfig({ ...env, [key]: 'invalid-synthetic-value' }), new RegExp(key));
  }
  assert.equal(loadConfig({ ...env, BRAND_MARK: '편지' }).brandMark, '편지');
});

test('config: autoexpunge disabled or within 1..365 only', () => {
  assert.equal(loadConfig({ ...env, AUTOEXPUNGE_DAYS: '' }).autoexpungeDays, null);
  for (const value of ['1', '365']) assert.equal(loadConfig({ ...env, AUTOEXPUNGE_DAYS: value }).autoexpungeDays, Number(value));
  for (const value of ['0', '366', 'x']) assert.throws(() => loadConfig({ ...env, AUTOEXPUNGE_DAYS: value }), /AUTOEXPUNGE_DAYS/);
});

test('config: public hostnames, domain overrides and HTTPS URLs validated', () => {
  for (const value of ['https://example.com', 'example.com:8080', 'example.com,', '-bad.example.com']) {
    assert.throws(() => loadConfig({ ...env, PUBLIC_HOSTNAMES: value }), /PUBLIC_HOSTNAMES/);
  }
  assert.deepEqual(loadConfig({ ...env, INTERNAL_DOMAINS: 'example.com, example.org' }).internalDomains, ['example.com', 'example.org']);
  for (const key of ['MAILCOW_UI_URL', 'MAILCOW_PUBLIC_URL']) {
    for (const value of ['http://example.com', 'https://user:synthetic@example.com', 'https://example.com/path']) {
      assert.throws(() => loadConfig({ ...env, [key]: value }), new RegExp(key));
    }
  }
});

test('config: trusted proxy addresses and CIDRs only', () => {
  assert.deepEqual(loadConfig({ ...env, TRUST_PROXY: '172.22.1.0/24, 192.0.2.1,2001:db8::/32' }).trustProxy, ['172.22.1.0/24', '192.0.2.1', '2001:db8::/32']);
  for (const value of ['', 'true', '*', 'example.com', '192.0.2.1/33', '2001:db8::/129', '192.0.2.1/']) {
    assert.throws(() => loadConfig({ ...env, TRUST_PROXY: value }), /TRUST_PROXY/);
  }
});

test('config: pin requires a readable certificate, verify accepts no pin', () => {
  assert.throws(() => loadConfig({ ...env, MAIL_TLS_MODE: 'pin' }), /MAIL_TLS_PIN_FILE/);
  assert.throws(() => loadConfig({ ...env, MAIL_TLS_MODE: 'pin', MAIL_TLS_PIN_FILE: '/nonexistent-webmail-pin.pem' }), /MAIL_TLS_PIN_FILE/);
  assert.throws(() => loadConfig({ ...env, MAIL_TLS_PIN_FILE: '/tmp/synthetic.pem' }), /MAIL_TLS_PIN_FILE/);
});

test('healthz: available without static output or authentication', async t => {
  const app = await fixture(t);
  const response = await app.inject('/healthz');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  assertHeaders(response);
});

test('public config: exact allowlist, no secrets or internal addresses', async t => {
  const app = await fixture(t);
  const response = await app.inject('/api/config');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    brandName: '메일', orgName: '', brandMark: '', defaultTheme: 'ink', defaultMode: 'system', attachMaxMb: 25, autoexpungeDays: 30, contactsEnabled: true, version: '0.1.0', logo: null,
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  for (const privateValue of [env.DB_PASSWORD, env.DB_HOST, env.IMAP_HOST, env.MAILCOW_UI_URL, env.PUBLIC_HOSTNAMES]) assert.ok(!response.body.includes(privateValue));
  assertHeaders(response);
});

test('public config: branding and disabled retention follow supplied environment', async t => {
  const config = loadConfig({ ...env, BRAND_NAME: '테스트 메일', ORG_NAME: '예제 조직', BRAND_MARK: '예', DEFAULT_THEME: 'olive', DEFAULT_MODE: 'dark', ATTACH_MAX_MB: '10', AUTOEXPUNGE_DAYS: '', CONTACTS_ENABLE: 'false' });
  const app = await fixture(t, { config });
  const response = await app.inject('/api/config');
  assert.deepEqual(response.json(), { brandName: '테스트 메일', orgName: '예제 조직', brandMark: '예', defaultTheme: 'olive', defaultMode: 'dark', attachMaxMb: 10, autoexpungeDays: null, contactsEnabled: false, version: '0.1.0', logo: null });
  const login = app.sessions.create({ email: 'user@example.com', password: Buffer.from('synthetic-user-password'), connection: { logout: async () => {} }, ip: '198.51.100.8' });
  const contacts = await app.inject({ method: 'GET', url: '/api/contacts?q=example.com', headers: { cookie: `webmail_sid=${login.token}` } });
  assert.equal(contacts.statusCode, 200);
  assert.deepEqual(contacts.json(), { items: [] });
  assert.equal(contacts.headers['cache-control'], 'no-store');
});

test('errors: AppError contract retains expected status, code and Korean message', async t => {
  const app = await fixture(t);
  app.get('/test-error', () => { throw new AppError(422, 'INVALID_INPUT', '입력값을 확인해 주세요.'); });
  const response = await app.inject('/test-error');
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.json(), { error: { code: 'INVALID_INPUT', message: '입력값을 확인해 주세요.' } });
  assertHeaders(response);
});

test('errors: unknown server error hides exception details and secrets', async t => {
  const app = await fixture(t);
  app.get('/test-error', () => { throw new Error(env.DB_PASSWORD); });
  const response = await app.inject('/test-error');
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, 'INTERNAL_ERROR');
  assert.ok(!response.body.includes(env.DB_PASSWORD));
  assertHeaders(response);
});

test('errors: thrown 401 becomes 403 and logs a warning', async t => {
  let logs = '';
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
  const app = await fixture(t, { logger: { ...logOptions('warn'), stream } });
  app.get('/test-auth', () => { throw new AppError(401, 'AUTH_FAILED', '메일 주소나 암호가 맞지 않아요.'); });
  const response = await app.inject('/test-auth');
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'AUTH_FAILED');
  assert.ok(logs.includes('AUTH_STATUS_REWRITTEN'));
  assertHeaders(response);
});

test('headers: directly sent 401 becomes 403, challenge removed, payload normalized', async t => {
  let logs = '';
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
  const app = await fixture(t, { logger: { ...logOptions('warn'), stream } });
  app.get('/test-auth', (_request, reply) => reply.code(401).header('WWW-Authenticate', 'Basic realm="synthetic"').header('content-length', '1').send('synthetic denied'));
  const response = await app.inject('/test-auth');
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'AUTH_FAILED');
  assert.ok(logs.includes('AUTH_CHALLENGE_REMOVED'));
  assert.ok(logs.includes('AUTH_STATUS_REWRITTEN'));
  assertHeaders(response);
});

test('headers: challenge removed even from successful plugin response', async t => {
  const app = await fixture(t);
  await app.register(async child => {
    child.get('/test-plugin', (_request, reply) => reply.header('wWw-AuThEnTiCaTe', 'synthetic').send({ ok: true }));
  });
  const response = await app.inject('/test-plugin');
  assert.equal(response.statusCode, 200);
  assertHeaders(response);
});

test('errors: missing API and missing frontend return JSON 404', async t => {
  const app = await fixture(t);
  for (const url of ['/api/missing', '/', '/unknown']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: { code: 'NOT_FOUND', message: '요청한 경로를 찾을 수 없어요.' } });
    assertHeaders(response);
  }
});

test('static: temporary synthetic files, SPA fallback and API exclusion', async t => {
  const staticDir = await mkdtemp(join(tmpdir(), 'webmail-w01-static-'));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const html = '<!doctype html><title>example.com</title><p>Synthetic webmail</p>';
  await writeFile(join(staticDir, 'index.html'), html);
  await writeFile(join(staticDir, 'asset.txt'), 'synthetic asset');
  const app = await fixture(t, { staticDir });
  for (const url of ['/', '/inbox/deep?example=1']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, html);
    assertHeaders(response);
  }
  assert.equal((await app.inject('/asset.txt')).body, 'synthetic asset');
  for (const url of ['/api/missing', '/api/missing?example=1', '/api']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'NOT_FOUND');
    assertHeaders(response);
  }
  const head = await app.inject({ method: 'HEAD', url: '/inbox/deep' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal((await app.inject({ method: 'POST', url: '/unknown' })).statusCode, 404);
});

test('logs: sensitive fields removed and request body/query not automatically logged', async t => {
  let logs = '';
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
  const app = await fixture(t, { logger: { ...logOptions('info'), stream } });
  app.post('/test-log', request => {
    request.log.info({ req: request, user: { password: 'secret-password', current: 'secret-current', next: 'secret-next', next2: 'secret-next2' } }, 'synthetic event');
    return { ok: true };
  });
  const response = await app.inject({ method: 'POST', url: '/test-log?secret=secret-query', headers: { cookie: 'webmail_sid=secret-cookie', 'x-webmail-csrf': 'secret-csrf' }, payload: { password: 'secret-body' } });
  assert.equal(response.statusCode, 200);
  assert.ok(logs.includes('synthetic event'));
  for (const secret of ['secret-password', 'secret-current', 'secret-next', 'secret-next2', 'secret-query', 'secret-cookie', 'secret-csrf', 'secret-body']) assert.ok(!logs.includes(secret), secret);
});

test('config: contacts default on, accept only true or false, and reject invalid startup values', () => {
  assert.equal(loadConfig(env).contactsEnabled, true);
  assert.equal(loadConfig({ ...env, CONTACTS_ENABLE: 'true' }).contactsEnabled, true);
  assert.equal(loadConfig({ ...env, CONTACTS_ENABLE: 'false' }).contactsEnabled, false);
  for (const value of ['', 'TRUE', 'False', '0', '1', ' true ', true, null]) {
    assert.throws(() => loadConfig({ ...env, CONTACTS_ENABLE: value }), /CONTACTS_ENABLE/);
  }
});

test('config: legacy public environment without LOGO_DIR starts, optional absolute logo path validated', async t => {
  assert.equal(Object.hasOwn(env, 'LOGO_DIR'), false); const app = await fixture(t); assert.equal((await app.inject('/api/config')).json().logo, null);
  assert.equal(loadConfig(env).logoDir, ''); assert.equal(loadConfig({ ...env, LOGO_DIR: '' }).logoDir, ''); assert.equal(loadConfig({ ...env, LOGO_DIR: '/brand' }).logoDir, '/brand');
  for (const value of ['relative', '/bad\0path', 7]) assert.throws(() => loadConfig({ ...env, LOGO_DIR: value }), /LOGO_DIR/);
});


test('Docker web-build copies every browser server import and its relative dependencies', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const server = join(root, 'server');
  const required = new Set();
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    if (file.startsWith(`${server}/`)) required.add(file);
    const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      const source = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)
        ? node.source : node.type === 'CallExpression' && node.callee.type === 'Import' ? node.arguments[0] : null;
      if (source?.type === 'StringLiteral' && source.value.startsWith('.')) {
        const base = resolve(dirname(file), source.value.split(/[?#]/)[0]);
        const dependency = [base, `${base}.js`, `${base}.jsx`, join(base, 'index.js'), join(base, 'index.jsx')]
          .find(candidate => { try { return statSync(candidate).isFile(); } catch { return false; } });
        assert.ok(dependency, `Unresolved relative import: ${relative(root, file)} -> ${source.value}`);
        if (/\.[cm]?jsx?$/.test(dependency)) visit(dependency);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      }
    }
    walk(ast);
  }
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.[cm]?jsx?$/.test(file)) visit(file);
    }
  }
  scan(join(root, 'web/src'));
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const stage = dockerfile.split(/^FROM .* AS web-build\s*$/mi)[1]?.split(/^FROM /mi)[0];
  assert.ok(stage, 'Dockerfile must have a web-build stage');
  const copies = [...stage.replace(/\\\r?\n/g, ' ').matchAll(/^COPY\s+(.+)$/gm)].flatMap(([, instruction]) => {
    if (/--from=/.test(instruction)) return [];
    const args = instruction.replace(/--\S+\s*/g, '').trim();
    const parts = args.startsWith('[') ? JSON.parse(args) : args.split(/\s+/);
    const destination = resolve(root, parts.pop().replace(/^\/app\/?/, './'));
    return parts.map(source => ({ source: resolve(root, source), destination }));
  });
  assert.ok(required.size > 0, 'Browser server imports must be discovered');
  const missing = [...required].filter(file => !copies.some(({ source, destination }) => {
    const suffix = relative(source, file);
    if (statSync(source).isDirectory()) return !suffix.startsWith('..') && resolve(destination, suffix) === file;
    return source === file && (destination === file || join(destination, source.split('/').at(-1)) === file);
  })).map(file => relative(root, file));
  assert.deepEqual(missing, [], 'Server dependencies missing from Docker web-build COPY');
});
