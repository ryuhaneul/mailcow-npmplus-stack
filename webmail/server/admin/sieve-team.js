// Port of toolkit/app/sieve_dist.py: edit only isolated top-level copy redirects.
export const addressPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
class Unparseable extends Error {}
export class Refused extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
const open = { '{': '}', '(': ')', '[': ']' };
function tokenize(script) {
  const tokens = [], stack = [];
  let i = 0;
  while (i < script.length) {
    const c = script[i];
    if (' \t\r\n'.includes(c)) { i++; continue; }
    if (c === '#') { const end = script.indexOf('\n', i); i = end < 0 ? script.length : end + 1; continue; }
    if (c === '/') {
      if (!script.startsWith('/*', i)) throw new Unparseable('unexpected character');
      const end = script.indexOf('*/', i + 2);
      if (end < 0) throw new Unparseable('unterminated comment');
      i = end + 2; continue;
    }
    if (c === '"') {
      let j = i + 1, value = '';
      while (true) {
        if (j >= script.length) throw new Unparseable('unterminated string');
        if (script[j] === '\\') {
          if (j + 1 >= script.length) throw new Unparseable('unterminated string');
          value += script[j + 1]; j += 2;
        } else if (script[j] === '"') break;
        else { value += script[j]; j++; }
      }
      tokens.push(['str', value, i, j + 1]); i = j + 1; continue;
    }
    if (c === ':') {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(script.slice(i + 1));
      if (!match) throw new Unparseable('unexpected character');
      tokens.push(['tag', ':' + match[0].toLowerCase(), i, i + 1 + match[0].length]); i += match[0].length + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const value = /^[A-Za-z_][A-Za-z0-9_]*/.exec(script.slice(i))[0];
      if (script[i + value.length] === ':') throw new Unparseable('multi-line text or unsupported syntax');
      tokens.push(['id', value.toLowerCase(), i, i + value.length]); i += value.length; continue;
    }
    if (/[0-9]/.test(c)) {
      const value = /^[0-9]+[KkMmGg]?/.exec(script.slice(i))[0];
      tokens.push(['num', value, i, i + value.length]); i += value.length; continue;
    }
    if ('{}()[],;'.includes(c)) {
      if (Object.hasOwn(open, c)) stack.push(open[c]);
      else if ('})]'.includes(c) && (!stack.length || stack.pop() !== c)) throw new Unparseable('unbalanced brackets');
      tokens.push(['sym', c, i, i + 1]); i++; continue;
    }
    throw new Unparseable('unexpected character');
  }
  if (stack.length) throw new Unparseable('unbalanced brackets');
  return tokens;
}
function command(tokens, end, block) {
  if (!tokens.length || tokens[0][0] !== 'id') throw new Unparseable('command expected');
  let args = tokens.slice(1);
  if (block && args.at(-1)?.[0] === 'sym' && args.at(-1)?.[1] === '{') args = args.slice(0, -1);
  return { name: tokens[0][1], args, start: tokens[0][2], end, block };
}
function commands(tokens) {
  const result = []; let current = [], depth = 0, paren = 0;
  for (const token of tokens) {
    const [kind, value, , end] = token;
    if (kind === 'sym' && value === '{') { depth++; if (depth === 1) current.push(token); continue; }
    if (kind === 'sym' && value === '}') { depth--; if (!depth) { result.push(command(current, end, true)); current = []; } continue; }
    if (depth > 0) continue;
    if (kind === 'sym' && '(['.includes(value)) paren++;
    else if (kind === 'sym' && ')]'.includes(value)) paren--;
    if (kind === 'sym' && value === ';') {
      if (paren) throw new Unparseable('semicolon inside brackets');
      result.push(command(current, end, false)); current = []; continue;
    }
    current.push(token);
  }
  if (current.length) throw new Unparseable('missing semicolon');
  return result;
}
function lineInfo(script, start, end) {
  const lineStart = script.slice(0, start).lastIndexOf('\n') + 1;
  const nl = script.indexOf('\n', end);
  let lineEnd = script.length, termEnd = script.length, term = '';
  if (nl >= 0) {
    lineEnd = nl; termEnd = nl + 1; term = '\n';
    if (nl > end && script[nl - 1] === '\r') { lineEnd = nl - 1; term = '\r\n'; }
  }
  const trim = value => value.replace(/^[ \t]+|[ \t]+$/g, '');
  const rest = trim(script.slice(end, lineEnd));
  const simple = !script.slice(start, end).includes('\n') && trim(script.slice(lineStart, start)) === '' && (!rest || rest.startsWith('#'));
  return { simple, lineStart, termEnd, term };
}
export function analyze(script) {
  const analysis = { parsed: false, reason: '', members: [], forwards: [], stopperBeforeMember: false, isTeam: false };
  if (typeof script !== 'string') { analysis.reason = 'script is not text'; return analysis; }
  let parsed;
  try { parsed = commands(tokenize(script)); }
  catch (error) { analysis.reason = error instanceof Unparseable ? error.message : 'unexpected: Error'; return analysis; }
  analysis.parsed = true;
  const stoppers = [];
  for (const { name, args, start, end, block } of parsed) {
    if (block) continue;
    const hasCopy = args.some(token => token[0] === 'tag' && token[1] === ':copy');
    if (name === 'redirect' && args.length === 2 && args[0][0] === 'tag' && args[0][1] === ':copy' && args[1][0] === 'str' && args[1][1] && script.slice(args[1][2] + 1, args[1][3] - 1) === args[1][1]) {
      analysis.members.push({ address: args[1][1], start, end, ...lineInfo(script, start, end) }); continue;
    }
    if (name === 'redirect' && args.length === 1 && args[0][0] === 'str') analysis.forwards.push(args[0][1]);
    if (['stop', 'discard'].includes(name) || (['redirect', 'fileinto'].includes(name) && !hasCopy)) stoppers.push(start);
  }
  if (analysis.members.length) analysis.stopperBeforeMember = stoppers.some(position => position < analysis.members.at(-1).start);
  analysis.isTeam = analysis.members.length > 0;
  return analysis;
}
function writable(analysis) {
  if (!analysis.parsed) throw new Refused('unparseable', analysis.reason);
  if (!analysis.members.length) throw new Refused('not_team', 'no distribution lines in this script');
}
function check(script, expected) {
  const analysis = analyze(script);
  if (!analysis.parsed || JSON.stringify(analysis.members.map(row => row.address.toLowerCase())) !== JSON.stringify(expected)) throw new Refused('self_check_failed', 'edited script failed the self-check');
}
export function addMember(script, address) {
  if (typeof address !== 'string' || !addressPattern.test(address)) throw new Refused('invalid_address');
  const analysis = analyze(script); writable(analysis);
  const current = analysis.members.map(row => row.address.toLowerCase());
  if (current.includes(address.toLowerCase())) return { script, changed: false };
  if (analysis.stopperBeforeMember) throw new Refused('stopper_before_member');
  const last = analysis.members.at(-1);
  if (!last.simple) throw new Refused('line_not_simple');
  const indent = script.slice(last.lineStart, last.start), eol = last.term || '\n';
  const line = `${indent}redirect :copy "${address}";`;
  const next = last.term ? script.slice(0, last.termEnd) + line + eol + script.slice(last.termEnd) : script + eol + line;
  check(next, [...current, address.toLowerCase()]);
  return { script: next, changed: true };
}
export function removeMember(script, address) {
  if (typeof address !== 'string' || !address) throw new Refused('invalid_address');
  const analysis = analyze(script); writable(analysis);
  const current = analysis.members.map(row => row.address.toLowerCase()), target = address.toLowerCase();
  if (!current.includes(target)) return { script, changed: false };
  if (current.every(value => value === target)) throw new Refused('last_member');
  if (analysis.stopperBeforeMember) throw new Refused('stopper_before_member');
  const hits = analysis.members.filter(row => row.address.toLowerCase() === target);
  if (hits.some(row => !row.simple)) throw new Refused('line_not_simple');
  let next = script;
  for (const row of [...hits].reverse()) {
    let start = row.lineStart;
    if (!row.term && start > 0) start -= next.slice(start - 2, start) === '\r\n' ? 2 : 1;
    next = next.slice(0, start) + next.slice(row.termEnd);
  }
  check(next, current.filter(value => value !== target));
  return { script: next, changed: true };
}
