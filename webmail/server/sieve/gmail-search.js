// Vendored from tools/gmail2sieve/core.js at be12f6b0ee6065b05798240cf5661301aa2f6d20.
// Search parser only: return an AST, never Sieve or a permissively decoded XML document.
class ConvError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const unsupported = message => new ConvError('unsupported', message);
const parseError = message => new ConvError('parse-error', message);
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const cleanValue = value => String(value).replace(CTRL, ' ').trim();

  // ---------- Gmail 검색식 파서 ----------
  // Gmail 연산자 표(자체 속성만: Map). 지원 4종 외 나머지는 필터 전체 제외.
  // 이 표에 없는 `단어:` 는 연산자가 아니라 일반 단어로 취급한다.
  const FIELDS = new Map([['from', 'from'], ['to', 'to'], ['cc', 'cc'], ['subject', 'subject']]);
  const UNSUPPORTED_OPS = new Set(['bcc', 'after', 'before', 'older', 'newer', 'older_than', 'newer_than',
    'label', 'category', 'has', 'list', 'filename', 'in', 'is', 'deliveredto', 'size', 'larger', 'smaller',
    'rfc822msgid', 'header']);

  function tokenize(src) {
    const toks = [];
    const push = (...values) => {
      if (toks.length + values.length > 200) throw unsupported('검색식 토큰 200개 한도를 넘었어요');
      toks.push(...values);
    };
    let depth = 0;
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '(') { if (++depth > 8) throw unsupported('검색식 괄호 8단 한도를 넘었어요'); push({ t: 'LP' }); i++; continue; }
      if (c === ')') { depth--; push({ t: 'RP' }); i++; continue; }
      if (c === '|') { push({ t: 'OR' }); i++; continue; }
      if (c === '-') { push({ t: 'NEG' }); i++; continue; }
      if (c === '{' || c === '}') throw unsupported('{…} (OR 묶음) 문법은 변환하지 않습니다');
      if (c === '+') throw unsupported('+ 로 시작하는 검색어(정확 일치)는 변환하지 않습니다');
      if (c === '"') {
        const j = src.indexOf('"', i + 1);
        if (j < 0) throw parseError('닫히지 않은 따옴표');
        push({ t: 'STR', v: src.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
      let j = i;
      while (j < n && !/[\s()"|{}]/.test(src[j])) j++;
      const w = src.slice(i, j);
      i = j;
      if (w === 'OR') { push({ t: 'OR' }); continue; }
      if (w === 'AND') { push({ t: 'AND' }); continue; }
      if (w === 'AROUND') throw unsupported('AROUND 연산자는 변환하지 않습니다');
      // 연산자 이름 뒤에 다시 연산자가 오는 경우(from:bcc:x)도 같은 방식으로 계속 해석
      let rest = w;
      for (;;) {
        const m = /^([A-Za-z0-9_]+):+([\s\S]*)$/.exec(rest);
        const name = m && m[1].toLowerCase();
        if (m && UNSUPPORTED_OPS.has(name)) throw unsupported('"' + name + ':" 연산자는 변환하지 않습니다');
        if (!m || !FIELDS.has(name)) {
          if (rest[0] === '+') throw unsupported('+ 로 시작하는 검색어(정확 일치)는 변환하지 않습니다');
          if (rest) push({ t: 'WORD', v: rest });
          break;
        }
        push({ t: 'FIELD', v: FIELDS.get(name) });
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


/** Preserve the original converter's plain multiword field values as one term. */
export function parseGmailSearch(source, context = 'any') {
  const tokens = tokenize(source);
  return context !== 'any' && tokens.length && tokens.every(token => token.t === 'WORD')
    ? { t: 'term', field: context, value: cleanValue(tokens.map(token => token.v).join(' ')) }
    : parseExpr(source, context);
}

export { tokenize, parseExpr };
