async function archiveRequest(request, reply, run) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const requestClosed = () => { if (request.raw.aborted || !request.raw.complete) abort(); };
  const responseClosed = () => { if (!reply.raw.writableEnded) abort(); };
  request.raw.once('aborted', abort);
  request.raw.once('close', requestClosed);
  reply.raw.once('close', responseClosed);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  try { return await run({ signal: controller.signal }); }
  finally {
    request.raw.removeListener('aborted', abort);
    request.raw.removeListener('close', requestClosed);
    reply.raw.removeListener('close', responseClosed);
  }
}

export default async function logsRoutes(app, { service }) {
  app.get('/api/admin/logs', { config: { adminMailcowApi: true } }, request => service.logs(request.session.mailcow, request.query));
  app.get('/api/admin/logs/archive', (request, reply) => archiveRequest(request, reply, options => service.archive(request.query, options)));
  app.get('/api/admin/logs/archive/status', (request, reply) => archiveRequest(request, reply, options => service.archiveStatus(options)));
  app.get('/api/admin/compat-usage', { config: { adminMailcowApi: true } }, request => service.compatUsage(request.session.mailcow));
  app.get('/api/admin/admins', { config: { adminMailcowApi: true } }, request => service.admins(request.session.mailcow));
  app.get('/api/admin/autoexpunge', request => service.autoexpunge(request.session.mailcow));
}
