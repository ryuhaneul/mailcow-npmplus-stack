import { AppError } from '../errors.js';

export function createAclReader({ doveadm, dockerapi, config }) {
  async function getAcl(owner) {
    if (!config.doveadmUrl || !config.doveadmKey) return dockerapi.getAcl(owner);
    const folders = await doveadm.call('mailboxList', { user: owner });
    const result = [];
    for (const { mailbox } of folders) {
      if (mailbox === 'Shared' || mailbox.startsWith('Shared/')) continue;
      const rows = await doveadm.call('aclGet', { user: owner, mailbox });
      for (const { id, global, rights } of rows) {
        if (typeof global !== 'string') throw new AppError(502, 'DOVEADM_REJECTED', 'doveadm이 요청을 거절했어요.');
        result.push({ user: owner, id: id.slice(id.indexOf('=') + 1), mailbox, rights: [...(global ? ['global'] : []), ...rights.split(/\s+/).filter(Boolean)] });
      }
    }
    return result;
  }
  return { getAcl };
}
