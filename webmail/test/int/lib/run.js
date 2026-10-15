import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { groups } from './runtime.js';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--group' || !args[1].split(',').every(group => groups.includes(group)))) {
  process.stderr.write('사용법: node test/int/lib/run.js [--group core|mail,sieve,account]\n');
  process.exit(2);
}
const cwd = fileURLToPath(new URL('../../../', import.meta.url));
const files = readdirSync(new URL('../', import.meta.url)).filter(name => name.endsWith('.test.js')).sort().map(name => `test/int/${name}`);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd, stdio: 'inherit', env: { ...process.env, ...(args.length ? { WEBMAIL_INT_GROUP: args[1] } : {}) },
});
process.exit(result.status ?? 1);
