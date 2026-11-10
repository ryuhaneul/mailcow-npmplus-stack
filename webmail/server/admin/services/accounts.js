import { tokens as retirementTokens } from '../../sieve/import-syntax.js';
import { emptyRetirementState, retirementVersion } from '../../security/retirement-store.js';
import { retirementRedirects } from '../../sieve/redirect-targets.js';
import { createProtocolNetlimitStore, protocolNetlimitState, protocolNetlimitVersion } from '../../security/protocol-netlimit-store.js';
import { collectMailboxQuota } from './quota.js';
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
const inactiveMailbox = () => new AppError(409, 'MAILBOX_INACTIVE', '계정을 켠 뒤 다시 해 주세요.');
const ownerVersions = owners => [...owners].sort(([a], [b]) => a.localeCompare(b));
const verifyFailed = () => new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 계정 설정이 예상과 달라요. 현재 값을 다시 확인해 주세요.');
const safeCode = error => error instanceof AppError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
const sieveWarning = () => ({ ...sieveDisabledWarning });
const targets = value => (Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)).map(normalize).filter(Boolean);
const isMemberAlias = row => row.private_comment === 'mailadmin:team-members';
const memberAliases = (filter, aliases) => analyze(filter.script_data).members.map(member => aliases.find(row =>
  isMemberAlias(row) && String(row.active) === '1' && normalize(row.address) === normalize(member.address))).filter(Boolean);
function teamMembers(filter, aliases) {
  const bundles = memberAliases(filter, aliases), addresses = new Set(bundles.map(row => normalize(row.address)));
  return [...new Set([...bundles.flatMap(row => targets(row.goto)),
    ...analyze(filter.script_data).members.map(member => normalize(member.address)).filter(addr => !addresses.has(addr))])];
}

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
export function createAccountsService({ mailcow, dockerapi, audit, lock, history, teams, otp, retirement = null, protocolNetlimit = createProtocolNetlimitStore(), aclFolders = {
  enabled: false,
  readOwned: async owner => (await dockerapi.getAcl(owner)).filter(row => normalize(row.user) === owner && row.mailbox === 'INBOX'),
  assertExist: async () => {},
} }) {
  const aliasApi = createAliasApi(mailcow);
  const retirementState = addr => retirement ? retirement.store.read(addr) : Promise.resolve(emptyRetirementState());
  const routingLock = operation => retirement ? retirement.routing.withRoutingLock(operation) : operation();
  const blockUnavailable = pendingLeave => new AppError(503, 'RETIREMENT_BLOCK_UNAVAILABLE', pendingLeave ? '서버 기능을 켜서 준비한 뒤 퇴사 처리의 남은 정리를 처리하세요.' : '서버의 수신 차단 준비 상태를 확인해 주세요.');
  const retirementConflict = code => new AppError(409, code, '퇴사 설정을 다시 확인해 주세요.');
  const retirementDto = (state, active) => ({ ...state, featureEnabled: retirement?.featureEnabled === true,
    effectiveReceiveBlock: !state.receiveBlocked ? 'off' : retirement?.featureEnabled && retirement?.ready ? 'on' : 'unverified',
    warnings: [...(state.receiveBlocked && (!retirement?.featureEnabled || !retirement?.ready) ? [{ code: 'RECEIVE_BLOCK_UNVERIFIED', message: '저장된 차단 선택의 실제 적용을 확인해야 해요.' }] : []),
      ...(state.retired && active !== undefined && active !== 2 ? [{ code: 'RETIREMENT_STATE_MISMATCH', message: '퇴사 기록과 현재 로그인 상태가 달라요.' }] : [])] });
  async function writeRetirement(addr, state, patch, actor, keys) {
    const version = retirementVersion();
    const selectedKeys = keys ?? (state.receiveBlocked ? await retirement.store.keysForOwner(addr) : []);
    await retirement.store.write({ email: addr, ...state, ...patch, updatedBy: actor,
      version, keys: selectedKeys, expected: state });
    const checked = await retirementState(addr);
    if (checked.version !== version || !isDeepStrictEqual((await retirement.store.keysForOwner(addr)).sort(), [...selectedKeys].sort())) throw verifyFailed();
    for (const [key, value] of Object.entries(patch)) if (!['version', 'updatedAt', 'updatedBy'].includes(key) && !isDeepStrictEqual(checked[key], value)) throw verifyFailed();
    return checked;
  }
  async function assertReusable(addr) {
    if (!retirement) return;
    const state = await retirementState(addr), keys = await retirement.store.keysForOwner(addr);
    if (state.version !== null || keys.length || (await retirement.store.blockedRecipients([addr])).length) throw retirementConflict('RETIREMENT_ADDRESS_STALE');
  }
  async function cleanupRetirement(addr, expected) {
    if (!retirement) return;
    await retirement.store.remove({ email: addr, expected });
    if ((await retirementState(addr)).version !== null || (await retirement.store.keysForOwner(addr)).length) throw verifyFailed();
  }
  async function assertMovable(addr) {
    const state = await retirementState(addr);
    if (state.receiveBlocked) throw new AppError(409, 'RETIREMENT_BLOCK_ACTIVE', '수신 차단을 먼저 끈 뒤 주소나 계정 종류를 바꿔 주세요.');
    if (state.pendingOperation) throw retirementConflict('RETIREMENT_OPERATION_PENDING');
    if (retirement && (await retirement.store.keysForOwner(addr)).length) throw retirementConflict('RETIREMENT_KEYS_STALE');
    return state;
  }
  const netState = async addr => protocolNetlimitState(await protocolNetlimit.read(addr));
  const editState = (mailbox, netlimit) => ({ mailbox, netlimit });
  const netFields = row => ({ protocolInternalOnly: row.enabled, protocolInternalVersion: row.version,
    ...(row.allowlistEmpty !== undefined ? { protocolInternalAllowlistEmpty: row.allowlistEmpty } : {}) });
  async function changeNetlimit({ session, actor, ip, addr, before, enabled }) {
    await box(session, addr);
    const after = { enabled, version: protocolNetlimitVersion() };
    return audit.run({ actor, ip, action: 'mailbox.protocol-netlimit', target: addr, kind: 'config', revertible: true, before, after }, async intent => {
      await protocolNetlimit.write({ email: addr, enabled, expected: before, version: after.version });
      if (!isDeepStrictEqual(await netState(addr), after)) throw verifyFailed();
      return { value: after, auditId: intent.id };
    });
  }
  async function cleanupNetlimit({ actor, ip, addr, expected }) {
    const before = expected ?? await netState(addr);
    if (before.version === null) return;
    return audit.run({ actor, ip, action: 'mailbox.protocol-netlimit.cleanup', target: addr, kind: 'irreversible', revertible: false,
      before, after: { enabled: false, version: null } }, async () => protocolNetlimit.remove({ email: addr, expected: before }));
  }
  history.register('mailbox.protocol-netlimit', {
    label: '사내 IP 제한을 바꿨어요',
    read: async ({ session, target }) => { await box(session, target); return netState(target); },
    prepareRevert: async ({ record }) => ({ expected: record.after, target: { enabled: record.before.enabled, version: protocolNetlimitVersion() } }),
    write: async ({ session, target, value, expected }) => {
      await box(session, target);
      const written = await protocolNetlimit.write({ email: target, enabled: value.enabled, version: value.version, expected });
      return { target: written };
    },
  });

  const folderWarnings = () => aclFolders.enabled === false ? [{ code: 'SUBFOLDER_ACL_UNCHECKED', message: '하위 폴더 공유 권한은 2단계(doveadm)가 켜진 서버에서만 확인·정리돼요' }] : [];
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
    await retirement?.routing.assertMutation(session, { kind: 'alias', address: addr, after: { ...alias, ...body.attr } });
    // Every caller holds the alias address key already; never re-enter that key.
    // Keep flow → alias → sorted mailbox order; goto may also contain alias addresses.
    const mailboxKeys = [...new Set((await rows(session, 'mailbox/all')).map(row => normalize(row.username))
      .filter(value => value !== addr && destinations.includes(value)))].sort();
    const underLocks = index => index < mailboxKeys.length ? lock.run(mailboxKeys[index], () => underLocks(index + 1)) : preserve();
    return underLocks(0);
    async function preserve() {
      const before = await Promise.all(mailboxKeys.map(async value => snapshot(await box(session, value))));
      await aliasApi.edit(session, body);
      changed();
      const aliases = await rows(session, 'alias/all');
      for (const original of before) {
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
      }
    }
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
    const items = [];
    // The retirement pool deliberately has two connections and no wait queue.
    for (const row of found.slice((Number(page) - 1) * 50, Number(page) * 50)) items.push({ ...summary(row, groups), retirement: retirementDto(await retirementState(normalize(row.username)), Number(row.active)) });
    return { items, total: found.length, page: Number(page), pageSize: 50 };
  }
  async function quotaList(session) {
    const boxes = await collectMailboxQuota(mailcow, session), groups = groupMailboxAddresses(await rows(session, 'filters/all'));
    return { items: boxes.filter(row => typeof row.username === 'string').map(row => {
      const item = summary(row, groups);
      return { address: item.address, name: item.name, kind: item.kind, usedBytes: item.usedBytes, quotaGb: item.quotaGb, etag: etag(snapshot(row)) };
    }) };
  }
  async function detail(session, rawAddress, { allShares = false, aclSnapshot, ownerSnapshot, skipOwnShares = false, includeProtocolNetlimit = true } = {}) {
    const addr = address(rawAddress), row = await box(session, addr);
    const [boxes, aliases, filters, appPasswords, syncjobs] = await Promise.all([
      rows(session, 'mailbox/all'), rows(session, 'alias/all'), rows(session, 'filters/all'),
      rows(session, `app-passwd/all/${encodeURIComponent(addr)}`), rows(session, 'syncjobs/all/no_log'),
    ]);
    const groups = groupMailboxAddresses(filters), warnings = [], shares = new Map();
    const owners = [...new Set([...(allShares ? boxes.map(box => normalize(box.username)) : groups), addr])];
    const activeByOwner = new Map(boxes.map(box => [normalize(box.username), box.active]));
    const skipped = [];
    let cursor = 0, sharesPartial = false;
    await Promise.all(Array.from({ length: Math.min(4, owners.length) }, async () => {
      while (cursor < owners.length) {
        const owner = owners[cursor++];
        const active = activeByOwner.get(owner);
        if (![0, 1, 2, '0', '1', '2'].includes(active)) { sharesPartial = true; continue; }
        ownerSnapshot?.set(owner, Number(active));
        if (active === 0 || active === '0' || skipOwnShares && owner === addr) { skipped.push(owner); continue; }
        try {
          const ownerAcl = await aclFolders.readOwned(owner);
          aclSnapshot?.set(owner, ownerAcl);
          for (const acl of ownerAcl) {
            const grantee = normalize(acl.id);
            if (normalize(acl.user) === owner && (owner === addr || grantee === addr)) shares.set(`${owner} ${grantee} ${acl.mailbox}`, { owner, grantee, mailbox: acl.mailbox, rights: [...acl.rights] });
          }
        } catch { sharesPartial = true; }
      }
    }));
    if (sharesPartial) warnings.push({ code: 'SHARES_PARTIAL', message: '공유 정보 일부를 읽지 못했어요. 공유 화면에서 다시 확인해 주세요.' });
    if (skipped.length) warnings.push({ code: 'SHARES_INACTIVE_SKIPPED', addresses: skipped.sort(),
      message: `꺼진 계정(${skipped.join(', ')})이 남에게 준 공유는 확인하지 못했어요. 처리 후 공유 화면에서 확인해 주세요.` });
    warnings.push(...folderWarnings());
    const senders = snapshot(row).senderAcl.map(sendAs => ({ mailbox: addr, sendAs, direction: 'received' }));
    for (const other of boxes) if (normalize(other.username) !== addr && targets(other.sender_acl).includes(addr)) senders.push({ mailbox: normalize(other.username), sendAs: addr, direction: 'granted' });
    const state = snapshot(row), net = includeProtocolNetlimit ? await protocolNetlimit.read(addr) : null;
    return { ...summary(row, groups), retirement: retirementDto(await retirementState(addr), Number(row.active)), ...(net ? netFields(net) : {}), appPasswordCount: appPasswords.length, etag: etag(net ? editState(state, protocolNetlimitState(net)) : state), sharesScope: allShares ? 'all' : 'teams+own', warnings,
      refs: {
        aliases: aliases.filter(alias => !isMemberAlias(alias) && targets(alias.goto).includes(addr)).map(alias => ({ address: normalize(alias.address), targets: targets(alias.goto), active: Number(alias.active), senderAllowed: String(alias.sender_allowed) === '1' })),
        teams: filters.filter(filter => filter.filter_type === 'prefilter' && String(filter.active) === '1').flatMap(filter => {
          const members = teamMembers(filter, aliases);
          return members.includes(addr) ? [{ mailbox: normalize(filter.username), filterId: filter.id, members }] : [];
        }),
        senders, shares: [...shares.values()].sort((a, b) => `${a.owner} ${a.grantee} ${a.mailbox}`.localeCompare(`${b.owner} ${b.grantee} ${b.mailbox}`)),
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
  async function save(session, addr, before, after, attempted = () => {}) {
    assertUnchanged(etag(before), snapshot(await box(session, addr)));
    const attr = attrs(before, after);
    if (before.active !== after.active) await retirement?.routing.assertMutation(session, { kind: 'mailbox', address: addr, after: { active: after.active } });
    if (Object.keys(attr).length) { attempted(); await mailcow.call(session, 'POST', '/api/v1/edit/mailbox', { items: [addr], attr }); }
    const applied = snapshot(await box(session, addr));
    if (!isDeepStrictEqual(applied, after)) throw verifyFailed();
    return applied;
  }
  const adapter = { runLocked: (target, operation) => routingLock(() => lock.run(target, operation)), label: '계정 설정을 바꿨어요', read: async ({ session, target }) => snapshot(await box(session, target)),
    write: ({ session, target, value, expected }) => save(session, target, expected, value) };
  history.register('mailbox.edit', adapter); history.register('mailbox.sender', adapter);
  async function edit({ session, actor, ip, addr: rawAddress, data }) {
    const password = typeof data?.password === 'string' ? Buffer.from(data.password) : null;
    const hasPassword = Object.hasOwn(data ?? {}, 'password');
    if (data && typeof data === 'object') delete data.password;
    try {
      const addr = address(rawAddress), hasNetlimit = Object.hasOwn(data ?? {}, 'protocolInternalOnly');
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['etag', 'name', 'quotaGb', 'active', 'protocols', 'protocolInternalOnly'].includes(key)) ||
        (hasPassword && (!password || !password.length)) || !Object.keys(data).some(key => key !== 'etag') && !hasPassword) throw invalid();
      if (data.name !== undefined && (typeof data.name !== 'string' || data.name.length > 255)) throw invalid();
      if (data.quotaGb !== undefined) quota(data.quotaGb);
      if (data.active !== undefined && ![true, false, 0, 1].includes(data.active)) throw invalid();
      if (hasNetlimit && typeof data.protocolInternalOnly !== 'boolean') throw invalid();
      if (data.protocols !== undefined && (!data.protocols || typeof data.protocols !== 'object' || Array.isArray(data.protocols) || Object.entries(data.protocols).some(([key, value]) => !protocols.includes(key) || typeof value !== 'boolean'))) throw invalid();
      return await lock.run(addr, async () => {
        const before = snapshot(await box(session, addr));
        // Existing quota clients use mailbox-only revisions and never write the flag.
        const legacy = !hasNetlimit && data.etag === etag(before);
        const netBefore = legacy ? null : await netState(addr);
        assertUnchanged(data.etag, legacy ? before : editState(before, netBefore));
        const after = { ...before, protocols: { ...before.protocols, ...data.protocols } };
        for (const key of ['name', 'quotaGb']) if (data[key] !== undefined) after[key] = data[key];
        if (data.active !== undefined) after.active = Number(data.active);
        const warnings = data.protocols?.sieve === false ? [sieveWarning()] : [], steps = [];
        let applied = before, stage = 'settings', flagAttempted = false;
        async function response(result) {
          if (legacy) return { result, steps, mailbox: applied, etag: etag(applied), warnings };
          try {
            const current = snapshot(await box(session, addr)), net = await protocolNetlimit.read(addr);
            return { result, steps, mailbox: { ...current, ...netFields(net) }, etag: etag(editState(current, protocolNetlimitState(net))), warnings };
          } catch {
            return { result: 'partial', steps, mailbox: { ...applied, protocolInternalOnly: null, protocolInternalVersion: null }, etag: null, reloadRequired: true, warnings };
          }
        }
        try {
          if (!isDeepStrictEqual(before, after)) applied = await audit.run({ actor, ip, action: 'mailbox.edit', target: addr, kind: 'config', revertible: true, before, after }, async intent => {
            const value = await save(session, addr, before, after); steps.push({ stage, status: 'ok', auditId: intent.id }); return value;
          });
          stage = 'protocol-netlimit';
          if (hasNetlimit && data.protocolInternalOnly !== netBefore.enabled) {
            flagAttempted = true;
            const changed = await changeNetlimit({ session, actor, ip, addr, before: netBefore, enabled: data.protocolInternalOnly });
            steps.push({ stage, status: 'ok', auditId: changed.auditId });
          }
          stage = 'password';
          if (hasPassword) await audit.run({ actor, ip, action: 'mailbox.password', target: addr, kind: 'config', revertible: false, before: {}, after: { password: 'changed' } }, async intent => {
            const attr = { password: password.toString(), password2: password.toString() };
            try { await mailcow.call(session, 'POST', '/api/v1/edit/mailbox', { items: [addr], attr }); }
            finally { delete attr.password; delete attr.password2; }
            steps.push({ stage, status: 'ok', auditId: intent.id });
          });
        } catch (error) {
          if (error instanceof MailcowAuthLost) throw error;
          if (!steps.length && (!flagAttempted || error.statusCode === 409)) throw error;
          steps.push({ stage, status: 'failed', code: safeCode(error), auditId: null });
          return response('partial');
        }
        return response('ok');
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
          await assertReusable(addr);
          await cleanupNetlimit({ actor, ip, addr });
          await audit.run({ actor, ip, action: 'mailbox/create', target: addr, kind: 'config', revertible: false, before: {}, after: { ...desired, password: 'set' } }, async intent => {
            const body = { local_part: addr.split('@')[0], domain, name: data.name, quota: String(quotaGb * 1024), active: '1', force_pw_update: '0', tls_enforce_in: '1', tls_enforce_out: '1', password: password.toString(), password2: password.toString() };
            await retirement?.routing.assertMutation(session, { kind: 'mailbox', address: addr, after: { username: addr, active: 1 } });
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
              await assertReusable(alias);
              if ((await rows(session, 'alias/all')).some(row => normalize(row.address) === alias) || (await rows(session, 'mailbox/all')).some(row => normalize(row.username) === alias)) throw new AppError(409, 'ALIAS_EXISTS', '이미 있는 주소라 별칭을 만들지 않았어요.');
              await audit.run({ actor, ip, action: 'alias/create', target: alias, kind: 'config', revertible: false, before: {}, after: { address: alias, targets: [addr], active: 1 } }, async intent => {
                await retirement?.routing.assertMutation(session, { kind: 'alias', address: alias, after: { address: alias, goto: addr, active: 1 } });
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
  function protectTeams(filters, aliases, addr) {
    const involved = [];
    for (const filter of filters.filter(row => row.filter_type === 'prefilter' && String(row.active) === '1')) {
      const parsed = analyze(filter.script_data), owner = normalize(filter.username);
      if (!parsed.parsed && String(filter.script_data ?? '').toLowerCase().includes('redirect')) {
        throw new AppError(409, 'UNPARSEABLE', `${owner}의 분배 필터를 해석할 수 없어요. 필터 화면에서 먼저 확인해 주세요.`);
      }
      if (!teamMembers(filter, aliases).includes(addr)) continue;
      const bundles = memberAliases(filter, aliases), alias = bundles[0];
      if (bundles.length > 1) throw new AppError(409, 'MULTIPLE_MEMBER_ALIASES', `${owner}의 묶음 별칭이 여러 개예요. 팀 분배에서 먼저 정리해 주세요.`);
      if (prefilters(filters, owner).length > 1) throw new AppError(409, 'MULTIPLE_PREFILTERS', `${owner}의 사전 필터가 여러 개예요. 필터 화면에서 먼저 정리해 주세요.`);
      try {
        if (alias && targets(alias.goto).includes(addr)) {
          if (targets(alias.goto).every(target => target === addr)) throw new Refused('last_member');
          if (parsed.stopperBeforeMember || !parsed.members.at(-1).simple) throw new Refused(parsed.stopperBeforeMember ? 'stopper_before_member' : 'line_not_simple');
        } else removeMember(filter.script_data, addr);
      }
      catch (error) {
        if (!(error instanceof Refused)) throw error;
        throw new AppError(409, error.code.toUpperCase(), error.code === 'last_member' ?
          `${owner}에서 이 사람이 마지막 구성원이에요. 팀 분배에서 다른 구성원을 먼저 넣어 주세요.` : `${owner}의 분배 필터를 안전하게 바꿀 수 없어요. 팀 분배에서 먼저 정리해 주세요.`);
      }
      involved.push({ ...filter, teamEtag: etag({ id: filter.id, source: filter.script_data, ...(alias ? { goto: alias.goto } : {}) }) });
    }
    return involved.sort((a, b) => normalize(a.username).localeCompare(normalize(b.username)));
  }
  async function lifecycleSnapshot(session, addr, { mode, cleanRefs, cleanShares = mode === 'delete', forwardTo }) {
    const account = snapshot(await box(session, addr)), netlimit = await netState(addr);
    const filters = await rows(session, 'filters/all');
    const ownFilters = prefilters(filters, addr).map(row => ({ id: row.id, sha256: scriptHash(row.script_data) })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    let forward;
    if (forwardTo) forward = await teams.previewForward(session, addr, forwardTo);
    const operation = { mode, cleanRefs, cleanShares, forwardTo };
    const retiredState = await retirementState(addr);
    if (mode === 'disable' && !cleanRefs && !cleanShares) return { state: { account, netlimit, ownFilters, operation, retiredState }, account, filters, forward,
      refs: { aliases: [], teams: [], senders: [], shares: [], syncjobs: [] }, sharesScope: 'none', teamsToClean: [] };
    const aliases = await rows(session, 'alias/all');
    if (mode === 'delete' && prefilters(filters, addr).some(filter => memberAliases(filter, aliases).length)) throw new AppError(409, 'TEAM_ALIAS_MODE', '팀 분배를 먼저 원래 방식으로 되돌려 주세요.');
    const teamsToClean = cleanRefs ? protectTeams(filters, aliases, addr) : [], aclByOwner = new Map(), ownerSnapshot = new Map();
    const info = await detail(session, addr, { allShares: true, includeProtocolNetlimit: false, aclSnapshot: aclByOwner, ownerSnapshot });
    if (cleanShares && info.warnings.some(warning => warning.code === 'SHARES_PARTIAL')) throw new AppError(502, 'SHARES_UNAVAILABLE', '공유를 모두 확인하지 못했어요. 아무것도 바꾸지 않았으니 다시 시도해 주세요.');
    const [boxes, jobs] = await Promise.all([rows(session, 'mailbox/all'), rows(session, 'syncjobs/all/no_log')]);
    const aliasRows = aliases.filter(row => !isMemberAlias(row) && targets(row.goto).includes(addr)).sort((a, b) => normalize(a.address).localeCompare(normalize(b.address)));
    const senderRows = boxes.filter(row => normalize(row.username) === addr && targets(row.sender_acl).length || targets(row.sender_acl).includes(addr)).sort((a, b) => normalize(a.username).localeCompare(normalize(b.username)));
    const syncRows = jobs.filter(row => normalize(row.user2) === addr).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const refs = Object.fromEntries(Object.entries(info.refs).map(([kind, values]) => [kind, values.map(ref => ({ ...ref, effect: kind === 'shares' ? cleanShares ? 'deleted' : 'kept' : !cleanRefs || kind === 'aliases' && mode === 'disable' ? 'kept' : kind === 'aliases' ? ref.targets.every(target => target === addr) ? 'deleted' : 'target_removed' : 'removed' }))]));
    const versions = {
      shareOwners: ownerVersions(ownerSnapshot),
      aliases: aliasRows.map(row => ({ address: normalize(row.address), sha256: etag(row) })),
      teams: teamsToClean.map(row => ({ mailbox: normalize(row.username), id: row.id, sha256: scriptHash(row.script_data), etag: row.teamEtag })),
      senders: senderRows.map(row => ({ mailbox: normalize(row.username), sha256: etag(row.sender_acl) })),
      shares: [...aclByOwner].sort(([a], [b]) => a.localeCompare(b)).map(([owner, acl]) => ({ owner, sha256: etag(acl) })),
      syncjobs: syncRows.map(row => ({ id: row.id, sha256: etag(row) })),
    };
    return { state: { account, netlimit, ownFilters, operation, retiredState, refs, versions }, account, filters, forward, refs, sharesScope: 'all',
      teamsToClean, aliasRows, senderRows, syncRows, aclByOwner, info };
  }
  async function deletePreview(session, rawAddress, options = {}) {
    const addr = address(rawAddress), mode = options.mode ?? 'delete', cleanRefs = options.cleanRefs ?? true;
    const forwardTo = options.forwardTo ? address(options.forwardTo) : null, cleanShares = options.cleanShares ?? (mode === 'delete');
    if (!['disable', 'delete'].includes(mode) || typeof cleanRefs !== 'boolean' || typeof cleanShares !== 'boolean' || mode === 'delete' && (!cleanRefs || !cleanShares || forwardTo)) throw invalid();
    const plan = await lifecycleSnapshot(session, addr, { mode, cleanRefs, cleanShares, forwardTo });
    const row = plan.info ?? await box(session, addr);
    return { address: addr, mode, cleanRefs, cleanShares, forwardTo, etag: etag(plan.state), messages: Number(row.messages ?? 0), usedBytes: Number(row.usedBytes ?? row.quota_used ?? 0),
      refs: plan.refs, sharesScope: plan.sharesScope, irreversible: mode === 'delete', confirmAddress: mode === 'delete' ? addr : null,
      confirmation: mode === 'delete' ? '메일함과 메일을 복구할 수 없어요. 주소를 직접 입력해 주세요.' : '로그인을 막고 메일은 보존해요.',
      warnings: [...(mode === 'disable' ? leaveWarnings() : []), ...(plan.info?.warnings ?? folderWarnings())] };
  }
  async function lifecycleRun({ session, actor, ip, addr: rawAddress, data, mode = 'delete', onRetired, onFinished, onStep, beforeWrite, skipForward = false }) {
    const addr = address(rawAddress), cleanRefs = data?.cleanRefs, cleanShares = mode === 'delete' ? true : data?.cleanShares ?? false, forwardTo = data?.forwardTo ? address(data.forwardTo) : null;
    if (typeof cleanShares !== 'boolean' || typeof cleanRefs !== 'boolean' || mode === 'delete' && (!cleanRefs || forwardTo) || mode === 'delete' && data.confirmAddress !== addr) throw invalid();
    return lock.run(`flow:${addr}`, async () => {
      const plan = await lifecycleSnapshot(session, addr, { mode, cleanRefs, cleanShares, forwardTo });
      assertUnchanged(data.etag, plan.state);
      const steps = [], cleaned = { aliases: [], teams: [], senders: [], shares: [], syncjobs: [] };
      const expectedAccount = structuredClone(plan.account);
      const skipOwnShares = cleanShares && plan.account.active === 0;
      const verifyShareOwners = owners => assertUnchanged(etag(plan.state.versions.shareOwners.filter(([owner]) => owners.has(owner)).map(([owner, active]) =>
        [owner, owner === addr ? expectedAccount.active : active])), ownerVersions(owners));
      let lostSession, stage, touched = false;
      const entry = { actor, ip, action: mode === 'delete' ? 'mailbox.delete' : 'mailbox.leave', target: addr,
        kind: mode === 'delete' ? 'irreversible' : 'config', revertible: false, before: { account: plan.account, refs: plan.refs }, after: { ...(mode === 'delete' ? {} : { active: 2, ...(Object.hasOwn(data, 'forwardTo') ? { forwardTo } : {}), cleanRefs, cleanShares, receiveBlocked: data.receiveBlocked ?? false }), ...(skipOwnShares ? { ownSharesUnchecked: true } : {}) } };
      const result = await audit.run(entry, async intent => {
        const success = async (name, target, auditId = null) => { touched = true; steps.push({ stage: name, target, status: 'ok', auditId }); await onStep?.({ stage: name, target }); };
        try {
          // Recheck the full preview once more after the durable intent and before the first write.
          assertUnchanged(data.etag, (await lifecycleSnapshot(session, addr, { mode, cleanRefs, cleanShares, forwardTo })).state);
          await beforeWrite?.();
          if (mode === 'disable') {
            stage = 'active';
            await lock.run(addr, async () => {
              const after = { ...plan.account, active: 2 };
              await save(session, addr, plan.account, after, () => { touched = true; }); expectedAccount.active = 2;
            });
            await success(stage, addr);
            stage = 'retirement';
            await onRetired?.(intent);
            if (forwardTo && !skipForward) {
              stage = 'forward';
              const applied = await teams.forward({ session, actor, ip, team: addr, member: forwardTo, etag: plan.forward.etag });
              await success(stage, addr, applied.auditId);
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
                else {
                  // Permanent deletion only: remove this owner's alias while its rejection keys remain until mailbox absence is verified.
                  await aliasApi.remove(session, [String(alias.id)]);
                }
                const checked = (await rows(session, 'alias/all')).find(row => String(row.id) === String(alias.id));
                if (remaining.length ? !checked || !isDeepStrictEqual(targets(checked.goto), remaining) : Boolean(checked)) throw verifyFailed();
              });
              cleaned.aliases.push(aliasAddress); await success(stage, aliasAddress);
            }
            for (const filter of plan.teamsToClean) {
              stage = 'teams'; const owner = normalize(filter.username);
              const applied = await teams.change({ session, actor, ip, team: owner, member: addr, add: false, irreversible: mode === 'delete', etag: filter.teamEtag });
              cleaned.teams.push(owner); await success(stage, owner, applied.auditId);
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
              cleaned.senders.push(owner); await success(stage, owner);
            }
          }
          if (cleanShares) {
            const owners = [...new Set(plan.refs.shares.map(share => share.owner))].sort();
            for (const owner of owners) {
              stage = 'shares';
              await lock.run(owner, async () => {
                const owned = acl => acl.filter(row => normalize(row.user) === owner);
                assertUnchanged(etag(owned(plan.aclByOwner.get(owner))), owned(await aclFolders.readOwned(owner)));
                const grants = plan.refs.shares.filter(share => share.owner === owner);
                await aclFolders.assertExist(owner, [...new Set(grants.map(share => share.mailbox))]);
                for (const { grantee, mailbox } of grants) {
                  await dockerapi.deleteAcl(owner, grantee, mailbox); touched = true;
                  cleaned.shares.push({ owner, grantee, mailbox });
                }
                const checked = await aclFolders.readOwned(owner);
                if (checked.some(row => normalize(row.user) === owner && (owner === addr || normalize(row.id) === addr))) throw verifyFailed();
                for (const { grantee, mailbox } of grants) await success(stage, `${owner} → ${grantee} (${mailbox})`);
              });
            }
          }
          if (cleanRefs) {
            for (const job of plan.syncRows) {
              stage = 'syncjobs';
              await lock.run(`syncjob:${job.id}`, async () => {
                const current = (await rows(session, 'syncjobs/all/no_log')).find(row => String(row.id) === String(job.id));
                assertUnchanged(etag(job), current ?? {});
                await mailcow.call(session, 'POST', '/api/v1/delete/syncjob', [String(job.id)]);
                if ((await rows(session, 'syncjobs/all/no_log')).some(row => String(row.id) === String(job.id))) throw verifyFailed();
              });
              cleaned.syncjobs.push(job.id); await success(stage, String(job.id));
            }
          }
          if (mode === 'delete') {
            stage = 'mailbox';
            await lock.run(addr, async () => {
              const checkedOwners = new Map();
              const current = await detail(session, addr, { allShares: true, includeProtocolNetlimit: false, ownerSnapshot: checkedOwners });
              verifyShareOwners(checkedOwners);
              if (current.warnings.some(warning => warning.code === 'SHARES_PARTIAL')) throw new AppError(502, 'SHARES_UNAVAILABLE', '공유를 모두 확인하지 못해 삭제를 멈췄어요.');
              if (Object.values(current.refs).some(refs => refs.length)) throw new AppError(409, 'REFERENCES_REMAIN', '연결이 남아 있어 메일함을 지우지 않았어요. 다시 미리보기를 확인해 주세요.');
              assertUnchanged(etag(expectedAccount), snapshot(await box(session, addr)));
              const checkedFilters = await rows(session, 'filters/all');
              protectTeams(checkedFilters, await rows(session, 'alias/all'), addr);
              const ownFilters = prefilters(checkedFilters, addr).map(row => ({ id: row.id, sha256: scriptHash(row.script_data) })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
              assertUnchanged(etag(plan.state.ownFilters), ownFilters);
              assertUnchanged(etag(plan.state.netlimit), await netState(addr));
              await mailcow.call(session, 'POST', '/api/v1/delete/mailbox', [addr]);
              if ((await rows(session, 'mailbox/all')).some(row => normalize(row.username) === addr)) throw verifyFailed();
            });
            await success(stage, addr);
            stage = 'retirement';
            await cleanupRetirement(addr, plan.state.retiredState);
            stage = 'protocol-netlimit';
            await lock.run(addr, () => cleanupNetlimit({ actor, ip, addr, expected: plan.state.netlimit }));
            if (plan.state.netlimit.version !== null) await success(stage, addr);
            stage = 'otp';
            const clearedOtp = await otp.cleanup({ email: addr, actor, ip });
            await success(stage, addr, clearedOtp.auditId);
          }
          if (mode === 'disable' && cleanShares) {
            stage = 'shares';
            const checkedOwners = new Map();
            const current = await detail(session, addr, { allShares: true, includeProtocolNetlimit: false, ownerSnapshot: checkedOwners, skipOwnShares });
            verifyShareOwners(checkedOwners);
            if (current.warnings.some(warning => warning.code === 'SHARES_PARTIAL') || current.refs.shares.length) throw verifyFailed();
          }
          stage = 'retirement';
          const final = await onFinished?.();
          if (final?.steps) steps.push(...final.steps);
          return { result: final?.result === 'partial' ? 'partial' : 'ok', steps, ...(final?.recovery ? { recovery: final.recovery } : {}), detail: { ...(final?.recovery ? { recovery: final.recovery } : {}), messages: plan.info?.messages ?? 0, usedBytes: plan.info?.usedBytes ?? 0, cleaned, steps }, warnings: [...(mode === 'disable' ? leaveWarnings() : []), ...(plan.info?.warnings ?? folderWarnings())] };
        } catch (error) {
          if (!touched) throw error;
          if (error instanceof MailcowAuthLost) lostSession = error;
          const recovery = stage === 'protocol-netlimit' ? [{ stage, message: '계정 변경은 적용됐지만 제한 설정 정리를 완료하지 못했어요. 현재 상태를 다시 확인해 주세요.' }] : stage === 'otp' ? [{ stage, message: '메일함 삭제는 적용됐어요. 관리 2단계 인증 초기화 API로 이전 주소의 남은 등록을 정리해 주세요.' }] : stage === 'aliases' ? [{ stage, message: '별칭 대상과 대상 메일함의 보내기 권한을 mailcow에서 확인하고 원래 권한을 복원해 주세요.' }] : [];
          steps.push({ stage: stage ?? 'verify', status: 'failed', code: safeCode(error), auditId: null, ...(recovery.length ? { recovery: recovery[0].message } : {}) });
          return { result: 'partial', steps, ...(recovery.length ? { recovery } : {}), detail: { messages: plan.info?.messages ?? 0, usedBytes: plan.info?.usedBytes ?? 0, cleaned, steps, ...(recovery.length ? { recovery } : {}) }, warnings: [...(mode === 'disable' ? leaveWarnings() : []), ...(plan.info?.warnings ?? folderWarnings())] };
        }
      });
      if (lostSession) throw lostSession;
      return result;
    });
  }
  function retirementInput(data, { leave = false } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.receiveBlocked !== 'boolean' ||
      data.cleanupConfirmed !== undefined && typeof data.cleanupConfirmed !== 'boolean' ||
      Object.hasOwn(data, 'forwardTo') && data.forwardTo !== null && (typeof data.forwardTo !== 'string' || !data.forwardTo)) throw invalid();
    if (!leave && Object.keys(data).some(key => !['receiveBlocked', 'forwardTo', 'etag', 'cleanupConfirmed'].includes(key))) throw invalid();
    const value = { receiveBlocked: data.receiveBlocked, cleanupConfirmed: data.cleanupConfirmed ?? false };
    if (Object.hasOwn(data, 'forwardTo')) value.forwardTo = data.forwardTo === null ? null : address(data.forwardTo);
    if (value.receiveBlocked && value.forwardTo) throw retirementConflict('RETIREMENT_FORWARD_CONFLICT');
    return value;
  }
  async function retirementPlan(session, addr, request, { initialLeave = false, allowPendingLeave = initialLeave } = {}) {
    if (!retirement) throw blockUnavailable();
    const state = await retirementState(addr), account = snapshot(await box(session, addr));
    const ownerKeys = await retirement.store.keysForOwner(addr);
    if (state.pendingOperation?.kind === 'leave' && !allowPendingLeave) throw new AppError(409, 'RETIREMENT_OPERATION_PENDING', '퇴사 처리의 남은 정리를 기존 퇴사 미리보기에서 먼저 처리해 주세요.');
    if (!initialLeave && (!state.retired || account.active !== 2)) throw retirementConflict('RETIREMENT_STATE_CONFLICT');
    if (request.receiveBlocked && (!retirement.featureEnabled || !retirement.ready)) throw blockUnavailable(state.pendingOperation?.kind === 'leave');
    const own = prefilters(await rows(session, 'filters/all'), addr), removeForward = [], blockers = [];
    const forwarding = own.map(filter => {
      const location = { source: 'admin', type: 'prefilter', address: addr, id: String(filter.id) };
      try { return { ...location, targets: [...new Set(retirementRedirects(filter.script_data).map(row => row.target))], inspected: true }; }
      catch { return { ...location, targets: [], inspected: false }; }
    });
    const existingTargets = [...new Set(forwarding.flatMap(row => row.targets))].sort();
    const forwardingChange = request.forwardTo ? { effect: existingTargets.includes(request.forwardTo) ? 'unchanged' : 'add', target: request.forwardTo,
      existingTargets, message: existingTargets.includes(request.forwardTo) ? '이미 있는 관리 전달을 유지해요.' : `기존 관리 전달 ${existingTargets.length}개에 ${request.forwardTo} 추가` } :
      request.forwardTo === null ? { effect: 'remove-managed', existingTargets, message: '미리보기에 표시된 관리 전달만 지워요.' } :
        { effect: 'kept', existingTargets, message: '기존 전달을 유지해요.' };
    let forward;
    if (request.forwardTo) { await retirement.routing.assertRecipients([request.forwardTo]); forward = await teams.previewForward(session, addr, request.forwardTo); }
    if (request.forwardTo === null) for (const filter of own) {
      let redirects;
      try { redirects = retirementRedirects(filter.script_data); } catch { blockers.push({ code: 'OWNER_FORWARD_UNEDITABLE', ...forwarding.find(row => row.id === String(filter.id)) }); continue; }
      if (!redirects.length) continue;
      const parsed = analyze(filter.script_data);
      // Whole-filter removal is restricted to a pure literal copy-forward filter.
      const pure = parsed.parsed && redirects.every(row => row.copy) && parsed.members.length === redirects.length &&
        retirementTokens(filter.script_data).every(token => typeof token === 'object' || ['require', 'redirect', ':copy', 'stop', '[', ']', ',', ';'].includes(token));
      if (!pure || own.length !== 1) blockers.push({ code: 'OWNER_FORWARD_UNEDITABLE', ...forwarding.find(row => row.id === String(filter.id)) });
      else removeForward.push({ id: String(filter.id), hash: scriptHash(filter.script_data), effect: 'filter_deleted_with_backup' });
    }
    const routing = request.receiveBlocked ? await retirement.routing.inspect(session, addr) : null;
    if (routing) blockers.push(...routing.blockers.filter(issue => !(issue.code === 'OWNER_FORWARD_ACTIVE' && issue.source === 'admin' && issue.type === 'prefilter' && removeForward.some(row => row.id === issue.id))));
    const changes = [...removeForward.map(row => ({ kind: 'owner-forward', address: addr, ...row })), ...(routing?.changes ?? [])];
    const version = { account, state, ownerKeys, request: { receiveBlocked: request.receiveBlocked, ...(Object.hasOwn(request, 'forwardTo') ? { forwardTo: request.forwardTo } : {}) },
      own: own.map(row => ({ id: row.id, hash: scriptHash(row.script_data) })).sort((a, b) => String(a.id).localeCompare(String(b.id))), routing: routing?.etag ?? null, forward: forward?.etag ?? null };
    return { address: addr, request, state, ownerKeys, account, routing, forward, changes, blockers, version, etag: etag(version),
      retirement: retirementDto(state, account.active), forwarding, forwardingChange, after: { receiveBlocked: request.receiveBlocked, ...(Object.hasOwn(request, 'forwardTo') ? { forwardTo: request.forwardTo } : {}) } };
  }
  const retirementPreviewDto = plan => ({ address: plan.address, etag: plan.etag, retirement: plan.retirement, after: plan.after,
    changes: plan.changes, blockers: plan.blockers, forwarding: plan.forwarding, forwardingChange: plan.forwardingChange, canPrepare: !plan.blockers.length, cleanupRequired: plan.changes.length > 0,
    warnings: plan.retirement.warnings });
  async function retirementPreview(session, rawAddress, data) {
    const addr = address(rawAddress), request = retirementInput(data);
    return retirementPreviewDto(await retirementPlan(session, addr, request));
  }
  function assertRetirementPlan(plan, consent) {
    if (plan.blockers.length) { const error = retirementConflict('RETIREMENT_ROUTES_REMAIN'); error.details = { blockers: plan.blockers }; throw error; }
    if (plan.changes.length && !consent) throw retirementConflict('RETIREMENT_CLEANUP_CONFIRM_REQUIRED');
  }
  async function applyRetirement({ session, actor, ip, addr, request, plan, completed = [], pendingBase = null, auditId }) {
    const steps = [], done = stage => completed.includes(stage), complete = stage => { if (!done(stage)) completed.push(stage); steps.push({ stage, status: 'ok' }); };
    let state = await retirementState(addr), stage = 'pending';
    const teamRevisions = new Map();
    const pending = () => ({ ...(pendingBase ?? { kind: 'settings', request, auditId }), completed: [...completed] });
    try {
      state = await writeRetirement(addr, state, { pendingOperation: pending() }, actor);
      // OFF is committed before any requested forwarding write.
      if (!request.receiveBlocked && state.receiveBlocked) {
        stage = 'receive-off'; state = await writeRetirement(addr, state, { receiveBlocked: false, pendingOperation: pending() }, actor, []); complete(stage);
      }
      stage = 'remove-forward';
      if (!done(stage) || plan.changes.some(row => row.kind === 'owner-forward')) {
        for (const change of plan.changes.filter(row => row.kind === 'owner-forward')) {
          const filter = (await rows(session, 'filters/all')).find(row => String(row.id) === change.id);
          if (!filter || normalize(filter.username) !== addr || scriptHash(filter.script_data) !== change.hash) throw retirementConflict('CHANGED_ELSEWHERE');
          await teams.deleteFilter({ session, actor, ip, filter });
        }
        complete(stage); state = await writeRetirement(addr, state, { pendingOperation: pending() }, actor);
      }
      stage = 'routing-cleanup';
      if (request.receiveBlocked) {
        // The initial etag was checked before writing; each remaining edge is now read and checked again.
        for (const change of plan.changes.filter(row => ['alias', 'team-member-alias', 'team'].includes(row.kind))) {
          if (change.kind === 'alias') await lock.run(change.address, async () => {
            const alias = (await rows(session, 'alias/all')).find(row => normalize(row.address) === change.address);
            if (!alias || etag(alias) !== change.version) throw retirementConflict('CHANGED_ELSEWHERE');
            await audit.run({ actor, ip, action: 'mailbox.retirement.alias', target: change.address, kind: 'config', revertible: false,
              before: aliasBackup(alias), after: { targets: change.keep } }, async () => {
              await editAliasPreservingSenders(session, alias, { items: [String(alias.id)], attr: { goto: change.keep.join(',') } });
              const checked = (await rows(session, 'alias/all')).find(row => String(row.id) === String(alias.id));
              if (!checked || !isDeepStrictEqual(targets(checked.goto), change.keep)) throw verifyFailed();
            });
          });
          else for (const member of change.remove) {
            const team = change.kind === 'team' ? change.address : change.team;
            const filter = prefilters(await rows(session, 'filters/all'), team).find(row => String(row.id) === change.filterId);
            if (!filter) throw retirementConflict('CHANGED_ELSEWHERE');
            const aliases = await rows(session, 'alias/all'), bundle = memberAliases(filter, aliases)[0];
            const currentEtag = etag({ id: filter.id, source: filter.script_data, ...(bundle ? { goto: bundle.goto } : {}) });
            if (currentEtag !== (teamRevisions.get(team) ?? change.etag)) throw retirementConflict('CHANGED_ELSEWHERE');
            const applied = await teams.change({ session, actor, ip, team, member, add: false, etag: currentEtag });
            teamRevisions.set(team, applied.etag);
          }
        }
        complete(stage);
        stage = 'receive-on';
        const fresh = await retirement.routing.inspect(session, addr), keys = retirement.routing.assertReady(fresh);
        if (!state.receiveBlocked || !isDeepStrictEqual(await retirement.store.keysForOwner(addr), keys)) state = await writeRetirement(addr, state, { receiveBlocked: true, pendingOperation: pending() }, actor, keys);
        complete(stage);
      }
      stage = 'forward';
      if (request.forwardTo && (!done(stage) || !plan.forwarding.some(row => row.targets.includes(request.forwardTo)))) {
        const preview = await teams.previewForward(session, addr, request.forwardTo);
        await retirement.routing.assertRecipients([request.forwardTo]);
        await teams.forward({ session, actor, ip, team: addr, member: request.forwardTo, etag: preview.etag }); complete(stage);
      }
      stage = 'complete'; state = await writeRetirement(addr, state, { pendingOperation: null }, actor);
      return { result: 'ok', address: addr, auditId, steps, detail: { steps }, retirement: retirementDto(state), warnings: retirementDto(state).warnings };
    } catch (error) {
      if (error instanceof MailcowAuthLost) throw error;
      steps.push({ stage, status: 'failed', code: safeCode(error) });
      let actual;
      try {
        actual = await retirementState(addr);
        // Readback resolves uncertain CAS commits; preserve the last committed selection.
        actual = await writeRetirement(addr, actual, { pendingOperation: pending() }, actor);
      } catch { actual = null; }
      const recovery = [{ stage, message: '현재 퇴사·수신 상태와 남은 연결을 다시 미리보기로 확인해 주세요.' }];
      return { result: 'partial', address: addr, auditId, steps, detail: { steps, recovery }, retirement: actual ? retirementDto(actual) : null, reloadRequired: !actual, recovery, warnings: [] };
    }
  }
  async function retirementUpdate({ session, actor, ip, addr: rawAddress, data }) {
    const addr = address(rawAddress), request = retirementInput(data);
    return routingLock(async () => {
      const plan = await retirementPlan(session, addr, request); assertUnchanged(data.etag, plan.version); assertRetirementPlan(plan, request.cleanupConfirmed);
      if (!plan.state.pendingOperation && plan.state.receiveBlocked === request.receiveBlocked && !Object.hasOwn(request, 'forwardTo') && !plan.changes.length &&
        isDeepStrictEqual(plan.ownerKeys, request.receiveBlocked ? plan.routing.keys : [])) return { result: 'unchanged', unchanged: true, retirement: plan.retirement, warnings: plan.retirement.warnings };
      return audit.run({ actor, ip, action: 'mailbox.retirement', target: addr, kind: 'config', revertible: false, before: plan.retirement, after: { ...plan.after, cleanupConfirmed: request.cleanupConfirmed, changes: plan.changes } }, async intent => {
        const fresh = await retirementPlan(session, addr, request); assertUnchanged(data.etag, fresh.version); assertRetirementPlan(fresh, request.cleanupConfirmed);
        const previous = fresh.state.pendingOperation;
        const sameRequest = previous?.kind === 'settings' && previous.request?.receiveBlocked === request.receiveBlocked &&
          Object.hasOwn(previous.request ?? {}, 'forwardTo') === Object.hasOwn(request, 'forwardTo') && previous.request?.forwardTo === request.forwardTo;
        return applyRetirement({ session, actor, ip, addr, request, plan: fresh, auditId: intent.id, completed: sameRequest ? [...(previous.completed ?? [])] : [] });
      });
    });
  }

  async function leave({ session, actor, ip, data }) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !['preview', 'run'].includes(data.action) || !['disable', 'delete'].includes(data.mode) || typeof data.cleanRefs !== 'boolean' ||
      Object.keys(data).some(key => !['action', 'address', 'mode', 'cleanRefs', 'cleanShares', 'forwardTo', 'receiveBlocked', 'cleanupConfirmed', 'etag', 'confirmAddress'].includes(key))) throw invalid();
    if (data.cleanShares !== undefined && typeof data.cleanShares !== 'boolean' || data.receiveBlocked !== undefined && typeof data.receiveBlocked !== 'boolean' ||
      data.cleanupConfirmed !== undefined && typeof data.cleanupConfirmed !== 'boolean') throw invalid();
    if (Object.hasOwn(data, 'forwardTo') && data.forwardTo !== null && (typeof data.forwardTo !== 'string' || !data.forwardTo)) throw invalid();
    if (data.receiveBlocked && data.forwardTo) throw retirementConflict('RETIREMENT_FORWARD_CONFLICT');
    const addr = address(data.address);
    if (!retirement || data.mode === 'delete') {
      if (data.mode === 'delete' && (data.receiveBlocked || data.forwardTo)) throw invalid();
      const result = data.action === 'preview' ? await deletePreview(session, addr, data) : await lifecycleRun({ session, actor, ip, addr, data, mode: data.mode });
      return { ...result, warnings: [...leaveWarnings(), ...result.warnings.filter(warning => !leaveWarnings().some(row => row.code === warning.code))] };
    }
    const current = await retirementState(addr);
    const currentActive = Number((await box(session, addr)).active);
    if (current.retired && !current.pendingOperation) return { result: 'unchanged', alreadyRetired: true, unchanged: true,
      address: addr, accountActive: currentActive, message: '이미 퇴사 처리한 계정이에요. 계정 상세에서 수신 설정을 바꿔 주세요.', settingsPath: `/admin/accounts/${encodeURIComponent(addr)}`, retirement: retirementDto(current, currentActive), warnings: [] };
    if (current.pendingOperation && current.pendingOperation.kind !== 'leave') return { result: 'unchanged', alreadyRetired: true, address: addr,
      accountActive: currentActive, settingsPath: `/admin/accounts/${encodeURIComponent(addr)}`, retirement: retirementDto(current, currentActive), warnings: [] };
    // Older retries may omit the new selection; the persisted request remains authoritative.
    const saved = current.pendingOperation?.request;
    if (saved && ['receiveBlocked', 'cleanRefs', 'cleanShares', 'forwardTo'].some(key => Object.hasOwn(data, key) && !isDeepStrictEqual(data[key], saved[key]))) throw retirementConflict('RETIREMENT_RETRY_SETTINGS_CHANGED');
    const options = saved ?? { cleanRefs: data.cleanRefs, cleanShares: data.cleanShares ?? false, receiveBlocked: data.receiveBlocked ?? false,
      ...(data.receiveBlocked ? { forwardTo: null } : Object.hasOwn(data, 'forwardTo') ? { forwardTo: data.forwardTo === null ? null : address(data.forwardTo) } : {}) };
    const request = retirementInput({ ...options, cleanupConfirmed: data.cleanupConfirmed ?? false }, { leave: true });
    const prepare = async () => {
      const lifecycle = await deletePreview(session, addr, { ...options, mode: 'disable' });
      const settings = await retirementPlan(session, addr, request, { initialLeave: true });
      const version = { lifecycle: lifecycle.etag, settings: settings.etag };
      return { lifecycle, settings, version };
    };
    const plan = await prepare();
    if (data.action === 'preview') return { ...plan.lifecycle, confirmation: !current.retired && plan.settings.account.active === 2 ? '받기 전용 계정이에요. 실행하면 퇴사 처리 기록을 명시적으로 남겨요.' : plan.lifecycle.confirmation, etag: etag(plan.version), receiveBlocked: options.receiveBlocked,
      retirement: plan.settings.retirement, forwarding: plan.settings.forwarding, forwardingChange: plan.settings.forwardingChange, receiveChanges: plan.settings.changes, blockers: plan.settings.blockers,
      cleanupRequired: plan.settings.changes.length > 0, canPrepare: !plan.settings.blockers.length, alreadyRetired: current.retired,
      pendingOperation: current.pendingOperation, unclassifiedReceiveOnly: !current.retired && plan.settings.account.active === 2 };
    assertUnchanged(data.etag, plan.version); assertRetirementPlan(plan.settings, request.cleanupConfirmed);
    let state = current, settingsResult;
    const pending = { kind: 'leave', request: options, lifecycleCompleted: current.pendingOperation?.lifecycleCompleted ?? [], completed: current.pendingOperation?.completed ?? [] };
    if (current.retired && plan.settings.account.active !== 2) throw retirementConflict('RETIREMENT_STATE_CONFLICT');
    const skipForward = options.forwardTo && pending.lifecycleCompleted.some(row => row.stage === 'forward') &&
      prefilters(await rows(session, 'filters/all'), addr).some(row => { try { return retirementRedirects(row.script_data).some(item => item.copy && item.target === options.forwardTo); } catch { return false; } });
    const result = await lifecycleRun({ session, actor, ip, addr, mode: 'disable', data: { ...data, ...options, etag: plan.lifecycle.etag }, skipForward,
      beforeWrite: async () => {
        const fresh = await retirementPlan(session, addr, request, { initialLeave: true });
        assertUnchanged(plan.settings.etag, fresh.version); assertRetirementPlan(fresh, request.cleanupConfirmed);
      },
      onStep: async completed => {
        if (!pending.lifecycleCompleted.some(row => isDeepStrictEqual(row, completed))) pending.lifecycleCompleted.push(completed);
        if (state.retired) state = await writeRetirement(addr, state, { pendingOperation: pending }, actor);
      },
      onRetired: async intent => {
        pending.auditId ??= intent.id;
        // active=2 has already been read back, so later failures cannot hide the retirement fact.
        state = await writeRetirement(addr, state, { retired: true, recordedAt: state.recordedAt ?? new Date().toISOString(), source: state.source ?? 'leave',
          sourceAuditId: state.sourceAuditId ?? intent.id, pendingOperation: pending }, actor);
      },
      onFinished: async () => {
        // Known cleanup changes alter the original graph. Re-inspect before committing keys.
        const fresh = await retirementPlan(session, addr, request, { allowPendingLeave: true });
        assertRetirementPlan(fresh, request.cleanupConfirmed);
        const consented = change => JSON.stringify({ kind: change.kind, address: change.address, remove: change.remove, keep: change.keep, id: change.id, hash: change.hash, filterId: change.filterId });
        if (fresh.changes.some(change => !plan.settings.changes.some(old => consented(old) === consented(change)))) throw retirementConflict('CHANGED_ELSEWHERE');
        settingsResult = await applyRetirement({ session, actor, ip, addr, request, plan: fresh, pendingBase: pending, auditId: pending.auditId, completed: [...pending.completed, ...(options.forwardTo ? ['forward'] : [])] });
        return settingsResult;
      } });
    let actual, accountActive;
    try { actual = retirementDto(await retirementState(addr)); } catch { actual = null; }
    try { accountActive = Number((await box(session, addr)).active); } catch { accountActive = null; }
    return { ...result, address: addr, accountActive, requested: options, ...(settingsResult?.result === 'partial' ? { result: 'partial' } : {}),
      steps: result.steps, detail: result.detail, retirement: actual, reloadRequired: !actual || accountActive === null,
      ...(settingsResult?.recovery ? { recovery: settingsResult.recovery } : {}) };
  }
  const renameNotices = [
    '앱 암호·본인 필터 소유자는 mailcow가 함께 바꿔요.',
    'BCC·수신 주소 바꾸기(recipient map) 설정은 확인하지 않아요 — mailcow 화면에서 확인해 주세요.',
  ];
  const replaceAddress = (values, old, next) => [...new Set(values.map(value => value === old ? next : value))].sort();
  const aclReadOnly = row => addressPattern.test(row.id) && isDeepStrictEqual([...new Set(row.rights)].sort(), ['lookup', 'read']);
  async function renamePlan(session, old, next) {
    const retiredState = await assertMovable(old); await assertReusable(next);
    const row = await box(session, old), account = snapshot(row);
    if (row.active === 0 || row.active === '0') throw inactiveMailbox();
    if (![1, 2, '1', '2'].includes(row.active)) throw new AppError(502, 'SHARES_UNAVAILABLE', '메일함의 사용 상태를 확인하지 못했어요. 다시 시도해 주세요.');
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
    const aclByOwner = new Map(), ownerSnapshot = new Map(), info = await detail(session, old, { allShares: true, includeProtocolNetlimit: false, aclSnapshot: aclByOwner, ownerSnapshot });
    if (info.warnings.some(warning => warning.code === 'SHARES_PARTIAL')) throw new AppError(502, 'SHARES_UNAVAILABLE', '공유를 모두 확인하지 못했어요. 다시 시도해 주세요.');
    const shares = relatedShares(aclByOwner, old).map(row => ({ owner: row.owner, grantee: row.id, mailbox: row.mailbox, rights: [...row.rights] }));
    for (const share of shares) {
      const existing = aclByOwner.get(share.owner)?.find(item => normalize(item.id) === next && item.mailbox === share.mailbox);
      if (!aclReadOnly({ ...share, id: share.grantee }) || existing && !aclReadOnly(existing)) throw new AppError(409, 'ACL_UNSUPPORTED', '관련 공유에 읽기 외 권한이 있어요. 공유 설정을 먼저 확인해 주세요.');
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
    const state = { old, next, keepOldAsAlias: true, retiredState, account, netlimit: await netState(old), netlimitTarget: await netState(next), shareOwners: ownerVersions(ownerSnapshot),
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
    const preview = plan => ({ address: old, newAddress: next, changes: plan.changes, etag: etag(plan.state), sharesScope: 'all', notices: renameNotices, warnings: plan.info.warnings });
    if (data.action === 'preview') return preview(await renamePlan(session, old, next));
    const addresses = [old, next].sort();
    return lock.run(`flow:${addresses[0]}`, () => lock.run(`flow:${addresses[1]}`, async () => {
      const plan = await renamePlan(session, old, next); assertUnchanged(data.etag, plan.state);
      const steps = [], recovery = [
        { stage: 'mailbox', message: `현재 ${next} 함을 확인해 주세요. 주소를 다시 바꾸려면 mailcow에서 모든 연결도 함께 확인해 주세요.` },
        { stage: 'protocol-netlimit', message: '주소 변경은 적용됐지만 제한 설정 정리를 완료하지 못했어요. 현재 상태를 다시 확인해 주세요.' },
        { stage: 'otp', message: '주소 변경은 적용됐어요. 관리 2단계 인증 초기화 API로 이전 주소의 남은 등록을 정리하고 새 주소로 다시 등록해 주세요.' },
        { stage: 'teamFilters', message: `필터 화면에서 ${old} 대신 ${next}로 팀 전달 주소를 확인해 주세요.` },
        { stage: 'aliases', message: `별칭 대상에서 ${old}를 ${next}로 바꾸고 대상 메일함의 원래 보내기 권한을 확인해 주세요.` },
        { stage: 'senders', message: '새 주소의 보내기 권한과 새 주소로 보낼 수 있는 사람을 권한 화면에서 확인해 주세요.' },
        { stage: 'shares', message: '공유 화면에서 새 주소의 폴더별 읽기 공유를 확인해 주세요.' },
        { stage: 'syncjobs', message: '대상이 바뀌지 않은 동기화 작업은 지우고 새 주소로 다시 만들어 주세요.' },
        { stage: 'oldAlias', message: `${old}를 ${next}로 보내는 별칭을 만들어 주세요.` },
      ];
      let renamed = false, fatal, netCopy, stage = 'mailbox';
      const warnings = plan.info.warnings.filter(warning => warning.code !== 'SUBFOLDER_ACL_UNCHECKED');
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
            if (!warnings.some(warning => warning.code === 'MAIL_COUNT_DECREASED')) warnings.push({ code: 'MAIL_COUNT_DECREASED', message: '주소를 바꾼 뒤 메일 수가 줄었어요. mailcow에서 메일 보존 상태를 바로 확인해 주세요.' });
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
              if (plan.state.netlimit.version !== null || plan.state.netlimitTarget.version !== null) {
                netCopy = { enabled: plan.state.netlimit.enabled, version: protocolNetlimitVersion() };
                await runStage('protocol-netlimit', next, plan.state.netlimitTarget, netCopy, () =>
                  protocolNetlimit.write({ email: next, enabled: netCopy.enabled, version: netCopy.version, expected: plan.state.netlimitTarget }));
                stage = 'mailbox';
              }
              assertUnchanged(etag(plan.state.netlimit), await netState(old));
              await retirement?.routing.assertMutation(session, { kind: 'mailbox', address: next, after: { username: next, active: plan.account.active } });
              await mailcow.call(session, 'POST', '/api/v1/edit/rename-mbox', { items: [old], attr: { domain: old.split('@')[1], old_local_part: old.split('@')[0], new_local_part: next.split('@')[0], create_alias: '0' } });
              renamed = true;
              await verifyMailbox();
            });
          }));
          stage = 'retirement';
          if (retirement && plan.state.retiredState.version !== null) {
            await writeRetirement(next, await retirementState(next), { ...plan.state.retiredState, pendingOperation: null }, actor, []);
            await cleanupRetirement(old, plan.state.retiredState);
            steps.push({ stage, target: next, status: 'ok' });
          }
          stage = 'protocol-netlimit';
          await lock.run(old, () => cleanupNetlimit({ actor, ip, addr: old, expected: plan.state.netlimit }));
          if (plan.state.netlimit.version !== null) steps.push({ stage, target: old, status: 'ok' });
          stage = 'otp';
          const clearedOtp = await otp.cleanup({ email: old, actor, ip });
          steps.push({ stage, target: old, status: 'ok', auditId: clearedOtp.auditId });
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
          const shareOwners = [...new Set(plan.changes.shares.map(share => share.newOwner))].sort();
          for (const owner of shareOwners) await lock.run(owner, async () => {
            stage = 'shares';
            const grants = plan.changes.shares.filter(share => share.newOwner === owner);
            await aclFolders.assertExist(owner, [...new Set(grants.map(share => share.mailbox))]);
            for (const share of grants) await runStage('shares', owner,
              { grantee: share.grantee, owner: share.owner, mailbox: share.mailbox },
              { grantee: share.newGrantee, owner, mailbox: share.mailbox }, async () => {
                let current = await aclFolders.readOwned(owner);
                const relevant = current.filter(item => item.mailbox === share.mailbox && [share.grantee, share.newGrantee].includes(normalize(item.id)));
                if (relevant.some(item => !aclReadOnly(item)) || relevant.length === 0) assertUnchanged('conflict', {});
                if (!relevant.some(item => normalize(item.id) === share.newGrantee)) await dockerapi.setAcl(owner, share.newGrantee, share.mailbox);
                if (share.grantee !== share.newGrantee && relevant.some(item => normalize(item.id) === share.grantee)) await dockerapi.deleteAcl(owner, share.grantee, share.mailbox);
                current = await aclFolders.readOwned(owner);
                if (!current.some(item => item.mailbox === share.mailbox && normalize(item.id) === share.newGrantee && aclReadOnly(item)) ||
                  share.grantee !== share.newGrantee && current.some(item => item.mailbox === share.mailbox && normalize(item.id) === old)) throw verifyFailed();
              });
          });
          for (const job of plan.syncRows) await runStage('syncjobs', String(job.id), { id: job.id, target: old }, { id: job.id, target: next }, async () => {
            const checked = (await rows(session, 'syncjobs/all/no_log')).find(item => String(item.id) === String(job.id));
            if (!checked || normalize(checked.user2) !== next) throw verifyFailed();
          });
          await lock.run(old, async () => {
            await runStage('oldAlias', old, {}, { address: old, targets: [next] }, async () => {
              if ((await rows(session, 'alias/all')).some(item => normalize(item.address) === old)) throw new AppError(409, 'ADDRESS_IN_USE', '옛 주소가 이미 별칭으로 있어요. 현재 대상을 확인해 주세요.');
              await retirement?.routing.assertMutation(session, { kind: 'alias', address: old, after: { address: old, goto: next, active: 1 } });
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
          const checkedAcl = new Map(), checkedOwners = new Map(), info = await detail(session, next, { allShares: true, includeProtocolNetlimit: false, aclSnapshot: checkedAcl, ownerSnapshot: checkedOwners });
          assertUnchanged(etag(ownerVersions(new Map(plan.state.shareOwners.map(([owner, active]) => [owner === old ? next : owner, active]).filter(([owner]) => checkedOwners.has(owner))))), ownerVersions(checkedOwners));
          if (info.warnings.some(warning => warning.code === 'SHARES_PARTIAL') || [...checkedAcl.values()].some(acl => acl.some(item => normalize(item.id) === old))) throw verifyFailed();
          for (const share of plan.changes.shares) if (!checkedAcl.get(share.newOwner)?.some(item => item.mailbox === share.mailbox && normalize(item.id) === share.newGrantee && aclReadOnly(item))) throw verifyFailed();
          return { result: 'ok', address: next, steps, recovery: [], warnings: [...warnings, ...folderWarnings()], detail: { steps }, notices: renameNotices };
        } catch (error) {
          if (!renamed && netCopy) {
            try {
              const currentBoxes = await rows(session, 'mailbox/all');
              if (currentBoxes.some(row => normalize(row.username) === old) && !currentBoxes.some(row => normalize(row.username) === next)) {
                await lock.run(next, async () => {
                  const current = await netState(next);
                  if (isDeepStrictEqual(current, netCopy)) {
                    await audit.run({ actor, ip, action: 'mailbox.rename.protocol-netlimit.restore', target: next, kind: 'irreversible', revertible: false,
                      before: current, after: plan.state.netlimitTarget }, async () => {
                      if (plan.state.netlimitTarget.version === null) await protocolNetlimit.remove({ email: next, expected: current });
                      else await protocolNetlimit.write({ email: next, enabled: plan.state.netlimitTarget.enabled, version: plan.state.netlimitTarget.version, expected: current });
                    });
                  } else if (!isDeepStrictEqual(current, plan.state.netlimitTarget)) assertUnchanged('conflict', {});
                });
                throw error;
              }
              renamed = true; // Keep the target restriction if the rename applied or cannot be disproved.
            } catch (recoveryError) {
              if (recoveryError === error) throw error;
              stage = 'protocol-netlimit';
              steps.push({ stage, status: 'failed', code: safeCode(recoveryError), recovery: recovery.find(item => item.stage === stage).message });
              return { result: 'partial', address: next, steps, recovery, warnings, detail: { steps, recovery }, notices: renameNotices };
            }
          }
          if (!renamed) throw error;
          if (error instanceof MailcowAuthLost) fatal = error;
          const instruction = recovery.find(item => item.stage === stage)?.message ?? '새 주소의 연결을 미리보기 목록과 대조하고 남은 설정을 mailcow에서 직접 고쳐 주세요.';
          steps.push({ stage, status: 'failed', code: safeCode(error), auditId: null, recovery: instruction });
          return { result: 'partial', address: next, steps, recovery, warnings: [...warnings, ...folderWarnings()], detail: { steps, recovery, warnings: [...warnings, ...folderWarnings()] }, notices: renameNotices };
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
    const retiredState = direction === 'mailbox-to-alias' ? await assertMovable(addr) : (await assertReusable(addr), await retirementState(addr));
    const netlimit = await netState(addr);
    await domainActive(session, addr.split('@')[1]);
    const internal = new Set(boxes.filter(row => String(row.active) === '1').map(row => normalize(row.username)));
    const destinations = direction === 'mailbox-to-alias' ? options.targets : [options.copyTo, options.sendGrantTo].filter(Boolean);
    if (destinations.some(destination => destination === addr || !internal.has(destination))) throw invalid();
    await retirement?.routing.assertMutation(session, { kind: 'mailbox', address: addr, after: direction === 'mailbox-to-alias' ? null : { username: addr, active: 1 } });
    if (direction === 'mailbox-to-alias') await retirement?.routing.assertMutation(session, { kind: 'alias', address: addr, after: { address: addr, goto: options.targets.join(','), active: 1 } });
    const senders = boxes.filter(row => normalize(row.username) !== addr && (targets(row.sender_acl).includes(addr) || normalize(row.username) === options.sendGrantTo)).sort((a, b) => normalize(a.username).localeCompare(normalize(b.username)));
    const senderVersions = senders.map(row => ({ address: normalize(row.username), sha256: etag(row.sender_acl) }));
    const senderRestore = senders.filter(row => targets(row.sender_acl).includes(addr));
    if (direction === 'alias-to-mailbox') {
      if (boxes.some(row => normalize(row.username) === addr)) throw new AppError(409, 'ADDRESS_IN_USE', '이미 메일함이 있는 주소예요.');
      const alias = aliases.find(row => normalize(row.address) === addr);
      if (!alias) throw new AppError(404, 'NOT_FOUND', '전환할 별칭을 찾을 수 없어요.');
      if (isMemberAlias(alias)) throw new AppError(409, 'TEAM_MEMBER_ALIAS', '팀 분배 화면에서 바꿔 주세요.');
      const ownFilters = filters.filter(row => normalize(row.username) === addr);
      return { state: { direction, addr, options, retiredState, netlimit, alias: etag(alias), senders: senderVersions,
        destinations: boxes.filter(row => destinations.includes(normalize(row.username))).map(snapshot).sort((a, b) => a.address.localeCompare(b.address)),
        filters: ownFilters.map(row => ({ id: row.id, sha256: scriptHash(row.script_data) })) },
        alias, ownFilters, senders, senderRestore, warnings: [gapWarning, ...folderWarnings()], changes: { alias: aliasBackup(alias),
          mailbox: { address: addr, name: addr.split('@')[0], kind: options.kind, quotaGb: options.quotaGb }, copyTo: options.copyTo, sendGrantTo: options.sendGrantTo,
          senderRestore: senderRestore.map(row => ({ mailbox: normalize(row.username), senderAcl: snapshot(row).senderAcl })) } };
    }
    if (prefilters(filters, addr).some(filter => memberAliases(filter, aliases).length)) throw new AppError(409, 'TEAM_ALIAS_MODE', '팀 분배를 먼저 원래 방식으로 되돌려 주세요.');
    const mailbox = await box(session, addr);
    if (mailbox.active === 0 || mailbox.active === '0') throw inactiveMailbox();
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
    const aclByOwner = new Map(), ownerSnapshot = new Map(), info = await detail(session, addr, { allShares: true, includeProtocolNetlimit: false, aclSnapshot: aclByOwner, ownerSnapshot });
    if (info.warnings.some(row => row.code === 'SHARES_PARTIAL')) throw new AppError(502, 'SHARES_UNAVAILABLE', '공유를 모두 확인하지 못했어요. 다시 시도해 주세요.');
    const shares = relatedShares(aclByOwner, addr);
    if (shares.some(row => !aclReadOnly(row))) throw new AppError(409, 'ACL_UNSUPPORTED', '관련 공유에 읽기 외 권한이 있어요. 공유를 먼저 확인해 주세요.');
    const ownFilters = filters.filter(row => normalize(row.username) === addr).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const references = aliases.filter(row => targets(row.goto).includes(addr)).sort((a, b) => normalize(a.address).localeCompare(normalize(b.address)));
    const jobs = (await rows(session, 'syncjobs/all/no_log')).filter(row => normalize(row.user2) === addr).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const warnings = [gapWarning,
      { code: 'SENDER_ADDRESS_RETAINED', message: '이 주소로 보내기 권한을 가진 사람은 계속 이 주소로 보낼 수 있어요(별칭이 됨).' },
      { code: 'OWN_SENDER_RIGHTS_REMOVED', message: `이 메일함이 다른 주소로 보내던 권한 ${snapshot(mailbox).senderAcl.length}개는 없어져요` },
      { code: 'OWN_SHARES_REMOVED', message: `이 메일함을 다른 사람에게 공유한 ${shares.filter(row => row.owner === addr).length}건은 없어져요` },
      { code: 'INCOMING_SHARES_UNUSED', message: `다른 함에서 이 주소에 준 공유 ${shares.filter(row => row.owner !== addr).length}건은 남지만 로그인할 수 없어 쓰이지 않아요` },
      ...info.warnings,
    ];
    const state = { direction, addr, options, retiredState, netlimit, shareOwners: ownerVersions(ownerSnapshot), account: snapshot(mailbox), aliases: references.map(row => ({ address: normalize(row.address), sha256: etag(row) })),
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
        const netlimitRecovery = { stage: 'protocol-netlimit', message: '계정 변경은 적용됐지만 제한 설정 정리를 완료하지 못했어요. 현재 상태를 다시 확인해 주세요.' };
        const recovery = direction === 'mailbox-to-alias' ? [netlimitRecovery,
          { stage: 'syncjobs', message: '이미 지운 동기화는 변경 기록의 작업 번호를 확인하고 필요하면 새로 만들어 주세요. 원본 암호는 다시 입력해야 해요.' },
          { stage: 'filters', message: '이미 지운 필터는 변경 기록의 원문 백업을 확인하고 필요하면 mailcow에서 다시 만들어 주세요.' },
          { stage: 'mailbox', message: '메일함이 남아 있는지 확인해 주세요. 새 메일은 옮기거나 지운 뒤 전환해야 해요.' },
          { stage: 'alias', message: `${addr} 별칭을 ${options.targets.join(', ')} 대상으로 만들어 메일 수신을 복구해 주세요.` },
          { stage: 'references', message: '대상 메일함의 원래 보내기 권한과 변경 기록의 원래 goto·활성 상태·공개 여부·보내기 권한·설명을 보고 참조 별칭을 다시 붙여 주세요.' },
          { stage: 'senders', message: '변경 기록의 원래 목록을 보고 다른 사람의 보내기 권한을 복원해 주세요.' },
        ] : [netlimitRecovery,
          { stage: 'alias', message: '변경 기록의 원래 별칭 대상과 설정을 확인해 주세요. 메일함을 만들지 못했다면 같은 주소의 별칭을 다시 만들 수 있어요.' },
          { stage: 'mailbox', message: '별칭과 메일함은 같은 주소에 함께 있을 수 없어요. 변경 기록을 보고 별칭을 복원하거나 초기 암호를 정해 메일함을 만들어 주세요.' },
          { stage: 'copy', message: 'mailcow에서 내부 대상으로 redirect :copy 사전 필터를 만들어 주세요.' },
          { stage: 'senders', message: '변경 기록의 원래 목록을 보고 다른 사람의 보내기 권한을 복원해 주세요.' },
          { stage: 'grant', message: '권한 화면에서 요청자의 보내기 권한 목록에 새 메일함 주소를 추가해 주세요.' },
        ];
        const mutate = async (path, body) => {
          if (path === '/api/v1/add/alias') await retirement?.routing.assertMutation(session, { kind: 'alias', address: body.address, after: body });
          if (path === '/api/v1/add/mailbox') await retirement?.routing.assertMutation(session, { kind: 'mailbox', address: `${body.local_part}@${body.domain}`, after: { username: `${body.local_part}@${body.domain}`, active: body.active } });
          if (['/api/v1/delete/alias', '/api/v1/edit/alias'].includes(path) && retirement) for (const id of body.items ?? body) {
            const alias = (await rows(session, 'alias/all')).find(row => String(row.id) === String(id));
            if (alias) await retirement.routing.assertMutation(session, { kind: 'alias', address: alias.address, after: path === '/api/v1/delete/alias' ? null : { ...alias, ...body.attr } });
          }
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
              stage = 'retirement';
              await cleanupRetirement(addr, plan.state.retiredState);
              stage = 'protocol-netlimit';
              await lock.run(addr, () => cleanupNetlimit({ actor, ip, addr, expected: plan.state.netlimit }));
              if (plan.state.netlimit.version !== null) steps.push({ stage, target: addr, status: 'ok' });
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
              stage = 'protocol-netlimit';
              await lock.run(addr, () => cleanupNetlimit({ actor, ip, addr, expected: plan.state.netlimit }));
              if (plan.state.netlimit.version !== null) steps.push({ stage, target: addr, status: 'ok' });
              await lock.run(addr, () => step('mailbox', addr, {}, { address: addr, quotaGb: options.quotaGb, password: 'set' }, async () => {
                if ((await rows(session, 'alias/all')).some(row => normalize(row.address) === addr) || (await rows(session, 'mailbox/all')).some(row => normalize(row.username) === addr)) throw new AppError(409, 'ADDRESS_IN_USE', '주소가 이미 사용 중이에요.');
                const body = { local_part: addr.split('@')[0], domain: addr.split('@')[1], name: addr.split('@')[0], quota: String(options.quotaGb * 1024), active: '1',
                  force_pw_update: '0', tls_enforce_in: '1', tls_enforce_out: '1', password: password.toString(), password2: password.toString() };
                try { await mutate('/api/v1/add/mailbox', body); mailboxCreated = true; } finally { delete body.password; delete body.password2; }
                const checked = snapshot(await box(session, addr));
                if (checked.address !== addr || checked.name !== addr.split('@')[0] || checked.quotaGb !== options.quotaGb || checked.active !== 1) throw verifyFailed();
                const disabled = protocols.filter(key => !checked.protocols[key]);
                if (disabled.length) {
                  const index = warnings.findIndex(warning => warning.code === 'SUBFOLDER_ACL_UNCHECKED');
                  warnings.splice(index < 0 ? warnings.length : index, 0, { code: 'PROTOCOL_DEFAULT_OFF', protocols: disabled });
                }
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
  return { list, quotaList, detail, create: args => routingLock(() => create(args)), edit: args => routingLock(() => edit(args)), deletePreview,
    remove: args => routingLock(() => lifecycleRun(args)), leave: args => args.data?.action === 'preview' ? leave(args) : routingLock(() => leave(args)),
    rename: args => args.data?.action === 'preview' ? rename(args) : routingLock(() => rename(args)),
    convert: args => args.data?.action === 'preview' ? convert(args) : routingLock(() => convert(args)), retirementPreview, retirementUpdate };
}
