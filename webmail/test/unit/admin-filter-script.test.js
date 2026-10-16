import test from 'node:test';
import assert from 'node:assert/strict';
import { hasMoveRedirect } from '../../web/src/admin/pages/filter-script.js';
test('admin filter move warning finds all redirects without copy, including lists and comments between tokens', () => {
  for (const source of ['redirect "user@example.com";', 'redirect ["a@example.com", "b@example.com"];', 'REDIRECT /* comment */ "user@example.com";', 'redirect :copy "a@example.com"; redirect "b@example.com";', 'if true { redirect "user@example.com"; }']) assert.equal(hasMoveRedirect(source), true, source);
});
test('admin filter move warning ignores quoted strings, comments and copy redirects', () => {
  for (const source of ['', 'discard;', 'redirect :copy "user@example.com";', 'redirect /* comment */ :copy "user@example.com";', '# redirect "user@example.com";\nkeep;', '/* redirect "user@example.com"; */ keep;', 'if header :contains "Subject" "redirect" { keep; }', 'if header :contains "Subject" "a\\\" redirect" { keep; }']) assert.equal(hasMoveRedirect(source), false, source);
});
