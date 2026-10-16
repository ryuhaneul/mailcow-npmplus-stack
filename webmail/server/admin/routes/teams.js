export default async function teamsRoutes(app, { service }) {
  app.get('/api/admin/teams', async request => service.list(request.session.mailcow, request.query));
  app.post('/api/admin/teams', async request => service.create({ session: request.session.mailcow, actor: request.session.username, ip: request.ip,
    teamAddress: request.body?.teamAddress, members: request.body?.members }));
  for (const method of ['POST', 'DELETE']) app.route({ method, url: '/api/admin/teams/:addr/members', handler: async request => service.change({
    session: request.session.mailcow, actor: request.session.username, ip: request.ip, team: request.params.addr,
    member: request.body?.member, etag: request.body?.etag, add: method === 'POST',
  }) });
}
