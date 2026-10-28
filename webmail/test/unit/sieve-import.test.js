import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { importScript, importPolicy, rulesDocument } from '../../server/sieve/import.js';
import { parseScript } from '../../server/sieve/parse.js';
import { generateScript, hashBody } from '../../server/sieve/generate.js';
import { validateDocument } from '../../server/sieve/model.js';
import { classifyState } from '../../server/sieve/state.js';

const fixtureRoot = new URL('../fixtures/sieve/', import.meta.url);
const read = name => readFile(new URL(name, fixtureRoot), 'utf8');
const path = name => fileURLToPath(new URL(name, fixtureRoot));
const policy = JSON.parse(await read('import-policy.json'));
const unchecked = JSON.parse(await read('import-policy-unchecked.json'));
const cliRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = args => spawnSync(process.execPath, ['bin/webmail-rules.js', ...args], { cwd: cliRoot, encoding: 'utf8', env: { PATH: process.env.PATH } });
let temp;
before(async () => { temp = await mkdtemp(join(tmpdir(), 'webmail-w14-import-')); });
after(async () => { await rm(temp, { recursive: true, force: true }); });

const cases = [
  ['gmail-basic', 'gmail2sieve', ['same', 'same'], 2],
  ['gmail-labels', 'gmail2sieve', ['changed', 'changed'], 2],
  ['gmail-unsupported', 'gmail2sieve', ['changed', 'unconvertible', 'unconvertible'], 1],
  ['gmail-wildcards', 'gmail2sieve', ['same', 'same', 'unconvertible'], 2],
  ['gmail-mixed', 'gmail2sieve', ['changed', 'same', 'unconvertible', 'unconvertible'], 2],
  ['rainloop-move', 'rainloop', ['same'], 1],
  ['rainloop-actions', 'rainloop', ['changed', 'same'], 2],
  ['rainloop-forward', 'rainloop', ['same', 'same', 'unconvertible'], 2],
  ['unknown-one', 'unknown', ['unconvertible'], 0],
  ['unknown-two', 'unknown', ['unconvertible', 'unconvertible'], 0],
];
for (const [name, format, statuses, count] of cases) {
  test(`import fixture ${name}: every source block has one report item`, async () => {
    const source = await read(`${name}.sieve`);
    const report = importScript(source, { name: name.startsWith('rainloop') ? 'rainloop.user' : 'legacy', policy });
    assert.equal(report.format, format);
    assert.equal(report.items.length, statuses.length);
    assert.deepEqual(report.items.map(item => item.status), statuses);
    assert.deepEqual(report.items.map(item => item.n), statuses.map((_, i) => i + 1));
    assert.equal(report.rules.length, count);
    assert.equal(report.items.filter(item => ['same', 'changed'].includes(item.status)).length, count);
    assert.equal(report.uncheckedFolders, 0);
    assert.equal(validateDocument(rulesDocument(report.rules), policy).rules.length, count);
    assert.equal(await read(`${name}.sieve`), source);
    if (format === 'gmail2sieve') assert.equal((source.match(/^# \[\d+\]/gm) ?? []).length, report.items.length);
    if (format === 'rainloop') assert.equal((source.match(/^BEGIN:FILTER:/gm) ?? []).length, report.items.length);
    for (const item of report.items) {
      assert.ok(item.summary); assert.ok(Array.isArray(item.changes));
      if (item.status === 'unconvertible') assert.ok(item.reason);
      if (item.status === 'changed') assert.ok(item.changes.length);
    }
    const state = classifyState({ activeName: 'legacy', importReport: report });
    assert.equal(state.state, format === 'unknown' || count === 0 ? 'import_blocked' : 'import_pending');
  });
}

test('all five Gmail fixtures are generated from synthetic XML by the repository converter', async () => {
  const require = createRequire(import.meta.url);
  const core = require('../../../tools/gmail2sieve/core.js');
  const dom = new JSDOM('');
  try {
    const parser = new dom.window.DOMParser();
    for (const name of ['basic', 'labels', 'unsupported', 'wildcards', 'mixed']) {
      const filters = core.parseFiltersXml(await read(`gmail-${name}.xml`), parser);
      const output = core.convert(filters, { now: '2026-10-15T00:00:00Z' });
      assert.equal(output.script, await read(`gmail-${name}.sieve`));
    }
  } finally { dom.window.close(); }
});

test('Gmail import discloses label copy removal, first-folder behavior and spam exception removal', async () => {
  const labels = importScript(await read('gmail-labels.sieve'), { policy });
  for (const item of labels.items) {
    assert.ok(item.changes.some(change => change.includes('POP3·Gmail')));
    assert.ok(item.changes.includes('여러 라벨이 맞으면 첫 폴더 하나에만 들어가요'));
  }
  assert.deepEqual(labels.rules[0].conditions, [{ field: 'from', op: 'start', value: 'promo' }]);
  const special = importScript(await read('gmail-wildcards.sieve'), { policy });
  assert.deepEqual(special.items[2].changes, ['스팸 예외 처리는 옮기지 않아요']);
  assert.equal(special.rules.length, 2);
  assert.deepEqual(special.rules[0].conditions, [{ field: 'from', op: 'matches', value: 'a*b' }]);
  assert.equal(special.items[2].reason, '동작이 없어 반영 안 됨');
  const mixed = importScript(await read('gmail-mixed.sieve'), { policy });
  assert.deepEqual(mixed.rules[0].actions, { move: 'Archive' });
  assert.deepEqual(mixed.rules[0].conditions, [
    { field: 'from', op: 'has', value: 'sender@example.com' },
    { match: 'any', conditions: [{ field: 'subject', op: 'has', value: 'a' }, { field: 'subject', op: 'has', value: 'b' }] },
  ]);
  assert.ok(mixed.items[0].changes.some(change => change.includes('받은편지함')));
  assert.deepEqual(mixed.rules[1].actions, { trash: true });
  assert.deepEqual(mixed.rules[1].conditions, [{ field: 'from', op: 'not', value: 'blocked@example.com' }]);
  assert.ok(mixed.items[2].reason.includes('원래도 변환되지 않은'));
});

test('SnappyMail metadata preserves disabled, read, stop and mapped Header conditions', async () => {
  const moved = importScript(await read('rainloop-move.sieve'), { name: 'rainloop.user', policy });
  assert.deepEqual(moved.rules[0].actions, { read: true, move: 'Archive' });
  assert.equal(moved.rules[0].stop, true);
  const actions = importScript(await read('rainloop-actions.sieve'), { name: 'rainloop.user', policy });
  assert.deepEqual(actions.rules[0].conditions, [{ field: 'subject', op: 'eq', value: 'delete-me' }]);
  assert.deepEqual(actions.rules[0].actions, { trash: true });
  assert.equal(actions.rules[1].enabled, false);
  assert.deepEqual(actions.rules[1].actions, { read: true });
  assert.deepEqual(actions.rules[1].conditions, [{ field: 'subject', op: 'not', value: 'newsletter' }]);
  const forward = importScript(await read('rainloop-forward.sieve'), { name: 'rainloop.user', policy });
  assert.deepEqual(forward.rules[0].actions, { forward: ['member@example.com'] });
  assert.deepEqual(forward.rules[1].actions, { forward: ['member@outside.example.com'] });
  assert.ok(forward.items[2].reason.includes('헤더와 Sieve 본문'));
});

test('approved SnappyMail Keep and Flag handling relies only on header metadata', async () => {
  const source = await read('rainloop-move.sieve');
  const changeHeader = change => source.replace(/BEGIN:HEADER\n([\s\S]*?)\nEND:HEADER/, (_, value) => {
    const json = JSON.parse(Buffer.from(value.replace(/\s/g, ''), 'base64').toString('utf8'));
    change(json);
    return `BEGIN:HEADER\n${Buffer.from(JSON.stringify(json)).toString('base64')}\nEND:HEADER`;
  });
  const moved = importScript(changeHeader(json => { json.Keep = true; }), { name: 'rainloop.user', policy });
  assert.equal(moved.items[0].status, 'changed');
  assert.deepEqual(moved.items[0].changes, ['받은편지함에 안 남아요']);
  assert.deepEqual(moved.rules[0].actions, { read: true, move: 'Archive' });
  assert.equal(moved.rules[0].stop, true);
  const onlyKeep = importScript(changeHeader(json => { json.Keep = true; json.ActionType = 'None'; json.ActionValue = ''; json.MarkAsRead = false; json.Stop = false; }), { name: 'rainloop.user', policy });
  assert.equal(onlyKeep.items[0].status, 'unconvertible');
  assert.equal(onlyKeep.items[0].reason, '동작 없음');
  assert.equal(onlyKeep.rules.length, 0);
  const foreignFlag = importScript(source.replace('addflag "\\\\Seen";', 'addflag "\\\\Seen"; addflag "\\\\Flagged";'), { name: 'rainloop.user', policy });
  assert.equal(foreignFlag.items[0].status, 'unconvertible');
  assert.equal(foreignFlag.rules.length, 0);
});

test('format detection accepts Gmail after hash comments and requires SnappyMail source name', async () => {
  assert.equal(importScript(`# other\n${await read('gmail-basic.sieve')}`, { policy }).format, 'gmail2sieve');
  assert.equal(importScript(await read('rainloop-move.sieve'), { name: 'different', policy }).format, 'unknown');
  assert.equal(importScript((await read('rainloop-move.sieve')).replace(/\n/g, '\r\n'), { name: 'rainloop.user', policy }).format, 'rainloop');
});

test('foreign executable content outside known blocks is never silently dropped', async () => {
  for (const [file, name] of [['gmail-basic', 'legacy'], ['rainloop-move', 'rainloop.user']]) {
    const source = await read(`${file}.sieve`);
    const report = importScript(`${source}\nif true { discard; }`, { name, policy });
    assert.ok(report.items.some(item => item.status === 'unconvertible'));
  }
  const alteredFooter = (await read('gmail-basic.sieve')).replace('discard;', 'keep;');
  assert.ok(importScript(alteredFooter, { policy }).items.some(item => item.status === 'unconvertible'));
});

test('damaged SnappyMail header remains represented and cannot be activated automatically', async () => {
  const source = (await read('rainloop-move.sieve')).replace('BEGIN:HEADER\n', 'BEGIN:HEADER\n!');
  const report = importScript(source, { name: 'rainloop.user', policy });
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].status, 'unconvertible');
  assert.equal(report.rules.length, 0);
});

test('missing folder policy adds warnings without changing import status; explicit empty list rejects move', async () => {
  const source = await read('gmail-basic.sieve');
  const report = importScript(source, { policy: unchecked });
  assert.deepEqual(report.items.map(item => item.status), ['same', 'same']);
  assert.equal(report.uncheckedFolders, 2);
  assert.ok(report.items.every(item => item.warnings.includes('폴더 존재 미확인')));
  const denied = importScript(source, { policy: { internalDomains: ['example.com'], folders: [] } });
  assert.ok(denied.items.every(item => item.status === 'unconvertible'));
  assert.equal(denied.rules.length, 0);
});

test('external forwarding imports with mandatory spam exclusion; forbidden folders still fail', async () => {
  const imported = importScript(await read('rainloop-forward.sieve'), { name: 'rainloop.user', policy: { internalDomains: [] } });
  assert.equal(imported.rules.length, 2);
  assert.ok(generateScript(rulesDocument(imported.rules)).includes('if header :contains "X-Spam-Flag" "YES" { stop; }'));
  const original = JSON.parse(await read('import-rules.json'));
  for (const folder of ['INBOX', 'Trash', 'Junk', 'Drafts', 'Shared/team', 'WebmailVirtual/AllMail']) {
    const doc = structuredClone(original); doc.rules[0].actions.move = folder;
    assert.throws(() => generateScript(doc, importPolicy(unchecked)), { code: 'RULES_INVALID' });
  }
  const doc = structuredClone(original); doc.rules[0].actions.forward = ['member@outside.example.com'];
  assert.ok(generateScript(doc, importPolicy(unchecked)).includes('if header :contains "X-Spam-Flag" "YES" { stop; }'));
});

test('policy permissions are explicit and cannot be inferred or overridden by extra fields', () => {
  for (const bad of [undefined, {}, { internalDomains: 'example.com' }, { internalDomains: ['bad domain'] }, { internalDomains: [], checkPolicy: false }, { internalDomains: [], folders: ['Archive'] }, { internalDomains: [], addresses: 'user@example.com' }]) assert.throws(() => importPolicy(bad));
});

test('unsafe imported values fail W10 validation and aggregate rule limits keep the first 500', async () => {
  const source = await read('gmail-basic.sieve');
  const unsafe = source.replace('"sender@example.com"', '"${wm_stop}"');
  const report = importScript(unsafe, { policy });
  assert.equal(report.items[0].status, 'unconvertible');
  const single = /(# \[1\][\s\S]*?)(?=\n# \[2\])/.exec(source)[1];
  const many = source.slice(0, source.indexOf('# [1]'))
    + Array.from({ length: 501 }, (_, i) => single.replace('# [1]', `# [${i + 1}]`)).join('\n')
    + source.slice(source.indexOf('# 받은편지함 처리'));
  const tooMany = importScript(many, { policy });
  assert.equal(tooMany.items.length, 501);
  assert.equal(tooMany.rules.length, 500);
  assert.ok(tooMany.items.slice(0, 500).every(item => item.status === 'same'));
  assert.equal(tooMany.items[500].status, 'unconvertible');
  assert.equal(tooMany.items[500].reason, '규칙 500개 한도');
});

test('CLI import and gen both exit zero, preserve the source and emit usable outputs', async () => {
  const before = await read('gmail-basic.sieve');
  const imported = cli(['import', path('gmail-basic.sieve'), '--policy', path('import-policy.json')]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).rules.length, 2);
  assert.ok(imported.stderr.includes('폴더 존재 미확인: 0개'));
  assert.equal(await read('gmail-basic.sieve'), before);
  const generated = cli(['gen', path('import-rules.json'), '--policy', path('import-policy.json')]);
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(parseScript(generated.stdout).state, 'ok');
  assert.deepEqual(parseScript(generated.stdout).doc, JSON.parse(await read('import-rules.json')));
  const snappy = cli(['import', path('rainloop-move.sieve'), '--policy', path('import-policy.json'), '--name', 'rainloop.user']);
  assert.equal(snappy.status, 0, snappy.stderr);
  assert.equal(JSON.parse(snappy.stdout).format, 'rainloop');
});

test('CLI missing folders reports warning items and count while keeping stdout machine-readable', () => {
  const imported = cli(['import', path('gmail-basic.sieve'), '--policy', path('import-policy-unchecked.json')]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).uncheckedFolders, 2);
  const generated = cli(['gen', path('import-rules.json'), '--policy', path('import-policy-unchecked.json')]);
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(parseScript(generated.stdout).state, 'ok');
  assert.ok(generated.stderr.includes('폴더 존재 미확인: 1개'));
  assert.ok(generated.stderr.includes('"warnings":["폴더 존재 미확인"]'));
});

test('CLI refuses missing domains and vacation without sending addresses with exit two', async () => {
  const missing = join(temp, 'missing.json'); await writeFile(missing, '{}');
  for (const options of [[], ['--policy', missing]]) {
    const result = cli(['gen', path('import-rules.json'), ...options]);
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.ok(result.stderr.includes('internalDomains'));
  }
  const policyFile = join(temp, 'policy.json'); await writeFile(policyFile, JSON.stringify({ internalDomains: ['example.com'], folders: policy.folders }));
  const doc = JSON.parse(await read('import-rules.json')); doc.vacation.enabled = true;
  const input = join(temp, 'vacation.json'); await writeFile(input, JSON.stringify(doc));
  const result = cli(['gen', input, '--policy', policyFile]);
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.statusCode, 422);
  assert.equal(JSON.parse(result.stderr).error.path, 'addresses');
});

test('CLI rejects invalid options, unreadable files, malformed JSON and invalid UTF-8 without echoing content', async () => {
  const malformed = join(temp, 'malformed.json'); await writeFile(malformed, '{"synthetic-private-value":');
  const invalidUtf8 = join(temp, 'invalid.sieve'); await writeFile(invalidUtf8, Buffer.from([0xff]));
  for (const args of [[], ['publish', 'example'], ['gen', path('import-rules.json'), '--unknown', 'x'], ['gen', malformed, '--policy', path('import-policy.json')], ['gen', join(temp, 'absent'), '--policy', path('import-policy.json')], ['import', invalidUtf8, '--policy', path('import-policy.json')]]) {
    const result = cli(args);
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('synthetic-private-value'), false);
  }
  const help = cli(['--help']); assert.equal(help.status, 0); assert.ok(help.stdout.includes('doveadm mailbox list -u <주소>'));
});

test('a generated envelope over 1MB drops the overflow and trailing source blocks', async () => {
  const source = (await read('gmail-basic.sieve')).replace('fileinto :create :copy "Archive";', `fileinto :create :copy "${'A'.repeat(500000)}";`);
  const report = importScript(source, { policy: unchecked });
  assert.equal(report.rules.length, 0); assert.equal(report.items[0].status, 'unconvertible');
  assert.equal(report.items[0].reason, '생성 스크립트 1MB 한도'); assert.equal(report.items[1].status, 'unconvertible');
  assert.equal(report.items[1].reason, report.items[0].reason);
  assert.ok(Buffer.byteLength(generateScript(rulesDocument(report.rules), importPolicy(unchecked))) <= 1024 * 1024);
});


test('import documents select the minimum wire version without changing stage-one rules', () => {
  const base = { id: 'version1', enabled: true, match: 'all', conditions: [{ field: 'subject', op: 'has', value: 'synthetic' }], actions: { read: true }, stop: false };
  assert.equal(rulesDocument([]).v, 1); assert.equal(rulesDocument([base]).v, 1);
  assert.equal(rulesDocument([{ ...base, conditions: [{ field: 'subject', op: 'matches', value: '*synthetic*' }] }]).v, 2);
  assert.equal(rulesDocument([{ ...base, conditions: [{ match: 'any', conditions: base.conditions }] }]).v, 2);
  assert.equal(rulesDocument([undefined]).v, 1);
});

test('all pattern and validation failures in server import reports use Korean reasons', async () => {
  const source = await read('gmail-wildcards.sieve');
  for (const pattern of ['a?b', 'a' + '\\', '*a'.repeat(21), 'unsafe${value}']) {
    const input = source.replace('"a*b"', '"' + pattern.replaceAll('\\', '\\\\') + '"');
    const report = importScript(input, { policy });
    assert.equal(report.items[0].status, 'unconvertible');
    assert.match(report.items[0].reason, /[가-힣]/);
    assert.doesNotMatch(report.items[0].reason, /\b[a-z]+_[a-z_]+\b/);
  }
});


test('CLI regen preserves exact metadata bytes and regenerates first-match body and hash', async () => {
  const doc = JSON.parse(await read('import-rules.json'));
  doc.v = 2; doc.rev = 17;
  doc.rules[0].stop = false;
  const current = generateScript(doc, importPolicy(policy));
  // A valid old generator body, with deliberately noncanonical v2 metadata.
  const body = current.slice(current.indexOf('require [')).replace('    set "wm_stop" "1";\n', '');
  const encoded = Buffer.from(JSON.stringify(doc, null, 2)).toString('base64url');
  const metadata = encoded.match(/.{1,73}/g).map(chunk => `# WEBMAIL-DATA ${chunk}`).join('\n');
  const source = `${current.split('\n')[0]}\n${metadata}\n# WEBMAIL-HASH ${hashBody(body)}\n${body}`;
  assert.equal(parseScript(source).state, 'ok');
  const input = join(temp, 'existing.sieve'); await writeFile(input, source);
  const result = cli(['regen', input, '--policy', path('import-policy.json')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseScript(result.stdout).state, 'ok');
  assert.deepEqual(parseScript(result.stdout).doc, doc);
  assert.equal(result.stdout.slice(0, result.stdout.indexOf('# WEBMAIL-HASH ')), source.slice(0, source.indexOf('# WEBMAIL-HASH ')));
  assert.equal(result.stdout.slice(result.stdout.indexOf('require [')), current.slice(current.indexOf('require [')));
  assert.notEqual(result.stdout.match(/# WEBMAIL-HASH (.+)/)[1], hashBody(body));
  assert.equal(await readFile(input, 'utf8'), source);
});

test('CLI regen rejects modified, damaged and newer scripts without stdout', async () => {
  const doc = JSON.parse(await read('import-rules.json'));
  const generated = generateScript(doc, importPolicy(policy));
  const newer = {...doc, v:3};
  const encoded = Buffer.from(JSON.stringify(newer)).toString('base64url');
  const sources = {
    modified_externally: `${generated}# external edit\n`,
    damaged: 'invalid script',
    newer_version: generated.replace(/(?:# WEBMAIL-DATA [^\n]+\n)+/, encoded.match(/.{1,120}/g).map(chunk => `# WEBMAIL-DATA ${chunk}\n`).join('')),
  };
  for (const [state, source] of Object.entries(sources)) {
    const input = join(temp, `${state}.sieve`); await writeFile(input, source);
    const result = cli(['regen', input, '--policy', path('import-policy.json')]);
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.ok(JSON.parse(result.stderr).error.message.includes(state));
  }
});


const wordTest = value => `anyof(header :contains ["subject", "from", "to", "cc"] "${value}", body :text :contains "${value}")`;
const wordGroup = (value, negative = false) => ({ match: negative ? 'all' : 'any', conditions: ['subject', 'from', 'to', 'body'].map(field => ({ field, op: negative ? 'not' : 'has', value })) });
async function importWordExpression(expression) {
  const source = (await read('gmail-basic.sieve')).replace('header :contains "from" "sender@example.com"', expression);
  return importScript(source, { policy });
}
for (const negative of [false, true]) test(`gmail2sieve whole-message word expands exactly: negative=${negative}`, async () => {
  const report = await importWordExpression(`${negative ? 'not ' : ''}${wordTest('견적')}`);
  assert.equal(report.rules.length, 2);
  assert.equal(report.items[0].status, 'same'); assert.deepEqual(report.items[0].changes, []);
  assert.deepEqual({ match: report.rules[0].match, conditions: report.rules[0].conditions }, wordGroup('견적', negative));
  assert.equal(rulesDocument(report.rules).v, 2);
  assert.equal(parseScript(generateScript(rulesDocument(report.rules), policy)).state, 'ok');
});

test('gmail2sieve multiple words preserve outer AND/OR and NOT without not nodes', async () => {
  const cases = [
    [`allof(${wordTest('a')}, ${wordTest('b')})`, { match: 'all', conditions: [wordGroup('a'), wordGroup('b')] }],
    [`anyof(${wordTest('a')}, ${wordTest('b')})`, { match: 'any', conditions: [...wordGroup('a').conditions, ...wordGroup('b').conditions] }],
    [`not anyof(${wordTest('a')}, ${wordTest('b')})`, { match: 'all', conditions: [...wordGroup('a', true).conditions, ...wordGroup('b', true).conditions] }],
    [`not allof(${wordTest('a')}, ${wordTest('b')})`, { match: 'any', conditions: [wordGroup('a', true), wordGroup('b', true)] }],
    [`not not ${wordTest('a')}`, wordGroup('a')],
  ];
  for (const [expression, expected] of cases) {
    const report = await importWordExpression(expression);
    assert.equal(report.rules.length, 2, expression);
    assert.deepEqual({ match: report.rules[0].match, conditions: report.rules[0].conditions }, expected);
    assert.equal(JSON.stringify(report.rules[0]).includes('"not":'), false);
    validateDocument(rulesDocument(report.rules), policy);
  }
});

for (const expression of [
  'body :text :contains "a"',
  wordTest('a').replace('body :text :contains "a"', 'body :text :contains "b"'),
  wordTest('a').replace('"subject", "from", "to", "cc"', '"subject", "from", "to"'),
  wordTest('a').replace(':text', ':raw'),
  wordTest('a').replace('body :text :contains', 'body :text :is'),
  wordTest('a').replace('anyof', 'allof'),
  wordTest('a').replace('body :text :contains "a"', 'body :text :contains ["a"]'),
  'not header :contains ["to", "cc"] "a"',
  'header :contains "to" "a"',
]) test(`noncanonical body/recipient import remains unsupported: ${expression}`, async () => {
  const report = await importWordExpression(expression);
  assert.equal(report.items[0].status, 'unconvertible'); assert.equal(report.rules.length, 1);
});

test('whole-message expansion still rejects existing depth and count limit overflow', async () => {
  const expressions = [
    `anyof(${['a','b','c'].map(wordTest).join(', ')})`,
    `allof(${['a','b','c','d','e','f'].map(wordTest).join(', ')})`,
    `allof(${wordTest('a')}, anyof(header :contains "subject" "b", allof(header :contains "from" "c", header :contains "subject" "d")))`,
  ];
  for (const expression of expressions) {
    const report = await importWordExpression(expression);
    assert.equal(report.items[0].status, 'unconvertible'); assert.equal(report.rules.length, 1);
  }
});

test('synthetic XML produced by repository gmail2sieve imports include and exclude words', () => {
  const require = createRequire(import.meta.url); const core = require('../../../tools/gmail2sieve/core.js');
  const dom = new JSDOM('');
  try {
    const xml = '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006"><entry><apps:property name="hasTheWord" value="견적"/><apps:property name="doesNotHaveTheWord" value="광고"/><apps:property name="label" value="Archive"/><apps:property name="shouldArchive" value="true"/></entry></feed>';
    const output = core.convert(core.parseFiltersXml(xml, new dom.window.DOMParser()), { now: '2026-10-27T00:00:00Z' });
    const report = importScript(output.script, { policy });
    assert.equal(report.rules.length, 1); assert.equal(report.items[0].status, 'same');
    assert.deepEqual(report.rules[0].conditions, [wordGroup('견적'), ...wordGroup('광고', true).conditions]);
  } finally { dom.window.close(); }
});


test('gmail2sieve header allows preceding blank and hash-comment lines only', async () => {
  const source = await read('gmail-basic.sieve');
  const expected = importScript(source, { name: 'legacy', policy }).rules.map(({ id, ...rule }) => rule);
  for (const prefix of ['', '\n\n', '# synthetic comment\n\n  # another comment\n', '# [1] 메모\n']) {
    const report = importScript(prefix + source, { name: 'legacy', policy });
    assert.equal(report.format, 'gmail2sieve');
    assert.equal(report.rules.length, 2);
    assert.deepEqual(report.items.map(item => item.status), ['same', 'same']);
    assert.deepEqual(report.rules.map(({ id, ...rule }) => rule), expected);
  }
  for (const prefix of ['keep;\n', '# comment\nrequire ["fileinto"];\n', 'sieve script: legacy\n']) {
    assert.equal(importScript(prefix + source, { name: 'legacy', policy }).format, 'unknown');
  }
});
