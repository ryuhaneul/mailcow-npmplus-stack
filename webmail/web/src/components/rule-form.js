// Browser validation mirrors the rule fields accepted by server/sieve/model.js.
const lower = value => value.replace(/[A-Z]/g, c => c.toLowerCase());
const safe = value => typeof value === 'string' && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && !value.includes('${');
export function personalFolder(folder) {
  return safe(folder.path) && folder.path.length > 0 && !/^(?:INBOX|Trash|Junk|Drafts)$/i.test(folder.path)
    && !/^(?:Shared|WebmailVirtual)(?:\/|$)/i.test(folder.path) && !folder.shared && !folder.virtual && folder.personal !== false
    && !['\\Inbox', '\\Trash', '\\Junk', '\\Drafts'].includes(folder.specialUse);
}
export function forwardStatus(text, internalDomains) {
  const addresses = text.split(',').map(value => value.trim());
  const external = addresses.some(value => value.includes('@') && !internalDomains.some(domain => lower(domain) === lower(value.split('@').at(-1))));
  const valid = safe(text) && addresses.length >= 1 && addresses.length <= 3 && addresses.every(value => {
    const parts = value.split('@');
    return parts.length === 2 && parts[0].length <= 64 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(parts[0])
      && !parts[0].startsWith('.') && !parts[0].endsWith('.') && !parts[0].includes('..') && parts[1].length <= 253
      && parts[1].split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  });
  return { addresses, external, valid: valid && !external };
}
export function ruleProblem(rule, allFolders, internalDomains, forwardText) {
  if (rule.conditions.length < 1 || rule.conditions.length > 10) return '조건은 1개부터 10개까지 넣어 주세요.';
  if (rule.conditions.some(c => c.field !== 'attachment' && (!safe(c.value) || [...c.value].length < 1 || [...c.value].length > 200))) return '조건 값은 제어문자와 ${ 없이 1~200자로 입력해 주세요.';
  const a = rule.actions;
  if (Object.hasOwn(a, 'move') && (!allFolders.some(f => f.path === a.move && personalFolder(f)) || a.trash)) return '옮길 개인 폴더를 선택해 주세요. 삭제와 함께 고를 수 없습니다.';
  if (a.forward && !forwardStatus(forwardText, internalDomains).valid) return '전달 받을 사내 메일 주소를 쉼표로 나누어 1~3개 입력해 주세요.';
  if (!a.move && !a.trash && !a.read && !a.star && !a.forward) return '동작을 하나 이상 선택해 주세요.';
  return null;
}
export function seededConditions(query = '') {
  const params = new URLSearchParams(query);
  const conditions = [];
  for (const field of ['from', 'to', 'subject']) for (const value of params.getAll(field)) if (value) conditions.push({field, op:'has', value});
  if (params.get('attachment') === 'has') conditions.push({field:'attachment', op:'has', value:''});
  return conditions.length ? conditions : [{field:'from', op:'has', value:''}];
}
