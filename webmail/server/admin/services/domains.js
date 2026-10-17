import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import { etag, assertUnchanged } from '../lock.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', '도메인과 입력값을 확인해 주세요.');
const missing = () => new AppError(404, 'NOT_FOUND', '도메인을 찾을 수 없어요.');
const conflict = () => new AppError(409, 'DOMAIN_EXISTS', '이미 사용 중인 도메인이에요.');
const verify = () => new AppError(502, 'WRITE_VERIFY_FAILED', '저장한 값이 예상과 달라요. 다시 확인해 주세요.');
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
function domain(value) {
  const name = normalize(value);
  if (name.length > 253 || !name.includes('.') || !name.split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(part))) throw invalid();
  return name;
}
function input(data, keys) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key))) throw invalid();
}
const defaults = { mailboxes: '100', aliases: '400', defquota: '20480', maxquota: '51200', quota: '1048576', relay_all_recipients: '0', backupmx: '0' };
const temporaryWarning = '임시 별칭은 되돌려도 돌아오지 않음';
const aliasState = row => row ? { aliasDomain: domain(row.alias_domain), targetDomain: domain(row.target_domain), active: String(row.active) === '1' } : null;

export function dnsRecords(name, serverIp, dkim) {
  const ip = serverIp || '서버 공인 IP 를 넣어 주세요';
  const selector = dkim.selector || 'dkim';
  return [
    ...['mail', 'mailcow', 'mail-npm', 'autodiscover'].map(prefix => ({ name: `${prefix}.${name}`, type: 'A', value: ip })),
    { name: `autoconfig.${name}`, type: 'CNAME', value: `mail.${name}` },
    { name, type: 'MX', value: `10 mail.${name}` },
    { name, type: 'TXT', value: 'v=spf1 mx a -all' },
    { name: `_dmarc.${name}`, type: 'TXT', value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${name}` },
    { name: `${selector}._domainkey.${name}`, type: 'TXT', value: dkim.publicKey ? `v=DKIM1; k=rsa; t=s; p=${dkim.publicKey}` : '(generate DKIM key first)' },
  ];
}

export function createDomainsService({ mailcow, audit, lock, history }) {
  async function rows(session, path) {
    const value = await mailcow.call(session, 'GET', `/api/v1/get/${path}`);
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && !Object.keys(value).length) return [];
    throw new AppError(502, 'MAILCOW_REJECTED', '도메인 정보를 읽을 수 없어요.');
  }
  async function context(session) {
    const [primary, aliases, mailboxes, addresses] = await Promise.all(['domain/all', 'alias-domain/all', 'mailbox/all', 'alias/all'].map(path => rows(session, path)));
    return { primary, aliases, mailboxes, addresses };
  }
  const primaryName = row => normalize(row.domain_name ?? row.domain);
  function state(name, data) {
    const row = data.primary.find(item => primaryName(item) === name);
    if (!row) return null;
    const affected = new Set([name, ...data.aliases.filter(item => normalize(item.target_domain) === name).map(item => normalize(item.alias_domain))]);
    return { domain: name, active: String(row.active) === '1',
      mailboxes: data.mailboxes.filter(item => normalize(item.username).split('@')[1] === name).length,
      aliases: data.addresses.filter(item => affected.has(normalize(item.address).split('@')[1])).length };
  }
  const read = async (session, name) => state(name, await context(session));
  async function readAlias(session, name) {
    const [aliases, addresses, bcc] = await Promise.all(['alias-domain/all', 'alias/all', 'bcc/all'].map(path => rows(session, path)));
    return { alias: aliasState(aliases.find(row => normalize(row.alias_domain) === name)),
      aliases: addresses.filter(row => normalize(row.address).split('@')[1] === name).map(row => ({ address: normalize(row.address), goto: String(row.goto ?? ''), active: String(row.active) })).sort((a, b) => a.address.localeCompare(b.address)),
      bcc: bcc.filter(row => normalize(row.local_dest) === name).map(row => ({ id: String(row.id), local_dest: name, bcc_dest: String(row.bcc_dest ?? ''), type: String(row.type ?? ''), active: String(row.active) })).sort((a, b) => a.id.localeCompare(b.id)) };
  }
  function unused(value) {
    if (value.aliases.length || value.bcc.length) {
      const error = new AppError(409, 'ALIAS_DOMAIN_IN_USE', '개별 별칭과 BCC를 먼저 지워 주세요.');
      error.details = { aliases: value.aliases, bcc: value.bcc }; throw error;
    }
  }
  async function applyActive(session, name, before, after) {
    assertUnchanged(etag(before), await read(session, name));
    await mailcow.call(session, 'POST', '/api/v1/edit/domain', { items: [name], attr: { active: after.active ? '1' : '0' } });
    if (!isDeepStrictEqual(await read(session, name), after)) throw verify();
  }
  async function list(session) {
    const data = await context(session);
    return { items: data.primary.map(row => { const value = state(primaryName(row), data); return { ...value, etag: etag(value) }; }) };
  }
  async function create({ session, actor, ip, data }) {
    input(data, ['domain', 'description', ...Object.keys(defaults)]);
    const name = domain(data.domain), body = { ...defaults, ...data, domain: name, description: data.description ?? name, active: '1' };
    if (typeof body.description !== 'string' || body.description.length > 255) throw invalid();
    if (!body.description) body.description = name;
    for (const key of ['mailboxes', 'aliases', 'defquota', 'maxquota', 'quota']) {
      if (!/^\d+$/.test(String(body[key])) || !Number.isSafeInteger(Number(body[key])) || Number(body[key]) < 1) throw invalid();
      body[key] = String(Number(body[key]));
    }
    for (const key of ['relay_all_recipients', 'backupmx']) {
      if (!['0', '1'].includes(String(body[key]))) throw invalid(); body[key] = String(body[key]);
    }
    if (+body.defquota > +body.maxquota || +body.maxquota > +body.quota) throw invalid();
    if (body.relay_all_recipients === '1') body.backupmx = '1';
    return lock.run(name, async () => {
      const current = await context(session);
      if (current.primary.some(row => primaryName(row) === name) || current.aliases.some(row => normalize(row.alias_domain) === name)) throw conflict();
      return audit.run({ actor, ip, action: 'domain.create', target: name, kind: 'config', revertible: false, before: null, after: body }, async intent => {
        const latest = await context(session);
        if (latest.primary.some(row => primaryName(row) === name) || latest.aliases.some(row => normalize(row.alias_domain) === name)) throw conflict();
        await mailcow.call(session, 'POST', '/api/v1/add/domain', body);
        const row = (await rows(session, 'domain/all')).find(item => primaryName(item) === name);
        const expected = { description: body.description, max_num_mboxes_for_domain: +body.mailboxes, max_num_aliases_for_domain: +body.aliases,
          def_quota_for_mbox: +body.defquota * 1048576, max_quota_for_mbox: +body.maxquota * 1048576, max_quota_for_domain: +body.quota * 1048576,
          active: 1, relay_all_recipients: +body.relay_all_recipients, backupmx: +body.backupmx };
        if (!row || Object.entries(expected).some(([key, value]) => typeof value === 'number' ? Number(row[key]) !== value : row[key] !== value)) throw verify();
        const applied = await read(session, name); return { ...applied, etag: etag(applied), auditId: intent.id };
      });
    });
  }
  async function edit({ session, actor, ip, name: rawName, data }) {
    input(data, ['action', 'etag', 'active', 'confirmDomain']);
    if (!['preview', 'run'].includes(data.action) || typeof data.active !== 'boolean') throw invalid();
    const name = domain(rawName);
    return lock.run(name, async () => {
      const before = await read(session, name); if (!before) throw missing();
      if (data.action === 'preview') return { ...before, desiredActive: data.active, etag: etag(before), confirmDomain: name, warning: '도메인을 끄면 이 도메인과 별칭 도메인으로 받는 별칭 메일이 모두 거부됩니다.' };
      assertUnchanged(data.etag, before);
      if (!data.active && data.confirmDomain !== name) throw invalid();
      if (before.active === data.active) return { ...before, etag: etag(before), unchanged: true };
      const after = { ...before, active: data.active };
      return audit.run({ actor, ip, action: 'domain.active', target: name, kind: 'config', revertible: true, before, after }, async intent => {
        await applyActive(session, name, before, after); return { ...after, etag: etag(after), auditId: intent.id };
      });
    });
  }
  async function listAliases(session) {
    const values = await rows(session, 'alias-domain/all');
    return { items: await Promise.all(values.map(async row => { const value = await readAlias(session, normalize(row.alias_domain)); return { ...value.alias, dependencies: { aliases: value.aliases, bcc: value.bcc }, etag: etag(value), warning: temporaryWarning }; })) };
  }
  async function applyAlias(session, name, before, after) {
    assertUnchanged(etag(before), await readAlias(session, name));
    if (after.alias) {
      const data = await context(session);
      if (!data.primary.some(row => primaryName(row) === after.alias.targetDomain && String(row.backupmx) !== '1')) throw new AppError(409, 'INVALID_TARGET_DOMAIN', '기본 도메인이 없거나 전달용 도메인이에요.');
      if (data.primary.some(row => primaryName(row) === name)) throw conflict();
      assertUnchanged(etag(before), await readAlias(session, name));
      await mailcow.call(session, 'POST', '/api/v1/add/alias-domain', { alias_domain: name, target_domain: after.alias.targetDomain, active: after.alias.active ? '1' : '0' });
    } else {
      unused(before);
      await mailcow.call(session, 'POST', '/api/v1/delete/alias-domain', [name]);
    }
    if (!isDeepStrictEqual(await readAlias(session, name), after)) throw verify();
  }
  async function changeAlias({ session, actor, ip, name: rawName, data, remove = false }) {
    input(data, remove ? ['etag', 'confirmDomain'] : ['aliasDomain', 'targetDomain']);
    const name = domain(rawName ?? data.aliasDomain);
    return lock.run(name, async () => {
      const before = await readAlias(session, name);
      if (remove && !before.alias) throw missing(); if (!remove && before.alias) throw conflict();
      if (remove) { assertUnchanged(data.etag, before); if (data.confirmDomain !== name) throw invalid(); unused(before); }
      const after = { ...before, alias: remove ? null : { aliasDomain: name, targetDomain: domain(data.targetDomain), active: true } };
      if (after.alias?.targetDomain === name) throw invalid();
      return audit.run({ actor, ip, action: remove ? 'alias-domain.delete' : 'alias-domain.create', target: name, kind: 'config', revertible: true, before, after }, async intent => {
        await applyAlias(session, name, before, after); return { ...(after.alias ?? { aliasDomain: name, deleted: true }), etag: etag(after), auditId: intent.id, warning: temporaryWarning, detail: { warning: temporaryWarning } };
      });
    });
  }
  // Keep upstream responses local: only these three primitive public fields may leave this function.
  async function publicDkim(session, name) {
    const row = await mailcow.call(session, 'GET', `/api/v1/get/dkim/${name}`);
    if (row && typeof row === 'object' && !Object.keys(row).length) return { selector: null, publicKey: null, length: null };
    if (!row || typeof row.pubkey !== 'string' || typeof row.dkim_selector !== 'string' || !['string', 'number'].includes(typeof row.length)) throw new AppError(502, 'MAILCOW_REJECTED', 'DKIM 공개 정보를 읽을 수 없어요.');
    return { selector: row.dkim_selector, publicKey: row.pubkey, length: String(row.length) };
  }
  async function dns(session, { serverIp = '' } = {}) {
    if (typeof serverIp !== 'string' || serverIp && isIP(serverIp) !== 4) throw invalid();
    const primary = await rows(session, 'domain/all');
    const items = [];
    for (const row of primary) {
      const name = domain(primaryName(row)), dkim = await publicDkim(session, name);
      items.push({ domain: name, records: dnsRecords(name, serverIp, dkim), ptr: { optional: true, address: serverIp || '서버 공인 IP 를 넣어 주세요', value: `mail.${name}` } });
    }
    return { items };
  }
  function destinationNames(value) {
    if (!Array.isArray(value) || !value.length || value.length > 100) throw invalid();
    return [...new Set(value.map(domain))].sort();
  }
  async function bundle(session, from, to) {
    const primary = await rows(session, 'domain/all'), aliases = await rows(session, 'alias-domain/all');
    const known = new Set([...primary.map(primaryName), ...aliases.map(row => normalize(row.alias_domain))]);
    const names = [...new Set([from, ...to])].sort();
    if (names.some(name => !known.has(name))) throw missing();
    return Promise.all(names.map(async name => ({ domain: name, ...await publicDkim(session, name) })));
  }
  async function dkim(session, rawName, { toDomains } = {}) {
    const name = domain(rawName);
    if (toDomains !== undefined && typeof toDomains !== 'string') throw invalid();
    const to = toDomains === undefined ? [] : destinationNames(toDomains.split(','));
    if (to.includes(name)) throw invalid();
    const values = await bundle(session, name, to), source = values.find(row => row.domain === name);
    if (!source.publicKey) throw missing();
    return { ...source, etag: etag(values), ...(toDomains === undefined ? {} : { targets: values.filter(row => row.domain !== name) }) };
  }
  async function duplicate({ session, actor, ip, data }) {
    input(data, ['fromDomain', 'toDomains', 'etag', 'overwrite']);
    const from = domain(data.fromDomain), to = destinationNames(data.toDomains);
    if (to.includes(from) || data.overwrite !== undefined && typeof data.overwrite !== 'boolean') throw invalid();
    const names = [from, ...to].sort();
    const locked = (index, operation) => index === names.length ? operation() : lock.run(names[index], () => locked(index + 1, operation));
    return locked(0, async () => {
      const before = await bundle(session, from, to); assertUnchanged(data.etag, before);
      const source = before.find(row => row.domain === from); if (!source.publicKey) throw missing();
      const existing = before.filter(row => row.domain !== from && row.publicKey).map(row => row.domain);
      if (existing.length && data.overwrite !== true) {
        const error = new AppError(409, 'DKIM_EXISTS', '이미 DKIM 키가 있는 도메인이에요. 덮어쓰기를 확인해 주세요.'); error.details = { domains: existing }; throw error;
      }
      const after = before.map(row => row.domain === from ? row : { ...source, domain: row.domain });
      // Private keys are never backed up; only safe public metadata and fingerprints enter the audit.
      const safeAudit = values => values.map(row => ({ domain: row.domain, selector: row.selector, length: row.length, publicFingerprint: row.publicKey === null ? null : etag(row.publicKey) }));
      return audit.run({ actor, ip, action: 'dkim.duplicate', target: from, kind: existing.length ? 'irreversible' : 'config', revertible: false, before: safeAudit(before), after: safeAudit(after) }, async intent => {
        assertUnchanged(etag(before), await bundle(session, from, to));
        await mailcow.call(session, 'POST', '/api/v1/add/dkim_duplicate', { from_domain: from, to_domain: to });
        const applied = await bundle(session, from, to); if (!isDeepStrictEqual(applied, after)) throw verify();
        return { fromDomain: from, toDomains: to, auditId: intent.id, etag: etag(applied), detail: { warning: '개인키를 보관하지 않아 이 변경은 되돌릴 수 없습니다.' } };
      });
    });
  }
  history.register('domain.active', { label: '도메인 사용 상태를 바꿨어요', read: ({ session, target }) => read(session, target), write: ({ session, target, expected, value }) => applyActive(session, target, expected, value) });
  for (const action of ['alias-domain.create', 'alias-domain.delete']) history.register(action, {
    label: '별칭 도메인을 바꿨어요', read: ({ session, target }) => readAlias(session, target),
    write: ({ session, target, expected, value }) => applyAlias(session, target, expected, value),
  });
  return { list, create, edit, listAliases, createAlias: args => changeAlias(args), removeAlias: args => changeAlias({ ...args, remove: true }), dkim, duplicate, dns };
}
