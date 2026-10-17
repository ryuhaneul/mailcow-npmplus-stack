import { createAclFolders } from './acl-folders.js';

export function createAclReader({ doveadm, dockerapi, config }) {
  const folders = createAclFolders({ doveadm, dockerapi, config });
  return { getAcl: folders.enabled ? folders.readOwned : owner => dockerapi.getAcl(owner) };
}
