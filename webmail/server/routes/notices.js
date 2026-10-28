import { AppError } from '../errors.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', '공지 조회와 읽음 번호를 확인해 주세요.');
const integer = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
export default async function noticesRoutes(app, { service }) {
  app.get('/api/notices/unread', request => service.unread(request.session.email));
  app.get('/api/notices', request => {
    const { scope = 'recent', before } = request.query;
    if (!['recent', 'all'].includes(scope) || before !== undefined && (scope !== 'all' || !integer(before))) throw invalid();
    // Audience and owner come exclusively from the authenticated session.
    return service.list(request.session.email, { scope, ...(before === undefined ? {} : { before: Number(before) }) });
  });
  app.post('/api/notices/seen', request => {
    const body = request.body;
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => key !== 'upTo') || !Number.isSafeInteger(body.upTo) || body.upTo < 0) throw invalid();
    return service.seen(request.session.email, body.upTo);
  });
}
