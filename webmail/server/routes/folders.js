export default async function folderRoutes(app, { service, listService }) {
  app.get('/api/folders', request => service.folders(request.session));
  app.post('/api/folders', async (request, reply) => reply.code(201).send(await service.create(request.session, request.body)));
  app.patch('/api/folders/:path', async request => {
    const result = await service.rename(request.session, request.params.path, request.body);
    listService.invalidate(request.session);
    return result;
  });
  app.delete('/api/folders/:path', async (request, reply) => {
    try { await service.remove(request.session, request.params.path); }
    catch (error) {
      if (error.code === 'FOLDER_IN_RULES') return reply.code(409).send({ error: { code: error.code, rules: error.rules } });
      throw error;
    }
    return reply.code(204).send();
  });
  app.post('/api/folders/:path/empty', async request => {
    const result = await service.empty(request.session, request.params.path, request.body);
    listService.invalidate(request.session);
    return result;
  });
}
