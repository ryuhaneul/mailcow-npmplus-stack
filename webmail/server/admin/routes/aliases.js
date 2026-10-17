export default async function aliasesRoutes(app, { service }) {
  const options = { config: { adminMailcowApi: true } };
  app.get('/api/admin/aliases', options, async request => service.list(request.session.mailcow, request.query));
  app.get('/api/admin/checks/aliases', options, async request => service.checks(request.session.mailcow));
  app.post('/api/admin/aliases', async request => service.create({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, data: request.body }));
  app.patch('/api/admin/aliases/:addr', async request => service.edit({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, addr: request.params.addr, data: request.body }));
  app.delete('/api/admin/aliases/:addr', async request => service.remove({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, addr: request.params.addr, data: request.body }));
}
