export default async function flowsRoutes(app, { service }) {
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, data: request.body });
  app.post('/api/admin/flows/team-move', async (request, reply) => {
    try { return await service.teamMove(args(request)); }
    catch (error) {
      if (error.code === 'TEAM_DISTRIBUTION_UNKNOWN') return reply.code(409).send({ error: { code: error.code, message: error.message, reason: error.reason } });
      throw error;
    }
  });
  app.post('/api/admin/flows/alias', request => service.alias(args(request)));
}
