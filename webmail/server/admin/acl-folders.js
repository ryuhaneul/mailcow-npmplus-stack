import { AppError } from '../errors.js';
import { assertAclMailbox } from './dockerapi.js';

export function createAclFolders({ doveadm, config, dockerapi }) {
  const enabled = Boolean(config.doveadmUrl && config.doveadmKey);
  async function list(owner) {
    if (!enabled) return ['INBOX'];
    const rows = await doveadm.call('mailboxList', { user: owner });
    return [...new Set(rows.map(row => row.mailbox).filter(mailbox => mailbox !== 'Shared' && !mailbox.startsWith('Shared/')))];
  }
  async function assertExist(owner, mailboxes) {
    mailboxes.forEach(assertAclMailbox);
    const available = new Set(await list(owner));
    if (mailboxes.some(mailbox => !available.has(mailbox))) throw new AppError(409, 'CONFLICT', '폴더가 바뀌었어요. 다시 읽고 확인해 주세요.');
  }
  async function readOwned(owner) {
    if (!enabled) return (await dockerapi.getAcl(owner)).filter(row => row.user.toLowerCase() === owner.toLowerCase() && row.mailbox === 'INBOX');
    const result = [];
    for (const mailbox of await list(owner)) {
      let rows;
      try { rows = await doveadm.call('aclGet', { user: owner, mailbox }); } catch (error) {
        if (error instanceof AppError && error.code === 'MAILBOX_NOT_FOUND') continue;
        throw error;
      }
      for (const { id, global, rights } of rows) {
        if (typeof global !== 'string') throw new AppError(502, 'DOVEADM_REJECTED', 'doveadm이 요청을 거절했어요.');
        result.push({ user: owner, id: id.startsWith('user=') ? id.slice(5) : id, mailbox, rights: [...(global ? ['global'] : []), ...rights.split(/\s+/).filter(Boolean)] });
      }
    }
    return result;
  }
  return { enabled, list, assertExist, readOwned };
}
