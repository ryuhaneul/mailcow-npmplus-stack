#!/usr/bin/env bash
set -euo pipefail
webmail_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
node --input-type=module - "$webmail_dir" <<'JS'
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';

const root = process.argv[2];
const composePath = join(root, 'test/int/compose.int.yml');
const compose = readFileSync(composePath, 'utf8');
// Check this repository's literal build fields, without requiring Docker/YAML dependencies.
const context = resolve(dirname(composePath), compose.match(/^      context: (.+)$/m)?.[1] ?? '');
assert.equal(context, root, 'int build context must be webmail/');
const dockerfile = compose.match(/^      dockerfile: (.+)$/m)?.[1];
const selected = dockerfile ? resolve(context, dockerfile) : null;
const source = selected ? readFileSync(selected, 'utf8') :
  compose.match(/^      dockerfile_inline: \|\n((?:        .*\n)*)/m)?.[1]?.replace(/^        /gm, '');
assert.ok(source, 'int Dockerfile must be readable');
const policy = path => readFileSync(path, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
const productionIgnore = join(root, 'Dockerfile.dockerignore');
const production = policy(existsSync(productionIgnore) ? productionIgnore : join(root, '.dockerignore'));
const selectedIgnore = selected && existsSync(`${selected}.dockerignore`) ? `${selected}.dockerignore` : join(context, '.dockerignore');
const integration = policy(selectedIgnore);
// The current policies use plain exclusions. Reject unsupported syntax rather than
// approximating Docker's ordered negation/escape/character-class semantics.
for (const pattern of [...production, ...integration]) {
  assert.ok(!/[!\\[\]{}]/.test(pattern), 'ignore syntax changed: review the context check');
}
function ignored(path, patterns) {
  const parts = path.split('/');
  return parts.some((_, i) => patterns.some(pattern => matchesGlob(parts.slice(0, i + 1).join('/'), pattern.replace(/^\/+|\/+$/g, ''))));
}
assert.ok(ignored('test/int/integration.test.js', production), 'production context must exclude test/');
assert.ok(!ignored('test/int/integration.test.js', integration), 'int COPY test is excluded by its effective dockerignore');
assert.ok(selected, 'int build must select a named Dockerfile for its own ignore file');
assert.deepEqual(integration, production.filter(pattern => pattern !== 'test'), 'int ignore must retain production exclusions except test');
for (const line of source.split('\n').filter(line => /^COPY\s/i.test(line))) {
  assert.ok(!line.includes('--from='), 'review int COPY from another stage');
  const inputs = line.split(/\s+/).slice(1, -1);
  for (const input of inputs) {
    assert.ok(!/["*?\[\]]/.test(input) && !input.startsWith('--'), 'review non-literal int COPY');
    const path = resolve(context, input);
    assert.ok(path.startsWith(`${context}/`) && existsSync(path), `int COPY input missing: ${input}`);
    assert.ok(!ignored(input, integration), `int COPY input excluded: ${input}`);
    if (statSync(path).isDirectory()) {
      for (const file of readdirSync(path, { recursive: true }).filter(name => /\.(?:js|mjs)$/.test(name))) {
        const target = relative(context, join(path, file));
        assert.ok(!ignored(target, integration), `int source excluded: ${target}`);
      }
    }
  }
}
console.log('image contexts: int COPY inputs included; production test excluded: OK');
JS
image_check_dir=$(mktemp -d "${TMPDIR:-/tmp}/webmail-image-check.XXXXXX")
trap 'rm -rf -- "$image_check_dir"' EXIT
mkdir "$image_check_dir/web-build" "$image_check_dir/runtime"

# Mirror Dockerfile COPY inputs and the current .dockerignore in isolated stages.
cp "$webmail_dir/package.json" "$webmail_dir/package-lock.json" "$image_check_dir/web-build/"
tar -C "$webmail_dir" --exclude-from="$webmail_dir/.dockerignore" -cf - web | tar -C "$image_check_dir/web-build" -xf -
(
  cd "$image_check_dir/web-build"
  npm ci
  npm run build
)

cp "$webmail_dir/package.json" "$webmail_dir/package-lock.json" "$image_check_dir/runtime/"
(
  cd "$image_check_dir/runtime"
  npm ci --omit=dev
)
tar -C "$webmail_dir" --exclude-from="$webmail_dir/.dockerignore" -cf - server | tar -C "$image_check_dir/runtime" -xf -
mkdir "$image_check_dir/runtime/web"
cp -R "$image_check_dir/web-build/web/dist" "$image_check_dir/runtime/web/dist"
(
  cd "$image_check_dir/runtime"
  NODE_ENV=production node --input-type=module <<'JS'
import assert from 'node:assert/strict';
// index.js imports app.js: resolve the same runtime graph without binding port 8080.
import { createApp } from './server/app.js';
const app = await createApp({ logger: false, config: {
  publicHostnames: ['mail.example.com'], trustProxy: ['127.0.0.1'],
  sessionIdleMin: 480, sessionMaxHours: 24,
  imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com',
  dbHost: 'db.example.com', dbName: 'example', dbUser: 'example', dbPassword: 'synthetic-image-check',
} });
try {
  const health = await app.inject('/healthz');
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { ok: true });
  assert.equal((await app.inject('/')).statusCode, 200);
} finally { await app.close(); }
console.log('runtime production imports, health and static output: OK');
JS
)
echo 'isolated image stages: OK'
