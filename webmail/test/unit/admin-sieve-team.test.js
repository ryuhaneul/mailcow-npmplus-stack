import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, addMember, removeMember, collapseMembers, Refused } from '../../server/admin/sieve-team.js';

const cases = JSON.parse(readFileSync(new URL('../fixtures/admin/sieve-team-parity.json', import.meta.url), 'utf8'));
for (const sample of cases) test(`Sieve Toolkit parity: ${sample.name}`, () => {
  assert.deepEqual(analyze(sample.script), sample.analysis);
  for (const item of sample.operations) {
    const edit = item.operation === 'add' ? addMember : removeMember;
    if (item.expected.error) assert.throws(() => edit(sample.script, item.address), error => error instanceof Refused && error.code === item.expected.error);
    else assert.deepEqual(edit(sample.script, item.address), item.expected);
  }
});

test('Sieve collapse: preserves conditional blocks and team links, using the first removed line indentation and CRLF', () => {
  const condition = 'require ["copy"];\r\nif header :contains "Subject" "AuthCode" {\r\n  redirect :copy "notice@example.com";\r\n}\r\n';
  const link = 'redirect :copy "linked@example.com"; # team link\r\n';
  const source = condition + '  redirect :copy "first@example.com"; # personal\r\n' + link + '  redirect :copy "second@example.com";\r\n';
  assert.deepEqual(collapseMembers(source, ['first@example.com', 'second@example.com'], 'team-members@example.com'), {
    script: condition + '  redirect :copy "team-members@example.com";\r\n' + link, changed: true,
  });
  for (const [script, code] of [
    ['redirect :copy "first@example.com"', 'unparseable'],
    ['stop;\nredirect :copy "first@example.com";\n', 'stopper_before_member'],
    ['redirect :copy "first@example.com"; keep;\n', 'line_not_simple'],
  ]) assert.throws(() => collapseMembers(script, ['first@example.com'], 'team-members@example.com'), error => error instanceof Refused && error.code === code);
});
