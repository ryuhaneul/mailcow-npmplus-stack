import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadAdminConfig } from '../../server/admin/config.js';

const library = fileURLToPath(new URL('../../../scripts/lib/webmail-env.sh', import.meta.url));
const baseConfig = 'DBNAME=mailcow\nIPV4_NETWORK=172.22.1\nMAILCOW_HOSTNAME=mail.example.test\nENABLE_IPV6=false\n';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mailadmin-api-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stack = join(dir, 'stack.env');
  await writeFile(stack, 'DOMAIN=example.test\nWEBMAIL_ENABLE=true\nWEBMAIL_ADMIN_ENABLE=true\nWEBMAIL_DB_PASSWORD=synthetic-db-only\n');
  return {
    dir,
    async configure(line = '') { await writeFile(join(dir, 'mailcow.conf'), baseConfig + line); },
    generate(trace = false) {
      return spawnSync('bash', [trace ? '-exc' : '-ec', `
        source "$1"
        webmail_load_config "$2" "$3"
        webmail_generate_env "$3"
        webmail_generate_admin_env "$3"
      `, 'fixture', library, stack, dir], {
        encoding: 'utf8', timeout: 15000,
        env: { PATH: process.env.PATH, HOME: dir, LC_ALL: 'C' }, cwd: dir,
      });
    },
    admin() { return readFile(join(dir, 'webmail-admin.env'), 'utf8'); },
    public() { return readFile(join(dir, 'webmail.env'), 'utf8'); },
  };
}
function assertQuiet(result, secret) {
  assert.ok(!result.stdout.includes(secret));
  assert.ok(!result.stderr.includes(secret));
}

test('admin API env: optional server key changes only admin key line; repeat preserves inode and mode', async t => {
  const f = await fixture(t);
  await f.configure();
  assert.equal(f.generate().status, 0);
  const previousAdmin = await f.admin();
  const previousPublic = await f.public();
  assert.ok(!previousAdmin.includes('MAILCOW_API_KEY'));
  const secret = 'synthetic-$dollar-"quote"-\\slash-$(touch${IFS}SHOULD_NOT_EXIST)-`false`';
  await f.configure(`API_KEY='${secret}'\n`);
  const first = f.generate(true);
  assert.equal(first.status, 0);
  assertQuiet(first, secret);
  const admin = await f.admin();
  const escaped = secret.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', () => '$$');
  assert.equal(admin, `${previousAdmin}MAILCOW_API_KEY="${escaped}"\n`);
  assert.equal(await f.public(), previousPublic);
  assert.ok(!previousPublic.includes('MAILCOW_API_KEY'));
  const before = await stat(join(f.dir, 'webmail-admin.env'));
  assert.equal(before.mode & 0o777, 0o600);
  assert.equal(f.generate(true).status, 0);
  assert.equal(await f.admin(), admin);
  const after = await stat(join(f.dir, 'webmail-admin.env'));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.ok(!(await readdir(f.dir)).includes('SHOULD_NOT_EXIST'));
  await f.configure();
  assert.equal(f.generate().status, 0);
  assert.equal(await f.admin(), previousAdmin);
  assert.equal(await f.public(), previousPublic);
});

for (const [label, line, expected] of [
  ['unquoted', 'API_KEY=synthetic-plain\n', 'synthetic-plain'],
  ['ASCII boundaries', 'API_KEY=!synthetic-boundary~\n', '!synthetic-boundary~'],
  ['double quoted', 'API_KEY="synthetic-double"\n', 'synthetic-double'],
  ['literal leading quote', 'API_KEY=\'"synthetic-leading\'\n', '\\"synthetic-leading'],
  ['last assignment', 'API_KEY=synthetic-old\nAPI_KEY=synthetic-last\n', 'synthetic-last'],
  ['empty', 'API_KEY=\n', null],
  ['quoted empty', 'API_KEY=""\n', null],
  ['read-only ignored', 'API_KEY_READ_ONLY=synthetic-unused\n', null],
]) {
  test(`admin API env: ${label}`, async t => {
    const f = await fixture(t);
    await f.configure(line);
    const result = f.generate(true);
    assert.equal(result.status, 0);
    assertQuiet(result, 'synthetic-');
    const admin = await f.admin();
    if (expected === null) assert.ok(!admin.includes('MAILCOW_API_KEY'));
    else assert.ok(admin.includes(`MAILCOW_API_KEY="${expected}"\n`));
    assert.ok(!(await f.public()).includes('MAILCOW_API_KEY'));
    const appEnv = Object.fromEntries(admin.trimEnd().split('\n').map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), JSON.parse(line.slice(separator + 1)).replaceAll('$$', '$')];
    }));
    assert.equal(loadAdminConfig(appEnv).mailcowApiKey, appEnv.MAILCOW_API_KEY ?? '');
  });
}
for (const [label, value] of [
  ['CR', 'synthetic-invalid\r'], ['CRLF', 'synthetic-invalid\r\nINJECTED=true'],
  ['LF', '"synthetic-invalid\nINJECTED=true"'], ['tab', 'synthetic-invalid\t'],
  ['NUL', 'synthetic-invalid\0'], ['escape', 'synthetic-invalid\x1b'], ['DEL', 'synthetic-invalid\x7f'],
  ['U+0085', 'synthetic-invalid\u0085'], ['U+2028', 'synthetic-invalid\u2028'],
  ['U+2029', 'synthetic-invalid\u2029'], ['non-ASCII printable', 'synthetic-invalid한'],
  ['internal space', 'synthetic-invalid value'], ['leading space', ' synthetic-invalid'],
  ['trailing space', 'synthetic-invalid '],
  ['single quote multiline', "'synthetic-invalid\nINJECTED=true'"],
]) {
  test(`admin API env: ${label} rejected without secret output or replacing existing admin env`, async t => {
    const f = await fixture(t);
    await f.configure('API_KEY=synthetic-existing\n');
    assert.equal(f.generate().status, 0);
    const before = await f.admin();
    await f.configure(`API_KEY=${value}\n`);
    const result = f.generate(true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid mailcow API key/);
    assertQuiet(result, 'synthetic-invalid');
    assert.equal(await f.admin(), before);
    assert.ok(!(await f.public()).includes('MAILCOW_API_KEY'));
    assert.ok(!(await readdir(f.dir)).some(name => name.startsWith('.webmail-admin.env.')));
  });
}
