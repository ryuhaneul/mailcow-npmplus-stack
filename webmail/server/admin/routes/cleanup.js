import { AppError } from '../../errors.js';

export default async function cleanupRoutes(app, { cleanup, quota, enabled }) {
  const args = request => {
    if (!enabled) throw new AppError(404, 'CLEANUP_DISABLED', '메일 정리와 용량 재확인이 꺼져 있어요.');
    return { session: request.session.mailcow, actor: request.session.username, ip: request.ip, data: request.body };
  };
  app.post('/api/admin/cleanup/count', request => cleanup.count(args(request)));
  app.post('/api/admin/cleanup/run', request => cleanup.run(args(request)));
  app.post('/api/admin/quota-recheck', request => quota.recheck(args(request)));
}
