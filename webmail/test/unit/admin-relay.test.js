import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRelayFiles, renderRelayFiles, validateRelayIp, relayNetwork, writeRelayInPlace } from '../../server/admin/relay-files.js';
import { createRelayService } from '../../server/admin/services/relay.js';
import { createAudit } from '../../server/admin/audit.js';
import { createResourceLock } from '../../server/admin/lock.js';
import { createHistoryService } from '../../server/admin/services/history.js';
import { createDockerApi } from '../../server/admin/dockerapi.js';
import { createLogsService } from '../../server/admin/services/logs.js';

const config = { mailcowIpv4Network: '172.22.1', mailcowIpv6Network: 'fd4d:6169:6c63:6f77::/64' };
const fixed = '!192.0.2.7, ![2001:db8:ffff::7], 127.0.0.0/8, [::ffff:127.0.0.0]/104, [::1]/128, [fe80::]/10, 172.22.1.0/24, [fd4d:6169:6c63:6f77::]/64';
const optionsFixed = '"127.0.0.0/8", "::ffff:127.0.0.0/104", "::1/128", "fe80::/10", "172.22.1.0/24", "fd4d:6169:6c63:6f77::/64"';
const baseExtra = `# operator\nmynetworks = ${fixed}\n# tail\n`;
const baseOptions = `# rspamd\nlocal_addrs = [${optionsFixed}];\nother = true;\n`;
const cases = [
  ['operator with exclusions', `# mailstack-edge exclusions (apply-postfix-edge.sh): !192.0.2.7, \nmynetworks = ${fixed}, 192.0.2.8\n# tail\n`, `local_addrs = [${optionsFixed}, "192.0.2.8"];\n`],
  ['managed block', `mynetworks = 198.51.100.1\n# unrelated\n# BEGIN mailstack-edge mynetworks (apply-postfix-edge.sh)\nmynetworks = ${fixed}, 192.0.2.8\n# END mailstack-edge mynetworks\n# tail\n`, `local_addrs = [${optionsFixed}, "192.0.2.8"];\n`],
  ['continued lines', `# operator\nmynetworks = ${fixed},\n    192.0.2.8,\n    192.0.2.9\n# tail\n`, `local_addrs = [${optionsFixed},\n "192.0.2.8", "192.0.2.9"];\n`],
  ['IPv6', `mynetworks = ${fixed}, [2001:db8:1::7], [2001:db8:2::]/64\n`, `local_addrs = [${optionsFixed}, "2001:db8:1::7", "2001:db8:2::/64"];\n`],
  ['options list', baseExtra, baseOptions],
  ['options default map', baseExtra, 'local_addrs = /etc/rspamd/custom/mailcow_networks.map;\n# tail\n'],
];
for (const [name, extra, options] of cases) test(`relay fixture: ${name}: add/remove retains fixed items and surroundings`, () => {
  const parsed = parseRelayFiles(extra, options, config); assert.equal(parsed.consistent, true);
  const added = validateRelayIp('203.0.113.8', parsed, config), contents = renderRelayFiles(parsed, [...parsed.ips, added].sort());
  const next = parseRelayFiles(...contents, config); assert.equal(next.consistent, true); assert.ok(next.ips.includes(added));
  const removed = renderRelayFiles(next, parsed.ips), final = parseRelayFiles(...removed, config); assert.deepEqual(final.ips, parsed.ips); assert.equal(final.consistent, true);
  for (const item of parsed.postfix.filter(item => item.fixed)) assert.ok(contents[0].includes(item.raw));
  for (const line of extra.split('\n').filter(line => line.startsWith('#'))) assert.ok(contents[0].includes(`${line}\n`));
  if (name === 'managed block') assert.ok(contents[0].startsWith('mynetworks = 198.51.100.1\n# unrelated\n'));
  if (!parsed.map) assert.equal(removed[1], options);
  assert.equal(removed[0], extra);
});
test('relay removes consecutive entries without dangling separators and retains inline comment', () => {
  const parsed = parseRelayFiles(`mynetworks = ${fixed}, 192.0.2.8, 192.0.2.9 # operator\n`, `local_addrs = [${optionsFixed}, "192.0.2.8", "192.0.2.9"];\n`, config);
  const result = renderRelayFiles(parsed, []); assert.equal(parseRelayFiles(...result, config).consistent, true);
  assert.ok(result[0].includes(' # operator\n')); assert.ok(!result[0].includes('/64,  #'));
});
test('relay validates prefix bounds, duplicates, overlap and alternate IPv6 spelling', () => {
  const parsed = parseRelayFiles(baseExtra, baseOptions, config);
  for (const ip of ['0.0.0.0/0', '192.0.2.0/23', '2001:db8::/63', '127.1.2.3', '169.254.0.1/999', 'fe80::7', '172.22.1.7', 'fd4d:6169:6c63:6f77::7', '192.0.2.7', '2001:db8:ffff::7', 'bad', '1.2.3.4\nfoo']) assert.throws(() => validateRelayIp(ip, parsed, config), { statusCode: 422 });
  assert.equal(validateRelayIp('198.51.100.99/24', parsed, config), '198.51.100.0/24');
  assert.equal(relayNetwork('2001:DB8::1').ip, relayNetwork('2001:db8:0:0:0:0:0:1').ip);
  const duplicate = parseRelayFiles(`mynetworks = ${fixed}, 192.0.2.0/24\n`, `local_addrs = [${optionsFixed}, "192.0.2.0/24"];\n`, config);
  assert.throws(() => validateRelayIp('192.0.2.99/24', duplicate, config), { statusCode: 422, code: 'RELAY_OVERLAP' });
});
test('relay refuses missing/duplicate/malformed layouts', () => {
  for (const extra of ['# no network\n', 'mynetworks = 127.0.0.0/8\nmynetworks = 127.0.0.0/8\n', '# BEGIN mailstack-edge mynetworks (apply-postfix-edge.sh)\nmynetworks = 127.0.0.0/8\n']) assert.throws(() => parseRelayFiles(extra, baseOptions, config), { statusCode: 409, code: 'RELAY_LAYOUT' });
});
async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'webmail-relay-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = [join(dir, 'extra.cf'), join(dir, 'options.inc')]; await Promise.all(paths.map((path, i) => writeFile(path, [baseExtra, baseOptions][i])));
  const audit = createAudit({ dir: join(dir, 'audit') }), lock = createResourceLock(), history = createHistoryService({ audit, lock }), calls = [];
  let failed = false;
  const dockerapi = { restart: async name => { calls.push(name); if (overrides.restartFail && (!failed || overrides.alwaysFail)) { failed = true; throw new Error('synthetic'); } } };
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
test('relay same-inode writer and successful service writes create private backups and metadata', async t => {
  const f = await setup(t), before = await Promise.all(f.paths.map(path => stat(path)));
  await f.service.create(await f.args());
  assert.deepEqual(f.calls, ['postfix-mailcow', 'rspamd-mailcow']);
  const listed = await f.service.list(); assert.deepEqual(listed.items.map(row => row.ip), ['203.0.113.8']); assert.equal(listed.items[0].note, '문서용 릴레이'); assert.equal(listed.items[0].actor, 'admin'); assert.ok(listed.items[0].date);
  for (let i = 0; i < 2; i++) assert.equal((await stat(f.paths[i])).ino, before[i].ino);
  const backups = await readdir(join(f.dir, 'backups')); assert.equal(backups.length, 1);
  for (const [i, name] of ['extra.cf', 'options.inc'].entries()) { const path = join(f.dir, 'backups', backups[0], name); assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(await readFile(path, 'utf8'), [baseExtra, baseOptions][i]); }
  await f.service.remove({ ...(await f.args()), address: '203.0.113.8', data: { etag: listed.etag, confirmRestart: true } });
  assert.deepEqual((await f.service.list()).items, []);
});
test('relay mismatch and stale etag reject writes before backups, disabled is 404', async t => {
  const f = await setup(t), stale = await f.args();
  await writeFile(f.paths[0], `${baseExtra}# changed\n`);
  await assert.rejects(f.service.create(stale), { statusCode: 409, code: 'CHANGED_ELSEWHERE' });
  await writeFile(f.paths[0], baseExtra.replace('\n# tail', ', 203.0.113.9\n# tail'));
  assert.equal((await f.service.list()).consistent, false);
  await assert.rejects(f.service.create(await f.args()), { statusCode: 409, code: 'RELAY_MISMATCH' });
  assert.equal(f.calls.length, 0);
  const disabled = createRelayService({ config: { ...config, relayFiles: [] }, history: { register() {} } });
  await assert.rejects(disabled.list(), { statusCode: 404, code: 'RELAY_DISABLED' });
});
for (const failure of ['restartFail', 'stopped', 'alwaysFail']) test(`relay ${failure}: restores bytes and inode, result is partial`, async t => {
  const f = await setup(t, { restartFail: true, ...(failure === 'stopped' ? { restartFail: false, stopped: true } : {}), ...(failure === 'alwaysFail' ? { alwaysFail: true } : {}) }), initial = await stat(f.paths[0]);
  await assert.rejects(f.service.create(await f.args()), { statusCode: 502, code: 'RELAY_APPLY_FAILED' });
  assert.equal(await readFile(f.paths[0], 'utf8'), baseExtra); assert.equal(await readFile(f.paths[1], 'utf8'), baseOptions); assert.equal((await stat(f.paths[0])).ino, initial.ino);
  const { rows } = await f.audit.read(); assert.equal(rows.at(-1).result, 'partial'); assert.equal(rows.at(-1).detail.restored, failure === 'restartFail'); assert.ok(f.calls.length >= 2);
});
test('relay audit intent failure performs no writes or restart', async t => {
  const f = await setup(t), audit = { read: () => f.audit.read(), run: async () => { throw new Error('intent failed'); } };
  const service = createRelayService({ config: { ...config, relayFiles: f.paths }, audit, lock: createResourceLock(), history: { register() {} }, dockerapi: { restart() { throw new Error('must not call'); } }, backupDir: join(f.dir, 'other-backups') });
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
test('relay writer shorter contents truncate same inode', async t => {
  const f = await setup(t); const initial = await stat(f.paths[0]); await writeRelayInPlace(f.paths, ['short', 'x']); assert.equal(await readFile(f.paths[0], 'utf8'), 'short'); assert.equal((await stat(f.paths[0])).ino, initial.ino);
});

test('relay rejects restart names outside the two fixed containers without network access', async () => {
  const api = createDockerApi({ config: { dockerapiUrl: 'https://dockerapi:443' } });
  for (const name of ['dovecot-mailcow', 'mysql-mailcow', '../restart', '', null]) await assert.rejects(api.restart(name), { statusCode: 422, code: 'DOCKERAPI_TASK_NOT_ALLOWED' });
});
test('relay enabled with one missing file is layout conflict; both missing disables feature', async t => {
  const f = await setup(t);
  await rm(f.paths[0]); await assert.rejects(f.service.list(), { statusCode: 409, code: 'RELAY_LAYOUT' });
  await rm(f.paths[1]); await assert.rejects(f.service.list(), { statusCode: 404, code: 'RELAY_DISABLED' });
});

test('relay removes all continued entries without empty list elements', () => {
  const [, extra, options] = cases.find(([name]) => name === 'continued lines');
  const parsed = parseRelayFiles(extra, options, config), contents = renderRelayFiles(parsed, []);
  assert.equal(parseRelayFiles(...contents, config).consistent, true);
  assert.ok(!/,\s*,/.test(contents[0])); assert.ok(!/,\s*,/.test(contents[1]));
  assert.ok(!/,\s*\]/.test(contents[1]));
});
