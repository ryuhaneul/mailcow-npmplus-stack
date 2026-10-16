import { sieveDisabledWarning } from '../../server/admin/messages.js';
import { parseCsv } from '../../server/admin/services/batch.js';
export function createFakeAdminApi() {
  const state = { session: { step: 'done', user: { username: '합성관리자' }, csrf: 'synthetic-admin-csrf', expiresAt: '2099-01-01T00:00:00Z' }, features: { cleanup: true, relay: true }, failure: null, auth: { mode: 'password', loginError: null, totpError: null }, requests: [] };
  state.status = {
    queue: { count: 9, longestDelaySeconds: 240 }, blocked: { count: 4 },
    certificates: [{ port: 993, daysRemaining: 42, expiresAt: '2026-11-27T00:00:00Z', valid: true }, { port: 465, daysRemaining: 18, expiresAt: '2026-11-03T00:00:00Z', valid: false, reason: 'SYNTHETIC_TLS_UNVERIFIED' }],
    storage: { vmail: { disk: '/synthetic/vmail', used: '26G', total: '42G', usedPercent: '62%' }, mailboxes: { items: [{ address: 'person@example.com', usedBytes: 2147483648, quotaBytes: 21474836480 }] } },
    version: { version: 'synthetic-2026-09' }, containers: { abnormalCount: 1, items: [{ container: 'synthetic-postfix', state: 'exited' }, { container: 'synthetic-dovecot', state: 'running' }] }, teamFilters: { count: 1, teams: ['team@example.com'] },
    checks: [{ code: 'TEAM_REDIRECT_MOVE', message: '복사 없이 옮기는 팀 필터가 있어요.', link: '#teams' }],
  };
  state.queue = { items: [{ id: 'SYNTHETIC1', state: 'deferred', sender: 'sender@example.com', recipients: ['person@example.com'], arrivedAt: '2026-10-16T00:00:00Z', size: 2048, waitingSeconds: 240, reason: '451 synthetic temporary response' }] };
  state.compat = { n: 1000, range: { dovecot: { newest: '1792108800', oldest: '1792105200', count: 87 }, postfix: { newest: '1792108800', oldest: '1792105200', count: 126 } }, plainPop3: { status: 'known', count: 2, accounts: [{ account: 'legacy@example.com', lastSeen: '1792108800' }], basis: 'pop3-login: Login 중 secured/TLS 표시 없는 계정 (조회한 로그 범위 안)' }, smtp25: { status: 'unknown', count: null, accounts: [], basis: '합성 로그에서 포트 판정 불가' } };
  state.history = [0, 1, 2].map((index) => ({ id: String(index).padStart(32, '0'), ts: `2026-10-16T0${3 - index}:00:00Z`, actor: '합성관리자', summary: ['운영팀 구성원 변경', '웹메일 로고 변경', '개인 메일 정리'][index], canRevert: index !== 2 }));
  state.flow = { joinMode: 'ok', failedLine: null, partialLine: null, authLostAtBatch: 0, batches: [] };
  const accountProtocols = { imap: true, pop3: true, smtp: true, sieve: true, eas: true, dav: true };
  state.accounts = { patchError: null, result: 'ok', version: 1, revertible: false, items: [
    { address: 'person@example.com', name: '합성 구성원', kind: 'personal', active: 1, quotaGb: 20, usedBytes: 2147483648, messages: 123 },
    { address: 'team@example.com', name: '합성 팀', kind: 'team', active: 1, quotaGb: 50, usedBytes: 1073741824, messages: 20 },
    { address: 'off@example.com', name: '합성 비활성', kind: 'personal', active: 0, quotaGb: 20, usedBytes: 0, messages: 0 },
    { address: 'admin@example.com', name: '합성 관리', kind: 'admin', active: 2, quotaGb: 3, usedBytes: 1024, messages: 1 },
  ].map(row => ({ ...row, protocols: { ...accountProtocols }, senderAcl: [] })) };
  state.accountRefs = { aliases: [{ address: 'contact@example.com', targets: ['person@example.com'], active: 1, senderAllowed: false }], teams: [{ mailbox: 'team@example.com', filterId: 8, members: ['person@example.com', 'other@example.com'] }], senders: [{ mailbox: 'person@example.com', sendAs: 'team@example.com', direction: 'received' }], shares: [{ owner: 'team@example.com', grantee: 'person@example.com', rights: ['lookup', 'read'] }], syncjobs: [{ id: 9, target: 'person@example.com', active: 1 }] };
  const leaveWarnings = [{ code: 'LOGIN_BLOCK_DELAY', message: '로그인 차단은 최대 5분 안에 적용돼요' }, { code: 'REMOVE_DEVICE_ACCOUNT', message: '퇴사자 기기의 메일 계정 설정을 지워 주세요' }];
  function inspectCsv(kind, text) {
    const records = parseCsv(text), header = records.shift().fields, seen = new Set();
    const items = records.map(record => {
      const value = Object.fromEntries(header.map((key, index) => [key, record.fields[index] ?? ''])), email = value.email ?? value.address ?? '';
      const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !seen.has(email); seen.add(email);
      return { line: record.line, email: value.email, address: value.address, name: value.name ?? '', type: value.type ?? '개인', team: value.team ?? '', teamAddress: value.team === '기획팀' ? 'team@example.com' : null, quotaGb: Number(value.quota_gb), targets: (value.targets ?? '').split(';'), valid, error: valid ? '' : '주소 또는 중복을 확인해 주세요.' };
    });
    return { kind, rows: items, normal: items.filter(row => row.valid).length, errors: items.filter(row => !row.valid).length };
  }
  async function middleware(request, response, next) {
    const url = new URL(request.url, 'http://localhost'); if (!url.pathname.startsWith('/api/admin/')) return next();
    state.requests.push({ path: url.pathname, method: request.method, csrf: request.headers['x-mailadmin-csrf'] }); response.setHeader('content-type', 'application/json');
    const fail = error => { response.statusCode = error.status ?? 403; response.end(JSON.stringify({ error })); };
    if (url.pathname === '/api/admin/auth/login' && request.method === 'POST') {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      if (state.auth.loginError) return fail(state.auth.loginError);
      state.session = { step: state.auth.mode === 'totp' ? 'totp' : 'done', user: { username: body.username }, csrf: 'synthetic-admin-csrf', expiresAt: new Date(Date.now() + 300000).toISOString() };
      return response.end(JSON.stringify({ ...state.session, features: state.features }));
    }
    if (url.pathname === '/api/admin/auth/totp' && request.method === 'POST' && state.session) {
      for await (const _part of request) { /* Consume without retaining authentication codes. */ }
      if (state.auth.totpError) { const error = state.auth.totpError; if (error.restart) state.session = null; return fail(error); }
      state.session.step = 'done'; return response.end(JSON.stringify({ ...state.session, features: state.features }));
    }
    if (state.failure || !state.session) { response.statusCode = 403; response.end(JSON.stringify({ error: state.failure ?? { code: 'NO_SESSION', message: '로그인이 필요해요.' } })); return; }
    if (url.pathname === '/api/admin/auth/session') return response.end(JSON.stringify({ ...state.session, features: state.features }));
    if (url.pathname.startsWith('/api/admin/history/') && request.method === 'GET') return response.end(JSON.stringify({ id: url.pathname.split('/').at(-1), target: 'person@example.com', revertible: state.accounts.revertible, canRevert: state.accounts.revertible }));
    if (url.pathname === '/api/admin/mailboxes' && request.method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase(), kind = url.searchParams.get('kind') ?? 'all', page = Number(url.searchParams.get('page') ?? 1);
      const items = state.accounts.items.filter(row => `${row.name} ${row.address}`.toLowerCase().includes(q) && (kind === 'all' || (kind === 'off' ? row.active !== 1 : row.kind === kind))).sort((a,b) => a.address.localeCompare(b.address));
      return response.end(JSON.stringify({ items: items.slice((page-1)*50, page*50), total: items.length, page, pageSize: 50 }));
    }
    const accountMatch = url.pathname.match(/^\/api\/admin\/mailboxes\/([^/]+)(\/delete-preview)?$/), leaving = url.pathname === '/api/admin/flows/leave';
    if (accountMatch || leaving) {
      let body = {}; if (request.method !== 'GET') { let raw=''; for await (const part of request) raw += part; body=JSON.parse(raw || '{}'); }
      const address = leaving ? body.address : decodeURIComponent(accountMatch[1]), row = state.accounts.items.find(row => row.address === address), etag = `synthetic-account-${state.accounts.version}`;
      if (!row) return fail({status:404,code:'NOT_FOUND',message:'메일함을 찾을 수 없어요.'});
      const send = value => response.end(JSON.stringify(value));
      if (request.method === 'GET') return send({ ...row, etag, refs: state.accountRefs, sharesScope: 'teams+own', appPasswordCount: 2, warnings: [] });
      if (request.method === 'PATCH') {
        if (state.accounts.patchError) return fail(state.accounts.patchError);
        if (body.etag !== etag) return fail({status:409,code:'CHANGED_ELSEWHERE',message:'다른 곳에서 값이 바뀌었어요.'});
        for (const key of ['name','quotaGb','protocols']) if (body[key] !== undefined) row[key] = body[key];
        if (body.active !== undefined) row.active=Number(body.active); state.accounts.version++;
        return send({ result: 'ok', mailbox: row, etag: `synthetic-account-${state.accounts.version}`, warnings: body.protocols?.sieve===false ? [{...sieveDisabledWarning}] : [], steps:[{stage:'settings',status:'ok',auditId:'11111111111111111111111111111111'}] });
      }
      const mode = leaving ? body.mode : 'delete', previewing = leaving ? body.action === 'preview' : Boolean(accountMatch[2]);
      if (previewing) return send({ address, mode, cleanRefs: leaving ? body.cleanRefs : true, forwardTo: body.forwardTo || null, etag, messages: row.messages, usedBytes: row.usedBytes, refs: body.cleanRefs === false ? {} : { ...state.accountRefs, aliases: state.accountRefs.aliases.map(alias => ({ ...alias, effect: mode==='delete' ? 'deleted' : 'kept' })) }, sharesScope: body.cleanRefs===false ? 'none' : 'all', irreversible: mode==='delete', confirmAddress: mode==='delete' ? address : null, confirmation: mode==='delete' ? '메일함과 메일을 복구할 수 없어요. 주소를 직접 입력해 주세요.' : '로그인을 막고 메일은 보존해요.', warnings: leaving ? leaveWarnings : [] });
      if (body.etag !== etag) return fail({status:409,code:'CHANGED_ELSEWHERE',message:'다른 곳에서 값이 바뀌었어요.'});
      if (mode==='delete' && (body.confirmAddress!==address || body.cleanRefs!==true)) return fail({status:422,code:'INVALID_INPUT',message:'주소 확인이 필요해요.'});
      if (mode==='disable') row.active=2;
      const steps = mode==='disable' ? [{stage:'active',target:address,status:'ok'}] : [{stage:'aliases',target:'contact@example.com',status:'ok'}];
      if (state.accounts.result==='partial') steps.push({stage: mode==='delete'?'mailbox':'teams',status:'failed',code:'SYNTHETIC_CLEANUP_FAILED'});
      else { if (mode==='delete') { steps.push({stage:'mailbox',target:address,status:'ok'}); state.accounts.items=state.accounts.items.filter(item=>item!==row); } else { row.active=2; if(body.forwardTo) steps.push({stage:'forward',target:body.forwardTo,status:'ok'}); } }
      return send({result:state.accounts.result,steps,warnings:leaving?leaveWarnings:[],detail:{steps}});
    }
    if (url.pathname === '/api/admin/teams') return response.end(JSON.stringify({ items: [{ mailbox: 'team@example.com', editable: true }], mailboxes: [{ address: 'team@example.com', name: '기획팀' }], total: 1, pageSize: 50 }));
    if (url.pathname === '/api/admin/mailboxes' && request.method === 'POST') {
      let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw), steps = [{ stage: 'mailbox', status: 'ok' }];
      if (body.team) steps.push({ stage: 'team', status: state.flow.joinMode === 'partial' ? 'failed' : 'ok', ...(state.flow.joinMode === 'partial' ? { code: 'SYNTHETIC_TEAM_FAILED' } : {}) });
      const partial = steps.some(step => step.status === 'failed');
      if (!partial && body.alias) steps.push({ stage: 'alias', status: 'ok' });
      if (!partial && body.addSendForTeam) steps.push({ stage: 'permissions', status: 'ok' });
      return response.end(JSON.stringify({ address: `${body.local}@${body.domain}`, result: partial ? 'partial' : 'ok', steps, password: body.password }));
    }
    if (url.pathname.startsWith('/api/admin/batch/') && request.method === 'POST') {
      let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw), kind = url.pathname.split('/').at(-1);
      let parsed; try { parsed = inspectCsv(kind, body.csv); } catch { return fail({ status: 422, code: 'CSV_SYNTAX', message: 'CSV 형식을 확인해 주세요.' }); }
      if (body.action === 'parse') return response.end(JSON.stringify(parsed));
      state.flow.batches.push({ kind, action: body.action, lines: body.lines });
      if (state.flow.authLostAtBatch === state.flow.batches.length) { state.session = null; return fail({ code: 'MAILCOW_SESSION_LOST', message: '합성 로그인 종료' }); }
      if (body.lines.some(line => !parsed.rows.find(row => row.line === line)?.valid)) return fail({ status: 422, code: 'INVALID_INPUT', message: '오류 줄은 실행하지 않았어요.' });
      const results = body.lines.map(line => { const row = parsed.rows.find(item => item.line === line), partial = line === state.flow.partialLine, failed = line === state.flow.failedLine && body.action !== 'retry'; return { line, email: row.email, address: row.address, result: partial ? 'partial' : failed ? 'failed' : 'ok', steps: partial ? [{ stage: 'mailbox', status: 'ok' }, { stage: 'team', status: 'failed' }] : [{ stage: 'mailbox', status: failed ? 'failed' : 'ok' }], ...(partial ? { recovery: ['메일함은 만들어졌고 팀 배정만 실패 — 계정 화면이나 팀 화면에서 마저 하기'] } : {}), ...(!failed && kind === 'mailboxes' ? { password: 'Batch-Initial-Aa1234!' } : {}) }; });
      return response.end(JSON.stringify({ results, result: results.some(row => row.result !== 'ok') ? 'partial' : 'ok' }));
    }
    if (url.pathname === '/api/admin/status') return response.end(JSON.stringify(state.status));
    if (url.pathname === '/api/admin/queue') return response.end(JSON.stringify(state.queue));
    if (url.pathname === '/api/admin/compat-usage') return response.end(JSON.stringify(state.compat));
    if (url.pathname === '/api/admin/history') return response.end(JSON.stringify({ items: state.history.slice(0, Number(url.searchParams.get('limit') ?? 50)) }));
    if (url.pathname === '/api/admin/auth/logout' && request.method === 'POST') { state.session = null; response.statusCode = 204; return response.end(); }
    response.statusCode = 404; response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '합성 경로 없음' } }));
  }
  return { state, middleware };
}
