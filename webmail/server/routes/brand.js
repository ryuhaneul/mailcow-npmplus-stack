import { readFile } from 'node:fs/promises';
import { AppError } from '../errors.js';
import { readBrandState, resolveBrandFile } from '../brand-store.js';

export default async function brandRoutes(app, { config }) {
  app.get('/brand/logo/:variant', { exposeHeadRoute: false, onSend: async (_request, reply, payload) => {
    if (reply.statusCode === 200) reply.header('content-security-policy', 'sandbox').header('x-content-type-options', 'nosniff').header('content-disposition', 'inline').header('cache-control', 'public, max-age=300');
    return payload;
  } }, async (request, reply) => {
    const variant = request.params.variant;
    if (!['light', 'dark'].includes(variant)) throw new AppError(404, 'NOT_FOUND', '로고를 찾을 수 없어요.');
    const current = await readBrandState(config.logoDir), entry = (variant === 'dark' ? current?.dark : null) ?? current?.light;
    if (!entry) throw new AppError(404, 'NOT_FOUND', '로고를 찾을 수 없어요.');
    let bytes; try { bytes = await readFile(resolveBrandFile(config.logoDir, entry)); } catch { throw new AppError(503, 'LOGO_READ_UNAVAILABLE', '저장한 로고를 읽을 수 없어요.'); }
    if (bytes.length !== entry.size) throw new AppError(503, 'LOGO_READ_UNAVAILABLE', '저장한 로고를 읽을 수 없어요.');
    return reply.type(entry.mime).send(bytes);
  });
}
