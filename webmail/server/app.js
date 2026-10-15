import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { logOptions } from './log.js';
import { installErrors, errorBody } from './errors.js';
import { installHeaders, installClientIp } from './security/headers.js';
import healthRoutes from './routes/health.js';
import { installAuth } from './routes/auth.js';
import configRoutes from './routes/config.js';
import folderRoutes from './routes/folders.js';
import storageRoutes from './routes/storage.js';
import messageRoutes from './routes/messages.js';
import eventRoutes from './routes/events.js';
import prefsRoutes from './routes/prefs.js';
import passwordRoutes from './routes/password.js';
import { createReadService } from './mail/read.js';
import { createListService } from './mail/list.js';
import { createFolderService } from './mail/folders.js';
import installDirectory from './routes/directory.js';
import composeRoutes from './routes/compose.js';
import { createComposeService } from './mail/compose.js';
import { createSmtpService } from './mail/smtp.js';
import rulesRoutes from './routes/rules.js';
import { createRulesService } from './sieve/service.js';

export async function createApp({ config = loadConfig(), staticDir = fileURLToPath(new URL('../web/dist/', import.meta.url)), logger = logOptions(config.logLevel), auth = {}, folders = {}, messages = {}, rules = {} } = {}) {
  const app = Fastify({ logger, trustProxy: config.trustProxy, logController: new LogController({ disableRequestLogging: true }) });
  installErrors(app);
  installHeaders(app);
  installClientIp(app);
  await installAuth(app, { ...auth, config });
  await installDirectory(app, { config });
  await app.register(composeRoutes, { config, service: createComposeService({ config, imap: app.imap, directory: app.directory, smtp: createSmtpService({ config }), logger: app.log, tempRoot: auth.tempRoot }) });
  const rulesService = rules.service ?? createRulesService({ ...rules, config, imap: app.imap, directory: app.directory });
  app.decorate('rules', rulesService);
  await app.register(rulesRoutes, { service: rulesService });
  const folderService = createFolderService({ rulesService, ...folders, imap: app.imap, logger: app.log });
  const listService = createListService({ ...messages, imap: app.imap });
  await app.register(folderRoutes, { service: folderService, listService });
  await app.register(storageRoutes, { service: folderService });
  await app.register(messageRoutes, { service: listService, reader: createReadService({ imap: app.imap }) });
  await app.register(eventRoutes, { listService });
  await app.register(prefsRoutes, { config });
  await app.register(passwordRoutes, { config });
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
