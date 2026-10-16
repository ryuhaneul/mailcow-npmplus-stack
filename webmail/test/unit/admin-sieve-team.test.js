import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, addMember, removeMember, Refused } from '../../server/admin/sieve-team.js';

const cases = JSON.parse(readFileSync(new URL('../fixtures/admin/sieve-team-parity.json', import.meta.url), 'utf8'));
for (const sample of cases) test(`Sieve Toolkit parity: ${sample.name}`, () => {
  assert.deepEqual(analyze(sample.script), sample.analysis);
  for (const item of sample.operations) {
    const edit = item.operation === 'add' ? addMember : removeMember;
    if (item.expected.error) assert.throws(() => edit(sample.script, item.address), error => error instanceof Refused && error.code === item.expected.error);
    else assert.deepEqual(edit(sample.script, item.address), item.expected);
  }
});
