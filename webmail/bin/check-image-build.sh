#!/usr/bin/env bash
set -euo pipefail
webmail_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
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
