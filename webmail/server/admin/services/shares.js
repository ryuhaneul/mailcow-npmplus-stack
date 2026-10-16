import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', '서로 다른 활성 메일함을 선택해 주세요.');
const unsupported = () => new AppError(409, 'ACL_UNSUPPORTED', '이 공유는 다른 권한이 섞여 있어 화면에서 바꿀 수 없어요. 관리자에게 문의해 주세요.');
const readOnly = rights => isDeepStrictEqual(rights, ['lookup', 'read']);
const address = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
export function groupMailboxAddresses(filters) {
  return new Set(filters.filter(row => typeof row?.username === 'string' && row.username && row.filter_type === 'prefilter' && String(row.active) === '1' && String(row.script_data ?? '').includes('redirect')).map(row => row.username.toLowerCase()));
}
export function createSharesService({ mailcow, dockerapi, audit, lock, history }) {
  async function mailboxes(session) {
    const rows = await mailcow.call(session, 'GET', '/api/v1/get/mailbox/all');
    if (!Array.isArray(rows)) throw new AppError(502, 'MAILCOW_REJECTED', '메일함 목록을 읽을 수 없어요.');
    return rows.filter(row => typeof row?.username === 'string' && String(row.active) === '1').map(row => ({ owner: row.username.toLowerCase(), name: typeof row.name === 'string' ? row.name : '' }));
  }
  async function validate(session, owner, grantees) {
    const active = new Set((await mailboxes(session)).map(row => row.owner));
    if (!active.has(owner) || grantees.some(grantee => !active.has(grantee) || grantee === owner)) throw invalid();
  }
  async function snapshot(owner) {
    const grants = new Map();
    for (const row of await dockerapi.getAcl(owner)) {
      if (row.user.toLowerCase() !== owner || row.mailbox !== 'INBOX') continue;
      const grantee = row.id.toLowerCase();
      grants.set(grantee, [...new Set([...(grants.get(grantee) ?? []), ...row.rights])].sort());
    }
    return { grants: [...grants.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([grantee, rights]) => ({ grantee, rights })) };
  }
  async function list(session, { q = '', page = '1' } = {}) {
    if (typeof q !== 'string' || !/^[1-9]\d*$/.test(String(page)) || !Number.isSafeInteger(Number(page))) throw invalid();
    const boxes = await mailboxes(session);
    const filters = await mailcow.call(session, 'GET', '/api/v1/get/filters/all');
    if (!Array.isArray(filters)) throw new AppError(502, 'MAILCOW_REJECTED', '팀 목록을 읽을 수 없어요.');
    const groups = groupMailboxAddresses(filters);
    const search = q.trim().toLowerCase();
    const selected = boxes.filter(box => `${box.owner} ${box.name}`.toLowerCase().includes(search)).sort((a, b) => a.owner.localeCompare(b.owner));
    const items = [];
    for (const box of selected.slice((Number(page) - 1) * 50, Number(page) * 50)) {
      const state = await snapshot(box.owner);
      items.push({ ...box, group: groups.has(box.owner), grantees: state.grants.map(row => row.grantee), etag: etag(state) });
    }
    return { items, total: selected.length, page: Number(page), pageSize: 50 };
  }
  async function change({ session, actor, ip, owner: rawOwner, grantee: rawGrantee, etag: expected, grant }) {
    const owner = address(rawOwner), grantee = address(rawGrantee);
    if (!owner || !grantee || owner === grantee) throw invalid();
    return lock.run(owner, async () => {
      if (grant) await validate(session, owner, [grantee]);
      const before = await snapshot(owner);
      assertUnchanged(expected, before);
      const existing = before.grants.find(row => row.grantee === grantee);
      if (existing && !readOnly(existing.rights)) throw unsupported();
      const response = state => ({ owner, grantee, grantees: state.grants.map(row => row.grantee), etag: etag(state), applied: true });
      if (Boolean(existing) === grant) return { ...response(before), unchanged: true };
      const after = { grants: (grant ? [...before.grants, { grantee, rights: ['lookup', 'read'] }] : before.grants.filter(row => row.grantee !== grantee)).sort((a, b) => a.grantee.localeCompare(b.grantee)) };
      return audit.run({ actor, ip, action: grant ? 'share.grant' : 'share.revoke', target: owner, kind: 'config', revertible: true, before, after }, async () => {
        assertUnchanged(expected, await snapshot(owner));
        if (grant) await dockerapi.setAcl(owner, grantee);
        else await dockerapi.deleteAcl(owner, grantee);
        const applied = await snapshot(owner);
        if (!isDeepStrictEqual(applied, after)) throw new AppError(502, 'WRITE_VERIFY_FAILED', '공유 설정이 예상과 달라요. 현재 값을 다시 확인해 주세요.');
        return response(applied);
      });
    });
  }
  const adapter = {
    label: '받은편지함 읽기 공유를 바꿨어요',
    read: ({ target }) => snapshot(target),
    async write({ session, target, value, expected }) {
      const current = await snapshot(target);
      assertUnchanged(etag(expected), current);
      const previous = new Map(expected.grants.map(row => [row.grantee, row.rights]));
      const desired = new Map(value.grants.map(row => [row.grantee, row.rights]));
      const changed = [...new Set([...previous.keys(), ...desired.keys()])].filter(grantee => !isDeepStrictEqual(previous.get(grantee), desired.get(grantee)));
      const additions = changed.filter(grantee => desired.has(grantee));
      if (additions.length) await validate(session, target, additions);
      for (const grantee of changed) {
        if ((previous.has(grantee) && !readOnly(previous.get(grantee))) || (desired.has(grantee) && !readOnly(desired.get(grantee)))) throw unsupported();
      }
      for (const grantee of changed) {
        if (desired.has(grantee)) await dockerapi.setAcl(target, grantee);
        else await dockerapi.deleteAcl(target, grantee);
      }
    },
  };
  history.register('share.grant', adapter);
  history.register('share.revoke', adapter);
  return { list, change };
}
