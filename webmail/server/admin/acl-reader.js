export function createAclReader({ doveadm, dockerapi, config }) {
  async function getAcl(owner) {
    if (!config.doveadmUrl || !config.doveadmKey) return dockerapi.getAcl(owner);
    const folders = await doveadm.call('mailboxList', { user: owner });
    const result = [];
    for (const { mailbox } of folders) {
      if (mailbox.startsWith('Shared/')) continue;
      const rows = await doveadm.call('aclGet', { user: owner, mailbox });
      for (const { id, rights } of rows) {
        result.push({ user: owner, id: id.slice(id.indexOf('=') + 1), mailbox, rights: rights.split(/\s+/).filter(Boolean) });
      }
    }
    return result;
  }
  return { getAcl };
}
