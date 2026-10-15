import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateDocument, canonicalJSON, MAX_SCRIPT_BYTES } from '../../server/sieve/model.js';
import { conditionTest, generateScript, hashBody, MAGIC } from '../../server/sieve/generate.js';
import { parseScript } from '../../server/sieve/parse.js';
import { classifyState } from '../../server/sieve/state.js';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/sieve/roundtrip.json', import.meta.url), 'utf8'));
const context = { internalDomains: ['example.com', 'alias.example.com'], folders: [{ path: 'Projects/팀' }, { path: 'Archive' }], addresses: ['user@example.com', 'alias@alias.example.com'], trashPath: 'Trash' };
const empty = () => ({ v: 1, rev: 0, rules: [], blocked: [], vacation: { enabled: false, start: null, end: null, subject: '', body: '' } });
const rule = (i = 1, actions = { read: true }) => ({ id: `r${String(i).padStart(7, '0')}`, enabled: true, match: 'all', conditions: [{ field: 'subject', op: 'has', value: '회의' }], actions, stop: false });
const document = () => ({ ...empty(), rules: [rule()] });
const expectInvalid = (doc, code = 'RULES_INVALID', policy = context) => assert.throws(() => validateDocument(doc, policy), error => error.statusCode === 422 && error.code === code && typeof error.path === 'string' && typeof error.reason === 'string');
const envelope = (value, body = 'require ["fileinto"];\n') => `${MAGIC}\n${Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url').match(/.{1,120}/g).map(c => `# WEBMAIL-DATA ${c}`).join('\n')}\n# WEBMAIL-HASH ${hashBody(body)}\n${body}`;

for (const fixture of fixtures) {
  test(`Sieve roundtrip: ${fixture.name}`, () => {
    assert.strictEqual(validateDocument(fixture.doc, context), fixture.doc);
    const first = generateScript(fixture.doc, context);
    const parsed = parseScript(first);
    assert.equal(parsed.state, 'ok');
    assert.deepEqual(parsed.doc, fixture.doc);
    assert.equal(parsed.rev, fixture.doc.rev);
    assert.equal(generateScript(parsed.doc, context), first);
    assert.equal(generateScript(fixture.doc, context), first);
    for (const line of first.split('\n').filter(line => line.startsWith('# WEBMAIL-DATA '))) assert.ok(line.length <= 135);
  });
}

test('canonical serialization ignores object insertion order and never reorders rules', () => {
  const doc = document();
  const reordered = JSON.parse(JSON.stringify(doc, Object.keys({ ...doc, ...doc.rules[0], ...doc.rules[0].conditions[0], ...doc.rules[0].actions, ...doc.vacation }).reverse()));
  assert.deepEqual(reordered, doc);
  assert.equal(generateScript(doc, context), generateScript(reordered, context));
  assert.equal(canonicalJSON({ b: 1, a: [2, 1] }), '{"a":[2,1],"b":1}');
});

test('all condition mappings and glob escaping use literal input', () => {
  for (const field of ['from', 'to', 'subject']) {
    const headers = field === 'to' ? '["to", "cc"]' : `"${field}"`;
    for (const [op, comparator] of [['has', ':contains'], ['not', ':contains'], ['eq', ':is'], ['start', ':matches']]) {
      const verb = field !== 'subject' && ['eq', 'start'].includes(op) ? 'address :all' : 'header';
      assert.equal(conditionTest({ field, op, value: 'Abc' }), `${op === 'not' ? 'not ' : ''}${verb} ${comparator} ${headers} "Abc${op === 'start' ? '*' : ''}"`);
    }
  }
  assert.equal(conditionTest({ field: 'subject', op: 'start', value: '*?\\"' }), 'header :matches "subject" "\\\\*\\\\?\\\\\\\\\\"*"');
  assert.equal(conditionTest({ field: 'attachment', op: 'has', value: '' }), 'header :contains "content-type" "multipart/mixed"');
});

test('spam guard surrounds blocking, vacation, user rules and final delivery', () => {
  const script = generateScript(fixtures[14].doc, context);
  const guard = script.indexOf('if not header :is "X-Spam-Flag" "YES" {');
  assert.ok(guard > script.indexOf('require ['));
  assert.ok(guard < script.indexOf('vacation :days 1'));
  assert.ok(guard < script.indexOf('# 규칙 1:'));
  assert.ok(script.endsWith('  elsif not string :is "${wm_folder}" "" { fileinto "${wm_folder}"; }\n}\n'));
  assert.equal(script.includes(':create'), false);
  assert.equal(script.includes('fileinto :copy'), false);
  assert.ok(script.includes('addflag "\\\\Seen";'));
  assert.ok(script.includes('addflag "\\\\Flagged";'));
});

test('blocked address/domain action precedes vacation and stops processing', () => {
  const doc = structuredClone(fixtures[14].doc);
  doc.blocked = ['BAD@example.com', '@spam.example.com'];
  const script = generateScript(doc, context);
  const block = 'if anyof(address :all :is "from" ["bad@example.com"], address :domain :is "from" ["spam.example.com"]) { fileinto "Trash"; stop; }';
  assert.ok(script.includes(block));
  assert.ok(script.indexOf(block) < script.indexOf('vacation :days 1'));
});

test('rules accumulate flags, keep the first folder, prefer trash and guard deduplicated redirects', () => {
  const doc = empty();
  doc.rules = [rule(1, { move: 'Archive', read: true, forward: ['USER@example.com'] }), rule(2, { move: 'Projects/팀', star: true, forward: ['user@EXAMPLE.COM'] }), rule(3, { trash: true })];
  doc.rules[1].stop = true;
  const script = generateScript(doc, context);
  assert.equal((script.match(/set "wm_forward_0" "0"/g) ?? []).length, 1);
  assert.equal((script.match(/redirect :copy "user@example.com"/g) ?? []).length, 2);
  assert.equal((script.match(/if not string :is "\$\{wm_forward_0\}" "1"/g) ?? []).length, 2);
  assert.equal(script.includes('wm_forward_1'), false);
  assert.equal((script.match(/if string :is "\$\{wm_folder\}" "" \{ set "wm_folder"/g) ?? []).length, 2);
  assert.equal((script.match(/if allof\(not string :is "\$\{wm_stop\}" "1"/g) ?? []).length, 3);
  assert.ok(script.includes('set "wm_stop" "1";'));
  assert.ok(script.includes('if string :is "${wm_trash}" "1" { fileinto "Trash"; }\n  elsif'));
});

test('disabled rules stay in data but produce no executable action', () => {
  const doc = document();
  doc.rules[0].enabled = false;
  const script = generateScript(doc, context);
  assert.equal(script.includes('addflag'), false);
  assert.deepEqual(parseScript(script).doc, doc);
});

test('vacation dates are inclusive; either bound and unbounded dates are supported', () => {
  const doc = structuredClone(fixtures[14].doc);
  let script = generateScript(doc, context);
  assert.ok(script.includes('currentdate :value "ge" "date" "2026-10-15"'));
  assert.ok(script.includes('currentdate :value "le" "date" "2026-10-31"'));
  assert.ok(script.includes(':addresses ["user@example.com", "alias@alias.example.com"]'));
  doc.vacation.end = null;
  script = generateScript(doc, context);
  assert.equal(script.includes('currentdate :value "le"'), false);
  doc.vacation.start = null;
  script = generateScript(doc, context);
  assert.equal(script.includes('currentdate'), false);
  assert.throws(() => generateScript(doc, { ...context, addresses: [] }), { code: 'RULES_INVALID', statusCode: 422 });
});

test('unsafe input cannot inject variables, commands or metadata lines', () => {
  for (const value of ['${wm_stop}', 'line\n# WEBMAIL-HASH x', 'x\r', 'x\t', 'x\0', 'x\u007f', 'x\u0085', '\ud800']) {
    const doc = document();
    doc.rules[0].conditions[0].value = value;
    expectInvalid(doc);
    doc.rules[0].conditions[0].value = 'safe';
    doc.rules[0].actions = { move: value };
    expectInvalid(doc);
  }
  const doc = document();
  doc.rules[0].conditions[0].value = '"; stop; #';
  assert.ok(generateScript(doc, context).includes('"\\"; stop; #"'));
  assert.throws(() => generateScript(doc, { ...context, trashPath: '${x}' }), { code: 'RULES_INVALID' });
  assert.throws(() => generateScript(doc, { ...context, addresses: ['bad\n@example.com'] }), { code: 'RULES_INVALID' });
});

test('external forwarding, subdomain lookalikes and move plus trash return 422', () => {
  for (const target of ['a@outside.example.com', 'a@example.com.invalid', 'a@sub.example.com']) {
    const doc = document(); doc.rules[0].actions = { forward: [target] };
    expectInvalid(doc, 'FORWARD_EXTERNAL');
  }
  const doc = document();
  doc.rules[0].actions = { move: 'Archive', trash: true };
  expectInvalid(doc);
  doc.rules[0].actions = { forward: ['a@EXAMPLE.COM', 'a@alias.example.com'] };
  assert.equal(validateDocument(doc, context), doc);
  expectInvalid(doc, 'FORWARD_EXTERNAL', {});
});

test('move requires an existing personal allowed folder', () => {
  for (const folder of [{ path: 'INBOX' }, { path: 'Trash' }, { path: 'Junk' }, { path: 'Drafts' }, { path: 'Shared/team' }, { path: 'WebmailVirtual/AllMail' }, { path: 'OtherTrash', specialUse: '\\Trash' }, { path: 'Other', shared: true }, { path: 'Other', virtual: true }, { path: 'Other', personal: false }]) {
    const doc = document(); doc.rules[0].actions = { move: folder.path };
    expectInvalid(doc, 'RULES_INVALID', { ...context, folders: [folder] });
  }
  const doc = document(); doc.rules[0].actions = { move: 'Missing' };
  expectInvalid(doc);
});

test('rule schema rejects missing, unknown and invalid fields', () => {
  const changes = [
    d => { d.v = 2; }, d => { d.rev = -1; }, d => { d.rev = 1.1; }, d => { d.extra = true; },
    d => { delete d.blocked; }, d => { d.rules = null; }, d => { d.rules[0].id = 'short'; },
    d => { d.rules.push(structuredClone(d.rules[0])); }, d => { d.rules[0].enabled = 1; },
    d => { d.rules[0].stop = null; }, d => { d.rules[0].match = 'each'; },
    d => { d.rules[0].conditions = []; }, d => { d.rules[0].conditions[0].field = 'body'; },
    d => { d.rules[0].conditions[0].op = 'regex'; }, d => { d.rules[0].conditions[0].value = ''; },
    d => { d.rules[0].conditions[0] = { field: 'attachment', op: 'not', value: '' }; },
    d => { d.rules[0].conditions[0] = { field: 'attachment', op: 'has', value: 'x' }; },
    d => { d.rules[0].actions = {}; }, d => { d.rules[0].actions = { read: false }; },
    d => { d.rules[0].actions = { star: 'yes' }; }, d => { d.rules[0].actions = { forward: [] }; },
    d => { d.rules[0].actions = { forward: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'] }; },
    d => { d.blocked = ['@bad..example.com']; }, d => { d.blocked = ['bad address@example.com']; },
    d => { d.vacation.start = '2026-02-30'; }, d => { d.vacation.start = '2026-10-30'; d.vacation.end = '2026-10-01'; },
    d => { d.vacation.body = '가'.repeat(4001); }, d => { d.vacation.enabled = 'true'; },
    d => { d.importedFrom = { name: 'example', sha256: 'invalid', at: '2026-10-15T00:00:00Z' }; },
    d => { d.importedFrom = { name: 'example', sha256: 'a'.repeat(64), at: 'yesterday' }; }
  ];
  for (const change of changes) { const doc = document(); change(doc); expectInvalid(doc); }
});

test('document limits: 100 rules, 10 conditions, 200 characters, 500 blocked and 4000 body', () => {
  const doc = document();
  doc.rules = Array.from({ length: 100 }, (_, i) => rule(i));
  doc.rules[0].conditions = Array.from({ length: 10 }, () => ({ field: 'subject', op: 'eq', value: '😀'.repeat(200) }));
  doc.blocked = Array.from({ length: 500 }, (_, i) => `block${i}@example.com`);
  doc.vacation.body = '가'.repeat(4000);
  assert.equal(validateDocument(doc, context), doc);
  doc.rules.push(rule(100)); expectInvalid(doc); doc.rules.pop();
  doc.rules[0].conditions.push({ field: 'from', op: 'has', value: 'a' }); expectInvalid(doc); doc.rules[0].conditions.pop();
  doc.rules[0].conditions[0].value += 'a'; expectInvalid(doc); doc.rules[0].conditions[0].value = 'valid';
  doc.blocked.push('overflow@example.com'); expectInvalid(doc);
});

test('redirect limit counts unique addresses, is capped at the measured 100 by default', () => {
  const doc = empty();
  doc.rules = Array.from({ length: 100 }, (_, i) => rule(i, { forward: [`member${i}@example.com`] }));
  assert.equal(validateDocument(doc, context), doc);
  doc.rules[0].actions.forward.push('MEMBER0@EXAMPLE.COM');
  assert.equal(validateDocument(doc, context), doc);
  doc.rules[0].actions.forward.push('overflow@example.com');
  expectInvalid(doc, 'TOO_MANY_FORWARDS');
  expectInvalid(documentWithForward(), 'TOO_MANY_FORWARDS', { ...context, maxRedirects: 0 });
});
function documentWithForward() { const doc = document(); doc.rules[0].actions = { forward: ['user@example.com'] }; return doc; }

test('generated script is bounded to one MiB in UTF-8 bytes including metadata', () => {
  const doc = document(); const path = '가'.repeat(MAX_SCRIPT_BYTES / 3);
  doc.rules[0].actions = { move: path };
  assert.throws(() => generateScript(doc, { ...context, folders: [{ path }] }), error => error.statusCode === 422 && error.reason === 'script_too_large');
});

test('body or HASH tampering yields modified_externally and preserves valid data', () => {
  const doc = document(); const script = generateScript(doc, context);
  for (const changed of [script.replace('addflag', 'removeflag'), script.replace(/# WEBMAIL-HASH [a-f0-9]/, '# WEBMAIL-HASH z'), `${script}# external\n`, script.replace(/# WEBMAIL-HASH [a-f0-9]{64}\n/, '')]) {
    const parsed = parseScript(changed);
    assert.equal(parsed.state, 'modified_externally');
    assert.deepEqual(parsed.doc, doc);
  }
});

test('broken data decoding, schema, header and UTF-8 yield damaged', () => {
  const script = generateScript(document(), context);
  const invalidDoc = document(); invalidDoc.rules[0].actions = { move: 'Archive', trash: true };
  for (const changed of [null, '', 'arbitrary script', script.replace('# WEBMAIL-DATA ', '# WEBMAIL-DATA !'), script.replace(/# WEBMAIL-DATA [^\n]+\n/g, ''), envelope('{broken'), envelope(invalidDoc), `${MAGIC}\n# WEBMAIL-DATA _w\n# WEBMAIL-HASH ${'0'.repeat(64)}\n`, 'a'.repeat(MAX_SCRIPT_BYTES + 1)]) {
    assert.deepEqual(parseScript(changed), { state: 'damaged', doc: null, rev: null });
  }
});

test('state classification covers all seven states and the approved inactive-without-active case', () => {
  const script = generateScript(document(), context);
  const cases = [
    [{}, 'none'],
    [{ activeName: 'legacy', importReport: { format: 'gmail2sieve', rules: [], items: [{ status: 'changed' }] } }, 'import_pending'],
    [{ activeName: 'legacy', importReport: { format: 'rainloop', rules: [], items: [{ status: 'same' }] } }, 'import_pending'],
    [{ activeName: 'legacy', importReport: { format: 'unknown', items: [] } }, 'import_blocked'],
    [{ activeName: 'legacy', importReport: { format: 'gmail2sieve', items: [{ status: 'unconvertible' }] } }, 'import_blocked'],
    [{ activeName: 'legacy' }, 'import_blocked'],
    [{ activeName: 'webmail-rules', webmailScript: script }, 'ok'],
    [{ activeName: 'legacy', webmailScript: script }, 'inactive_other'],
    [{ activeName: null, webmailScript: script }, 'inactive_other'],
    [{ activeName: 'webmail-rules', webmailScript: `${script}# changed\n` }, 'modified_externally'],
    [{ activeName: 'webmail-rules', webmailScript: '' }, 'damaged']
  ];
  for (const [input, expected] of cases) {
    const snapshot = structuredClone(input);
    const result = classifyState(input);
    assert.equal(result.state, expected);
    assert.equal(result.activeName, input.activeName ?? null);
    assert.deepEqual(input, snapshot);
  }
});

test('removed folders and changed domain policies warn without damaging stored documents', () => {
  const doc = structuredClone(fixtures[14].doc);
  const script = generateScript(doc, context);
  assert.equal(parseScript(script).state, 'ok');
  assert.deepEqual(classifyState({ activeName: 'webmail-rules', webmailScript: script }).missingFolders, ['Projects/팀']);
  assert.deepEqual(classifyState({ activeName: 'webmail-rules', webmailScript: script, folders: context.folders }).missingFolders, []);
  expectInvalid(doc, 'FORWARD_EXTERNAL', { ...context, internalDomains: [] });
});


test('vacation body: LF, blank lines, dot lines and escaped quotes roundtrip; CRLF normalizes', () => {
  for (const body of ['첫 줄\n\n마지막 줄', '.\n.leading\n..two\n"quoted" and \\ slash\n', 'first\r\n\r\n.last']) {
    const doc = empty();
    doc.vacation = { enabled: true, start: null, end: null, subject: '부재중', body };
    const expected = body.replace(/\r\n/g, '\n');
    validateDocument(doc, context);
    assert.equal(doc.vacation.body, expected);
    const script = generateScript(doc, context);
    const quoted = '"' + expected.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    assert.ok(script.includes(`:addresses ["user@example.com", "alias@alias.example.com"] ${quoted};`));
    const parsed = parseScript(script);
    assert.equal(parsed.state, 'ok');
    assert.deepEqual(parsed.doc, doc);
    assert.equal(generateScript(parsed.doc, context), script);
    assert.equal(generateScript(doc, context), script);
  }
});

test('vacation body: other controls stay 422, LF is allowed only in body, normalized limit is 4000', () => {
  for (const value of ['x\r', 'x\t', 'x\0', 'x\u000b', 'x\u001f', 'x\u007f', 'x\u0085', '${wm_stop}', '\ud800']) {
    const doc = empty(); doc.vacation.body = value; expectInvalid(doc);
  }
  const doc = empty(); doc.vacation.subject = 'first\nsecond'; expectInvalid(doc);
  doc.vacation.subject = '';
  doc.vacation.body = 'a'.repeat(3999) + '\r\n';
  validateDocument(doc, context);
  assert.equal([...doc.vacation.body].length, 4000);
  doc.vacation.body += 'a'; expectInvalid(doc);
});
