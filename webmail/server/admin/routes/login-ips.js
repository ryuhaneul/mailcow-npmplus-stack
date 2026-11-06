export default async function loginIpsRoutes(app, { service }) {
  const args = request => ({ actor: request.session.username, ip: request.ip, data: request.body, address: request.params.ip });
  app.get('/api/admin/login-ips', () => service.list());
  app.post('/api/admin/login-ips', request => service.create(args(request)));
  app.delete('/api/admin/login-ips/:ip', request => service.remove(args(request)));
}
