import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { mailTlsOptions } from '../../../server/mail/imap-pool.js';
import { connectManageSieve } from '../../../server/sieve/managesieve.js';

export const groups = ['core', 'mail', 'sieve', 'account'];
const cleanups = new WeakMap();
export function cleanup(t, operation) {
  if (!cleanups.has(t)) {
    const stack = [];
    cleanups.set(t, stack);
    t.after(async () => {
      let failed = false;
      for (const run of stack.reverse()) {
        try { await run(); } catch { failed = true; }
      }
      assert.equal(failed, false, '시험 자료 원복 실패: VM에서 해당 시험 자료/계정 확인 필요');
    });
  }
  cleanups.get(t).push(operation);
}
const selected = (process.env.WEBMAIL_INT_GROUP || groups.join(',')).split(',');
if (process.env.WEBMAIL_INT === '1') assert.ok(selected.every(value => groups.includes(value)), 'WEBMAIL_INT_GROUP 그룹 이름 확인');
export function integration(group, name, body) {
  test(`[${group}] ${name}`, {
    skip: process.env.WEBMAIL_INT !== '1' ? '건너뜀: WEBMAIL_INT=1 없음' : !selected.includes(group) ? '건너뜀: 그룹 제외' : false,
    timeout: 300_000,
  }, async t => {
    // Network/protocol exceptions may contain credentials. Do not report their bodies/stacks.
    try { await body(t); } catch (error) {
      if (error?.code === 'ERR_ASSERTION') throw error;
      throw new Error('통합시험 연결/프로토콜 실패 (요청·암호·쿠키 출력 생략)');
    }
  });
}
export function required(name) {
  assert.ok(process.env[name], `${name} 환경변수 필요`);
  return process.env[name];
}
export const email = (user = 'user1') => `${user}@${required('WEBMAIL_INT_DOMAIN')}`;
export const password = () => required('WEBMAIL_INT_PASSWORD');
export const unique = () => `Int-${randomUUID()}`;
export function tlsConfig() {
  return {
    imapHost: process.env.WEBMAIL_INT_IMAP_HOST || 'dovecot-mailcow',
    sieveHost: process.env.WEBMAIL_INT_IMAP_HOST || 'dovecot-mailcow',
    sievePort: 4190,
    mailTlsServername: required('WEBMAIL_INT_TLS_SERVERNAME'),
    mailTlsMode: process.env.WEBMAIL_INT_TLS_MODE || 'verify',
    mailTlsPinFile: process.env.WEBMAIL_INT_TLS_PIN_FILE || '',
  };
}
export async function imap(t, user = 'user1', pass = password()) {
  const config = tlsConfig();
  const client = new ImapFlow({
    host: config.imapHost, port: 993, secure: true, tls: mailTlsOptions(config),
    auth: { user: email(user), pass }, logger: false, emitLogs: false, logRaw: false,
    disableAutoIdle: true, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 60_000,
  });
  client.on('error', () => {});
  cleanup(t, async () => { try { if (client.usable) await client.logout(); } finally { client.close(); } });
  await client.connect();
  if (client.options?.auth) client.options.auth.pass = '';
  return client;
}
export async function sieve(t, user = 'user1') {
  const secret = Buffer.from(password());
  let client;
  try { client = await connectManageSieve(tlsConfig(), { email: email(user), password: secret }); }
  finally { secret.fill(0); }
  cleanup(t, async () => { try { await client.logout(); } finally { client.close(); } });
  return client;
}
export async function api(user = 'user1', pass = password(), base = process.env.WEBMAIL_INT_URL || 'http://webmail:8080') {
  const origin = required('WEBMAIL_INT_ORIGIN');
  let cookie = '', csrf = '';
  let retryAfter = 0;
  async function request(method, path, payload, expected = 200, extra = {}) {
    const multipart = payload instanceof FormData;
    const response = await fetch(new URL(path, base), {
      method, redirect: 'manual', signal: AbortSignal.timeout(60_000),
      headers: { origin, ...(cookie ? { cookie, 'x-webmail-csrf': csrf } : {}),
        ...(payload === undefined || multipart ? {} : { 'content-type': 'application/json' }), ...extra },
      ...(payload === undefined ? {} : { body: multipart ? payload : JSON.stringify(payload) }),
    });
    assert.equal(response.status, expected, `${method} ${path.split('?')[0]} HTTP 상태`);
    assert.equal(response.headers.has('www-authenticate'), false);
    retryAfter = Number(response.headers.get('retry-after') || 0);
    const body = response.status === 204 ? null : await response.json();
    if (path === '/api/auth/login' && expected === 200) {
      cookie = (response.headers.get('set-cookie') || '').split(';')[0];
      csrf = body.csrf;
      assert.ok(cookie.startsWith('webmail_sid=') && typeof csrf === 'string', '세션/CSRF 발급');
    }
    return body;
  }
  const client = { request, get: path => request('GET', path),
    get retryAfter() { return retryAfter; },
    login: () => request('POST', '/api/auth/login', { email: email(user), password: pass }),
    logout: () => request('POST', '/api/auth/logout', undefined, 204) };
  return client;
}
export async function login(t, user = 'user1', pass = password()) {
  const client = await api(user, pass);
  await client.login();
  cleanup(t, () => client.logout());
  return client;
}
export function message(subject, to = 'recipient@example.com', extra = '') {
  return Buffer.from(`From: Synthetic Sender <sender@example.com>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@example.com>\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n${extra}\r\nSynthetic integration message.\r\n`);
}
export async function scratch(t, web, direct, count = 0) {
  const name = unique();
  await web.request('POST', '/api/folders', { name }, 201);
  cleanup(t, async () => {
    if (direct.mailbox?.path === name) await direct.mailboxClose();
    await web.request('POST', `/api/folders/${encodeURIComponent(name)}/empty`, { confirmName: name });
    await web.request('DELETE', `/api/folders/${encodeURIComponent(name)}`, undefined, 204);
  });
  for (let i = 0; i < count; i++) await direct.append(name, message(`${name}-${i}`));
  return name;
}
export async function eventually(operation, check, label) {
  // SMTP delivery/index visibility only; fixed upper bound, no API error suppression.
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await operation();
    if (check(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.fail(`${label}: 30초 이내 반영되지 않음`);
}
