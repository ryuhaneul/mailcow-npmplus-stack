export default async function sharesRoutes(app, { service }) {
  app.get('/api/admin/shares', async request => service.list(request.session.mailcow, request.query));
  app.get('/api/admin/shares/:owner', async request => service.get(request.session.mailcow, request.params.owner));
  for (const method of ['POST', 'DELETE']) {
    app.route({ method, url: '/api/admin/shares/:owner', handler: async request => service.change({
      session: request.session.mailcow, actor: request.session.username, ip: request.ip,
      owner: request.params.owner, grantee: request.body?.grantee, etag: request.body?.etag, grant: method === 'POST',
    }) });
  }
}
