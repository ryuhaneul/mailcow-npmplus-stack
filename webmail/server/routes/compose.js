import multipart from '@fastify/multipart';
import { errorBody } from '../errors.js';

export default async function composeRoutes(app, { service, config }) {
  await app.register(multipart, { limits: { files: 1, fields: 1, parts: 2, fieldSize: 128, fileSize: config.attachMaxMb * 1024 * 1024 } });
  app.post('/api/attachments', async (request, reply) => reply.code(201).send(await service.upload(request.session, request.parts())));
  app.delete('/api/attachments/:id', async (request, reply) => {
    await service.remove(request.session, request.params.id);
    return reply.code(204).send();
  });
  app.get('/api/drafts/:ref', async request => service.loadDraft(request.session, request.params.ref));
  app.put('/api/drafts', async request => service.draft(request.session, request.body));
  app.post('/api/send', async (request, reply) => {
    try { return await service.send(request.session, request.body); } catch (error) {
      if (error.code !== 'SMTP_REJECTED') throw error;
      return reply.code(502).send({ error: { ...errorBody(error.code, error.message).error, smtpMessage: error.smtpMessage } });
    }
  });
}
