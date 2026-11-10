#!/usr/bin/env node
import { createPool } from 'mysql2/promise';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '../server/errors.js';
import { loadAdminConfig } from '../server/admin/config.js';
import { createMailcowClient } from '../server/admin/mailcow-client.js';
import { createDockerApi } from '../server/admin/dockerapi.js';
import { createRetirementRouting } from '../server/admin/retirement-routing.js';
import { createRetirementStore, retirementAddress } from '../server/security/retirement-store.js';

export async function checkRetirementRoutes({ db, store, routing, session }) {
  return store.withRoutingLock(async () => {
    const [rows] = await db.execute({ sql: 'SELECT email FROM mailstack_webmail.account_retirement WHERE receive_blocked=1 ORDER BY email', timeout: 1000 });
    if (!Array.isArray(rows)) throw new Error('Invalid stored ON list');
    const addresses = rows.map(row => retirementAddress(row.email));
    if (new Set(addresses).size !== addresses.length) throw new Error('Duplicate stored ON address');
    const failures = [];
    for (const address of addresses) {
      try { routing.assertReady(await routing.inspect(session, address)); }
      catch (error) { failures.push({ address, code: error instanceof AppError ? error.code : 'RETIREMENT_ROUTING_UNAVAILABLE' }); }
    }
    return { ready: failures.length === 0, checked: addresses.length, failures };
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No options accepted');
  const config = loadAdminConfig();
  if (!config.mailcowApiKey || !config.dbHost || !config.dbUser || !config.dbPassword) throw new Error('Connection configuration required');
  const db = createPool({ host: config.dbHost, database: config.dbName, user: config.dbUser, password: config.dbPassword,
    dateStrings: true, timezone: 'Z', connectionLimit: 2, waitForConnections: false, connectTimeout: 1000 });
  const store = createRetirementStore({ config, db });
  try {
    const mailcow = createMailcowClient({ config }), session = mailcow.createApiContext({ permission: 'read' });
    const routing = createRetirementRouting({ mailcow, dockerapi: createDockerApi({ config }), store });
    const result = await checkRetirementRoutes({ db, store, routing, session });
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 2;
  } finally { await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(JSON.stringify({ ready: false, error: 'RETIREMENT_ROUTING_UNAVAILABLE', message: 'Stored ON routing could not be verified; check DB/API access and retry. No account state was changed.' }));
    process.exitCode = 2;
  });
}
