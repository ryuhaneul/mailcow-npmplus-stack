import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectRedirects, retirementRedirects } from '../../server/sieve/redirect-targets.js';
import { inspectRedirects as legacyExport } from '../../server/admin/services/filters.js';

test('redirect reader: existing filters re-export the identical literal reader', () => {
  assert.equal(legacyExport, inspectRedirects);
  assert.deepEqual(inspectRedirects('require ["copy"]; if true { redirect :copy ["ONE@example.test", "two@example.test"]; }'), [
    { target: 'one@example.test', copy: true }, { target: 'two@example.test', copy: true },
  ]);
  // The legacy consumer does not acquire retirement-only restrictions.
  assert.deepEqual(inspectRedirects('include "another-script";'), []);
});
test('retirement reader: conditionals, comments, multiline values and unrelated variables do not hide fixed redirects', () => {
  const source = '# redirect "not-a-target@example.test";\nrequire ["copy","variables"];\nset "label" "${value}";\nif header :contains "subject" "example" {\nredirect :copy "ONE@example.test";\n} else { keep; }\n';
  assert.deepEqual(retirementRedirects(source), [{ target: 'one@example.test', copy: true }]);
  assert.deepEqual(retirementRedirects('vacation :days 1 :subject "away" "line one\nline two";'), []);
  assert.deepEqual(retirementRedirects(''), []);
});
test('retirement reader: opaque delivery commands and dynamic recipients fail closed', () => {
  for (const source of ['include "other";', 'pipe "program";', 'if execute "program" { keep; }', 'notify "mailto:one@example.test";',
    'unknown_delivery "one@example.test";', 'set "target" "one@example.test"; redirect "${target}";', 'redirect :unknown "one@example.test";']) {
    assert.throws(() => retirementRedirects(source), { code: 'FILTER_UNINSPECTABLE' });
  }
});
test('retirement reader: malformed nesting, missing terminator and unparseable strings are not treated as safe', () => {
  for (const source of ['if true { redirect "one@example.test";', 'redirect "one@example.test"', 'if true { keep }', 'keep; }', 'require ["copy";', 'redirect "broken;']) {
    assert.throws(() => retirementRedirects(source), { code: 'FILTER_UNINSPECTABLE' });
  }
});
