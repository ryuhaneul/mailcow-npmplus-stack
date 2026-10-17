export default async function statusRoutes(app, { service }) {
  app.get('/api/admin/status', { config: { adminMailcowApi: true } }, request => service.status(request.session.mailcow));
  app.get('/api/admin/queue', { config: { adminMailcowApi: true } }, request => service.queue(request.session.mailcow));
}
