import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';
import { createAclFolders } from '../acl-folders.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', '서로 다른 활성 메일함을 선택해 주세요.');
const unsupported = () => new AppError(409, 'ACL_UNSUPPORTED', '이 공유는 다른 권한이 섞여 있어 화면에서 바꿀 수 없어요. 관리자에게 문의해 주세요.');
const isTemplateFolder = mailbox => mailbox === 'Templates' || mailbox.startsWith('Templates/');
const readOnly = rights => isDeepStrictEqual(rights, ['lookup', 'read']);
const address = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
export function groupMailboxAddresses(filters) {
  return new Set(filters.filter(row => typeof row?.username === 'string' && row.username && row.filter_type === 'prefilter' && String(row.active) === '1' && String(row.script_data ?? '').toLowerCase().includes('redirect')).map(row => row.username.toLowerCase()));
}
export function createSharesService({ mailcow, dockerapi, audit, lock, history, config = {}, aclFolders = createAclFolders({ dockerapi, config: {} }) }) {
  const warnings = aclFolders.enabled ? [] : ['SUBFOLDER_ACL_UNCHECKED'];
  const wholeMailbox = config.wholeMailbox === true;
  function describe(state) {
    const grants = state.grants.map(row => {
      const shared = row.folders.some(folder => folder.mailbox === 'INBOX');
      return { ...row, shared, residualFolders: shared ? 0 : row.folders.length, readOnly: row.folders.every(folder => readOnly(folder.rights)) };
    });
    return { grantees: grants.filter(row => row.shared).map(row => row.grantee), grants, wholeMailbox, warnings, etag: etag(state) };
  }
  function normalized(grants) {
    return { version: 2, grants: grants.filter(row => row.folders.length).map(row => ({ ...row, folders: [...row.folders].sort((a, b) => a.mailbox.localeCompare(b.mailbox)) })).sort((a, b) => a.grantee.localeCompare(b.grantee)) };
  }
  async function mailboxes(session) {
    let rows = await mailcow.call(session, 'GET', '/api/v1/get/mailbox/all');
    if (rows && typeof rows === 'object' && !Object.keys(rows).length) rows = [];
    if (!Array.isArray(rows)) throw new AppError(502, 'MAILCOW_REJECTED', '메일함 목록을 읽을 수 없어요.');
    return rows.filter(row => typeof row?.username === 'string' && String(row.active) === '1').map(row => ({ owner: row.username.toLowerCase(), name: typeof row.name === 'string' ? row.name : '' }));
  }
  async function validate(session, owner, grantees) {
    const active = new Set((await mailboxes(session)).map(row => row.owner));
    if (!active.has(owner) || grantees.some(grantee => !active.has(grantee) || grantee === owner)) throw invalid();
  }
  async function snapshot(owner) {
    const grants = new Map();
    for (const row of await aclFolders.readOwned(owner)) {
      if (row.user.toLowerCase() !== owner) continue;
      const grantee = row.id.toLowerCase();
      if (!grants.has(grantee)) grants.set(grantee, new Map());
      const folders = grants.get(grantee);
      folders.set(row.mailbox, [...new Set([...(folders.get(row.mailbox) ?? []), ...row.rights])].sort());
    }
    return normalized([...grants].map(([grantee, folders]) => ({ grantee, folders: [...folders].map(([mailbox, rights]) => ({ mailbox, rights })) })));
  }
  async function list(session, { q = '', page = '1' } = {}) {
    if (typeof q !== 'string' || !/^[1-9]\d*$/.test(String(page)) || !Number.isSafeInteger(Number(page))) throw invalid();
    const boxes = await mailboxes(session);
    let filters = await mailcow.call(session, 'GET', '/api/v1/get/filters/all');
    if (filters && typeof filters === 'object' && !Object.keys(filters).length) filters = [];
    if (!Array.isArray(filters)) throw new AppError(502, 'MAILCOW_REJECTED', '팀 목록을 읽을 수 없어요.');
    const groups = groupMailboxAddresses(filters);
    const search = q.trim().toLowerCase();
    const selected = boxes.filter(box => `${box.owner} ${box.name}`.toLowerCase().includes(search)).sort((a, b) => a.owner.localeCompare(b.owner));
    const pageBoxes = selected.slice((Number(page) - 1) * 50, Number(page) * 50);
    const items = pageBoxes.map(box => ({ ...box, group: groups.has(box.owner) }));
    return { items, total: selected.length, page: Number(page), pageSize: 50, wholeMailbox, warnings };
  }
  async function get(session, rawOwner) {
    const owner = address(rawOwner);
    if (!owner) throw invalid();
    const box = (await mailboxes(session)).find(row => row.owner === owner);
    if (!box) throw new AppError(404, 'NOT_FOUND', '메일함을 찾을 수 없어요.');
    return { ...box, ...describe(await snapshot(owner)) };
  }
  async function change({ session, actor, ip, owner: rawOwner, grantee: rawGrantee, etag: expected, grant }) {
    const owner = address(rawOwner), grantee = address(rawGrantee);
    if (!owner || !grantee || owner === grantee) throw invalid();
    return lock.run(owner, async () => {
      if (grant) await validate(session, owner, [grantee]);
      const before = await snapshot(owner);
      assertUnchanged(expected, before);
      const existing = before.grants.find(row => row.grantee === grantee);
      if (existing && !existing.folders.filter(folder => grant || !isTemplateFolder(folder.mailbox)).every(folder => readOnly(folder.rights))) throw unsupported();
      const mutableFolders = existing?.folders.filter(folder => !isTemplateFolder(folder.mailbox)) ?? [];
      const response = state => ({ owner, grantee, ...describe(state), applied: true });
      if (grant ? existing?.folders.some(folder => folder.mailbox === 'INBOX') : !mutableFolders.length) return { ...response(before), unchanged: true };
      const after = normalized(grant ? [
        ...before.grants.filter(row => row.grantee !== grantee),
        { grantee, folders: [...(existing?.folders ?? []), { mailbox: 'INBOX', rights: ['lookup', 'read'] }] },
      ] : before.grants.map(row => row.grantee === grantee ? { ...row, folders: row.folders.filter(folder => isTemplateFolder(folder.mailbox)) } : row));
      const mailboxes = grant ? ['INBOX'] : mutableFolders.map(folder => folder.mailbox);
      return audit.run({ actor, ip, action: grant ? 'share.grant' : 'share.revoke', target: owner, kind: 'config', revertible: true, before, after }, async intent => {
        assertUnchanged(expected, await snapshot(owner));
        await aclFolders.assertExist(owner, mailboxes);
        if (grant) await dockerapi.setAcl(owner, grantee, 'INBOX');
        else for (const mailbox of mailboxes) await dockerapi.deleteAcl(owner, grantee, mailbox);
        const applied = await snapshot(owner);
        if (!isDeepStrictEqual(applied, after)) throw new AppError(502, 'WRITE_VERIFY_FAILED', '공유 설정이 예상과 달라요. 현재 값을 다시 확인해 주세요.');
        return { ...response(applied), auditId: intent.id };
      });
    });
  }
  const adapter = {
    label: '읽기 공유를 바꿨어요',
    read: ({ target }) => snapshot(target),
    async prepareRevert({ target, record }) {
      // Re-read the folder list inside the owner lock before comparing either state.
      const available = new Set(await aclFolders.list(target));
      const current = await snapshot(target);
      const protectedGrants = current.grants.map(row => ({ ...row, folders: row.folders.filter(folder => isTemplateFolder(folder.mailbox)) }));
      const retained = state => {
        const grants = state.grants.map(row => ({ ...row, folders: row.folders.filter(folder => !isTemplateFolder(folder.mailbox) && available.has(folder.mailbox)) }));
        for (const row of protectedGrants) {
          const grant = grants.find(item => item.grantee === row.grantee);
          if (grant) grant.folders.push(...row.folders);
          else grants.push(row);
        }
        return normalized(grants);
      };
      const skipped = [...new Set(record.before.grants.flatMap(row => row.folders.filter(folder => !isTemplateFolder(folder.mailbox) && !available.has(folder.mailbox)).map(folder => folder.mailbox)))].sort();
      return { target: retained(record.before), expected: retained(record.after), skipped };
    },
    async write({ session, target, value, expected, skipped = [] }) {
      const current = await snapshot(target);
      assertUnchanged(etag(expected), current);
      const flatten = state => new Map(state.grants.flatMap(row => row.folders.map(folder => [JSON.stringify([row.grantee, folder.mailbox]), { grantee: row.grantee, ...folder }])));
      const previous = flatten(expected), desired = flatten(value);
      const changed = [...new Set([...previous.keys(), ...desired.keys()])].filter(key => !isDeepStrictEqual(previous.get(key), desired.get(key)));
      const additions = [...new Set(changed.filter(key => desired.has(key)).map(key => desired.get(key).grantee))];
      if (additions.length) await validate(session, target, additions);
      for (const key of changed) {
        const grantee = (previous.get(key) ?? desired.get(key)).grantee;
        for (const state of [current, value]) {
          if (state.grants.find(row => row.grantee === grantee)?.folders.some(folder => !isTemplateFolder(folder.mailbox) && !readOnly(folder.rights))) throw unsupported();
        }
      }
      await aclFolders.assertExist(target, changed.map(key => (desired.get(key) ?? previous.get(key)).mailbox));
      for (const key of changed) {
        const row = desired.get(key) ?? previous.get(key);
        if (desired.has(key)) await dockerapi.setAcl(target, row.grantee, row.mailbox);
        else await dockerapi.deleteAcl(target, row.grantee, row.mailbox);
      }
      return { target: value, skipped };
    },
  };
  history.register('share.grant', adapter);
  history.register('share.revoke', adapter);
  return { list, get, change };
}
