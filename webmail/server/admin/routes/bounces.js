export default async function bouncesRoutes(app, { service }) {
  app.get('/api/admin/bounces', { config: { adminMailcowApi: true } }, request => service.list(request.query));
  const args = request => ({ id: request.params.id, data: request.body, actor: request.session.username, ip: request.ip });
  app.put('/api/admin/bounces/:id/resolution', request => service.resolve(args(request)));
  app.put('/api/admin/bounces/:id/suppression', request => service.suppress(args(request)));
  app.delete('/api/admin/bounces/:id/suppression', request => service.release(args(request)));
  app.delete('/api/admin/bounces/:id', request => service.remove(args(request)));
}
