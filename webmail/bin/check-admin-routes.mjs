#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const visited = new Set();
function inspectImports(path) {
  path = resolve(path);
  assert.ok(!path.startsWith(join(root, 'server/admin/')), `public import reaches admin: ${path}`);
  if (visited.has(path)) return;
  visited.add(path);
  const source = readFileSync(path, 'utf8');
  const imports = /(?:\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s*)?|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(imports)) inspectImports(resolve(dirname(path), match[1]));
}
inspectImports(join(root, 'server/app.js'));
const app = await createApp({ logger: false, staticDir: join(root, 'web/dist'), config: {
  publicHostnames: ['mail.example.com'], trustProxy: ['192.0.2.0/24'],
  sessionIdleMin: 60, sessionMaxHours: 8,
  imapHost: 'imap.example.com', imapPort: 993, mailTlsMode: 'verify', mailTlsServername: 'mail.example.com',
  dbHost: 'db.example.com', dbName: 'example', dbUser: 'example', dbPassword: 'synthetic-route-check',
} });
try {
  await app.ready();
  // Disable the compressed radix display so /api/admin remains a literal path.
  assert.ok(!app.printRoutes({ commonPrefix: false }).includes('/api/admin'), 'public app registers admin routes');
  const response = await app.inject('/api/admin/auth/session');
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'NOT_FOUND');
} finally { await app.close(); }
const dist = join(root, 'web/dist');
if (existsSync(dist)) {
  for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    assert.ok(!/admin/i.test(path.slice(dist.length)), `admin asset in public dist: ${path}`);
    if (entry.isFile() && /\.(?:html|js|css|json|map)$/.test(entry.name)) {
      assert.ok(!/\/api\/admin\b|dist-admin|src\/admin\//.test(readFileSync(path, 'utf8')), `admin content in public dist: ${path}`);
    }
  }
}
console.log('R-ROUTES: public admin routes, admin imports and admin assets: 0');
