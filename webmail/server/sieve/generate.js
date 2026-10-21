import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';
import { quoteSieve } from './glob.js';
import { asciiLower, canonicalJSON, MAX_SCRIPT_BYTES, minimumDocumentVersion, validateAddress, validateDocument, validateText } from './model.js';

export const MAGIC = '# WEBMAIL-RULES 1 — 웹메일이 만든 필터입니다. 여기서 직접 고치면 웹메일에서 규칙을 고칠 수 없게 됩니다.';
export const hashBody = body => createHash('sha256').update(body, 'utf8').digest('hex');
const quote = quoteSieve;
const sieveList = values => `[${values.map(quote).join(', ')}]`;
const uniqueAddresses = values => [...new Set(values.map(asciiLower))];

export function conditionTest(condition) {
  if (Object.hasOwn(condition, 'conditions')) return `${condition.match === 'all' ? 'allof' : 'anyof'}(${condition.conditions.map(conditionTest).join(', ')})`;
  const { field, op, value } = condition;
  if (field === 'attachment') return 'header :contains "content-type" "multipart/mixed"';
  const headers = field === 'to' ? '["to", "cc"]' : quote(field);
  const test = field !== 'subject' && ['eq', 'start', 'matches'].includes(op) ? 'address :all' : 'header';
  const comparator = { has: ':contains', not: ':contains', eq: ':is', start: ':matches', matches: ':matches' }[op];
  const pattern = op === 'start' ? `${value.replace(/[\\*?]/g, c => `\\${c}`)}*` : value;
  return `${op === 'not' ? 'not ' : ''}${test} ${comparator} ${headers} ${quote(pattern)}`;
}

/** addresses: all permitted sending addresses; trashPath: actual personal Trash path. */
export function generateScript(doc, { addresses = [], trashPath = 'Trash', ...policy } = {}) {
  // Select the stored wire version on a copy, preserving the caller's document.
  doc = structuredClone(doc);
  if ([1, 2].includes(doc?.v)) doc.v = minimumDocumentVersion(doc.rules);
  validateDocument(doc, policy);
  validateText(trashPath, 'trashPath', { min: 1 });
  addresses.forEach((address, i) => validateAddress(address, `addresses[${i}]`));
  if (doc.vacation.enabled && addresses.length === 0) {
    const error = new AppError(422, 'RULES_INVALID', '부재중 응답 주소가 필요해요.');
    error.path = 'addresses';
    error.reason = 'required';
    throw error;
  }
  const targets = uniqueAddresses(doc.rules.filter(rule => rule.enabled).flatMap(rule => rule.actions.forward ?? []));
  const internal = new Set((policy.internalDomains ?? []).map(asciiLower));
  const externalForward = targets.some(target => !internal.has(target.split('@')[1]));
  const forwardIndex = new Map(targets.map((target, i) => [target, i]));
  const lines = [
    'require ["fileinto", "imap4flags", "variables", "copy", "vacation", "date", "relational"];',
    ...(externalForward ? ['if header :contains "X-Spam-Flag" "YES" { stop; }'] : []),
    'if not header :is "X-Spam-Flag" "YES" {',
    '  set "wm_stop" "0";',
    '  set "wm_folder" "";',
    '  set "wm_trash" "0";',
    ...targets.map((_, i) => `  set "wm_forward_${i}" "0";`)
  ];
  if (doc.blocked.length) {
    const mailboxes = uniqueAddresses(doc.blocked.filter(item => !item.startsWith('@')));
    const domains = uniqueAddresses(doc.blocked.filter(item => item.startsWith('@')).map(item => item.slice(1)));
    const tests = [];
    if (mailboxes.length) tests.push(`address :all :is "from" ${sieveList(mailboxes)}`);
    if (domains.length) tests.push(`address :domain :is "from" ${sieveList(domains)}`);
    lines.push(`  if anyof(${tests.join(', ')}) { fileinto ${quote(trashPath)}; stop; }`);
  }
  if (doc.vacation.enabled) {
    const tests = [];
    if (doc.vacation.start) tests.push(`currentdate :value "ge" "date" ${quote(doc.vacation.start)}`);
    if (doc.vacation.end) tests.push(`currentdate :value "le" "date" ${quote(doc.vacation.end)}`);
    const vacation = `vacation :days 1 :subject ${quote(doc.vacation.subject)} :addresses ${sieveList(uniqueAddresses(addresses))} ${quote(doc.vacation.body)};`;
    if (tests.length) lines.push(`  if allof(${tests.join(', ')}) {`, `    ${vacation}`, '  }');
    else lines.push(`  ${vacation}`);
  }
  for (const [i, rule] of doc.rules.entries()) {
    if (!rule.enabled) continue;
    const combined = conditionTest(rule);
    const fields = { from: '보낸 사람', to: '받는 사람', subject: '제목', attachment: '첨부파일' };
    const summary = node => Object.hasOwn(node, 'conditions') ? `(${node.conditions.map(summary).join(node.match === 'all' ? ' 및 ' : ' 또는 ')})` : fields[node.field];
    lines.push(`  # 규칙 ${i + 1}: ${rule.conditions.map(summary).join(rule.match === 'all' ? ' 및 ' : ' 또는 ')}`, `  if allof(not string :is "${'${wm_stop}'}" "1", ${combined}) {`);
    if (rule.actions.read) lines.push('    addflag "\\\\Seen";');
    if (rule.actions.star) lines.push('    addflag "\\\\Flagged";');
    if (rule.actions.move) lines.push(`    if string :is "${'${wm_folder}'}" "" { set "wm_folder" ${quote(rule.actions.move)}; }`);
    if (rule.actions.trash) lines.push('    set "wm_trash" "1";');
    for (const target of uniqueAddresses(rule.actions.forward ?? [])) {
      const index = forwardIndex.get(target);
      lines.push(`    if not string :is "${'${wm_forward_'}${index}}" "1" {`, `      redirect :copy ${quote(target)};`, `      set "wm_forward_${index}" "1";`, '    }');
    }
    if (rule.stop) lines.push('    set "wm_stop" "1";');
    lines.push('  }');
  }
  lines.push(`  if string :is "${'${wm_trash}'}" "1" { fileinto ${quote(trashPath)}; }`, `  elsif not string :is "${'${wm_folder}'}" "" { fileinto "${'${wm_folder}'}"; }`, '}');
  const body = `${lines.join('\n')}\n`;
  const encoded = Buffer.from(canonicalJSON(doc), 'utf8').toString('base64url');
  const data = encoded.match(/.{1,120}/g).map(chunk => `# WEBMAIL-DATA ${chunk}`).join('\n');
  const script = `${MAGIC}\n${data}\n# WEBMAIL-HASH ${hashBody(body)}\n${body}`;
  if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) {
    const error = new AppError(422, 'RULES_INVALID', '필터 스크립트는 1MB 이하여야 해요.');
    error.path = '$';
    error.reason = 'script_too_large';
    throw error;
  }
  return script;
}
