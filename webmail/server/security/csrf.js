import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

export function checkOrigin(request, publicHostnames) {
  const allowed = publicHostnames.map(host => `https://${host}`);
  if (!allowed.includes(request.headers.origin)) {
    throw new AppError(403, 'BAD_ORIGIN', '허용된 웹메일 주소에서 다시 시도해 주세요.');
  }
}

export function checkCsrf(request) {
  const raw = request.headers['x-webmail-csrf'];
  const expected = Buffer.from(request.session.csrf);
  const actual = typeof raw === 'string' ? Buffer.from(raw) : Buffer.alloc(0);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError(403, 'CSRF', '요청을 확인할 수 없어요. 화면을 새로 고친 뒤 다시 시도해 주세요.');
  }
}
