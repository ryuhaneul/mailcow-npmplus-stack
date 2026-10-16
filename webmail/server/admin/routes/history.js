export default async function historyRoutes(app, { service }) {
  app.get('/api/admin/history', async request => service.list(request.query));
  app.get('/api/admin/history/:id', async request => service.detail(request.params.id));
  app.post('/api/admin/history/:id/revert', async request => service.revert(request.params.id, {
    confirm: request.body?.confirm, actor: request.session.username, ip: request.ip, session: request.session.mailcow,
  }));
}
