import { createHash } from 'node:crypto';
import { mkdir, chmod, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { externalRedirectPreview, internalDomainSet } from '../filter-script.js';
import { AppError } from '../../errors.js';
import { analyze, addMember, removeMember, renameMember, addressPattern, Refused } from '../sieve-team.js';
import { etag, assertUnchanged } from '../lock.js';
import { groupMailboxAddresses } from './shares.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const state = source => ({ members: analyze(source).members.map(row => row.address), sha256: sha256(source), bytes: Buffer.byteLength(source) });
const hashFields = (before, after) => ({ scriptSha256Before: sha256(before), scriptSha256After: sha256(after), bytesBefore: Buffer.byteLength(before), bytesAfter: Buffer.byteLength(after) });
const invalid = () => new AppError(422, 'INVALID_ADDRESS', '활성 내부 메일함과 구성원을 확인해 주세요.');
const conflict = () => new AppError(409, 'CHANGED_ELSEWHERE', '다른 곳에서 값이 바뀌었어요. 다시 읽고 확인해 주세요.');
const verifyFailed = () => new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 필터가 예상과 달라요. 현재 값을 다시 확인해 주세요.');
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
function refused(error) {
  if (!(error instanceof Refused)) throw error;
  throw new AppError(error.code === 'invalid_address' ? 422 : error.code === 'self_check_failed' ? 500 : 409,
    error.code.toUpperCase(), '이 팀 분배 필터는 안전하게 바꿀 수 없어요. 읽기 전용 사유를 확인해 주세요.');
}
function memberAlias(filter, aliases) {
  const matches = analyze(filter.script_data).members.map(member => aliases.find(row =>
    String(row.active) === '1' && row.private_comment === 'mailadmin:team-members' && normalize(row.address) === normalize(member.address))).filter(Boolean);
  if (matches.length > 1) throw new Refused('multiple_member_aliases');
  return matches[0] ?? null;
}
export function createFilterBackups({ dir }) {
  const root = () => join(dir, 'filter-backups');
  const path = (id, phase) => {
    if (!/^[a-f0-9]{32}$/.test(id) || !['before', 'after'].includes(phase)) throw new AppError(409, 'NOT_REVERTIBLE', '필터 백업을 찾을 수 없어 되돌릴 수 없어요.');
    return join(root(), `${id}.${phase}.sieve`);
  };
  async function write(id, before, after) {
    await mkdir(root(), { recursive: true, mode: 0o700 }); await chmod(root(), 0o700);
    for (const [phase, source] of [['before', before], ['after', after]]) {
      const handle = await open(path(id, phase), 'wx', 0o600);
      try { await handle.chmod(0o600); await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
    }
    const directory = await open(root(), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async function read(record, phase) {
    try {
      const data = await readFile(path(record.id, phase));
      const expected = record[phase === 'before' ? 'scriptSha256Before' : 'scriptSha256After'];
      if (sha256(data) !== expected) throw new Error();
      return data.toString('utf8');
    } catch { throw new AppError(409, 'NOT_REVERTIBLE', '필터 백업을 찾을 수 없어 되돌릴 수 없어요.'); }
  }
  return { write, read };
}
export function createTeamsService({ mailcow, audit, lock, history, auditDir }) {
  const backups = createFilterBackups({ dir: auditDir });
  async function filters(session) {
    let rows = await mailcow.call(session, 'GET', '/api/v1/get/filters/all');
    if (rows && typeof rows === 'object' && !Object.keys(rows).length) rows = [];
    if (!Array.isArray(rows)) throw new AppError(502, 'MAILCOW_REJECTED', '필터 목록을 읽을 수 없어요.');
    return rows.filter(row => row && typeof row === 'object');
  }
  async function mailboxes(session) {
    let rows = await mailcow.call(session, 'GET', '/api/v1/get/mailbox/all');
    if (rows && typeof rows === 'object' && !Object.keys(rows).length) rows = [];
    if (!Array.isArray(rows)) throw new AppError(502, 'MAILCOW_REJECTED', '메일함 목록을 읽을 수 없어요.');
    return rows.filter(row => typeof row?.username === 'string' && String(row.active) === '1').map(row => ({ address: normalize(row.username), name: typeof row.name === 'string' ? row.name : '' }));
  }
  async function aliases(session) {
    let rows = await mailcow.call(session, 'GET', '/api/v1/get/alias/all');
    if (rows && typeof rows === 'object' && !Object.keys(rows).length) rows = [];
    if (!Array.isArray(rows)) throw new AppError(502, 'MAILCOW_REJECTED', '별칭 목록을 읽을 수 없어요.');
    return rows.filter(row => row && typeof row === 'object');
  }
  const prefilters = (rows, team) => rows.filter(row => normalize(row.username) === team && row.filter_type === 'prefilter' && String(row.active) === '1');
  function selected(rows, team) {
    const entries = prefilters(rows, team);
    if (!entries.length) throw new AppError(409, 'NOT_TEAM', '활성 팀 분배 필터가 없어요.');
    if (entries.length > 1) throw new AppError(409, 'MULTIPLE_PREFILTERS', '활성 사전 필터가 여러 개라 바꿀 수 없어요.');
    return entries[0];
  }
  const revision = filter => etag({ id: filter.id, source: filter.script_data });
  async function save(session, team, original, next) {
    const freshRows = await filters(session);
    const entries = prefilters(freshRows, team);
    if (entries.length !== 1 || String(entries[0].id) !== String(original.id) || entries[0].script_data !== original.script_data) throw conflict();
    const domainRows = await Promise.all(['domain/all', 'alias-domain/all'].map(async path => {
      const value = await mailcow.call(session, 'GET', `/api/v1/get/${path}`);
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object' && !Object.keys(value).length) return [];
      throw new AppError(502, 'MAILCOW_REJECTED', '도메인 정보를 읽을 수 없어요.');
    }));
    if (externalRedirectPreview(next, [...internalDomainSet(...domainRows)]).needsSpamGuard) throw new AppError(422, 'EXTERNAL_SPAM_GUARD', '이 메일함 관리자 필터에 스팸 제외 줄을 먼저 넣어 주세요.');
    const current = entries[0];
    const attr = { script_data: next };
    for (const key of ['script_desc', 'active', 'filter_type']) if (current[key] !== undefined && current[key] !== null) attr[key] = String(current[key]);
    await mailcow.call(session, 'POST', '/api/v1/edit/filter', { items: [String(current.id)], attr });
    const checked = prefilters(await filters(session), team);
    if (checked.length !== 1 || checked[0].script_data !== next) throw verifyFailed();
  }
  function teamEntry(team, entries, names, aliasRows, teams) {
    if (entries.length > 1) return groupMailboxAddresses(entries).size || entries.some(row => String(row.script_data ?? '').toLowerCase().includes('redirect')) ?
      { mailbox: team, filterId: null, members: [], editable: false, reason: 'multiple_prefilters', distribution: 'unknown', mode: 'sieve', memberAlias: null, convertible: false, etag: etag(entries) } : null;
    const filter = entries[0], a = analyze(filter.script_data);
    if (!a.parsed) return String(filter.script_data ?? '').toLowerCase().includes('redirect') ?
      { mailbox: team, filterId: filter.id, members: [], editable: false, reason: 'unparseable', distribution: 'unknown', mode: 'sieve', memberAlias: null, convertible: false, etag: revision(filter) } : null;
    if (!a.members.length) return null;
    let alias = null, reason = '';
    try { alias = memberAlias(filter, aliasRows); } catch (error) {
      if (!(error instanceof Refused)) throw error;
      reason = error.code;
    }
    reason ||= a.stopperBeforeMember ? 'stopper_before_member' : !a.members.at(-1).simple ? 'line_not_simple' : '';
    const unique = new Map();
    const append = (address, via) => {
      const key = normalize(address);
      if (!unique.has(key)) unique.set(key, { address, name: names.get(key) ?? '', via });
    };
    if (alias) for (const address of String(alias.goto ?? '').split(/[\s,;]+/).map(normalize).filter(Boolean)) append(address, 'alias');
    for (const row of a.members) if (!alias || normalize(row.address) !== normalize(alias.address)) append(row.address, 'sieve');
    const members = [...unique.values()];
    const convertible = !alias && !reason && members.filter(row => names.has(normalize(row.address)) && !teams.has(normalize(row.address))).length >= 3;
    return { mailbox: team, filterId: filter.id, members, editable: !reason, reason,
      mode: alias ? 'alias' : 'sieve', memberAlias: alias ? normalize(alias.address) : null, convertible,
      distribution: a.forwards.length ? 'mixed' : 'copy', etag: alias ? etag({ id: filter.id, source: filter.script_data, goto: alias.goto }) : revision(filter) };
  }
  async function list(session, { q = '', page = '1' } = {}) {
    if (typeof q !== 'string' || !/^[1-9]\d*$/.test(String(page)) || !Number.isSafeInteger(Number(page))) throw invalid();
    const boxes = await mailboxes(session), rows = await filters(session), aliasRows = await aliases(session);
    const names = new Map(boxes.map(row => [row.address, row.name]));
    const groups = new Map();
    for (const row of rows) if (typeof row.username === 'string' && row.filter_type === 'prefilter' && String(row.active) === '1') {
      const team = normalize(row.username); groups.set(team, [...groups.get(team) ?? [], row]);
    }
    const items = [], forwards = [], teams = groupMailboxAddresses(rows);
    for (const [team, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const item = teamEntry(team, entries, names, aliasRows, teams);
      if (item) items.push(item);
      else if (entries.length === 1) for (const to of analyze(entries[0].script_data).forwards) forwards.push({ mailbox: team, to, distribution: 'move', editable: false });
    }
    const search = q.trim().toLowerCase();
    const found = items.filter(row => `${row.mailbox} ${names.get(row.mailbox) ?? ''} ${row.members.map(member => member.address).join(' ')}`.toLowerCase().includes(search));
    return { items: found.slice((Number(page) - 1) * 50, Number(page) * 50), forwards, mailboxes: boxes.sort((a, b) => a.address.localeCompare(b.address)), total: found.length, page: Number(page), pageSize: 50 };
  }
  const destinations = alias => [...new Set(String(alias.goto ?? '').split(/[\s,;]+/).map(normalize).filter(Boolean))];
  const combinedRevision = (filter, alias) => ({ id: filter.id, source: filter.script_data, ...(alias ? { goto: alias.goto } : {}) });
  function memberState(filter, alias) {
    if (!alias) return state(filter.script_data);
    const members = new Map();
    const addresses = [...destinations(alias), ...analyze(filter.script_data).members.filter(row => normalize(row.address) !== normalize(alias.address)).map(row => row.address)];
    for (const address of addresses) if (!members.has(normalize(address))) members.set(normalize(address), address);
    return { ...state(filter.script_data), members: [...members.values()], memberAlias: normalize(alias.address), aliasGoto: alias.goto };
  }
  async function saveAlias(session, team, filter, alias, goto) {
    const current = selected(await filters(session), team);
    let fresh;
    try { fresh = memberAlias(current, await aliases(session)); } catch (error) { refused(error); }
    if (!fresh || String(fresh.id) !== String(alias.id)) throw conflict();
    assertUnchanged(etag(combinedRevision(filter, alias)), combinedRevision(current, fresh));
    await mailcow.call(session, 'POST', '/api/v1/edit/alias', { items: [String(fresh.id)], attr: { goto } });
    const checked = (await aliases(session)).find(row => String(row.id) === String(fresh.id));
    if (!checked || checked.goto !== goto) throw verifyFailed();
  }
  async function change({ session, actor, ip, team: rawTeam, member: rawMember, etag: expected, add, irreversible = false }) {
    const team = normalize(rawTeam), member = normalize(rawMember);
    if (!team || !member || member.length > 254 || /[\s"\\\x00-\x1f]/.test(member)) throw invalid();
    return lock.run('alias-graph', () => lock.run(team, async () => {
      const boxes = new Set((await mailboxes(session)).map(row => row.address));
      if (!boxes.has(team) || (add && (!addressPattern.test(member) || member === team || !boxes.has(member)))) throw invalid();
      const rows = await filters(session), filter = selected(rows, team);
      let alias;
      try { alias = memberAlias(filter, await aliases(session)); } catch (error) { refused(error); }
      assertUnchanged(expected, combinedRevision(filter, alias));
      if (alias) {
        const parsed = analyze(filter.script_data);
        if (parsed.stopperBeforeMember || !parsed.members.at(-1).simple) refused(new Refused(parsed.stopperBeforeMember ? 'stopper_before_member' : 'line_not_simple'));
      }
      const response = (source, currentAlias = alias) => ({ mailbox: team, members: memberState({ ...filter, script_data: source }, currentAlias).members,
        etag: etag(combinedRevision({ ...filter, script_data: source }, currentAlias)) });
      // Removal must also work after the account was disabled (active=2).
      if (alias && (add ? boxes.has(member) && !groupMailboxAddresses(rows).has(member) : destinations(alias).includes(member))) {
        const before = destinations(alias), after = add ? [...new Set([...before, member])] : before.filter(address => address !== member);
        if (isDeepStrictEqual(before, after)) return { ...response(filter.script_data), unchanged: true, auditId: null };
        if (!after.length) throw new AppError(409, 'LAST_MEMBER', '마지막 구성원은 뺄 수 없어요.');
        const nextAlias = { ...alias, goto: after.join(',') };
        return audit.run({ actor, ip, action: add ? 'team.member.add' : 'team.member.remove', target: team, kind: irreversible ? 'irreversible' : 'config', revertible: !irreversible,
          before: memberState(filter, alias), after: memberState(filter, nextAlias), ...hashFields(filter.script_data, filter.script_data) }, async intent => {
          await saveAlias(session, team, filter, alias, nextAlias.goto);
          return { ...response(filter.script_data, nextAlias), auditId: intent.id };
        }, { prepare: ({ id }) => backups.write(id, filter.script_data, filter.script_data) });
      }
      let edited;
      try { edited = (add ? addMember : removeMember)(filter.script_data, member); } catch (error) { refused(error); }
      if (!edited.changed) return { ...response(filter.script_data), unchanged: true, auditId: null };
      return audit.run({ actor, ip, action: add ? 'team.member.add' : 'team.member.remove', target: team, kind: irreversible ? 'irreversible' : 'config', revertible: !irreversible,
        before: memberState(filter, alias), after: memberState({ ...filter, script_data: edited.script }, alias), ...hashFields(filter.script_data, edited.script) }, async intent => {
        if (alias) {
          const fresh = selected(await filters(session), team);
          assertUnchanged(expected, combinedRevision(fresh, memberAlias(fresh, await aliases(session))));
        }
        await save(session, team, filter, edited.script); return { ...response(edited.script), auditId: intent.id };
      }, { prepare: ({ id }) => backups.write(id, filter.script_data, edited.script) });
    }));
  }
  async function create({ session, actor, ip, teamAddress, members }) {
    const team = normalize(teamAddress);
    if (!Array.isArray(members) || !members.length || members.some(value => typeof value !== 'string')) throw invalid();
    const addresses = members.map(normalize);
    if (!addressPattern.test(team) || new Set(addresses).size !== addresses.length || addresses.some(member => !addressPattern.test(member) || member === team)) throw invalid();
    return lock.run('alias-graph', () => lock.run(team, async () => {
      const boxes = new Set((await mailboxes(session)).map(row => row.address));
      if (!boxes.has(team) || addresses.some(member => !boxes.has(member))) throw invalid();
      const existing = await filters(session), teams = groupMailboxAddresses(existing);
      const personal = addresses.filter(member => !teams.has(member)), links = addresses.filter(member => teams.has(member));
      const aliasAddress = team.replace('@', '-members@');
      if (personal.length && (aliasAddress.length > 254 || !addressPattern.test(aliasAddress))) throw invalid();
      const absent = async () => { if (prefilters(await filters(session), team).length) throw new AppError(409, 'TEAM_EXISTS', '이미 활성 사전 필터가 있어요. 현재 필터를 먼저 확인해 주세요.'); };
      const aliasAbsent = async () => {
        if ((await aliases(session)).some(row => normalize(row.address) === aliasAddress) ||
          (await mailcow.call(session, 'GET', '/api/v1/get/mailbox/all')).some(row => normalize(row.username) === aliasAddress)) {
          throw new AppError(409, 'ADDRESS_IN_USE', '이미 사용 중인 묶음 별칭 주소예요.');
        }
      };
      await absent();
      if (personal.length) await aliasAbsent();
      const alias = personal.length ? { address: aliasAddress, goto: personal.join(','), active: '1', internal: '1', private_comment: 'mailadmin:team-members', sogo_visible: '0' } : null;
      const source = 'require ["copy"];\n' + (alias ? [aliasAddress, ...links] : addresses).map(member => `redirect :copy "${member}";\n`).join('');
      return audit.run({ actor, ip, action: 'team.create', target: team, kind: 'config', revertible: false, before: state(''),
        after: memberState({ script_data: source }, alias), ...hashFields('', source) }, async () => {
        await absent();
        if (alias) await aliasAbsent();
        try {
          if (alias) {
            await mailcow.call(session, 'POST', '/api/v1/add/alias', alias);
            const checkedAlias = (await aliases(session)).find(row => normalize(row.address) === aliasAddress);
            if (!checkedAlias || checkedAlias.goto !== alias.goto || String(checkedAlias.internal) !== '1' ||
              String(checkedAlias.active) !== '1' || checkedAlias.private_comment !== alias.private_comment) throw verifyFailed();
          }
          await absent();
          await mailcow.call(session, 'POST', '/api/v1/add/filter', { username: team, filter_type: 'prefilter', active: '1', script_desc: '팀 분배', script_data: source });
          const checked = prefilters(await filters(session), team);
          if (checked.length !== 1 || checked[0].script_data !== source) throw verifyFailed();
          const checkedAlias = alias ? (await aliases(session)).find(row => normalize(row.address) === aliasAddress) : null;
          if (alias && (!checkedAlias || checkedAlias.goto !== alias.goto)) throw verifyFailed();
          return { mailbox: team, members: memberState(checked[0], checkedAlias).members, etag: etag(combinedRevision(checked[0], checkedAlias)) };
        } catch (error) {
          if (!alias) throw error;
          let remaining = true;
          try {
            // Only an unchanged, absent prefilter proves that creation never applied.
            if (!prefilters(await filters(session), team).length) {
              const created = (await aliases(session)).find(row => normalize(row.address) === aliasAddress);
              if (created) await mailcow.call(session, 'POST', '/api/v1/delete/alias', [String(created.id)]);
              remaining = (await aliases(session)).some(row => normalize(row.address) === aliasAddress);
            }
          } catch { /* Uncertain application or failed cleanup: keep the alias. */ }
          if (remaining) throw new AppError(error.statusCode ?? 502, error.code ?? 'WRITE_VERIFY_FAILED', `${error.message} 적용 여부 확인 필요 — 남은 별칭: ${aliasAddress}`);
          throw error;
        }
      }, { prepare: ({ id }) => backups.write(id, '', source) });
    }));
  }
  async function deleteFilter({ session, actor, ip, filter }) {
    const owner = normalize(filter.username);
    return lock.run(owner, async () => {
      return audit.run({ actor, ip, action: 'mailbox.convert.filter.delete', target: owner, kind: 'irreversible', revertible: false,
        before: state(filter.script_data), after: state(''), ...hashFields(filter.script_data, '') }, async intent => {
        const fresh = (await filters(session)).find(row => String(row.id) === String(filter.id));
        assertUnchanged(etag(filter), fresh ?? {});
        await mailcow.call(session, 'POST', '/api/v1/delete/filter', [String(filter.id)]);
        if ((await filters(session)).some(row => String(row.id) === String(filter.id))) throw verifyFailed();
        return { auditId: intent.id };
      }, { prepare: ({ id }) => backups.write(id, filter.script_data, '') });
    });
  }
  async function renameFilter({ session, actor, ip, filter, oldAddress, newAddress }) {
    const owner = normalize(filter.username) === oldAddress ? newAddress : normalize(filter.username);
    const edited = renameMember(filter.script_data, oldAddress, newAddress);
    return lock.run(owner, async () => {
      const read = async () => (await filters(session)).find(row => String(row.id) === String(filter.id));
      const current = await read();
      if (!current || normalize(current.username) !== owner || current.script_data !== filter.script_data) throw conflict();
      return audit.run({ actor, ip, action: 'mailbox.rename.filter', target: owner, kind: 'config', revertible: false,
        before: state(filter.script_data), after: state(edited.script), ...hashFields(filter.script_data, edited.script) }, async intent => {
        const fresh = await read();
        if (!fresh || normalize(fresh.username) !== owner || fresh.script_data !== filter.script_data) throw conflict();
        const attr = { script_data: edited.script };
        for (const key of ['script_desc', 'active', 'filter_type']) if (fresh[key] !== undefined && fresh[key] !== null) attr[key] = String(fresh[key]);
        if (edited.changed) await mailcow.call(session, 'POST', '/api/v1/edit/filter', { items: [String(filter.id)], attr });
        const checked = await read();
        if (!checked || normalize(checked.username) !== owner || checked.script_data !== edited.script) throw verifyFailed();
        return { auditId: intent.id };
      }, { prepare: ({ id }) => backups.write(id, filter.script_data, edited.script) });
    });
  }
  async function forwardPlan(session, team, member) {
    const boxes = await mailcow.call(session, 'GET', '/api/v1/get/mailbox/all');
    if (!Array.isArray(boxes) || team === member || !addressPattern.test(member) ||
      !boxes.some(row => normalize(row.username) === member && String(row.active) === '1') ||
      !boxes.some(row => normalize(row.username) === team && ['1', '2'].includes(String(row.active)))) throw invalid();
    const entries = prefilters(await filters(session), team);
    if (entries.length > 1) throw new AppError(409, 'MULTIPLE_PREFILTERS', '사전 필터가 여러 개예요. 필터 화면에서 먼저 정리해 주세요.');
    const original = entries[0];
    if (!original) return { original: null, before: '', next: `require ["copy"];\nredirect :copy "${member}";\n` };
    let edited;
    try { edited = addMember(original.script_data, member); } catch (error) { refused(error); }
    return { original, before: original.script_data, next: edited.script };
  }
  async function previewForward(session, team, member) {
    const plan = await forwardPlan(session, normalize(team), normalize(member));
    return { etag: etag({ id: plan.original?.id ?? null, source: plan.before }) };
  }
  async function forward({ session, actor, ip, team: rawTeam, member: rawMember, etag: expected, reversible = true }) {
    const team = normalize(rawTeam), member = normalize(rawMember);
    return lock.run(team, async () => {
      const plan = await forwardPlan(session, team, member);
      assertUnchanged(expected, { id: plan.original?.id ?? null, source: plan.before });
      if (plan.next === plan.before) return { unchanged: true, auditId: null };
      return audit.run({ actor, ip, action: 'team.forward', target: team, kind: 'config', revertible: Boolean(plan.original) && reversible,
        before: state(plan.before), after: state(plan.next), ...hashFields(plan.before, plan.next) }, async intent => {
        if (plan.original) await save(session, team, plan.original, plan.next);
        else {
          if (prefilters(await filters(session), team).length) throw conflict();
          await mailcow.call(session, 'POST', '/api/v1/add/filter', { username: team, filter_type: 'prefilter', active: '1', script_desc: '퇴사 후 내부 전달', script_data: plan.next });
          const checked = prefilters(await filters(session), team);
          if (checked.length !== 1 || checked[0].script_data !== plan.next) throw verifyFailed();
        }
        return { auditId: intent.id };
      }, { prepare: ({ id }) => backups.write(id, plan.before, plan.next) });
    });
  }
  const adapter = {
    label: '팀 구성원을 바꿨어요',
    runLocked: (target, operation) => lock.run('alias-graph', () => lock.run(target, operation)),
    async read({ session, target, record }) {
      const entries = prefilters(await filters(session), target);
      if (entries.length !== 1 || typeof entries[0].script_data !== 'string') return { members: [], sha256: etag(entries), bytes: 0 };
      const alias = record.before.memberAlias ? memberAlias(entries[0], await aliases(session)) : null;
      return memberState(entries[0], alias);
    },
    async prepare({ record, intent }) {
      const before = await backups.read(record, 'before'), after = await backups.read(record, 'after');
      await backups.write(intent.id, after, before);
    },
    async write({ session, target, expected, value, record }) {
      const entries = prefilters(await filters(session), target);
      if (entries.length !== 1 || typeof entries[0].script_data !== 'string') throw conflict();
      const filter = entries[0];
      const alias = record.before.memberAlias ? memberAlias(filter, await aliases(session)) : null;
      if (!isDeepStrictEqual(memberState(filter, alias), expected)) throw conflict();
      const original = await backups.read(record, 'before');
      if (sha256(original) !== value.sha256) throw new AppError(409, 'NOT_REVERTIBLE', '백업 내용이 기록과 달라 되돌릴 수 없어요.');
      if (alias && value.aliasGoto !== expected.aliasGoto) await saveAlias(session, target, filter, alias, value.aliasGoto);
      else await save(session, target, filter, original);
    },
  };
  history.register('team.member.add', adapter); history.register('team.member.remove', adapter); history.register('team.forward', adapter);
  return { list, change, create, previewForward, forward, renameFilter, deleteFilter };
}
