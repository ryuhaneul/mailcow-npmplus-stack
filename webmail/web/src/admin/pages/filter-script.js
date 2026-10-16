// Only detects the move warning. The server validates the complete script on save.
export function hasMoveRedirect(script) {
  const words = script.match(/\/\*[\s\S]*?\*\/|#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|:?[a-zA-Z_][a-zA-Z0-9_-]*|[^\s]/g) || [];
  const commands = words.filter(word => !word.startsWith('/*') && !word.startsWith('#'));
  return commands.some((word, index) => word.toLowerCase() === 'redirect' && commands[index + 1]?.toLowerCase() !== ':copy');
}
