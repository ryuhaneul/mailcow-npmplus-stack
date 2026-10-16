import { isIPv4 } from 'node:net';
import { validateAlias } from './aliases.js';
import { randomInt } from 'node:crypto';
import { AppError } from '../../errors.js';
import { MailcowAuthLost } from '../mailcow-client.js';
import { addressPattern } from '../sieve-team.js';
import { sanitizeSyncResponse } from './sync.js';

const invalid = message => new AppError(422, 'INVALID_INPUT', message ?? 'CSV 입력값과 실행할 줄 번호를 확인해 주세요.');
const normalize = value => String(value ?? '').trim().toLowerCase();
const kinds = { 개인: 'personal', 팀: 'team', 관리: 'admin' };
const columns = { mailboxes: ['email', 'name', 'type', 'team'], quotas: ['email', 'quota_gb'], aliases: ['address', 'targets'], syncjobs: ['source', 'password', 'target', 'host'] };
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
    fields.push(closed ? field : field.trim());
    if (touched || fields.some(value => value)) records.push({ line: start, fields });
    fields = []; field = ''; closed = false; touched = false;
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else { field += char; if (char === '\n') line++; }
    } else if (char === '\n') { finish(); line++; start = line; }
    else if (char === ',') { fields.push(closed ? field : field.trim()); field = ''; closed = false; touched = true; }
    else if (char === '"') {
      if (field.trim() || closed) throw syntax(line);
      field = ''; quoted = true; quoteLine = line; touched = true;
    } else {
      if (closed) { if (char.trim()) throw syntax(line); continue; }
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
function input(data, kind) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['action', 'csv', 'lines', 'options'].includes(key)) || !['parse', 'run', 'retry'].includes(data.action)) throw invalid();
  const options = data.options ?? {}, allowed = kind === 'syncjobs' ? ['autoCreate', 'host'] : kind === 'aliases' ? [] : ['createDomains'];
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !allowed.includes(key))) throw invalid();
  for (const key of ['createDomains', 'autoCreate']) if (key in options && typeof options[key] !== 'boolean') throw invalid();
  if ('host' in options && typeof options.host !== 'string') throw invalid();
  if (data.action === 'parse' && data.lines !== undefined) throw invalid();
  if (data.action !== 'parse' && (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 50 || data.lines.some(value => !Number.isSafeInteger(value) || value < 2) || new Set(data.lines).size !== data.lines.length)) throw invalid();
  return options;
}
const validEmail = value => value.length <= 254 && addressPattern.test(value) && value.split('@')[1].length <= 253 && value.split('@')[1].includes('.') && value.split('@')[1].split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(part));
const validHost = value => isIPv4(value) || !/^\d+(?:\.\d+){3}$/.test(value) && value.length <= 253 && value.includes('.') && value.split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(part));
const sameJob = (job, row) => normalize(job.user1) === normalize(row.source) && normalize(job.host1) === row.host && normalize(job.user2) === row.target;
// toolkit/app/mailcow_api.py add_syncjob defaults with api_batch_create's basic inputs.
const syncDefaults = { port1: '993', enc1: 'SSL', mins_interval: '20', subfolder2: '', maxage: '0', maxbytespersecond: '0', timeout1: '600', timeout2: '600', exclude: '', custom_params: '', delete2duplicates: '1', delete1: '0', delete2: '0', automap: '1', skipcrossduplicates: '0', subscribeall: '1', active: '1' };
export function createBatchService({ mailcow, accounts, domains, teams, aliases, audit, lock }) {
  async function rows(session, path) {
    const result = await mailcow.call(session, 'GET', `/api/v1/get/${path}`);
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object' && !Object.keys(result).length) return [];
    throw new AppError(502, 'MAILCOW_REJECTED', '일괄 작업에 필요한 목록을 읽을 수 없어요.');
  }
  async function context(session, kind) {
    const boxes = await rows(session, 'mailbox/all');
    if (kind === 'quotas') return { boxes };
    const [aliases, primary, aliasDomains] = await Promise.all([
      rows(session, 'alias/all'), rows(session, 'domain/all'), rows(session, 'alias-domain/all'),
    ]);
    if (kind === 'aliases') return { boxes, aliases, primary, aliasDomains };
    if (kind === 'syncjobs') return { boxes, aliases, primary, aliasDomains, jobs: await rows(session, 'syncjobs/all/no_log') };
    const first = await teams.list(session);
    const groups = [...first.items];
    for (let page = 2; page <= Math.ceil(first.total / first.pageSize); page++) groups.push(...(await teams.list(session, { page: String(page) })).items);
    return { boxes, aliases, primary, aliasDomains, groups };
  }
  async function inspect(session, kind, csv, options, credentials) {
    const records = parseCsv(csv), header = records.shift().fields.map(value => value.trim()), allowed = columns[kind];
    const required = { mailboxes: ['email'], quotas: ['email', 'quota_gb'], aliases: ['address', 'targets'], syncjobs: ['source', 'password', 'target'] }[kind];
    if (header.some(key => !allowed.includes(key)) || new Set(header).size !== header.length || required.some(key => !header.includes(key))) throw invalid('CSV 열 제목을 확인해 주세요.');
    // Preserve quoted source-password whitespace; all other cells keep their existing normalization.
    for (const record of records) record.fields = record.fields.map((value, index) => kind === 'syncjobs' && header[index] === 'password' ? value : value.trim());
    if (kind === 'syncjobs') for (const record of records) credentials.set(record.line, record.fields[header.indexOf('password')] ?? '');
    const facts = await context(session, kind), seen = new Map();
    if (kind === 'aliases' || kind === 'syncjobs') {
      const active = new Set(facts.primary.filter(row => String(row.active) === '1').map(row => normalize(row.domain_name ?? row.domain)));
      const map = new Map(facts.aliasDomains.filter(row => String(row.active) === '1' && active.has(normalize(row.target_domain))).map(row => [normalize(row.alias_domain), normalize(row.target_domain)]));
      const domainContext = { active: new Set([...active, ...map.keys()]), map };
      const result = records.map(record => {
        const values = Object.fromEntries(header.map((key, index) => [key, record.fields[index] ?? '']));
        const row = kind === 'aliases' ? { line: record.line, address: normalize(values.address), targets: [...new Set(values.targets.split(/[;,]/).map(normalize).filter(Boolean))].sort() } :
          { line: record.line, source: values.source, password: '●●●●', target: normalize(values.target), host: normalize(values.host || options.host), createMailbox: !facts.boxes.some(box => normalize(box.username) === normalize(values.target)) };
        Object.assign(row, { valid: true, error: '', code: null });
        function fail(reason, message) { return Object.assign(row, { valid: false, code: reason, error: message }); }
        if (record.fields.length !== header.length) return fail('CSV_COLUMNS', '열 개수가 제목과 달라요.');
        if (kind === 'aliases') {
          if (!validEmail(row.address) || !row.targets.length || row.targets.some(target => !validEmail(target))) return fail('INVALID_ADDRESS', '별칭 주소와 대상 형식을 확인해 주세요.');
          if (seen.has(row.address)) return fail('DUPLICATE_ADDRESS', `중복 주소예요(${seen.get(row.address)}번 줄과 같음)`);
          seen.set(row.address, row.line);
          if (facts.boxes.some(box => normalize(box.username) === row.address) || facts.aliases.some(alias => normalize(alias.address) === row.address)) return fail('ADDRESS_EXISTS', '이미 있는 메일함 또는 별칭 주소예요.');
          try { validateAlias({ address: row.address, goto: row.targets.join(','), active: '1' }, domainContext, facts.aliases); }
          catch (error) { if (!(error instanceof AppError)) throw error; return fail(code(error), error.message); }
          return row;
        }
        if (!validEmail(normalize(row.source)) || !validEmail(row.target)) return fail('INVALID_ADDRESS', '원본과 대상 메일 주소 형식을 확인해 주세요.');
        if (!validHost(row.host)) return fail('INVALID_HOST', '원본 호스트는 도메인 이름 또는 IPv4로 적어 주세요.');
        if (!credentials.get(row.line)) return fail('PASSWORD_REQUIRED', '원본 암호를 입력해 주세요.');
        const key = JSON.stringify([normalize(row.source), row.host, row.target]);
        if (seen.has(key)) return fail('DUPLICATE_SYNC', `중복 작업이에요(${seen.get(key)}번 줄과 같음)`);
        seen.set(key, row.line);
        const existingJob = facts.jobs.find(job => sameJob(job, row));
        if (existingJob) return fail('SYNC_EXISTS', `같은 작업이 이미 있어요(원본: ${existingJob.user1}).`);
        if (facts.aliases.some(alias => normalize(alias.address) === row.target) && !facts.boxes.some(box => normalize(box.username) === row.target)) return fail('TARGET_IS_ALIAS', '대상 주소는 별칭이에요.');
        const primary = facts.primary.find(item => normalize(item.domain_name ?? item.domain) === row.target.split('@')[1]);
        if (!primary) return fail('DOMAIN_NOT_FOUND', '대상 메일함 도메인이 없어요.');
        if (row.createMailbox && String(primary.active) !== '1') return fail('DOMAIN_NOT_ACTIVE', '대상 메일함 도메인이 꺼져 있어요.');
        if (row.createMailbox && options.autoCreate === false) return fail('NOT_FOUND', '대상 메일함이 없어요. 자동 만들기를 켜 주세요.');
        return row;
      });
      return { kind, rows: result, normal: result.filter(row => row.valid).length, errors: result.filter(row => !row.valid).length };
    }
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
  async function executeSync({ session, actor, ip, row, options, sourcePassword }) {
    return lock.run(`sync-create:${row.target}`, async () => {
      let mailboxCreated = false;
      const identity = { source: row.source, host: row.host, target: row.target };
      try {
        const original = await rows(session, 'syncjobs/all/no_log');
        const existing = original.find(job => sameJob(job, row));
        if (existing) throw new AppError(409, 'SYNC_EXISTS', `같은 작업이 이미 있어요(원본: ${existing.user1}).`);
        if (!(await rows(session, 'mailbox/all')).some(box => normalize(box.username) === row.target)) {
          if (options.autoCreate === false) throw new AppError(422, 'NOT_FOUND', '대상 메일함이 없어요.');
          const [local, domain] = row.target.split('@');
          const created = await accounts.create({ session, actor, ip, data: { local, domain, name: local, kind: 'personal', password: sourcePassword } });
          delete created.password; mailboxCreated = true;
        }
        const safe = value => sanitizeSyncResponse(value, [sourcePassword]);
        const added = await audit.run({ actor, ip, action: 'sync.create', target: `sync-create:${row.target}`, kind: 'config', revertible: false, before: {}, after: safe(identity) }, async intent => {
          const latest = await rows(session, 'syncjobs/all/no_log');
          const existing = latest.find(job => sameJob(job, row));
          if (existing) throw new AppError(409, 'SYNC_EXISTS', `같은 작업이 이미 있어요(원본: ${existing.user1}).`);
          const body = { username: row.target, host1: row.host, user1: row.source, password1: sourcePassword, ...syncDefaults };
          try { safe(await mailcow.call(session, 'POST', '/api/v1/add/syncjob', body)); }
          finally { delete body.password1; }
          const after = await rows(session, 'syncjobs/all/no_log'), ids = new Set(latest.map(job => String(job.id)));
          const found = after.filter(job => !ids.has(String(job.id)) && sameJob(job, row));
          if (found.length !== 1 || found[0].user1 !== row.source || !/^[1-9]\d*$/.test(String(found[0].id)) || String(found[0].port1) !== '993' || found[0].enc1 !== 'SSL' || String(found[0].delete1) !== '0' || String(found[0].delete2) !== '0') throw new AppError(502, 'WRITE_VERIFY_FAILED', '만든 동기화 작업이 예상과 달라요. 현재 작업을 확인해 주세요.');
          return { id: String(found[0].id), auditId: intent.id, detail: safe({ ...identity, result: 'ok' }) };
        });
        return safe({ line: row.line, ...identity, result: 'ok', jobId: added.id, mailboxCreated, auditId: added.auditId });
      } catch (error) {
        if (error instanceof MailcowAuthLost) throw error;
        return sanitizeSyncResponse({ line: row.line, ...identity, result: mailboxCreated ? 'partial' : 'failed', mailboxCreated, code: code(error), error: error instanceof AppError ? error.message : '동기화 작업을 만들지 못했어요.',
          ...(mailboxCreated ? { recovery: ['대상 메일함은 만들어졌고 동기화 작업만 실패 — 이 줄만 다시 실행하면 메일함은 그대로 두고 작업만 만듦'] } : {}) }, [sourcePassword]);
      }
    });
  }
  async function executeRow({ session, actor, ip, kind, row, options, sourcePassword }) {
    const steps = []; let initialPassword;
    try {
      if (kind === 'syncjobs') return await executeSync({ session, actor, ip, row, options, sourcePassword });
      if (kind === 'aliases') return { line: row.line, result: 'ok', ...await aliases.create({ session, actor, ip, data: { address: row.address, targets: row.targets } }) };
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
      return { line: row.line, ...(kind === 'aliases' ? { address: row.address } : { email: row.email }), result: steps.length ? 'partial' : 'failed', code: code(error),
        error: error instanceof AppError ? sanitizeSyncResponse(error.message, initialPassword ? [initialPassword] : []) : '일괄 작업 중 오류가 발생했어요.',
        steps, ...(steps.length ? { recovery: ['도메인은 만들어졌어요. 메일함 상태를 확인한 뒤 해당 줄만 다시 실행해 주세요.'] } : {}) };
    } finally { initialPassword = undefined; }
  }
  async function run({ session, actor, ip, kind, data }) {
    if (!Object.hasOwn(columns, kind)) throw new AppError(404, 'NOT_FOUND', '지원하지 않는 일괄 작업이에요.');
    const credentials = new Map(), options = input(data, kind);
    let parsed;
    try { parsed = await inspect(session, kind, data.csv, options, credentials); }
    catch (error) { error.message = sanitizeSyncResponse(error.message, [...credentials.values()]); throw error; }
    const safe = value => kind === 'syncjobs' ? sanitizeSyncResponse(value, [...credentials.values()]) : value;
    if (data.action === 'parse') {
      const preview = safe(parsed);
      // This fixed preview marker is display data, not an upstream credential.
      if (kind === 'syncjobs') for (const row of preview.rows) row.password = '●●●●';
      return preview;
    }
    const chosen = data.lines.map(line => parsed.rows.find(row => row.line === line));
    if (chosen.some(row => !row?.valid)) throw invalid('오류 줄이 포함돼 실행하지 않았어요. 줄별 미리보기를 다시 확인해 주세요.');
    const results = []; let lost;
    const response = await audit.run({ actor, ip, action: `batch.${kind}`, target: `batch:${kind}`, kind: 'config', revertible: false,
      before: {}, after: { lines: chosen.map(row => row.line) } }, async intent => {
      for (const row of chosen) {
        try { results.push(await executeRow({ session, actor, ip, kind, row, options, sourcePassword: credentials.get(row.line) })); }
        catch (error) {
          if (!(error instanceof MailcowAuthLost)) throw error;
          lost = error; results.push(safe({ line: row.line, ...(kind === 'syncjobs' ? { source: row.source, host: row.host, target: row.target } : kind === 'aliases' ? { address: row.address } : { email: row.email }), result: 'failed', code: code(error) })); break;
        }
      }
      const safeResults = results.map(row => kind === 'syncjobs' ? safe({ source: row.source, host: row.host, target: row.target, result: row.result }) : ({ line: row.line, ...(kind === 'aliases' ? { address: row.address } : { email: row.email }), result: row.result, ...(row.code ? { failure: row.code } : {}), steps: row.steps?.map(step => ({ stage: step.stage, status: step.status, auditId: step.auditId })) ?? [] }));
      return { kind, result: results.some(row => row.result !== 'ok') ? 'partial' : 'ok', results, auditId: intent.id,
        detail: { results: safeResults, stopped: Boolean(lost) } };
    });
    if (lost) throw lost;
    // The response-only credentials never enter the audit detail.
    delete response.detail;
    return safe(response);
  }
  return { run };
}
