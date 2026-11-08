// Isolated VM only. Protocol errors and HTTP bodies may contain secrets: never print them.
import { test } from 'node:test';
import { connect as tcpConnect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const ids = Array.from({ length: 16 }, (_, i) => `V${String(i + 1).padStart(2, '0')}`);
const condition = process.env.NETLIMIT_INT_CONDITION || 'baseline';
const common = ['SYNTHETIC', 'HOST', 'SMTP_HOST', 'SMTP588_HOST', 'TLS_SERVERNAME', 'EMAIL', 'PASSWORD', 'SOURCE_A', 'SOURCE_B', 'ADMIN_URL', 'ADMIN_ORIGIN', 'ADMIN_KEY', 'RELAY_IP', 'MAILCOW_URL', 'MAILCOW_KEY', 'SMTP588_MODE'];
const extra = condition === 'baseline' ? [] : ['OFF_EMAIL', 'DISABLED_EMAIL', 'PRESEEDED', 'BASELINE_MS'];
const missing = [...common, ...extra].filter(key => !process.env[`NETLIMIT_INT_${key}`]);
const skip = process.env.NETLIMIT_INT !== '1' ? '미실행 — NETLIMIT_INT=1 없음' : missing.length ? `미실행 — 입력 없음: ${missing.map(key => `NETLIMIT_INT_${key}`).join(',')}` : false;
function ensure(value, code) { if (!value) throw Error(code); }
const env = key => process.env[`NETLIMIT_INT_${key}`];
const mailboxPath = email => `/api/admin/mailboxes/${encodeURIComponent(email)}`;
const safe = operation => async () => { try { await operation(); } catch { throw Error('NETLIMIT_CHECK_FAILED (sensitive details omitted)'); } };
const protocols = ['imap', 'pop3', 'smtp'];
const stats = values => { const sorted = [...values].sort((a, b) => a - b); return { min: sorted[0], median: sorted[2], max: sorted.at(-1) }; };

// A bounded line reader keeps credentials and server diagnostics out of assertions.
class Lines {
  constructor(socket) {
    this.socket = socket; this.buffer = ''; this.lines = []; this.waiter = null; this.closed = false;
    this.data = chunk => {
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > 65536) { socket.destroy(); return; }
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) { this.lines.push(this.buffer.slice(0, end).replace(/\r$/, '')); this.buffer = this.buffer.slice(end + 1); }
      if (this.lines.length > 1000) socket.destroy();
      this.flush();
    };
    this.end = () => { this.closed = true; this.flush(); };
    socket.on('data', this.data); socket.on('error', this.end); socket.on('close', this.end);
    socket.setTimeout(12000, () => socket.destroy());
  }
  flush() { if (this.waiter && (this.lines.length || this.closed)) { const waiter = this.waiter; this.waiter = null; waiter(); } }
  async line() {
    if (!this.lines.length && !this.closed) await new Promise(resolve => { this.waiter = resolve; });
    ensure(this.lines.length, 'PROTOCOL_CONNECTION_FAILED'); return this.lines.shift();
  }
  write(value) { this.socket.write(value + '\r\n'); }
  detach() { this.socket.removeListener('data', this.data); this.socket.removeListener('error', this.end); this.socket.removeListener('close', this.end); }
}
async function open(port, source, secure) {
  const options = { host: port === 588 ? env('SMTP588_HOST') : [465, 587, 25].includes(port) ? env('SMTP_HOST') : env('HOST'), port, localAddress: source, servername: env('TLS_SERVERNAME'), rejectUnauthorized: true,
    ...(env('CA_FILE') ? { ca: readFileSync(env('CA_FILE')) } : {}) };
  const socket = secure ? tlsConnect(options) : tcpConnect(options);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.destroy(); reject(Error('CONNECT_TIMEOUT')); }, 10000);
    socket.once('error', () => { clearTimeout(timer); reject(Error('CONNECT_FAILED')); });
    socket.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(); }); });
  ensure(socket.localAddress === source || socket.localAddress === `::ffff:${source}`, 'SOURCE_BIND_MISMATCH');
  return new Lines(socket);
}
async function imap(source, password = env('PASSWORD'), spoof) {
  const lines = await open(993, source, true);
  try {
    ensure(/^\* OK\b/i.test(await lines.line()), 'IMAP_GREETING');
    if (spoof) {
      lines.write(`i ID ("name" "mailstack-webmail" "x-originating-ip" ${JSON.stringify(spoof)})`);
      while (!/^i (OK|NO|BAD)\b/i.test(await lines.line())) { /* consume ID reply, never log */ }
    }
    lines.write(`a LOGIN ${JSON.stringify(env('EMAIL'))} ${JSON.stringify(password)}`);
    for (;;) { const reply = await lines.line(); if (/^a OK\b/i.test(reply)) return true; if (/^a NO\b/i.test(reply)) return false; ensure(!/^a BAD\b/i.test(reply), 'IMAP_COMMAND_FAILED'); }
  } finally { lines.socket.destroy(); }
}
async function pop3(source, password = env('PASSWORD'), email = env('EMAIL')) {
  const lines = await open(995, source, true);
  try { ensure((await lines.line()).startsWith('+OK'), 'POP3_GREETING'); lines.write(`USER ${email}`); ensure((await lines.line()).startsWith('+OK'), 'POP3_USER');
    lines.write(`PASS ${password}`); const reply = await lines.line(); ensure(/^(\+OK|-ERR)/.test(reply), 'POP3_REPLY'); return reply.startsWith('+OK');
  } finally { lines.socket.destroy(); }
}
async function smtp(source, port, password = env('PASSWORD'), email = env('EMAIL')) {
  let lines = await open(port, source, port === 465);
  async function response() { let reply = await lines.line(); ensure(/^\d{3}[- ]/.test(reply), 'SMTP_REPLY'); const code = reply.slice(0, 3); let count = 0;
    while (reply[3] === '-') { ensure(++count < 100, 'SMTP_REPLY_LIMIT'); reply = await lines.line(); ensure(reply.startsWith(code), 'SMTP_MULTILINE'); } return Number(code); }
  try {
    ensure(await response() === 220, 'SMTP_GREETING'); lines.write('EHLO netlimit-int.example.test'); ensure(await response() === 250, 'SMTP_EHLO');
    if (port !== 465 && !(port === 588 && env('SMTP588_MODE') === 'plain')) {
      lines.write('STARTTLS'); ensure(await response() === 220, 'SMTP_STARTTLS'); const socket = lines.socket; lines.detach();
      const secure = tlsConnect({ socket, servername: env('TLS_SERVERNAME'), rejectUnauthorized: true, ...(env('CA_FILE') ? { ca: readFileSync(env('CA_FILE')) } : {}) });
      secure.setTimeout(12000, () => secure.destroy());
      await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', () => reject(Error('TLS_FAILED'))); });
      lines = new Lines(secure); lines.write('EHLO netlimit-int.example.test'); ensure(await response() === 250, 'SMTP_TLS_EHLO');
    }
    lines.write(`AUTH PLAIN ${Buffer.from(`\0${email}\0${password}`).toString('base64')}`);
    const code = await response(); ensure(code === 235 || code === 535, 'SMTP_AUTH_NOT_EXERCISED'); return code === 235;
  } finally { lines.socket.destroy(); }
}
// IMAP identity override is used only by the preseeded fault matrix.
async function auth(protocol, source, password = env('PASSWORD'), email = env('EMAIL')) {
  if (protocol === 'imap' && email !== env('EMAIL')) {
    const lines = await open(993, source, true);
    try { ensure(/^\* OK\b/i.test(await lines.line()), 'IMAP_GREETING'); lines.write(`a LOGIN ${JSON.stringify(email)} ${JSON.stringify(password)}`);
      for (;;) { const reply = await lines.line(); if (/^a OK\b/i.test(reply)) return true; if (/^a NO\b/i.test(reply)) return false; ensure(!/^a BAD\b/i.test(reply), 'IMAP_COMMAND_FAILED'); }
    } finally { lines.socket.destroy(); }
  }
  return protocol === 'imap' ? imap(source, password) : protocol === 'pop3' ? pop3(source, password, email) : smtp(source, Number(protocol.slice(4)), password, email);
}
const authPaths = ['imap', 'pop3', 'smtp465', 'smtp587', 'smtp588', 'smtp25'];
async function request(method, path, body, { mailcow = false, status = 200 } = {}) {
  const response = await fetch(new URL(path, env(mailcow ? 'MAILCOW_URL' : 'ADMIN_URL')), { method, redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { origin: env('ADMIN_ORIGIN'), [mailcow ? 'x-api-key' : 'x-mailadmin-api-key']: env(mailcow ? 'MAILCOW_KEY' : 'ADMIN_KEY'), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  ensure(response.status === status && !response.headers.has('www-authenticate'), 'API_STATUS');
  const result = await response.json();
  if (mailcow && method !== 'GET') ensure(Array.isArray(result) && result.length > 0 && result.every(item => item.type === 'success'), 'MAILCOW_BUSINESS_FAILURE');
  return result;
}
const detail = (email = env('EMAIL')) => request('GET', mailboxPath(email));
async function patch(data, email = env('EMAIL')) { const before = await detail(email); const result = await request('PATCH', mailboxPath(email), { etag: before.etag, ...data }); ensure(result.result === 'ok', 'PATCH_PARTIAL'); return result; }
async function replaceIps(values) {
  const before = await request('GET', '/api/admin/login-ips');
  for (const item of before.items) await request('DELETE', `/api/admin/login-ips/${encodeURIComponent(item.ip)}`);
  for (const item of values) await request('POST', '/api/admin/login-ips', { ip: item.ip, note: item.note || '' });
}
async function aliases(email) { const list = await request('GET', `/api/admin/aliases?q=${encodeURIComponent(email)}`); return list.items.find(item => item.address === email); }
async function removeMailbox(email) {
  const found = await fetch(new URL(mailboxPath(email), env('ADMIN_URL')), { headers: { 'x-mailadmin-api-key': env('ADMIN_KEY') }, signal: AbortSignal.timeout(60000) });
  if (found.status === 404) return;
  ensure(found.status === 200, 'CLEANUP_LOOKUP');
  const preview = await request('POST', mailboxPath(email) + '/delete-preview', {});
  const result = await request('DELETE', mailboxPath(email), { etag: preview.etag, confirmAddress: email, cleanRefs: true }); ensure(result.result === 'ok', 'CLEANUP_DELETE');
}
async function removeAlias(email) { const found = await aliases(email); if (found) await request('DELETE', `/api/admin/aliases/${encodeURIComponent(email)}`, { etag: found.etag, confirmAddress: email }); }
function validate() {
  ensure(['baseline', 'policy503', 'refused', 'blackhole', 'coldstart'].includes(condition), 'CONDITION_INVALID');
  ensure(env('SYNTHETIC') === '1' && /^netlimit-int-[a-z0-9-]+@[^@]+\.test$/i.test(env('EMAIL')), 'DEDICATED_SYNTHETIC_REQUIRED');
  ensure(isIP(env('SOURCE_A')) && isIP(env('SOURCE_B')) && env('SOURCE_A') !== env('SOURCE_B') && isIP(env('RELAY_IP')), 'SOURCE_INVALID');
  ensure(['starttls', 'plain'].includes(env('SMTP588_MODE')), 'SMTP588_MODE_INVALID');
  for (const key of ['EMAIL', 'PASSWORD', 'OFF_EMAIL', 'DISABLED_EMAIL']) ensure(!/[\r\n\0]/.test(env(key) || ''), 'CREDENTIAL_FORMAT');
  for (const key of ['ADMIN_URL', 'MAILCOW_URL', 'ADMIN_ORIGIN']) { const url = new URL(env(key)); ensure(url.protocol === 'https:' && !url.username && !url.password, 'HTTPS_REQUIRED'); }
  if (condition !== 'baseline') {
    ensure(env('PRESEEDED') === '1' && Number.isFinite(Number(env('BASELINE_MS'))) && Number(env('BASELINE_MS')) >= 0, 'FAULT_PRESEED_REQUIRED');
    ensure([env('OFF_EMAIL'), env('DISABLED_EMAIL')].every(value => /^netlimit-int-[a-z0-9-]+@[^@]+\.test$/i.test(value)) && new Set([env('EMAIL'), env('OFF_EMAIL'), env('DISABLED_EMAIL')]).size === 3, 'FAULT_ACCOUNTS_INVALID');
  }
}

if (skip) {
  for (const id of ids) test(`${id} netlimit VM`, { skip }, () => {});
} else {
  test(`netlimit VM ${['baseline', 'policy503', 'refused', 'blackhole', 'coldstart'].includes(condition) ? condition : 'invalid'}`, { timeout: 1800000 }, async t => {
    try { validate(); } catch { throw Error('NETLIMIT_INPUT_INVALID (values omitted)'); }
    let original, originalIps, appName, appPassword; const temporary = new Set(); let changed = false;
    let failed = false;
    const run = async (id, fn) => { await t.test(id, safe(async () => { ensure(!failed, 'PREREQUISITE_FAILED'); try { await fn(); } catch { failed = true; throw Error('CHECK_FAILED'); } })); };
    const checkAuth = async (path, source, expected, password, email) => ensure(await auth(path, source, password, email) === expected, 'AUTH_EXPECTATION');
    try {
      if (condition !== 'baseline') {
        // Faults are already injected by the operator. No admin/DB writes or app-password creation here.
        await run('V11 preseeded ON/OFF/protocol-OFF and wrong-password matrix', async () => {
          for (const path of authPaths) for (const source of [env('SOURCE_A'), env('SOURCE_B')]) {
            for (const email of [env('EMAIL'), env('OFF_EMAIL')]) await checkAuth(path, source, true, env('PASSWORD'), email);
            await checkAuth(path, source, false, env('PASSWORD'), env('DISABLED_EMAIL'));
            await checkAuth(path, source, false, `Wrong-${randomUUID()}!`);
          }
        });
      } else {
        original = await detail(); originalIps = await request('GET', '/api/admin/login-ips');
        ensure(original.active === 1 && original.protocols && Array.isArray(originalIps.items), 'INITIAL_STATE_INVALID');
        changed = true;
        await patch({ protocolInternalOnly: false, protocols: Object.fromEntries(protocols.map(key => [key, true])) });
        await replaceIps([{ ip: env('SOURCE_A'), note: 'netlimit integration source A' }]);
        await run('V02 IMAP/POP3 ON/OFF by two bound sources', async () => {
          for (const flag of [false, true]) { await patch({ protocolInternalOnly: flag }); for (const path of ['imap', 'pop3']) for (const source of [env('SOURCE_A'), env('SOURCE_B')]) await checkAuth(path, source, !flag || source === env('SOURCE_A')); }
        });
        await run('V03 immediate authentication after cache warm-up', async () => { await patch({ protocolInternalOnly: true }); for (const path of ['imap', 'pop3']) { await checkAuth(path, env('SOURCE_A'), true); await checkAuth(path, env('SOURCE_A'), true); await checkAuth(path, env('SOURCE_B'), false); } });
        await run('V04 fresh flag and list on the next connection', async () => {
          await patch({ protocolInternalOnly: false }); await checkAuth('imap', env('SOURCE_B'), true);
          await patch({ protocolInternalOnly: true }); await checkAuth('imap', env('SOURCE_B'), false);
          await replaceIps([{ ip: env('SOURCE_B') }]); await checkAuth('imap', env('SOURCE_B'), true); await checkAuth('imap', env('SOURCE_A'), false);
          await replaceIps([{ ip: env('SOURCE_A') }]);
        });
        appName = `netlimit-int-${randomUUID()}`; appPassword = `Int-${randomUUID()}!aA9`;
        await request('POST', '/api/v1/add/app-passwd', { username: env('EMAIL'), app_name: appName, app_passwd: appPassword, app_passwd2: appPassword, active: '1', protocols: ['imap_access', 'pop3_access', 'smtp_access'] }, { mailcow: true });
        await run('V05 SMTP AUTH on 465/587/588/25 with password and app password', async () => {
          for (const password of [env('PASSWORD'), appPassword]) { await patch({ protocolInternalOnly: true }); for (const path of authPaths.filter(value => value.startsWith('smtp'))) { await checkAuth(path, env('SOURCE_A'), true, password); await checkAuth(path, env('SOURCE_B'), false, password); }
            await patch({ protocolInternalOnly: false }); for (const path of authPaths.filter(value => value.startsWith('smtp'))) await checkAuth(path, env('SOURCE_B'), true, password); }
        });
        await run('V06 app password IMAP/POP3 from both sources', async () => { await patch({ protocolInternalOnly: true }); for (const path of ['imap', 'pop3']) { await checkAuth(path, env('SOURCE_A'), true, appPassword); await checkAuth(path, env('SOURCE_B'), false, appPassword); } });
        await run('V08 spoofed client name and originating address do not exempt B', async () => { for (const spoof of [env('SOURCE_A'), env('RELAY_IP')]) ensure(await imap(env('SOURCE_B'), env('PASSWORD'), spoof) === false, 'SPOOF_EXEMPTION'); });
        await run('V14 account API conflict, audit/undo, rename/delete/convert/recreate', async () => {
          const domain = env('EMAIL').split('@')[1], local = `netlimit-int-${randomUUID()}`, first = `${local}@${domain}`, next = `${local}-renamed@${domain}`;
          for (const email of [first, next]) { await request('GET', mailboxPath(email), undefined, { status: 404 }); ensure(!await aliases(email), 'TEMP_ADDRESS_EXISTS'); }
          temporary.add(first); temporary.add(next);
          const create = email => request('POST', '/api/admin/mailboxes', { local: email.split('@')[0], domain, kind: 'personal', quotaGb: 1, name: 'Network policy integration', password: env('PASSWORD') });
          ensure((await create(first)).result === 'ok', 'CREATE'); let before = await detail(first); ensure(before.protocolInternalOnly === false, 'DEFAULT_FLAG');
          for (const invalid of [null, 'true', 1, {}]) await request('PATCH', mailboxPath(first), { etag: before.etag, protocolInternalOnly: invalid }, { status: 422 });
          const on = await patch({ protocolInternalOnly: true }, first); await request('PATCH', mailboxPath(first), { etag: before.etag, protocolInternalOnly: false }, { status: 409 });
          const auditId = on.steps.find(step => step.stage === 'protocol-netlimit' && step.auditId)?.auditId; ensure(auditId, 'AUDIT_ID');
          const audit = await request('GET', `/api/admin/history/${encodeURIComponent(auditId)}`); ensure(audit.action === 'mailbox.protocol-netlimit' && audit.canRevert, 'AUDIT_ACTION');
          await request('POST', `/api/admin/history/${encodeURIComponent(auditId)}/revert`, { confirm: true });
          const undone = await detail(first); ensure(undone.protocolInternalOnly === false && undone.protocolInternalVersion !== on.mailbox.protocolInternalVersion, 'UNDO_VERSION');
          const again = await patch({ protocolInternalOnly: true }, first); await patch({ protocolInternalOnly: false }, first);
          await request('POST', `/api/admin/history/${encodeURIComponent(again.steps.find(step => step.stage === 'protocol-netlimit').auditId)}/revert`, { confirm: true }, { status: 409 });
          await patch({ protocolInternalOnly: true }, first);
          const renameBody = { action: 'preview', newLocal: next.split('@')[0], keepOldAsAlias: true };
          const plan = await request('POST', mailboxPath(first) + '/rename', renameBody);
          ensure((await request('POST', mailboxPath(first) + '/rename', { ...renameBody, action: 'run', etag: plan.etag })).result === 'ok', 'RENAME');
          ensure((await detail(next)).protocolInternalOnly === true, 'RENAME_FLAG'); await removeAlias(first);
          await request('GET', mailboxPath(first), undefined, { status: 404 });
          ensure((await create(first)).result === 'ok' && (await detail(first)).protocolInternalOnly === false, 'RENAME_OLD_RECREATE_FLAG'); await removeMailbox(first);
          const conversion = { action: 'preview', address: next, targets: [env('EMAIL')] };
          const cp = await request('POST', '/api/admin/convert/mailbox-to-alias', conversion);
          ensure((await request('POST', '/api/admin/convert/mailbox-to-alias', { ...conversion, action: 'run', etag: cp.etag })).result === 'ok', 'CONVERT_ALIAS');
          const back = { action: 'preview', address: next, kind: 'personal', quotaGb: 1 };
          const bp = await request('POST', '/api/admin/convert/alias-to-mailbox', back);
          ensure((await request('POST', '/api/admin/convert/alias-to-mailbox', { ...back, action: 'run', etag: bp.etag, password: env('PASSWORD') })).result === 'ok', 'CONVERT_MAILBOX');
          ensure((await detail(next)).protocolInternalOnly === false, 'CONVERT_FLAG'); await patch({ protocolInternalOnly: true }, next); await removeMailbox(next);
          ensure((await create(next)).result === 'ok' && (await detail(next)).protocolInternalOnly === false, 'RECREATE_FLAG');
        });
        await run('V15 protocol OFF, empty list and default flag', async () => {
          await patch({ protocolInternalOnly: true, protocols: Object.fromEntries(protocols.map(key => [key, false])) });
          for (const path of authPaths) await checkAuth(path, env('SOURCE_A'), false);
          await patch({ protocols: Object.fromEntries(protocols.map(key => [key, true])) }); await replaceIps([]);
          const empty = await detail(); ensure(empty.protocolInternalOnly === true && empty.protocolInternalAllowlistEmpty === true, 'EMPTY_LIST_WARNING');
          for (const path of ['imap', 'pop3']) for (const source of [env('SOURCE_A'), env('SOURCE_B')]) await checkAuth(path, source, false);
          await replaceIps([{ ip: env('SOURCE_A') }]); await patch({ protocolInternalOnly: false });
        });
      }
      await run('V12 five monotonic AUTH latency samples', async () => {
        if (condition === 'baseline') await patch({ protocolInternalOnly: true });
        const values = [];
        for (let i = 0; i < 5; i++) { const start = performance.now(); await checkAuth('imap', env('SOURCE_A'), true); values.push(performance.now() - start); }
        const measured = stats(values); t.diagnostic(JSON.stringify({ condition, samples: 5, min: measured.min, median: measured.median, max: measured.max }));
        if (condition === 'blackhole') ensure(measured.median - Number(env('BASELINE_MS')) <= 2500, 'POLICY_DELAY_EXCEEDED');
      });
    } catch { failed = true; throw Error('NETLIMIT_RUN_FAILED (sensitive details omitted)'); }
    finally {
      let restored = true;
      const cleanup = async fn => { try { await fn(); } catch { restored = false; } };
      if (appName) await cleanup(async () => {
        const items = await request('GET', `/api/v1/get/app-passwd/all/${encodeURIComponent(env('EMAIL'))}`, undefined, { mailcow: true });
        const owned = items.filter(item => item.name === appName); if (owned.length) await request('POST', '/api/v1/delete/app-passwd', owned.map(item => String(item.id)), { mailcow: true });
        const after = await request('GET', `/api/v1/get/app-passwd/all/${encodeURIComponent(env('EMAIL'))}`, undefined, { mailcow: true }); ensure(!after.some(item => item.name === appName), 'APP_PASSWORD_CLEANUP');
      });
      for (const email of [...temporary].reverse()) { await cleanup(() => removeMailbox(email)); await cleanup(() => removeAlias(email)); }
      if (changed) {
        await cleanup(() => replaceIps(originalIps.items));
        await cleanup(() => patch({ protocolInternalOnly: original.protocolInternalOnly, protocols: original.protocols }));
        await cleanup(async () => { const current = await detail(); ensure(current.protocolInternalOnly === original.protocolInternalOnly && JSON.stringify(current.protocols) === JSON.stringify(original.protocols), 'FLAG_PROTOCOL_RESTORE');
          const currentIps = await request('GET', '/api/admin/login-ips'); const project = values => JSON.stringify(values.map(({ ip, note }) => ({ ip, note })).sort((a, b) => a.ip.localeCompare(b.ip))); ensure(project(currentIps.items) === project(originalIps.items), 'LIST_RESTORE'); });
      }
      appPassword = undefined;
      ensure(restored, 'NETLIMIT_RESTORE_FAILED (use isolated VM snapshot; details omitted)');
      t.diagnostic(`RESTORE ${condition === 'baseline' ? 'verified' : 'no-runner-mutations'}`);
    }
  });
}
