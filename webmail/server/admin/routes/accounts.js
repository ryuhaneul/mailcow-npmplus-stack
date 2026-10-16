export default async function accountsRoutes(app, { service }) {
  app.get('/api/admin/mailboxes', { config: { adminMailcowApi: true } }, async request => service.list(request.session.mailcow, request.query));
  app.get('/api/admin/mailboxes/:addr', async request => service.detail(request.session.mailcow, request.params.addr));
  app.post('/api/admin/mailboxes', async request => service.create({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, data: request.body }));
  app.patch('/api/admin/mailboxes/:addr', async request => service.edit({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, addr: request.params.addr, data: request.body }));
}
