export default async function logoRoutes(app, { service }) {
  const args = request => ({ owner: request.session.id, actor: request.session.username, ip: request.ip, data: request.body });
  app.get('/api/admin/logo', () => service.get());
  app.post('/api/admin/logo/preview', { bodyLimit: 2 * 1024 * 1024 }, request => service.preview(args(request)));
  app.put('/api/admin/logo', request => service.put(args(request)));
  app.get('/api/admin/logo/file/:which', { onSend: async (_request, reply, payload) => { if (reply.statusCode === 200) reply.header('x-content-type-options', 'nosniff').header('content-security-policy', 'sandbox').header('content-disposition', 'inline'); return payload; } }, async (request, reply) => { const result = await service.file(request.params.which, request.session.id); return reply.type(result.mime).send(result.data); });
}
