export default async function sendersRoutes(app, { service }) {
  const options = { config: { adminMailcowApi: true } };
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, addr: request.params.addr, data: request.body });
  app.get('/api/admin/senders/:addr', options, request => service.get(request.session.mailcow, request.params.addr));
  app.post('/api/admin/senders/:addr/diff', request => service.diff(args(request)));
  app.put('/api/admin/senders/:addr', request => service.put(args(request)));
}
