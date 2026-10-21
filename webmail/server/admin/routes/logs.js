export default async function logsRoutes(app, { service }) {
  app.get('/api/admin/logs', { config: { adminMailcowApi: true } }, request => service.logs(request.session.mailcow, request.query));
  app.get('/api/admin/logs/archive', request => service.archive(request.query));
  app.get('/api/admin/logs/archive/status', () => service.archiveStatus());
  app.get('/api/admin/compat-usage', { config: { adminMailcowApi: true } }, request => service.compatUsage(request.session.mailcow));
  app.get('/api/admin/admins', { config: { adminMailcowApi: true } }, request => service.admins(request.session.mailcow));
  app.get('/api/admin/autoexpunge', request => service.autoexpunge(request.session.mailcow));
}
