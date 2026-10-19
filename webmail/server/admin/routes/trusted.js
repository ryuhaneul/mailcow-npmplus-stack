export default async function trustedRoutes(app, { service }) {
  // Keep the structured input detail local to these routes; other admin errors
  // retain the shared error handler and authentication response rules.
  app.addHook('onSend', async (request, reply, payload) => {
    const error = request.adminError;
    if (reply.statusCode !== 422 || error?.code !== 'INVALID_INPUT' || !error.detail || typeof payload !== 'string') return payload;
    const body = JSON.parse(payload);
    body.error.detail = error.detail;
    reply.removeHeader('content-length');
    return JSON.stringify(body);
  });
  const args = request => ({ actor: request.session.username, ip: request.ip, data: request.body, sender: request.params.sender, address: request.params.ip });
  app.get('/api/admin/trusted', () => service.list());
  app.get('/api/admin/trusted/recent', request => service.recent(request.session.mailcow));
  app.post('/api/admin/trusted/senders', request => service.addSender(args(request)));
  app.post('/api/admin/trusted/senders/:sender/ips', request => service.addIps(args(request)));
  app.delete('/api/admin/trusted/senders/:sender/ips/:ip', request => service.removeIp(args(request)));
  app.delete('/api/admin/trusted/senders/:sender', request => service.removeSender(args(request)));
  app.patch('/api/admin/trusted/senders/:sender', request => service.memo(args(request)));
}
