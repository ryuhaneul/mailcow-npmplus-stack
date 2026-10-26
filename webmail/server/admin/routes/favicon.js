import { faviconCsp } from '../../favicon-store.js';
export default async function faviconAdminRoutes(app, { service }) {
  const args = request => ({ owner: request.session.id, actor: request.session.username, ip: request.ip, data: request.body });
  app.get('/api/admin/favicon', () => service.get());
  app.post('/api/admin/favicon/preview', { bodyLimit: 400 * 1024 }, request => service.preview(args(request)));
  app.put('/api/admin/favicon', request => service.put(args(request)));
  app.put('/api/admin/favicon/revert', request => service.revert(args(request)));
  app.delete('/api/admin/favicon', request => service.remove(args(request)));
  app.get('/api/admin/favicon/file/:id', { onSend: async (_request, reply, payload) => {
    reply.header('content-security-policy', faviconCsp).header('x-content-type-options', 'nosniff').header('content-disposition', 'inline'); return payload;
  } }, async (request, reply) => { const value = await service.file(request.params.id, request.session.id); return reply.type(value.mime).send(value.data); });
}
