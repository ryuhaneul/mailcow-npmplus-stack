import { randomBytes } from 'node:crypto';
import { AppError } from '../../errors.js';
import { isMailboxAddress } from '../doveadm.js';
import { groupMailboxAddresses } from './shares.js';
import { kstTimestamp } from '../audit.js';

const folders = Object.freeze({ inbox: 'INBOX', sent: 'Sent', junk: 'Junk', all: '*' });
const invalid = () => new AppError(422, 'INVALID_INPUT', '메일함과 정리 조건을 확인해 주세요.');
const expired = () => new AppError(409, 'PREVIEW_EXPIRED', '확인 시간이 지났어요. 개수를 다시 확인해 주세요.');
export function createCleanupService({ mailcow, doveadm, quota, audit, lock, now = Date.now }) {
  const previews = new Map();
  function sweep() { for (const [token, value] of previews) if (value.expires <= now()) previews.delete(token); }
  async function teamCheck(session, mailbox, confirmed) {
    let filters = await mailcow.call(session, 'GET', '/api/v1/get/filters/all');
    if (filters && typeof filters === 'object' && !Object.keys(filters).length) filters = [];
    if (!Array.isArray(filters)) throw new AppError(502, 'MAILCOW_REJECTED', '팀 목록을 읽을 수 없어요.');
    if (groupMailboxAddresses(filters).has(mailbox) && confirmed !== true) throw new AppError(422, 'TEAM_CONFIRM_REQUIRED', '팀 메일함의 메일을 정리하는지 확인해 주세요.');
  }
  async function search(mailbox, query) {
    const rows = await doveadm.call('search', { user: mailbox, query });
    if (rows.some(row => typeof row?.['mailbox-guid'] !== 'string' || typeof row.uid !== 'string')) throw new AppError(502, 'DOVEADM_REJECTED', '메일 개수를 읽을 수 없어요.');
    return rows.length;
  }
  async function count({ session, data }) {
    sweep();
    const before = data?.before;
    if (typeof before !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(before) || !Number.isFinite(Date.parse(`${before}T00:00:00Z`)) || new Date(`${before}T00:00:00Z`).toISOString().slice(0, 10) !== before || before > kstTimestamp(now()).slice(0, 10)) throw new AppError(422, 'DATE_REQUIRED', '기준일을 올바르게 입력해 주세요.');
    if (!data || !isMailboxAddress(data.mailbox) || !Object.hasOwn(folders, data.folder) || Object.keys(data).some(key => !['mailbox', 'folder', 'before', 'confirmTeam'].includes(key)) || (data.confirmTeam !== undefined && typeof data.confirmTeam !== 'boolean')) throw invalid();
    const mailbox = data.mailbox.toLowerCase();
    await teamCheck(session, mailbox, data.confirmTeam);
    return lock.run(mailbox, async () => {
      const folder = folders[data.folder];
      if (folder !== '*') {
        const rows = await doveadm.call('mailboxList', { user: mailbox });
        if (!rows.some(row => row?.mailbox === folder)) throw new AppError(404, 'NOT_FOUND', '메일 폴더를 찾을 수 없어요.');
      }
      const query = ['mailbox', folder, 'before', before];
      const count = await search(mailbox, query), usage = await quota.usage(mailbox);
      const token = randomBytes(32).toString('hex');
      previews.set(token, { session, mailbox, folder: data.folder, before, query, count, usage, confirmTeam: data.confirmTeam === true, expires: now() + 600_000 });
      return { count, usage, token };
    });
  }
  async function run({ session, actor, ip, data }) {
    sweep();
    if (!data || typeof data.token !== 'string' || Object.keys(data).some(key => !['token', 'confirmAddress'].includes(key))) throw invalid();
    const preview = previews.get(data.token);
    if (!preview || preview.session !== session) throw expired();
    if (data.confirmAddress !== preview.mailbox) throw new AppError(422, 'CONFIRM_ADDRESS_REQUIRED', '메일함 주소를 그대로 입력해 주세요.');
    return lock.run(preview.mailbox, async () => {
      if (previews.get(data.token) !== preview || preview.expires <= now()) throw expired();
      previews.delete(data.token);
      await teamCheck(session, preview.mailbox, preview.confirmTeam);
      const count = await search(preview.mailbox, preview.query);
      if (count !== preview.count) throw new AppError(409, 'COUNT_CHANGED', '확인한 뒤 메일 수가 바뀌어 지우지 않았어요. 개수를 다시 확인해 주세요.');
      const usage = await quota.usage(preview.mailbox);
      const conditions = { mailbox: preview.mailbox, folder: preview.folder, before: preview.before };
      return audit.run({ actor, ip, action: 'cleanup.run', target: preview.mailbox, kind: 'irreversible', revertible: false, before: { ...conditions, count, usage }, after: { ...conditions, count: 0 } }, async intent => {
        await doveadm.call('expunge', { user: preview.mailbox, query: preview.query });
        const remaining = await search(preview.mailbox, preview.query), after = await quota.usage(preview.mailbox);
        const detail = { ...conditions, deleted: count - remaining, remaining, before: usage, after };
        return { ...detail, auditId: intent.id, ...(remaining ? { result: 'partial', recovery: '남은 메일 수를 다시 확인한 뒤 정리해 주세요.' } : {}), detail };
      });
    });
  }
  return { count, run };
}
