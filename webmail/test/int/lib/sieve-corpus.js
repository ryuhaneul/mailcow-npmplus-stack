import { conditionTest, generateScript } from '../../../server/sieve/generate.js';
import { rulesDocument } from '../../../server/sieve/import.js';

export function sieveCorpus() {
  const mails = Array.from({ length: 40 }, (_, i) => {
    const subjects = ['Project Alpha', '회의 안내', 'a*b?c literal', 'UPPER lower', 'Absent value'];
    const subject = subjects[i % subjects.length];
    const encoded = i % 3 === 0 ? `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=` : subject;
    const from = i % 2 ? 'alpha@example.com' : 'Beta@example.org';
    const to = i % 3 ? 'recipient@example.com' : 'other@example.org';
    const cc = i % 4 ? 'carbon@example.org' : 'team@example.com';
    const type = i % 2 ? 'text/plain; charset=utf-8' : 'multipart/mixed; boundary="example-boundary"';
    return `From: "Synthetic, Sender" <${from}>\r\nTo: "Receiver" <${to}>\r\nCc: ${cc}\r\nSubject: ${encoded}\r\nMessage-ID: <int-matrix-${i}@example.com>\r\nDate: Thu, 15 Oct 2026 08:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: ${type}\r\n\r\n${i % 2 ? 'Synthetic text.' : '--example-boundary\r\nContent-Type: text/plain\r\n\r\nSynthetic part.\r\n--example-boundary--'}\r\n`;
  });
  const conditions = [];
  for (const [field, values] of [['from', ['example.com', 'alpha@example.com', 'alpha@', 'missing']],
    ['to', ['example.com', 'team@example.com', 'recipient@', 'missing']],
    ['subject', ['Alpha', '회의 안내', 'a*b?', 'missing']]]) {
    for (const [i, op] of ['has', 'eq', 'start', 'not'].entries()) conditions.push({ field, op, value: values[i] });
  }
  conditions.push({ field: 'attachment', op: 'has', value: '' });
  const rules = Array.from({ length: 30 }, (_, i) => ({
    id: `case${String(i).padStart(4, '0')}`, enabled: true, match: i % 2 ? 'any' : 'all',
    conditions: i < conditions.length ? [conditions[i]] : [conditions[i % conditions.length], conditions[(i + 5) % conditions.length]],
    actions: { read: true }, stop: false,
  }));
  // Keep the 40 × 30 host-runner contract while replacing repeated filler
  // cases with stage-two patterns, mixed joins and headers beyond 998 chars.
  const sample = (subject, from = 'alpha@example.com', display = '합성 표시 이름', to = 'recipient@example.com') =>
    `From: "${display}" <${from}>\r\nTo: ${to}\r\nCc: team@example.com\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\nSynthetic body.\r\n`;
  const extras = [
    sample('prefix middle suffix'), sample('literal * and ? and \\'), sample('회의 안내'),
    sample(`${'x'.repeat(1200)}TAIL`), sample(`${'x'.repeat(1200)}FAIL`),
    sample('주소 검사', 'alpha@example.com', 'prefix middle suffix'),
    sample('long address', `${'x'.repeat(1100)}tail@example.com`),
    sample('Ä case', 'Beta@example.org'),
  ];
  mails.splice(mails.length - extras.length, extras.length, ...extras);
  const leaf = (field, value, op = 'matches') => ({ field, op, value });
  const patterns = [
    leaf('subject', 'prefix*'), leaf('subject', '*middle*'), leaf('subject', '*suffix'),
    leaf('subject', '*\\**'), leaf('subject', '*\\?*'), leaf('subject', '*\\\\*'),
    leaf('subject', '회*안내'), leaf('subject', '*TAIL'),
    leaf('from', '*@example.com'), leaf('to', 'team*@example.com'),
    leaf('from', '*tail@example.com'), leaf('subject', 'ä*'),
  ];
  const trees = patterns.map(condition => ({ match: 'all', conditions: [condition] }));
  trees.push(
    { match: 'all', conditions: [leaf('subject', 'prefix', 'has'), { match: 'any', conditions: [leaf('from', 'alpha*'), leaf('to', '*@example.org')] }] },
    { match: 'any', conditions: [leaf('subject', 'missing', 'not'), { match: 'all', conditions: [leaf('from', '*@example.com'), leaf('subject', '*TAIL')] }] },
    { match: 'all', conditions: [leaf('from', 'missing', 'not'), { match: 'any', conditions: [leaf('subject', '회*'), leaf('subject', '*suffix')] }] },
  );
  trees.forEach((tree, i) => { const index = rules.length - trees.length + i; rules[index] = { ...rules[index], ...tree }; });
  const scripts = rules.map((rule, i) => `require ["vnd.dovecot.debug"];\nif ${conditionTest(rule)} { debug_log "WM_MATCH_${i}"; }\n`);
  return { mails, rules, scripts };
}

export function deliveryCases(today = new Date().toISOString().slice(0, 10)) {
  const condition = { field: 'subject', op: 'has', value: 'COPY' };
  const rule = (i, actions, stop = false) => ({ id: `copy${String(i).padStart(4, '0')}`, enabled: true, match: 'all', conditions: [condition], actions, stop });
  const policy = { internalDomains: ['example.com'], folders: [{ path: 'Archive' }, { path: 'IntOther' }], addresses: ['recipient@example.com'] };
  const a = { move: 'Archive' }, b = { move: 'IntOther' }, trash = { trash: true }, read = { read: true }, star = { star: true };
  const specs = [
    [[a, b], -1, 'Archive'], [[b, a], -1, 'IntOther'],
    [[a, trash], 0, 'Archive'], [[a, trash], -1, 'Trash'],
    [[b, trash], -1, 'Trash'], [[read, a, b], -1, 'Archive'],
    [[star, b, read], -1, 'IntOther'], [[a, b, trash], 1, 'Archive'],
    [[trash, a], -1, 'Trash'], [[a, trash, b], 1, 'Trash'],
  ];
  const copies = specs.map(([actions, stopIndex, expectedFolder], i) => ({
    name: `copy-${i}`, expectedFolder,
    script: generateScript(rulesDocument(actions.map((value, j) => rule(j, value, j === stopIndex))), policy),
  }));
  const vacation = (start, end) => ({ ...rulesDocument([]), vacation: { enabled: true, start, end, subject: 'Synthetic vacation', body: 'Synthetic reply' } });
  const vacations = [
    { name: 'vacation-inside', doc: vacation(today, today), spam: false, expectedVacation: true },
    { name: 'vacation-outside', doc: vacation('2000-01-01', '2000-01-02'), spam: false, expectedVacation: false },
    { name: 'vacation-spam', doc: vacation(today, today), spam: true, expectedVacation: false },
  ].map(value => ({ ...value, script: generateScript(value.doc, policy) }));
  return [...copies, ...vacations];
}
