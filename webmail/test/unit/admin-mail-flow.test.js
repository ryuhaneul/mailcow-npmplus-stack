import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasMatches, buildGraph, incomingTree, outgoingTree } from '../../server/admin/mail-flow.js';

const addr = local => `${local}@example.com`;
const mailbox = (local, active = 1) => ({ username: addr(local), active });
const alias = (local, goto, extra = {}) => ({ address: addr(local), goto, active: 1, ...extra });
const filter = (id, local, script_data, extra = {}) => ({ id, username: addr(local), script_data, filter_type: 'postfilter', active: 1, ...extra });
const prefilter = (id, local, script) => filter(id, local, script, { filter_type: 'prefilter' });
const redirect = (to, copy = false) => `redirect ${copy ? ':copy ' : ''}"${to}";\n`;
const members = Array.from({ length: 11 }, (_, index) => addr(`member${String(index + 1).padStart(2, '0')}`));
const outside = 'out@outside.example.com';

function fixture() {
  return buildGraph({
    boxes: [...['tax3', 'tax', 'tax-member', 'sales', 'ywlee', 'rose', 'mix', 'x'].map(local => mailbox(local)),
      ...members.map((username, index) => ({ username, active: index === 0 ? '2' : '1' }))],
    aliases: [
      alias('global', `SALES@EXAMPLE.COM, ${addr('ywlee')}`),
      alias('global-chain', [addr('global-loop')]),
      alias('global-loop', [addr('global-chain'), addr('global')]),
      alias('sales-members', members.join(','), { private_comment: 'mailadmin:team-members' }),
      alias('global-off', addr('x'), { active: 0 }),
    ],
    filters: [
      filter(12, 'tax3', redirect(addr('global')) + redirect(outside, true) + redirect(addr('tax'))),
      filter(2, 'tax3', redirect('TAX@EXAMPLE.COM')),
      prefilter(3, 'tax', redirect(addr('tax-member'), true)),
      prefilter(4, 'sales', redirect(addr('sales-members'), true)),
      filter(5, 'sales', redirect(addr('rose'), true)),
      filter(6, 'rose', redirect(addr('sales'), true)),
      prefilter(7, 'mix', redirect(addr('x'), true) + redirect(addr('x'))),
      filter(8, 'mix', 'redirect :copy "${dynamic}";'),
      filter(9, 'mix', redirect(addr('missing'), true), { active: 0 }),
      filter(10, 'mix', redirect(addr('missing'), true), { filter_type: 'personal' }),
      filter(11, 'mix', redirect(addr('x'), true)),
    ],
    domains: ['example.com'],
  });
}

const child = (node, local) => node.children.find(row => row.address === addr(local));

test('mail flow: tax routes reach fourteen distinct destinations with ordered moves and filter ids', () => {
  const graph = fixture();
  const { root, count } = outgoingTree(graph, 'TAX3@EXAMPLE.COM');
  assert.equal(count, 14);
  assert.deepEqual([...graph.moveTargets.get(addr('tax3'))], [addr('tax'), addr('global')]);
  assert.deepEqual(child(child(root, 'tax'), 'tax-member').group, { members: [addr('tax-member')] });
  const sales = child(child(root, 'global'), 'sales');
  assert.deepEqual(sales.children.find(row => row.group).group.members, members);
  assert.equal(sales.children.find(row => row.group).active, 2);
  assert.equal(child(child(root, 'global'), 'ywlee').type, 'mailbox');
  assert.equal(root.children.find(row => row.address === outside).type, 'external');
  assert.deepEqual(graph.outgoing.get(addr('tax3')).find(edge => edge.to === addr('tax')).filterIds, ['2', '12']);
});

test('mail flow: cycles stop only the current branch in both directions', () => {
  const graph = fixture();
  const { root } = outgoingTree(graph, addr('sales'));
  assert.equal(child(root, 'sales-members'), undefined);
  const cycle = child(child(root, 'rose'), 'sales');
  assert.equal(cycle.cycle, true);
  assert.deepEqual(cycle.children, []);
  assert.equal(child(root, 'rose').kind, 'filter');
  const incoming = incomingTree(graph, addr('ywlee'));
  const global = child(incoming.root, 'global');
  assert.equal(child(global, 'tax3').kind, 'filter');
  const aliasCycle = child(child(child(global, 'global-loop'), 'global-chain'), 'global-loop');
  assert.equal(aliasCycle.cycle, true);
  assert.equal(incoming.count, 4);
});

test('mail flow: team copies are deduplicated and moves, warnings and unrelated routes survive', () => {
  const graph = fixture();
  const { root, count } = outgoingTree(graph, addr('mix'));
  assert.deepEqual(root.warning, { code: 'FILTER_UNINSPECTABLE', filterId: '8' });
  assert.deepEqual([...graph.moveTargets.get(addr('mix'))], [addr('x')]);
  assert.deepEqual(root.children.map(({ kind, copy }) => [kind, copy]), [['filter', false], ['team', null]]);
  assert.equal(count, 1);
  for (const local of ['global-off', 'sales-members', 'missing']) {
    assert.equal(graph.nodes.has(addr(local)), false);
    assert.equal(graph.outgoing.has(addr(local)), false);
  }
});

test('mail flow: copy and move to one address remain distinct and reuse downstream addresses per path', () => {
  const graph = buildGraph({
    boxes: [mailbox('start'), mailbox('mid'), mailbox('end', '0')],
    aliases: [alias('bridge', addr('end'))],
    filters: [filter(1, 'start', redirect(addr('mid'), true) + redirect(addr('mid'))),
      filter(2, 'mid', redirect(addr('missing'), true) + redirect(addr('bridge'), true))],
    domains: ['example.com'],
  });
  const { root, count } = outgoingTree(graph, addr('start'));
  assert.equal(count, 2);
  assert.deepEqual(root.children.map(row => row.copy), [true, false]);
  for (const branch of root.children) {
    assert.equal(child(branch, 'missing').type, 'unknown');
    assert.equal(child(child(branch, 'bridge'), 'end').active, 0);
  }
  assert.deepEqual(incomingTree(graph, addr('end')).count, 3);
});

test('mail flow: alias search follows only aliases through cycles and stops at the first mailbox', () => {
  const graph = fixture();
  const expected = ['global-chain', 'global-loop', 'global'].map(addr).sort();
  const matches = aliasMatches(graph, ' GLOBAL ');
  assert.deepEqual([...matches.keys()].sort(), [addr('sales'), addr('ywlee')]);
  assert.deepEqual(matches.get(addr('sales')), expected);
  assert.deepEqual(matches.get(addr('ywlee')), expected);
  assert.equal(aliasMatches(graph, 'sales-members').size, 0);
  assert.equal(aliasMatches(graph, '').size, 0);
});
