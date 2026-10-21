import test from 'node:test';
import assert from 'node:assert/strict';
import { hasMoveRedirect, externalRedirectPreview, insertSpamGuard } from '../../web/src/admin/pages/filter-script.js';
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
test('spam guard insertion preserves exact original bytes after all leading require statements', () => {
  for (const [script, expected] of [
    [redirect, `${guard}\n${redirect}`],
    [`require ["copy"];\n${redirect}`, `require ["copy"];\n${guard}\n${redirect}`],
    [`# header\r\nrequire ["copy"];\r\nrequire "fileinto";\r\n${redirect}`, `# header\r\nrequire ["copy"];\r\nrequire "fileinto";\r\n${guard}\r\n${redirect}`],
    [`require /* a */ [\n "copy"\n]; ${redirect}`, `require /* a */ [\n "copy"\n];\n${guard}\n ${redirect}`],
  ]) { assert.equal(insertSpamGuard(script), expected); assert.equal(externalRedirectPreview(expected, []).needsSpamGuard, false); }
});
