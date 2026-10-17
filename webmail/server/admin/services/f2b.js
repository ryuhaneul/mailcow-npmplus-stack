import { isIP, BlockList } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';

const ranges = { ban_time: [60], max_ban_time: [60], max_attempts: [1], retry_window: [1], netban_ipv4: [8, 32], netban_ipv6: [8, 128] };
const editable = [...Object.keys(ranges), 'ban_time_increment'];
const invalid = () => new AppError(422, 'INVALID_INPUT', 'fail2ban 입력값과 설정 범위를 확인해 주세요.');
const failed = () => new AppError(502, 'WRITE_VERIFY_FAILED', 'fail2ban 저장 결과가 예상과 달라요. 다시 확인해 주세요.');
const allPorts = '이 IP 에서는 웹메일·관리 화면을 포함한 모든 메일 포트가 막혀 있어요';
const queueNotice = '차단 해제 요청은 되돌리지 않음';
function input(data, keys) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key))) throw invalid();
}
function network(value) {
  if (typeof value !== 'string') throw invalid();
  const result = value.trim().toLowerCase(), [address, prefix, ...extra] = result.split('/'), family = isIP(address);
  if (!family || address.includes('%') || extra.length || prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128))) throw invalid();
  return result;
}
function settings(value) {
  return Object.fromEntries([...Object.keys(ranges).map(key => [key, Number(value[key])]), ['ban_time_increment', [true, 1, '1'].includes(value.ban_time_increment)], ['manage_external', [true, 1, '1'].includes(value.manage_external)]]);
}
const list = value => [...new Set(String(value ?? '').split(/[\s,;]+/).filter(Boolean))].sort();
const membership = (state, name) => ({ network: name, whitelist: state.whitelist.includes(name), blacklist: state.blacklist.includes(name) });
function contains(name, ip, config) {
  try {
    let address = String(ip ?? ''); if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
    const [base, prefix] = name.split('/'), family = isIP(base); if (!family || family !== isIP(address)) return false;
    const block = new BlockList(); block.addSubnet(base, prefix === undefined ? config[family === 4 ? 'netban_ipv4' : 'netban_ipv6'] : Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
    return block.check(address, family === 4 ? 'ipv4' : 'ipv6');
  } catch { return false; }
}
export function createF2bService({ mailcow, audit, lock, history }) {
  const target = 'fail2ban';
  async function read(session) {
    const value = await mailcow.call(session, 'GET', '/api/v1/get/fail2ban');
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(ranges).some(key => !Number.isSafeInteger(Number(value[key])))) throw new AppError(502, 'MAILCOW_REJECTED', 'fail2ban 설정을 읽을 수 없어요.');
    const bans = field => Array.isArray(value[field]) ? value[field].map(row => ({ network: String(row.network), ip: String(row.ip ?? String(row.network).split('/')[0]), ...(field === 'active_bans' ? { queuedForUnban: String(row.queued_for_unban) === '1', bannedUntil: String(row.banned_until ?? '') } : {}) })) : [];
    return { settings: settings(value), whitelist: list(value.whitelist), blacklist: list(value.blacklist), activeBans: bans('active_bans'), permanentBans: bans('perm_bans') };
  }
  async function writeSettings(session, config, whitelist, blacklist) {
    const attr = { ...config, ban_time_increment: config.ban_time_increment ? '1' : '0', manage_external: config.manage_external ? '1' : '0', whitelist: whitelist.join('\n'), blacklist: blacklist.join('\n') };
    await mailcow.call(session, 'POST', '/api/v1/edit/fail2ban', { items: [], attr });
    const applied = await read(session);
    if (!isDeepStrictEqual(applied.settings, config) || !isDeepStrictEqual(applied.whitelist, whitelist) || !isDeepStrictEqual(applied.blacklist, blacklist)) throw failed();
  }
  async function applySettings(session, expected, value) {
    const current = await read(session); assertUnchanged(etag(expected), current.settings);
    await writeSettings(session, value, current.whitelist, current.blacklist);
  }
  async function applyMembership(session, expected, value) {
    const current = await read(session); assertUnchanged(etag(expected), membership(current, value.network));
    const updated = key => [...current[key].filter(item => item !== value.network), ...(value[key] ? [value.network] : [])].sort();
    await writeSettings(session, current.settings, updated('whitelist'), updated('blacklist'));
  }
  async function get(session, ip) {
    const value = await read(session), project = row => ({ ...row, affectsAllPorts: true, notice: allPorts, self: contains(row.network, ip, value.settings) });
    return { ...value, activeBans: value.activeBans.map(project), permanentBans: value.permanentBans.map(project), etag: etag(value.settings) };
  }
  async function put({ session, actor, ip, data }) {
    input(data, ['etag', ...editable]);
    for (const key of editable) if (data[key] !== undefined) {
      if (key === 'ban_time_increment' ? typeof data[key] !== 'boolean' : !Number.isSafeInteger(data[key]) || data[key] < ranges[key][0] || data[key] > (ranges[key][1] ?? Number.MAX_SAFE_INTEGER)) throw invalid();
    }
    return lock.run(target, async () => {
      const before = (await read(session)).settings; assertUnchanged(data.etag, before);
      const after = { ...before, ...Object.fromEntries(editable.filter(key => data[key] !== undefined).map(key => [key, data[key]])) };
      if (isDeepStrictEqual(before, after)) return { settings: before, etag: etag(before), unchanged: true };
      return audit.run({ actor, ip, action: 'fail2ban.settings', target, kind: 'config', revertible: true, before, after }, async intent => {
        await applySettings(session, before, after); return { settings: after, etag: etag(after), auditId: intent.id };
      });
    });
  }
  async function action({ session, actor, ip, data }) {
    input(data, ['network', 'action']); if (!['unban', 'whitelist', 'blacklist', 'unwhitelist'].includes(data.action)) throw invalid();
    const normalized = network(data.network), operation = data.action;
    return lock.run(target, async () => {
      const current = await read(session), name = operation === 'unwhitelist' ? current.whitelist.find(item => item.toLowerCase() === normalized) : normalized;
      if (operation === 'unban') {
        if (current.permanentBans.some(row => row.network === name)) throw new AppError(409, 'PERM_BAN', '차단 목록(blacklist)에서 온 영구 차단이라 풀기로는 풀리지 않음');
        const row = current.activeBans.find(row => row.network === name); if (!row) throw new AppError(404, 'NOT_FOUND', '현재 차단 목록에 없는 주소예요.');
        if (row.queuedForUnban) return { network: name, action: operation, unchanged: true, notice: '해제 요청됨 — 몇 초 안에 풀려요' };
        return audit.run({ actor, ip, action: 'fail2ban.unban', target, kind: 'irreversible', revertible: false, before: { network: name }, after: { network: name, queuedForUnban: true } }, async intent => {
          await mailcow.call(session, 'POST', '/api/v1/edit/fail2ban', { items: [name], attr: { action: operation } });
          const found = (await read(session)).activeBans.find(item => item.network === name); if (found && !found.queuedForUnban) throw failed();
          return { network: name, action: operation, auditId: intent.id, notice: '해제 요청됨 — 몇 초 안에 풀려요' };
        });
      }
      if (operation === 'unwhitelist' && !current.whitelist.includes(name)) throw new AppError(404, 'NOT_FOUND', '차단 안 함 목록에 없는 주소예요.');
      const before = membership(current, name), after = { network: name, whitelist: operation === 'whitelist', blacklist: operation === 'unwhitelist' ? before.blacklist : operation === 'blacklist' };
      if (isDeepStrictEqual(before, after)) return { ...after, unchanged: true };
      return audit.run({ actor, ip, action: 'fail2ban.membership', target, kind: 'config', revertible: true, before, after }, async intent => {
        if (operation === 'unwhitelist') await applyMembership(session, before, after);
        else {
          assertUnchanged(etag(before), membership(await read(session), name));
          await mailcow.call(session, 'POST', '/api/v1/edit/fail2ban', { items: [name], attr: { action: operation } });
        }
        if (!isDeepStrictEqual(membership(await read(session), name), after)) throw failed();
        return { ...after, auditId: intent.id, ...(operation === 'whitelist' ? { notice: queueNotice, detail: { notice: queueNotice } } : {}) };
      });
    });
  }
  history.register('fail2ban.settings', { label: 'fail2ban 설정을 바꿨어요', read: async ({ session }) => (await read(session)).settings, write: ({ session, expected, value }) => applySettings(session, expected, value) });
  history.register('fail2ban.membership', { label: 'fail2ban 목록을 바꿨어요', read: async ({ session, record }) => membership(await read(session), record.after.network), write: ({ session, expected, value }) => applyMembership(session, expected, value) });
  return { get, put, action };
}
