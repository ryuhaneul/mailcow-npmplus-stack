import { inspectRedirects } from '../sieve/redirect-targets.js';
import { groupMailboxAddresses } from './services/shares.js';
import { activePrefilterGroups, isMemberAlias, teamEntry } from './services/teams.js';

const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const targets = value => (Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)).map(normalize).filter(Boolean);
const active = row => String(row.active) === '1';
const compareId = (a, b) => Number(a) - Number(b);

export function buildGraph({ boxes, aliases, filters, domains }) {
  const nodes = new Map(), outgoing = new Map(), incoming = new Map(), aliasAddresses = new Set();
  const moveTargets = new Map(), warnings = new Map();
  const internal = new Set(domains);
  function node(address) {
    if (!nodes.has(address)) nodes.set(address, {
      address, type: internal.has(address.split('@').at(-1)) ? 'unknown' : 'external', active: null, team: false,
    });
    return nodes.get(address);
  }
  const edges = new Map();
  function addEdge(from, to, kind, copy = null, filterId) {
    node(from);
    node(to);
    const key = JSON.stringify([from, to, kind, copy]);
    if (!edges.has(key)) {
      const edge = { from, to, kind, copy, filterIds: [] };
      edges.set(key, edge);
      if (!outgoing.has(from)) outgoing.set(from, []);
      if (!incoming.has(to)) incoming.set(to, []);
      outgoing.get(from).push(edge);
      incoming.get(to).push(edge);
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
  for (const alias of aliasRows) {
    const address = normalize(alias.address);
    if (!address || !active(alias) || isMemberAlias(alias)) continue;
    aliasAddresses.add(address);
    const source = node(address);
    if (source.type !== 'mailbox') source.type = 'alias';
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
    teamTargets.set(address, members);
    for (const member of members) addEdge(address, member, 'team');
    // teamEntry already expanded this copy destination into its members.
    if (item.memberAlias) members.add(item.memberAlias);
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
      if (!warnings.has(address)) warnings.set(address, { code: error.code, filterId });
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
  for (const edges of outgoing.values()) edges.sort((a, b) => a.to.localeCompare(b.to));
  for (const edges of incoming.values()) edges.sort((a, b) => a.from.localeCompare(b.from));
  return { nodes, outgoing, incoming, aliasAddresses, moveTargets, warnings };
}

function tree(graph, address, reverse) {
  const adjacency = reverse ? graph.incoming : graph.outgoing;
  const path = new Set(), counted = new Set();
  const makeNode = (addr, edge = null) => ({
    ...graph.nodes.get(addr), kind: edge?.kind ?? null, copy: edge?.copy ?? null, cycle: path.has(addr),
    warning: graph.warnings.get(addr) ?? null, children: [], group: null,
  });
  const root = makeNode(address);
  function visit(node) {
    if (node.cycle) return;
    const edges = adjacency.get(node.address) ?? [];
    path.add(node.address);
    const members = [];
    for (const edge of edges) {
      const next = reverse ? edge.from : edge.to;
      const leaf = !adjacency.get(next)?.length && graph.nodes.get(next).type !== 'alias';
      if (next !== address && (reverse || leaf)) counted.add(next);
      if (!reverse && edge.kind === 'team' && leaf) {
        members.push(next);
        continue;
      }
      const child = makeNode(next, edge);
      node.children.push(child);
      visit(child);
    }
    if (members.length) {
      const group = makeNode(members[0], { kind: 'team' });
      group.group = { members };
      node.children.push(group);
      node.children.sort((a, b) => a.address.localeCompare(b.address));
    }
    path.delete(node.address);
  }
  visit(root);
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
