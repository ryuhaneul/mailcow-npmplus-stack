/* Gmail 필터(mailFilters.xml) → Sieve 변환 코어. 순수 함수만(DOM·네트워크 사용 금지).
 * 브라우저: 전역 G2S / Node: module.exports. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.G2S = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 오류 ----------
  class ConvError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const unsupported = (m) => new ConvError('unsupported', m);
  const parseError = (m) => new ConvError('parse-error', m);

  // ---------- 문자열 정리 ----------
  // 제어문자·줄바꿈(\r \n \t, NEL, U+2028/2029 포함)
  const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
  const oneLine = (s) => String(s).replace(CTRL, ' ').replace(/ {2,}/g, ' ').trim();
  const cleanValue = (s) => String(s).replace(CTRL, ' ').trim();

  // Sieve 문자열 리터럴. variables 확장이 켜져 있어 `${` 는 변수 치환되므로 변환하지 않는다.
  function str(v) {
    if (v.indexOf('${') >= 0) throw unsupported('값에 "${" 가 있어 Sieve 변수 치환과 충돌합니다');
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  // :matches 패턴: * 는 와일드카드로 두고 \ 와 ? 는 글자 그대로 비교
  const matchPattern = (v) => v.replace(/\\/g, '\\\\').replace(/\?/g, '\\?');

  // ---------- XML ----------
  function parseFiltersXml(xmlText, domParser) {
    const doc = domParser.parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML 을 읽을 수 없습니다');
    const entries = doc.getElementsByTagName('entry');
    const filters = [];
    for (let i = 0; i < entries.length; i++) {
      const props = {};
      const ps = entries[i].getElementsByTagName('apps:property');
      for (let j = 0; j < ps.length; j++) {
        props[ps[j].getAttribute('name')] = ps[j].getAttribute('value') || '';
      }
      filters.push({ props: props });
    }
    return filters;
  }

  // ---------- Gmail 검색식 파서 ----------
  // Gmail 연산자 표(자체 속성만: Map). 지원 4종 외 나머지는 필터 전체 제외.
  // 이 표에 없는 `단어:` 는 연산자가 아니라 일반 단어로 취급한다.
  const FIELDS = new Map([['from', 'from'], ['to', 'to'], ['cc', 'cc'], ['subject', 'subject']]);
  const UNSUPPORTED_OPS = new Set(['bcc', 'after', 'before', 'older', 'newer', 'older_than', 'newer_than',
    'label', 'category', 'has', 'list', 'filename', 'in', 'is', 'deliveredto', 'size', 'larger', 'smaller',
    'rfc822msgid', 'header']);

  function tokenize(src) {
    const toks = [];
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '(') { toks.push({ t: 'LP' }); i++; continue; }
      if (c === ')') { toks.push({ t: 'RP' }); i++; continue; }
      if (c === '|') { toks.push({ t: 'OR' }); i++; continue; }
      if (c === '-') { toks.push({ t: 'NEG' }); i++; continue; }
      if (c === '{' || c === '}') throw unsupported('{…} (OR 묶음) 문법은 변환하지 않습니다');
      if (c === '+') throw unsupported('+ 로 시작하는 검색어(정확 일치)는 변환하지 않습니다');
      if (c === '"') {
        const j = src.indexOf('"', i + 1);
        if (j < 0) throw parseError('닫히지 않은 따옴표');
        toks.push({ t: 'STR', v: src.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
      let j = i;
      while (j < n && !/[\s()"|{}]/.test(src[j])) j++;
      const w = src.slice(i, j);
      i = j;
      if (w === 'OR') { toks.push({ t: 'OR' }); continue; }
      if (w === 'AND') { toks.push({ t: 'AND' }); continue; }
      if (w === 'AROUND') throw unsupported('AROUND 연산자는 변환하지 않습니다');
      // 연산자 이름 뒤에 다시 연산자가 오는 경우(from:bcc:x)도 같은 방식으로 계속 해석
      let rest = w;
      for (;;) {
        const m = /^([A-Za-z0-9_]+):+([\s\S]*)$/.exec(rest);
        const name = m && m[1].toLowerCase();
        if (m && UNSUPPORTED_OPS.has(name)) throw unsupported('"' + name + ':" 연산자는 변환하지 않습니다');
        if (!m || !FIELDS.has(name)) {
          if (rest[0] === '+') throw unsupported('+ 로 시작하는 검색어(정확 일치)는 변환하지 않습니다');
          if (rest) toks.push({ t: 'WORD', v: rest });
          break;
        }
        toks.push({ t: 'FIELD', v: FIELDS.get(name) });
        rest = m[2];
      }
    }
    return toks;
  }

  const mk = (type, kids) => {
    const flat = [];
    kids.forEach((k) => { if (k.t === type) flat.push.apply(flat, k.kids); else flat.push(k); });
    return flat.length === 1 ? flat[0] : { t: type, kids: flat };
  };

  // 우선순위: NOT(-) > AND(명시·암묵) > OR. ctx = 'any' | 'from' | 'to' | 'cc' | 'subject'
  function parseExpr(src, ctx) {
    const toks = tokenize(src);
    let pos = 0;
    const peek = () => toks[pos];

    function primary(c) {
      const tok = toks[pos++];
      if (!tok) throw parseError('식이 중간에 끝났습니다');
      switch (tok.t) {
        case 'LP': {
          const e = or(c);
          if (!peek() || peek().t !== 'RP') throw parseError('괄호 짝이 맞지 않습니다');
          pos++;
          return e;
        }
        case 'NEG': return { t: 'not', kid: primary(c) };
        case 'FIELD': return primary(tok.v);
        case 'STR':
        case 'WORD': {
          const v = cleanValue(tok.v);
          if (!v) throw parseError('빈 검색어');
          return { t: 'term', field: c, value: v };
        }
        default: throw parseError('예상치 못한 "' + (tok.t === 'RP' ? ')' : tok.t) + '"');
      }
    }
    function and(c) {
      const kids = [primary(c)];
      for (;;) {
        const t = peek();
        if (!t || t.t === 'OR' || t.t === 'RP') break;
        if (t.t === 'AND') pos++;
        kids.push(primary(c));
      }
      return mk('and', kids);
    }
    function or(c) {
      const kids = [and(c)];
      while (peek() && peek().t === 'OR') { pos++; kids.push(and(c)); }
      return mk('or', kids);
    }

    const e = or(ctx);
    if (pos < toks.length) throw parseError('괄호 짝이 맞지 않습니다');
    return e;
  }

  // ---------- AST → Sieve ----------
  function termSieve(node, facts, neg) {
    const v = node.value;
    switch (node.field) {
      case 'from':
      case 'to':
      case 'cc': {
        const hdr = node.field === 'from' ? '"from"' : node.field === 'to' ? '["to", "cc"]' : '["cc"]';
        if (node.field === 'to') {
          // 부정 안에서 Bcc 를 못 보면 제외 조건이 약해져 필터가 넓어짐
          if (neg) throw new ConvError('negated-to', '제외 조건의 받는 사람 검사는 숨은참조를 못 봐서 조건이 넓어집니다');
          facts.to = true;
        }
        if (v.indexOf('*') >= 0) {
          facts.wildcard = true;
          return 'address :matches ' + hdr + ' ' + str(matchPattern(v));
        }
        return 'header :contains ' + hdr + ' ' + str(v);
      }
      case 'subject':
        if (v.indexOf('*') >= 0) facts.literalStar = true;
        return 'header :contains "subject" ' + str(v);
      default:
        facts.any = true;
        if (neg) facts.anyNeg = true;
        if (v.indexOf('*') >= 0) facts.literalStar = true;
        return 'anyof (header :contains ["subject", "from", "to", "cc"] ' + str(v) +
          ', body :text :contains ' + str(v) + ')';
    }
  }

  // neg: `not` 이 홀수 번 걸린 위치인지
  function fmt(node, ind, facts, neg) {
    if (node.t === 'raw') return node.text; // size 테스트
    if (node.t === 'term') return termSieve(node, facts, neg);
    if (node.t === 'not') return 'not ' + fmt(node.kid, ind, facts, !neg);
    const kw = node.t === 'and' ? 'allof' : 'anyof';
    const parts = node.kids.map((k) => fmt(k, ind + 2, facts, neg));
    const one = kw + ' (' + parts.join(', ') + ')';
    if (one.length + ind <= 90 && one.indexOf('\n') < 0) return one;
    const pad = ' '.repeat(ind + 2);
    return kw + ' (\n' + parts.map((p) => pad + p).join(',\n') + '\n' + ' '.repeat(ind) + ')';
  }

  // ---------- 필터 하나 ----------
  const KNOWN = ['from', 'to', 'subject', 'hasTheWord', 'doesNotHaveTheWord', 'size', 'sizeOperator',
    'sizeUnit', 'label', 'shouldArchive', 'shouldTrash', 'shouldNeverSpam', 'shouldMarkAsRead',
    'shouldStar', 'shouldAlwaysMarkAsImportant', 'shouldNeverMarkAsImportant', 'forwardTo',
    'smartLabelToApply'];
  const OUT_OF_SCOPE = ['shouldMarkAsRead', 'shouldStar', 'shouldAlwaysMarkAsImportant',
    'shouldNeverMarkAsImportant'];
  const UNSUPPORTED_CRITERIA = ['hasAttachment'];
  const isTrue = (v) => v === 'true';

  function summarize(p) {
    const cond = [];
    ['from', 'to', 'subject', 'hasTheWord', 'doesNotHaveTheWord'].forEach((k) => {
      if (p[k]) cond.push(k + '=' + p[k]);
    });
    if (p.size) cond.push('size ' + (p.sizeOperator || '?') + ' ' + p.size + (p.sizeUnit ? ' ' + p.sizeUnit : ''));
    const act = [];
    if (p.label) act.push('label=' + p.label);
    Object.keys(p).forEach((k) => {
      if (k.indexOf('should') === 0 && isTrue(p[k])) act.push(k);
    });
    if (p.forwardTo) act.push('forwardTo=' + p.forwardTo);
    if (p.smartLabelToApply) act.push('smartLabelToApply=' + p.smartLabelToApply);
    return { cond: oneLine(cond.join(' / ')), act: oneLine(act.join(', ')) };
  }

  const SIZE_OP = new Map([['s_sl', ':over'], ['s_ss', ':under']]);
  const SIZE_UNIT = new Map([['s_smb', { suffix: 'M', mult: 1048576n }], ['s_skb', { suffix: 'K', mult: 1024n }]]);
  const SIEVE_MAX = 18446744073709551615n;

  function buildCondition(p, facts) {
    UNSUPPORTED_CRITERIA.forEach((k) => {
      if (p[k]) throw unsupported('"' + k + '" 조건은 변환하지 않습니다');
    });
    const kids = [];
    const add = (attr, ctx, negate) => {
      const raw = p[attr];
      if (!raw || !raw.trim()) return;
      let e;
      try {
        // 따옴표·괄호·OR 등 없이 일반 단어만 있는 from/to/subject 속성 값은 구문 하나
        const toks = ctx === 'any' ? [] : tokenize(raw);
        e = toks.length && toks.every((t) => t.t === 'WORD')
          ? { t: 'term', field: ctx, value: cleanValue(toks.map((t) => t.v).join(' ')) }
          : parseExpr(raw, ctx);
      } catch (err) {
        if (err instanceof ConvError) err.message = attr + ': ' + err.message;
        throw err;
      }
      kids.push(negate ? { t: 'not', kid: e } : e);
    };
    add('from', 'from');
    add('to', 'to');
    add('subject', 'subject');
    add('hasTheWord', 'any');
    add('doesNotHaveTheWord', 'any', true);
    if (p.size && p.size.trim()) {
      if (!/^\d+$/.test(p.size.trim())) throw parseError('size: 숫자가 아닙니다');
      const op = SIZE_OP.get(p.sizeOperator);
      if (!op) throw parseError('size: 크기 비교 방향(sizeOperator)을 알 수 없습니다');
      const unit = SIZE_UNIT.get(p.sizeUnit) || { suffix: '', mult: 1n };
      const num = BigInt(p.size.trim());
      if (num * unit.mult > SIEVE_MAX) throw parseError('size: Sieve 가 받을 수 있는 최대 크기(2^64-1 바이트)를 넘습니다');
      kids.push({ t: 'raw', text: 'size ' + op + ' ' + num + unit.suffix });
    }
    if (!kids.length) throw new ConvError('no-condition', '변환할 조건이 없습니다');
    return mk('and', kids);
  }

  function convertOne(filter, n) {
    const p = filter.props || {};
    const s = summarize(p);
    const summary = s.cond + (s.act ? ' => ' + s.act : '');
    const row = {
      n: n, conditionSummary: s.cond, actionSummary: s.act, summary: summary,
      status: 'converted', converted: false, warnings: [], folders: [], sieve: '', comment: '',
    };
    const warn = (code, text) => row.warnings.push({ code: code, text: text });

    // 조건
    const facts = {};
    let cond;
    try {
      cond = buildCondition(p, facts);
      cond = fmt(cond, 0, facts, false);
    } catch (e) {
      if (!(e instanceof ConvError)) throw e;
      row.status = 'excluded';
      row.comment = '# [' + n + '] (변환 제외) ' + oneLine(summary);
      warn(e.code, '변환 제외 — ' + e.message);
      return row;
    }

    // 동작
    const lines = [];
    const folders = [];
    const label = cleanValue(p.label || '');
    const archive = isTrue(p.shouldArchive);
    try {
      if (label) { lines.push('fileinto :create :copy ' + str(label) + ';'); folders.push(label); }
      else if (archive) {
        lines.push('fileinto :create :copy "Archive";');
        folders.push('Archive');
        warn('archive-no-label', '라벨 없이 보관만 지정된 필터 — "Archive" 폴더로 사본을 넣습니다');
      }
    } catch (e) {
      if (!(e instanceof ConvError)) throw e;
      row.status = 'excluded';
      row.comment = '# [' + n + '] (변환 제외) ' + oneLine(summary);
      warn(e.code, '변환 제외 — 라벨: ' + e.message);
      return row;
    }
    if (archive) lines.push('set "hc_archive" "1";');
    if (isTrue(p.shouldTrash)) lines.push('set "hc_trash" "1";');
    if (isTrue(p.shouldNeverSpam)) lines.push('set "hc_neverspam" "1";');

    // 경고
    if (facts.wildcard) warn('wildcard', '값의 * 를 Sieve 와일드카드(:matches)로 재해석했습니다. Gmail 과 의미가 다를 수 있고, 주소만 비교합니다(표시 이름 제외)');
    if (facts.to) warn('to-no-bcc', 'to 는 To·Cc 헤더만 비교합니다. Gmail 은 Bcc 수신도 포함하므로 Bcc 로 받은 메일은 걸리지 않습니다');
    if (facts.any) warn('any-approx', '"어디든" 검색어는 제목·보낸 사람·받는 사람·참조 헤더와 본문 텍스트를 보는 근사 변환입니다. Gmail 전체 검색과 같지 않습니다');
    if (facts.anyNeg) warn('any-neg', '제외할 단어를 제목·주소·본문 텍스트에서만 찾습니다. 첨부 등 다른 곳에만 있으면 제외되지 않아 이 필터가 적용될 수 있습니다');
    if (facts.literalStar) warn('literal-star', '제목/어디든 검색어의 * 는 와일드카드가 아니라 글자 그대로 비교합니다');
    if (p.smartLabelToApply) warn('smartlabel', 'smartLabelToApply(' + oneLine(p.smartLabelToApply) + ') 는 무시했습니다');
    OUT_OF_SCOPE.forEach((k) => {
      if (isTrue(p[k])) warn('out-of-scope', k + ' 는 변환 범위 밖이라 무시했습니다');
    });
    if (p.forwardTo) warn('forward', 'forwardTo 는 외부 전달 정책상 변환하지 않았습니다');
    Object.keys(p).forEach((k) => {
      if (KNOWN.indexOf(k) < 0 && UNSUPPORTED_CRITERIA.indexOf(k) < 0) {
        warn('unknown-prop', '알 수 없는 속성 ' + oneLine(k) + ' 는 무시했습니다');
      }
    });

    if (!lines.length) {
      row.status = 'skipped';
      row.comment = '# [' + n + '] (동작 없음 — 변환 생략) ' + oneLine(summary);
      warn('no-action', '변환할 동작(라벨·보관·휴지통·스팸 제외)이 없어 블록을 만들지 않았습니다');
      return row;
    }

    row.converted = true;
    row.folders = folders;
    row.comment = '# [' + n + '] ' + oneLine(summary);
    row.sieve = 'if ' + cond + ' {\n' + lines.map((l) => '  ' + l).join('\n') + '\n}';
    return row;
  }

  // ---------- 전체 ----------
  const REQUIRE = 'require ["fileinto", "copy", "mailbox", "body", "variables"];';
  const FINAL_BLOCK = [
    '# 받은편지함 처리 — 위 필터들이 남긴 표시를 보고 한 번만 결정',
    'if string :is "${hc_trash}" "1" {',
    '  fileinto "Trash";',
    '} elsif string :is "${hc_archive}" "1" {',
    '  discard;   # 받은편지함 사본만 취소 — 위에서 넣은 폴더 사본은 그대로 배달됨',
    '} elsif string :is "${hc_neverspam}" "1" {',
    '  fileinto "INBOX";   # 받은편지함 명시 저장 → 이후 서버 전역 스팸→정크 규칙 건너뜀',
    '}',
  ].join('\n');

  const WARNING_LABELS = {
    unsupported: '변환 제외 — 미지원 문법',
    'parse-error': '변환 제외 — 해석 실패',
    'no-condition': '변환 제외 — 조건 없음',
    wildcard: '와일드카드(*) 재해석',
    'to-no-bcc': 'to 는 To·Cc 만 비교(Bcc 제외)',
    'any-approx': '"어디든" 검색 근사 변환',
    'negated-to': '변환 제외 — 제외 조건의 받는 사람(to) 검사',
    'any-neg': '제외할 단어를 일부 위치에서만 검사',
    'literal-star': '* 를 글자 그대로 비교',
    smartlabel: 'smartLabel 무시',
    'out-of-scope': '범위 밖 동작 무시',
    forward: '전달(forwardTo) 변환 안 함',
    'archive-no-label': '라벨 없는 보관 → Archive',
    'no-action': '동작 없음 — 블록 생략',
    'unknown-prop': '알 수 없는 속성 무시',
  };

  function convert(filters, options) {
    options = options || {};
    const now = options.now ? new Date(options.now) : new Date();
    const rows = filters.map((f, i) => convertOne(f, i + 1));

    const folders = [];
    rows.forEach((r) => r.folders.forEach((f) => { if (folders.indexOf(f) < 0) folders.push(f); }));

    const warnings = [];
    const byCode = {};
    rows.forEach((r) => {
      const seen = {};
      r.warnings.forEach((w) => {
        warnings.push({ n: r.n, code: w.code, text: w.text });
        if (!seen[w.code]) { seen[w.code] = true; byCode[w.code] = (byCode[w.code] || 0) + 1; }
      });
    });

    const head = [
      '# Gmail 필터 → Sieve 변환 결과 (gmail2sieve)',
      '# 생성 시각: ' + now.toISOString(),
      '# 원본 필터 수: ' + filters.length,
      REQUIRE,
    ].join('\n');
    const script = [head].concat(rows.map((r) => r.comment + (r.sieve ? '\n' + r.sieve : '')), [FINAL_BLOCK]).join('\n\n') + '\n';

    const stats = {
      total: rows.length,
      converted: rows.filter((r) => r.converted).length,
      excluded: rows.filter((r) => r.status === 'excluded').length,
      skipped: rows.filter((r) => r.status === 'skipped').length,
      filtersWithWarnings: rows.filter((r) => r.warnings.length).length,
      warningCount: warnings.length,
      folderCount: folders.length,
      byCode: byCode,
    };
    return { script: script, folders: folders, rows: rows, warnings: warnings, stats: stats };
  }

  return { parseFiltersXml: parseFiltersXml, convert: convert, parseExpr: parseExpr, WARNING_LABELS: WARNING_LABELS };
});
