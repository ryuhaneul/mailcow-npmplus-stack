import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadAdminConfig } from './config.js';
import { installAdminAuth } from './routes/auth.js';
import { createAudit } from './audit.js';
import { createResourceLock } from './lock.js';
import { createHistoryService } from './services/history.js';
import historyRoutes from './routes/history.js';
import { createDockerApi } from './dockerapi.js';
import { createSharesService } from './services/shares.js';
import sharesRoutes from './routes/shares.js';
import { logOptions } from '../log.js';
import { installErrors, errorBody } from '../errors.js';
import { installHeaders, installClientIp } from '../security/headers.js';

export const adminCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";

export async function createAdminApp({ config = loadAdminConfig(), staticDir = fileURLToPath(new URL('../../web/dist-admin/', import.meta.url)), logger = logOptions(config.logLevel), auth = {}, audit: auditOptions = {}, dockerapi } = {}) {
  const app = Fastify({ logger, trustProxy: config.trustProxy, bodyLimit: 64 * 1024, logController: new LogController({ disableRequestLogging: true }) });
  installErrors(app);
  installHeaders(app);
  installClientIp(app);
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('content-security-policy', adminCsp);
    const pathname = request.url.split('?')[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });
  await installAdminAuth(app, { ...auth, config });
  const audit = createAudit({ ...auditOptions, dir: config.auditDir, logger: app.log });
  const adminLock = createResourceLock();
  const history = createHistoryService({ audit, lock: adminLock });
  app.decorate('audit', audit);
  app.decorate('adminLock', adminLock);
  app.decorate('adminHistory', history);
  await app.register(historyRoutes, { service: history });
  dockerapi ??= createDockerApi({ config });
  app.decorate('dockerapi', dockerapi);
  const shares = createSharesService({ mailcow: app.mailcow, dockerapi, audit, lock: adminLock, history });
  app.decorate('shares', shares);
  await app.register(sharesRoutes, { service: shares });
  app.get('/healthz', async () => ({ ok: true }));
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
