// Only detects the move warning. The server validates the complete script on save.
export function hasMoveRedirect(script) {
  const words = script.match(/\/\*[\s\S]*?\*\/|#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|:?[a-zA-Z_][a-zA-Z0-9_-]*|[^\s]/g) || [];
  const commands = words.filter(word => !word.startsWith('/*') && !word.startsWith('#'));
  return commands.some((word, index) => word.toLowerCase() === 'redirect' && commands[index + 1]?.toLowerCase() !== ':copy');
}

// Preview only: recognize literal redirects and the standalone spam guard we insert.
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
export function insertSpamGuard(script) {
  const words = scriptTokens(script); let index = 0, end = 0;
  while (words[index]?.value.toLowerCase() === 'require') {
    while (words[index] && words[index].value !== ';') index++;
    if (!words[index]) break;
    end = words[index++].end;
  }
  const newline = script.includes('\r\n') ? '\r\n' : '\n';
  return end ? `${script.slice(0, end)}${newline}${spamGuard}${newline}${script.slice(end).replace(/^\r?\n/, '')}` : `${spamGuard}${newline}${script}`;
}
