import { AppError } from '../../errors.js';

export default async function apiKeysRoutes(app, { service }) {
  app.addHook('preHandler', async request => {
    if (request.adminPrincipal?.type === 'apiKey' || request.session?.state !== 'ready') throw new AppError(403, 'API_KEY_FORBIDDEN', 'API 키 관리는 관리자 로그인 후 사용할 수 있어요.');
  });
  const args = request => ({ actor: request.session.username, ip: request.ip, data: request.body });
  app.get('/api/admin/api-keys', request => service.list(request.query));
  app.post('/api/admin/api-keys', async (request, reply) => reply.code(201).send(await service.create(args(request))));
  app.delete('/api/admin/api-keys/:id', request => service.remove({ ...args(request), id: request.params.id }));
}
