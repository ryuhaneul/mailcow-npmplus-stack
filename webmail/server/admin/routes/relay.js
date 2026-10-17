export default async function relayRoutes(app, { service }) {
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, data: request.body });
  app.get('/api/admin/relay', () => service.list());
  app.get('/api/admin/relay/:ip/recent', request => service.recent(request.session.mailcow, request.params.ip));
  app.post('/api/admin/relay', request => service.create(args(request)));
  app.delete('/api/admin/relay/:ip', request => service.remove({ ...args(request), address: request.params.ip }));
}
