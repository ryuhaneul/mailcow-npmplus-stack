import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConditionTree, validateConditionTree } from '../../server/sieve/condition-tree.js';
import { validateDocument } from '../../server/sieve/model.js';
import { ruleProblem } from '../../web/src/components/rule-form.js';

const leaf = (value = 'synthetic', op = 'has', field = 'subject') => ({ field, op, value });
const all = (...conditions) => ({ match: 'all', conditions });
const any = (...conditions) => ({ match: 'any', conditions });
const rule = tree => ({ id: 'test0001', enabled: true, ...tree, actions: { read: true }, stop: false });
const doc = (tree, v = 2) => ({ v, rev: 0, rules: [rule(tree)], blocked: [], vacation: { enabled: false, start: null, end: null, subject: '', body: '' } });

test('normalization flattens same joins and singleton groups before checking depth', () => {
  const input = all(all(all(leaf('a'), leaf('b')), leaf('c')));
  assert.deepEqual(normalizeConditionTree(input), all(leaf('a'), leaf('b'), leaf('c')));
  assert.deepEqual(normalizeConditionTree(all(any(leaf('a'), leaf('b')))), any(leaf('a'), leaf('b')));
  assert.deepEqual(normalizeConditionTree(any(leaf())), all(leaf()));
  assert.deepEqual(normalizeConditionTree(leaf()), all(leaf()));
});
test('De Morgan conversion flips joins and representable leaf negation', () => {
  assert.deepEqual(normalizeConditionTree({ not: all(leaf('a'), leaf('b', 'not', 'from')) }), any(leaf('a', 'not'), leaf('b', 'has', 'from')));
  assert.deepEqual(normalizeConditionTree({ not: { not: any(leaf('a'), leaf('b')) } }), any(leaf('a'), leaf('b')));
});
test('same joins produced by De Morgan are flattened a second time', () => {
  assert.deepEqual(normalizeConditionTree(all(leaf('a'), { not: any(leaf('b'), leaf('c')) })), all(leaf('a'), leaf('b', 'not'), leaf('c', 'not')));
});
for (const condition of [leaf('a', 'eq'), leaf('a', 'start'), leaf('a*', 'matches'), leaf('', 'has', 'attachment'), leaf('a', 'has', 'to')]) {
  test(`normalization rejects excluded ${condition.field}/${condition.op}`, () => {
    assert.throws(() => normalizeConditionTree({ not: condition }), error => error.reason === 'negation');
  });
}
test('normalization rejects empty groups, final excessive depth and final excessive size', () => {
  for (const tree of [all(), { not: any() }, all(leaf(), any(leaf(), all(leaf(), leaf()))), all(...Array.from({ length: 11 }, () => leaf()))]) {
    assert.throws(() => normalizeConditionTree(tree), error => error.reason === 'group_shape');
  }
});

const fixtures = [];
for (const field of ['from', 'to', 'subject']) for (const op of ['has', 'not', 'eq', 'start', 'matches']) {
  fixtures.push([`${field}/${op}`, all(leaf(op === 'matches' ? '*synthetic*' : 'synthetic', op, field)), true]);
}
for (const value of ['*', 'a**b', '\\*', '\\?', '\\\\', 'Ä*', '가*다', '*'.repeat(20), '😀'.repeat(200)]) fixtures.push([`pattern ${value}`, all(leaf(value, 'matches')), true]);
for (const value of ['?', '\\', '\\q', '*'.repeat(21), '', 'x'.repeat(201), '${unsafe}', 'bad\n', '\ud800']) fixtures.push([`invalid pattern ${JSON.stringify(value)}`, all(leaf(value, 'matches')), false]);
fixtures.push(
  ['attachment', all(leaf('', 'has', 'attachment')), true],
  ['attachment negation', all(leaf('', 'not', 'attachment')), false],
  ['body includes', all(leaf('x', 'has', 'body')), true],
  ['body excludes', all(leaf('x', 'not', 'body')), true],
  ['body exact unsupported', all(leaf('x', 'eq', 'body')), false],
  ['body prefix unsupported', all(leaf('x', 'start', 'body')), false],
  ['body pattern unsupported', all(leaf('x', 'matches', 'body')), false],
  ['unknown field', all(leaf('x', 'has', 'unsupported')), false],
  ['unknown op', all(leaf('x', 'regex')), false],
  ['all/any', all(leaf(), any(leaf('a'), leaf('b'))), true],
  ['any/all', any(leaf(), all(leaf('a'), leaf('b'))), true],
  ['twenty leaves', all(any(...Array.from({ length: 10 }, () => leaf())), any(...Array.from({ length: 10 }, () => leaf()))), true],
  ['twenty-one leaves', all(any(...Array.from({ length: 10 }, () => leaf())), any(...Array.from({ length: 10 }, () => leaf())), leaf()), false],
  ['depth three', all(leaf(), any(leaf(), all(leaf(), leaf()))), false],
  ['empty root', all(), false], ['empty child', all(leaf(), any()), false],
  ['singleton child', all(leaf(), any(leaf())), false],
  ['same join', all(leaf(), all(leaf(), leaf())), false],
  ['single child group', all(any(leaf(), leaf())), false],
  ['unknown group field', all(leaf(), { ...any(leaf(), leaf()), extra: true }), false],
  ['null child', all(null), false], ['array child', all([]), false],
);
for (const [name, tree, valid] of fixtures) test(`model/browser condition parity: ${name}`, () => {
  let accepted = true;
  try { validateDocument(doc(tree)); } catch (error) { assert.equal(error.statusCode, 422); accepted = false; }
  assert.equal(accepted, valid, 'model');
  assert.equal(ruleProblem(rule(tree), [], [], '') === null, valid, 'browser');
});

test('stored validation rejects non-normal forms with group_shape and relative paths', () => {
  const tree = all(leaf(), any(leaf()));
  assert.deepEqual(validateConditionTree(tree), { path: '$.conditions[1]', reason: 'group_shape' });
  assert.throws(() => validateDocument(doc(tree)), error => error.reason === 'group_shape' && error.path === '$.rules[0].conditions[1]');
});
test('v1 data stays unchanged; new structure requires v2, which can also read old structures', () => {
  const original = doc(all(leaf()), 1);
  const snapshot = structuredClone(original);
  assert.equal(validateDocument(original), original);
  assert.deepEqual(original, snapshot);
  assert.doesNotThrow(() => validateDocument(doc(all(leaf()), 2)));
  for (const tree of [all(leaf('*', 'matches')), all(leaf(), any(leaf(), leaf()))]) {
    assert.throws(() => validateDocument(doc(tree, 1)), error => error.path === '$.v' && error.reason === 'version');
    assert.doesNotThrow(() => validateDocument(doc(tree, 2)));
  }
  for (const version of [0, 3, '2', null]) assert.throws(() => validateDocument(doc(all(leaf()), version)), error => error.reason === 'version');
});
