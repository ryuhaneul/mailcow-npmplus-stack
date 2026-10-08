// 실행: node tools/gmail2sieve/app.test.js
// 실제 입력 점검(선택): G2S_REAL_XML=/path/to/mailFilters.xml node tools/gmail2sieve/app.test.js  (수치만 출력)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G2S = require('./core.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); } catch (e) {
    console.log('FAIL ' + name + '\n     ' + e.message);
    process.exitCode = 1;
  }
}

// app.html 의 순수 함수 블록만 떼어 실행한다
const appHtml = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
const pure = /<script id="view-pure">([\s\S]*?)<\/script>/.exec(appHtml);
const raw = new vm.Script(pure[1] + '\nG2SView;').runInNewContext({});
// vm 안에서 만든 객체는 deepStrictEqual 이 프로토타입 차이로 거부하므로 JSON 을 거쳐 비교한다
const J = (x) => JSON.parse(JSON.stringify(x));
const V = Object.assign({}, raw, {
  folderTree: (f) => J(raw.folderTree(f)),
  summaryItems: (s) => J(raw.summaryItems(s)),
  rowView: (...a) => J(raw.rowView(...a)),
  analyze: (t, d) => { const r = raw.analyze(t, d); return r.error ? J(r) : Object.assign(r, { ranges: J(r.ranges) }); },
});

// 테스트 전용 최소 DOMParser (core.test.js 와 같은 방식)
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
const DEPS = { G2S, parser: fakeDomParser, options: { now: NOW } };
const entry = (props) => '<entry>' + Object.keys(props).map((k) =>
  "<apps:property name='" + k + "' value='" + props[k].replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;') + "'/>").join('') + '</entry>';
const feed = (list) => "<?xml version='1.0'?><feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='x'>" + list.map(entry).join('') + '</feed>';

// 합성 표본: 변환(단순·여러 줄 조건·라벨 하위 폴더·휴지통) / 제외 / 생략 / 줄바꿈 주입 시도 포함
const SAMPLE = [
  { from: 'a@sample.test', label: 'Alpha', shouldArchive: 'true' },
  { hasTheWord: 'bcc:x@sample.test', label: 'Beta' },
  { subject: 'ping', smartLabelToApply: '^smartlabel_social' },
  { from: 'b@sample.test', to: 'c@sample.test', subject: 'long subject text for wrapping one', hasTheWord: '"alpha beta" OR "gamma delta" OR "epsilon zeta"', doesNotHaveTheWord: 'spam-word other-word third-word', label: 'Team/Sub', shouldNeverSpam: 'true' },
  { subject: 'news', shouldTrash: 'true' },
  { from: 'x@sample.test', label: 'Team/Other\n# [9] fake\n# 받은편지함 처리\ndiscard;' },
  { subject: 'last', label: 'Alpha' },
];

// ---------- 줄 범위 ----------
test('줄 범위: 모든 행의 범위 텍스트 = 엔진 comment + sieve (변환·제외·생략)', () => {
  const a = V.analyze(feed(SAMPLE), DEPS);
  assert.ok(!a.error, a.error);
  const rows = a.result.rows;
  assert.deepStrictEqual(rows.map((r) => r.status), ['converted', 'excluded', 'skipped', 'converted', 'converted', 'converted', 'converted']);
  const lines = a.result.script.split('\n');
  rows.forEach((r, i) => {
    const rg = a.ranges[i];
    const got = lines.slice(rg.start - 1, rg.end).join('\n');
    assert.strictEqual(got, r.comment + (r.sieve ? '\n' + r.sieve : ''), '행 ' + r.n);
  });
});
test('줄 범위: excluded·skipped 는 주석 한 줄만', () => {
  const a = V.analyze(feed(SAMPLE), DEPS);
  [1, 2].forEach((i) => assert.strictEqual(a.ranges[i].start, a.ranges[i].end, '행 ' + (i + 1)));
});
test('줄 범위: 마지막 행은 끝 결정 블록을 포함하지 않음', () => {
  const a = V.analyze(feed(SAMPLE), DEPS);
  const lines = a.result.script.split('\n');
  const last = a.ranges[a.ranges.length - 1];
  const fin = lines.findIndex((l) => l.indexOf('# 받은편지함 처리') === 0) + 1;
  assert.ok(last.end < fin, '마지막 행 끝 ' + last.end + ' / 끝 결정 블록 시작 ' + fin);
  assert.ok(!lines.slice(last.start - 1, last.end).join('\n').includes('hc_trash'));
});
test('줄 범위: 범위 사이는 빈 줄 하나, 범위 밖은 머리·빈 줄·끝 결정 블록뿐', () => {
  const a = V.analyze(feed(SAMPLE), DEPS);
  const lines = a.result.script.split('\n');
  for (let i = 1; i < a.ranges.length; i++) {
    assert.strictEqual(a.ranges[i].start, a.ranges[i - 1].end + 2);
    assert.strictEqual(lines[a.ranges[i].start - 2], '');
  }
  assert.strictEqual(lines.slice(0, a.ranges[0].start - 1).filter((l) => l !== '').length, 4); // 머리 주석 3 + require
  const finStart = a.ranges[a.ranges.length - 1].end + 2;
  assert.ok(lines[finStart - 1].indexOf('# 받은편지함 처리') === 0);
});
test('줄 범위: 줄바꿈 주입 시도(라벨·값 안의 가짜 주석)에도 범위가 어긋나지 않음', () => {
  const a = V.analyze(feed(SAMPLE), DEPS);
  const n6 = a.ranges[5];
  const lines = a.result.script.split('\n');
  assert.ok(lines.slice(n6.start - 1, n6.end).join('\n').includes('Team/Other'));
  assert.strictEqual(lines.filter((l) => l.indexOf('# [9] ') === 0).length, 0);
});
test('줄 범위: 여러 줄 조건이 한 범위 안에 들어감', () => {
  const a = V.analyze(feed(SAMPLE), DEPS);
  const r4 = a.ranges[3];
  assert.ok(r4.end - r4.start >= 6, JSON.stringify(r4));
});
test('줄 범위: 엔진 형식이 바뀌어 위치를 못 찾으면 예외', () => {
  const a = V.analyze(feed(SAMPLE), DEPS);
  const sc = a.result.script;
  const at = sc.lastIndexOf('# 받은편지함 처리');
  assert.throws(() => V.lineRanges(sc.slice(0, at) + '# x' + sc.slice(at + 10), a.result.rows), /끝 결정 블록/);
  assert.throws(() => V.lineRanges('# only head\n', a.result.rows), /필터 1/);
});

// ---------- 폴더 트리 ----------
test('폴더 트리: 하위 폴더·부모 공유·부모 자체 라벨·순서', () => {
  assert.deepStrictEqual(V.folderTree(['Team/Sub', 'Alpha', 'Team/Other', 'Team', 'Alpha']), [
    { name: 'Team', depth: 0, pending: true },
    { name: 'Sub', depth: 1, pending: true },
    { name: 'Other', depth: 1, pending: true },
    { name: 'Alpha', depth: 0, pending: true },
  ]);
  assert.deepStrictEqual(V.folderTree(['A/B/C']), [
    { name: 'A', depth: 0, pending: false },
    { name: 'B', depth: 1, pending: false },
    { name: 'C', depth: 2, pending: true },
  ]);
  assert.deepStrictEqual(V.folderTree([]), []);
  assert.deepStrictEqual(V.folderTree(['__proto__/x']).map((n) => n.name), ['__proto__', 'x']);
});
test('폴더 트리: 표본 입력의 폴더 수 = 엔진 stats', () => {
  const a = V.analyze(feed(SAMPLE), DEPS);
  assert.strictEqual(a.result.stats.folderCount, a.result.folders.length);
  assert.ok(V.folderTree(a.result.folders).filter((n) => n.pending).length === a.result.folders.length);
});

// ---------- 요약 ----------
test('요약: 필터/변환/제외/(생략)/경고/새 폴더, 생략 0이면 숨김', () => {
  const a = V.analyze(feed(SAMPLE), DEPS);
  const s = a.result.stats;
  const items = V.summaryItems(s);
  assert.deepStrictEqual(items.map((i) => i.label), ['필터', '변환', '제외', '생략', '경고', '새 폴더']);
  assert.deepStrictEqual(items.map((i) => i.value), [s.total, s.converted, s.excluded, s.skipped, s.filtersWithWarnings, s.folderCount]);
  assert.deepStrictEqual(items.map((i) => i.value), [7, 5, 1, 1, 3, 3]); // 합성 표본: 변환 5·제외 1·생략 1, 폴더 Alpha·Team/Sub·Team/Other…
  const none = V.summaryItems({ total: 2, converted: 2, excluded: 0, skipped: 0, filtersWithWarnings: 0, folderCount: 1 });
  assert.deepStrictEqual(none.map((i) => i.label), ['필터', '변환', '제외', '경고', '새 폴더']);
  assert.strictEqual(none.find((i) => i.key === 'warnings').tone, '');
});
test('요약: 변환 + 제외 + 생략 = 필터', () => {
  const s = V.analyze(feed(SAMPLE), DEPS).result.stats;
  assert.strictEqual(s.converted + s.excluded + s.skipped, s.total);
});

// ---------- 목록 행 ----------
test('행 보기: 라벨·동작·상태·경고 (엔진 WARNING_LABELS 사용)', () => {
  const a = V.analyze(feed(SAMPLE), DEPS);
  const v = (i) => V.rowView(a.result.rows[i], a.filters[i].props, G2S.WARNING_LABELS);
  assert.deepStrictEqual([v(0).no, v(0).label, v(0).flags, v(0).statusText, v(0).warnings.length], ['01', 'Alpha', ['받은편지함 건너뛰기'], '변환', 0]);
  assert.deepStrictEqual([v(1).statusText, v(1).label, v(1).warnings[0].label], ['제외', 'Beta', G2S.WARNING_LABELS.unsupported]);
  assert.ok(!v(1).warnings[0].text.startsWith('변환 제외'), v(1).warnings[0].text);
  assert.deepStrictEqual([v(2).statusText, v(2).label, v(2).flags], ['생략', '', []]);
  assert.deepStrictEqual(v(3).flags, ['스팸 안 보냄']);
  assert.deepStrictEqual(v(4).flags, ['휴지통']);
  assert.ok(!/[\n\r]/.test(v(5).label));
  a.result.rows.forEach((r, i) => assert.strictEqual(v(i).warnings.length, r.warnings.length));
});
test('행 보기: 경고 있는 행 수 = 요약의 경고 수, 라벨 없는 보관은 Archive', () => {
  const a = V.analyze(feed(SAMPLE.concat([{ from: 'q@sample.test', shouldArchive: 'true' }])), DEPS);
  const views = a.result.rows.map((r, i) => V.rowView(r, a.filters[i].props, G2S.WARNING_LABELS));
  assert.strictEqual(views.filter((x) => x.warnings.length).length, a.result.stats.filtersWithWarnings);
  assert.strictEqual(views[views.length - 1].label, 'Archive');
});
test('선택 표시 문구', () => {
  assert.strictEqual(V.rangeText('02', { start: 12, end: 16 }), '선택: 필터 02 → 12–16줄');
  assert.strictEqual(V.rangeText('08', { start: 38, end: 38 }), '선택: 필터 08 → 38줄');
});

// ---------- 파일 검사 ----------
test('오류 입력 4종: 5MB 초과 상수·빈 파일·XML 아님·필터 0개', () => {
  assert.strictEqual(V.MAX_BYTES, 5 * 1024 * 1024);
  assert.deepStrictEqual(V.analyze('', DEPS), { error: V.MSG.empty });
  assert.deepStrictEqual(V.analyze(' \n\t ', DEPS), { error: V.MSG.empty });
  assert.deepStrictEqual(V.analyze('<html><body>hi</body></html>', DEPS), { error: V.MSG.notXml });
  assert.deepStrictEqual(V.analyze('그냥 글자', DEPS), { error: V.MSG.notXml });
  assert.deepStrictEqual(V.analyze(feed([]), DEPS), { error: V.MSG.noFilters });
  assert.ok(V.MSG.tooBig.indexOf('5MB') >= 0);
});
test('변환 중 예외는 오류 안내로 바뀜', () => {
  const bad = { parseFiltersXml: () => [{ props: {} }], convert: () => { throw new Error('boom'); } };
  const r = V.analyze('<x/>', { G2S: bad, parser: null });
  assert.strictEqual(r.error, '변환 중 오류가 났습니다: boom');
});

// ---------- 복사 ----------
const asyncTest = (name, fn) => { pending.push([name, fn]); };
const pending = [];
asyncTest('복사: Clipboard API 성공 시 엔진 출력과 바이트 동일(끝 개행 포함), 폴백 호출 없음', async () => {
  const script = V.analyze(feed(SAMPLE), DEPS).result.script;
  assert.ok(script.endsWith('\n'));
  let got = null; let fb = 0;
  const how = await V.copyScript(script, { write: (t) => { got = t; return Promise.resolve(); }, fallback: () => { fb++; return true; } });
  assert.strictEqual(how, 'clipboard');
  assert.strictEqual(fb, 0);
  assert.ok(Buffer.from(got).equals(Buffer.from(script)));
});
asyncTest('복사: Clipboard API 거부 → 폴백에 같은 원문, 폴백 성공', async () => {
  const script = V.analyze(feed(SAMPLE), DEPS).result.script;
  let got = null;
  const how = await V.copyScript(script, { write: () => Promise.reject(new Error('denied')), fallback: (t) => { got = t; return true; } });
  assert.strictEqual(how, 'fallback');
  assert.ok(Buffer.from(got).equals(Buffer.from(script)));
});
asyncTest('복사: API 없음(동기 예외 포함) → 폴백, 둘 다 실패하면 failed', async () => {
  const script = 'x\n';
  assert.strictEqual(await V.copyScript(script, { write: null, fallback: () => true }), 'fallback');
  assert.strictEqual(await V.copyScript(script, { write: () => { throw new Error('sync'); }, fallback: () => true }), 'fallback');
  assert.strictEqual(await V.copyScript(script, { write: null, fallback: () => false }), 'failed');
  assert.strictEqual(await V.copyScript(script, { write: () => Promise.reject(new Error('x')), fallback: () => { throw new Error('y'); } }), 'failed');
});

asyncTest('복사: 요청 뒤 결과가 바뀌면 폴백을 실행하지 않고 stale (거부 뒤·API 없음·성공 뒤 모두)', async () => {
  let fb = 0; let ok = true;
  const deps = (write) => ({ write, fallback: () => { fb++; return true; }, valid: () => ok });
  let reject;
  const p1 = V.copyScript('x\n', deps(() => new Promise((res, rej) => { reject = rej; })));
  ok = false; reject(new Error('denied'));
  assert.strictEqual(await p1, 'stale');
  assert.strictEqual(await V.copyScript('x\n', deps(null)), 'stale');
  let resolve;
  ok = true;
  const p2 = V.copyScript('x\n', deps(() => new Promise((res) => { resolve = res; })));
  ok = false; resolve();
  assert.strictEqual(await p2, 'stale');
  assert.strictEqual(fb, 0, '폴백 실행 ' + fb + '회');
  ok = true;
  assert.strictEqual(await V.copyScript('x\n', deps(() => Promise.reject(new Error('d')))), 'fallback');
  assert.strictEqual(fb, 1);
});

// ---------- 화면 코드 점검 ----------
test('app.html: 사용자 데이터가 들어갈 수 있는 HTML 삽입 API 사용 0', () => {
  ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'createContextualFragment'].forEach((w) => {
    assert.ok(appHtml.indexOf(w) < 0, w);
  });
});
test('app.html: 외부 참조·네트워크 API 0', () => {
  [/https?:\/\//, /<script\b[^>]*\ssrc\b/, /<link\b/, /@import/, /url\(/, /\bfetch\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/].forEach((re) => {
    assert.ok(!re.test(appHtml), String(re));
  });
});
test('build.js: 여러 줄에 걸친 외부 참조를 놓치지 않음 (합성 복제본)', () => {
  const os = require('os');
  const cp = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g2s-build-'));
  const dir = path.join(root, 'tools', 'gmail2sieve');
  fs.mkdirSync(dir, { recursive: true });
  ['build.js', 'core.js'].forEach((f) => fs.copyFileSync(path.join(__dirname, f), path.join(dir, f)));
  const run = (html) => {
    fs.writeFileSync(path.join(dir, 'app.html'), html);
    return cp.spawnSync(process.execPath, [path.join(dir, 'build.js')], { encoding: 'utf8' });
  };
  try {
    const base = run(appHtml);
    assert.strictEqual(base.status, 0, '원본 복제본은 통과해야 함: ' + base.stderr);
    const inject = (frag) => appHtml.replace('</body>', frag + '\n</body>');
    [
      ['<script\n src="//example.test/x.js"></script>', /<script src/],
      ['<SCRIPT\n\tSRC = "x.js"></SCRIPT>', /<script src/],
      ['<link\nrel="stylesheet" href="x.css">', /<link/],
      ['<style>\n@IMPORT "x.css";\n</style>', /@import/],
      ['<style>a{background:url\n(x.png)}</style>'.replace('url\n(', 'url('), /url\(/],
      ['<img\nsrc=\n"//example.test/a.png">', /\/\/ 로 시작/],
      ['<a href="//example.test/">x</a>', /\/\/ 로 시작/],
      ['<a href="https://example.test/">x</a>', /https:\/\//],
    ].forEach(([frag, re]) => {
      const r = run(inject(frag));
      assert.strictEqual(r.status, 1, JSON.stringify(frag) + ' 가 통과함');
      assert.ok(re.test(r.stderr), JSON.stringify(frag) + ' → ' + r.stderr);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('빌드 산출물: 최신 (build.js --check 와 같은 검사)', () => {
  const cp = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'build.js'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(cp.status, 0, cp.stderr + cp.stdout);
});

// ---------- 실제 입력(선택, 수치만 출력) ----------
const real = process.env.G2S_REAL_XML;
if (real) {
  test('실제 mailFilters.xml: 범위 검증 통과, 요약 수치 출력', () => {
    const a = V.analyze(fs.readFileSync(real, 'utf8'), { G2S, parser: fakeDomParser, options: { now: NOW } });
    assert.ok(!a.error, a.error);
    const lines = a.result.script.split('\n');
    a.result.rows.forEach((r, i) => {
      assert.strictEqual(lines.slice(a.ranges[i].start - 1, a.ranges[i].end).join('\n'), r.comment + (r.sieve ? '\n' + r.sieve : ''));
    });
    console.log('     ' + V.summaryItems(a.result.stats).map((i) => i.label + ' ' + i.value).join(' / '));
  });
} else {
  console.log('skip 실제 입력 점검 (G2S_REAL_XML 미지정)');
}

(async () => {
  for (const [name, fn] of pending) {
    try { await fn(); passed++; console.log('ok   ' + name); } catch (e) {
      console.log('FAIL ' + name + '\n     ' + e.message);
      process.exitCode = 1;
    }
  }
  console.log('\n' + passed + ' passed' + (process.exitCode ? ', FAILED 있음' : ''));
})();
