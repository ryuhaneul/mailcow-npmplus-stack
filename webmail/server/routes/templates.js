import { AppError } from '../errors.js';
import { isPublicTemplateRef } from '../templates/public.js';
import { decodeRef } from '../mail/ref.js';
import { isTemplateFolder, maxTemplates } from '../templates/store.js';

export default async function templateRoutes(app, { store, sharing, prefs, compose, config, publicReader }) {
  const write = { bodyLimit: (config.attachMaxMb ?? 30) * 1024 * 1024 };
  const read = (session, token) => isPublicTemplateRef(token) ? publicReader.get(session, token) : isTemplateFolder(decodeRef(token).path) ? store.get(session, token) : sharing.read(session, token);
  app.get('/api/templates', async request => {
    const mine = await store.list(request.session), shared = await sharing.list(request.session);
    const publicResult = await publicReader.list(request.session);
    const doc = await prefs.get(request.session);
    const available = new Set([...mine, ...shared, ...publicResult.items].map(item => JSON.stringify([item.owner, item.id])));
    const pins = (doc.templatePins ?? []).filter(pin => publicResult.unavailable && pin.owner === 'public' || available.has(JSON.stringify([pin.owner, pin.id])));
    return { mine, shared, public: publicResult.items, ...(publicResult.unavailable ? { publicUnavailable: true } : {}), pins, limits: { max: maxTemplates } };
  });
  app.get('/api/templates/share', request => sharing.get(request.session));
  app.put('/api/templates/share', request => sharing.put(request.session, request.body));
  app.get('/api/templates/:ref', request => read(request.session, request.params.ref));
  app.post('/api/templates', write, async (request, reply) => reply.code(201).send(await store.create(request.session, request.body)));
  app.put('/api/templates/:ref', write, request => store.update(request.session, request.params.ref, request.body));
  app.delete('/api/templates/:ref', request => store.remove(request.session, request.params.ref, request.body));
  app.post('/api/templates/:ref/move', request => store.move(request.session, request.params.ref, request.body));
  app.post('/api/templates/:ref/copy', async (request, reply) => reply.code(201).send(await (isPublicTemplateRef(request.params.ref) ? publicReader.copy(request.session, request.params.ref) : sharing.copy(request.session, request.params.ref))));
  app.post('/api/templates/:ref/attachments-to-compose', async request => {
    const body = request.body;
    if (!body || Object.keys(body).length !== 1 || typeof body.composeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.composeId)) throw new AppError(422, 'BAD_REQUEST', '작성 내용을 확인해 주세요.');
    if (isPublicTemplateRef(request.params.ref)) return publicReader.attachments(request.session, request.params.ref, body);
    const template = await read(request.session, request.params.ref);
    return compose.templateAttachments(request.session, request.params.ref, body, template.html);
  });
}
