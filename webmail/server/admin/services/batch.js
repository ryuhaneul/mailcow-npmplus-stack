import { randomInt } from 'node:crypto';
import { AppError } from '../../errors.js';
import { MailcowAuthLost } from '../mailcow-client.js';
import { addressPattern } from '../sieve-team.js';
import { sanitizeSyncResponse } from './sync.js';

const invalid = message => new AppError(422, 'INVALID_INPUT', message ?? 'CSV 입력값과 실행할 줄 번호를 확인해 주세요.');
const normalize = value => String(value ?? '').trim().toLowerCase();
const kinds = { 개인: 'personal', 팀: 'team', 관리: 'admin' };
const columns = { mailboxes: ['email', 'name', 'type', 'team'], quotas: ['email', 'quota_gb'] };
const code = error => error instanceof AppError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
const recovery = '메일함은 만들어졌고 팀 배정만 실패 — 계정 화면이나 팀 화면에서 마저 하기';
function syntax(line) {
  const error = new AppError(422, 'CSV_SYNTAX', 'CSV 따옴표와 구분자를 확인해 주세요.'); error.line = line; return error;
}
// Record line numbers refer to physical source lines, including quoted multiline fields.
export function parseCsv(csv) {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > 1024 * 1024) throw invalid('CSV는 1MB 이하로 넣어 주세요.');
  const text = csv.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n');
  const count = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
  if (count > 1000) throw invalid('제목을 포함해 CSV는 1,000줄 이하로 넣어 주세요.');
  const records = []; let fields = [], field = '', quoted = false, closed = false, line = 1, start = 1, quoteLine = 1, touched = false;
  function finish() {
    fields.push(field.trim());
    if (touched || fields.some(value => value)) records.push({ line: start, fields });
    fields = []; field = ''; closed = false; touched = false;
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else { field += char; if (char === '\n') line++; }
    } else if (char === '\n') { finish(); line++; start = line; }
    else if (char === ',') { fields.push(field.trim()); field = ''; closed = false; touched = true; }
    else if (char === '"') {
      if (field.trim() || closed) throw syntax(line);
      field = ''; quoted = true; quoteLine = line; touched = true;
    } else {
      if (closed && char.trim()) throw syntax(line);
      field += char; if (char.trim()) touched = true;
    }
  }
  if (quoted) throw syntax(quoteLine);
  finish();
  if (!records.length || records[0].line !== 1) throw invalid('첫 줄에 열 제목을 넣어 주세요.');
  return records;
}
function password() {
  const groups = ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789', '!@#%^*-_=+'], alphabet = groups.join('');
  const chars = groups.map(group => group[randomInt(group.length)]);
  while (chars.length < 20) chars.push(alphabet[randomInt(alphabet.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
function input(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['action', 'csv', 'lines', 'options'].includes(key)) || !['parse', 'run', 'retry'].includes(data.action)) throw invalid();
  const options = data.options ?? {};
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'createDomains') || options.createDomains !== undefined && typeof options.createDomains !== 'boolean') throw invalid();
  if (data.action === 'parse' && data.lines !== undefined) throw invalid();
  if (data.action !== 'parse' && (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 50 || data.lines.some(value => !Number.isSafeInteger(value) || value < 2) || new Set(data.lines).size !== data.lines.length)) throw invalid();
  return options;
}
const validEmail = value => value.length <= 254 && addressPattern.test(value) && value.split('@')[1].length <= 253 && value.split('@')[1].includes('.') && value.split('@')[1].split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(part));
export function createBatchService({ mailcow, accounts, domains, teams, audit }) {
  async function rows(session, path) {
    const result = await mailcow.call(session, 'GET', `/api/v1/get/${path}`);
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object' && !Object.keys(result).length) return [];
    throw new AppError(502, 'MAILCOW_REJECTED', '일괄 작업에 필요한 목록을 읽을 수 없어요.');
  }
  async function context(session, kind) {
    const boxes = await rows(session, 'mailbox/all');
    if (kind === 'quotas') return { boxes };
    const [aliases, primary, aliasDomains, first] = await Promise.all([
      rows(session, 'alias/all'), rows(session, 'domain/all'), rows(session, 'alias-domain/all'), teams.list(session),
    ]);
    const groups = [...first.items];
    for (let page = 2; page <= Math.ceil(first.total / first.pageSize); page++) groups.push(...(await teams.list(session, { page: String(page) })).items);
    return { boxes, aliases, primary, aliasDomains, groups };
  }
  async function inspect(session, kind, csv, options) {
    const records = parseCsv(csv), header = records.shift().fields, allowed = columns[kind];
    if (header.some(key => !allowed.includes(key)) || new Set(header).size !== header.length || !header.includes('email') || kind === 'quotas' && !header.includes('quota_gb')) throw invalid('CSV 열 제목을 확인해 주세요.');
    const facts = await context(session, kind), seen = new Map();
    const result = records.map(record => {
      const values = Object.fromEntries(header.map((key, index) => [key, record.fields[index] ?? '']));
      const email = normalize(values.email), type = values.type || '개인', row = { line: record.line, email,
        ...(kind === 'mailboxes' ? { name: values.name || email.split('@')[0], type, team: values.team || '', teamAddress: null } : { quotaGb: /^\d+$/.test(values.quota_gb) ? Number(values.quota_gb) : null }), valid: true, error: '', code: null };
      function fail(reason, message) { row.valid = false; row.code = reason; row.error = message; return row; }
      if (record.fields.length !== header.length) return fail('CSV_COLUMNS', '열 개수가 제목과 달라요.');
      if (!validEmail(email)) return fail('INVALID_ADDRESS', '메일 주소 형식을 확인해 주세요.');
      if (seen.has(email)) return fail('DUPLICATE_ADDRESS', `중복 주소예요(${seen.get(email)}번 줄과 같음)`);
      seen.set(email, record.line);
      const existing = facts.boxes.some(box => normalize(box.username) === email);
      if (kind === 'quotas') {
        if (!existing) return fail('NOT_FOUND', '메일함이 없어요.');
        if (!Number.isSafeInteger(row.quotaGb) || row.quotaGb < 1 || !Number.isSafeInteger(row.quotaGb * 1024)) return fail('INVALID_QUOTA', '용량은 1GB 이상 정수로 적어 주세요. 무제한(0)은 사용할 수 없어요.');
        return row;
      }
      if (existing || facts.aliases.some(alias => normalize(alias.address) === email)) return fail('ADDRESS_EXISTS', '이미 있는 메일함 또는 별칭 주소예요.');
      if (!Object.hasOwn(kinds, type)) return fail('INVALID_KIND', '종류는 개인·팀·관리 중 하나로 적어 주세요.');
      if (row.name.length > 255) return fail('INVALID_NAME', '이름은 255자 이하로 적어 주세요.');
      const domain = email.split('@')[1], primary = facts.primary.find(item => normalize(item.domain_name ?? item.domain) === domain);
      if (primary && String(primary.active) !== '1') return fail('DOMAIN_NOT_ACTIVE', '꺼진 도메인이에요.');
      if (!primary && facts.aliasDomains.some(item => normalize(item.alias_domain) === domain)) return fail('DOMAIN_NOT_PRIMARY', '별칭 도메인에는 메일함을 만들 수 없어요.');
      if (!primary && !options.createDomains) return fail('DOMAIN_NOT_FOUND', '도메인이 없어요.');
      row.createDomain = !primary;
      if (row.team) {
        const direct = facts.groups.find(group => group.mailbox === normalize(row.team));
        const matches = direct ? [direct] : facts.groups.filter(group => facts.boxes.find(box => normalize(box.username) === group.mailbox)?.name === row.team);
        if (matches.length > 1) return fail('TEAM_AMBIGUOUS', '팀 이름이 여러 개와 일치 — 주소로 적어 주세요');
        if (!matches.length) return fail('NOT_TEAM', '존재하지 않는 팀이에요.');
        row.teamAddress = matches[0].mailbox;
      }
      return row;
    });
    return { kind, rows: result, normal: result.filter(row => row.valid).length, errors: result.filter(row => !row.valid).length };
  }
  async function executeRow({ session, actor, ip, kind, row, options }) {
    const steps = []; let initialPassword;
    try {
      if (kind === 'mailboxes') {
        const [local, domain] = row.email.split('@');
        // Re-read before creating: a previous row/request may already have created this domain.
        if (options.createDomains && !(await rows(session, 'domain/all')).some(item => normalize(item.domain_name ?? item.domain) === domain)) {
          const created = await domains.create({ session, actor, ip, data: { domain } }); steps.push({ stage: 'domain', status: 'ok', auditId: created.auditId });
        }
        initialPassword = password();
        const created = await accounts.create({ session, actor, ip, data: { local, domain, name: row.name, kind: kinds[row.type],
          ...(row.teamAddress ? { team: row.teamAddress } : {}), password: initialPassword } });
        return { line: row.line, email: row.email, ...created, steps: [...steps, ...created.steps], ...(created.result === 'partial' ? { recovery: [recovery] } : {}) };
      }
      const current = await accounts.detail(session, row.email), result = await accounts.edit({ session, actor, ip, addr: row.email, data: { etag: current.etag, quotaGb: row.quotaGb } });
      return { line: row.line, email: row.email, ...result, ...(result.result === 'ok' && !result.steps.length ? { unchanged: true } : {}) };
    } catch (error) {
      if (error instanceof MailcowAuthLost) throw error;
      return { line: row.line, email: row.email, result: steps.length ? 'partial' : 'failed', code: code(error),
        error: error instanceof AppError ? sanitizeSyncResponse(error.message, initialPassword ? [initialPassword] : []) : '일괄 작업 중 오류가 발생했어요.',
        steps, ...(steps.length ? { recovery: ['도메인은 만들어졌어요. 메일함 상태를 확인한 뒤 해당 줄만 다시 실행해 주세요.'] } : {}) };
    } finally { initialPassword = undefined; }
  }
  async function run({ session, actor, ip, kind, data }) {
    if (!Object.hasOwn(columns, kind)) throw new AppError(404, 'NOT_FOUND', '지원하지 않는 일괄 작업이에요.');
    const options = input(data), parsed = await inspect(session, kind, data.csv, options);
    if (data.action === 'parse') return parsed;
    const chosen = data.lines.map(line => parsed.rows.find(row => row.line === line));
    if (chosen.some(row => !row?.valid)) throw invalid('오류 줄이 포함돼 실행하지 않았어요. 줄별 미리보기를 다시 확인해 주세요.');
    const results = []; let lost;
    const response = await audit.run({ actor, ip, action: `batch.${kind}`, target: `batch:${kind}`, kind: 'config', revertible: false,
      before: {}, after: { lines: chosen.map(row => row.line) } }, async intent => {
      for (const row of chosen) {
        try { results.push(await executeRow({ session, actor, ip, kind, row, options })); }
        catch (error) {
          if (!(error instanceof MailcowAuthLost)) throw error;
          lost = error; results.push({ line: row.line, email: row.email, result: 'failed', code: code(error) }); break;
        }
      }
      const safeResults = results.map(row => ({ line: row.line, email: row.email, result: row.result, ...(row.code ? { failure: row.code } : {}), steps: row.steps?.map(step => ({ stage: step.stage, status: step.status, auditId: step.auditId })) ?? [] }));
      return { kind, result: results.some(row => row.result !== 'ok') ? 'partial' : 'ok', results, auditId: intent.id,
        detail: { results: safeResults, stopped: Boolean(lost) } };
    });
    if (lost) throw lost;
    // The response-only credentials never enter the audit detail.
    delete response.detail;
    return response;
  }
  return { run };
}
