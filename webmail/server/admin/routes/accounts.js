export default async function accountsRoutes(app, { service }) {
  app.get('/api/admin/quota', { config: { adminMailcowApi: true } }, async request => service.quotaList(request.session.mailcow));
  app.get('/api/admin/mailboxes', { config: { adminMailcowApi: true } }, async request => service.list(request.session.mailcow, request.query));
  app.get('/api/admin/mailboxes/:addr', async request => service.detail(request.session.mailcow, request.params.addr));
  app.post('/api/admin/mailboxes', async request => service.create({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, data: request.body }));
  app.post('/api/admin/mailboxes/:addr/delete-preview', async request => service.deletePreview(request.session.mailcow, request.params.addr));
  app.delete('/api/admin/mailboxes/:addr', async request => service.remove({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, addr: request.params.addr, data: request.body }));
  app.post('/api/admin/mailboxes/:addr/rename', async request => service.rename({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, addr: request.params.addr, data: request.body }));
  for (const direction of ['mailbox-to-alias', 'alias-to-mailbox']) app.post(`/api/admin/convert/${direction}`, async request => service.convert({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, direction, data: request.body }));
  app.post('/api/admin/flows/leave', async request => service.leave({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, data: request.body }));
  app.patch('/api/admin/mailboxes/:addr', async request => service.edit({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, addr: request.params.addr, data: request.body }));
}
