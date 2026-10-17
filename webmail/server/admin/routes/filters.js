export default async function filtersRoutes(app, { service }) {
  const options = { config: { adminMailcowApi: true } };
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, addr: request.params.addr, data: request.body });
  app.get('/api/admin/filters/:addr', options, request => service.list(request.session.mailcow, request.params.addr));
  app.put('/api/admin/filters/:addr/:id', request => service.edit({ ...args(request), id: request.params.id }));
  app.post('/api/admin/filters/:addr', request => service.create(args(request)));
  app.get('/api/admin/user-filters/:addr', options, request => service.user(request.session.mailcow, request.params.addr));
  app.get('/api/admin/checks/filters', options, request => service.checks(request.session.mailcow));
}
