import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { MailcowAuthLost } from '../mailcow-client.js';
import { addressPattern } from '../sieve-team.js';
import { etag } from '../lock.js';

const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const unique = values => [...new Set(values)].sort();
const invalid = () => new AppError(422, 'INVALID_INPUT', '흐름의 대상과 변경 항목을 확인해 주세요.');
const changed = () => new AppError(409, 'CHANGED_ELSEWHERE', '다른 곳에서 값이 바뀌었어요. 미리보기를 다시 확인해 주세요.');
const safeCode = error => error instanceof AppError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
function address(value) {
  const result = normalize(value); if (!result || result.length > 254 || !addressPattern.test(result)) throw invalid(); return result;
}
function input(data, fields) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !fields.includes(key)) || !['preview', 'run'].includes(data.action)) throw invalid();
}
function teamParams(data) {
  input(data, ['action', 'member', 'fromTeam', 'toTeam', 'mode', 'distribution', 'sendGrant', 'etags']);
  if (!['move', 'add', 'remove'].includes(data.mode) || typeof data.sendGrant !== 'boolean' || data.distribution !== undefined && typeof data.distribution !== 'boolean') throw invalid();
  const value = { member: address(data.member), mode: data.mode, distribution: data.distribution ?? true, sendGrant: data.sendGrant };
  if (!value.distribution && !value.sendGrant) throw invalid();
  if (data.mode !== 'add') value.fromTeam = address(data.fromTeam); else if (data.fromTeam !== undefined) throw invalid();
  if (data.mode !== 'remove') value.toTeam = address(data.toTeam); else if (data.toTeam !== undefined) throw invalid();
  if (value.fromTeam && value.fromTeam === value.toTeam) throw invalid();
  return value;
}
function aliasParams(data) {
  input(data, ['action', 'alias', 'target', 'grantSendTo', 'etags']);
  if (!Array.isArray(data.grantSendTo)) throw invalid();
  const recipients = data.grantSendTo.map(address);
  if (unique(recipients).length !== recipients.length) throw invalid();
  return { alias: address(data.alias), target: address(data.target), grantSendTo: recipients.sort() };
}

export function createFlowsService({ mailcow, teams, aliases, senders, audit, lock }) {
  async function getTeam(session, addr) {
    let page = 1;
    for (;;) {
      const data = await teams.list(session, { q: addr, page: String(page) }), row = data.items.find(row => normalize(row.mailbox) === addr);
      if (row) return { row, mailboxes: data.mailboxes };
      if (page * data.pageSize >= data.total) throw new AppError(409, 'NOT_TEAM', '팀 분배가 있는 팀 메일함을 선택해 주세요.');
      page++;
    }
  }
  async function teamPlan(session, params) {
    const selected = {};
    for (const addr of [params.fromTeam, params.toTeam].filter(Boolean)) selected[addr] = await getTeam(session, addr);
    const boxes = Object.values(selected)[0].mailboxes;
    if ([params.member, params.fromTeam, params.toTeam].filter(Boolean).some(addr => !boxes.some(row => normalize(row.address) === addr))) throw invalid();
    const current = await senders.get(session, params.member), steps = [], changes = { member: params.member, distribution: [], senders: { before: current.senderAcl, after: current.senderAcl }, otherMembersAndPermissions: '모두 유지' };
    const etags = { params: etag(params), teams: {}, senders: {} };
    let context;
    for (const [team, add] of [[params.fromTeam, false], [params.toTeam, true]].filter(([team]) => team)) {
      const row = selected[team].row, before = row.members.map(item => normalize(item.address)), present = before.includes(params.member), unchanged = !params.distribution || add === present;
      if (params.distribution && row.distribution === 'unknown') {
        if (row.reason === 'multiple_prefilters') throw new AppError(409, 'MULTIPLE_PREFILTERS', '활성 사전 필터가 여러 개라 바꿀 수 없어요.');
        if (row.reason === 'unparseable') throw new AppError(409, 'UNPARSEABLE', '이 팀 분배 필터는 안전하게 바꿀 수 없어요. 읽기 전용 사유를 확인해 주세요.');
        const error = new AppError(409, 'TEAM_DISTRIBUTION_UNKNOWN', '팀 분배 상태를 확인할 수 없어요.'); error.reason = String(row.reason ?? 'unknown'); throw error;
      }
      if (!unchanged && !row.editable) throw new AppError(409, String(row.reason || 'TEAM_READ_ONLY').toUpperCase(), '팀 분배의 읽기 전용 사유를 확인해 주세요.');
      if (!unchanged && !add && before.length === 1) throw new AppError(409, 'LAST_MEMBER', '마지막 팀 구성원은 뺄 수 없어요.');
      if (params.distribution && add && params.member === team) throw invalid();
      const after = unchanged ? before : add ? [...before, params.member] : before.filter(value => value !== params.member);
      changes.distribution.push({ team, before, after });
      if (!params.distribution) continue;
      const stage = add ? 'team.add' : 'team.remove'; etags.teams[team] = row.etag;
      steps.push({ stage, target: team, before, after, unchanged, recovery: `${team} 팀 분배를 확인하고 완료 단계의 변경 기록에서 구성원 변경을 되돌려 주세요.`, run: async () => {
        if (unchanged) { if ((await getTeam(session, team)).row.etag !== row.etag) throw changed(); return { unchanged: true, auditId: null }; }
        return teams.change({ session, ...context, team, member: params.member, etag: row.etag, add });
      } });
    }
    if (params.sendGrant) {
      const add = params.toTeam ? [params.toTeam] : [], remove = params.fromTeam ? [params.fromTeam] : [];
      const prepared = await senders.readAndMerge({ session, address: params.member, add, remove }); etags.senders[params.member] = prepared.etag;
      changes.senders = { before: prepared.diff.before, after: prepared.diff.after, alreadyAllowedByAlias: prepared.diff.alreadyAllowedByAlias };
      steps.push({ stage: 'senders', target: params.member, ...changes.senders, unchanged: isDeepStrictEqual(prepared.diff.before, prepared.diff.after), recovery: `${params.member}의 보내기 권한에서 완료 단계의 변경 기록을 확인하고 이전 팀 권한을 복구해 주세요.`,
        run: () => senders.put({ session, ...context, addr: params.member, data: { etag: prepared.etag, add, remove } }) });
    }
    return { params, etags, changes, steps, setContext: value => { context = value; } };
  }
  async function aliasPlan(session, params) {
    const edit = await aliases.previewEdit(session, params.alias, { targets: [params.target], mode: 'move' });
    const boxes = await mailcow.call(session, 'GET', '/api/v1/get/mailbox/all');
    if (!Array.isArray(boxes)) throw new AppError(502, 'MAILCOW_REJECTED', '메일함 목록을 읽을 수 없어요.');
    if (params.grantSendTo.some(addr => !boxes.some(row => normalize(row.username) === addr))) throw invalid();
    const etags = { params: etag(params), teams: {}, senders: {}, alias: edit.etag };
    const changes = { alias: params.alias, target: { before: edit.before.alias.goto.split(','), after: [params.target] }, senders: [], existingPermissionsDeleted: '없음' };
    let context;
    const steps = [{ stage: 'alias', target: params.alias, before: changes.target.before, after: changes.target.after, unchanged: isDeepStrictEqual(edit.before, edit.after), recovery: `${params.alias} 별칭의 변경 기록에서 이전 받는 대상을 복구해 주세요.`,
      run: () => aliases.edit({ session, ...context, addr: params.alias, data: { etag: edit.etag, targets: [params.target], mode: 'move' } }) }];
    for (const addr of params.grantSendTo) {
      const prepared = await senders.readAndMerge({ session, address: addr, add: [params.alias], remove: [] }); etags.senders[addr] = prepared.etag;
      const allowed = edit.after.alias.sender_allowed === '1' && edit.after.alias.goto.split(',').map(normalize).includes(addr);
      const otherAllowed = prepared.writeState.aliasAllowed.filter(value => value !== params.alias);
      const after = unique([...prepared.writeState.senderAcl, params.alias]).filter(value => !otherAllowed.includes(value) && !(allowed && value === params.alias));
      const change = { address: addr, before: prepared.writeState.senderAcl, after, alreadyAllowedByAlias: allowed ? [params.alias] : [] }; changes.senders.push(change);
      steps.push({ stage: 'senders', target: addr, ...change, unchanged: isDeepStrictEqual(change.before, change.after), recovery: `${addr}의 보내기 권한 변경 기록에서 추가한 별칭 권한을 확인하고 복구해 주세요.`, run: async () => {
        const fresh = await senders.readAndMerge({ session, address: addr, add: [params.alias], remove: [] });
        if (!isDeepStrictEqual(fresh.writeState.senderAcl, prepared.writeState.senderAcl)) throw changed();
        return senders.put({ session, ...context, addr, data: { etag: fresh.etag, add: [params.alias], remove: [] } });
      } });
    }
    return { params, etags, changes, steps, setContext: value => { context = value; } };
  }
  const preview = plan => ({ action: 'preview', ...plan.params, etags: plan.etags, changes: plan.changes, steps: plan.steps.map(({ run, recovery, ...step }) => step) });
  async function execute(kind, { session, actor, ip, data }) {
    const params = kind === 'team-move' ? teamParams(data) : aliasParams(data);
    const prepare = () => kind === 'team-move' ? teamPlan(session, params) : aliasPlan(session, params);
    if (data.action === 'preview') return preview(await prepare());
    if (!data.etags || typeof data.etags !== 'object' || Array.isArray(data.etags)) throw changed();
    const resources = unique(kind === 'team-move' ? [params.member, params.fromTeam, params.toTeam].filter(Boolean) : [params.alias, ...params.grantSendTo]);
    const locked = (index, operation) => index === resources.length ? operation() : lock.run(`flow:${resources[index]}`, () => locked(index + 1, operation));
    return locked(0, async () => {
      let plan;
      try { plan = await prepare(); } catch (error) {
        if (error instanceof AppError && [404, 409, 422].includes(error.statusCode)) throw changed();
        throw error;
      }
      if (!isDeepStrictEqual(data.etags, plan.etags)) throw changed();
      plan.setContext({ actor, ip });
      let fatal, actualChanges = 0;
      const result = await audit.run({ actor, ip, action: `flow.${kind}`, target: params.member ?? params.alias, kind: 'config', revertible: false,
        before: { changes: plan.changes }, after: params }, async intent => {
        const steps = [];
        for (const step of plan.steps) {
          try {
            const applied = await step.run(); if (!applied.unchanged) actualChanges++;
            steps.push({ stage: step.stage, target: step.target, status: applied.unchanged ? 'unchanged' : 'ok', auditId: applied.auditId ?? null });
          } catch (error) {
            if (!actualChanges) throw error;
            if (error instanceof MailcowAuthLost) fatal = error;
            steps.push({ stage: step.stage, target: step.target, status: 'failed', code: safeCode(error), auditId: null, recovery: step.recovery });
            const recovery = plan.steps.map(row => ({ stage: row.stage, target: row.target, message: row.recovery }));
            return { result: 'partial', steps, recovery, changes: plan.changes, auditId: intent.id, detail: { steps, recovery } };
          }
        }
        return { result: 'ok', unchanged: actualChanges === 0, steps, recovery: [], changes: plan.changes, auditId: intent.id, detail: { steps } };
      });
      if (fatal) throw fatal;
      return result;
    });
  }
  return { teamMove: args => execute('team-move', args), alias: args => execute('alias', args) };
}
