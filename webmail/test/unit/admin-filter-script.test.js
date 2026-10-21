import test from 'node:test';
import assert from 'node:assert/strict';
import { hasMoveRedirect, externalRedirectPreview, insertForwardingSafety, needsBounceGuard } from '../../web/src/admin/pages/filter-script.js';
test('admin filter move warning finds all redirects without copy, including lists and comments between tokens', () => {
  for (const source of ['redirect "user@example.com";', 'redirect ["a@example.com", "b@example.com"];', 'REDIRECT /* comment */ "user@example.com";', 'redirect :copy "a@example.com"; redirect "b@example.com";', 'if true { redirect "user@example.com"; }']) assert.equal(hasMoveRedirect(source), true, source);
});
test('admin filter move warning ignores quoted strings, comments and copy redirects', () => {
  for (const source of ['', 'discard;', 'redirect :copy "user@example.com";', 'redirect /* comment */ :copy "user@example.com";', '# redirect "user@example.com";\nkeep;', '/* redirect "user@example.com"; */ keep;', 'if header :contains "Subject" "redirect" { keep; }', 'if header :contains "Subject" "a\\\" redirect" { keep; }']) assert.equal(hasMoveRedirect(source), false, source);
});

const guard = 'if header :contains "X-Spam-Flag" "YES" { stop; }';
const redirect = 'redirect :copy "outside@example.net";';
test('external preview distinguishes internal domains, aliases, literal lists and comments', () => {
  assert.deepEqual(externalRedirectPreview('redirect :copy ["a@example.com", "b@alias.example.com"];', ['example.com', 'alias.example.com']), { external: [], needsSpamGuard: false });
  assert.deepEqual(externalRedirectPreview(`# ${redirect}\n/* ${redirect} */ keep;`, []), { external: [], needsSpamGuard: false });
  assert.deepEqual(externalRedirectPreview('REDIRECT :copy ["OUTSIDE@example.net", "inside@example.com", "outside@example.net"];', ['example.com']), { external: ['outside@example.net'], needsSpamGuard: true });
});
test('spam exclusion must be standalone and ahead of every external redirect', () => {
  for (const script of [redirect, `${redirect}\n${guard}`, `if true { ${guard} } ${redirect}`, `# ${guard}\n${redirect}`, `if header :contains "Subject" "${guard.replaceAll('"', '\\"')}" { keep; } ${redirect}`]) assert.equal(externalRedirectPreview(script, []).needsSpamGuard, true, script);
  for (const script of [`${guard}\n${redirect}`, `require ["copy"];\n${guard}\nif true { ${redirect} }`, `IF HEADER :CONTAINS /* check */ "X-Spam-Flag" "YES" { STOP; } ${redirect}`]) assert.equal(externalRedirectPreview(script, []).needsSpamGuard, false, script);
});
const bounce = 'if envelope :is "from" "" { stop; }';
test('forwarding safety insertion merges require and inserts exactly the missing guards', () => {
  for (const [script, expected] of [
    [redirect, `require ["envelope"];\n${guard}\n${bounce}\n${redirect}`],
    [`require ["copy"];\n${redirect}`, `require ["copy", "envelope"];\n${guard}\n${bounce}\n${redirect}`],
    [`require "copy";\n${redirect}`, `require ["copy", "envelope"];\n${guard}\n${bounce}\n${redirect}`],
    [`require ["copy", "envelope"];\n${redirect}`, `require ["copy", "envelope"];\n${guard}\n${bounce}\n${redirect}`],
    [`require "copy";\nrequire "envelope";\n${redirect}`, `require "copy";\nrequire "envelope";\n${guard}\n${bounce}\n${redirect}`],
    [`# header\r\nrequire ["copy"];\r\nrequire "fileinto";\r\n${redirect}`, `# header\r\nrequire ["copy", "envelope"];\r\nrequire "fileinto";\r\n${guard}\r\n${bounce}\r\n${redirect}`],
    [`require /* a */ [\n "copy"\n]; ${redirect}`, `require /* a */ [\n "copy", "envelope"\n];\n${guard}\n${bounce}\n ${redirect}`],
    [`# require "envelope";\n${redirect}`, `require ["envelope"];\n${guard}\n${bounce}\n# require "envelope";\n${redirect}`],
    [`${guard}\n${redirect}`, `require ["envelope"];\n${bounce}\n${guard}\n${redirect}`],
    [`require "envelope";\n${bounce}\n${redirect}`, `require "envelope";\n${guard}\n${bounce}\n${redirect}`],
  ]) {
    assert.equal(insertForwardingSafety(script, []), expected, script);
    assert.equal(externalRedirectPreview(expected, []).needsSpamGuard, false);
    assert.equal(needsBounceGuard(expected, []), false);
    assert.equal(insertForwardingSafety(expected, []), expected, 'second insertion must be a no-op');
  }
});
test('bounce advice is independent of mandatory spam policy and ignores late, nested or commented guards', () => {
  for (const script of [redirect, `${redirect} ${bounce}`, `if true { ${bounce} } ${redirect}`, `# ${bounce}\n${redirect}`]) assert.equal(needsBounceGuard(script, []), true, script);
  const spamOnly = `${guard}\n${redirect}`;
  assert.equal(externalRedirectPreview(spamOnly, []).needsSpamGuard, false);
  assert.equal(needsBounceGuard(spamOnly, []), true);
  const bounceOnly = `require "envelope";\n${bounce}\n${redirect}`;
  assert.equal(externalRedirectPreview(bounceOnly, []).needsSpamGuard, true);
  assert.equal(needsBounceGuard(bounceOnly, []), false);
  const both = `require "envelope";\n${guard}\n${bounce}\n${redirect}`;
  assert.equal(insertForwardingSafety(both, []), both);
  assert.equal(needsBounceGuard('redirect :copy "inside@example.com";', ['example.com']), false);
});
