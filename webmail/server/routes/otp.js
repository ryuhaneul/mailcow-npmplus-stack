import { cookieName, cookieOptions } from '../security/session.js';

export default async function otpRoutes(app, { config }) {
  const noQuery = request => app.otp.validateBody(request.query ?? {}, []);
  const changing = operation => async (request, reply) => {
    noQuery(request);
    const { token, value } = await app.otp[operation](request.session, request.ip, request.body);
    reply.setCookie(cookieName, token, cookieOptions(config));
    return value;
  };
  app.get('/api/otp', async request => {
    noQuery(request);
    const { enabled, registeredAt, forced, version } = app.otp.metadata(request.otpSnapshot);
    return { enabled, registeredAt, forced, version };
  });
  app.post('/api/otp/enrollment', async request => {
    noQuery(request); app.otp.validateBody(request.body, []);
    return app.otp.begin(request.session);
  });
  app.post('/api/otp/enrollment/confirm', changing('confirm'));
  app.delete('/api/otp/enrollment', async (request, reply) => {
    noQuery(request);
    if (request.body !== undefined) app.otp.validateBody(request.body, []);
    await app.otp.cancel(request.session);
    return reply.code(204).send();
  });
  app.post('/api/otp/disable', changing('disable'));
}
