import { constants } from 'node:http2';

export class AppError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function safeStatus(status, log) {
  if (status === constants.HTTP_STATUS_UNAUTHORIZED) {
    log.warn({ code: 'AUTH_STATUS_REWRITTEN' }, '인증 실패 응답 상태를 변환했습니다.');
    return 403;
  }
  return status;
}

export function errorBody(code, message) {
  return { error: { code, message } };
}

export function installErrors(app) {
  app.setErrorHandler((error, request, reply) => {
    const rawStatus = error.statusCode;
    const status = safeStatus(Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500, request.log);
    if (status >= 500) request.log.error({ code: 'SERVER_ERROR', status, ip: request.ip }, '서버 오류가 발생했습니다.');
    const known = error instanceof AppError && status < 500;
    const code = known ? error.code : status === 403 ? 'AUTH_FAILED' : status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
    const message = known ? error.message : status === 403 ? '접근할 수 없어요.' : status < 500 ? '요청을 확인해 주세요.' : '서버 오류가 발생했어요. 잠시 뒤 다시 시도해 주세요.';
    reply.code(status).send(errorBody(code, message));
  });
}
