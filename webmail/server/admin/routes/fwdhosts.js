export default async function fwdhostsRoutes(app, { service }) {
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, data: request.body });
  app.get('/api/admin/fwdhosts', { config: { adminMailcowApi: true } }, request => service.list(request.session.mailcow));
  app.post('/api/admin/fwdhosts', request => service.create(args(request)));
  app.delete('/api/admin/fwdhosts', request => service.remove(args(request)));
}
