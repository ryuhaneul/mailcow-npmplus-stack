import { createEventService } from '../mail/events.js';

export default async function eventRoutes(app) {
  const service = createEventService({ imap: app.imap, sessions: app.sessions, logger: app.log });
  const streams = new Set();
  app.addHook('preClose', async () => { for (const stream of streams) stream.destroy(); });
  app.get('/api/events', (request, reply) => {
    const stream = service.open(request.session);
    streams.add(stream);
    const abort = () => stream.destroy();
    reply.raw.once('close', abort);
    stream.once('close', () => { streams.delete(stream); reply.raw.off('close', abort); });
    return reply.type('text/event-stream').header('cache-control', 'no-store').header('x-accel-buffering', 'no').send(stream);
  });
}
