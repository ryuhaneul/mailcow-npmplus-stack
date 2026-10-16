export default async function syncRoutes(app, { service }) {
  const options = { config: { adminMailcowApi: true } };
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, id: request.params.id, data: request.body });
  app.get('/api/admin/syncjobs', options, request => service.list(request.session.mailcow));
  app.get('/api/admin/syncjobs/:id', options, request => service.get(request.session.mailcow, request.params.id));
  app.patch('/api/admin/syncjobs/:id', request => service.patch(args(request)));
  app.post('/api/admin/syncjobs/:id/run-now', request => service.runNow(args(request)));
  app.delete('/api/admin/syncjobs/:id', request => service.remove(args(request)));
}
