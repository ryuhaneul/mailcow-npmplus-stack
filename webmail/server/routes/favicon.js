import { AppError } from '../errors.js';
import { readFaviconState, readFaviconFile, faviconCsp } from '../favicon-store.js';
export default async function faviconRoutes(app, { config }) {
  app.get('/favicon.ico', { onSend: async (_request, reply, payload) => {
    reply.header('content-security-policy', faviconCsp).header('x-content-type-options', 'nosniff').header('cache-control', 'no-cache').header('content-disposition', 'inline'); return payload;
  } }, async (request, reply) => {
    const entry = await readFaviconState(config.logoDir);
    if (!entry) throw new AppError(404, 'NOT_FOUND', '등록된 탭 아이콘이 없어요.');
    const value = await readFaviconFile(config.logoDir, entry), tag = `"${entry.version}"`;
    reply.header('etag', tag).type(value.mime);
    if (request.headers['if-none-match']?.split(',').some(item => item.trim().replace(/^W\//, '') === tag || item.trim() === '*')) return reply.code(304).send();
    return reply.send(value.data);
  });
}
