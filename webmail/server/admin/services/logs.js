import { AppError } from '../../errors.js';

const kinds = ['postfix', 'dovecot', 'rspamd-history', 'netfilter', 'ui', 'api', 'sasl'];
const presets = { sender_rejected: 'postfix', noqueue: 'postfix', storage_errors: 'dovecot', protocol_by_account: 'dovecot' };
const invalid = () => new AppError(422, 'INVALID_INPUT', '로그 종류와 검색 조건을 확인해 주세요.');
const rejected = () => new AppError(502, 'MAILCOW_REJECTED', '로그 정보를 읽을 수 없어요.');
const cut = (value, limit = 4000) => Array.from(String(value ?? '')).slice(0, limit).join('');
const text = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const searchable = value => value && typeof value === 'object' ? Object.values(value).map(searchable).join(' ') : String(value ?? '');
const trimValues = value => typeof value === 'string' ? cut(value) : Array.isArray(value) ? value.map(trimValues) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimValues(item)])) : value;
const pick = (row, keys) => Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
function rows(value) { if (Array.isArray(value)) return value; if (value && typeof value === 'object' && !Object.keys(value).length) return []; throw rejected(); }
function time(row, kind) { return String((kind === 'sasl' ? row.datetime : kind === 'rspamd-history' ? row.unix_time : row.time) ?? ''); }
function project(row, kind) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw rejected();
  const line = { time: time(row, kind), program: String(row.program ?? kind), priority: String(row.priority ?? ''), message: typeof row.message === 'string' ? row.message : text(row.message) };
  if (kind === 'ui') Object.assign(line, { program: 'ui', priority: String(row.type ?? row.priority ?? ''), message: [text(row.msg ?? row.message), row.remote].filter(Boolean).join(' '), fields: pick(row, ['type', 'msg', 'call', 'remote']) });
  if (kind === 'sasl') Object.assign(line, { program: String(row.service ?? row.program ?? 'sasl'), message: [row.username, row.rip ?? row.real_rip].filter(Boolean).join(' '), fields: pick(row, ['username', 'rip', 'real_rip']) });
  if (kind === 'api') { line.fields = pick(row, ['uri', 'method', 'remote', 'data']); if (!line.message) line.message = searchable(line.fields); }
  if (kind === 'rspamd-history') {
    const fields = { sender: row.sender_mime || row.sender_smtp || '', recipients: Array.isArray(row.rcpt_mime) && row.rcpt_mime.length ? row.rcpt_mime : row.rcpt_smtp ?? [], score: row.score && typeof row.score === 'object' ? row.score.value : row.score, action: row.action ?? '', ip: row.ip ?? '' };
    Object.assign(line, { program: 'rspamd-history', message: searchable(fields), fields });
  }
  return line;
}
const range = (data, kind) => ({ newest: data.length ? time(data[0], kind) : null, oldest: data.length ? time(data.at(-1), kind) : null, count: data.length });
function bounded(value) { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 2 * 1024 * 1024) throw new AppError(502, 'LOG_RESPONSE_TOO_LARGE', '로그 응답이 2MiB를 넘었어요. 조회 줄 수를 줄여 주세요.'); return value; }
function login(line) {
  const match = /\b(imap|pop3|(?:manage)?sieve|submission)-login(?:\[\d+\])?:\s+Login:\s*([\s\S]*)/i.exec(`${line.program}: ${line.message}`);
  if (!match) return null;
  const account = /\buser=<([^>]+)>/i.exec(match[2]); return { protocol: match[1].toLowerCase().replace('managesieve', 'sieve'), account: account?.[1].toLowerCase() ?? null, detail: match[2] };
}
function groupKey(preset, line) {
  const message = line.message;
  if (preset === 'sender_rejected') return /Sender address rejected: not owned by user\s+([^\s;]+)/i.exec(message)?.[1].toLowerCase();
  if (preset === 'noqueue') { const match = /NOQUEUE:\s+reject:\s+.*?:\s+(\d{3}\s+[^;]+)(?:;|$)/i.exec(message); return match?.[1].replace(/<[^>]*>:\s*/g, '').trim(); }
  if (preset === 'storage_errors') { if (/Bad file descriptor/i.test(message)) return 'bad_file_descriptor'; if (/Timeout(?:\s+\([^)]*\))?\s+while waiting for (?:dot)?lock/i.test(message)) return 'lock_wait'; }
  if (preset === 'protocol_by_account') { const found = login(line); if (found?.account) return `${found.account} · ${found.protocol}`; }
  return null;
}
export function createLogsService({ mailcow, config }) {
  async function fetch(session, kind, n) { return rows(await mailcow.call(session, 'GET', `/api/v1/get/logs/${kind}/${n}`)).slice(0, n); }
  async function logs(session, query = {}) {
    if (!query || Object.keys(query).some(key => !['kind', 'preset', 'q', 'n'].includes(key)) || query.preset !== undefined && (!Object.hasOwn(presets, query.preset) || query.kind !== undefined)) throw invalid();
    const kind = query.preset === undefined ? query.kind : presets[query.preset], rawN = query.n ?? '200', n = Number(rawN), q = query.q ?? '';
    if (!kinds.includes(kind) || !/^[1-9]\d*$/.test(String(rawN)) || !Number.isSafeInteger(n) || n > 1000 || typeof q !== 'string' || Array.from(q).length > 200) throw invalid();
    const data = await fetch(session, kind, n), projected = data.map(row => project(row, kind)), selected = projected.filter(line => searchable({ message: line.message, fields: line.fields }).toLowerCase().includes(q.toLowerCase()));
    const result = { kind, n, lines: selected.map(trimValues), range: range(data, kind) };
    if (query.preset !== undefined) {
      const groups = new Map(); for (const line of selected) { const key = groupKey(query.preset, line); if (!key) continue; if (!groups.has(key)) groups.set(key, { key, count: 0, sample: cut(line.message, 200) }); groups.get(key).count++; }
      result.preset = query.preset; result.groups = [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    }
    return bounded(result);
  }
  async function compatUsage(session) {
    const n = 1000, [dovecot, postfix] = await Promise.all([fetch(session, 'dovecot', n), fetch(session, 'postfix', n)]), plain = new Map(), smtp = new Map(); let uncertain = false;
    for (const row of dovecot) {
      const line = project(row, 'dovecot'), found = login(line);
      if (found?.protocol !== 'pop3') continue;
      if (!found.account) { uncertain = true; continue; }
      const security = found.detail.replace(/\b(?:user|rip|lip|session)=<[^>]*>|\b(?:user|rip|lip|session)=\S+/gi, '');
      if (!/(?:^|[\s,])(?:secured|TLS(?:v[\d.]+)?|SSL(?:v[\d.]+)?|TSL)(?=$|[\s,:])/i.test(security) && !plain.has(found.account)) plain.set(found.account, { account: found.account, lastSeen: line.time });
    }
    for (const row of postfix) {
      const line = project(row, 'postfix'); if (!/\bpostfix\/smtpd(?:\[\d+\])?(?=[:\s]|$)/i.test(`${line.program}: ${line.message}`)) continue;
      const account = /\bsasl_username=([^\s,;]+)/i.exec(line.message)?.[1].toLowerCase(); if (account && !smtp.has(account)) smtp.set(account, { account, lastSeen: line.time });
    }
    return bounded({ n, range: { dovecot: range(dovecot, 'dovecot'), postfix: range(postfix, 'postfix') }, plainPop3: { status: uncertain ? 'unknown' : 'known', count: uncertain ? null : plain.size, accounts: [...plain.values()], basis: 'pop3-login: Login 중 secured/TLS 표시 없는 계정 (조회한 로그 범위 안)', ...(uncertain ? { reason: '계정 이름을 읽을 수 없는 POP3 로그인 줄이 있어요.' } : {}) }, smtp25: { status: 'known', count: smtp.size, accounts: [...smtp.values()], basis: 'postfix/smtpd 줄의 sasl_username (mailcow 기본 syslog 이름 기준)' } });
  }
  async function admins(session) {
    const data = rows(await mailcow.call(session, 'GET', '/api/v1/get/admin/all'));
    const yes = value => value === true || String(value) === '1';
    return { items: data.map(row => ({ username: String(row.username), active: yes(row.active_int ?? row.active), tfaActive: yes(row.tfa_active_int ?? row.tfa_active), created: String(row.created ?? ''), forceTfa: yes(row.attributes?.force_tfa), forcePwUpdate: yes(row.attributes?.force_pw_update) })) };
  }
  return { logs, compatUsage, admins, autoexpunge: () => ({ days: config.autoexpungeDays }) };
}
