export default async function quotaNotificationRoutes(app, { service }) {
  app.get('/api/admin/quota/notifications', { config: { adminMailcowApi: true } }, request => service.view(request.session.mailcow));
  app.put('/api/admin/quota/notifications', request => service.save({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, data: request.body }));
}
