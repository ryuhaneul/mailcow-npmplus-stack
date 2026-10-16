export function initialPassword() {
  const groups = ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789', '!@#%^*-_=+'], alphabet = groups.join('');
  function random(limit) { const ceiling = Math.floor(4294967296 / limit) * limit; let number; do { number = crypto.getRandomValues(new Uint32Array(1))[0]; } while (number >= ceiling); return number % limit; }
  const chars = groups.map(group => group[random(group.length)]);
  while (chars.length < 20) chars.push(alphabet[random(alphabet.length)]);
  for (let index = chars.length - 1; index > 0; index--) { const other = random(index + 1); [chars[index], chars[other]] = [chars[other], chars[index]]; }
  return chars.join('');
}
export function chunks(lines) { const result = []; for (let index = 0; index < lines.length; index += 50) result.push(lines.slice(index, index + 50)); return result; }
export function withoutPasswords(value) {
  if (Array.isArray(value)) return value.map(withoutPasswords);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'password').map(([key, item]) => [key, withoutPasswords(item)]));
  return value;
}
export const failedLines = results => results.filter(row => row.result === 'failed').map(row => row.line);
export const partialTeamRecovery = '메일함은 만들어졌고 팀 배정만 실패 — 계정 화면이나 팀 화면에서 마저 하기';
export const connectionRecovery = '메일함은 만들어졌어요. 계정 화면에서 완료 단계와 남은 연결을 확인해 주세요.';
