import { AppError } from '../../errors.js';
export default async function otpRoutes(app, { service }) {
  const args = request => {
    if (Object.keys(request.query ?? {}).length) throw new AppError(422, 'INVALID_INPUT', '입력값을 확인해 주세요.');
    return { session: request.session.mailcow, actor: request.session.username, ip: request.ip, addr: request.params.addr, data: request.body };
  };
  app.get('/api/admin/otp/policy', request => service.policy(args(request)));
  app.put('/api/admin/otp/policy', request => service.setPolicy(args(request)));
  app.get('/api/admin/otp/accounts/:addr', request => service.status(args(request)));
  app.post('/api/admin/otp/accounts/:addr/reset', request => service.reset(args(request)));
}
