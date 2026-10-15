import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyResponse, runProbe, exitCode } from '../int/waf-probe.mjs';

const credentials = { email: 'user1@mail.example.com', password: 'synthetic-password' };
const original = { v: 1, rev: 1, rules: [], blocked: [], vacation: { enabled: false, start: null, end: null, subject: '', body: '' } };
async function fakeServer(options = {}) {
  const requests = []; let rev = 1;
  const server = http.createServer(async (req, res) => {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (!req.url.startsWith('/api/attachments')) chunks.push(chunk); }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({ path: req.url, method: req.method, body, size, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    if (options.block && req.url === '/api/drafts') { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<html>blocked</html>'); return; }
    let data;
    if (req.url === '/api/auth/login') { res.setHeader('set-cookie', 'webmail_sid=synthetic-session; HttpOnly; Path=/'); data = { user: { email: credentials.email }, csrf: 'synthetic-csrf' }; }
    else if (req.url === '/api/rules' && req.method === 'GET') data = { rev, doc: original, state: 'ok' };
    else if (req.url === '/api/rules') {
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
    const rules = requests.filter(req => req.path === '/api/rules' && req.method === 'PUT');
    assert.ok(rules[0].body.doc.rules[0].conditions[0].value.includes('${'));
    assert.deepEqual(rules[1].body.doc, original); assert.equal(rules[1].body.baseRev, 2);
    assert.ok(requests.find(req => req.path === '/api/attachments').size > 20 * 1024 * 1024);
    assert.ok(requests.some(req => req.path.startsWith('/api/messages?') && decodeURIComponent(req.path).includes('${value}')));
    const password = requests.find(req => req.path === '/api/password').body;
    assert.equal(password.current, credentials.password); assert.notEqual(password.next, password.next2);
    assert.ok(requests.slice(1).every(req => req.headers.cookie.includes('webmail_sid=') && req.headers['x-webmail-csrf'] === 'synthetic-csrf'));
  } finally { await server.close(); }
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
