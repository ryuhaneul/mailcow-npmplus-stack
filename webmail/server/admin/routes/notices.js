export default async function noticesRoutes(app, { service }) {
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip,
    id: request.params.id, data: request.body });
  app.get('/api/admin/notices', request => service.list({ session: request.session.mailcow, state: request.query.state }));
  app.get('/api/admin/notices/:id', request => service.get(args(request)));
  app.post('/api/admin/notices/preview', request => service.preview(args(request)));
  app.post('/api/admin/notices', request => service.save(args(request)));
  app.put('/api/admin/notices/:id', request => service.save(args(request)));
  for (const action of ['publish', 'hide', 'pin', 'unpin']) {
    app.post(`/api/admin/notices/:id/${action}`, request => service.change({ ...args(request), action }));
  }
  app.delete('/api/admin/notices/:id', request => service.change({ ...args(request), action: 'delete' }));
}
