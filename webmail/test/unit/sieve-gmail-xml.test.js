import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import jsdom from 'jsdom';
import { readGmailXml } from '../../server/sieve/gmail-xml.js';
import { convertGmailEntries } from '../../server/sieve/import-xml.js';
import { parseGmailSearch, tokenize } from '../../server/sieve/gmail-search.js';
import { validateDocument } from '../../server/sieve/model.js';
import { generateScript } from '../../server/sieve/generate.js';

const policy = { internalDomains: ['example.com'] };
const folders = [{ path: 'Archive', specialUse: '\\Archive' }, { path: 'News' }];
const escape = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const entryXml = props => `<entry>${props.map(([name, value]) => `<apps:property name="${escape(name)}" value="${escape(value)}"/>`).join('')}</entry>`;
const feed = body => `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006">${body}</feed>`;
const entries = rows => rows.map((props, i) => ({ n: i + 1, props }));
const convert = (rows, options = {}) => convertGmailEntries(entries(rows), { policy, folders, stage: 1, ...options });
const one = (props, options) => convert([props], options).items[0];
const props = value => Object.entries(value);
const read = name => readFile(new URL(`../fixtures/gmail-xml/${name}`, import.meta.url), 'utf8');
const valid = { from: 'notice@example.com', shouldStar: 'true' };
const doc = rules => ({ v: 1, rev: 0, rules, blocked: [], vacation: { enabled: false, start: null, end: null, subject: '', body: '' } });
const xmlError = (xml, reason) => assert.throws(() => readGmailXml(xml), error => error.statusCode === 422 && error.code === 'XML_INVALID' && error.detail.reason === reason);

test('Gmail XML fixture: URI prefixes, original values, valid v1 rules, deterministic conversion', async () => {
  const decoded = readGmailXml(await read('basic.xml'));
  assert.equal(decoded.entries.length, 2);
  assert.deepEqual(decoded.entries[0], { n: 1, props: props({ from: 'notice@example.com', shouldMarkAsRead: 'true', shouldStar: 'true' }) });
  const options = { policy, folders, stage: 1 };
  const report = convertGmailEntries(decoded.entries, options);
  assert.deepEqual(report.items.map(item => item.status), ['same', 'same']);
  assert.deepEqual(report.rules[0].actions, { read: true, star: true });
  assert.equal(report.rules[1].conditions[0].value, '정기 안내');
  assert.equal(validateDocument(doc(report.rules), { ...policy, folders }).v, 1);
  assert.deepEqual(convertGmailEntries(decoded.entries, options), report);
});

test('DTD, declarations and entity amplification are rejected before DOM construction', async () => {
  const spy = mock.method(jsdom, 'JSDOM', function () { throw new Error('DOM must not be constructed'); });
  try {
    for (const declaration of ['<!DOCTYPE feed>', '<!ENTITY a "x">', '<!ELEMENT feed ANY>', '<!ATTLIST feed x CDATA #IMPLIED>', '<!doctype feed>']) xmlError(`${declaration}${feed('<entry/>')}`, 'dtd');
    const bomb = await read('entities.xml');
    assert.ok(Buffer.byteLength(bomb) < 2048);
    xmlError(bomb, 'dtd');
    assert.equal(spy.mock.callCount(), 0);
  } finally { spy.mock.restore(); }
});

test('byte and UTF-8 validation: 512KiB boundary, one BOM, declaration encoding', () => {
  xmlError('a'.repeat(512 * 1024 + 1), 'too_large');
  xmlError('가'.repeat(Math.ceil(512 * 1024 / 3)), 'too_large');
  xmlError('\ud800', 'not_utf8');
  xmlError(null, 'not_utf8');
  xmlError(`<?xml version="1.0" encoding="ISO-8859-1"?>${feed('<entry/>')}`, 'not_utf8');
  const minimal = feed('<entry/>');
  const boundary = minimal.replace('<entry/>', `<entry/><!--${' '.repeat(512 * 1024 - minimal.length - 7)}-->`);
  assert.equal(Buffer.byteLength(boundary), 512 * 1024);
  assert.equal(readGmailXml(boundary).entries.length, 1);
  assert.equal(readGmailXml(`\uFEFF<?xml version="1.0" encoding="UTF-8"?>${minimal}`).entries.length, 1);
  xmlError(`\uFEFF\uFEFF${minimal}`, 'malformed');
});

test('processing instructions and malformed XML are rejected', () => {
  for (const xml of [`<?work data?>${feed('<entry/>')}`, feed('<entry/><?work data?>'), `<?xml version="1.0"?><?xml version="1.0"?>${feed('<entry/>')}`]) xmlError(xml, 'pi');
  for (const xml of ['<feed>', feed('<entry>'), feed('<entry x="1" x="2"/>'), feed('<entry>&undefined;</entry>')]) xmlError(xml, 'malformed');
});

test('only direct namespace-qualified Atom entries and Google properties count', () => {
  for (const xml of ['<feed><entry/></feed>', '<entry xmlns="http://www.w3.org/2005/Atom"/>', feed(''), feed('<other><entry/></other>'), '<feed xmlns="https://example.com/"><entry/></feed>']) xmlError(xml, 'not_gmail');
  const decoded = readGmailXml(feed('<entry><property xmlns="https://example.com/" name="from" value="wrong"/><content><apps:property name="from" value="nested"/></content><apps:property name="from" value="right"/></entry>'));
  assert.deepEqual(decoded.entries, [{ n: 1, props: [['from', 'right']] }]);
  xmlError(feed('<entry/>'.repeat(1001)), 'too_many_entries');
  assert.equal(readGmailXml(feed('<entry/>'.repeat(1000))).entries.length, 1000);
});

test('duplicate, unknown, missing and excessive properties fail only their own entry', () => {
  const rows = [props(valid), [...props(valid), ['from', 'other@example.com']], [...props(valid), ['unknown', 'x']]];
  const parsed = readGmailXml(feed(rows.map(entryXml).join('') + '<entry><apps:property name="from"/></entry>'));
  const report = convertGmailEntries(parsed.entries, { policy, folders, stage: 1 });
  assert.deepEqual(report.items.map(item => item.status), ['same', 'no', 'no', 'no']);
  assert.match(report.items[1].reason, /같은 설정/);
  assert.match(report.items[2].reason, /알 수 없는 설정/);
  assert.match(report.items[3].reason, /name·value/);
  assert.match(one(Array.from({ length: 33 }, () => ['from', 'x'])).reason, /32개/);
  assert.match(one(props({ ...valid, subject: 'x'.repeat(2001) })).reason, /2000자/);
  assert.match(one(props({ ...valid, shouldStar: 'yes' })).reason, /참·거짓/);
  assert.equal(one(props({ ...valid, shouldTrash: 'false' })).status, 'same');
  assert.deepEqual(one(props({ ...valid, shouldTrash: 'false' })).rule.actions, { star: true });
});

const cases = [
  ['from', { from: 'notice@example.com' }, { shouldStar: 'true' }, 'same', 'from'],
  ['to', { to: 'team@example.com' }, { shouldStar: 'true' }, 'changed', 'to'],
  ['subject', { subject: 'weekly notice' }, { shouldStar: 'true' }, 'same', 'subject'],
  ['cc never widens', { hasTheWord: 'cc:team@example.com' }, { shouldStar: 'true' }, 'no', /cc:/],
  ['operator-only expression', { hasTheWord: 'from:notice@example.com subject:weekly' }, { shouldStar: 'true' }, 'same', 'from'],
  ['bare body word rejects whole rule', { from: 'notice@example.com', hasTheWord: 'bodyword' }, { shouldStar: 'true' }, 'no', /본문/],
  ['unsupported label search', { hasTheWord: 'label:News' }, { shouldStar: 'true' }, 'no', /label:/],
  ['unsupported state search', { hasTheWord: 'is:unread' }, { shouldStar: 'true' }, 'no', /is:/],
  ['unsupported date search', { hasTheWord: 'older_than:2d' }, { shouldStar: 'true' }, 'no', /older_than:/],
  ['negative from', { doesNotHaveTheWord: 'from:notice@example.com' }, { shouldStar: 'true' }, 'same', 'from'],
  ['negative subject', { doesNotHaveTheWord: 'subject:notice' }, { shouldStar: 'true' }, 'same', 'subject'],
  ['negative to', { hasTheWord: '-to:team@example.com' }, { shouldStar: 'true' }, 'no', /받는 사람 제외/],
  ['negative to in excluded search', { doesNotHaveTheWord: 'to:team@example.com' }, { shouldStar: 'true' }, 'no', /받는 사람 제외/],
  ['attachment approximation', { hasAttachment: 'true' }, { shouldStar: 'true' }, 'changed', 'attachment'],
  ['attachment false ignored', { from: 'notice@example.com', hasAttachment: 'false' }, { shouldStar: 'true' }, 'same', 'from'],
  ['size condition rejected', { from: 'notice@example.com', size: '100', sizeOperator: 's_sl', sizeUnit: 's_skb' }, { shouldStar: 'true' }, 'no', /크기/],
  ['size defaults ignored', { from: 'notice@example.com', sizeOperator: 's_sl', sizeUnit: 's_skb' }, { shouldStar: 'true' }, 'same', 'from'],
  ['excludeChats ignored', { from: 'notice@example.com', excludeChats: 'true' }, { shouldStar: 'true' }, 'same', 'from'],
  ['label with archive', { from: 'notice@example.com' }, { label: 'News', shouldArchive: 'true' }, 'same', 'from'],
  ['label without archive', { from: 'notice@example.com' }, { label: 'News' }, 'changed', 'from'],
  ['new label with archive', { from: 'notice@example.com' }, { label: 'NewFolder', shouldArchive: 'true' }, 'same', 'from'],
  ['archive only', { from: 'notice@example.com' }, { shouldArchive: 'true' }, 'changed', 'from'],
  ['trash', { from: 'notice@example.com' }, { shouldTrash: 'true' }, 'same', 'from'],
  ['trash overrides label', { from: 'notice@example.com' }, { shouldTrash: 'true', label: 'News' }, 'changed', 'from'],
  ['read', { from: 'notice@example.com' }, { shouldMarkAsRead: 'true' }, 'same', 'from'],
  ['star', { from: 'notice@example.com' }, { shouldStar: 'true' }, 'same', 'from'],
  ['internal forward', { from: 'notice@example.com' }, { forwardTo: 'team@example.com' }, 'same', 'from'],
  ['external forward omitted', { from: 'notice@example.com' }, { forwardTo: 'team@outside.example', shouldStar: 'true' }, 'changed', 'from'],
  ['external forward alone', { from: 'notice@example.com' }, { forwardTo: 'team@outside.example' }, 'no', /동작/],
  ['never spam omitted', { from: 'notice@example.com' }, { shouldNeverSpam: 'true', shouldStar: 'true' }, 'changed', 'from'],
  ['importance omitted', { from: 'notice@example.com' }, { shouldAlwaysMarkAsImportant: 'true', shouldStar: 'true' }, 'changed', 'from'],
  ['unimportant omitted', { from: 'notice@example.com' }, { shouldNeverMarkAsImportant: 'true', shouldStar: 'true' }, 'changed', 'from'],
  ['smart label omitted', { from: 'notice@example.com' }, { smartLabelToApply: '^smartlabel_personal', shouldStar: 'true' }, 'changed', 'from'],
  ['smart label literal false is still omitted', { from: 'notice@example.com' }, { smartLabelToApply: 'false', shouldStar: 'true' }, 'changed', 'from'],
  ['omission leaves no actions', { from: 'notice@example.com' }, { shouldNeverSpam: 'true' }, 'no', /동작/],
  ['trailing star', { from: 'notice*' }, { shouldStar: 'true' }, 'changed', 'from'],
  ['middle star', { from: 'no*tice' }, { shouldStar: 'true' }, 'no', /별표/],
  ['question mark', { from: 'notice?' }, { shouldStar: 'true' }, 'no', /별표/],
  ['nested condition', { from: '(notice OR news)', subject: 'weekly' }, { shouldStar: 'true' }, 'no', /2단/],
  ['negative pattern', { from: '-notice*' }, { shouldStar: 'true' }, 'no', /별표/],
  ['no conditions', {}, { shouldStar: 'true' }, 'no', /조건/],
  ['unsafe variable value', { subject: '"${example}"' }, { shouldStar: 'true' }, 'no', /unsafe_text/],
  ['protected folder', { from: 'notice@example.com' }, { label: 'INBOX' }, 'no', /폴더/],
];
for (const [name, conditions, actions, status, expected] of cases) {
  test(`Gmail decision table: ${name}`, () => {
    const item = one(props({ ...conditions, ...actions }));
    assert.equal(item.status, status, item.reason);
    assert.deepEqual(item.gmail.conditions, props(conditions));
    assert.deepEqual(item.gmail.actions, props(actions));
    if (status === 'no') { assert.match(item.reason, expected); assert.equal(item.rule, undefined); }
    else {
      assert.equal(item.rule.conditions[0].field, expected);
      if (status === 'changed') assert.ok(item.changes.length);
      validateDocument(doc([item.rule]), { ...policy, folders: [...folders, { path: 'NewFolder' }] });
    }
  });
}

test('parser retains operator precedence, plain field text and negative normal form', () => {
  assert.equal(parseGmailSearch('weekly notice', 'subject').value, 'weekly notice');
  assert.equal(parseGmailSearch('from:a OR from:b subject:x').t, 'or');
  const or = one(props({ from: 'a OR b', shouldStar: 'true' })).rule;
  assert.equal(or.match, 'any');
  assert.deepEqual(or.conditions.map(c => c.value), ['a', 'b']);
  const not = one(props({ doesNotHaveTheWord: '(from:a OR subject:b)', shouldStar: 'true' })).rule;
  assert.equal(not.match, 'all');
  assert.deepEqual(not.conditions.map(c => c.op), ['not', 'not']);
});

test('search limits and malformed or unsupported syntax reject their entry', () => {
  assert.equal(tokenize(Array(200).fill('a').join(' ')).length, 200);
  assert.equal(one(props({ subject: `${'from:'.repeat(199)}a`, shouldStar: 'true' })).status, 'same');
  for (const expression of [Array(201).fill('a').join(' '), `${'('.repeat(9)}a${')'.repeat(9)}`, '(a', 'a OR', '"unfinished', '{a b}', '+word', 'a AROUND b', Array(11).fill('a').join(' AND ')]) {
    assert.equal(one(props({ ...valid, subject: expression })).status, 'no', expression);
  }
  assert.equal(one(props({ subject: `${'('.repeat(8)}a${')'.repeat(8)}`, shouldStar: 'true' })).status, 'same');
});

test('action omissions disclose names, archive availability and folder precedence', () => {
  const item = one(props({ ...valid, shouldNeverSpam: 'true', shouldAlwaysMarkAsImportant: 'true', shouldNeverMarkAsImportant: 'true', smartLabelToApply: 'category', forwardTo: 'x@outside.example' }));
  for (const key of ['shouldNeverSpam', 'shouldAlwaysMarkAsImportant', 'shouldNeverMarkAsImportant', 'smartLabelToApply', 'forwardTo']) assert.ok(item.changes.some(change => change.includes(key)));
  const missing = one(props({ ...valid, shouldArchive: 'true' }), { folders: [] });
  assert.equal(missing.status, 'changed');
  assert.ok(missing.changes.some(change => change.includes('shouldArchive')));
  assert.deepEqual(missing.rule.actions, { star: true });
  assert.equal(one(props({ from: 'a', shouldArchive: 'true' }), { folders: [] }).status, 'no');
  assert.equal(one(props({ ...valid, label: 'News' }), { folders: [{ path: 'News', shared: true }] }).status, 'no');
  const trash = one(props({ ...valid, label: 'News', shouldTrash: 'true' }));
  assert.deepEqual(trash.rule.actions, { star: true, trash: true });
  assert.ok(trash.changes.some(change => change.includes('label')));
  const report = convert([props({ from: 'a', label: 'News', shouldArchive: 'true' }), props({ from: 'b', label: 'NewFolder', shouldArchive: 'true' })]);
  assert.deepEqual(report.items.map(item => item.status), ['changed', 'changed']);
  assert.ok(report.items.every(item => item.changes.some(change => change.includes('첫 폴더'))));
  assert.deepEqual(report.newFolders, ['NewFolder']);
  assert.equal(report.items[1].newFolder, 'NewFolder');
  const appended = convert([props({ from: 'c', label: 'NewFolder', shouldArchive: 'true' })], { existingRules: [report.rules[0]], mode: 'append' });
  assert.equal(appended.items[0].status, 'changed');
  assert.ok(appended.items[0].changes.some(change => change.includes('첫 폴더')));
  assert.equal(one([...props(valid), ['label', 'News'], ['label', 'Other']]).status, 'no');
});

test('append fills 100-rule limit in order, replace ignores old count; IDs never collide', () => {
  const existingRules = convert(Array(95).fill(props(valid))).rules;
  const rows = Array(10).fill(props(valid));
  const result = convert(rows, { existingRules, mode: 'append' });
  assert.equal(result.rules.length, 5);
  assert.deepEqual(result.items.map(item => item.status), [...Array(5).fill('same'), ...Array(5).fill('no')]);
  assert.ok(result.items.slice(5).every(item => item.reason === '규칙 100개 한도'));
  assert.equal(new Set([...existingRules, ...result.rules].map(rule => rule.id)).size, 100);
  assert.equal(convert(rows, { existingRules, mode: 'replace' }).rules.length, 10);
});

test('forward limit includes existing distinct addresses and preserves duplicates', () => {
  const existingRules = convert([props({ from: 'a', forwardTo: 'one@example.com' })]).rules;
  const result = convert([props({ from: 'a', forwardTo: 'ONE@example.com' }), props({ from: 'b', forwardTo: 'two@example.com' }), props({ from: 'c', forwardTo: 'three@example.com' }), props(valid)], { policy: { ...policy, maxRedirects: 2 }, existingRules, mode: 'append' });
  assert.equal(result.rules.length, 2);
  assert.deepEqual(result.items.map(item => item.status), ['same', 'same', 'no', 'no']);
  assert.ok(result.items.slice(2).every(item => item.reason === '전달 주소 수 한도'));
  const none = convert([props({ from: 'a', forwardTo: 'one@example.com' }), props(valid)], { policy: { ...policy, maxRedirects: 0 } });
  assert.deepEqual(none.items.map(item => item.reason), ['전달 주소 수 한도', '전달 주소 수 한도']);
});

test('script byte limit retains the prefix and rejects remaining entries', () => {
  const subject = Array(9).fill(`"${'가'.repeat(190)}"`).join(' AND ');
  const result = convert(Array(100).fill(props({ subject, shouldStar: 'true' })));
  assert.ok(result.rules.length > 0 && result.rules.length < 100);
  assert.ok(result.items.slice(result.rules.length).every(item => item.status === 'no' && item.reason === '생성 스크립트 1MB 한도'));
  assert.ok(Buffer.byteLength(generateScript(doc(result.rules), { ...policy, folders })) <= 1024 * 1024);
});

test('stage2 dispatch keeps stage1 behavior for the X2 handoff', () => {
  const rows = [props(valid), props({ subject: '(a OR b)', from: 'x', shouldStar: 'true' })];
  assert.deepEqual(convert(rows, { stage: 2 }), convert(rows, { stage: 1 }));
});
