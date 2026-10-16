export default async function rspamdMapsRoutes(app, { service }) {
  app.get('/api/admin/rspamd-maps/:name', request => service.get(request.session.mailcow, request.params.name));
  app.put('/api/admin/rspamd-maps/:name', { bodyLimit: 2 * 1024 * 1024 }, request => service.put({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, name: request.params.name, data: request.body }));
}
