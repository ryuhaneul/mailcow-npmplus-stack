import { AppError } from '../errors.js';
import { createPrefsService, MAX_PREFS_BYTES } from '../prefs.js';

export default async function prefsRoutes(app, { config, service }) {
  service ??= createPrefsService({ config, imap: app.imap, logger: app.log });
  const parse = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    parse(request, body, (error, value) => done(error ? new AppError(422, 'PREFS_INVALID', '설정 형식을 확인해 주세요.') : null, value));
  });
  app.get('/api/prefs', request => service.get(request.session));
  app.put('/api/prefs', { bodyLimit: MAX_PREFS_BYTES }, async (request, reply) => {
    await service.put(request.session, request.body);
    return reply.code(204).send();
  });
}
