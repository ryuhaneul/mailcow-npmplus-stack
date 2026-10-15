import { createPasswordService } from '../mailcow/password.js';
import { AppError } from '../errors.js';
import { cookieName, cookieOptions } from '../security/session.js';

export default async function passwordRoutes(app, { config }) {
  const service = createPasswordService({ config, sessions: app.sessions, rateLimiter: app.rateLimiter, logger: app.log });
  app.post('/api/password', async (request, reply) => {
    try {
      const result = await service.change(request.session, request.body);
      reply.clearCookie(cookieName, { ...cookieOptions(config), maxAge: 0 });
      return result;
    } catch (error) {
      if (!(error instanceof AppError) || !error.fallbackUrl) throw error;
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, fallbackUrl: error.fallbackUrl } });
    }
  });
}
