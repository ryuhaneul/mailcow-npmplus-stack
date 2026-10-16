export default async function syncRoutes(app, { service }) {
  const options = { config: { adminMailcowApi: true } };
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, id: request.params.id, data: request.body });
  app.get('/api/admin/syncjobs', options, request => service.list(request.session.mailcow));
  app.get('/api/admin/syncjobs/:id', options, request => service.get(request.session.mailcow, request.params.id));
  app.patch('/api/admin/syncjobs/:id', async (request, reply) => {
    try { return await service.patch(args(request)); }
    catch (error) {
      if (error.code === 'DELETE2_MULTI_SOURCE') return reply.code(409).send({ error: { code: error.code, message: error.message, jobs: error.jobs } });
      throw error;
    }
  });
  app.post('/api/admin/syncjobs/:id/run-now', request => service.runNow(args(request)));
  app.delete('/api/admin/syncjobs/:id', request => service.remove(args(request)));
}
