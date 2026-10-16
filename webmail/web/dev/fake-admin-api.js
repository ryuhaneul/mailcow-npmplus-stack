export function createFakeAdminApi() {
  const state = { session: { step: 'done', user: { username: '합성관리자' }, csrf: 'synthetic-admin-csrf', expiresAt: '2099-01-01T00:00:00Z' }, failure: null, auth: { mode: 'password', loginError: null, totpError: null }, requests: [] };
  async function middleware(request, response, next) {
    const url = new URL(request.url, 'http://localhost'); if (!url.pathname.startsWith('/api/admin/')) return next();
    state.requests.push({ path: url.pathname, method: request.method, csrf: request.headers['x-mailadmin-csrf'] }); response.setHeader('content-type', 'application/json');
    const fail = error => { response.statusCode = error.status ?? 403; response.end(JSON.stringify({ error })); };
    if (url.pathname === '/api/admin/auth/login' && request.method === 'POST') {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      if (state.auth.loginError) return fail(state.auth.loginError);
      state.session = { step: state.auth.mode === 'totp' ? 'totp' : 'done', user: { username: body.username }, csrf: 'synthetic-admin-csrf', expiresAt: new Date(Date.now() + 300000).toISOString() };
      return response.end(JSON.stringify(state.session));
    }
    if (url.pathname === '/api/admin/auth/totp' && request.method === 'POST' && state.session) {
      for await (const _part of request) { /* Consume without retaining authentication codes. */ }
      if (state.auth.totpError) { const error = state.auth.totpError; if (error.restart) state.session = null; return fail(error); }
      state.session.step = 'done'; return response.end(JSON.stringify(state.session));
    }
    if (state.failure || !state.session) { response.statusCode = 403; response.end(JSON.stringify({ error: state.failure ?? { code: 'NO_SESSION', message: '로그인이 필요해요.' } })); return; }
    if (url.pathname === '/api/admin/auth/session') return response.end(JSON.stringify(state.session));
    if (url.pathname === '/api/admin/status') return response.end(JSON.stringify({ queue: { count: 0, longestDelaySeconds: 0 }, blocked: { count: 0 } }));
    if (url.pathname === '/api/admin/auth/logout' && request.method === 'POST') { state.session = null; response.statusCode = 204; return response.end(); }
    response.statusCode = 404; response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '합성 경로 없음' } }));
  }
  return { state, middleware };
}
