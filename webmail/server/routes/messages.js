import { createActionService } from '../mail/actions.js';
import { createScopedActionService } from '../mail/scoped-actions.js';
import { AppError, safeStatus } from '../errors.js';
import { finished } from 'node:stream/promises';

export default async function messageRoutes(app, { service, reader }) {
  const actions = createActionService({ imap: app.imap });
  const scoped = createScopedActionService({ imap: app.imap });
  async function scopedResponse(reply, operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError && error.detail) {
        return reply.code(safeStatus(error.statusCode, app.log)).send({
          error: { code: error.code, message: error.message, detail: error.detail },
        });
      }
      throw error;
    }
  }
  app.post('/api/messages/selections', (request, reply) =>
    scopedResponse(reply, () => scoped.prepare(request.session, request.body)));
  app.post('/api/messages/actions/scope', (request, reply) => scopedResponse(reply, async () => {
    try {
      return await scoped.execute(request.session, request.body);
    } finally {
      service.invalidate(request.session);
    }
  }));
  app.get('/api/messages/selections/:id/failed', (request, reply) =>
    scopedResponse(reply, () => scoped.failures(request.session, request.params.id, request.query)));
  app.post('/api/messages/actions', async request => {
    const result = await actions.run(request.session, request.body);
    service.invalidate(request.session);
    return result;
  });
  app.get('/api/messages', request => service.messages(request.session, request.query));
  app.get('/api/messages/:ref', request => reader.read(request.session, request.params.ref, request.query));
  app.get('/api/messages/:ref/parts/:partId', async (request, reply) => {
    await reader.part(request.session, request.params.ref, request.params.partId, request.query, async (stream, headers) => {
      const abort = () => { if (!stream.readableEnded) stream.destroy(); };
      reply.raw.once('close', abort);
      const complete = finished(stream, { cleanup: true });
      reply.headers(headers).send(stream);
      try { await complete; } finally { reply.raw.off('close', abort); }
    });
    return reply;
  });
}
