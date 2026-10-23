import { AppError } from '../../errors.js';
import { collectMailboxQuota } from './quota.js';
import { etag, assertUnchanged } from '../lock.js';
import { validateQuotaNotifications, notificationAddress } from '../quota-notification-state.js';
export const quotaNotificationErrors = {
  SMTP_REJECTED: '메일 서버가 관리 앱의 발송을 허용하지 않아요. 주소와 내부 릴레이 설정을 확인해 주세요.',
  SEND_FAILED: '알림 메일을 보내지 못했어요. 다음 점검에서 다시 시도합니다.',
  UNCONFIRMED: '마지막 시도 결과 확인 안 됨. 중복 방지를 위해 발송 간격을 기다립니다.',
  COLLECTION_FAILED: '계정 사용량 수집에 실패했어요. mailcow API 연결 설정을 확인해 주세요.',
};
export function quotaNotificationTargets(rows, settings, accounts, now) {
  if (!settings.enabled || !settings.sender) return [];
  const time = value => value ? Date.parse(value) : 0;
  return rows.map(row => ({ ...row, username: String(row.username ?? '').toLowerCase(), quota: Number(row.quota), quota_used: Number(row.quota_used) }))
    .filter(row => notificationAddress(row.username) && Number(row.active) === 1 && Number.isFinite(row.quota) && row.quota > 0 && Number.isFinite(row.quota_used) && row.quota_used >= 0 &&
      row.quota_used / row.quota * 100 >= settings.threshold && (!accounts[row.username]?.lastSentAt || now - time(accounts[row.username].lastSentAt) >= settings.intervalMinutes * 60_000))
    .sort((a, b) => {
      const attempted = row => Math.max(time(accounts[row.username]?.lastSentAt), time(accounts[row.username]?.lastFailure?.at));
      return attempted(a) - attempted(b) || a.username.localeCompare(b.username);
    }).filter((row, index, all) => all.findIndex(other => other.username === row.username) === index).slice(0, 200);
}
export function createQuotaNotificationsService({ store, mailcow, config, audit, lock, history, send, now = Date.now }) {
  history?.register('quota.notifications.settings', { label: '쿼터 알림 설정을 바꿨어요' });
  history?.register('quota.notifications.send', { label: '쿼터 알림을 보냈어요' });
  async function view(session) {
    const settings = await store.readSettings(), state = await store.readState(), warnings = [];
    if (!config.mailcowApiKey) warnings.push('자동 사용량 수집용 mailcow API 키가 설정되지 않았어요.');
    if (settings.sender) {
      try {
        const rows = await mailcow.call(session, 'GET', '/api/v1/get/domain/all');
        if (!Array.isArray(rows)) throw new Error();
        if (!rows.some(row => String(row.domain_name ?? row.domain).toLowerCase() === settings.sender.split('@')[1])) warnings.push('보내는 주소가 관리 도메인 목록에 없어요.');
      } catch (error) { if (error.code === 'MAILCOW_SESSION_LOST') throw error; warnings.push('보내는 주소의 관리 도메인 여부를 확인하지 못했어요.'); }
    }
    return { settings, etag: etag(settings), effectiveEnabled: settings.enabled && Boolean(settings.sender), state, warnings };
  }
  async function save({ session, actor, ip, data }) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.etag !== 'string') throw new AppError(422, 'INVALID_INPUT', '알림 설정을 확인해 주세요.');
    const { etag: expected, ...input } = data, settings = validateQuotaNotifications(input);
    await lock.run('quota-notifications-settings', async () => {
      const before = await store.readSettings(); assertUnchanged(expected, before);
      await audit.run({ actor, ip, action: 'quota.notifications.settings', target: '쿼터 알림', kind: 'config', revertible: false, before, after: settings }, async () => { await store.saveSettings(settings); return {}; });
    });
    return view(session);
  }
  async function runOnce({ stopped = () => false } = {}) {
    const state = await store.readState(), stamp = () => new Date(now()).toISOString();
    let recovered = false;
    for (const row of Object.values(state.accounts)) if (row.pendingAt) {
      row.lastSentAt = row.pendingAt; row.lastFailure = { at: stamp(), code: 'UNCONFIRMED' }; row.pendingAt = null; recovered = true;
    }
    if (recovered) await store.saveState(state);
    const settings = await store.readSettings();
    if (!settings.enabled || !settings.sender || stopped()) return { sent: 0, failed: 0 };
    return audit.run({ actor: '자동 쿼터 알림', ip: '127.0.0.1', action: 'quota.notifications.send', target: '쿼터 알림', kind: 'info', revertible: false }, async () => {
      let rows;
      try {
        if (!config.mailcowApiKey) throw new Error();
        rows = await collectMailboxQuota(mailcow, mailcow.createApiContext({ permission: 'read' }));
      } catch {
        state.lastCheckAt = stamp(); state.lastRunFailure = { at: stamp(), code: 'COLLECTION_FAILED' }; await store.saveState(state);
        return { result: 'partial', detail: { sent: 0, failed: 1 } };
      }
      const candidates = quotaNotificationTargets(rows, settings, state.accounts, now());
      let sent = 0, failed = 0;
      for (const mailbox of candidates) {
        if (stopped() || etag(await store.readSettings()) !== etag(settings)) break;
        const row = state.accounts[mailbox.username] ??= { lastSentAt: null, lastFailure: null, pendingAt: null };
        row.pendingAt = stamp(); await store.saveState(state);
        let error;
        try { await send(settings.sender, mailbox); } catch (failure) { error = failure; }
        if (!error) { row.lastSentAt = stamp(); row.lastFailure = null; sent++; }
        else {
          failed++;
          const code = error.explicit === true ? error.code === 'SMTP_REJECTED' ? 'SMTP_REJECTED' : 'SEND_FAILED' : 'UNCONFIRMED';
          if (code === 'UNCONFIRMED') row.lastSentAt = row.pendingAt;
          row.lastFailure = { at: stamp(), code };
        }
        row.pendingAt = null; await store.saveState(state);
      }
      state.lastCheckAt = stamp(); state.lastRunFailure = null; await store.saveState(state);
      return { result: failed ? 'partial' : 'ok', detail: { sent, failed } };
    });
  }
  return { view, save, runOnce };
}
