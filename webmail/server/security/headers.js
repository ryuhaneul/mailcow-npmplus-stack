import { isIP } from 'node:net';
import { safeStatus, errorBody } from '../errors.js';

export const securityHeaders = Object.freeze({
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
});

export function installHeaders(app) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.hasHeader('www-authenticate')) {
      reply.removeHeader('www-authenticate');
      request.log.error({ code: 'AUTH_CHALLENGE_REMOVED' }, '금지된 인증 응답 머리글을 제거했습니다.');
    }
    const status = safeStatus(reply.statusCode, request.log);
    if (status !== reply.statusCode) {
      reply.code(status).type('application/json');
      payload = JSON.stringify(errorBody('AUTH_FAILED', '접근할 수 없어요.'));
      reply.removeHeader('content-length');
    }
    let pathname = '';
    try {
      const url = new URL(request.url, 'http://localhost');
      url.pathname = decodeURIComponent(url.pathname);
      pathname = url.pathname;
    } catch {}
    for (const [name, value] of Object.entries(securityHeaders)) {
      reply.header(name, name === 'content-security-policy' && pathname.startsWith('/starflow/')
        ? value.replace("frame-ancestors 'none'", "frame-ancestors 'self'") : value);
    }
    return payload;
  });
}

// Fastify가 신뢰 경계까지 계산한 체인만 읽는다. 원본 XFF는 파싱하지 않는다.
export function installClientIp(app) {
  app.addHook('onRequest', async request => {
    let ip;
    for (const address of request.ips) {
      if (!isIP(address)) break;
      ip = address;
    }
    Object.defineProperty(request, 'ip', { value: ip, enumerable: true, configurable: true });
  });
}
