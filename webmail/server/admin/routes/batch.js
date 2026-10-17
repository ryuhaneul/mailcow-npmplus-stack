import { AppError } from '../../errors.js';

export default async function batchRoutes(app, { service }) {
  app.post('/api/admin/batch/:kind', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    try { return await service.run({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, kind: request.params.kind, data: request.body }); }
    catch (error) {
      if (error instanceof AppError && error.statusCode === 422 && Number.isInteger(error.line)) return reply.code(422).send({ error: { code: error.code, message: error.message, line: error.line } });
      throw error;
    }
  });
}
