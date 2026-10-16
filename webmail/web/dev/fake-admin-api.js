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
    if (url.pathname === '/api/admin/status') return response.end(JSON.stringify(state.status));
    if (url.pathname === '/api/admin/queue') return response.end(JSON.stringify(state.queue));
    if (url.pathname === '/api/admin/compat-usage') return response.end(JSON.stringify(state.compat));
    if (url.pathname === '/api/admin/history') return response.end(JSON.stringify({ items: state.history.slice(0, Number(url.searchParams.get('limit') ?? 50)) }));
    if (url.pathname === '/api/admin/auth/logout' && request.method === 'POST') { state.session = null; response.statusCode = 204; return response.end(); }
    response.statusCode = 404; response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '합성 경로 없음' } }));
  }
  return { state, middleware };
}
