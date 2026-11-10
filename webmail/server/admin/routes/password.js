import { AppError } from '../../errors.js';
import { cookieName } from '../session.js';
import { ADMIN_ACCOUNTS_LOCK } from '../lock.js';

export default async function passwordRoutes(app) {
  app.post('/api/admin/auth/password', async request => {
    const body = request.body;
    const currentPassword = typeof body?.currentPassword === 'string' ? Buffer.from(body.currentPassword) : Buffer.alloc(0);
    let password = body?.password, password2 = body?.password2;
    if (body && typeof body === 'object') {
      delete body.currentPassword;
      delete body.password;
      delete body.password2;
    }
    try {
      if (!currentPassword.length || typeof password !== 'string' || !password.length || typeof password2 !== 'string' || password !== password2) {
        throw new AppError(422, 'INVALID_INPUT', '현재 암호와 새 암호를 입력하고, 새 암호 확인을 일치시켜 주세요.');
      }
      return await app.adminLock.run(ADMIN_ACCOUNTS_LOCK, async () => {
        const session = await app.adminSessions.get(request.cookies[cookieName]);
        if (session.state !== 'ready') throw new AppError(403, 'NO_SESSION', '로그인을 먼저 완료해 주세요.');
        const release = app.adminRateLimiter.reserve(request.ip, session.username);
        let temporary;
        try {
          temporary = await app.mailcow.login({ username: session.username, password: currentPassword, ip: request.ip });
          if (!['ready', 'totp'].includes(temporary.state)) throw new AppError(403, 'ADMIN_PENDING_ACTION', 'mailcow 관리 화면에서 필요한 작업을 먼저 끝내 주세요.');
        } catch (error) {
          if (error.code === 'AUTH_FAILED') {
            error.remainingAttempts = app.adminRateLimiter.remaining(request.ip, session.username);
            throw Object.assign(new AppError(403, 'AUTH_FAILED', '현재 암호가 맞지 않습니다. 현재 암호를 확인하고 다시 입력해 주세요.'), { remainingAttempts: error.remainingAttempts });
          }
          release();
          throw error;
        } finally {
          if (temporary) await app.mailcow.logout(temporary);
        }
        release();
        const detail = await app.mailcow.call(session.mailcow, 'GET', `/api/v1/get/admin/${encodeURIComponent(session.username)}`);
        const flags = { active: detail?.active, force_tfa: detail?.attributes?.force_tfa, force_pw_update: detail?.attributes?.force_pw_update };
        for (const key of ['active', 'force_tfa', 'force_pw_update']) {
          if (![0, 1, '0', '1'].includes(flags[key])) throw new AppError(502, 'MAILCOW_REJECTED', '관리자 계정 상태를 확인할 수 없어 암호를 변경하지 않았어요.');
        }
        if (Number(flags.active) !== 1) throw new AppError(403, 'NO_SESSION', '사용 중인 관리자 계정으로 다시 로그인해 주세요.');
        await app.audit.run({ actor: session.username, ip: request.ip, action: 'admin.password.change', target: session.username,
          kind: 'credential', revertible: false, before: {}, after: { password: 'changed' } }, async () => {
          const current = await app.adminSessions.get(request.cookies[cookieName]);
          if (current !== session || current.state !== 'ready') throw new AppError(403, 'NO_SESSION', '로그인을 먼저 완료해 주세요.');
          const cleanup = app.adminSessions.invalidateUser(session.username, { exceptId: session.id });
          try {
            await app.mailcow.call(session.mailcow, 'POST', '/api/v1/edit/admin', { items: [session.username], attr: { password, password2, ...flags } }, undefined, { rejectWarnings: true });
          } finally {
            app.adminSessions.bumpGeneration(session.username);
            await cleanup;
          }
        });
        return { ok: true };
      });
    } finally {
      currentPassword.fill(0);
      password = undefined;
      password2 = undefined;
    }
  });
}
