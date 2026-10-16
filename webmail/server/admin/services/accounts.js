import { sieveDisabledWarning } from '../messages.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { AppError } from '../../errors.js';
import { MailcowAuthLost } from '../mailcow-client.js';
import { etag, assertUnchanged } from '../lock.js';
import { groupMailboxAddresses } from './shares.js';
import { aliasBackup, createAliasApi } from './aliases.js';
import { analyze, removeMember, renameMember, Refused, addressPattern } from '../sieve-team.js';

const GB = 1024 ** 3;
const scriptHash = source => createHash('sha256').update(String(source ?? '')).digest('hex');
const protocols = ['imap', 'pop3', 'smtp', 'sieve', 'eas', 'dav'];
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const invalid = () => new AppError(422, 'INVALID_INPUT', '계정 입력값을 확인해 주세요.');
const verifyFailed = () => new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 계정 설정이 예상과 달라요. 현재 값을 다시 확인해 주세요.');
const safeCode = error => error instanceof AppError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
const sieveWarning = () => ({ ...sieveDisabledWarning });
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
  const aliasApi = createAliasApi(mailcow);
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
  function relatedShares(aclByOwner, addr) {
    const shares = new Map();
    for (const acl of aclByOwner.values()) for (const row of acl) {
      const owner = normalize(row.user), grantee = normalize(row.id);
      if (owner === addr || grantee === addr) shares.set(`${owner} ${grantee} ${row.mailbox}`, { ...row, owner, id: grantee });
    }
    return [...shares.values()].sort((a, b) => `${a.owner} ${a.id} ${a.mailbox}`.localeCompare(`${b.owner} ${b.id} ${b.mailbox}`));
  }
  async function editAliasPreservingSenders(session, alias, body, changed = () => {}) {
    const addr = normalize(alias.address), destinations = targets(body.attr.goto);
    const before = (await rows(session, 'mailbox/all')).filter(row => destinations.includes(normalize(row.username))).map(snapshot);
    await aliasApi.edit(session, body);
    changed();
    const aliases = await rows(session, 'alias/all');
    for (const original of before) await lock.run(original.address, async () => {
      const current = snapshot(await box(session, original.address));
      if (!isDeepStrictEqual(current.senderAcl, original.senderAcl) &&
        !isDeepStrictEqual(current.senderAcl, original.senderAcl.filter(value => value !== addr))) assertUnchanged('conflict', {});
      // mailcow omits explicit entries already allowed by a fixed sender alias.
      const implicit = aliases.filter(row => !normalize(row.address).startsWith('@') && String(row.sender_allowed) === '1' && targets(row.goto).includes(original.address)).map(row => normalize(row.address));
      const effective = values => [...new Set([...values, ...implicit])].sort();
      if (!isDeepStrictEqual(effective(current.senderAcl), effective(original.senderAcl))) {
        await mailcow.call(session, 'POST', '/api/v1/edit/mailbox', { items: [original.address], attr: { sender_acl: original.senderAcl } });
      }
      if (!isDeepStrictEqual(effective(snapshot(await box(session, original.address)).senderAcl), effective(original.senderAcl))) throw verifyFailed();
    });
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
  async function detail(session, rawAddress, { allShares = false, aclSnapshot } = {}) {
    const addr = address(rawAddress), row = await box(session, addr);
    const [boxes, aliases, filters, appPasswords, syncjobs] = await Promise.all([
      rows(session, 'mailbox/all'), rows(session, 'alias/all'), rows(session, 'filters/all'),
      rows(session, `app-passwd/all/${encodeURIComponent(addr)}`), rows(session, 'syncjobs/all/no_log'),
    ]);
    const groups = groupMailboxAddresses(filters), warnings = [], shares = new Map();
    const owners = [...new Set([...(allShares ? boxes.map(box => normalize(box.username)) : groups), addr])];
    let cursor = 0, sharesPartial = false;
    await Promise.all(Array.from({ length: Math.min(4, owners.length) }, async () => {
      while (cursor < owners.length) {
        const owner = owners[cursor++];
        try {
          const ownerAcl = await dockerapi.getAcl(owner);
          aclSnapshot?.set(owner, ownerAcl);
          for (const acl of ownerAcl) {
            const grantee = normalize(acl.id);
            if (normalize(acl.user) === owner && acl.mailbox === 'INBOX' && (owner === addr || grantee === addr)) shares.set(`${owner} ${grantee} ${acl.mailbox}`, { owner, grantee, rights: [...acl.rights] });
          }
        } catch { sharesPartial = true; }
      }
    }));
    if (sharesPartial) warnings.push({ code: 'SHARES_PARTIAL', message: '공유 정보 일부를 읽지 못했어요. 공유 화면에서 다시 확인해 주세요.' });
    const senders = snapshot(row).senderAcl.map(sendAs => ({ mailbox: addr, sendAs, direction: 'received' }));
    for (const other of boxes) if (normalize(other.username) !== addr && targets(other.sender_acl).includes(addr)) senders.push({ mailbox: normalize(other.username), sendAs: addr, direction: 'granted' });
    const state = snapshot(row);
    return { ...summary(row, groups), appPasswordCount: appPasswords.length, etag: etag(state), sharesScope: allShares ? 'all' : 'teams+own', warnings,
      refs: {
        aliases: aliases.filter(alias => targets(alias.goto).includes(addr)).map(alias => ({ address: normalize(alias.address), targets: targets(alias.goto), active: Number(alias.active), senderAllowed: String(alias.sender_allowed) === '1' })),
        teams: filters.filter(filter => filter.filter_type === 'prefilter' && String(filter.active) === '1').flatMap(filter => {
          const members = analyze(filter.script_data).members.map(member => normalize(member.address));
          return members.includes(addr) ? [{ mailbox: normalize(filter.username), filterId: filter.id, members }] : [];
        }),
        senders, shares: [...shares.values()].sort((a, b) => `${a.owner} ${a.grantee}`.localeCompare(`${b.owner} ${b.grantee}`)),
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
                await aliasApi.add(session, { address: alias, goto: addr, active: '1', sogo_visible: '0', comment: '' });
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
  const leaveWarnings = () => [
    { code: 'LOGIN_BLOCK_DELAY', message: '로그인 차단은 최대 5분 안에 적용돼요' },
    { code: 'REMOVE_DEVICE_ACCOUNT', message: '퇴사자 기기의 메일 계정 설정을 지워 주세요' },
  ];
  const prefilters = (filters, addr) => filters.filter(filter => normalize(filter.username) === addr && filter.filter_type === 'prefilter' && String(filter.active) === '1');
  function protectTeams(filters, addr) {
    const involved = [];
    for (const filter of filters.filter(row => row.filter_type === 'prefilter' && String(row.active) === '1')) {
      const parsed = analyze(filter.script_data), owner = normalize(filter.username);
      if (!parsed.parsed && String(filter.script_data ?? '').toLowerCase().includes('redirect')) {
        throw new AppError(409, 'UNPARSEABLE', `${owner}의 분배 필터를 해석할 수 없어요. 필터 화면에서 먼저 확인해 주세요.`);
      }
      if (!parsed.members.some(member => normalize(member.address) === addr)) continue;
      if (prefilters(filters, owner).length > 1) throw new AppError(409, 'MULTIPLE_PREFILTERS', `${owner}의 사전 필터가 여러 개예요. 필터 화면에서 먼저 정리해 주세요.`);
      try { removeMember(filter.script_data, addr); }
      catch (error) {
        if (!(error instanceof Refused)) throw error;
        throw new AppError(409, error.code.toUpperCase(), error.code === 'last_member' ?
          `${owner}에서 이 사람이 마지막 구성원이에요. 팀 분배에서 다른 구성원을 먼저 넣어 주세요.` : `${owner}의 분배 필터를 안전하게 바꿀 수 없어요. 팀 분배에서 먼저 정리해 주세요.`);
      }
      involved.push(filter);
    }
    return involved.sort((a, b) => normalize(a.username).localeCompare(normalize(b.username)));
  }
  async function lifecycleSnapshot(session, addr, { mode, cleanRefs, forwardTo }) {
    const account = snapshot(await box(session, addr));
    const filters = await rows(session, 'filters/all');
    const ownFilters = prefilters(filters, addr).map(row => ({ id: row.id, sha256: scriptHash(row.script_data) })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    let forward;
    if (forwardTo) forward = await teams.previewForward(session, addr, forwardTo);
    const operation = { mode, cleanRefs, forwardTo };
    if (mode === 'disable' && !cleanRefs) return { state: { account, ownFilters, operation }, account, filters, forward,
      refs: { aliases: [], teams: [], senders: [], shares: [], syncjobs: [] }, sharesScope: 'none', teamsToClean: [] };
    const teamsToClean = protectTeams(filters, addr), aclByOwner = new Map();
    const info = await detail(session, addr, { allShares: true, aclSnapshot: aclByOwner });
    if (info.warnings.some(warning => warning.code === 'SHARES_PARTIAL')) throw new AppError(502, 'SHARES_UNAVAILABLE', '공유를 모두 확인하지 못했어요. 아무것도 바꾸지 않았으니 다시 시도해 주세요.');
    const [aliases, boxes, jobs] = await Promise.all([rows(session, 'alias/all'), rows(session, 'mailbox/all'), rows(session, 'syncjobs/all/no_log')]);
    const aliasRows = aliases.filter(row => targets(row.goto).includes(addr)).sort((a, b) => normalize(a.address).localeCompare(normalize(b.address)));
    const senderRows = boxes.filter(row => normalize(row.username) === addr && targets(row.sender_acl).length || targets(row.sender_acl).includes(addr)).sort((a, b) => normalize(a.username).localeCompare(normalize(b.username)));
    const syncRows = jobs.filter(row => normalize(row.user2) === addr).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const refs = { ...info.refs, aliases: info.refs.aliases.map(alias => ({ ...alias, effect: mode === 'disable' ? 'kept' : alias.targets.every(target => target === addr) ? 'deleted' : 'target_removed' })) };
    const versions = {
      aliases: aliasRows.map(row => ({ address: normalize(row.address), sha256: etag(row) })),
      teams: teamsToClean.map(row => ({ mailbox: normalize(row.username), id: row.id, sha256: scriptHash(row.script_data) })),
      senders: senderRows.map(row => ({ mailbox: normalize(row.username), sha256: etag(row.sender_acl) })),
      shares: [...aclByOwner].sort(([a], [b]) => a.localeCompare(b)).map(([owner, acl]) => ({ owner, sha256: etag(acl) })),
      syncjobs: syncRows.map(row => ({ id: row.id, sha256: etag(row) })),
    };
    return { state: { account, ownFilters, operation, refs, versions }, account, filters, forward, refs, sharesScope: 'all',
      teamsToClean, aliasRows, senderRows, syncRows, aclByOwner, info };
  }
  async function deletePreview(session, rawAddress, options = {}) {
    const addr = address(rawAddress), mode = options.mode ?? 'delete', cleanRefs = options.cleanRefs ?? true;
    const forwardTo = options.forwardTo ? address(options.forwardTo) : null;
    if (!['disable', 'delete'].includes(mode) || typeof cleanRefs !== 'boolean' || mode === 'delete' && (!cleanRefs || forwardTo)) throw invalid();
    const plan = await lifecycleSnapshot(session, addr, { mode, cleanRefs, forwardTo });
    const row = plan.info ?? await box(session, addr);
    return { address: addr, mode, cleanRefs, forwardTo, etag: etag(plan.state), messages: Number(row.messages ?? 0), usedBytes: Number(row.usedBytes ?? row.quota_used ?? 0),
      refs: plan.refs, sharesScope: plan.sharesScope, irreversible: mode === 'delete', confirmAddress: mode === 'delete' ? addr : null,
      confirmation: mode === 'delete' ? '메일함과 메일을 복구할 수 없어요. 주소를 직접 입력해 주세요.' : '로그인을 막고 메일은 보존해요.',
      warnings: mode === 'disable' ? leaveWarnings() : [] };
  }
  async function lifecycleRun({ session, actor, ip, addr: rawAddress, data, mode = 'delete' }) {
    const addr = address(rawAddress), cleanRefs = data?.cleanRefs, forwardTo = data?.forwardTo ? address(data.forwardTo) : null;
    if (typeof cleanRefs !== 'boolean' || mode === 'delete' && (!cleanRefs || forwardTo) || mode === 'delete' && data.confirmAddress !== addr) throw invalid();
    return lock.run(`flow:${addr}`, async () => {
      const plan = await lifecycleSnapshot(session, addr, { mode, cleanRefs, forwardTo });
      assertUnchanged(data.etag, plan.state);
      const steps = [], cleaned = { aliases: [], teams: [], senders: [], shares: [], syncjobs: [] };
      const expectedAccount = structuredClone(plan.account);
      let lostSession, stage, touched = false;
      const entry = { actor, ip, action: mode === 'delete' ? 'mailbox.delete' : 'mailbox.leave', target: addr,
        kind: mode === 'delete' ? 'irreversible' : 'config', revertible: false, before: { account: plan.account, refs: plan.refs }, after: mode === 'delete' ? {} : { active: 2, forwardTo } };
      const result = await audit.run(entry, async () => {
        const success = (name, target, auditId = null) => { touched = true; steps.push({ stage: name, target, status: 'ok', auditId }); };
        try {
          // Recheck the full preview once more after the durable intent and before the first write.
          assertUnchanged(data.etag, (await lifecycleSnapshot(session, addr, { mode, cleanRefs, forwardTo })).state);
          if (mode === 'disable') {
            stage = 'active';
            await lock.run(addr, async () => {
              const after = { ...plan.account, active: 2 };
              await save(session, addr, plan.account, after); expectedAccount.active = 2;
            });
            success(stage, addr);
            if (forwardTo) {
              stage = 'forward';
              const applied = await teams.forward({ session, actor, ip, team: addr, member: forwardTo, etag: plan.forward.etag });
              success(stage, addr, applied.auditId);
            }
          }
          if (cleanRefs) {
            if (mode === 'delete') for (const alias of plan.aliasRows) {
              stage = 'aliases'; const aliasAddress = normalize(alias.address);
              await lock.run(aliasAddress, async () => {
                const current = (await rows(session, 'alias/all')).find(row => String(row.id) === String(alias.id));
                assertUnchanged(etag(alias), current ?? {});
                const remaining = targets(alias.goto).filter(target => target !== addr);
                if (remaining.length) await editAliasPreservingSenders(session, alias, { items: [String(alias.id)], attr: { goto: remaining.join(',') } }, () => { touched = true; });
                else await aliasApi.remove(session, [String(alias.id)]);
                const checked = (await rows(session, 'alias/all')).find(row => String(row.id) === String(alias.id));
                if (remaining.length ? !checked || !isDeepStrictEqual(targets(checked.goto), remaining) : Boolean(checked)) throw verifyFailed();
              });
              cleaned.aliases.push(aliasAddress); success(stage, aliasAddress);
            }
            for (const filter of plan.teamsToClean) {
              stage = 'teams'; const owner = normalize(filter.username);
              const applied = await teams.change({ session, actor, ip, team: owner, member: addr, add: false, irreversible: mode === 'delete', etag: etag({ id: filter.id, source: filter.script_data }) });
              cleaned.teams.push(owner); success(stage, owner, applied.auditId);
            }
            for (const sender of plan.senderRows) {
              stage = 'senders'; const owner = normalize(sender.username);
              await lock.run(owner, async () => {
                const before = snapshot(await box(session, owner));
                assertUnchanged(etag(sender.sender_acl), (await box(session, owner)).sender_acl);
                const after = { ...before, senderAcl: owner === addr ? [] : before.senderAcl.filter(target => target !== addr) };
                await save(session, owner, before, after);
                if (owner === addr) expectedAccount.senderAcl = [];
              });
              cleaned.senders.push(owner); success(stage, owner);
            }
            const owners = [...new Set(plan.refs.shares.map(share => share.owner))].sort();
            for (const owner of owners) {
              stage = 'shares';
              await lock.run(owner, async () => {
                const owned = acl => acl.filter(row => normalize(row.user) === owner);
                assertUnchanged(etag(owned(plan.aclByOwner.get(owner))), owned(await dockerapi.getAcl(owner)));
                const grants = [...new Set(plan.refs.shares.filter(share => share.owner === owner).map(share => share.grantee))];
                for (const grantee of grants) {
                  await dockerapi.deleteAcl(owner, grantee); touched = true;
                  cleaned.shares.push({ owner, grantee }); success(stage, `${owner} → ${grantee}`);
                }
                const checked = await dockerapi.getAcl(owner);
                if (checked.some(row => normalize(row.user) === owner && row.mailbox === 'INBOX' && grants.includes(normalize(row.id)))) throw verifyFailed();
              });
            }
            for (const job of plan.syncRows) {
              stage = 'syncjobs';
              await lock.run(`syncjob:${job.id}`, async () => {
                const current = (await rows(session, 'syncjobs/all/no_log')).find(row => String(row.id) === String(job.id));
                assertUnchanged(etag(job), current ?? {});
                await mailcow.call(session, 'POST', '/api/v1/delete/syncjob', [String(job.id)]);
                if ((await rows(session, 'syncjobs/all/no_log')).some(row => String(row.id) === String(job.id))) throw verifyFailed();
              });
              cleaned.syncjobs.push(job.id); success(stage, String(job.id));
            }
          }
          if (mode === 'delete') {
            stage = 'mailbox';
            await lock.run(addr, async () => {
              const current = await detail(session, addr, { allShares: true });
              if (current.warnings.some(warning => warning.code === 'SHARES_PARTIAL')) throw new AppError(502, 'SHARES_UNAVAILABLE', '공유를 모두 확인하지 못해 삭제를 멈췄어요.');
              if (Object.values(current.refs).some(refs => refs.length)) throw new AppError(409, 'REFERENCES_REMAIN', '연결이 남아 있어 메일함을 지우지 않았어요. 다시 미리보기를 확인해 주세요.');
              assertUnchanged(etag(expectedAccount), snapshot(await box(session, addr)));
              const checkedFilters = await rows(session, 'filters/all');
              protectTeams(checkedFilters, addr);
              const ownFilters = prefilters(checkedFilters, addr).map(row => ({ id: row.id, sha256: scriptHash(row.script_data) })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
              assertUnchanged(etag(plan.state.ownFilters), ownFilters);
              await mailcow.call(session, 'POST', '/api/v1/delete/mailbox', [addr]);
              if ((await rows(session, 'mailbox/all')).some(row => normalize(row.username) === addr)) throw verifyFailed();
            });
            success(stage, addr);
          }
          return { result: 'ok', steps, detail: { messages: plan.info?.messages ?? 0, usedBytes: plan.info?.usedBytes ?? 0, cleaned, steps }, warnings: mode === 'disable' ? leaveWarnings() : [] };
        } catch (error) {
          if (!touched) throw error;
          if (error instanceof MailcowAuthLost) lostSession = error;
          const recovery = stage === 'aliases' ? [{ stage, message: '별칭 대상과 대상 메일함의 보내기 권한을 mailcow에서 확인하고 원래 권한을 복원해 주세요.' }] : [];
          steps.push({ stage: stage ?? 'verify', status: 'failed', code: safeCode(error), auditId: null, ...(recovery.length ? { recovery: recovery[0].message } : {}) });
          return { result: 'partial', steps, ...(recovery.length ? { recovery } : {}), detail: { messages: plan.info?.messages ?? 0, usedBytes: plan.info?.usedBytes ?? 0, cleaned, steps, ...(recovery.length ? { recovery } : {}) }, warnings: mode === 'disable' ? leaveWarnings() : [] };
        }
      });
      if (lostSession) throw lostSession;
      return result;
    });
  }
  async function leave({ session, actor, ip, data }) {
    if (!data || !['preview', 'run'].includes(data.action) || !['disable', 'delete'].includes(data.mode) || typeof data.cleanRefs !== 'boolean') throw invalid();
    const result = data.action === 'preview' ? await deletePreview(session, data.address, data) :
      await lifecycleRun({ session, actor, ip, addr: data.address, data, mode: data.mode });
    return { ...result, warnings: leaveWarnings() };
  }
  const renameNotices = [
    '앱 암호·본인 필터 소유자는 mailcow가 함께 바꿔요.',
    'BCC·수신 주소 바꾸기(recipient map) 설정은 확인하지 않아요 — mailcow 화면에서 확인해 주세요.',
  ];
  const replaceAddress = (values, old, next) => [...new Set(values.map(value => value === old ? next : value))].sort();
  const aclReadOnly = row => row.mailbox === 'INBOX' && addressPattern.test(row.id) && isDeepStrictEqual([...new Set(row.rights)].sort(), ['lookup', 'read']);
  async function renamePlan(session, old, next) {
    const row = await box(session, old), account = snapshot(row);
    if (![1, 2].includes(account.active)) throw new AppError(409, 'MAILBOX_INACTIVE', '로그인이 켜져 있거나 받기 전용인 메일함만 주소를 바꿀 수 있어요.');
    const [boxes, aliases, filters, jobs] = await Promise.all([rows(session, 'mailbox/all'), rows(session, 'alias/all'), rows(session, 'filters/all'), rows(session, 'syncjobs/all/no_log')]);
    if (boxes.some(item => normalize(item.username) === next) || aliases.some(item => normalize(item.address) === next)) throw new AppError(409, 'ADDRESS_IN_USE', '새 주소가 이미 메일함이나 별칭으로 있어요.');
    const affectedFilters = [];
    for (const filter of filters.filter(item => ['prefilter', 'postfilter'].includes(item.filter_type))) {
      let edited;
      try { edited = renameMember(filter.script_data, old, next); }
      catch (error) {
        if (!(error instanceof Refused)) throw error;
        throw new AppError(409, error.code.toUpperCase(), `${normalize(filter.username)}의 필터를 안전하게 바꿀 수 없어요. 필터 화면에서 먼저 정리해 주세요.`);
      }
      if (edited.changed || normalize(filter.username) === old) affectedFilters.push({ ...filter, nextScript: edited.script });
    }
    affectedFilters.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const aliasRows = aliases.filter(item => targets(item.goto).includes(old)).sort((a, b) => normalize(a.address).localeCompare(normalize(b.address)));
    const senderRows = boxes.filter(item => normalize(item.username) === old || targets(item.sender_acl).includes(old)).sort((a, b) => normalize(a.username).localeCompare(normalize(b.username)));
    const syncRows = jobs.filter(item => normalize(item.user2) === old).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const aclByOwner = new Map(), info = await detail(session, old, { allShares: true, aclSnapshot: aclByOwner });
    if (info.warnings.some(warning => warning.code === 'SHARES_PARTIAL')) throw new AppError(502, 'SHARES_UNAVAILABLE', '공유를 모두 확인하지 못했어요. 다시 시도해 주세요.');
    const shares = relatedShares(aclByOwner, old).map(row => ({ owner: row.owner, grantee: row.id, mailbox: row.mailbox, rights: [...row.rights] }));
    for (const share of shares) {
      const existing = aclByOwner.get(share.owner)?.find(item => normalize(item.id) === next && item.mailbox === share.mailbox);
      if (!aclReadOnly({ ...share, id: share.grantee }) || existing && !aclReadOnly(existing)) throw new AppError(409, 'ACL_UNSUPPORTED', '관련 공유에 받은편지함 읽기 외 권한이 있어요. 공유 설정을 먼저 확인해 주세요.');
    }
    const changes = {
      mailbox: [{ address: old, newAddress: next, messages: info.messages, appPasswordCount: info.appPasswordCount, description: renameNotices[0] }],
      teamFilters: affectedFilters.map(filter => ({ mailbox: normalize(filter.username), newMailbox: normalize(filter.username) === old ? next : normalize(filter.username), filterId: filter.id, sha256Before: scriptHash(filter.script_data), sha256After: scriptHash(filter.nextScript) })),
      aliases: aliasRows.map(alias => ({ address: normalize(alias.address), before: targets(alias.goto), after: replaceAddress(targets(alias.goto), old, next) })),
      senderAs: [{ mailbox: old, newMailbox: next, before: account.senderAcl, after: replaceAddress(account.senderAcl, old, next) }],
      senderGrants: senderRows.filter(item => normalize(item.username) !== old).map(item => ({ mailbox: normalize(item.username), before: snapshot(item).senderAcl, after: replaceAddress(snapshot(item).senderAcl, old, next) })),
      shares: shares.map(share => ({ ...share, newOwner: share.owner === old ? next : share.owner, newGrantee: share.grantee === old ? next : share.grantee })),
      syncjobs: syncRows.map(job => ({ id: job.id, before: old, after: next })),
      oldAlias: [{ address: old, targets: [next] }],
    };
    const state = { old, next, keepOldAsAlias: true, account,
      filters: affectedFilters.map(filter => ({ id: filter.id, owner: normalize(filter.username), sha256: scriptHash(filter.script_data), active: filter.active, type: filter.filter_type })),
      aliases: aliasRows.map(alias => ({ id: alias.id, sha256: etag(alias) })),
      senders: senderRows.map(item => ({ mailbox: normalize(item.username), sha256: etag(item.sender_acl) })),
      shares: [...aclByOwner].sort(([a], [b]) => a.localeCompare(b)).map(([owner, acl]) => ({ owner, sha256: etag(acl) })),
      syncjobs: syncRows.map(job => ({ id: job.id, sha256: etag(job) })),
    };
    return { state, changes, info, account, filters: affectedFilters, aliasRows, senderRows, syncRows, shares, aclByOwner };
  }
  async function rename({ session, actor, ip, addr: rawAddress, data }) {
    const old = address(rawAddress);
    if (!data || !['preview', 'run'].includes(data.action) || typeof data.newLocal !== 'string' || data.newLocal.includes('@') || data.keepOldAsAlias !== true) throw invalid();
    const next = address(`${data.newLocal}@${old.split('@')[1]}`);
    if (next === old) throw invalid();
    const preview = plan => ({ address: old, newAddress: next, changes: plan.changes, etag: etag(plan.state), sharesScope: 'all', notices: renameNotices });
    if (data.action === 'preview') return preview(await renamePlan(session, old, next));
    const addresses = [old, next].sort();
    return lock.run(`flow:${addresses[0]}`, () => lock.run(`flow:${addresses[1]}`, async () => {
      const plan = await renamePlan(session, old, next); assertUnchanged(data.etag, plan.state);
      const steps = [], recovery = [
        { stage: 'mailbox', message: `현재 ${next} 함을 확인해 주세요. 주소를 다시 바꾸려면 mailcow에서 모든 연결도 함께 확인해 주세요.` },
        { stage: 'teamFilters', message: `필터 화면에서 ${old} 대신 ${next}로 팀 전달 주소를 확인해 주세요.` },
        { stage: 'aliases', message: `별칭 대상에서 ${old}를 ${next}로 바꾸고 대상 메일함의 원래 보내기 권한을 확인해 주세요.` },
        { stage: 'senders', message: '새 주소의 보내기 권한과 새 주소로 보낼 수 있는 사람을 권한 화면에서 확인해 주세요.' },
        { stage: 'shares', message: '공유 화면에서 새 주소의 받은편지함 읽기 공유를 확인해 주세요.' },
        { stage: 'syncjobs', message: '대상이 바뀌지 않은 동기화 작업은 지우고 새 주소로 다시 만들어 주세요.' },
        { stage: 'oldAlias', message: `${old}를 ${next}로 보내는 별칭을 만들어 주세요.` },
      ];
      let renamed = false, fatal, stage = 'mailbox';
      const warnings = [];
      const expectedAccount = { ...plan.account, address: next, senderAcl: replaceAddress(plan.account.senderAcl, old, next) };
      const record = { actor, ip, action: 'mailbox.rename', target: old, kind: 'config', revertible: false, before: { address: old, changes: plan.changes }, after: { address: next, keepOldAsAlias: true } };
      const result = await audit.run(record, async () => {
        const runStage = async (name, target, before, after, operation) => {
          stage = name;
          return audit.run({ actor, ip, action: `mailbox.rename.${name}`, target, kind: 'config', revertible: false, before, after }, async intent => {
            await operation(); steps.push({ stage: name, target, status: 'ok', auditId: intent.id });
          });
        };
        const verifyMailbox = async (final = false) => {
          const current = await box(session, next);
          if (Number(current.messages ?? 0) < plan.info.messages) {
            if (!warnings.length) warnings.push({ code: 'MAIL_COUNT_DECREASED', message: '주소를 바꾼 뒤 메일 수가 줄었어요. mailcow에서 메일 보존 상태를 바로 확인해 주세요.' });
            throw verifyFailed();
          }
          const actual = snapshot(current);
          const expected = final ? expectedAccount : { ...expectedAccount, senderAcl: actual.senderAcl };
          if (!isDeepStrictEqual(actual, expected) ||
            (await rows(session, 'mailbox/all')).some(item => normalize(item.username) === old)) throw verifyFailed();
          const currentFilters = await rows(session, 'filters/all');
          if (plan.filters.some(filter => normalize(filter.username) === old && !currentFilters.some(item => String(item.id) === String(filter.id) && normalize(item.username) === next))) throw verifyFailed();
        };
        try {
          await lock.run(addresses[0], () => lock.run(addresses[1], async () => {
            assertUnchanged(data.etag, (await renamePlan(session, old, next)).state);
            await runStage('mailbox', old, { address: old }, { address: next }, async () => {
              assertUnchanged(data.etag, (await renamePlan(session, old, next)).state);
              await mailcow.call(session, 'POST', '/api/v1/edit/rename-mbox', { items: [old], attr: { domain: old.split('@')[1], old_local_part: old.split('@')[0], new_local_part: next.split('@')[0], create_alias: '0' } });
              renamed = true;
              await verifyMailbox();
            });
          }));
          for (const filter of plan.filters) {
            stage = 'teamFilters';
            const applied = await teams.renameFilter({ session, actor, ip, filter, oldAddress: old, newAddress: next });
            steps.push({ stage, target: String(filter.id), status: 'ok', auditId: applied.auditId });
          }
          for (const alias of plan.aliasRows) await lock.run(normalize(alias.address), async () => {
            const desired = replaceAddress(targets(alias.goto), old, next), original = [...new Set(targets(alias.goto))].sort();
            const fresh = (await rows(session, 'alias/all')).find(item => String(item.id) === String(alias.id));
            const current = fresh ? [...new Set(targets(fresh.goto))].sort() : null;
            if (!isDeepStrictEqual(current, desired) && !isDeepStrictEqual(current, original)) assertUnchanged('conflict', {});
            await runStage('aliases', normalize(alias.address), { targets: original }, { targets: desired }, async () => {
              const checked = (await rows(session, 'alias/all')).find(item => String(item.id) === String(alias.id));
              if (!checked || !isDeepStrictEqual(targets(checked.goto).sort(), current)) assertUnchanged('conflict', {});
              if (!isDeepStrictEqual(current, desired)) await editAliasPreservingSenders(session, alias, { items: [String(alias.id)], attr: { goto: desired.join(',') } });
              const applied = (await rows(session, 'alias/all')).find(item => String(item.id) === String(alias.id));
              if (!applied || !isDeepStrictEqual(targets(applied.goto).sort(), desired)) throw verifyFailed();
            });
          });
          for (const sender of plan.senderRows) {
            const owner = normalize(sender.username) === old ? next : normalize(sender.username);
            await lock.run(owner, async () => {
              const before = snapshot(await box(session, owner)), original = snapshot(sender).senderAcl, desired = replaceAddress(original, old, next);
              if (!isDeepStrictEqual(before.senderAcl, original) && !isDeepStrictEqual(before.senderAcl, desired)) assertUnchanged('conflict', {});
              await runStage('senders', owner, { senderAcl: original }, { senderAcl: desired }, () => save(session, owner, before, { ...before, senderAcl: desired }));
            });
          }
          for (const share of plan.changes.shares) await lock.run(share.newOwner, async () => {
            await runStage('shares', share.newOwner, { grantee: share.grantee, owner: share.owner }, { grantee: share.newGrantee, owner: share.newOwner }, async () => {
              let current = await dockerapi.getAcl(share.newOwner);
              const relevant = current.filter(item => item.mailbox === 'INBOX' && [share.grantee, share.newGrantee].includes(normalize(item.id)));
              if (relevant.some(item => !aclReadOnly(item)) || relevant.length === 0) assertUnchanged('conflict', {});
              if (!current.some(item => item.mailbox === 'INBOX' && normalize(item.id) === share.newGrantee)) await dockerapi.setAcl(share.newOwner, share.newGrantee);
              if (share.grantee !== share.newGrantee && current.some(item => item.mailbox === 'INBOX' && normalize(item.id) === share.grantee)) await dockerapi.deleteAcl(share.newOwner, share.grantee);
              current = await dockerapi.getAcl(share.newOwner);
              if (!current.some(item => normalize(item.id) === share.newGrantee && aclReadOnly(item)) || share.grantee !== share.newGrantee && current.some(item => normalize(item.id) === old)) throw verifyFailed();
            });
          });
          for (const job of plan.syncRows) await runStage('syncjobs', String(job.id), { id: job.id, target: old }, { id: job.id, target: next }, async () => {
            const checked = (await rows(session, 'syncjobs/all/no_log')).find(item => String(item.id) === String(job.id));
            if (!checked || normalize(checked.user2) !== next) throw verifyFailed();
          });
          await lock.run(old, async () => {
            await runStage('oldAlias', old, {}, { address: old, targets: [next] }, async () => {
              if ((await rows(session, 'alias/all')).some(item => normalize(item.address) === old)) throw new AppError(409, 'ADDRESS_IN_USE', '옛 주소가 이미 별칭으로 있어요. 현재 대상을 확인해 주세요.');
              await aliasApi.add(session, { address: old, goto: next, active: '1', sogo_visible: '0', comment: '' });
              const checked = (await rows(session, 'alias/all')).find(item => normalize(item.address) === old);
              if (!checked || String(checked.active) !== '1' || !isDeepStrictEqual(targets(checked.goto), [next])) throw verifyFailed();
            });
          });
          stage = 'verify';
          await verifyMailbox(true);
          const checkedFilters = await rows(session, 'filters/all');
          if (plan.filters.some(filter => !checkedFilters.some(item => String(item.id) === String(filter.id) && item.script_data === filter.nextScript))) throw verifyFailed();
          const aliases = await rows(session, 'alias/all'), boxes = await rows(session, 'mailbox/all'), jobs = await rows(session, 'syncjobs/all/no_log');
          if (aliases.some(alias => targets(alias.goto).includes(old)) || boxes.some(item => targets(item.sender_acl).includes(old)) || jobs.some(job => normalize(job.user2) === old)) throw verifyFailed();
          for (const filter of checkedFilters) if (['prefilter', 'postfilter'].includes(filter.filter_type)) {
            try { if (renameMember(filter.script_data, old, next).changed) throw verifyFailed(); }
            catch (error) { if (error instanceof Refused) throw verifyFailed(); throw error; }
          }
          const checkedAcl = new Map(), info = await detail(session, next, { allShares: true, aclSnapshot: checkedAcl });
          if (info.warnings.some(warning => warning.code === 'SHARES_PARTIAL') || [...checkedAcl.values()].some(acl => acl.some(item => normalize(item.id) === old))) throw verifyFailed();
          for (const share of plan.changes.shares) if (!checkedAcl.get(share.newOwner)?.some(item => normalize(item.id) === share.newGrantee && aclReadOnly(item))) throw verifyFailed();
          return { result: 'ok', address: next, steps, recovery: [], warnings, detail: { steps }, notices: renameNotices };
        } catch (error) {
          if (!renamed) throw error;
          if (error instanceof MailcowAuthLost) fatal = error;
          const instruction = recovery.find(item => item.stage === stage)?.message ?? '새 주소의 연결을 미리보기 목록과 대조하고 남은 설정을 mailcow에서 직접 고쳐 주세요.';
          steps.push({ stage, status: 'failed', code: safeCode(error), auditId: null, recovery: instruction });
          return { result: 'partial', address: next, steps, recovery, warnings, detail: { steps, recovery, warnings }, notices: renameNotices };
        }
      });
      if (fatal) throw fatal;
      return result;
    }));
  }
  const notEmpty = () => new AppError(409, 'MAILBOX_NOT_EMPTY', '메일이 있는 메일함은 별칭으로 바꿀 수 없어요. 메일을 옮기거나 지워 주세요.');
  const gapWarning = { code: 'CONVERSION_GAP', message: '같은 주소의 메일함과 별칭은 함께 있을 수 없어 전환 중 잠깐 메일을 받지 못할 수 있어요.' };
  async function conversionPlan(session, addr, direction, options) {
    const [boxes, aliases, filters] = await Promise.all([rows(session, 'mailbox/all'), rows(session, 'alias/all'), rows(session, 'filters/all')]);
    await domainActive(session, addr.split('@')[1]);
    const internal = new Set(boxes.filter(row => String(row.active) === '1').map(row => normalize(row.username)));
    const destinations = direction === 'mailbox-to-alias' ? options.targets : [options.copyTo, options.sendGrantTo].filter(Boolean);
    if (destinations.some(destination => destination === addr || !internal.has(destination))) throw invalid();
    const senders = boxes.filter(row => normalize(row.username) !== addr && (targets(row.sender_acl).includes(addr) || normalize(row.username) === options.sendGrantTo)).sort((a, b) => normalize(a.username).localeCompare(normalize(b.username)));
    const senderVersions = senders.map(row => ({ address: normalize(row.username), sha256: etag(row.sender_acl) }));
    const senderRestore = senders.filter(row => targets(row.sender_acl).includes(addr));
    if (direction === 'alias-to-mailbox') {
      if (boxes.some(row => normalize(row.username) === addr)) throw new AppError(409, 'ADDRESS_IN_USE', '이미 메일함이 있는 주소예요.');
      const alias = aliases.find(row => normalize(row.address) === addr);
      if (!alias) throw new AppError(404, 'NOT_FOUND', '전환할 별칭을 찾을 수 없어요.');
      const ownFilters = filters.filter(row => normalize(row.username) === addr);
      return { state: { direction, addr, options, alias: etag(alias), senders: senderVersions,
        destinations: boxes.filter(row => destinations.includes(normalize(row.username))).map(snapshot).sort((a, b) => a.address.localeCompare(b.address)),
        filters: ownFilters.map(row => ({ id: row.id, sha256: scriptHash(row.script_data) })) },
        alias, ownFilters, senders, senderRestore, warnings: [gapWarning], changes: { alias: aliasBackup(alias),
          mailbox: { address: addr, name: addr.split('@')[0], kind: options.kind, quotaGb: options.quotaGb }, copyTo: options.copyTo, sendGrantTo: options.sendGrantTo,
          senderRestore: senderRestore.map(row => ({ mailbox: normalize(row.username), senderAcl: snapshot(row).senderAcl })) } };
    }
    const mailbox = await box(session, addr);
    if (Number(mailbox.messages) !== 0) throw notEmpty();
    const relatedFilters = [];
    for (const filter of filters.filter(row => ['prefilter', 'postfilter'].includes(row.filter_type))) {
      try {
        // Token recognition is shared with rename: no replacement is saved here.
        const edited = renameMember(filter.script_data, addr, options.targets[0]);
        if (edited.changed || normalize(filter.username) === addr) relatedFilters.push(filter);
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        throw new AppError(409, error.code.toUpperCase(), `${normalize(filter.username)}의 필터를 해석할 수 없어요. 필터 화면에서 먼저 확인해 주세요.`);
      }
    }
    const aclByOwner = new Map(), info = await detail(session, addr, { allShares: true, aclSnapshot: aclByOwner });
    if (info.warnings.some(row => row.code === 'SHARES_PARTIAL')) throw new AppError(502, 'SHARES_UNAVAILABLE', '공유를 모두 확인하지 못했어요. 다시 시도해 주세요.');
    const shares = relatedShares(aclByOwner, addr);
    if (shares.some(row => !aclReadOnly(row))) throw new AppError(409, 'ACL_UNSUPPORTED', '관련 공유에 받은편지함 읽기 외 권한이 있어요. 공유를 먼저 확인해 주세요.');
    const ownFilters = filters.filter(row => normalize(row.username) === addr).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const references = aliases.filter(row => targets(row.goto).includes(addr)).sort((a, b) => normalize(a.address).localeCompare(normalize(b.address)));
    const jobs = (await rows(session, 'syncjobs/all/no_log')).filter(row => normalize(row.user2) === addr).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const warnings = [gapWarning,
      { code: 'SENDER_ADDRESS_RETAINED', message: '이 주소로 보내기 권한을 가진 사람은 계속 이 주소로 보낼 수 있어요(별칭이 됨).' },
      { code: 'OWN_SENDER_RIGHTS_REMOVED', message: `이 메일함이 다른 주소로 보내던 권한 ${snapshot(mailbox).senderAcl.length}개는 없어져요` },
      { code: 'OWN_SHARES_REMOVED', message: `이 메일함을 다른 사람에게 공유한 ${shares.filter(row => row.owner === addr).length}건은 없어져요` },
      { code: 'INCOMING_SHARES_UNUSED', message: `다른 함에서 이 주소에 준 공유 ${shares.filter(row => row.owner !== addr).length}건은 남지만 로그인할 수 없어 쓰이지 않아요` },
    ];
    const state = { direction, addr, options, account: snapshot(mailbox), aliases: references.map(row => ({ address: normalize(row.address), sha256: etag(row) })),
      filters: relatedFilters.map(row => ({ id: row.id, owner: normalize(row.username), sha256: scriptHash(row.script_data), active: row.active, type: row.filter_type })),
      senders: senderVersions, acl: [...aclByOwner].sort(([a], [b]) => a.localeCompare(b)).map(([owner, acl]) => ({ owner, sha256: etag(acl) })),
      syncjobs: jobs.map(row => ({ id: row.id, sha256: etag(row) })),
      destinations: boxes.filter(row => destinations.includes(normalize(row.username))).map(snapshot).sort((a, b) => a.address.localeCompare(b.address)) };
    return { state, mailbox, references, ownFilters, jobs, senders, senderRestore, warnings,
      changes: { mailbox: { address: addr, messages: 0 }, alias: { address: addr, targets: options.targets },
        aliasesRestored: references.map(aliasBackup), filtersRemoved: ownFilters.map(row => ({ id: row.id, sha256: scriptHash(row.script_data) })),
        syncjobsRemoved: jobs.map(row => ({ id: row.id })), refs: info.refs, senderRestore: senderRestore.map(row => ({ mailbox: normalize(row.username), senderAcl: snapshot(row).senderAcl })) } };
  }
  async function convert({ session, actor, ip, direction, data }) {
    const hasPassword = Object.hasOwn(data ?? {}, 'password');
    const password = typeof data?.password === 'string' ? Buffer.from(data.password) : null;
    if (data && typeof data === 'object') delete data.password;
    try {
      if (!data || !['preview', 'run'].includes(data.action) || !['mailbox-to-alias', 'alias-to-mailbox'].includes(direction) ||
        data.action === 'preview' && hasPassword || direction === 'mailbox-to-alias' && hasPassword) throw invalid();
      const addr = address(data.address);
      let options;
      if (direction === 'mailbox-to-alias') {
        if (!Array.isArray(data.targets) || !data.targets.length) throw invalid();
        options = { targets: [...new Set(data.targets.map(address))].sort() };
      } else {
        if (data.action === 'run' && !password?.length) throw invalid();
        const kind = data.kind ?? 'personal'; if (!['personal', 'team', 'admin'].includes(kind)) throw invalid();
        options = { kind, quotaGb: quota(data.quotaGb ?? { personal: 20, team: 50, admin: 3 }[kind]),
          copyTo: data.copyTo ? address(data.copyTo) : null, sendGrantTo: data.sendGrantTo ? address(data.sendGrantTo) : null };
      }
      const initial = await conversionPlan(session, addr, direction, options);
      if (data.action === 'preview') return { address: addr, direction, etag: etag(initial.state), changes: initial.changes, warnings: initial.warnings,
        ...(direction === 'alias-to-mailbox' ? { passwordRequired: true, passwordNotice: '실행할 때 초기 암호가 필요해요' } : {}) };
      return await lock.run(`flow:${addr}`, async () => {
        const plan = await conversionPlan(session, addr, direction, options); assertUnchanged(data.etag, plan.state);
        const kind = direction === 'mailbox-to-alias' ? 'irreversible' : 'config';
        const steps = [], warnings = [...plan.warnings];
        let touched = false, mailboxCreated = false, fatal, stage = 'verify';
        const recovery = direction === 'mailbox-to-alias' ? [
          { stage: 'syncjobs', message: '이미 지운 동기화는 변경 기록의 작업 번호를 확인하고 필요하면 새로 만들어 주세요. 원본 암호는 다시 입력해야 해요.' },
          { stage: 'filters', message: '이미 지운 필터는 변경 기록의 원문 백업을 확인하고 필요하면 mailcow에서 다시 만들어 주세요.' },
          { stage: 'mailbox', message: '메일함이 남아 있는지 확인해 주세요. 새 메일은 옮기거나 지운 뒤 전환해야 해요.' },
          { stage: 'alias', message: `${addr} 별칭을 ${options.targets.join(', ')} 대상으로 만들어 메일 수신을 복구해 주세요.` },
          { stage: 'references', message: '대상 메일함의 원래 보내기 권한과 변경 기록의 원래 goto·활성 상태·공개 여부·보내기 권한·설명을 보고 참조 별칭을 다시 붙여 주세요.' },
          { stage: 'senders', message: '변경 기록의 원래 목록을 보고 다른 사람의 보내기 권한을 복원해 주세요.' },
        ] : [
          { stage: 'alias', message: '변경 기록의 원래 별칭 대상과 설정을 확인해 주세요. 메일함을 만들지 못했다면 같은 주소의 별칭을 다시 만들 수 있어요.' },
          { stage: 'mailbox', message: '별칭과 메일함은 같은 주소에 함께 있을 수 없어요. 변경 기록을 보고 별칭을 복원하거나 초기 암호를 정해 메일함을 만들어 주세요.' },
          { stage: 'copy', message: 'mailcow에서 내부 대상으로 redirect :copy 사전 필터를 만들어 주세요.' },
          { stage: 'senders', message: '변경 기록의 원래 목록을 보고 다른 사람의 보내기 권한을 복원해 주세요.' },
          { stage: 'grant', message: '권한 화면에서 요청자의 보내기 권한 목록에 새 메일함 주소를 추가해 주세요.' },
        ];
        const mutate = async (path, body) => {
          const value = path === '/api/v1/add/alias' ? await aliasApi.add(session, body) : path === '/api/v1/edit/alias' ? await aliasApi.edit(session, body) :
            path === '/api/v1/delete/alias' ? await aliasApi.remove(session, body) : await mailcow.call(session, 'POST', path, body);
          touched = true; return value;
        };
        const result = await audit.run({ actor, ip, action: `mailbox.convert.${direction}`, target: addr, kind, revertible: false,
          before: plan.changes, after: { address: addr, direction, ...options, ...(direction === 'alias-to-mailbox' ? { password: 'set' } : {}) } }, async () => {
          const step = async (name, target, before, after, operation) => {
            stage = name;
            return audit.run({ actor, ip, action: `mailbox.convert.${name}`, target, kind, revertible: false, before, after }, async intent => {
              await operation(); steps.push({ stage: name, target, status: 'ok', auditId: intent.id });
            });
          };
          const restoreSender = async (sender, grant = false) => {
            const owner = normalize(sender.username);
            await lock.run(owner, async () => {
              const before = snapshot(await box(session, owner)), original = snapshot(sender).senderAcl;
              const pruned = original.filter(value => value !== addr);
              if (!isDeepStrictEqual(before.senderAcl, original) && !isDeepStrictEqual(before.senderAcl, pruned)) assertUnchanged('conflict', {});
              const desired = [...new Set([...before.senderAcl, addr])].sort();
              await step(grant ? 'grant' : 'senders', owner, { senderAcl: before.senderAcl }, { senderAcl: desired }, async () => {
                await save(session, owner, before, { ...before, senderAcl: desired });
                if (!isDeepStrictEqual(before.senderAcl, desired)) touched = true;
              });
            });
          };
          try {
            assertUnchanged(data.etag, (await conversionPlan(session, addr, direction, options)).state);
            if (direction === 'mailbox-to-alias') {
              for (const job of plan.jobs) await lock.run(`syncjob:${job.id}`, () => step('syncjobs', String(job.id), { id: job.id, target: addr }, {}, async () => {
                const current = (await rows(session, 'syncjobs/all/no_log')).find(row => String(row.id) === String(job.id)); assertUnchanged(etag(job), current ?? {});
                await mutate('/api/v1/delete/syncjob', [String(job.id)]);
                if ((await rows(session, 'syncjobs/all/no_log')).some(row => String(row.id) === String(job.id))) throw verifyFailed();
              }));
              for (const filter of plan.ownFilters) {
                stage = 'filters'; const removed = await teams.deleteFilter({ session, actor, ip, filter }); touched = true;
                steps.push({ stage, target: String(filter.id), status: 'ok', auditId: removed.auditId });
              }
              await lock.run(addr, () => step('mailbox', addr, { account: plan.state.account }, {}, async () => {
                const fresh = await conversionPlan(session, addr, direction, options);
                const expected = { ...plan.state, filters: plan.state.filters.filter(filter => filter.owner !== addr), syncjobs: [] };
                assertUnchanged(etag(expected), fresh.state);
                if ((await rows(session, 'filters/all')).some(row => normalize(row.username) === addr)) assertUnchanged('conflict', {});
                if (Number((await box(session, addr)).messages) !== 0) throw notEmpty();
                await mutate('/api/v1/delete/mailbox', [addr]);
                if ((await rows(session, 'mailbox/all')).some(row => normalize(row.username) === addr)) throw verifyFailed();
              }));
              await lock.run(addr, () => step('alias', addr, {}, { address: addr, targets: options.targets }, async () => {
                if ((await rows(session, 'alias/all')).some(row => normalize(row.address) === addr) || (await rows(session, 'mailbox/all')).some(row => normalize(row.username) === addr)) throw new AppError(409, 'ADDRESS_IN_USE', '주소가 이미 사용 중이에요.');
                await mutate('/api/v1/add/alias', { address: addr, goto: options.targets.join(','), active: '1', sogo_visible: '0', sender_allowed: '0', public_comment: '', private_comment: '' });
                const checked = (await rows(session, 'alias/all')).find(row => normalize(row.address) === addr);
                if (!checked || String(checked.active) !== '1' || !isDeepStrictEqual(targets(checked.goto).sort(), options.targets)) throw verifyFailed();
              }));
              for (const reference of plan.references) await lock.run(normalize(reference.address), () => step('references', normalize(reference.address), {}, aliasBackup(reference), async () => {
                const original = aliasBackup(reference), remaining = targets(reference.goto).filter(value => value !== addr);
                const current = (await rows(session, 'alias/all')).find(row => normalize(row.address) === original.address);
                const pruned = { ...original, goto: remaining.join(',') };
                if (current ? !isDeepStrictEqual(aliasBackup(current), original) && !isDeepStrictEqual(aliasBackup(current), pruned) : remaining.length > 0) assertUnchanged('conflict', {});
                if (!current) await mutate('/api/v1/add/alias', original);
                else if (!isDeepStrictEqual(aliasBackup(current), original)) {
                  const { address: _address, ...attr } = original;
                  await editAliasPreservingSenders(session, reference, { items: [String(current.id)], attr }, () => { touched = true; });
                }
                const checked = (await rows(session, 'alias/all')).find(row => normalize(row.address) === original.address);
                if (!checked || !isDeepStrictEqual(aliasBackup(checked), original)) throw verifyFailed();
              }));
              for (const sender of plan.senderRestore) await restoreSender(sender);
            } else {
              await lock.run(addr, () => step('alias', addr, aliasBackup(plan.alias), {}, async () => {
                assertUnchanged(data.etag, (await conversionPlan(session, addr, direction, options)).state);
                await mutate('/api/v1/delete/alias', [String(plan.alias.id)]);
                if ((await rows(session, 'alias/all')).some(row => normalize(row.address) === addr)) throw verifyFailed();
              }));
              await lock.run(addr, () => step('mailbox', addr, {}, { address: addr, quotaGb: options.quotaGb, password: 'set' }, async () => {
                if ((await rows(session, 'alias/all')).some(row => normalize(row.address) === addr) || (await rows(session, 'mailbox/all')).some(row => normalize(row.username) === addr)) throw new AppError(409, 'ADDRESS_IN_USE', '주소가 이미 사용 중이에요.');
                const body = { local_part: addr.split('@')[0], domain: addr.split('@')[1], name: addr.split('@')[0], quota: String(options.quotaGb * 1024), active: '1',
                  force_pw_update: '0', tls_enforce_in: '1', tls_enforce_out: '1', password: password.toString(), password2: password.toString() };
                try { await mutate('/api/v1/add/mailbox', body); mailboxCreated = true; } finally { delete body.password; delete body.password2; }
                const checked = snapshot(await box(session, addr));
                if (checked.address !== addr || checked.name !== addr.split('@')[0] || checked.quotaGb !== options.quotaGb || checked.active !== 1) throw verifyFailed();
                const disabled = protocols.filter(key => !checked.protocols[key]); if (disabled.length) warnings.push({ code: 'PROTOCOL_DEFAULT_OFF', protocols: disabled });
              }));
              if (options.copyTo) {
                stage = 'copy'; const expected = await teams.previewForward(session, addr, options.copyTo);
                const applied = await teams.forward({ session, actor, ip, team: addr, member: options.copyTo, etag: expected.etag, reversible: false });
                steps.push({ stage, target: addr, status: 'ok', auditId: applied.auditId });
              }
              for (const sender of plan.senderRestore) await restoreSender(sender);
              if (options.sendGrantTo) {
                const sender = plan.senders.find(row => normalize(row.username) === options.sendGrantTo);
                await restoreSender(sender, true);
              }
            }
            return { result: 'ok', address: addr, steps, warnings, recovery: [], detail: { steps }, ...(mailboxCreated ? { password: password.toString() } : {}) };
          } catch (error) {
            if (!touched) throw error;
            if (error instanceof MailcowAuthLost) fatal = error;
            const instruction = error.code === 'MAILBOX_NOT_EMPTY' ? '새로 도착한 메일이 있어 전환을 멈췄어요. 메일을 옮기거나 지운 뒤 다시 전환하세요. 이미 지운 동기화·필터는 변경 기록에서 확인하세요.' :
              recovery.find(row => row.stage === stage)?.message ?? '변경 기록의 원래 설정과 완료 단계를 확인하고 남은 연결을 mailcow에서 직접 복구해 주세요.';
            steps.push({ stage, status: 'failed', code: safeCode(error), recovery: instruction, auditId: null });
            return { result: 'partial', address: addr, steps, warnings, recovery, detail: { steps, recovery }, ...(mailboxCreated ? { password: password.toString() } : {}) };
          }
        });
        if (fatal) throw fatal;
        return result;
      });
    } finally { password?.fill(0); }
  }
  return { list, detail, create, edit, deletePreview, remove: lifecycleRun, leave, rename, convert };
}
