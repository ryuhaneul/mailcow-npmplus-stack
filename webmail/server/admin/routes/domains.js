export default async function domainsRoutes(app, { service }) {
  const options = { config: { adminMailcowApi: true } };
  const args = request => ({ session: request.session.mailcow, actor: request.session.username, ip: request.ip, data: request.body });
  // These conflicts include safe dependency names so administrators can resolve them first.
  const details = handler => async (request, reply) => {
    try { return await handler(request); }
    catch (error) {
      if (error.statusCode === 409 && ['DKIM_EXISTS', 'ALIAS_DOMAIN_IN_USE'].includes(error.code)) return reply.code(409).send({ error: { code: error.code, message: error.message, ...error.details } });
      throw error;
    }
  };
  app.get('/api/admin/domains', options, request => service.list(request.session.mailcow));
  app.post('/api/admin/domains', request => service.create(args(request)));
  app.patch('/api/admin/domains/:domain', request => service.edit({ ...args(request), name: request.params.domain }));
  app.get('/api/admin/alias-domains', options, request => service.listAliases(request.session.mailcow));
  app.post('/api/admin/alias-domains', request => service.createAlias(args(request)));
  app.delete('/api/admin/alias-domains/:aliasDomain', details(request => service.removeAlias({ ...args(request), name: request.params.aliasDomain })));
  app.get('/api/admin/dkim/:domain', options, request => service.dkim(request.session.mailcow, request.params.domain, request.query));
  app.post('/api/admin/dkim/duplicate', details(request => service.duplicate(args(request))));
  app.get('/api/admin/dns', options, request => service.dns(request.session.mailcow, request.query));
}
