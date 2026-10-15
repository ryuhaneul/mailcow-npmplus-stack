import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { logOptions } from './log.js';
import { installErrors, errorBody } from './errors.js';
import { installHeaders } from './security/headers.js';
import healthRoutes from './routes/health.js';
import configRoutes from './routes/config.js';

export async function createApp({ config = loadConfig(), staticDir = fileURLToPath(new URL('../web/dist/', import.meta.url)), logger = logOptions(config.logLevel) } = {}) {
  const app = Fastify({ logger, trustProxy: config.trustProxy, logController: new LogController({ disableRequestLogging: true }) });
  installErrors(app);
  installHeaders(app);
  await app.register(healthRoutes);
  await app.register(configRoutes, { config });
  const root = resolve(staticDir);
  const hasStatic = existsSync(root) && statSync(root).isDirectory();
  if (hasStatic) await app.register(fastifyStatic, { root, wildcard: false, index: ['index.html'] });
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0];
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    if (hasStatic && !isApi && ['GET', 'HEAD'].includes(request.method) && existsSync(resolve(root, 'index.html'))) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send(errorBody('NOT_FOUND', '요청한 경로를 찾을 수 없어요.'));
  });
  return app;
}
