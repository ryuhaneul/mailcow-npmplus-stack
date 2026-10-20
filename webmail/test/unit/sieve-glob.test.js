import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globMatch, patternProblem, quoteSieve } from '../../server/sieve/glob.js';

const cases = [
  ['', '', true], ['', 'a', false], ['*', '', true], ['**', 'anything', true],
  ['a**b', 'ab', true], ['a**b', 'a long b', true], ['a*b*c', 'abxc', true],
  ['a*b', 'xab', false], ['a*b', 'abx', false], ['abc', 'ABC', true],
  ['Ä', 'ä', false], ['Ä*', 'ÄBC', true], ['가*다', '가나다', true],
  ['가*다', '가다', true], ['가*다', '가나', false],
  ['\\*', '*', true], ['\\*', 'anything', false], ['\\?', '?', true],
  ['\\?', 'a', false], ['\\\\', '\\', true], ['a\\*b', 'a*b', true],
  ['a\\*b', 'axb', false], ['*\\**', 'abc*def', true], ['*\\?*', 'a?b', true],
  ['"*"', '"text"', true], ['*a*a*b', 'aaaac', false],
  ['*😀*', 'x😀y', true], ['prefix*end', `prefix${'x'.repeat(2000)}end`, true],
  ['*tail', `${'x'.repeat(2000)}tail`, true], ['*tail', `${'x'.repeat(2000)}TAILx`, false],
];
for (const [pattern, value, expected] of cases) test(`glob ${JSON.stringify(pattern)} case ${cases.findIndex(c => c[0] === pattern && c[1] === value)}`, () => {
  assert.equal(patternProblem(pattern), null);
  assert.equal(globMatch(pattern, value), expected);
});

test('invalid escape, question wildcard and complexity return the agreed reasons', () => {
  for (const value of ['\\', 'abc\\', '\\x', '\\"']) {
    assert.equal(patternProblem(value), 'pattern_escape');
    assert.equal(globMatch(value, value), false);
  }
  assert.equal(patternProblem('a?b'), 'pattern_question');
  assert.equal(patternProblem('*'.repeat(20)), null);
  assert.equal(patternProblem('*'.repeat(21)), 'pattern_complexity');
  assert.equal(patternProblem('\\*'.repeat(21)), null);
});

test('Sieve quoting preserves pattern escapes and quotes through string decoding', () => {
  const value = 'a\\*b\\?c\\\\d"e';
  assert.equal(quoteSieve(value), '"a\\\\*b\\\\?c\\\\\\\\d\\"e"');
  assert.equal(JSON.parse(quoteSieve(value)), value);
});

test('twenty interleaved stars on 998 characters stay under 50ms', () => {
  const pattern = `${'*a'.repeat(19)}*b`;
  const target = 'a'.repeat(998);
  globMatch(pattern, target);
  const start = performance.now();
  assert.equal(globMatch(pattern, target), false);
  assert.ok(performance.now() - start < 50);
});

test('greedy matcher agrees with an independent exhaustive small-string oracle', () => {
  function oracle(pattern, value) {
    if (!pattern) return !value;
    if (pattern[0] === '*') return oracle(pattern.slice(1), value) || (value.length > 0 && oracle(pattern, value.slice(1)));
    return value.length > 0 && pattern[0] === value[0] && oracle(pattern.slice(1), value.slice(1));
  }
  function strings(alphabet, max) {
    const result = [''];
    let layer = [''];
    for (let i = 0; i < max; i++) { layer = layer.flatMap(s => alphabet.map(c => s + c)); result.push(...layer); }
    return result;
  }
  for (const pattern of strings(['a', 'b', '*'], 4)) for (const value of strings(['a', 'b'], 5)) {
    assert.equal(globMatch(pattern, value), oracle(pattern, value), `${pattern} / ${value}`);
  }
});
