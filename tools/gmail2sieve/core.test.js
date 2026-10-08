// 실행: node tools/gmail2sieve/core.test.js
// 실제 입력 점검(선택): G2S_REAL_XML=/path/to/mailFilters.xml node tools/gmail2sieve/core.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const G2S = require('./core.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); } catch (e) {
    console.log('FAIL ' + name + '\n     ' + e.message);
    process.exitCode = 1;
  }
}

// 테스트 전용 최소 DOMParser (entry / apps:property 만 지원, Node 에는 DOMParser 가 없음)
const ENT = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
const unescapeXml = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] !== undefined ? ENT[e] : m;
});
const fakeDomParser = {
  parseFromString(xml) {
    if (!/<feed[\s>]/.test(xml)) return { getElementsByTagName: (t) => (t === 'parsererror' ? [{}] : []) };
    const entries = (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).map((e) => {
      const props = [...e.matchAll(/<apps:property name=(['"])(.*?)\1 value=(['"])([\s\S]*?)\3\s*\/>/g)]
        .map((m) => ({ n: unescapeXml(m[2]), v: unescapeXml(m[4]) }));
      return {
        getElementsByTagName: () => props.map((p) => ({ getAttribute: (a) => (a === 'name' ? p.n : p.v) })),
      };
    });
    return { getElementsByTagName: (t) => (t === 'entry' ? entries : []) };
  },
};

const NOW = '2026-01-02T03:04:05Z';
const conv = (props) => G2S.convert([{ props }], { now: NOW });
const row0 = (props) => conv(props).rows[0];

// ---------- 1. XML ----------
test('XML: 엔티티·탭(&#x9;)·다건 파싱', () => {
  const xml = "<?xml version='1.0'?><feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='x'>" +
    "<entry><apps:property name='subject' value='&quot;a &amp; b&quot;'/><apps:property name='label' value='L'/></entry>" +
    "<entry><apps:property name='hasTheWord' value='cc::(&#x9;x@y.kr)'/></entry></feed>";
  const f = G2S.parseFiltersXml(xml, fakeDomParser);
  assert.strictEqual(f.length, 2);
  assert.strictEqual(f[0].props.subject, '"a & b"');
  assert.strictEqual(f[1].props.hasTheWord, 'cc::(\tx@y.kr)');
});
test('XML: 잘못된 XML 은 예외', () => {
  assert.throws(() => G2S.parseFiltersXml('<nope', fakeDomParser), /XML/);
});

// ---------- 2. 파서 ----------
const sieveOf = (props) => row0(props).sieve;
test('to:: (콜론 2개) → to/cc 헤더', () => {
  assert.ok(sieveOf({ hasTheWord: 'to::(*@sub.example.test)', label: 'L' }).includes('address :matches ["to", "cc"] "*@sub.example.test"'));
});
test('cc::(탭 + 값) → cc 헤더, 탭 제거', () => {
  const s = sieveOf({ hasTheWord: 'cc::(\tteam@example.test)', label: 'L' });
  assert.ok(s.includes('header :contains ["cc"] "team@example.test"'), s);
});
test('값 안 탭은 공백, 앞뒤 공백 제거', () => {
  const s = sieveOf({ subject: '"a\tb  "', label: 'L' });
  assert.ok(s.includes('header :contains "subject" "a b"'), s);
});
test('중첩 괄호 + OR 우선순위 (AND > OR)', () => {
  const e = G2S.parseExpr('a b OR (c AND (d OR e))', 'subject');
  assert.strictEqual(e.t, 'or');
  assert.strictEqual(e.kids[0].t, 'and');
  assert.strictEqual(e.kids[1].t, 'and');
  assert.strictEqual(e.kids[1].kids[1].t, 'or');
});
test('- 부정 (단어·필드·괄호)', () => {
  const e = G2S.parseExpr('-a -from:(b OR c)', 'any');
  assert.strictEqual(e.t, 'and');
  assert.strictEqual(e.kids[0].t, 'not');
  assert.strictEqual(e.kids[1].kid.t, 'or');
  assert.strictEqual(e.kids[1].kid.kids[0].field, 'from');
});
test('단어 중간 하이픈은 부정 아님', () => {
  const e = G2S.parseExpr('no-reply@x.io', 'from');
  assert.deepStrictEqual(e, { t: 'term', field: 'from', value: 'no-reply@x.io' });
});
test('| 는 OR', () => {
  const e = G2S.parseExpr('a | b', 'subject');
  assert.strictEqual(e.t, 'or');
  assert.strictEqual(e.kids.length, 2);
});
test('따옴표 없는 여러 단어 = 단어별 AND, 따옴표 구문 = 하나', () => {
  const a = G2S.parseExpr('Alpha Beta Gamma', 'subject');
  assert.strictEqual(a.t, 'and'); assert.strictEqual(a.kids.length, 3);
  const b = G2S.parseExpr('"Alpha Beta Gamma"', 'subject');
  assert.deepStrictEqual(b, { t: 'term', field: 'subject', value: 'Alpha Beta Gamma' });
});
test('필드 연산자는 다음 항 하나에만 적용', () => {
  const e = G2S.parseExpr('from:a b', 'any');
  assert.strictEqual(e.kids[0].field, 'from');
  assert.strictEqual(e.kids[1].field, 'any');
});
test('괄호 안 항은 연산자 필드 상속', () => {
  const e = G2S.parseExpr('subject:(x OR "y z")', 'any');
  assert.ok(e.kids.every((k) => k.field === 'subject'));
});
test('괄호 짝 불일치·빈 괄호·따옴표 미닫힘·끝난 식 → 해석 실패 제외', () => {
  ['(a OR b', 'a OR b)', '()', '"abc', 'a OR', '-', 'a AND'].forEach((v) => {
    const r = row0({ subject: v, label: 'L' });
    assert.strictEqual(r.status, 'excluded', v);
    assert.strictEqual(r.warnings[0].code, 'parse-error', v);
    assert.ok(r.comment.indexOf('(변환 제외)') > 0);
    assert.strictEqual(r.sieve, '');
  });
});
test('bcc:·{…}·미지원 연산자 → 필터 전체 제외 (부정 안에서도)', () => {
  ['bcc:x@y.kr', '-bcc:x@y.kr', 'from:a {b c}', 'has:attachment', 'label:x', 'filename:a.pdf',
    'larger:5M', 'older_than:1d', 'in:inbox', 'list:x', 'is:unread', 'before:2020/1/1'].forEach((v) => {
    const r = row0({ hasTheWord: 'ok ' + v, label: 'L' });
    assert.strictEqual(r.status, 'excluded', v);
    assert.strictEqual(r.warnings[0].code, 'unsupported', v);
    assert.strictEqual(r.sieve, '');
  });
  assert.strictEqual(row0({ doesNotHaveTheWord: 'bcc:x', label: 'L' }).status, 'excluded');
});
test('값에 ${ 가 있으면 제외(변수 치환 충돌 방지)', () => {
  assert.strictEqual(row0({ subject: '"a${b}"', label: 'L' }).status, 'excluded');
  assert.strictEqual(row0({ subject: 'a', label: '${x}' }).status, 'excluded');
});
test('hasAttachment 조건 / 조건 없음 → 제외', () => {
  assert.strictEqual(row0({ hasAttachment: 'true', subject: 'a', label: 'L' }).status, 'excluded');
  assert.strictEqual(row0({ label: 'L' }).warnings[0].code, 'no-condition');
});
test('size: 값 없으면 무시, 있으면 over/under + 단위', () => {
  assert.ok(!sieveOf({ subject: 'a', label: 'L', sizeOperator: 's_sl', sizeUnit: 's_smb' }).includes('size'));
  assert.ok(sieveOf({ subject: 'a', label: 'L', size: '5', sizeOperator: 's_sl', sizeUnit: 's_smb' }).includes('size :over 5M'));
  assert.ok(sieveOf({ subject: 'a', label: 'L', size: '7', sizeOperator: 's_ss', sizeUnit: 's_skb' }).includes('size :under 7K'));
  assert.ok(/size :under 7[,)\s]/.test(sieveOf({ subject: 'a', label: 'L', size: '7', sizeOperator: 's_ss', sizeUnit: 's_sb' })));
  assert.strictEqual(row0({ subject: 'a', label: 'L', size: 'x', sizeOperator: 's_sl' }).status, 'excluded');
});

// ---------- 3. 항 변환 ----------
test('from: * 없으면 header :contains, 있으면 address :matches + 경고', () => {
  const a = row0({ from: 'a@b.kr', label: 'L' });
  assert.ok(a.sieve.includes('header :contains "from" "a@b.kr"'));
  assert.ok(!a.warnings.some((w) => w.code === 'wildcard'));
  const b = row0({ from: '*@b.kr', label: 'L' });
  assert.ok(b.sieve.includes('address :matches "from" "*@b.kr"'));
  assert.ok(b.warnings.some((w) => w.code === 'wildcard'));
});
test(':matches 의 ? 와 \\ 는 글자 그대로', () => {
  const s = sieveOf({ from: '*a?b\\c@x', label: 'L' });
  assert.ok(s.includes('address :matches "from" "*a\\\\?b\\\\\\\\c@x"'), s);
});
test('to 속성/to: → to·cc + Bcc 경고, cc: → cc 만', () => {
  const r = row0({ to: 'a@b', label: 'L' });
  assert.ok(r.sieve.includes('header :contains ["to", "cc"] "a@b"'));
  assert.ok(r.warnings.some((w) => w.code === 'to-no-bcc'));
  const c = row0({ hasTheWord: 'cc:a@b', label: 'L' });
  assert.ok(!c.warnings.some((w) => w.code === 'to-no-bcc'));
});
test('어디든 → 헤더 + body :text 근사 + 경고', () => {
  const r = row0({ hasTheWord: '"주간 요약"', label: 'L' });
  assert.ok(r.sieve.includes('anyof (header :contains ["subject", "from", "to", "cc"] "주간 요약", body :text :contains "주간 요약")'), r.sieve);
  assert.ok(r.warnings.some((w) => w.code === 'any-approx'));
});
test('doesNotHaveTheWord → not (…)', () => {
  const r = row0({ subject: 'a', doesNotHaveTheWord: '"x y"', label: 'L' });
  assert.ok(/not anyof \(header :contains \["subject", "from", "to", "cc"\] "x y"/.test(r.sieve), r.sieve);
});
test('속성 간 AND(allof)', () => {
  const r = row0({ from: 'a', to: 'b', label: 'L' });
  assert.ok(r.sieve.startsWith('if allof ('), r.sieve);
});

// ---------- 4. 이스케이프·주석 ----------
test('문자열 이스케이프: " 와 \\', () => {
  const s = sieveOf({ subject: '"a\\b\\"', label: 'x"y' });
  assert.ok(s.includes('"subject" "a\\\\b\\\\"') , s);
  assert.ok(s.includes('fileinto :create :copy "x\\"y";'), s);
});
test('주석 한 줄화: 제어문자·줄바꿈·U+2028/2029 → 공백', () => {
  const evil = 'a\n\r\t\u2028\u2029\u0085b';
  const r = row0({ subject: evil, label: 'L\nM', shouldArchive: 'true' });
  assert.ok(!/[\n\r\u2028\u2029\u0085]/.test(r.comment), JSON.stringify(r.comment));
  assert.ok(r.comment.startsWith('# [1] subject=a b'), r.comment);
});
test('주석 탈출 입력이 실행문을 만들지 않음', () => {
  const evils = ['x&#10;discard;', 'x\ndiscard;', 'x\r\ndiscard;', 'x\u2028discard;', 'x\u0085discard;',
    'x\n}\nfileinto "Evil";\n#'];
  evils.forEach((ev) => {
    const out = G2S.convert([{ props: { subject: ev, label: 'L', shouldArchive: 'true' } },
      { props: { from: 'ok', forwardTo: ev } }, { props: { subject: '(' + ev, label: 'L' } },
      { props: { hasTheWord: ev, smartLabelToApply: ev } }], { now: NOW }).script;
    out.split('\n').forEach((line) => {
      if (/^\s*(discard|fileinto|\})/.test(line)) {
        // 허용되는 실행문은 우리가 만든 것뿐
        assert.ok(/^(\s*fileinto :create :copy "L";|\}|\} elsif .*|\s*discard;   #.*|\s*fileinto "(Trash|INBOX)";.*)$/.test(line) ||
          /^\s*fileinto :create :copy "/.test(line), 'injection: ' + JSON.stringify(line));
      }
    });
    assert.ok(!/Evil/.test(out.split('\n').filter((l) => !l.startsWith('#')).join('\n')), 'Evil 이 코드로 노출');
    assert.strictEqual((out.match(/^discard;/gm) || []).length, 0);
  });
});
test('라벨에 줄바꿈이 있어도 문자열 한 줄', () => {
  const s = sieveOf({ subject: 'a', label: 'L\n};discard;' });
  assert.ok(s.includes('fileinto :create :copy "L };discard;";'), s);
  assert.strictEqual(s.split('\n').filter((l) => /^\s*fileinto/.test(l)).length, 1);
});

// ---------- 5. 스크립트 구조·동작 2단계 ----------
test('스크립트 머리: require 1개, 확장 5종, 생성 시각·필터 수', () => {
  const out = G2S.convert([{ props: { from: 'a', label: 'L' } }, { props: { from: 'b', label: 'M' } }], { now: NOW });
  assert.strictEqual((out.script.match(/^require /gm) || []).length, 1);
  assert.ok(out.script.includes('require ["fileinto", "copy", "mailbox", "body", "variables"];'));
  assert.ok(out.script.includes('# 생성 시각: 2026-01-02T03:04:05.000Z'));
  assert.ok(out.script.includes('# 원본 필터 수: 2'));
  assert.ok(!/\bstop\b/.test(out.script.split('\n').filter((l) => !l.startsWith('#')).join('\n')));
});
test('필터별 주석 1줄 + 끝 결정 블록 고정 문구', () => {
  const out = G2S.convert([{ props: { from: 'a', label: 'L' } }, { props: { subject: 'z', shouldTrash: 'true' } }], { now: NOW });
  assert.strictEqual((out.script.match(/^# \[\d+\]/gm) || []).length, 2);
  const tail = out.script.slice(out.script.indexOf('# 받은편지함 처리'));
  assert.strictEqual(tail, [
    '# 받은편지함 처리 — 위 필터들이 남긴 표시를 보고 한 번만 결정',
    'if string :is "${hc_trash}" "1" {',
    '  fileinto "Trash";',
    '} elsif string :is "${hc_archive}" "1" {',
    '  discard;   # 받은편지함 사본만 취소 — 위에서 넣은 폴더 사본은 그대로 배달됨',
    '} elsif string :is "${hc_neverspam}" "1" {',
    '  fileinto "INBOX";   # 받은편지함 명시 저장 → 이후 서버 전역 스팸→정크 규칙 건너뜀',
    '}', ''].join('\n'));
});
test('동작: 라벨은 항상 :copy, 보관·휴지통·neverSpam 은 set 표시만', () => {
  const r = row0({ from: 'a', label: 'L', shouldArchive: 'true', shouldTrash: 'true', shouldNeverSpam: 'true' });
  assert.ok(/fileinto :create :copy "L";\n  set "hc_archive" "1";\n  set "hc_trash" "1";\n  set "hc_neverspam" "1";\n\}$/.test(r.sieve), r.sieve);
  assert.ok(!/fileinto "INBOX"|discard/.test(r.sieve));
});
test('보관만(라벨 없음) → Archive 사본 + 표시 + 경고', () => {
  const r = row0({ from: 'a', shouldArchive: 'true' });
  assert.ok(r.sieve.includes('fileinto :create :copy "Archive";') && r.sieve.includes('set "hc_archive" "1";'));
  assert.ok(r.warnings.some((w) => w.code === 'archive-no-label'));
});
test('휴지통만 → 폴더 사본 없이 표시만', () => {
  const r = row0({ subject: 'x', shouldTrash: 'true' });
  assert.ok(!r.sieve.includes('fileinto') && r.sieve.includes('set "hc_trash" "1";'));
  assert.deepStrictEqual(r.folders, []);
});
test('smartLabel 만 있는 필터 → 블록 없이 주석·경고', () => {
  const r = row0({ from: 'a', smartLabelToApply: '^smartlabel_personal' });
  assert.strictEqual(r.status, 'skipped');
  assert.strictEqual(r.sieve, '');
  assert.deepStrictEqual(r.warnings.map((w) => w.code).sort(), ['no-action', 'smartlabel']);
});
test('라벨 + smartLabel → 변환하되 smartLabel 경고', () => {
  const r = row0({ from: 'a', label: 'L', smartLabelToApply: '^s' });
  assert.ok(r.converted && r.warnings.some((w) => w.code === 'smartlabel'));
});
test('forwardTo / 읽음·별표 → 변환 안 함·경고', () => {
  const r = row0({ from: 'a', label: 'L', forwardTo: 'x@y', shouldMarkAsRead: 'true', shouldStar: 'true' });
  assert.ok(!r.sieve.includes('x@y'));
  const codes = r.warnings.map((w) => w.code);
  assert.ok(codes.includes('forward') && codes.filter((c) => c === 'out-of-scope').length === 2);
});
test('3+30 동시 일치: 3 은 보관(사본+archive), 30 은 라벨만+neverSpam → 끝 블록이 discard 선택', () => {
  const out = G2S.convert([
    { props: { from: 'a1@example.test OR a2@example.test OR a3@example.test', to: 'a3@example.test', label: '라벨A', shouldArchive: 'true', shouldNeverSpam: 'true' } },
    { props: { hasTheWord: '(from:(a1@example.test OR a2@example.test OR a3@example.test) OR to:(a3@example.test))', label: '라벨A', shouldNeverSpam: 'true' } },
  ], { now: NOW });
  const [a, b] = out.rows;
  assert.ok(a.sieve.includes('set "hc_archive" "1";') && a.sieve.includes('set "hc_neverspam" "1";'));
  assert.ok(b.sieve.includes('fileinto :create :copy "라벨A";') && !b.sieve.includes('hc_archive'));
  assert.ok(b.sieve.includes('set "hc_neverspam" "1";'));
  // 두 필터 모두 사본을 넣고, 폴더는 하나
  assert.strictEqual((out.script.match(/fileinto :create :copy "라벨A";/g) || []).length, 2);
  assert.deepStrictEqual(out.folders, ['라벨A']);
  // 끝 블록: trash → archive(discard) → neverspam(INBOX) 순서
  const t = out.script;
  assert.ok(t.indexOf('hc_trash') < t.indexOf('"${hc_archive}"') && t.indexOf('"${hc_archive}"') < t.indexOf('"${hc_neverspam}"'));
});
test('폴더 목록: 중복 제거·등장 순서·제외 필터 미포함', () => {
  const out = G2S.convert([
    { props: { from: 'a', label: 'A/B' } }, { props: { from: 'b', label: 'A/B' } },
    { props: { from: '(', label: 'X' } }, { props: { from: 'c', shouldArchive: 'true' } },
  ], { now: NOW });
  assert.deepStrictEqual(out.folders, ['A/B', 'Archive']);
});
test('stats: 변환/제외/생략·사유별 필터 수', () => {
  const out = G2S.convert([
    { props: { from: '*@a', label: 'L', smartLabelToApply: 's' } },
    { props: { from: '*@b', label: 'L' } },
    { props: { subject: '(', label: 'L' } },
    { props: { from: 'z', smartLabelToApply: 's' } },
  ], { now: NOW });
  const s = out.stats;
  assert.strictEqual(s.total, 4); assert.strictEqual(s.converted, 2);
  assert.strictEqual(s.excluded, 1); assert.strictEqual(s.skipped, 1);
  assert.strictEqual(s.byCode.wildcard, 2); assert.strictEqual(s.byCode.smartlabel, 2);
  assert.strictEqual(s.byCode['parse-error'], 1);
  assert.strictEqual(s.warningCount, out.warnings.length);
});
test('빈 입력도 유효한 스크립트(머리 + 끝 블록)', () => {
  const out = G2S.convert([], { now: NOW });
  assert.ok(out.script.includes('require ') && out.script.includes('hc_trash'));
  assert.strictEqual(out.stats.total, 0);
});

// ---------- 5-2. Gate D 1라운드 수정분 ----------
const noBlock = (r, code, msg) => {
  assert.strictEqual(r.status, 'excluded', msg);
  assert.strictEqual(r.warnings[0].code, code, msg + ' ' + r.warnings[0].code);
  assert.strictEqual(r.sieve, '', msg);
  assert.ok(!/fileinto|set "/.test(r.comment), msg);
};
test('미지원 연산자·AROUND·+·{} 는 (부정 안이어도) 필터 전체 제외, 실행 블록 0', () => {
  ['-rfc822msgid:abc@example.test', '-(holiday AROUND 10 vacation)', '-(+unicorn)', '-bcc://x',
    'from:bcc:x', 'to:label:x', 'header:x', 'deliveredto:x', 'RFC822MSGID:x', 'Bcc:x', 'LABEL:x',
    'after:2020/1/1', 'before:2020/1/1', 'older:1d', 'newer:1d', 'older_than:1d', 'newer_than:1d',
    'category:promotions', 'has:attachment', 'list:x', 'filename:a.pdf', 'in:inbox', 'is:unread',
    'size:5', 'larger:5M', 'smaller:5M', '+word', 'a AROUND 3 b', '{a b}'].forEach((v) => {
    [{ hasTheWord: v }, { doesNotHaveTheWord: v }, { subject: v }, { from: v }].forEach((base) => {
      const props = Object.assign({ label: 'L', shouldArchive: 'true' }, base);
      const out = conv(props);
      noBlock(out.rows[0], 'unsupported', JSON.stringify(props));
      assert.ok(!/^\s*(if|fileinto|set)\b/m.test(out.script.replace(/^#.*$/gm, '').replace(/^if string[\s\S]*$/m, '')), v);
    });
  });
});
test('Object.prototype 이름(constructor:, __proto__:, toString:)과 따옴표 안 연산자는 일반 문자열', () => {
  ['constructor:x', '__proto__:x', 'toString:x', 'hasOwnProperty:x', '"from:x"', '"bcc:x"', 'Re:'].forEach((v) => {
    const r = row0({ hasTheWord: v, label: 'L' });
    assert.ok(r.converted, v + ' ' + JSON.stringify(r.warnings));
    const lit = v.replace(/"/g, '');
    assert.ok(r.sieve.includes('"' + lit + '"'), r.sieve);
    assert.ok(!/function|native code|undefined|object/i.test(r.sieve), r.sieve);
  });
});
test('위 표에 없는 단어: 는 제외하지 않음 (제목 속 Re:)', () => {
  const r = row0({ subject: 'Re: hello', label: 'L' });
  assert.ok(r.converted);
  assert.ok(r.sieve.includes('header :contains "subject" "Re: hello"'), r.sieve);
});
test('size lookup: sizeOperator=constructor → 제외, sizeUnit=constructor/빈 값 → 바이트', () => {
  const base = { subject: 'a', label: 'L', size: '5' };
  noBlock(row0(Object.assign({ sizeOperator: 'constructor' }, base)), 'parse-error', 'op');
  noBlock(row0(Object.assign({ sizeOperator: '__proto__' }, base)), 'parse-error', 'op2');
  ['constructor', '', 'toString', 's_sb'].forEach((u) => {
    const r = row0(Object.assign({ sizeOperator: 's_sl', sizeUnit: u }, base));
    assert.ok(r.converted, u);
    assert.ok(/size :over 5(,|\s|\))/.test(r.sieve) && !/function|native/.test(r.sieve), r.sieve);
  });
});
test('size 상한: 2^64-1 바이트까지만, 단위 배수 적용 후 판정', () => {
  const sz = (size, unit) => row0({ subject: 'a', label: 'L', size: size, sizeOperator: 's_sl', sizeUnit: unit });
  assert.ok(sz('18446744073709551615', 's_sb').converted);
  assert.ok(sz('18446744073709551615', 's_sb').sieve.includes('size :over 18446744073709551615'));
  noBlock(sz('18446744073709551616', 's_sb'), 'parse-error', '2^64');
  noBlock(sz('17592186044416', 's_smb'), 'parse-error', '2^44 M');
  assert.ok(sz('17592186044415', 's_smb').converted);
  assert.ok(sz('17592186044415', 's_smb').sieve.includes('size :over 17592186044415M'));
  noBlock(sz('18014398509481984', 's_skb'), 'parse-error', '2^54 K');
  assert.ok(sz('18014398509481983', 's_skb').converted);
  noBlock(sz('1e5', 's_sb'), 'parse-error', '지수');
  noBlock(sz('-5', 's_sb'), 'parse-error', '음수');
  noBlock(sz('5.5', 's_sb'), 'parse-error', '소수');
  noBlock(sz('9'.repeat(5000), 's_sb'), 'parse-error', '초대형');
});
test('부정 안의 to 는 필터 전체 제외, 짝수 부정·부정 밖·cc 는 변환', () => {
  noBlock(row0({ doesNotHaveTheWord: 'to:hidden@example.test', label: 'L' }), 'negated-to', 'dnh to:');
  noBlock(row0({ hasTheWord: '-to:x', label: 'L' }), 'negated-to', '-to:');
  noBlock(row0({ hasTheWord: 'a OR -to:x', label: 'L' }), 'negated-to', 'OR -to:');
  noBlock(row0({ hasTheWord: '-(a to:x)', label: 'L' }), 'negated-to', '-(…to:)');
  noBlock(row0({ hasTheWord: '-(-(-to:x))', label: 'L' }), 'negated-to', '3중');
  const even = row0({ hasTheWord: '-(-to:x)', label: 'L' });
  assert.ok(even.converted && even.sieve.includes('header :contains ["to", "cc"] "x"'), even.sieve);
  assert.ok(even.warnings.some((w) => w.code === 'to-no-bcc'));
  assert.ok(row0({ doesNotHaveTheWord: '-to:x', label: 'L' }).converted);
  const cc = row0({ doesNotHaveTheWord: 'cc:x', label: 'L' });
  assert.ok(cc.converted && cc.sieve.includes('not header :contains ["cc"] "x"'), cc.sieve);
  assert.ok(!cc.warnings.some((w) => w.code === 'to-no-bcc'));
  const pos = row0({ to: 'x@example.test', label: 'L' });
  assert.ok(pos.converted && pos.warnings.some((w) => w.code === 'to-no-bcc'));
});
test('from/to/subject 속성의 일반 단어 여러 개 = 구문 1개 (공백 하나로)', () => {
  const r = row0({ subject: 'Alpha  Beta\tGamma', from: 'Kim Lee', to: 'x y', label: 'L' });
  assert.ok(r.sieve.includes('header :contains "subject" "Alpha Beta Gamma"'), r.sieve);
  assert.ok(r.sieve.includes('header :contains "from" "Kim Lee"'), r.sieve);
  assert.ok(r.sieve.includes('header :contains ["to", "cc"] "x y"'), r.sieve);
  assert.strictEqual((r.sieve.match(/"subject"/g) || []).length, 1);
});
test('괄호·OR·따옴표가 섞인 속성 값은 기존 파서 그대로', () => {
  const a = row0({ subject: '(알파 베타 감마)', label: 'L' }).sieve;
  assert.strictEqual((a.match(/"subject"/g) || []).length, 3);
  const b = row0({ subject: '"a b" OR c', label: 'L' }).sieve;
  assert.ok(b.includes('anyof (header :contains "subject" "a b", header :contains "subject" "c")'), b);
  const c = row0({ subject: 'a -b', label: 'L' }).sieve;
  assert.ok(c.includes('not header :contains "subject" "b"'), c);
  assert.strictEqual((row0({ hasTheWord: 'x y', label: 'L' }).sieve.match(/anyof \(header/g) || []).length, 2);
});
test('부정 안 어디든 → any-neg 경고 (변환은 유지), 집계', () => {
  const r = row0({ subject: 'a', doesNotHaveTheWord: 'foo', label: 'L' });
  assert.ok(r.converted && r.warnings.some((w) => w.code === 'any-neg'));
  assert.ok(row0({ hasTheWord: '-foo', label: 'L' }).warnings.some((w) => w.code === 'any-neg'));
  assert.ok(!row0({ hasTheWord: '-(-foo)', label: 'L' }).warnings.some((w) => w.code === 'any-neg'));
  assert.ok(!row0({ hasTheWord: 'foo', label: 'L' }).warnings.some((w) => w.code === 'any-neg'));
  const out = G2S.convert([{ props: { doesNotHaveTheWord: 'a', subject: 's', label: 'L' } },
    { props: { doesNotHaveTheWord: 'b', subject: 's', label: 'L' } }], { now: NOW });
  assert.strictEqual(out.stats.byCode['any-neg'], 2);
});

test('필드 뒤 + 로 시작하는 항은 제외, 따옴표 안·주소 중간의 + 는 변환', () => {
  ['-subject:+unicorn', '-from:+user', 'subject:+x', 'to:+a@example.test', 'cc:+a', '-(subject:+x)',
    'from:to:+x'].forEach((v) => {
    [{ hasTheWord: v }, { doesNotHaveTheWord: v }].forEach((base) => {
      const props = Object.assign({ label: 'L', shouldArchive: 'true' }, base);
      noBlock(conv(props).rows[0], 'unsupported', JSON.stringify(props));
    });
  });
  noBlock(row0({ subject: 'from:+x', label: 'L' }), 'unsupported', 'subject attr');
  [['subject:"+x"', '"subject" "+x"'], ['"+unicorn"', '"+unicorn"'],
    ['from:user+tag@example.test', '"from" "user+tag@example.test"']].forEach(([v, want]) => {
    const r = row0({ hasTheWord: v, label: 'L' });
    assert.ok(r.converted && r.sieve.includes(want), v + ' ' + r.sieve);
  });
});

// ---------- 6. 실제 입력(선택) ----------
const real = process.env.G2S_REAL_XML;
if (real) {
  test('실제 mailFilters.xml: 파싱 실패 0, 행 수 = 항목 수', () => {
    const xml = fs.readFileSync(real, 'utf8');
    const filters = G2S.parseFiltersXml(xml, fakeDomParser);
    const out = G2S.convert(filters, { now: NOW });
    assert.strictEqual(out.rows.length, filters.length);
    assert.strictEqual(out.stats.byCode['parse-error'] || 0, 0);
    assert.strictEqual(out.stats.excluded, 0);
    console.log('     (필터 ' + filters.length + ', 변환 ' + out.stats.converted + ', 제외 ' + out.stats.excluded + ')');
  });
} else {
  console.log('skip 실제 입력 점검 (G2S_REAL_XML 미지정)');
}

console.log('\n' + passed + ' passed' + (process.exitCode ? ', FAILED 있음' : ''));
