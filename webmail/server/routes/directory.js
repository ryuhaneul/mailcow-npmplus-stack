import { createPool } from 'mysql2/promise';
import { AppError } from '../errors.js';
import { createDirectoryService } from '../directory/index.js';

export default async function installDirectory(app, { config, service, db } = {}) {
  service ??= createDirectoryService({ config, imap: app.imap, db: db ?? createPool({
    host: config.dbHost, database: config.dbName, user: config.dbUser, password: config.dbPassword,
    connectionLimit: 2, connectTimeout: 10000,
  }) });
  app.decorate('directory', service);
  app.addHook('onClose', async () => { await service.close?.(); });
  function session(request) {
    if (!request.session) throw new AppError(403, 'NO_SESSION', '로그인이 필요해요.');
    return request.session;
  }
  app.get('/api/compose/identities', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.identities(session(request));
  });
  app.get('/api/contacts', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.contacts(session(request), request.query);
  });
}
