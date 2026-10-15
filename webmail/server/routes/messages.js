import { createActionService } from '../mail/actions.js';
import { finished } from 'node:stream/promises';

export default async function messageRoutes(app, { service, reader }) {
  const actions = createActionService({ imap: app.imap });
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
