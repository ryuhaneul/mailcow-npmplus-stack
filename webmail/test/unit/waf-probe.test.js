import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyResponse, runProbe, exitCode } from '../int/waf-probe.mjs';
import { validateDocument } from '../../server/sieve/model.js';
import { listArtifacts, formatListing, parseArgs } from '../int/list-artifacts.mjs';

const credentials = { email: 'user1@mail.example.com', password: 'synthetic-password' };
const original = { v: 1, rev: 1, rules: [], blocked: [], vacation: { enabled: false, start: null, end: null, subject: '', body: '' } };

for (const [mode, band] of [['block', 'In'], ['detect', 'Out']]) {
  test(`WAF ${mode} YAML limits Gmail XML exclusions to three IDs, POST and webmail hosts`, () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const render = enabled => execFileSync('bash', ['-c', 'source scripts/lib/webmail-env.sh; source scripts/lib/waf.sh; waf_render_appsec_config'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DOMAIN: 'example.com', WEBMAIL_ENABLE: enabled, WEBMAIL_HOSTNAMES: 'newmail.example.com,other.example.com', SNAPPYMAIL_ENABLE: 'true', WEBMAIL_ADMIN_ENABLE: enabled, WEBMAIL_ADMIN_HOSTNAME: 'admin.example.com', WAF_MODE: mode, WAF_ALLOWLIST: '' },
    });
    const yaml = render('true');
    const blocks = yaml.split(/(?=^  - filter:)/m);
    const xmlBlocks = blocks.filter(block => block.includes('/api/rules/import/xml'));
    assert.equal(xmlBlocks.length, 2);
    for (const [index, host] of ['newmail.example.com', 'other.example.com'].entries()) {
      assert.equal(xmlBlocks[index], `  - filter: Is${band}Band == true && req.Host == "${host}" && req.Method == "POST" && req.URL.Path in ["/api/rules/import/xml/preview", "/api/rules/import/xml"]\n    apply:\n      - Remove${band}BandRuleByID(941100)\n      - Remove${band}BandRuleByID(941130)\n      - Remove${band}BandRuleByID(941310)\n`);
    }
    assert.ok(blocks.filter(block => !xmlBlocks.includes(block)).every(block => !/RuleByID\(941(?:100|130|310)\)/.test(block)));
    const disabled = render('false');
    assert.ok(!disabled.includes('/api/rules/import/xml'));
    assert.ok(!/RuleByID\(941(?:100|130|310)\)/.test(disabled));
  });
}

async function fakeServer(options = {}) {
  const requests = []; let rev = options.state === 'none' ? 0 : 1;
  const server = http.createServer(async (req, res) => {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (!req.url.startsWith('/api/attachments')) chunks.push(chunk); }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({ path: req.url, method: req.method, body, size, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    if (options.block && req.url === '/api/drafts') { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<html>blocked</html>'); return; }
    let data;
    if (req.url === '/api/auth/login') { res.setHeader('set-cookie', 'webmail_sid=synthetic-session; HttpOnly; Path=/'); data = { user: { email: credentials.email }, csrf: 'synthetic-csrf' }; }
    else if (req.url === '/api/rules' && req.method === 'GET') data = { rev, doc: options.state && !['ok', 'none'].includes(options.state) ? null : original, state: options.state || 'ok' };
    else if (req.url === '/api/rules') {
      try { validateDocument(body.doc, { internalDomains: [], folders: [] }); }
      catch {
        res.statusCode = 422;
        res.end(JSON.stringify({ error: { code: 'RULES_INVALID', message: '합성 앱 검사 거절' } }));
        return;
      }
      if (options.save && (rev === 1 || !options.restoreFail)) data = { rev: ++rev };
      else { res.statusCode = 422; data = { error: { code: 'RULES_INVALID', message: '합성 거절' } }; }
    }
    else if (req.url === '/api/drafts') data = { draftRef: 'synthetic-ref' };
    else if (req.url === '/api/send') data = { ok: true };
    else if (req.url === '/api/attachments') data = { id: 'synthetic-attachment', size: 20 * 1024 * 1024 };
    else if (req.url.startsWith('/api/messages?')) data = { items: [], total: 0 };
    else { res.statusCode = 422; data = { error: { code: 'PW_MISMATCH', message: '새 암호 불일치' } }; }
    res.end(JSON.stringify(data));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('three response sources distinguish app JSON, upstream block HTML/403, and connection failures', () => {
  assert.equal(classifyResponse({ status: 403, contentType: 'application/json', body: '{"error":{"code":"NO_SESSION","message":"expired"}}' }, '/api/rules').source, '웹메일 앱 JSON');
  for (const [status, contentType, body] of [[403, 'text/html', '<html>blocked</html>'], [200, 'text/html', '<html>challenge</html>'], [403, 'application/json', '{"message":"proxy block"}']]) {
    assert.equal(classifyResponse({ status, contentType, body }, '/api/rules').source, '앱 아닌 차단/응답');
  }
  assert.equal(classifyResponse({ failed: true }).source, '연결 실패');
  assert.equal(exitCode([{ source: '앱 아닌 차단/응답' }]), 1);
  assert.equal(exitCode([{ source: '연결 실패' }]), 1);
});

test('real fake-server probe sends the full R-WAF bundle with cookies/CSRF and restores a saved doc', async () => {
  const server = await fakeServer({ save: true });
  try {
    const result = await runProbe(server.url, credentials);
    assert.equal(result.code, 0); assert.ok(result.rows.every(row => row.source === '웹메일 앱 JSON'));
    const requests = server.requests;
    assert.ok(requests.find(req => req.path === '/api/drafts').body.html.includes('<script>'));
    assert.ok(requests.some(req => req.body?.subject?.includes('SELECT *')));
    const xmlRequests = requests.filter(req => ['/api/rules/import/xml/preview', '/api/rules/import/xml'].includes(req.path));
    assert.equal(xmlRequests.length, 2);
    for (const { body } of xmlRequests) {
      assert.ok(body.xml.includes('쾌속 배송') && body.xml.includes('알림/공지'));
      const bytes = Buffer.from(body.xml).toString('latin1');
      assert.match(bytes, /<\s*\/\s*[^\xbe]*\xbe/);
      assert.match(bytes, /\xbc\s*\/\s*[^\xbe>]*[\xbe>]/);
    }
    const rules = requests.filter(req => req.path === '/api/rules' && req.method === 'PUT');
    const value = rules[0].body.doc.rules[0].conditions[0].value;
    assert.ok(!value.includes('${') && value.includes('"') && value.includes('<') && value.includes(';') && value.includes('합성'));
    assert.doesNotThrow(() => validateDocument(rules[0].body.doc, { internalDomains: [], folders: [] }));
    assert.deepEqual(rules[1].body.doc, original); assert.equal(rules[1].body.baseRev, 2);
    assert.ok(requests.find(req => req.path === '/api/attachments').size > 20 * 1024 * 1024);
    assert.ok(requests.some(req => req.path.startsWith('/api/messages?') && decodeURIComponent(req.path).includes('${value}')));
    const password = requests.find(req => req.path === '/api/password').body;
    assert.equal(password.current, credentials.password); assert.notEqual(password.next, password.next2);
    assert.ok(requests.slice(1).every(req => req.headers.cookie.includes('webmail_sid=') && req.headers['x-webmail-csrf'] === 'synthetic-csrf'));
  } finally { await server.close(); }
});

test('non-editable Sieve state is explicitly skipped without PUT or restore', async () => {
  for (const state of ['import_pending', 'inactive_other', 'damaged']) {
    const server = await fakeServer({ state });
    try {
      const result = await runProbe(server.url, credentials);
      const row = result.rows.find(row => row.request === 'Sieve 기호 규칙 저장');
      assert.equal(row.source, '건너뜀'); assert.equal(row.business, `건너뜀(상태: ${state})`);
      assert.equal(result.code, 2);
      assert.equal(server.requests.filter(req => req.path === '/api/rules' && req.method === 'PUT').length, 0);
    } finally { await server.close(); }
  }
});

test('none Sieve state saves an app-valid symbol rule and restores the document', async () => {
  const server = await fakeServer({ state: 'none', save: true });
  try {
    const result = await runProbe(server.url, credentials);
    assert.equal(result.code, 0);
    const writes = server.requests.filter(req => req.path === '/api/rules' && req.method === 'PUT');
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].body.doc, original);
  } finally { await server.close(); }
});

test('artifact listing reads only matching folders/draft envelopes and emits JSON lines with counts', async () => {
  const name = 'Int-00000000-0000-0000-0000-000000000001';
  const calls = [];
  const client = {
    list: async () => [{ path: name }, { path: 'IntExcluded' }, { path: 'Int-user-folder' }, { path: 'Drafts', specialUse: '\\Drafts' }],
    status: async (path, query) => { calls.push(['status', path, query]); return { messages: 1 }; },
    mailboxOpen: async (path, options) => {
      calls.push(['open', path, options]); client.mailbox = { exists: 7, uidValidity: 123n };
    },
    async *fetch(set, query, options) {
      calls.push(['fetch', set, query, options]);
      for (const [i, subject] of ['합성 WAF HTML 시험', 'plain', 'full', 'noscript', name, '추가 진단', '일반 초안'].entries()) {
        yield { uid: i + 1, envelope: { subject, from: [{ address: 'sender@example.com' }] }, source: 'body must not be printed' };
      }
    },
  };
  const rows = await listArtifacts(client, { account: 'user7', subjects: ['추가 진단'] });
  assert.equal(rows.filter(row => row.kind === 'folder').length, 2);
  assert.equal(rows.filter(row => row.kind === 'draft').length, 6);
  assert.deepEqual(calls, [
    ['status', name, { messages: true }], ['status', 'IntExcluded', { messages: true }],
    ['open', 'Drafts', { readOnly: true }], ['fetch', '1:*', { uid: true, envelope: true }, { uid: true }],
  ]);
  const output = formatListing('user7', rows);
  const lines = output.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.at(-1), { account: 'user7', kind: 'summary', folders: 2, drafts: 6 });
  assert.equal(lines.find(row => row.kind === 'draft').uidValidity, 123);
  assert.ok(!output.includes('body must not be printed') && !output.includes('sender@example.com'));
  assert.deepEqual(parseArgs(['--users', 'user1,user7,user1', '--subject', '별도 진단']), { users: ['user1', 'user7'], subjects: ['별도 진단'] });
  assert.throws(() => parseArgs(['--delete', name]));
});

test('automatic IP limiter uses six distinct synthetic accounts and no spoofed XFF', async () => {
  const attempts = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    attempts.push({ body: JSON.parse(Buffer.concat(chunks)), headers: req.headers });
    res.writeHead(attempts.length < 6 ? 403 : 429, { 'content-type': 'application/json', ...(attempts.length === 6 ? { 'retry-after': '899' } : {}) });
    res.end(JSON.stringify({ error: { code: attempts.length < 6 ? 'AUTH_FAILED' : 'RATE_LIMITED' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const env = { ...process.env, WEBMAIL_INT: '1', WEBMAIL_INT_GROUP: 'core', WEBMAIL_INT_DOMAIN: 'example.com', WEBMAIL_INT_AUTH_INTERVAL_MS: '1',
      WEBMAIL_INT_PASSWORD: credentials.password, WEBMAIL_INT_ORIGIN: 'https://mail.example.com', WEBMAIL_INT_URL: `http://127.0.0.1:${server.address().port}` };
    // This child is an independent test runner, not another worker of this suite.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-name-pattern=같은 출발 IP', fileURLToPath(new URL('../int/integration.test.js', import.meta.url))], {
      timeout: 10000, env,
    });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.equal(attempts.length, 6, output.replaceAll(credentials.password, '[redacted]'));
    assert.equal(new Set(attempts.map(row => row.body.email)).size, 6);
    assert.ok(attempts.every(row => row.body.email.startsWith('invalid-int-') && row.body.email.endsWith('@example.com') && row.headers['x-forwarded-for'] === undefined));
    assert.ok(output.includes('남은 시간: 899초') && !output.includes(credentials.password));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('restore business failure is explicitly reported even though response is application JSON', async () => {
  const server = await fakeServer({ save: true, restoreFail: true });
  try {
    const result = await runProbe(server.url, credentials);
    assert.equal(result.code, 2); assert.equal(result.rows.at(-1).business, '규칙 원복 실패');
  } finally { await server.close(); }
});

async function cli(url) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../int/waf-probe.mjs', import.meta.url)), url], { env: { ...process.env, WEBMAIL_PROBE_EMAIL: credentials.email, WEBMAIL_PROBE_PASSWORD: credentials.password } });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const [code] = await once(child, 'close'); return { code, output };
}
test('CLI table and exit status are correct for app, upstream HTML block and unreachable origin', async () => {
  for (const block of [false, true]) {
    const server = await fakeServer({ block });
    try {
      const result = await cli(server.url);
      assert.equal(result.code, block ? 1 : 0);
      assert.ok(result.output.includes(block ? '앱 아닌 차단/응답' : '웹메일 앱 JSON'));
      assert.ok(!result.output.includes(credentials.password));
    } finally { await server.close(); }
  }
  const closed = await fakeServer(); const url = closed.url; await closed.close();
  const result = await cli(url); assert.equal(result.code, 1); assert.ok(result.output.includes('연결 실패'));
});
