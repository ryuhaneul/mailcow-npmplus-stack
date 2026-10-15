export default async function folderRoutes(app, { service }) {
  app.get('/api/folders', request => service.folders(request.session));
  app.post('/api/folders', async (request, reply) => reply.code(201).send(await service.create(request.session, request.body)));
  app.patch('/api/folders/:path', request => service.rename(request.session, request.params.path, request.body));
  app.delete('/api/folders/:path', async (request, reply) => {
    try { await service.remove(request.session, request.params.path); }
    catch (error) {
      if (error.code === 'FOLDER_IN_RULES') return reply.code(409).send({ error: { code: error.code, rules: error.rules } });
      throw error;
    }
    return reply.code(204).send();
  });
  app.post('/api/folders/:path/empty', request => service.empty(request.session, request.params.path, request.body));
}
