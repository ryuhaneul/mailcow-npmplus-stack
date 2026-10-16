import { AppError } from '../../errors.js';

export function quotaUsage(rows) {
  const storage = rows.find(row => row?.type === 'STORAGE');
  const numeric = value => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value) * 1024);
  if (!storage || !numeric(storage.value) || !(storage.limit === '-' || numeric(storage.limit)) || rows.some(row => !row || ['root', 'type', 'value', 'limit', 'percent'].some(key => typeof row[key] !== 'string'))) throw new AppError(502, 'DOVEADM_REJECTED', '용량 응답을 읽을 수 없어요.');
  return { usedKiB: storage.value, limitKiB: storage.limit, usedBytes: Number(storage.value) * 1024, limitBytes: storage.limit === '-' ? null : Number(storage.limit) * 1024, raw: rows };
}
export function createQuotaService({ doveadm, audit, lock }) {
  const usage = async mailbox => quotaUsage(await doveadm.call('quotaGet', { user: mailbox }));
  async function recheck({ actor, ip, data }) {
    if (!data || typeof data.mailbox !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(data.mailbox) || Object.keys(data).some(key => key !== 'mailbox')) throw new AppError(422, 'INVALID_INPUT', '메일함 주소를 확인해 주세요.');
    const mailbox = data.mailbox.toLowerCase();
    return lock.run(mailbox, async () => {
      const before = await usage(mailbox);
      return audit.run({ actor, ip, action: 'quota.recheck', target: mailbox, kind: 'info', revertible: false, before }, async intent => {
        await doveadm.call('quotaRecalc', { user: mailbox });
        const after = await usage(mailbox), diff = after.usedBytes - before.usedBytes;
        return { before, after, diff, auditId: intent.id, detail: { before, after, diff } };
      });
    });
  }
  return { usage, recheck };
}
