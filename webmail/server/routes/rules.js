export default async function rulesRoutes(app, { service }) {
  const handler = operation => async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await operation(request.session, request.body); }
    catch (error) {
      if (error.statusCode === 422 && error.path) return reply.code(422).send({ error: { code: error.code, message: error.message, path: error.path, reason: error.reason } });
      throw error;
    }
  };
  app.get('/api/rules', handler(service.get));
  app.put('/api/rules', handler(service.save));
  app.post('/api/rules/reactivate', handler(service.reactivate));
  app.post('/api/rules/restore', handler(service.restore));
  app.post('/api/rules/import', handler(service.importRules));
  app.post('/api/rules/preview', handler(service.preview));
  app.post('/api/rules/apply-existing', handler(service.applyExisting));
}
