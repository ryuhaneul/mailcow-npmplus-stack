// imapsync 19828–19842, 19935–19936: string-valued credential options.
export const secretParams = ['password1', 'password2', 'passfile1', 'passfile2', 'oauthaccesstoken1', 'oauthaccesstoken2', 'oauthdirect1', 'oauthdirect2', 'authuser1', 'authuser2'];
const secretPattern = String.raw`${secretParams.join('|')}|password[\w]*|passwd[\w]*|passfile[\w]*|oauthaccesstoken[\w]*|[\w]*secret[\w]*|[\w]*token[\w]*|[\w]+_key|apikey|privatekey`;
const secretName = new RegExp(`^(?:${secretPattern})$`, 'i');
const secretKey = key => secretName.test(key) || secretName.test(key.replace(/[^a-z0-9]/gi, ''));
const credential = new RegExp(String.raw`(?<![\w-])(--?(?:${secretParams.join('|')})\b\s*(?:=\s*|\s+))(\\"(?:\\\\.|[^\\])*?\\"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)`, 'gi');
const humanFields = new Set(['message', 'msg', 'log', 'returned_text', 'error', 'notice', 'recovery', 'reason']);
function parsedStructure(value) {
  if (!/^[\s]*[\[{]/.test(value)) return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
}
// Known values are replaced only in human-readable text, never IDs, addresses or status codes.
export function sanitizeSyncResponse(value, secrets = [], extraHumanFields = []) {
  const hidden = new Set(secrets.filter(item => typeof item === 'string' && item));
  function collect(item) {
    if (typeof item === 'string') {
      const parsed = parsedStructure(item);
      if (parsed) { collect(parsed); return; }
      for (const match of item.matchAll(credential)) {
        const raw = match[2];
        let plain = raw;
        // API_LOG wraps JSON in attr='…'; decode JSON-escaped option quotes as well.
        if (raw.startsWith('\\"')) {
          try { plain = JSON.parse(`"${raw}"`); } catch { /* Keep the raw value masked. */ }
        }
        if (/^["']/.test(plain)) {
          if (plain.startsWith('"')) {
            try { plain = JSON.parse(plain); } catch { plain = plain.slice(1, -1); }
          } else plain = plain.slice(1, -1).replace(/\\(.)/g, '$1');
        } else plain = plain.replace(/[\\"'},]+$/, '');
        if (plain) hidden.add(plain);
      }
    } else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (secretKey(key) && typeof child === 'string' && child) hidden.add(child);
      else collect(child);
    }
  }
  collect(value);
  function clean(item, human = false, key = '') {
    if (typeof item === 'string') {
      const parsed = parsedStructure(item);
      if (parsed) return JSON.stringify(clean(parsed, human, key));
      if (key === 'custom_params') return item.replace(credential, '$1***');
      if (!human) return item;
      let result = item;
      for (const secret of [...hidden].sort((a, b) => b.length - a.length)) result = result.split(secret).join('***');
      result = result.replace(credential, '$1***');
      return result.replace(/\*[^\s*<>"'@]+@mailcow\.local/gi, '****@mailcow.local');
    }
    if (Array.isArray(item)) return item.map(child => clean(child, human, key));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !secretKey(key)).map(([key, child]) => [key, clean(child, humanFields.has(key) || extraHumanFields.includes(key), key)]));
    return item;
  }
  return clean(value, typeof value === 'string');
}
