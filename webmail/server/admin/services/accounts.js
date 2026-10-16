import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { MailcowAuthLost } from '../mailcow-client.js';
import { etag, assertUnchanged } from '../lock.js';
import { groupMailboxAddresses } from './shares.js';
import { analyze, addressPattern } from '../sieve-team.js';

const GB = 1024 ** 3;
const protocols = ['imap', 'pop3', 'smtp', 'sieve', 'eas', 'dav'];
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const invalid = () => new AppError(422, 'INVALID_INPUT', '계정 입력값을 확인해 주세요.');
const verifyFailed = () => new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 계정 설정이 예상과 달라요. 현재 값을 다시 확인해 주세요.');
const safeCode = error => error instanceof AppError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
const sieveWarning = () => ({ code: 'SIEVE_DISABLED', message: 'Sieve를 끄면 필터를 저장할 수 없어요.' });
const targets = value => (Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)).map(normalize).filter(Boolean);
function address(value) {
  const result = normalize(value);
  if (result.length > 254 || !addressPattern.test(result)) throw invalid();
  return result;
}
function quota(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(value * 1024)) throw invalid();
  return value;
}
function snapshot(row) {
  return { address: normalize(row.username), name: typeof row.name === 'string' ? row.name : '', quotaGb: Number(row.quota) / GB,
    active: Number(row.active), protocols: Object.fromEntries(protocols.map(key => [key, String(row.attributes?.[`${key}_access`] ?? '1') === '1'])),
    senderAcl: [...new Set(targets(row.sender_acl))].sort() };
}
const kindOf = (row, groups) => groups.has(normalize(row.username)) ? 'team' : Number(row.quota) === 3 * GB ? 'admin' : 'personal';
const summary = (row, groups) => ({ ...snapshot(row), kind: kindOf(row, groups), usedBytes: Number(row.quota_used ?? 0), messages: Number(row.messages ?? 0) });
export function createAccountsService({ mailcow, dockerapi, audit, lock, history, teams }) {
  const get = (session, path) => mailcow.call(session, 'GET', `/api/v1/get/${path}`);
  async function rows(session, path) {
    const result = await get(session, path);
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object' && !Object.keys(result).length) return [];
    throw new AppError(502, 'MAILCOW_REJECTED', '계정 연결 정보를 읽을 수 없어요.');
  }
  async function box(session, addr) {
    const row = await get(session, `mailbox/${encodeURIComponent(addr)}`);
    if (!row || normalize(row.username) !== addr) throw new AppError(404, 'NOT_FOUND', '메일함을 찾을 수 없어요.');
    return row;
  }
  async function domainActive(session, domain) {
    if (!(await rows(session, 'domain/all')).some(row => normalize(row.domain_name ?? row.domain) === domain && String(row.active) === '1')) {
      throw new AppError(422, 'DOMAIN_NOT_ACTIVE', '활성 도메인을 선택해 주세요.');
    }
  }
  async function list(session, { q = '', kind = 'all', page = '1' } = {}) {
    if (typeof q !== 'string' || !['all', 'personal', 'team', 'admin', 'off'].includes(kind) || !/^[1-9]\d*$/.test(String(page)) || !Number.isSafeInteger(Number(page))) throw invalid();
    const boxes = await rows(session, 'mailbox/all'), groups = groupMailboxAddresses(await rows(session, 'filters/all'));
    const search = q.trim().toLowerCase();
    const found = boxes.filter(row => typeof row.username === 'string' && `${row.username} ${row.name ?? ''}`.toLowerCase().includes(search) &&
      (kind === 'all' || (kind === 'off' ? String(row.active) !== '1' : kindOf(row, groups) === kind))).sort((a, b) => a.username.localeCompare(b.username));
    return { items: found.slice((Number(page) - 1) * 50, Number(page) * 50).map(row => summary(row, groups)), total: found.length, page: Number(page), pageSize: 50 };
  }
  async function detail(session, rawAddress) {
    const addr = address(rawAddress), row = await box(session, addr);
    const [boxes, aliases, filters, appPasswords, syncjobs] = await Promise.all([
      rows(session, 'mailbox/all'), rows(session, 'alias/all'), rows(session, 'filters/all'),
      rows(session, `app-passwd/all/${encodeURIComponent(addr)}`), rows(session, 'syncjobs/all/no_log'),
    ]);
    const groups = groupMailboxAddresses(filters), warnings = [], shares = [];
    const owners = [...new Set([...groups, addr])];
    let cursor = 0, sharesPartial = false;
    await Promise.all(Array.from({ length: Math.min(4, owners.length) }, async () => {
      while (cursor < owners.length) {
        const owner = owners[cursor++];
        try {
          for (const acl of await dockerapi.getAcl(owner)) {
            const grantee = normalize(acl.id);
            if (normalize(acl.user) === owner && acl.mailbox === 'INBOX' && (owner === addr || grantee === addr)) shares.push({ owner, grantee, rights: [...acl.rights] });
          }
        } catch { sharesPartial = true; }
      }
    }));
    if (sharesPartial) warnings.push({ code: 'SHARES_PARTIAL', message: '공유 정보 일부를 읽지 못했어요. 공유 화면에서 다시 확인해 주세요.' });
    const senders = snapshot(row).senderAcl.map(sendAs => ({ mailbox: addr, sendAs, direction: 'received' }));
    for (const other of boxes) if (normalize(other.username) !== addr && targets(other.sender_acl).includes(addr)) senders.push({ mailbox: normalize(other.username), sendAs: addr, direction: 'granted' });
    const state = snapshot(row);
    return { ...summary(row, groups), appPasswordCount: appPasswords.length, etag: etag(state), sharesScope: 'teams+own', warnings,
      refs: {
        aliases: aliases.filter(alias => targets(alias.goto).includes(addr)).map(alias => ({ address: normalize(alias.address), targets: targets(alias.goto), active: Number(alias.active), senderAllowed: String(alias.sender_allowed) === '1' })),
        teams: filters.filter(filter => filter.filter_type === 'prefilter' && String(filter.active) === '1').flatMap(filter => {
          const members = analyze(filter.script_data).members.map(member => normalize(member.address));
          return members.includes(addr) ? [{ mailbox: normalize(filter.username), filterId: filter.id, members }] : [];
        }),
        senders, shares: shares.sort((a, b) => `${a.owner} ${a.grantee}`.localeCompare(`${b.owner} ${b.grantee}`)),
        syncjobs: syncjobs.filter(job => normalize(job.user2) === addr).map(job => ({ id: job.id, target: addr, active: Number(job.active) })),
      } };
  }
  function attrs(before, after) {
    const result = {};
    if (before.name !== after.name) result.name = after.name;
    if (before.quotaGb !== after.quotaGb) result.quota = String(quota(after.quotaGb) * 1024);
    if (before.active !== after.active) result.active = String(after.active);
    if (!isDeepStrictEqual(before.senderAcl, after.senderAcl)) result.sender_acl = after.senderAcl;
    for (const key of protocols) if (before.protocols[key] !== after.protocols[key]) result[`${key}_access`] = after.protocols[key] ? '1' : '0';
    return result;
  }
  async function save(session, addr, before, after) {
    assertUnchanged(etag(before), snapshot(await box(session, addr)));
    const attr = attrs(before, after);
    if (Object.keys(attr).length) await mailcow.call(session, 'POST', '/api/v1/edit/mailbox', { items: [addr], attr });
    const applied = snapshot(await box(session, addr));
    if (!isDeepStrictEqual(applied, after)) throw verifyFailed();
    return applied;
  }
  const adapter = { label: '계정 설정을 바꿨어요', read: async ({ session, target }) => snapshot(await box(session, target)),
    write: ({ session, target, value, expected }) => save(session, target, expected, value) };
  history.register('mailbox.edit', adapter); history.register('mailbox.sender', adapter);
  async function edit({ session, actor, ip, addr: rawAddress, data }) {
    const password = typeof data?.password === 'string' ? Buffer.from(data.password) : null;
    const hasPassword = Object.hasOwn(data ?? {}, 'password');
    if (data && typeof data === 'object') delete data.password;
    try {
      const addr = address(rawAddress);
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['etag', 'name', 'quotaGb', 'active', 'protocols'].includes(key)) ||
        (hasPassword && (!password || !password.length)) || !Object.keys(data).some(key => key !== 'etag') && !hasPassword) throw invalid();
      if (data.name !== undefined && (typeof data.name !== 'string' || data.name.length > 255)) throw invalid();
      if (data.quotaGb !== undefined) quota(data.quotaGb);
      if (data.active !== undefined && ![true, false, 0, 1].includes(data.active)) throw invalid();
      if (data.protocols !== undefined && (!data.protocols || typeof data.protocols !== 'object' || Array.isArray(data.protocols) || Object.entries(data.protocols).some(([key, value]) => !protocols.includes(key) || typeof value !== 'boolean'))) throw invalid();
      return await lock.run(addr, async () => {
        const before = snapshot(await box(session, addr)); assertUnchanged(data.etag, before);
        const after = { ...before, protocols: { ...before.protocols, ...data.protocols } };
        for (const key of ['name', 'quotaGb']) if (data[key] !== undefined) after[key] = data[key];
        if (data.active !== undefined) after.active = Number(data.active);
        const warnings = data.protocols?.sieve === false ? [sieveWarning()] : [], steps = [];
        let applied = before;
        if (!isDeepStrictEqual(before, after)) applied = await audit.run({ actor, ip, action: 'mailbox.edit', target: addr, kind: 'config', revertible: true, before, after }, async intent => {
          const value = await save(session, addr, before, after); steps.push({ stage: 'settings', status: 'ok', auditId: intent.id }); return value;
        });
        if (hasPassword) {
          try {
            await audit.run({ actor, ip, action: 'mailbox.password', target: addr, kind: 'config', revertible: false, before: {}, after: { password: 'changed' } }, async intent => {
              const attr = { password: password.toString(), password2: password.toString() };
              try { await mailcow.call(session, 'POST', '/api/v1/edit/mailbox', { items: [addr], attr }); }
              finally { delete attr.password; delete attr.password2; }
              steps.push({ stage: 'password', status: 'ok', auditId: intent.id });
            });
          } catch (error) {
            if (error instanceof MailcowAuthLost) throw error;
            if (!steps.length) throw error;
            steps.push({ stage: 'password', status: 'failed', code: safeCode(error), auditId: null });
            return { result: 'partial', steps, mailbox: applied, etag: etag(applied), warnings };
          }
        }
        return { result: 'ok', steps, mailbox: applied, etag: etag(applied), warnings };
      });
    } finally { password?.fill(0); }
  }
  async function create({ session, actor, ip, data }) {
    const password = typeof data?.password === 'string' ? Buffer.from(data.password) : null;
    if (data && typeof data === 'object') delete data.password;
    try {
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['local', 'domain', 'name', 'kind', 'quotaGb', 'team', 'alias', 'addSendForTeam'].includes(key)) || !password?.length ||
        typeof data.local !== 'string' || typeof data.domain !== 'string' || !['personal', 'team', 'admin'].includes(data.kind) ||
        typeof data.name !== 'string' || data.name.length > 255 || (data.addSendForTeam !== undefined && typeof data.addSendForTeam !== 'boolean') || (data.addSendForTeam && !data.team)) throw invalid();
      const addr = address(`${data.local}@${data.domain}`), domain = addr.split('@')[1], team = data.team === undefined ? null : address(data.team), alias = data.alias === undefined ? null : address(data.alias);
      const quotaGb = quota(data.quotaGb ?? { personal: 20, team: 50, admin: 3 }[data.kind]);
      await domainActive(session, domain);
      const desired = { address: addr, name: data.name, quotaGb, active: 1 };
      let lostSession;
      const result = await audit.run({ actor, ip, action: 'mailbox.create.flow', target: addr, kind: 'config', revertible: false, before: {}, after: { ...desired, password: 'set' } }, async () => {
        const steps = [];
        let mailbox;
        const warnings = [];
        await lock.run(addr, async () => {
          if ((await rows(session, 'mailbox/all')).some(row => normalize(row.username) === addr)) throw new AppError(409, 'MAILBOX_EXISTS', '이미 있는 메일함이에요.');
          await audit.run({ actor, ip, action: 'mailbox/create', target: addr, kind: 'config', revertible: false, before: {}, after: { ...desired, password: 'set' } }, async intent => {
            const body = { local_part: addr.split('@')[0], domain, name: data.name, quota: String(quotaGb * 1024), active: '1', force_pw_update: '0', tls_enforce_in: '1', tls_enforce_out: '1', password: password.toString(), password2: password.toString() };
            try { await mailcow.call(session, 'POST', '/api/v1/add/mailbox', body); }
            finally { delete body.password; delete body.password2; }
            mailbox = snapshot(await box(session, addr));
            if (Object.entries(desired).some(([key, value]) => mailbox[key] !== value)) throw verifyFailed();
            const disabled = protocols.filter(key => !mailbox.protocols[key]);
            if (disabled.length) warnings.push({ code: 'PROTOCOL_DEFAULT_OFF', protocols: disabled });
            steps.push({ stage: 'mailbox', status: 'ok', auditId: intent.id });
          });
        });
        let stage;
        try {
          if (team) {
            stage = 'team';
            const listed = await teams.list(session), found = listed.items.find(item => item.mailbox === team);
            // Team list is paginated; search the exact address when it is beyond the first page.
            const chosen = found ?? (await teams.list(session, { q: team })).items.find(item => item.mailbox === team);
            if (!chosen) throw new AppError(409, 'NOT_TEAM', '팀 분배 메일함을 확인해 주세요.');
            const result = await teams.change({ session, actor, ip, team, member: addr, etag: chosen.etag, add: true });
            steps.push({ stage, status: 'ok', auditId: result.auditId });
          }
          if (alias) {
            stage = 'alias';
            await lock.run(alias, async () => {
              await domainActive(session, alias.split('@')[1]);
              if ((await rows(session, 'alias/all')).some(row => normalize(row.address) === alias) || (await rows(session, 'mailbox/all')).some(row => normalize(row.username) === alias)) throw new AppError(409, 'ALIAS_EXISTS', '이미 있는 주소라 별칭을 만들지 않았어요.');
              await audit.run({ actor, ip, action: 'alias/create', target: alias, kind: 'config', revertible: false, before: {}, after: { address: alias, targets: [addr], active: 1 } }, async intent => {
                await mailcow.call(session, 'POST', '/api/v1/add/alias', { address: alias, goto: addr, active: '1', sogo_visible: '0', comment: '' });
                const checked = (await rows(session, 'alias/all')).find(row => normalize(row.address) === alias);
                if (!checked || !isDeepStrictEqual(targets(checked.goto), [addr]) || String(checked.active) !== '1') throw verifyFailed();
                steps.push({ stage, status: 'ok', auditId: intent.id });
              });
            });
          }
          if (data.addSendForTeam) {
            stage = 'permissions';
            await lock.run(addr, async () => {
              const before = snapshot(await box(session, addr)), after = { ...before, senderAcl: [...new Set([...before.senderAcl, team])].sort() };
              await audit.run({ actor, ip, action: 'mailbox.sender', target: addr, kind: 'config', revertible: true, before, after }, async intent => {
                mailbox = await save(session, addr, before, after); steps.push({ stage, status: 'ok', auditId: intent.id });
              });
            });
          }
        } catch (error) {
          if (error instanceof MailcowAuthLost) lostSession = error;
          steps.push({ stage, status: 'failed', code: safeCode(error), auditId: null });
          return { result: 'partial', steps, address: addr, mailbox, warnings, password: password.toString(), detail: { steps } };
        }
        return { result: 'ok', steps, address: addr, mailbox, warnings, password: password.toString(), detail: { steps } };
      });
      if (lostSession) throw lostSession;
      return result;
    } finally { password?.fill(0); }
  }
  return { list, detail, create, edit };
}
