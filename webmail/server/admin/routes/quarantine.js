export default async function quarantineRoutes(app, { service }) {
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, id: request.params.id, data: request.body });
  app.get('/api/admin/quarantine', { config: { adminMailcowApi: true } }, request => service.list(request.session.mailcow));
  app.post('/api/admin/quarantine/:id', request => service.change(args(request)));
  app.delete('/api/admin/quarantine/:id', request => service.change({ ...args(request), remove: true }));
}
