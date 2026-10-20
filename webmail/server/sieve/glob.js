// Pure Sieve :matches helpers. Only ASCII case folding; ? is not a wildcard.
const lower = value => value.replace(/[A-Z]/g, c => c.toLowerCase());

export function patternProblem(value) {
  let stars = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') {
      if (++i === value.length || !['*', '?', '\\'].includes(value[i])) return 'pattern_escape';
    } else if (value[i] === '?') return 'pattern_question';
    else if (value[i] === '*' && ++stars > 20) return 'pattern_complexity';
  }
  return null;
}

export const quoteSieve = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Whole-value match, bounded by pattern × target, without regex/backtracking trees. */
export function globMatch(pattern, value) {
  if (patternProblem(pattern)) return false;
  const tokens = [];
  const folded = lower(pattern);
  for (let i = 0; i < folded.length; i++) {
    if (folded[i] === '\\') tokens.push(folded[++i]);
    else if (folded[i] === '*') { if (tokens.at(-1) !== null) tokens.push(null); }
    else tokens.push(folded[i]);
  }
  const target = lower(value);
  let p = 0, v = 0, star = -1, retry = 0;
  while (v < target.length) {
    if (p < tokens.length && tokens[p] === null) { star = p++; retry = v; }
    else if (p < tokens.length && tokens[p] === target[v]) { p++; v++; }
    else if (star >= 0) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (p < tokens.length && tokens[p] === null) p++;
  return p === tokens.length;
}
