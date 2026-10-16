import { createHash } from 'node:crypto';
import { mkdir, chmod, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { analyze, addMember, removeMember, addressPattern, Refused } from '../sieve-team.js';
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
    const rows = await mailcow.call(session, 'GET', '/api/v1/get/filters/all');
    if (!Array.isArray(rows)) throw new AppError(502, 'MAILCOW_REJECTED', '필터 목록을 읽을 수 없어요.');
    return rows.filter(row => row && typeof row === 'object');
  }
  async function mailboxes(session) {
    const rows = await mailcow.call(session, 'GET', '/api/v1/get/mailbox/all');
    if (!Array.isArray(rows)) throw new AppError(502, 'MAILCOW_REJECTED', '메일함 목록을 읽을 수 없어요.');
    return rows.filter(row => typeof row?.username === 'string' && String(row.active) === '1').map(row => ({ address: normalize(row.username), name: typeof row.name === 'string' ? row.name : '' }));
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
    const current = entries[0];
    const attr = { script_data: next };
    for (const key of ['script_desc', 'active', 'filter_type']) if (current[key] !== undefined && current[key] !== null) attr[key] = String(current[key]);
    await mailcow.call(session, 'POST', '/api/v1/edit/filter', { items: [String(current.id)], attr });
    const checked = prefilters(await filters(session), team);
    if (checked.length !== 1 || checked[0].script_data !== next) throw verifyFailed();
  }
  function teamEntry(team, entries, names) {
    if (entries.length > 1) return groupMailboxAddresses(entries).size || entries.some(row => String(row.script_data ?? '').toLowerCase().includes('redirect')) ?
      { mailbox: team, filterId: null, members: [], editable: false, reason: 'multiple_prefilters', distribution: 'unknown', etag: etag(entries) } : null;
    const filter = entries[0], a = analyze(filter.script_data);
    if (!a.parsed) return String(filter.script_data ?? '').toLowerCase().includes('redirect') ?
      { mailbox: team, filterId: filter.id, members: [], editable: false, reason: 'unparseable', distribution: 'unknown', etag: revision(filter) } : null;
    if (!a.members.length) return null;
    const reason = a.stopperBeforeMember ? 'stopper_before_member' : !a.members.at(-1).simple ? 'line_not_simple' : '';
    const unique = new Map();
    for (const row of a.members) if (!unique.has(row.address.toLowerCase())) unique.set(row.address.toLowerCase(), { address: row.address, name: names.get(row.address.toLowerCase()) ?? '' });
    const members = [...unique.values()];
    return { mailbox: team, filterId: filter.id, members, editable: !reason, reason,
      distribution: a.forwards.length ? 'mixed' : 'copy', etag: revision(filter) };
  }
  async function list(session, { q = '', page = '1' } = {}) {
    if (typeof q !== 'string' || !/^[1-9]\d*$/.test(String(page)) || !Number.isSafeInteger(Number(page))) throw invalid();
    const boxes = await mailboxes(session), rows = await filters(session);
    const names = new Map(boxes.map(row => [row.address, row.name]));
    const groups = new Map();
    for (const row of rows) if (typeof row.username === 'string' && row.filter_type === 'prefilter' && String(row.active) === '1') {
      const team = normalize(row.username); groups.set(team, [...groups.get(team) ?? [], row]);
    }
    const items = [], forwards = [];
    for (const [team, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const item = teamEntry(team, entries, names);
      if (item) items.push(item);
      else if (entries.length === 1) for (const to of analyze(entries[0].script_data).forwards) forwards.push({ mailbox: team, to, distribution: 'move', editable: false });
    }
    const search = q.trim().toLowerCase();
    const found = items.filter(row => `${row.mailbox} ${names.get(row.mailbox) ?? ''} ${row.members.map(member => member.address).join(' ')}`.toLowerCase().includes(search));
    return { items: found.slice((Number(page) - 1) * 50, Number(page) * 50), forwards, mailboxes: boxes.sort((a, b) => a.address.localeCompare(b.address)), total: found.length, page: Number(page), pageSize: 50 };
  }
  async function change({ session, actor, ip, team: rawTeam, member: rawMember, etag: expected, add }) {
    const team = normalize(rawTeam), member = normalize(rawMember);
    if (!team || !member || member.length > 254 || /[\s"\\\x00-\x1f]/.test(member)) throw invalid();
    return lock.run(team, async () => {
      const boxes = new Set((await mailboxes(session)).map(row => row.address));
      if (!boxes.has(team) || (add && (!addressPattern.test(member) || member === team || !boxes.has(member)))) throw invalid();
      const filter = selected(await filters(session), team);
      assertUnchanged(expected, { id: filter.id, source: filter.script_data });
      let edited;
      try { edited = (add ? addMember : removeMember)(filter.script_data, member); } catch (error) { refused(error); }
      const response = source => ({ mailbox: team, members: state(source).members, etag: etag({ id: filter.id, source }) });
      if (!edited.changed) return { ...response(filter.script_data), unchanged: true, auditId: null };
      return audit.run({ actor, ip, action: add ? 'team.member.add' : 'team.member.remove', target: team, kind: 'config', revertible: true,
        before: state(filter.script_data), after: state(edited.script), ...hashFields(filter.script_data, edited.script) }, async intent => {
        await save(session, team, filter, edited.script); return { ...response(edited.script), auditId: intent.id };
      }, { prepare: ({ id }) => backups.write(id, filter.script_data, edited.script) });
    });
  }
  async function create({ session, actor, ip, teamAddress, members }) {
    const team = normalize(teamAddress);
    if (!Array.isArray(members) || !members.length || members.some(value => typeof value !== 'string')) throw invalid();
    const addresses = members.map(normalize);
    if (!addressPattern.test(team) || new Set(addresses).size !== addresses.length || addresses.some(member => !addressPattern.test(member) || member === team)) throw invalid();
    return lock.run(team, async () => {
      const boxes = new Set((await mailboxes(session)).map(row => row.address));
      if (!boxes.has(team) || addresses.some(member => !boxes.has(member))) throw invalid();
      const absent = async () => { if (prefilters(await filters(session), team).length) throw new AppError(409, 'TEAM_EXISTS', '이미 활성 사전 필터가 있어요. 현재 필터를 먼저 확인해 주세요.'); };
      await absent();
      const source = 'require ["copy"];\n' + addresses.map(member => `redirect :copy "${member}";\n`).join('');
      return audit.run({ actor, ip, action: 'team.create', target: team, kind: 'config', revertible: false, before: state(''), after: state(source), ...hashFields('', source) }, async () => {
        await absent();
        await mailcow.call(session, 'POST', '/api/v1/add/filter', { username: team, filter_type: 'prefilter', active: '1', script_desc: '팀 분배', script_data: source });
        const checked = prefilters(await filters(session), team);
        if (checked.length !== 1 || checked[0].script_data !== source) throw verifyFailed();
        return { mailbox: team, members: addresses, etag: revision(checked[0]) };
      }, { prepare: ({ id }) => backups.write(id, '', source) });
    });
  }
  const adapter = {
    label: '팀 구성원을 바꿨어요',
    async read({ session, target }) {
      const entries = prefilters(await filters(session), target);
      return entries.length === 1 && typeof entries[0].script_data === 'string' ? state(entries[0].script_data) : { members: [], sha256: etag(entries), bytes: 0 };
    },
    async prepare({ record, intent }) {
      const before = await backups.read(record, 'before'), after = await backups.read(record, 'after');
      await backups.write(intent.id, after, before);
    },
    async write({ session, target, expected, value, record }) {
      const entries = prefilters(await filters(session), target);
      if (entries.length !== 1 || typeof entries[0].script_data !== 'string') throw conflict();
      const filter = entries[0];
      if (!isDeepStrictEqual(state(filter.script_data), expected)) throw conflict();
      const original = await backups.read(record, 'before');
      if (sha256(original) !== value.sha256) throw new AppError(409, 'NOT_REVERTIBLE', '백업 내용이 기록과 달라 되돌릴 수 없어요.');
      await save(session, target, filter, original);
    },
  };
  history.register('team.member.add', adapter); history.register('team.member.remove', adapter);
  return { list, change, create };
}
