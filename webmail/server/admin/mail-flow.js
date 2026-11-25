import { inspectRedirects } from '../sieve/redirect-targets.js';
import { activeAliasDomainMap, isDiscardTarget } from './services/aliases.js';
import { groupMailboxAddresses } from './services/shares.js';
import { activePrefilterGroups, isMemberAlias, teamEntry } from './services/teams.js';

const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const targets = value => (Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)).map(normalize).filter(Boolean);
const active = row => String(row.active) === '1';
const compareId = (a, b) => Number(a) - Number(b);

export function buildGraph({ boxes, aliases, filters, domains, aliasDomains = [] }) {
  const nodes = new Map(), outgoing = new Map(), incoming = new Map(), aliasAddresses = new Set();
  const moveTargets = new Map(), warnings = new Map();
  const internal = new Set(domains);
  const domainMap = activeAliasDomainMap(aliasDomains, internal);
  for (const aliasDomain of domainMap.keys()) internal.add(aliasDomain);
  function node(address) {
    if (!nodes.has(address)) nodes.set(address, {
      address, type: isDiscardTarget(address) ? 'discard' : internal.has(address.split('@').at(-1)) ? 'unknown' : 'external', active: null, team: false,
    });
    return nodes.get(address);
  }
  function resolve(target) {
    if (['alias', 'mailbox'].includes(nodes.get(target)?.type)) return target;
    const [local, domain] = target.split('@'), primary = domainMap.get(domain);
    if (!primary || !local) return target;
    const canonical = `${local}@${primary}`;
    const mailbox = nodes.get(canonical);
    return mailbox?.type === 'mailbox' && [1, 2].includes(mailbox.active) ? canonical : target;
  }
  const edges = new Map(), incomingKeys = new Set();
  function addEdge(from, displayTo, kind, copy = null, filterId) {
    const to = resolve(displayTo);
    node(from);
    node(to);
    const key = JSON.stringify([from, displayTo, kind, copy]);
    if (!edges.has(key)) {
      const edge = { from, to, displayTo, kind, copy, filterIds: [] };
      edges.set(key, edge);
      if (!outgoing.has(from)) outgoing.set(from, []);
      outgoing.get(from).push(edge);
      // The incoming tree displays one source per resolved destination and edge kind.
      const incomingKey = JSON.stringify([from, to, kind, copy]);
      if (!incomingKeys.has(incomingKey)) {
        incomingKeys.add(incomingKey);
        if (!incoming.has(to)) incoming.set(to, []);
        incoming.get(to).push(edge);
      }
    }
    const edge = edges.get(key);
    if (filterId !== undefined && !edge.filterIds.includes(filterId)) edge.filterIds.push(filterId);
  }
  const names = new Map();
  for (const box of boxes) {
    const address = normalize(box?.username);
    if (!address) continue;
    Object.assign(node(address), { type: 'mailbox', active: Number(box.active) });
    if (active(box)) names.set(address, typeof box.name === 'string' ? box.name : '');
  }
  const aliasRows = aliases.filter(row => row && typeof row === 'object');
  const activeAliases = aliasRows.filter(alias => normalize(alias.address) && active(alias) && !isMemberAlias(alias));
  for (const alias of activeAliases) {
    const address = normalize(alias.address);
    aliasAddresses.add(address);
    const source = node(address);
    if (source.type !== 'mailbox') source.type = 'alias';
  }
  for (const alias of activeAliases) {
    const address = normalize(alias.address);
    for (const target of targets(alias.goto)) addEdge(address, target, 'alias');
  }
  const filterRows = filters.filter(row => row && typeof row === 'object');
  const teams = groupMailboxAddresses(filterRows), teamTargets = new Map(), domainNames = [...internal];
  for (const [address, entries] of activePrefilterGroups(filterRows)) {
    if (nodes.get(address)?.type !== 'mailbox') continue;
    const item = teamEntry(address, entries, names, aliasRows, teams, domainNames);
    if (!item) continue;
    node(address).team = true;
    const members = new Set(item.members.map(member => normalize(member.address)));
    for (const member of members) addEdge(address, member, 'team');
    // teamEntry already expanded this copy destination into its members.
    if (item.memberAlias) members.add(item.memberAlias);
    teamTargets.set(address, members);
  }
  const orderedFilters = filterRows.filter(row => active(row) && ['prefilter', 'postfilter'].includes(row.filter_type))
    .sort((a, b) => compareId(a.id, b.id));
  for (const filter of orderedFilters) {
    const address = normalize(filter.username);
    if (!address) continue;
    const filterId = String(filter.id);
    let redirects;
    try { redirects = inspectRedirects(filter.script_data); }
    catch (error) {
      if (error.code !== 'FILTER_UNINSPECTABLE') throw error;
      node(address);
      if (!warnings.has(address)) warnings.set(address, []);
      warnings.get(address).push({ code: error.code, filterId });
      continue;
    }
    for (const { target, copy } of redirects) {
      if (copy && teamTargets.get(address)?.has(target)) continue;
      addEdge(address, target, 'filter', copy, filterId);
      if (!copy) {
        if (!moveTargets.has(address)) moveTargets.set(address, new Set());
        moveTargets.get(address).add(target);
      }
    }
  }
  for (const edges of outgoing.values()) edges.sort((a, b) => a.displayTo.localeCompare(b.displayTo));
  for (const edges of incoming.values()) edges.sort((a, b) => a.from.localeCompare(b.from));
  return { nodes, outgoing, incoming, aliasAddresses, moveTargets, warnings };
}

function tree(graph, address, reverse) {
  const adjacency = reverse ? graph.incoming : graph.outgoing;
  const path = new Set(), counted = new Set();
  const makeNode = (addr, edge = null) => ({
    ...graph.nodes.get(addr), address: reverse ? addr : edge?.displayTo ?? addr,
    kind: edge?.kind ?? null, copy: edge?.copy ?? null, cycle: path.has(addr),
    warnings: graph.warnings.get(addr) ?? [], children: [], group: null,
  });
  const root = makeNode(address);
  function visit(node, addr) {
    if (node.cycle) return;
    const edges = adjacency.get(addr) ?? [];
    path.add(addr);
    const members = [];
    for (const edge of edges) {
      const next = reverse ? edge.from : edge.to;
      const leaf = !adjacency.get(next)?.length && !['alias', 'discard'].includes(graph.nodes.get(next).type);
      if (next !== address && (reverse || leaf)) counted.add(next);
      const child = makeNode(next, edge);
      if (!reverse && edge.kind === 'team' && leaf) {
        members.push(child);
        continue;
      }
      node.children.push(child);
      visit(child, next);
    }
    if (members.length) {
      const group = { ...members[0], warnings: [], group: {
        members: members.map(({ address, active, warnings }) => ({ address, active, warnings })),
      } };
      node.children.push(group);
      node.children.sort((a, b) => a.address.localeCompare(b.address));
    }
    path.delete(addr);
  }
  visit(root, address);
  return { root, count: counted.size };
}

export function outgoingTree(graph, addr) {
  return tree(graph, normalize(addr), false);
}

export function incomingTree(graph, addr) {
  return tree(graph, normalize(addr), true);
}

export function aliasMatches(graph, q) {
  const search = normalize(q), matches = new Map();
  if (!search) return matches;
  for (const alias of [...graph.aliasAddresses].sort()) {
    if (!alias.includes(search)) continue;
    const visited = new Set([alias]);
    const pending = [alias];
    while (pending.length) {
      for (const edge of graph.outgoing.get(pending.pop()) ?? []) {
        if (edge.kind !== 'alias' || visited.has(edge.to)) continue;
        visited.add(edge.to);
        if (graph.nodes.get(edge.to).type === 'mailbox') {
          if (!matches.has(edge.to)) matches.set(edge.to, []);
          matches.get(edge.to).push(alias);
        } else pending.push(edge.to);
      }
    }
  }
  return matches;
}
