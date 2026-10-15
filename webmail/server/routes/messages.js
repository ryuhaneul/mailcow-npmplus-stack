import { finished } from 'node:stream/promises';

export default async function messageRoutes(app, { service, reader }) {
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
