export default async function publicTemplatesRoutes(app, { service }) {
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip,
    id: request.params.id, data: request.body });
  const write = { bodyLimit: 16 * 1024 * 1024 };
  app.get('/api/admin/public-templates', () => service.list());
  app.get('/api/admin/public-templates/:id', request => service.get(args(request)));
  app.post('/api/admin/public-templates', write, request => service.save(args(request)));
  app.put('/api/admin/public-templates/:id', write, request => service.save(args(request)));
  app.delete('/api/admin/public-templates/:id', request => service.remove(args(request)));
}
