// Shared literal redirect and standalone spam guard rules for server and browser.
export function hasMoveRedirect(script) {
  const words = script.match(/\/\*[\s\S]*?\*\/|#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|:?[a-zA-Z_][a-zA-Z0-9_-]*|[^\s]/g) || [];
  const commands = words.filter(word => !word.startsWith('/*') && !word.startsWith('#'));
  return commands.some((word, index) => word.toLowerCase() === 'redirect' && commands[index + 1]?.toLowerCase() !== ':copy');
}

// Recognize literal redirects and the standalone spam guard we insert.
const spamGuard = 'if header :contains "X-Spam-Flag" "YES" { stop; }';
function scriptTokens(script) {
  return [...script.matchAll(/\/\*[\s\S]*?\*\/|#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|:?[a-zA-Z_][a-zA-Z0-9_-]*|[^\s]/g)]
    .filter(match => !match[0].startsWith('/*') && !match[0].startsWith('#'))
    .map(match => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
}
export function externalRedirectPreview(script, internalDomains) {
  const words = scriptTokens(script), internal = new Set(internalDomains.map(value => value.toLowerCase()));
  const targets = new Set(); let firstRedirect = Infinity, guard = Infinity, depth = 0;
  const guardWords = scriptTokens(spamGuard).map(word => word.value.toLowerCase());
  for (let i = 0; i < words.length; i++) {
    const value = words[i].value.toLowerCase();
    if (depth === 0 && guardWords.every((word, offset) => words[i + offset]?.value.toLowerCase() === word)) guard = Math.min(guard, i);
    if (value === 'redirect') {
      for (let j = i + 1; j < words.length && ![';', '{', '}'].includes(words[j].value); j++) {
        const target = /^"([^"\\\s@]+@[^"\\\s@]+)"$/.exec(words[j].value)?.[1]?.toLowerCase();
        if (target && !internal.has(target.split('@')[1])) { targets.add(target); firstRedirect = Math.min(firstRedirect, i); }
      }
    }
    if (value === '{') depth++;
    if (value === '}') depth--;
  }
  return { external: [...targets].sort(), needsSpamGuard: targets.size > 0 && guard >= firstRedirect };
}
const bounceGuard = 'if envelope :is "from" "" { stop; }';
export function needsBounceGuard(script, internalDomains) {
  if (!externalRedirectPreview(script, internalDomains).external.length) return false;
  const words = scriptTokens(script), guardWords = scriptTokens(bounceGuard).map(word => word.value.toLowerCase());
  let depth = 0;
  for (let i = 0; i < words.length; i++) {
    if (depth === 0 && guardWords.every((word, offset) => words[i + offset]?.value.toLowerCase() === word)
      && !externalRedirectPreview(script.slice(0, words[i].start), internalDomains).external.length) return false;
    if (words[i].value === '{') depth++;
    if (words[i].value === '}') depth--;
  }
  return true;
}
export function insertForwardingSafety(script, internalDomains) {
  const lines = [];
  if (externalRedirectPreview(script, internalDomains).needsSpamGuard) lines.push(spamGuard);
  if (needsBounceGuard(script, internalDomains)) lines.push(bounceGuard);
  if (!lines.length) return script;
  const newline = script.includes('\r\n') ? '\r\n' : '\n';
  let words = scriptTokens(script), index = 0, firstRequire = null, hasEnvelope = false;
  while (words[index]?.value.toLowerCase() === 'require') {
    const start = index++;
    while (words[index] && words[index].value !== ';') {
      if (words[index].value.toLowerCase() === '"envelope"') hasEnvelope = true;
      index++;
    }
    if (!words[index]) break;
    firstRequire ??= words.slice(start + 1, index);
    index++;
  }
  if (!hasEnvelope) {
    if (!firstRequire) script = `require ["envelope"];${newline}${script}`;
    else if (firstRequire[0]?.value === '[') {
      const last = firstRequire.filter(word => word.value.startsWith('"')).at(-1);
      const at = last?.end ?? firstRequire[0].end;
      script = `${script.slice(0, at)}${last ? ', ' : ''}"envelope"${script.slice(at)}`;
    } else {
      const capability = firstRequire[0];
      script = `${script.slice(0, capability.start)}[${capability.value}, "envelope"]${script.slice(capability.end)}`;
    }
  }
  words = scriptTokens(script); index = 0; let end = 0;
  while (words[index]?.value.toLowerCase() === 'require') {
    while (words[index] && words[index].value !== ';') index++;
    if (!words[index]) break;
    end = words[index++].end;
  }
  return `${script.slice(0, end)}${newline}${lines.join(newline)}${newline}${script.slice(end).replace(/^\r?\n/, '')}`;
}

export const externalSpamGuardMessage = '외부로 전달하는 필터는 맨 앞에 스팸 메일 전달 제외 줄이 있어야 저장할 수 있어요.';

export function internalDomainSet(domains, aliases) {
  const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
  const primary = new Set(domains.filter(row => String(row.active) === '1').map(row => normalize(row.domain_name ?? row.domain)));
  return new Set([...primary, ...aliases.filter(row => String(row.active) === '1' && primary.has(normalize(row.target_domain))).map(row => normalize(row.alias_domain))]);
}
