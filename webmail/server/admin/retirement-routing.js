import { AppError } from '../errors.js';
import { createHash } from 'node:crypto';
import { retirementAddress } from '../security/retirement-store.js';
import { retirementRedirects } from '../sieve/redirect-targets.js';
import { analyze, removeMember, Refused } from './sieve-team.js';
import { etag } from './lock.js';
import { MailcowAuthLost } from './mailcow-client.js';

const unavailable = () => new AppError(503, 'RETIREMENT_ROUTING_UNAVAILABLE', '수신 경로를 모두 확인할 수 없어요. 다시 시도해 주세요.');
const refused = () => new AppError(409, 'RETIREMENT_ROUTES_REMAIN', '먼저 전달 연결과 확인이 필요한 필터를 정리해 주세요.');
const enabled = value => [1, 2, '1', '2'].includes(value);
const unique = values => [...new Set(values)].sort();
const sourceHash = source => createHash('sha256').update(source, 'utf8').digest('hex');
const domain = value => retirementAddress(`check@${value}`).split('@')[1];
const destinations = value => unique((Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/) : []).map(retirementAddress));
const only = (result, owner) => !result.problems.length && result.targets.length === 1 && result.targets[0] === owner;
const issue = (code, address, extra = {}) => ({ code, address, ...extra });
const compact = rows => [...new Map(rows.map(row => [JSON.stringify(row), row])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

// Matches the known mailbox/alias/alias-domain/catch-all routing model only.
// Unknown internal destinations are never treated as harmless external leaves.
export function createRetirementGraph({ mailboxes, aliases, aliasDomains, domains }) {
  if (![mailboxes, aliases, aliasDomains, domains].every(Array.isArray)) throw unavailable();
  const boxes = new Map(), nodes = new Map(), mappedDomains = new Map(), internal = new Set();
  try {
    for (const row of domains) internal.add(domain(row.domain_name ?? row.domain));
    for (const row of mailboxes) {
      const address = retirementAddress(row.username);
      if (![0, 1, 2, '0', '1', '2'].includes(row.active) || boxes.has(address)) throw unavailable();
      boxes.set(address, { address, active: Number(row.active) }); internal.add(address.split('@')[1]);
    }
    for (const row of aliasDomains) {
      const alias = domain(row.alias_domain), target = domain(row.target_domain); internal.add(alias); internal.add(target);
      if (![0, 1, '0', '1'].includes(row.active)) throw unavailable();
      if (String(row.active) === '1') { if (mappedDomains.has(alias)) throw unavailable(); mappedDomains.set(alias, target); }
    }
    for (const row of aliases) {
      if (![0, 1, 2, '0', '1', '2'].includes(row.active)) throw unavailable();
      if (!enabled(row.active)) continue;
      const address = typeof row.address === 'string' && row.address.startsWith('@') ? '@' + domain(row.address.slice(1)) : retirementAddress(row.address);
      if (nodes.has(address)) throw unavailable();
      const targets = destinations(row.goto); if (!targets.length) throw unavailable();
      nodes.set(address, { address, targets, memberAlias: row.private_comment === 'mailadmin:team-members', version: etag(row) });
      internal.add(address.split('@')[1]);
    }
  } catch { throw unavailable(); }
  const memo = new Map();
  function resolveNode(address, trail) {
    if (address === 'null@localhost') return { targets: [], problems: [], depth: 0 };
    if (trail.has(address)) return { targets: [], problems: [issue('ALIAS_LOOP', address)], depth: 0 };
    if (memo.has(address)) return memo.get(address);
    const node = nodes.get(address);
    if (node) {
      const next = new Set(trail); next.add(address);
      const branches = node.targets.map(target => target === address && enabled(boxes.get(address)?.active) ? { targets: [target], problems: [], depth: 0 } : resolveNode(target, next));
      const result = { targets: unique(branches.flatMap(row => row.targets)), problems: compact(branches.flatMap(row => row.problems)), depth: 1 + Math.max(...branches.map(row => row.depth)) };
      memo.set(address, result); return result;
    }
    if (enabled(boxes.get(address)?.active)) return { targets: [address], problems: [], depth: 0 };
    const [local, name] = address.split('@'), primary = mappedDomains.get(name);
    if (primary && enabled(boxes.get(`${local}@${primary}`)?.active)) return resolveNode(`${local}@${primary}`, trail);
    if (local.includes('+') && local.split('+')[0]) return resolveNode(`${local.split('+')[0]}@${name}`, trail);
    if (nodes.has(`@${name}`)) return resolveNode(`@${name}`, trail);
    return internal.has(name) ? { targets: [], problems: [issue('UNRESOLVED_INTERNAL', address)], depth: 0 } : { targets: [address], problems: [], depth: 0 };
  }
  return { boxes, nodes, mappedDomains, resolve: address => resolveNode(retirementAddress(address), new Set()),
    resolveAlias: address => resolveNode(address, new Set()),
    fingerprint: etag({ boxes: [...boxes].sort(([a], [b]) => a.localeCompare(b)), nodes: [...nodes].sort(([a], [b]) => a.localeCompare(b)),
      domains: [...mappedDomains].sort(([a], [b]) => a.localeCompare(b)), internal: [...internal].sort() }) };
}

function aliasPlan(facts, graph, owner) {
  const keys = [owner], changes = [], blockers = [];
  for (const node of graph.nodes.values()) {
    const result = graph.resolveAlias(node.address);
    if (only(result, owner)) {
      if (node.address.startsWith('@')) blockers.push(issue('CATCH_ALL_TARGET', node.address));
      else keys.push(node.address);
    } else if (result.targets.includes(owner)) {
      if (node.address === owner) { blockers.push(issue('CANONICAL_ROUTE_CONFLICT', owner)); continue; }
      const remove = node.targets.filter(target => only(graph.resolve(target), owner)), keep = node.targets.filter(target => !remove.includes(target));
      if (remove.length && keep.length) changes.push({ kind: node.memberAlias ? 'team-member-alias' : 'alias', address: node.address, remove, keep, version: node.version, depth: result.depth });
    }
  }
  const [local, primary] = owner.split('@');
  for (const [alias, target] of graph.mappedDomains) if (target === primary) keys.push(`${local}@${alias}`);
  const projectedFacts = { ...facts, aliases: facts.aliases.map(row => {
    const address = String(row.address).trim().toLowerCase(), change = changes.find(item => item.address === address);
    return change ? { ...row, goto: change.keep.join(',') } : row;
  }) };
  const projected = createRetirementGraph(projectedFacts), normalizedKeys = unique(keys);
  // Classify unresolved literals after all rejection keys have been collected.
  const matchesRecipientKey = value => {
    const [local, name] = value.split('@');
    return normalizedKeys.includes(value) || local.includes('+') && normalizedKeys.includes(`${local.split('+')[0]}@${name}`);
  };
  for (const node of graph.nodes.values()) {
    const result = graph.resolveAlias(node.address);
    blockers.push(...result.problems.filter(problem => problem.code !== 'UNRESOLVED_INTERNAL' || result.targets.includes(owner) ||
      [problem.address, ...node.targets].some(matchesRecipientKey)));
  }
  for (const key of normalizedKeys) if (!only(projected.resolve(key), owner)) blockers.push(issue('RECIPIENT_KEY_CONFLICT', key));
  // An explicit tagged alias cannot override the base-address access rejection.
  for (const address of unique([...projected.nodes.keys(), ...[...projected.boxes.values()].filter(row => enabled(row.active)).map(row => row.address)])) {
    if (address.startsWith('@')) continue;
    const [part, name] = address.split('@');
    if (part.includes('+') && normalizedKeys.includes(`${part.split('+')[0]}@${name}`) && !only(projected.resolve(address), owner)) blockers.push(issue('PLUS_ADDRESS_CONFLICT', address));
  }
  changes.sort((a, b) => a.depth - b.depth || a.address.localeCompare(b.address));
  return { keys: normalizedKeys, aliasChanges: changes, blockers, projected };
}

export function createRetirementRouting({ mailcow, dockerapi, store }) {
  async function get(session, path) { return mailcow.call(session, 'GET', `/api/v1/get/${path}`); }
  async function rows(session, path) {
    const value = await get(session, path);
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && !Object.keys(value).length) return [];
    throw unavailable();
  }
  async function inspect(session, rawOwner) {
    const owner = retirementAddress(rawOwner);
    const [mailboxes, aliases, aliasDomains, domains, filters, global] = await Promise.all([
      rows(session, 'mailbox/all'), rows(session, 'alias/all'), rows(session, 'alias-domain/all'), rows(session, 'domain/all'), rows(session, 'filters/all'), get(session, 'global_filters/all'),
    ]);
    const facts = { mailboxes, aliases, aliasDomains, domains }, graph = createRetirementGraph(facts);
    if (!graph.boxes.has(owner)) throw new AppError(404, 'NOT_FOUND', '메일함을 찾을 수 없어요.');
    const accountActive = graph.boxes.get(owner).active;
    if (!enabled(accountActive)) throw new AppError(409, 'RETIREMENT_STATE_CONFLICT', '퇴사 계정의 현재 상태를 먼저 확인해 주세요.');
    if (!global || typeof global !== 'object' || Array.isArray(global) || ['prefilter','postfilter'].some(key => global[key] !== undefined && typeof global[key] !== 'string')) throw unavailable();
    const plan = aliasPlan(facts, graph, owner), blockers = plan.blockers, teamChanges = [], versions = [], inspected = [];
    const active = new Set([...graph.boxes.values()].filter(row => enabled(row.active)).map(row => row.address));
    const selected = [];
    for (const filter of filters) {
      let address;
      try { address = retirementAddress(filter.username); } catch { throw unavailable(); }
      if (![0, 1, '0', '1'].includes(filter.active) || !['prefilter','postfilter'].includes(filter.filter_type) || typeof filter.script_data !== 'string' || !/^\d+$/.test(String(filter.id))) throw unavailable();
      versions.push({ source: 'admin', address, id: String(filter.id), active: String(filter.active), type: filter.filter_type, hash: sourceHash(filter.script_data) });
      if (String(filter.active) === '1' && active.has(address)) selected.push({ ...filter, username: address });
    }
    const matchesRecipientKey = value => {
      const full = value.trim().toLowerCase(), [local, name] = full.split('@');
      return plan.keys.includes(full) || local.includes('+') && plan.keys.includes(`${local.split('+')[0]}@${name}`);
    };
    function examine(source, location, filter) {
      const hash = sourceHash(source); inspected.push({ ...location, hash });
      let redirects;
      try { redirects = retirementRedirects(source); }
      catch { blockers.push(issue('FILTER_UNINSPECTABLE', location.address, location)); return; }
      let resolved;
      try { resolved = redirects.map(redirect => ({ redirect, result: plan.projected.resolve(redirect.target) })); }
      catch { blockers.push(issue('FILTER_ROUTE_UNKNOWN', location.address, location)); return; }
      if (location.address === owner) {
        const outgoing = resolved.filter(row => row.result.targets.some(target => target !== owner) ||
          row.result.problems.some(problem => problem.code === 'UNRESOLVED_INTERNAL')).map(row => row.redirect);
        if (outgoing.length) {
          blockers.push(issue('OWNER_FORWARD_ACTIVE', owner, { ...location, targets: unique(outgoing.map(row => row.target)) })); return;
        }
      }
      const involved = [];
      for (const { redirect, result } of resolved) {
        if (result.problems.length) {
          if (result.problems.some(problem => problem.code !== 'UNRESOLVED_INTERNAL') ||
            [redirect.target, ...result.problems.map(problem => problem.address)].some(matchesRecipientKey)) {
            blockers.push(issue('FILTER_ROUTE_UNKNOWN', location.address, { ...location, target: redirect.target }));
          }
          continue;
        }
        if (result.targets.includes(owner)) involved.push(redirect);
      }
      if (!involved.length) return;
      if (!filter || filter.filter_type !== 'prefilter') {
        blockers.push(issue('FILTER_TARGET_REMAINS', location.address, { ...location, targets: unique(involved.map(row => row.target)) })); return;
      }
      const peers = selected.filter(row => row.username.toLowerCase() === location.address && row.filter_type === 'prefilter');
      const parsed = analyze(source);
      const bundles = parsed.members.map(member => graph.nodes.get(member.address.toLowerCase())).filter(node => node?.memberAlias);
      if (graph.boxes.get(location.address)?.active !== 1 || peers.length !== 1 || !parsed.parsed || bundles.length > 1 || parsed.stopperBeforeMember || !parsed.members.length) {
        blockers.push(issue('TEAM_UNEDITABLE', location.address, location)); return;
      }
      let next = source;
      const removals = [];
      for (const redirect of involved) {
        if (!redirect.copy || !parsed.members.some(member => member.address.toLowerCase() === redirect.target) || !only(plan.projected.resolve(redirect.target), owner)) {
          blockers.push(issue('TEAM_UNEDITABLE', location.address, { ...location, target: redirect.target })); continue;
        }
        try { next = removeMember(next, redirect.target).script; removals.push(redirect.target); }
        catch (error) { blockers.push(issue(error instanceof Refused && error.code === 'last_member' ? 'LAST_TEAM_MEMBER' : 'TEAM_UNEDITABLE', location.address, location)); }
      }
      if (removals.length && !retirementRedirects(next).some(row => plan.projected.resolve(row.target).targets.length)) {
        blockers.push(issue('LAST_TEAM_MEMBER', location.address, location)); return;
      }
      if (removals.length) teamChanges.push({ kind: 'team', address: location.address, filterId: String(filter.id), remove: unique(removals),
        etag: etag({ id: filter.id, source, ...(bundles[0] ? { goto: aliases.find(row => String(row.address).trim().toLowerCase() === bundles[0].address).goto } : {}) }), beforeHash: hash, afterHash: sourceHash(next) });
    }
    for (const change of plan.aliasChanges.filter(row => row.kind === 'team-member-alias')) {
      const refs = selected.filter(filter => filter.filter_type === 'prefilter' && analyze(filter.script_data).members.some(member => member.address.toLowerCase() === change.address));
      const originalAlias = aliases.find(row => enabled(row.active) && String(row.address).trim().toLowerCase() === change.address);
      if (refs.length !== 1 || graph.boxes.get(refs[0]?.username)?.active !== 1 || String(originalAlias?.active) !== '1' || change.keep.length === 0 ||
        selected.filter(row => row.username === refs[0]?.username && row.filter_type === 'prefilter').length !== 1) blockers.push(issue('TEAM_ALIAS_UNEDITABLE', change.address));
      else {
        const filter = refs[0], parsed = analyze(filter.script_data);
        if (parsed.stopperBeforeMember || !parsed.members.at(-1)?.simple) { blockers.push(issue('TEAM_ALIAS_UNEDITABLE', change.address)); continue; }
        change.team = filter.username.toLowerCase(); change.filterId = String(filter.id);
        change.etag = etag({ id: filter.id, source: filter.script_data, goto: originalAlias.goto });
      }
    }
    for (const filter of selected) examine(filter.script_data, { source: 'admin', address: filter.username.toLowerCase(), type: filter.filter_type, id: String(filter.id), order: filter.filter_type === 'prefilter' ? 2 : 4 }, filter);
    for (const type of ['prefilter','postfilter']) {
      const source = global[type] ?? ''; versions.push({ source: 'global', type, hash: sourceHash(source) });
      examine(source, { source: 'global', address: null, type, order: type === 'prefilter' ? 1 : 5 });
    }
    const addresses = [...active].sort(); let cursor = 0, checkedMailboxes = 0, fatal;
    async function worker() {
      while (cursor < addresses.length && !fatal) {
        const address = addresses[cursor++];
        try {
          const [payload, names] = await Promise.all([get(session, `active-user-sieve/${encodeURIComponent(address)}`), dockerapi.listSieve(address)]);
          const script = Array.isArray(payload) && payload.length === 1 && typeof payload[0] === 'string' ? payload[0] :
            payload && typeof payload === 'object' && !Object.keys(payload).length ? null : undefined;
          if (!Array.isArray(names) || names.some(row => typeof row?.name !== 'string' || typeof row.active !== 'boolean') || names.filter(row => row.active).length > 1 || script === undefined) throw unavailable();
          const activeName = names.find(row => row.active)?.name ?? null;
          versions.push({ source: 'user', address, activeName, hash: script === null ? null : sourceHash(script) });
          if (Boolean(activeName) !== (script !== null)) throw unavailable();
          checkedMailboxes++;
          if (script !== null) examine(script, { source: 'user', address, type: 'active-user', order: 3 });
        } catch (error) {
          if (error instanceof MailcowAuthLost) fatal = error;
          else blockers.push(issue('USER_SCRIPT_UNAVAILABLE', address, { source: 'user', type: 'active-user' }));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, addresses.length) }, worker));
    if (fatal) throw fatal;
    teamChanges.sort((a, b) => a.address.localeCompare(b.address) || a.filterId.localeCompare(b.filterId));
    const safeBlockers = compact(blockers), changes = [...plan.aliasChanges.filter(row => row.kind !== 'team-member-alias' || row.team), ...teamChanges];
    versions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); inspected.sort((a, b) => a.order - b.order || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { address: owner, accountActive, keys: plan.keys, changes, blockers: safeBlockers, ready: accountActive === 2 && !safeBlockers.length && !changes.length,
      canPrepare: !safeBlockers.length, checkedMailboxes, totalMailboxes: addresses.length, inspected, etag: etag({ graph: graph.fingerprint, versions, owner, changes, blockers: safeBlockers }) };
  }
  function assertReady(plan) {
    if (plan?.accountActive !== 2) throw new AppError(409, 'RETIREMENT_STATE_CONFLICT', '퇴사 계정의 현재 상태를 먼저 확인해 주세요.');
    if (!plan || !plan.ready || plan.blockers?.length || plan.changes?.length) { const error = refused(); error.details = { blockers: plan?.blockers ?? [], changes: plan?.changes ?? [] }; throw error; }
    return plan.keys;
  }
  async function assertRecipients(addresses) {
    const blocked = await store.blockedRecipients(addresses);
    if (blocked.length) { const error = new AppError(409, 'RETIREMENT_RECIPIENT_BLOCKED', '수신 차단된 계정으로 전달할 수 없어요.'); error.details = { recipients: blocked }; throw error; }
  }
  async function assertScript(source) { await assertRecipients(retirementRedirects(source).map(row => row.target)); }
  const protectedRoute = () => new AppError(409, 'RETIREMENT_ROUTE_PROTECTED', '먼저 해당 계정의 수신 차단을 끄세요.');
  async function routingFacts(session) {
    const [mailboxes, aliases, aliasDomains, domains] = await Promise.all(['mailbox/all', 'alias/all', 'alias-domain/all', 'domain/all'].map(path => rows(session, path)));
    return { mailboxes, aliases, aliasDomains, domains };
  }
  async function assertAdminScript(session, source, owner, projectedGraph) {
    const redirects = retirementRedirects(source).map(row => row.target).filter(target => target !== 'null@localhost');
    if (!redirects.length) return;
    const graph = projectedGraph ?? createRetirementGraph(await routingFacts(session)), keys = [...redirects];
    for (const target of redirects) {
      const result = graph.resolve(target);
      if (result.problems.some(issue => issue.code !== 'UNRESOLVED_INTERNAL')) throw refused();
      keys.push(...result.targets, ...result.problems.map(issue => issue.address));
    }
    if (owner) keys.push(retirementAddress(owner));
    if ((await store.blockedRecipients(unique(keys))).length) throw protectedRoute();
  }
  async function assertMutation(session, { kind, address, after, owner }) {
    const fields = { alias: ['aliases', 'address'], 'alias-domain': ['aliasDomains', 'alias_domain'], mailbox: ['mailboxes', 'username'], domain: ['domains', 'domain_name'] };
    if (!fields[kind]) throw unavailable();
    const facts = await routingFacts(session), [collection, field] = fields[kind];
    const name = String(address).trim().toLowerCase();
    const rowName = row => String(row[field] ?? (kind === 'domain' ? row.domain : '')).trim().toLowerCase();
    const original = facts[collection].find(row => rowName(row) === name);
    const changed = after === null ? null : { ...original, ...after, [field]: name };
    if (kind === 'alias' && original && changed && original.goto === changed.goto && String(original.active) === String(changed.active)) return;
    const projected = { ...facts, [collection]: [...facts[collection].filter(row => rowName(row) !== name), ...(changed ? [changed] : [])] };
    const before = createRetirementGraph(facts), next = createRetirementGraph(projected);
    const names = new Set([...facts.aliases, ...projected.aliases].map(row => String(row.address).trim().toLowerCase()).filter(value => !value.startsWith('@')));
    for (const mailbox of [...facts.mailboxes, ...projected.mailboxes]) {
      const addr = retirementAddress(mailbox.username); names.add(addr);
      for (const map of [...facts.aliasDomains, ...projected.aliasDomains]) if (String(map.target_domain).toLowerCase() === addr.split('@')[1]) names.add(`${addr.split('@')[0]}@${String(map.alias_domain).toLowerCase()}`);
    }
    if (['alias','mailbox'].includes(kind) && !name.startsWith('@')) names.add(name);
    const protectedKeys = owner ? [retirementAddress(owner)] : [];
    for (const envelope of names) {
      const old = before.resolve(envelope), value = next.resolve(envelope);
      if (kind === 'alias-domain' && JSON.stringify(old) !== JSON.stringify(value) && value.problems.some(issue => issue.code === 'ALIAS_LOOP')) throw refused();
      const explicit = ['alias','mailbox'].includes(kind) && envelope === name;
      const domainAffected = kind === 'domain' && (envelope.split('@')[1] === name || [...before.mappedDomains, ...next.mappedDomains].some(([alias, target]) => target === name && envelope.split('@')[1] === alias));
      if (explicit || domainAffected || JSON.stringify(old) !== JSON.stringify(value)) protectedKeys.push(envelope, ...value.targets, ...value.problems.filter(issue => issue.code === 'UNRESOLVED_INTERNAL').map(issue => issue.address));
    }
    if (kind === 'alias' && changed && enabled(changed.active)) {
      const result = next.resolveAlias(name);
      if (result.problems.some(issue => issue.code !== 'UNRESOLVED_INTERNAL')) throw refused();
      protectedKeys.push(...destinations(changed.goto).filter(target => target !== 'null@localhost'), ...result.targets, ...result.problems.map(issue => issue.address));
    }
    if ((await store.blockedRecipients(unique(protectedKeys))).length) throw protectedRoute();
    // Dormant scripts are excluded from ON inspection; guard them before activation.
    if (kind === 'mailbox' && original && !enabled(original.active) && changed && enabled(changed.active)) {
      let filters, payload, scripts;
      try {
        [filters, payload, scripts] = await Promise.all([
          rows(session, 'filters/all'), get(session, `active-user-sieve/${encodeURIComponent(name)}`), dockerapi.listSieve(name),
        ]);
      } catch (error) { if (error instanceof MailcowAuthLost) throw error; throw unavailable(); }
      const sources = [];
      for (const filter of filters) {
        let filterOwner;
        try { filterOwner = retirementAddress(filter.username); } catch { throw unavailable(); }
        if (filterOwner !== name) continue;
        if (![0, 1, '0', '1'].includes(filter.active) || !['prefilter', 'postfilter'].includes(filter.filter_type) || typeof filter.script_data !== 'string') throw unavailable();
        if (String(filter.active) === '1') sources.push(filter.script_data);
      }
      const source = Array.isArray(payload) && payload.length === 1 && typeof payload[0] === 'string' ? payload[0] :
        payload && typeof payload === 'object' && !Array.isArray(payload) && !Object.keys(payload).length ? null : undefined;
      if (!Array.isArray(scripts) || scripts.some(row => typeof row?.name !== 'string' || typeof row.active !== 'boolean') || scripts.filter(row => row.active).length > 1 || source === undefined) throw unavailable();
      if (Boolean(scripts.find(row => row.active)?.name) !== (source !== null)) throw unavailable();
      if (source !== null) sources.push(source);
      for (const source of sources) await assertAdminScript(session, source, name, next);
    }
  }
  return { inspect, assertReady, assertRecipients, assertScript, assertAdminScript, assertMutation, withRoutingLock: operation => store.withRoutingLock(operation) };
}
