import { AppError } from '../errors.js';

export default async function rulesRoutes(app, { service }) {
  const handler = operation => async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await operation(request.session, request.body); }
    catch (error) {
      if (error.statusCode === 422 && error.path) return reply.code(422).send({ error: { code: error.code, message: error.message, path: error.path, reason: error.reason } });
      if (error instanceof AppError && ['IMPORT_WRITE_FAILED', 'FOLDER_CREATE_FAILED', 'XML_INVALID'].includes(error.code)) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, detail: error.detail } });
      }
      throw error;
    }
  };
  app.get('/api/rules', handler(service.get));
  app.put('/api/rules', handler(service.save));
  app.post('/api/rules/reactivate', handler(service.reactivate));
  app.post('/api/rules/restore', handler(service.restore));
  app.post('/api/rules/import', handler(service.importRules));
  app.post('/api/rules/import/xml/preview', { bodyLimit: 1.5 * 1024 * 1024 }, handler(service.previewXml));
  app.post('/api/rules/import/xml', { bodyLimit: 1.5 * 1024 * 1024 }, handler(service.importXml));
  app.post('/api/rules/import/undo', handler(service.undoImport));
  app.post('/api/rules/preview', handler(service.preview));
  app.post('/api/rules/apply-existing', handler(service.applyExisting));
}
