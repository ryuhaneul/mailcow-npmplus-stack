import { AppError } from '../../errors.js';
import { ADMIN_ACCOUNTS_LOCK, assertUnchanged, etag } from '../lock.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', '관리자 계정 입력값과 확인 내용을 살펴봐 주세요.');
const rejected = () => new AppError(502, 'MAILCOW_REJECTED', '관리자 계정 상태나 변경 결과를 확인할 수 없어요. 목록을 새로고침해 주세요.');
const ownAction = () => new AppError(403, 'ADMIN_SELF_ACTION', '본인 계정은 끄거나 삭제할 수 없어요. 내 암호는 기존 암호 변경 메뉴를 이용해 주세요.');
const fields = { create: ['username', 'password', 'password2', 'active'], active: ['active', 'etag'], password: ['password', 'password2', 'etag'], delete: ['confirm', 'etag'] };
const yes = value => value === true || String(value) === '1';
function username(value) {
  if (typeof value !== 'string') throw invalid();
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(name) || !/[a-z0-9]/.test(name) || name === 'api') throw invalid();
  return name;
}
function state(row, strict = false) {
  const bit = value => {
    if (strict && ![0, 1, '0', '1'].includes(value)) throw rejected();
    return yes(value) ? 1 : 0;
  };
  return { username: String(row.username), active: bit(row.active_int ?? row.active),
    force_tfa: bit(row.attributes?.force_tfa), force_pw_update: bit(row.attributes?.force_pw_update) };
}
function view(row) {
  const current = state(row);
  return { username: current.username, active: Boolean(current.active), tfaActive: yes(row.tfa_active_int ?? row.tfa_active),
    created: String(row.created ?? ''), forceTfa: Boolean(current.force_tfa), forcePwUpdate: Boolean(current.force_pw_update), etag: etag(current) };
}
export function createAdminsService({ mailcow, audit, lock, sessions }) {
  async function read(context) {
    const result = await mailcow.call(context, 'GET', '/api/v1/get/admin/all');
    const rows = Array.isArray(result) ? result : result && typeof result === 'object' && !Object.keys(result).length ? [] : null;
    if (!rows || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || typeof row.username !== 'string' || !row.username)) throw rejected();
    return rows;
  }
  async function list(context) { return { items: (await read(context)).map(view) }; }
  async function mutate(mode, { token, ip, username: target, data }) {
    let password, password2;
    try {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
      const keys = Object.keys(data);
      password = data.password; password2 = data.password2;
      delete data.password; delete data.password2;
      if (keys.some(key => !fields[mode].includes(key))) throw invalid();
      target = username(mode === 'create' ? data.username : target);
      if (['create', 'password'].includes(mode) && (typeof password !== 'string' || !password || typeof password2 !== 'string' || password !== password2)) throw invalid();
      if (['create', 'active'].includes(mode) && typeof data.active !== 'boolean') throw invalid();
      if (mode !== 'create' && typeof data.etag !== 'string') throw invalid();
      if (mode === 'delete' && data.confirm !== target) throw invalid();
      return await lock.run(ADMIN_ACCOUNTS_LOCK, async () => {
        const session = await sessions.get(token);
        if (session.state !== 'ready') throw new AppError(403, 'NO_SESSION', '로그인을 먼저 완료해 주세요.');
        const rows = await read(session.mailcow), states = rows.map(row => state(row, true));
        const actor = states.find(row => row.username === session.username);
        if (!actor || actor.active !== 1) throw new AppError(403, 'NO_SESSION', '사용 중인 관리자 계정으로 다시 로그인해 주세요.');
        const index = states.findIndex(row => row.username === target), before = states[index];
        if (mode === 'create') {
          if (before) throw invalid();
        } else {
          if (!before) throw new AppError(404, 'ADMIN_NOT_FOUND', '관리자 계정을 찾을 수 없어요.');
          if (target === session.username && (mode !== 'active' || !data.active)) throw ownAction();
          assertUnchanged(data.etag, before);
          if ((mode === 'delete' || (mode === 'active' && !data.active)) && before.active === 1 && states.filter(row => row.active === 1).length <= 1) {
            throw new AppError(409, 'LAST_ACTIVE_ADMIN', '마지막 활성 관리자는 끄거나 삭제할 수 없어요. 다른 관리자 계정을 먼저 켜 주세요.');
          }
          if (mode === 'active' && before.active === Number(data.active)) return { ok: true, item: view(rows[index]), unchanged: true };
        }
        const after = mode === 'create' ? { username: target, active: Number(data.active), password: 'set' } : mode === 'delete' ? {} :
          { ...before, ...(mode === 'active' ? { active: Number(data.active) } : { password: 'changed' }) };
        const action = { create: 'admin.create', active: 'admin.active.change', password: 'admin.password.reset', delete: 'admin.delete' }[mode];
        const kind = mode === 'password' ? 'credential' : mode === 'active' ? 'config' : 'irreversible';
        return audit.run({ actor: session.username, ip, action, target, kind, revertible: false, before: before ?? {}, after }, async () => {
          const current = await sessions.get(token);
          if (current !== session || current.state !== 'ready') throw new AppError(403, 'NO_SESSION', '로그인을 먼저 완료해 주세요.');
          const cleanup = sessions.invalidateUser(target);
          try {
            const path = `/api/v1/${mode === 'create' ? 'add' : mode === 'delete' ? 'delete' : 'edit'}/admin`;
            const body = mode === 'create' ? { username: target, password, password2, active: Number(data.active) } : mode === 'delete' ? [target] :
              { items: [target], attr: { active: before.active, force_tfa: before.force_tfa, force_pw_update: before.force_pw_update,
                ...(mode === 'active' ? { active: Number(data.active) } : { password, password2 }) } };
            const result = await mailcow.call(session.mailcow, 'POST', path, body, undefined, { rejectWarnings: true });
            const last = Array.isArray(result) ? result.at(-1) : result;
            const key = Array.isArray(last?.msg) ? last.msg[0] : last?.msg;
            const expected = mode === 'create' ? 'admin_added' : mode === 'delete' ? 'admin_removed' : 'admin_modified';
            if (last?.type !== 'success' || key !== expected) throw rejected();
            const appliedRows = await read(session.mailcow), applied = appliedRows.find(row => row.username === target);
            if (mode === 'delete') { if (applied) throw rejected(); return { ok: true }; }
            if (!applied) throw rejected();
            const actual = state(applied, true);
            if (actual.active !== after.active || (mode !== 'create' && (actual.force_tfa !== before.force_tfa || actual.force_pw_update !== before.force_pw_update))) throw rejected();
            return mode === 'password' ? { ok: true } : { ok: true, item: view(applied) };
          } finally {
            sessions.bumpGeneration(target);
            await cleanup;
          }
        });
      });
    } finally { password = undefined; password2 = undefined; }
  }
  return { list, create: args => mutate('create', args), active: args => mutate('active', args), password: args => mutate('password', args), remove: args => mutate('delete', args) };
}
