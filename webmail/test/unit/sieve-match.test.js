import { test } from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { matches, loadInboxHeaders, preview } from '../../server/sieve/match.js';
import { conditionTest } from '../../server/sieve/generate.js';
import { decodeRef } from '../../server/mail/ref.js';

const rule = (...conditions) => ({ match: 'all', conditions });
const condition = (field, op, value) => ({ field, op, value });
const bWord = text => `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`;
const qWord = text => `=?EUC-KR?Q?${Array.from(iconv.encode(text, 'euc-kr'), byte => '=' + byte.toString(16).padStart(2, '0')).join('')}?=`;

// Each operator is checked with positive and negative examples against the
// independent expected W10 Sieve expression, including both address fields.
for (const field of ['from', 'to', 'subject']) {
  for (const op of ['has', 'not', 'eq', 'start']) {
    for (const [variant, display, subject] of [
      ['ASCII case', 'Sales TEAM', 'Report ABC'],
      ['Korean', '홍길동 영업팀', '한글 견적서'],
      ['UTF-8 B', bWord('홍길동 영업팀'), bWord('한글 견적서')],
      ['EUC-KR Q', qWord('홍길동 영업팀'), qWord('한글 견적서')],
      ['bare address', '', 'Report ABC'],
    ]) {
      test(`match ${field}/${op}: ${variant}`, () => {
        const address = 'User@EXAMPLE.com';
        const header = field === 'subject' ? `Subject: ${subject}\r\n` : `${field === 'from' ? 'From' : 'Cc'}: ${display ? `${display} <${address}>` : address}\r\n`;
        const decodedSubject = variant === 'Korean' || variant.includes('B') || variant.includes('Q') ? '한글 견적서' : 'Report ABC';
        const value = field === 'subject'
          ? (op === 'eq' ? decodedSubject : op === 'start' ? decodedSubject.slice(0, 2) : decodedSubject.slice(1, 3))
          : (op === 'eq' ? 'user@example.COM' : op === 'start' ? 'uSER@' : display ? variant === 'ASCII case' ? 'sales team' : '영업팀' : 'example.COM');
        const c = condition(field, op, value);
        const headerNames = field === 'to' ? '["to", "cc"]' : `"${field}"`;
        const verb = field !== 'subject' && ['eq', 'start'].includes(op) ? 'address :all' : 'header';
        const comparator = { has: ':contains', not: ':contains', eq: ':is', start: ':matches' }[op];
        assert.equal(conditionTest(c), `${op === 'not' ? 'not ' : ''}${verb} ${comparator} ${headerNames} "${value}${op === 'start' ? '*' : ''}"`);
        assert.equal(matches(rule(c), Buffer.from(header)), op !== 'not');
        assert.equal(matches(rule({ ...c, value: 'absent@example.net' }), header), op === 'not');
      });
    }
  }
}
for (const contentType of ['Multipart/MIXED; boundary=example', 'multipart/mixed', bWord('multipart/mixed'), qWord('multipart/mixed')]) {
  test(`match attachment/has: ${contentType}`, () => {
    const c = condition('attachment', 'has', '');
    assert.equal(conditionTest(c), 'header :contains "content-type" "multipart/mixed"');
    assert.equal(matches(rule(c), `Content-Type: ${contentType}\r\n`), true);
    assert.equal(matches(rule(c), 'Content-Type: multipart/alternative\r\n'), false);
  });
}

test('match combines all/any without treating enabled/actions as conditions', () => {
  const conditions = [condition('from', 'eq', 'sender@example.com'), condition('subject', 'has', '견적')];
  const headers = { from: ['Sender <sender@example.com>'], subject: ['회의'] };
  assert.equal(matches({ match: 'all', conditions }, headers), false);
  assert.equal(matches({ match: 'any', conditions, enabled: false }, headers), true);
  headers.subject = ['견적'];
  assert.equal(matches({ match: 'all', conditions }, headers), true);
});

test('match repeats headers independently; not negates the union of To and Cc', () => {
  const headers = 'To: First <one@example.com>, two@example.com\r\nTo: three@example.com\r\nCc: Team: Four <four@example.com>, five@example.com;\r\nSubject: first\r\nSubject: second\r\n';
  for (const value of ['one', 'two', 'three', 'four', 'five']) {
    assert.equal(matches(rule(condition('to', 'eq', `${value}@example.com`)), headers), true);
    assert.equal(matches(rule(condition('to', 'not', value)), headers), false);
  }
  assert.equal(matches(rule(condition('to', 'eq', 'First')), headers), false);
  assert.equal(matches(rule(condition('subject', 'eq', 'second')), headers), true);
  assert.equal(matches(rule(condition('subject', 'has', 'firstsecond')), headers), false);
  assert.equal(matches(rule(condition('from', 'not', 'absent')), ''), true);
  assert.equal(matches(rule(condition('subject', 'eq', '')), ''), false);
});

test('match uses ASCII casemap only and literal prefix characters', () => {
  assert.equal(matches(rule(condition('subject', 'eq', 'ÄBC 한글')), 'Subject: Äbc 한글\r\n'), true);
  assert.equal(matches(rule(condition('subject', 'eq', 'äbc 한글')), 'Subject: Äbc 한글\r\n'), false);
  for (const value of ['*?', '\\', 'a?*\\']) {
    assert.equal(matches(rule(condition('subject', 'start', value)), { subject: [`${value}tail`] }), true);
    assert.equal(matches(rule(condition('subject', 'start', value)), { subject: ['anything'] }), false);
    assert.ok(conditionTest(condition('subject', 'start', value)).includes(':matches'));
  }
});

test('match decodes folded/adjacent words, keeps display punctuation out of address syntax, stops at body', () => {
  const headers = `From: ${bWord('한글, <fake@example.net>')} <real@example.com>\r\nSubject: ${bWord('견적')}\r\n\t${bWord('요청')}\r\nContent-Type: text/plain\r\n\r\nSubject: injected\r\nContent-Type: multipart/mixed\r\n`;
  assert.equal(matches(rule(condition('from', 'has', 'fake@example.net')), headers), true);
  assert.equal(matches(rule(condition('from', 'eq', 'fake@example.net')), headers), false);
  assert.equal(matches(rule(condition('from', 'eq', 'real@example.com')), headers), true);
  assert.equal(matches(rule(condition('subject', 'eq', '견적요청')), headers), true);
  assert.equal(matches(rule(condition('subject', 'has', 'injected')), headers), false);
  assert.equal(matches(rule(condition('attachment', 'has', '')), headers), false);
});

class Inbox {
  constructor(rows) {
    this.rows = rows;
    this.mailbox = { uidValidity: 123n };
    this.enabled = new Set(); this.capabilities = new Map();
    this.commands = []; this.fetches = [];
  }
  async exec(command, attributes, { untagged }) {
    this.commands.push({ command, attributes });
    assert.equal(command, 'UID SORT');
    const sorted = [...this.rows].sort((a, b) => b.internalDate - a.internalDate || b.uid - a.uid);
    untagged.SORT({ attributes: sorted.map(row => ({ value: String(row.uid) })) });
    return { next() {} };
  }
  async *fetch(range, query, options) {
    this.fetches.push({ range, query, options });
    if (this.failure) throw this.failure;
    const uids = new Set(range.split(',').map(Number));
    // Replies deliberately arrive in a different order from SORT.
    for (const row of this.rows) {
      if (!uids.has(row.uid) || (query.headers && row.uid === this.disappeared)) continue;
      yield query.headers ? row : { uid: row.uid, internalDate: row.internalDate };
    }
  }
}
function message(uid, date = '2026-10-15T00:00:00Z', headers = 'Subject: 견적서\r\nFrom: Sender <sender@example.com>\r\nTo: team@example.com\r\nContent-Type: multipart/mixed\r\n') {
  return { uid, internalDate: new Date(date), headers: Buffer.from(headers),
    envelope: { subject: '견적서', from: [{ name: 'Sender', address: 'sender@example.com' }], to: [{ name: '', address: 'team@example.com' }] },
    size: 200, flags: new Set(['\\Seen', '\\Flagged', '\\Answered']) };
}
function fixture(rows) {
  const client = new Inbox(rows);
  let time = Date.parse('2026-10-15T12:00:00Z');
  let locks = 0;
  const imap = { async withMailbox(_session, path, operation) {
    locks++; assert.equal(path, 'INBOX'); return operation(client);
  } };
  const session = {};
  const now = () => time;
  return { client, imap, session, now, load: (s = session) => loadInboxHeaders(imap, s, { now }),
    advance(ms) { time += ms; }, setTime(value) { time = Date.parse(value); }, locks: () => locks };
}

test('headers: inclusive exact calendar year boundary, padded SINCE, UID queries, no text SEARCH', async () => {
  const f = fixture([message(1, '2025-10-15T11:59:59.999Z'), message(2, '2025-10-15T12:00:00Z'), message(3, '2026-10-15T00:00:00Z')]);
  const result = await f.load();
  assert.deepEqual(result.items.map(row => row.uid), [3, 2]);
  assert.equal(result.scanned, 2); assert.equal(result.limited, false);
  assert.deepEqual(f.client.commands[0], { command: 'UID SORT', attributes: [
    [{ type: 'ATOM', value: 'REVERSE' }, { type: 'ATOM', value: 'ARRIVAL' }], { type: 'ATOM', value: 'UTF-8' },
    { type: 'ATOM', value: 'SINCE' }, { type: 'ATOM', value: '14-Oct-2025' },
  ] });
  assert.ok(f.client.fetches.every(call => call.options.uid === true));
  assert.deepEqual(f.client.fetches.filter(call => call.query.headers)[0].query.headers, ['from', 'to', 'cc', 'subject', 'content-type']);
  assert.deepEqual(decodeRef(result.items[0].ref), { path: 'INBOX', uidValidity: 123, uid: 3 });
  assert.deepEqual(Object.keys(result.items[0].item), ['ref', 'folder', 'folderName', 'from', 'to', 'subject', 'date', 'size', 'seen', 'flagged', 'answered', 'hasAttachment']);
  assert.equal(result.items[0].item.seen, true); assert.equal(result.items[0].item.flagged, true);
  assert.equal(result.items[0].item.answered, true); assert.equal(result.items[0].item.hasAttachment, true);
});

test('headers: calendar leap day clamps to Feb 28 and includes exact boundary', async () => {
  const f = fixture([message(1, '2023-02-28T12:00:00Z'), message(2, '2023-02-28T11:59:59.999Z')]);
  f.setTime('2024-02-29T12:00:00Z');
  assert.deepEqual((await f.load()).items.map(row => row.uid), [1]);
});

test('headers: cap 20,000 newest eligible, metadata only for extra candidate; exactly cap is not limited', async t => {
  const rows = Array.from({ length: 20_001 }, (_, i) => message(i + 1, new Date(Date.UTC(2026, 9, 1) + i * 1000)));
  const f = fixture(rows);
  const result = await f.load();
  assert.equal(result.scanned, 20_000); assert.equal(result.limited, true);
  assert.equal(result.items[0].uid, 20_001); assert.equal(result.items.at(-1).uid, 2);
  const headerFetches = f.client.fetches.filter(call => call.query.headers);
  assert.equal(headerFetches.flatMap(call => call.range.split(',')).length, 20_000);
  assert.equal(headerFetches.some(call => call.range.split(',').includes('1')), false);
  assert.equal(headerFetches.length, 10);
  assert.ok(headerFetches.every(call => !call.query.envelope && call.range.split(',').length <= 2000));
  const began = performance.now();
  assert.equal(preview(rule(condition('subject', 'has', '견적')), result).count, 20_000);
  const recalculationMs = performance.now() - began;
  assert.ok(recalculationMs < 200, `20k recalculation ${recalculationMs}ms`);
  t.diagnostic(`20k cached recalculation ${Math.round(recalculationMs)}ms; 10 header FETCH, no ENVELOPE`);
  assert.equal((await fixture(rows.slice(1)).load()).limited, false);
});

test('headers: cache at 299999ms, expires at 300000ms, sessions and UIDVALIDITY isolated', async () => {
  const f = fixture([message(1)]);
  const first = await f.load();
  f.client.rows.push(message(2));
  f.advance(299999); assert.strictEqual(await f.load(), first);
  assert.equal(f.client.commands.length, 1);
  assert.equal((await f.load({})).scanned, 2); assert.equal(f.client.commands.length, 2);
  f.advance(1); assert.equal((await f.load()).scanned, 2); assert.equal(f.client.commands.length, 3);
  f.client.mailbox.uidValidity = 124n;
  assert.equal(decodeRef((await f.load()).items[0].ref).uidValidity, 124);
  assert.equal(f.client.commands.length, 4); assert.equal(f.locks(), 14);
});

test('headers: empty or expired inbox needs no header FETCH; failed loads retry; expunges skipped', async () => {
  const empty = fixture([]); assert.deepEqual(await empty.load(), { items: [], scanned: 0, limited: false, partial: false });
  assert.equal(empty.client.fetches.length, 0);
  const old = fixture([message(1, '2020-01-01T00:00:00Z')]);
  assert.equal((await old.load()).scanned, 0);
  assert.equal(old.client.fetches.some(call => call.query.headers), false);
  const f = fixture([message(1), message(2)]);
  f.client.failure = new Error('synthetic fetch failure');
  await assert.rejects(f.load(), /synthetic fetch failure/);
  f.client.failure = null; f.client.disappeared = 2;
  assert.equal((await f.load()).scanned, 1); assert.equal(f.client.commands.length, 2);
});

test('preview counts full snapshot, returns latest 20 list rows and recomputes without IMAP', async () => {
  const f = fixture(Array.from({ length: 25 }, (_, i) => message(i + 1, new Date(Date.UTC(2026, 9, i + 1)), `Subject: ${bWord(i % 2 ? '회의' : '견적서')}\r\n`)));
  const snapshot = await f.load();
  const calls = f.client.fetches.length;
  const result = preview(rule(condition('subject', 'not', 'absent')), snapshot);
  assert.equal(result.count, 25); assert.equal(result.items.length, 20); assert.equal(result.scanned, 25); assert.equal(result.limited, false);
  assert.equal(decodeRef(result.items[0].ref).uid, 25); assert.equal(decodeRef(result.items.at(-1).ref).uid, 6);
  assert.equal(preview(rule(condition('subject', 'has', '견적')), snapshot).count, 13);
  assert.equal(preview(rule(condition('subject', 'has', '회의')), snapshot).count, 12);
  assert.deepEqual(preview(rule(condition('subject', 'has', '없음')), snapshot), { count: 0, items: [], scanned: 25, limited: false, partial: false });
  assert.equal(f.client.fetches.length, calls);
  assert.equal(preview(rule(condition('subject', 'has', '견적')), { ...snapshot, limited: true }).limited, true);
  assert.deepEqual(snapshot.items.map(record => record.uid), Array.from({ length: 25 }, (_, i) => 25 - i));
});

// Stage-two expectations pair exact generated Sieve with independent outcomes.
for (const field of ['from', 'to', 'subject']) {
  for (const [pattern, positive, negative] of [
    ['prefix*', 'PREFIX middle suffix', 'xprefix middle suffix'],
    ['*middle*', 'prefix MIDDLE suffix', 'prefix suffix'],
    ['*suffix', 'prefix middle SUFFIX', 'prefix middle suffixx'],
    ['a**b', 'A long B', 'A long C'],
    ['literal\\*', 'literal*', 'literalx'],
    ['literal\\?', 'literal?', 'literalx'],
    ['literal\\\\', 'literal\\', 'literalx'],
    ['회*안내', '회의 안내', '회의'],
    ['Ä*', 'ÄBC', 'äBC'],
  ]) test(`pattern generation and matcher ${field}/${pattern}`, () => {
    const c = condition(field, 'matches', pattern);
    const valueHeaders = value => field === 'subject' ? { subject: [value] } : {
      addresses: { from: field === 'from' ? [value] : [], to: field === 'to' ? [value] : [], cc: [] },
      from: [], to: [], cc: [], subject: [], 'content-type': [],
    };
    const quoted = `"${pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    assert.equal(conditionTest(c), `${field === 'subject' ? 'header' : 'address :all'} :matches ${field === 'to' ? '["to", "cc"]' : `"${field}"`} ${quoted}`);
    assert.equal(matches(rule(c), valueHeaders(positive)), true);
    assert.equal(matches(rule(c), valueHeaders(negative)), false);
  });
}

test('patterns select addresses rather than display names, including Cc and decoded Korean subjects', () => {
  const headers = `From: "prefix display" <alpha@example.com>\r\nTo: "recipient" <one@example.org>\r\nCc: team@example.com\r\nSubject: ${bWord('회의 안내')}\r\n`;
  assert.equal(matches(rule(condition('from', 'matches', 'prefix*')), headers), false);
  assert.equal(matches(rule(condition('from', 'matches', '*@EXAMPLE.COM')), headers), true);
  assert.equal(matches(rule(condition('to', 'matches', 'team*')), headers), true);
  assert.equal(matches(rule(condition('subject', 'matches', '회*안내')), headers), true);
});

test('mixed condition joins generate recursive Sieve and evaluate every/some recursively', () => {
  const a = condition('subject', 'matches', '*tail');
  const b = condition('from', 'matches', '*@example.com');
  const c = condition('subject', 'not', 'missing');
  for (const [outer, inner] of [['all', 'any'], ['any', 'all']]) {
    const tree = { match: outer, conditions: [a, { match: inner, conditions: [b, c] }] };
    assert.equal(conditionTest(tree), `${outer === 'all' ? 'allof' : 'anyof'}(${conditionTest(a)}, ${inner === 'all' ? 'allof' : 'anyof'}(${conditionTest(b)}, ${conditionTest(c)}))`);
    for (const [subject, from] of [['tail', 'a@example.com'], ['missing', 'a@example.com'], ['tail', 'a@example.org'], ['missing', 'a@example.org']]) {
      const A = subject.endsWith('tail'), B = from.endsWith('@example.com'), C = !subject.includes('missing');
      assert.equal(matches(tree, { subject: [subject], from: [from] }), outer === 'all' ? A && (B || C) : A || (B && C));
    }
  }
});

test('long subjects and addresses are matched in full beyond 998 characters', () => {
  for (const field of ['from', 'to', 'subject']) {
    const tail = field === 'subject' ? 'TAIL' : 'tail@example.com';
    const value = `${'x'.repeat(1200)}${tail}`;
    assert.equal(matches(rule(condition(field, 'matches', `*${tail}`)), { [field]: [value] }), true);
    assert.equal(matches(rule(condition(field, 'matches', `*${tail}x`)), { [field]: [value] }), false);
    assert.equal(matches(rule(condition(field, 'matches', `${'x'.repeat(100)}*`)), { [field]: [value] }), true);
  }
});

test('expanded VM corpus keeps 1200 pairs and importable generated conditions preserve matcher results', async () => {
  const { sieveCorpus } = await import('../int/lib/sieve-corpus.js');
  const { Reader, readConditions } = await import('../../server/sieve/import-syntax.js');
  const { mails, rules, scripts } = sieveCorpus();
  assert.equal(mails.length, 40); assert.equal(rules.length, 30);
  assert.ok(mails.some(mail => mail.includes('x'.repeat(1200))));
  let checked = 0, excluded = 0;
  const excludedNegation = node => node.conditions ? node.conditions.some(excludedNegation) : node.field === 'to' && node.op === 'not';
  for (const [index, source] of scripts.entries()) {
    const reader = new Reader(source);
    reader.expect('require'); reader.strings(); reader.expect(';'); reader.expect('if');
    // Existing v:1 recipient exclusions remain executable, but importing new
    // exclusions on recipients is deliberately unsupported by the contract.
    if (excludedNegation(rules[index])) {
      assert.throws(() => readConditions(reader), /이 제외 조건/);
      excluded += mails.length;
      continue;
    }
    const parsed = readConditions(reader);
    reader.expect('{'); reader.expect('debug_log'); reader.string(); reader.expect(';'); reader.expect('}'); reader.done();
    for (const mail of mails) {
      const headers = mail.split('\r\n\r\n')[0];
      assert.equal(matches(parsed, headers), matches(rules[index], headers), `rule ${index}, pair ${checked}`);
      checked++;
    }
  }
  assert.equal(checked, 1160);
  assert.equal(excluded, 40);
  assert.equal(checked + excluded, 1200);
});
