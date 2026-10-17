export default async function securityRoutes(app, { service }) {
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, data: request.body });
  app.get('/api/admin/fail2ban', { config: { adminMailcowApi: true } }, request => service.get(request.session.mailcow, request.ip));
  app.post('/api/admin/fail2ban/actions', request => service.action(args(request)));
  app.put('/api/admin/fail2ban/settings', request => service.put(args(request)));
}
