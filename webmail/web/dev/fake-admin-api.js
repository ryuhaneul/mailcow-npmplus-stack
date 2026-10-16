export function createFakeAdminApi() {
  const state = { session: { step: 'done', user: { username: '합성관리자' }, csrf: 'synthetic-admin-csrf', expiresAt: '2099-01-01T00:00:00Z' }, failure: null, requests: [] };
  function middleware(request, response, next) {
    const url = new URL(request.url, 'http://localhost'); if (!url.pathname.startsWith('/api/admin/')) return next();
    state.requests.push({ path: url.pathname, method: request.method, csrf: request.headers['x-mailadmin-csrf'] }); response.setHeader('content-type', 'application/json');
    if (state.failure || !state.session) { response.statusCode = 403; response.end(JSON.stringify({ error: state.failure ?? { code: 'SESSION_EXPIRED', message: '합성 세션 오류' } })); return; }
    if (url.pathname === '/api/admin/auth/session') return response.end(JSON.stringify(state.session));
    if (url.pathname === '/api/admin/status') return response.end(JSON.stringify({ queue: { count: 0, longestDelaySeconds: 0 }, blocked: { count: 0 } }));
    if (url.pathname === '/api/admin/auth/logout' && request.method === 'POST') { state.session = null; response.statusCode = 204; return response.end(); }
    response.statusCode = 404; response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '합성 경로 없음' } }));
  }
  return { state, middleware };
}
