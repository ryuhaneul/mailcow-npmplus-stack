import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRelayFiles, renderRelayFiles, validateRelayIp, relayNetwork, writeRelayFiles } from '../../server/admin/relay-files.js';
import { createRelayService } from '../../server/admin/services/relay.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createDockerApi } from '../../server/admin/dockerapi.js';
import { createLogsService } from '../../server/admin/services/logs.js';

const config = { mailcowIpv4Network: '172.22.1', mailcowIpv6Network: 'fd4d:6169:6c63:6f77::/64' };
const fixed = ['!192.0.2.7', '![2001:db8:ffff::7]', '127.0.0.0/8', '[::ffff:127.0.0.0]/104', '[::1]/128', '[fe80::]/10', '172.22.1.0/24', '[fd4d:6169:6c63:6f77::]/64'];
const baseExtra = fixed.map(raw => `# mailstack-fixed ${raw}\n`).join('');
const baseOptions = fixed.filter(raw => !raw.startsWith('!')).join('\n') + '\n';
for (const ip of ['203.0.113.8', '203.0.113.0/24', '2001:db8:1::8', '2001:db8:2::/64']) test(`relay map add/remove ${ip}`, () => {
  const parsed = parseRelayFiles(baseExtra, baseOptions, config);
  const added = validateRelayIp(ip, parsed, config), contents = renderRelayFiles(parsed, [added]);
  const next = parseRelayFiles(...contents, config); assert.equal(next.consistent, true); assert.deepEqual(next.ips, [added]);
  const removed = renderRelayFiles(next, []);
  assert.deepEqual(removed, [baseExtra, baseOptions]);
  for (const item of fixed) assert.ok(contents[0].includes(`# mailstack-fixed ${item}`));
});
test('relay default map retains exactly its original internal fixed networks', () => {
  const internal = '172.22.1.0/24\n[fd4d:6169:6c63:6f77::]/64\n';
  const parsed = parseRelayFiles(baseExtra, internal, config);
  const rendered = renderRelayFiles(parsed, ['203.0.113.8']);
  assert.equal(rendered[1], internal + '203.0.113.8\n');
  assert.deepEqual(renderRelayFiles(parseRelayFiles(...rendered, config), []), [baseExtra, internal]);
});
test('relay validates prefix bounds, duplicates, overlap and alternate IPv6 spelling', () => {
  const parsed = parseRelayFiles(baseExtra, baseOptions, config);
  for (const ip of ['0.0.0.0/0', '192.0.2.0/23', '2001:db8::/63', '127.1.2.3', '169.254.0.1/999', 'fe80::7', '172.22.1.7', 'fd4d:6169:6c63:6f77::7', '192.0.2.7', '2001:db8:ffff::7', 'bad', '1.2.3.4\nfoo']) assert.throws(() => validateRelayIp(ip, parsed, config), { statusCode: 422 });
  assert.equal(validateRelayIp('198.51.100.99/24', parsed, config), '198.51.100.0/24');
  assert.equal(relayNetwork('2001:DB8::1').ip, relayNetwork('2001:db8:0:0:0:0:0:1').ip);
  const duplicate = parseRelayFiles(baseExtra + '192.0.2.0/24\n', baseOptions + '192.0.2.0/24\n', config);
  assert.throws(() => validateRelayIp('192.0.2.99/24', duplicate, config), { statusCode: 422, code: 'RELAY_OVERLAP' });
});
test('relay refuses legacy syntax, include paths, exclusions and malformed map rows', () => {
  for (const extra of ['mynetworks = 127.0.0.0/8\n', '/etc/other\n', '!192.0.2.8\n', '192.0.2.8, 192.0.2.9\n', '[bad]\n']) assert.throws(() => parseRelayFiles(extra, baseOptions, config), { statusCode: 409, code: 'RELAY_LAYOUT' });
});
async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'webmail-relay-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all(['postfix', 'rspamd'].map(name => mkdir(join(dir, name))));
  const paths = [join(dir, 'postfix', 'mynetworks'), join(dir, 'rspamd', 'local_addrs.map')]; await Promise.all(paths.map((path, i) => writeFile(path, [baseExtra, baseOptions][i])));
  await writeFile(join(dir, 'postfix', 'conversion.json'), '{"version":2}');
  const audit = createAudit({ dir: join(dir, 'audit') }), lock = createResourceLock(), history = createHistoryService({ audit, lock }), calls = [];
  let failed = false;
  const dockerapi = { reload: async name => { calls.push(name); if (overrides.reloadFail && (!failed || overrides.alwaysFail)) { failed = true; throw new Error('synthetic'); } } };
  const mailcow = { call: async (_session, _method, path) => {
    if (path.includes('/logs/')) return overrides.logRows ?? [];
    if (overrides.stopped) return { a: { container: 'postfix-mailcow', state: 'exited' } };
    return { a: { container: 'postfix-mailcow', state: 'running' }, b: { container: 'rspamd-mailcow', state: 'running' } };
  } };
  let clock = 0;
  const service = createRelayService({ config: { ...config, relayFiles: paths }, audit, lock, history, dockerapi, mailcow, logs: createLogsService({ mailcow, config }), backupDir: join(dir, 'backups'), now: () => clock, wait: async ms => { clock += ms; } });
  const args = async (extra = {}) => ({ actor: 'admin', ip: '192.0.2.44', session: {}, data: { ip: '203.0.113.8', note: '문서용 릴레이', etag: (await service.list()).etag, confirmRestart: true, ...extra } });
  return { dir, paths, audit, history, service, calls, args };
}
test('relay atomic writer and successful service writes create private backups and metadata', async t => {
  const f = await setup(t), before = await Promise.all(f.paths.map(path => stat(path)));
  await f.service.create(await f.args());
  assert.deepEqual(f.calls, ['postfix-mailcow']);
  const listed = await f.service.list(); assert.deepEqual(listed.items.map(row => row.ip), ['203.0.113.8']); assert.equal(listed.items[0].note, '문서용 릴레이'); assert.equal(listed.items[0].actor, 'admin'); assert.ok(listed.items[0].date);
  for (let i = 0; i < 2; i++) assert.notEqual((await stat(f.paths[i])).ino, before[i].ino);
  const backups = await readdir(join(f.dir, 'backups')); assert.equal(backups.length, 1);
  for (const [i, name] of ['mynetworks', 'local_addrs.map'].entries()) { const path = join(f.dir, 'backups', backups[0], name); assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(await readFile(path, 'utf8'), [baseExtra, baseOptions][i]); }
  await f.service.remove({ ...(await f.args()), address: '203.0.113.8', data: { etag: listed.etag, confirmRestart: true } });
  assert.deepEqual((await f.service.list()).items, []);
});
test('relay mismatch and stale etag reject writes before backups, disabled is 404', async t => {
  const f = await setup(t), stale = await f.args();
  await writeFile(f.paths[0], `${baseExtra}# changed\n`);
  await assert.rejects(f.service.create(stale), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  await writeFile(f.paths[0], baseExtra + '203.0.113.9\n');
  assert.equal((await f.service.list()).consistent, false);
  await assert.rejects(f.service.create(await f.args()), { statusCode: 409, code: 'RELAY_MISMATCH' });
  assert.equal(f.calls.length, 0);
  const disabled = createRelayService({ config: { ...config, relayFiles: [] }, history: { register() {} } });
  await assert.rejects(disabled.list(), { statusCode: 404, code: 'RELAY_DISABLED' });
});
for (const failure of ['reloadFail', 'stopped', 'alwaysFail']) test(`relay ${failure}: restores bytes, result is partial`, async t => {
  const f = await setup(t, { reloadFail: true, ...(failure === 'stopped' ? { reloadFail: false, stopped: true } : {}), ...(failure === 'alwaysFail' ? { alwaysFail: true } : {}) });
  await assert.rejects(f.service.create(await f.args()), { statusCode: 502, code: 'RELAY_APPLY_FAILED' });
  assert.equal(await readFile(f.paths[0], 'utf8'), baseExtra); assert.equal(await readFile(f.paths[1], 'utf8'), baseOptions);
  const { rows } = await f.audit.read(); assert.equal(rows.at(-1).result, 'partial'); assert.equal(rows.at(-1).detail.restored, failure === 'reloadFail'); assert.ok(f.calls.length >= 2);
});
test('relay audit intent failure performs no writes or restart', async t => {
  const f = await setup(t), audit = { read: () => f.audit.read(), run: async () => { throw new Error('intent failed'); } };
  const service = createRelayService({ config: { ...config, relayFiles: f.paths }, audit, lock: createResourceLock(), history: { register() {} }, dockerapi: { reload() { throw new Error('must not call'); } }, backupDir: join(f.dir, 'other-backups') });
  await assert.rejects(service.create(await f.args()), /intent failed/); assert.equal(await readFile(f.paths[0], 'utf8'), baseExtra);
});
test('relay history restores exact bytes, can undo the revert, and refuses drift', async t => {
  const f = await setup(t), created = await f.service.create(await f.args());
  const reverted = await f.history.revert(created.auditId, { confirm: true, actor: 'admin', ip: '192.0.2.44', session: {} });
  assert.equal(await readFile(f.paths[0], 'utf8'), baseExtra);
  await f.history.revert(reverted.id, { confirm: true, actor: 'admin', ip: '192.0.2.44', session: {} });
  assert.equal((await f.service.list()).items.length, 1);
  await writeFile(f.paths[0], `${await readFile(f.paths[0], 'utf8')}# drift\n`);
  await assert.rejects(f.history.revert(created.auditId, { confirm: true, actor: 'admin', ip: '192.0.2.44', session: {} }), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
});
test('relay recent reuses bounded postfix logs, counts client IP only, exposes address-only samples', async t => {
  const f = await setup(t, { logRows: [{ time: '3', program: 'postfix/smtpd', message: 'client=example[203.0.113.8], from=<hidden@example.com>' }, { time: '2', message: 'client=other[203.0.113.8]' }, { time: '1', message: '203.0.113.8 mentioned but not client' }, { time: '0', message: 'client=other[203.0.113.9]' }] });
  const result = await f.service.recent({}, '203.0.113.8'); assert.equal(result.count, 2); assert.equal(result.lastSeen, '3'); assert.deepEqual(result.examples, ['203.0.113.8', '203.0.113.8']); assert.equal(result.notice, '최근 로그 1000줄 안에서'); assert.equal(result.range.count, 4);
});
test('relay writer atomically replaces shorter contents', async t => {
  const f = await setup(t); const initial = await stat(f.paths[0]); await writeRelayFiles(f.paths, ['short', 'x']); assert.equal(await readFile(f.paths[0], 'utf8'), 'short'); assert.notEqual((await stat(f.paths[0])).ino, initial.ino);
});

test('relay rejects reload names outside Postfix without network access', async () => {
  const api = createDockerApi({ config: { dockerapiUrl: 'https://dockerapi:443' } });
  for (const name of ['rspamd-mailcow', 'dovecot-mailcow', 'mysql-mailcow', '../restart', '', null]) await assert.rejects(api.reload(name), { statusCode: 422, code: 'DOCKERAPI_TASK_NOT_ALLOWED' });
});
test('relay enabled with one missing file is layout conflict; both missing disables feature', async t => {
  const f = await setup(t);
  await rm(f.paths[0]); await assert.rejects(f.service.list(), { statusCode: 409, code: 'RELAY_LAYOUT' });
  await rm(f.paths[1]); await assert.rejects(f.service.list(), { statusCode: 404, code: 'RELAY_DISABLED' });
});

test('relay conversion pending blocks changes before writing or reload', async t => {
  const f = await setup(t), args = await f.args();
  await rm(join(f.dir, 'postfix', 'conversion.json'));
  await assert.rejects(f.service.create(args), { statusCode: 409, code: 'RELAY_CONVERSION_PENDING' });
  assert.deepEqual(f.calls, []); assert.equal(await readFile(f.paths[0], 'utf8'), baseExtra);
});
test('relay legacy audit records stay intact and cannot revert', async t => {
  const f = await setup(t);
  const old = await f.audit.run({ actor: 'admin', ip: '192.0.2.44', action: 'relay.change', target: 'relay', kind: 'config', revertible: true, before: { ips: [], files: ['old','old'] }, after: { ips: [], files: ['old','old'] } }, async intent => ({ result: 'ok', auditId: intent.id }));
  const prior = JSON.stringify(await f.audit.read());
  const record = await f.history.detail(old.auditId ?? old.id);
  assert.equal(record.canRevert, false); assert.match(record.revertReason, /이전 방식 기록/);
  await assert.rejects(f.history.revert(record.id, { confirm: true, actor: 'admin', ip: '192.0.2.44', session: {} }), { statusCode: 409, code: 'NOT_REVERTIBLE' });
  assert.equal(JSON.stringify(await f.audit.read()), prior);
});
for (const index of [0, 1]) test(`relay write failure at file ${index + 1} records partial and restores bytes`, { skip: process.getuid?.() === 0 }, async t => {
  const f = await setup(t), args = await f.args(), directory = join(f.dir, index === 0 ? 'postfix' : 'rspamd');
  await chmod(directory, 0o555); t.after(() => chmod(directory, 0o755).catch(() => {}));
  try {
    await assert.rejects(f.service.create(args), { statusCode: 502, code: 'RELAY_APPLY_FAILED' });
    assert.equal(await readFile(f.paths[0], 'utf8'), baseExtra);
    assert.equal(await readFile(f.paths[1], 'utf8'), baseOptions);
    const { rows } = await f.audit.read(); assert.equal(rows.at(-1).result, 'partial'); assert.equal(rows.at(-1).detail.restored, false);
  } finally { await chmod(directory, 0o755); }
});

test('dockerapi reload validates the fixed payload and rejects command errors, bad JSON and timeout', async t => {
  const https = await import('node:https');
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'relay-api-tls-')); t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=dockerapi', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const cert = await readFile(join(dir, 'cert.pem')), key = await readFile(join(dir, 'key.pem'));
  const calls = []; let mode = 'success';
  const server = https.createServer({ key, cert }, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/containers/json') return res.end(JSON.stringify({ abc123: { Id: 'abc123', Config: { Labels: { 'com.docker.compose.service': 'postfix-mailcow' }, Env: ['SYNTHETIC_SECRET=not-for-response'] } } }));
    assert.equal(req.url, '/containers/abc123/exec');
    if (mode === 'timeout') return;
    res.end(mode === 'json' ? 'bad JSON' : JSON.stringify({ type: mode, msg: 'synthetic upstream detail' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const api = createDockerApi({ config: { dockerapiUrl: `https://127.0.0.1:${server.address().port}` }, ca: cert });
  assert.deepEqual(await api.reload('postfix-mailcow'), { type: 'success' });
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/containers/abc123/exec', body: { cmd: 'reload', task: 'postfix' } });
  for (mode of ['danger', 'json', 'timeout']) await assert.rejects(api.reload('postfix-mailcow'), error => {
    assert.equal(error.code, mode === 'timeout' ? 'DOCKERAPI_UNAVAILABLE' : 'DOCKERAPI_REJECTED');
    assert.ok(!error.message.includes('synthetic upstream detail')); return true;
  });
});
