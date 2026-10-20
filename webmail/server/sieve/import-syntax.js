import { normalizeConditionTree } from './condition-tree.js';
import { patternProblem } from './glob.js';
// Deliberately limited reader for known import formats; no Sieve is executed.
export const unsupported = reason => { throw new Error(reason); };

export function tokens(source) {
  const result = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source[i] === '#') { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) unsupported('닫히지 않은 주석이에요.');
      i = end + 2; continue;
    }
    if (source[i] === '"') {
      let value = ''; let closed = false;
      for (i++; i < source.length; i++) {
        if (source[i] === '"') { i++; closed = true; break; }
        if (source[i] === '\\') {
          i++;
          if (i >= source.length || !['\\', '"'].includes(source[i])) unsupported('지원하지 않는 문자열 이스케이프예요.');
        }
        value += source[i];
      }
      if (!closed) unsupported('닫히지 않은 문자열이에요.');
      result.push({ string: value }); continue;
    }
    const atom = /^(?::?[a-zA-Z_][a-zA-Z0-9_-]*|\d+[KMGkmg]?|[\[\](){},;])/.exec(source.slice(i));
    if (!atom) unsupported('지원하지 않는 Sieve 문법이에요.');
    result.push(atom[0].toLowerCase()); i += atom[0].length;
  }
  return result;
}

export class Reader {
  constructor(source) { this.values = tokens(source); this.i = 0; }
  peek() { return this.values[this.i]; }
  take() { return this.values[this.i++]; }
  expect(value) { if (this.take() !== value) unsupported('알려진 필터 구조와 달라요.'); }
  string() { const value = this.take(); if (!value || typeof value !== 'object') unsupported('문자열이 필요해요.'); return value.string; }
  strings() {
    if (this.peek() !== '[') return [this.string()];
    this.take(); const values = [this.string()];
    while (this.peek() === ',') { this.take(); values.push(this.string()); }
    this.expect(']'); return values;
  }
  done() { if (this.i !== this.values.length) unsupported('해석하지 못한 Sieve 내용이 남았어요.'); }
}

function prefix(pattern) {
  let result = ''; let stars = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      if (++i === pattern.length) unsupported('잘못된 와일드카드예요.');
      result += pattern[i];
    } else if (char === '*') {
      if (i !== pattern.length - 1 || ++stars > 1) unsupported('끝의 별표 하나만 가져올 수 있어요.');
    } else if (char === '?') unsupported('물음표 와일드카드는 가져올 수 없어요.');
    else result += char;
  }
  if (stars !== 1 || !result) unsupported('끝의 별표 하나만 가져올 수 있어요.');
  return result;
}

export function readConditions(reader, depth = 0) {
  function read(level) {
    if (level > 8) unsupported('조건이 너무 복잡해요.');
    const keyword = reader.take();
    if (['allof', 'anyof'].includes(keyword)) {
      reader.expect('('); const parts = [read(level + 1)];
      while (reader.peek() === ',') { reader.take(); parts.push(read(level + 1)); }
      reader.expect(')');
      return { match: keyword === 'allof' ? 'all' : 'any', conditions: parts };
    }
    if (keyword === 'not') return { not: read(level + 1) };
    if (!['header', 'address'].includes(keyword)) unsupported('본문·크기 또는 지원하지 않는 조건이에요.');
    let comparator = ':is';
    while (typeof reader.peek() === 'string' && reader.peek().startsWith(':')) {
      const tag = reader.take();
      if ([':contains', ':is', ':matches'].includes(tag)) comparator = tag;
      else if (tag === ':comparator') {
        if (reader.string() !== 'i;ascii-casemap') unsupported('지원하지 않는 비교 방식이에요.');
      } else if (tag !== ':all' || keyword !== 'address') unsupported('지원하지 않는 비교 방식이에요.');
    }
    const headers = reader.strings().map(value => value.toLowerCase()).sort();
    const values = reader.strings();
    if (keyword === 'header' && comparator === ':contains' && headers.length === 1 && headers[0] === 'content-type'
      && values.length === 1 && values[0] === 'multipart/mixed') return { field: 'attachment', op: 'has', value: '' };
    const field = headers.length === 1 && ['from', 'subject'].includes(headers[0]) ? headers[0]
      : JSON.stringify(headers) === '["cc","to"]' ? 'to' : null;
    if (!field) unsupported('이 머리글 검사는 같은 뜻으로 옮길 수 없어요.');
    if (keyword === 'address' && field === 'subject') unsupported('제목 주소 검사는 지원하지 않아요.');
    if (keyword === 'address' && comparator === ':contains') unsupported('주소만 포함하는 조건은 머리글 포함과 달라요.');
    if (keyword === 'header' && field !== 'subject' && comparator !== ':contains') unsupported('머리글 전체 비교는 주소 비교와 달라요.');
    const conditions = values.map(value => {
      let op = { ':contains': 'has', ':is': 'eq', ':matches': 'matches' }[comparator];
      if (op === 'matches') {
        const reason = patternProblem(value);
        if (reason) unsupported(reason);
        // Preserve the legacy v:1 representation for an exact literal prefix.
        try { const literal = prefix(value); op = 'start'; value = literal; } catch { /* General glob stays matches. */ }
      }
      return { field, op, value };
    });
    return { match: 'any', conditions };
  }
  try { return normalizeConditionTree(read(depth)); }
  catch (error) {
    if (error.reason === 'group_shape') unsupported('조건이 너무 복잡해요.');
    if (error.reason === 'negation') unsupported('이 제외 조건은 옮길 수 없어요.');
    throw error;
  }
}

export function unknownItems(source) {
  let all;
  try { all = tokens(source); } catch { return [{ n: 1, summary: '해석할 수 없는 스크립트', status: 'unconvertible', changes: [], reason: '모르는 스크립트 형식이에요.' }]; }
  const parts = []; let start = 0; let depth = 0;
  for (let i = 0; i < all.length; i++) {
    if (all[i] === '{') depth++;
    if (all[i] === '}') depth--;
    if (depth === 0 && (all[i] === ';' || all[i] === '}')) {
      if (all[start] !== 'require') parts.push(all.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < all.length) parts.push(all.slice(start));
  return parts.map((_, i) => ({ n: i + 1, summary: `알 수 없는 블록 ${i + 1}`, status: 'unconvertible', changes: [], reason: '모르는 스크립트 형식이에요.' }));
}
