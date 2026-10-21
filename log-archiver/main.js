import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore, DEFAULT_RETENTION } from './store.js';
import { openCollector } from './collector.js';
import { createSources, SOURCE_NAMES } from './sources.js';
import { createSearch } from './search.js';
import { createArchiveServer } from './api.js';

function integer(name, fallback, max = 2147483647) {
  const value = process.env[name] ?? String(fallback);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new TypeError('Invalid runtime configuration');
  }
  return Number(value);
}

async function configuration() {
  const env = process.env;
  if (env.LOG_ARCHIVE_KEY && env.LOG_ARCHIVE_KEY_FILE) throw new TypeError('Ambiguous archive key configuration');
  const key = env.LOG_ARCHIVE_KEY_FILE ? (await readFile(env.LOG_ARCHIVE_KEY_FILE, 'utf8')).trim() : env.LOG_ARCHIVE_KEY;
  if (!key?.trim()) throw new TypeError('Archive key required');
  const requiredSources = env.LOG_ARCHIVE_REQUIRED_SOURCES === undefined ? [...SOURCE_NAMES] : env.LOG_ARCHIVE_REQUIRED_SOURCES.split(',').map(value => value.trim());
  if (!requiredSources.length || requiredSources.some(source => !SOURCE_NAMES.includes(source)) || new Set(requiredSources).size !== requiredSources.length) {
    throw new TypeError('Invalid required sources');
  }
  const retention = env.LOG_ARCHIVE_RETENTION_JSON === undefined ? {} : JSON.parse(env.LOG_ARCHIVE_RETENTION_JSON);
  if (!retention || typeof retention !== 'object' || Array.isArray(retention) || Object.entries(retention).some(([source, days]) => !Object.hasOwn(DEFAULT_RETENTION, source) || !Number.isSafeInteger(days) || days < 1)) {
    throw new TypeError('Invalid retention policy');
  }
  return {
    key, requiredSources, retention,
    root: env.LOG_ARCHIVE_ROOT ?? '/archive',
    sources: createSources({ dockerRoot: env.LOG_ARCHIVE_DOCKER_ROOT ?? '/docker-containers', npmplusRoot: env.LOG_ARCHIVE_NPMPLUS_ROOT ?? '/npmplus-data', mailcowProject: env.LOG_ARCHIVE_MAILCOW_PROJECT ?? 'mailcowdockerized', webmailProject: env.LOG_ARCHIVE_WEBMAIL_PROJECT ?? 'webmail' }),
    collectMs: integer('LOG_ARCHIVE_COLLECT_INTERVAL_MS', 1000),
    expireMs: integer('LOG_ARCHIVE_EXPIRE_INTERVAL_MS', 600000),
    retryMs: integer('LOG_ARCHIVE_RETRY_INTERVAL_MS', 1000),
    port: integer('LOG_ARCHIVE_PORT', 8080, 65535),
    host: env.LOG_ARCHIVE_HOST ?? '0.0.0.0',
  };
}

// Only controlled metadata is logged. Error messages/stacks may contain input
// paths, Docker config, or secret values and must never reach stdout/stderr.
function report(event) {
  console.error(JSON.stringify({ event, time: new Date().toISOString() }));
}

async function main() {
  const config = await configuration();
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const pause = ms => delay(ms, undefined, { signal: shutdown.signal }).catch(error => {
    if (error.name !== 'AbortError') throw error;
  });
  try {
    while (!shutdown.signal.aborted) {
      let store, collector, server, search;
      try {
        store = await openStore({ root: config.root, retention: config.retention, onDelete: entry => {
          console.log(JSON.stringify({ event: 'archive-expired', source: entry.source, hour: entry.hour, files: 2, bytes: entry.compressedBytes, retentionDays: store?.retention[entry.source] ?? config.retention[entry.source] ?? DEFAULT_RETENTION[entry.source], time: new Date().toISOString(), recovered: entry.recovered === true }));
        } });
        collector = await openCollector({ store, sources: config.sources, requiredSources: config.requiredSources, retention: config.retention });
        if (shutdown.signal.aborted) continue;
        search = createSearch({ store });
        server = createArchiveServer({ store, key: config.key, search, status: async () => {
          const status = await collector.status();
          return { ...status, generations: status.generations.map(({ path, ...generation }) => ({ ...generation, observedSize: generation.size })) };
        } });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); });
        });
        // One scheduler serializes collection and expiry. Never queue overlapping
        // commits; shutdown waits for the current operation before closing store.
        let expireAt = 0;
        while (!shutdown.signal.aborted) {
          const started = performance.now();
          await collector.collect();
          if (!shutdown.signal.aborted && performance.now() >= expireAt) {
            await store.expire({ now: new Date() });
            expireAt = performance.now() + config.expireMs;
          }
          await pause(Math.max(0, config.collectMs - (performance.now() - started)));
        }
      } catch {
        report('archive-runtime-retry');
      } finally {
        // Stop accepting requests and drain existing queries before releasing
        // the store lock. A new attempt gets a fresh search/collector/store.
        try {
          if (server) await new Promise(resolve => server.close(resolve));
        } finally {
          search?.close();
          try { if (collector) await collector.close(); }
          finally { if (store) await store.close(); }
        }
      }
      if (!shutdown.signal.aborted) await pause(config.retryMs);
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

main().catch(() => {
  report('archive-runtime-failed');
  process.exitCode = 1;
});
