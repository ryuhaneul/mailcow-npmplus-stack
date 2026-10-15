export default async function folderRoutes(app, { service }) {
  app.get('/api/folders', request => service.folders(request.session));
  app.post('/api/folders', async (request, reply) => reply.code(201).send(await service.create(request.session, request.body)));
  app.patch('/api/folders/:path', request => service.rename(request.session, request.params.path, request.body));
  app.delete('/api/folders/:path', async (request, reply) => {
    await service.remove(request.session, request.params.path);
    return reply.code(204).send();
  });
  app.post('/api/folders/:path/empty', request => service.empty(request.session, request.params.path, request.body));
}
