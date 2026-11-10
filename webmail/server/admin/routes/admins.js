import { cookieName } from '../session.js';

export default async function adminsRoutes(app, { service }) {
  app.get('/api/admin/admins', { config: { adminMailcowApi: true } }, request => service.list(request.session.mailcow));
  const input = request => ({ token: request.cookies[cookieName], ip: request.ip, username: request.params.username, data: request.body });
  app.post('/api/admin/admins', request => service.create(input(request)));
  app.patch('/api/admin/admins/:username/active', request => service.active(input(request)));
  app.post('/api/admin/admins/:username/password', request => service.password(input(request)));
  app.delete('/api/admin/admins/:username', request => service.remove(input(request)));
}
