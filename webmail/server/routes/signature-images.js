import multipart from '@fastify/multipart';
import { AppError } from '../errors.js';
import { MAX_SIGNATURE_IMAGE_BYTES } from '../signature-images.js';

const invalid = () => new AppError(422, 'SIGNATURE_IMAGE_INVALID', '이미지 파일 한 개를 올려 주세요.');
const tooLarge = () => new AppError(413, 'SIGNATURE_IMAGE_TOO_LARGE', '서명 이미지는 200KiB까지 올릴 수 있어요.');

export default async function signatureImagesRoutes(app, { service }) {
  await app.register(multipart, { limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_SIGNATURE_IMAGE_BYTES } });
  app.get('/api/signature-images', request => service.get(request.session));
  app.post('/api/signature-images', async (request, reply) => {
    let file;
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'file' || file) throw invalid();
        const chunks = [];
        let size = 0;
        for await (const chunk of part.file) {
          size += chunk.length;
          if (size > MAX_SIGNATURE_IMAGE_BYTES) throw tooLarge();
          chunks.push(chunk);
        }
        if (part.file.truncated) throw tooLarge();
        file = { name: part.filename, bytes: Buffer.concat(chunks, size) };
      }
      if (!file) throw invalid();
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error.statusCode === 413) throw tooLarge();
      throw invalid();
    }
    return reply.code(201).send(await service.upload(request.session, file, request.headers['if-match']));
  });
  app.get('/api/signature-images/:id/content', async (request, reply) => {
    const image = await service.content(request.session, request.params.id);
    return reply.type(image.contentType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store').send(image.bytes);
  });
  app.delete('/api/signature-images/:id', request => service.delete(request.session, request.params.id, request.headers['if-match']));
}
