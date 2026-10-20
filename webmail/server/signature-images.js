import { createHash, randomBytes } from 'node:crypto';
import { AppError } from './errors.js';
import { getMetadata, setMetadataEntries } from './mail/imap-raw.js';
import { withSignatureStoreLock } from './signature-store-lock.js';

export const SIGNATURE_IMAGES_ENTRY = '/private/vendor/mailstack-webmail/signature-images-v1';
export const MAX_SIGNATURE_IMAGE_BYTES = 204800;
export const MAX_SIGNATURE_IMAGES_BYTES = 1048576;
export const MAX_SIGNATURE_IMAGES_COUNT = 20;
export const MAX_SIGNATURE_IMAGES_JSON_BYTES = 1572864;
export const MAX_SIGNATURE_IMAGE_PIXELS = 16000000;
const idPattern = /^[A-Za-z0-9_-]{32}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => new AppError(422, 'SIGNATURE_IMAGE_INVALID', 'PNG, JPEG, GIF, WebP 이미지 파일을 확인해 주세요.');
const tooLarge = () => new AppError(413, 'SIGNATURE_IMAGE_TOO_LARGE', '서명 이미지 보관함의 크기 또는 개수 한도를 넘었어요.');
const corrupt = () => new AppError(503, 'SIGNATURE_IMAGES_INVALID', '저장된 서명 이미지 보관함을 읽을 수 없어요. 원본은 보존돼 있어요.');
const newRevision = () => randomBytes(24).toString('base64url');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fileName(name) {
  if (typeof name !== 'string' || !name.trim() || /[\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 255) throw invalid();
  return name;
}

// Header inspection deliberately does not decode the complete bitmap.
export function inspectSignatureImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw invalid();
  if (bytes.length > MAX_SIGNATURE_IMAGE_BYTES) throw tooLarge();
  let contentType, width, height;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw invalid();
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] || bytes[27] || bytes[28] > 1) throw invalid();
    contentType = 'image/png';
  } else if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); contentType = 'image/gif';
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9 || marker === 0x00 || marker === 0xd8) throw invalid();
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw invalid();
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw invalid();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 11 || !bytes[offset + 7] || length !== 8 + 3 * bytes[offset + 7]) throw invalid();
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); contentType = 'image/jpeg';
        break;
      }
      offset += length;
    }
  } else if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
    const kind = bytes.toString('ascii', 12, 16), length = bytes.readUInt32LE(16);
    if (20 + length + (length % 2) > bytes.length) throw invalid();
    if (kind === 'VP8X' && length === 10 && bytes.length >= 30) {
      if ((bytes[20] & 0xc1) || bytes[21] || bytes[22] || bytes[23]) throw invalid();
      width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3);
    } else if (kind === 'VP8L' && length >= 5 && bytes.length >= 25 && bytes[20] === 0x2f) {
      if (bytes[24] & 0xe0) throw invalid();
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === 'VP8 ' && length >= 10 && bytes.length >= 30 && !(bytes[20] & 1) && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else throw invalid();
    contentType = 'image/webp';
  }
  if (!contentType || !width || !height) throw invalid();
  if (width * height > MAX_SIGNATURE_IMAGE_PIXELS) throw tooLarge();
  return { contentType, width, height };
}

export function parseSignatureImages(raw) {
  if (raw === null) return { version: 1, revision: '0', images: {} };
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_SIGNATURE_IMAGES_JSON_BYTES) throw corrupt();
    const doc = JSON.parse(raw);
    if (!exact(doc, ['version', 'revision', 'images']) || doc.version !== 1 || typeof doc.revision !== 'string' || !idPattern.test(doc.revision) || !object(doc.images)) throw corrupt();
    if (Object.keys(doc.images).length > MAX_SIGNATURE_IMAGES_COUNT) throw corrupt();
    let used = 0;
    for (const [id, image] of Object.entries(doc.images)) {
      if (!idPattern.test(id) || !exact(image, ['name', 'contentType', 'size', 'sha256', 'base64'])) throw corrupt();
      fileName(image.name);
      if (typeof image.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) throw corrupt();
      const bytes = Buffer.from(image.base64, 'base64');
      if (bytes.toString('base64') !== image.base64 || bytes.length !== image.size || hash(bytes) !== image.sha256 || inspectSignatureImage(bytes).contentType !== image.contentType) throw corrupt();
      used += bytes.length;
    }
    if (used > MAX_SIGNATURE_IMAGES_BYTES) throw corrupt();
    return doc;
  } catch { throw corrupt(); }
}
const usedBytes = doc => Object.values(doc.images).reduce((total, image) => total + image.size, 0);
function imageInfo(id, image) {
  const { width, height } = inspectSignatureImage(Buffer.from(image.base64, 'base64'));
  return { id, name: image.name, contentType: image.contentType, size: image.size, width, height };
}
function checkRevision(doc, revision) {
  if (revision === undefined || revision === null || revision === '') throw new AppError(428, 'SIGNATURE_REVISION_REQUIRED', '최신 서명 이미지 정보를 먼저 불러와 주세요.');
  if (revision !== doc.revision) throw new AppError(409, 'SIGNATURE_CONFLICT', '서명 이미지가 바뀌었어요. 다시 불러와 주세요.');
}

export function createSignatureImagesService({ imap, getReferences }) {
  async function read(client) {
    return parseSignatureImages(await getMetadata(client, '', SIGNATURE_IMAGES_ENTRY, { maxSize: MAX_SIGNATURE_IMAGES_JSON_BYTES }));
  }
  async function run(session, operation) {
    return withSignatureStoreLock(session.email, async () => {
      try { return await imap.withMailbox(session, 'INBOX', operation); } catch (error) {
        if (error instanceof AppError && error.statusCode !== 502) throw error;
        throw new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
      }
    });
  }
  async function write(client, doc) {
    const json = JSON.stringify(doc);
    if (Buffer.byteLength(json) > MAX_SIGNATURE_IMAGES_JSON_BYTES) throw tooLarge();
    await setMetadataEntries(client, [[SIGNATURE_IMAGES_ENTRY, json]]);
  }
  return {
    // Internal callers already holding the account queue and mailbox lock use read.
    read,
    get(session) {
      return run(session, async client => {
        const doc = await read(client);
        return { revision: doc.revision, images: Object.entries(doc.images).map(([id, image]) => imageInfo(id, image)), usedBytes: usedBytes(doc), maxBytes: MAX_SIGNATURE_IMAGES_BYTES, maxFileBytes: MAX_SIGNATURE_IMAGE_BYTES, maxCount: MAX_SIGNATURE_IMAGES_COUNT };
      });
    },
    upload(session, { name, bytes }, revision) {
      return run(session, async client => {
        const doc = await read(client);
        checkRevision(doc, revision);
        fileName(name);
        const { contentType } = inspectSignatureImage(bytes), sha256 = hash(bytes);
        const existing = Object.entries(doc.images).find(([, image]) => image.sha256 === sha256 && image.contentType === contentType && image.base64 === bytes.toString('base64'));
        if (existing) return { revision: doc.revision, image: imageInfo(...existing), usedBytes: usedBytes(doc) };
        if (Object.keys(doc.images).length >= MAX_SIGNATURE_IMAGES_COUNT || usedBytes(doc) + bytes.length > MAX_SIGNATURE_IMAGES_BYTES) throw tooLarge();
        const id = randomBytes(24).toString('base64url');
        doc.images[id] = { name, contentType, size: bytes.length, sha256, base64: bytes.toString('base64') };
        doc.revision = newRevision();
        await write(client, doc);
        return { revision: doc.revision, image: imageInfo(id, doc.images[id]), usedBytes: usedBytes(doc) };
      });
    },
    content(session, id) {
      return run(session, async client => {
        const doc = await read(client), image = doc.images[id];
        if (!Object.hasOwn(doc.images, id)) throw new AppError(404, 'SIGNATURE_IMAGE_NOT_FOUND', '서명 이미지를 찾을 수 없어요.');
        return { ...imageInfo(id, image), bytes: Buffer.from(image.base64, 'base64') };
      });
    },
    delete(session, id, revision) {
      return run(session, async client => {
        const doc = await read(client);
        checkRevision(doc, revision);
        if (!Object.hasOwn(doc.images, id)) throw new AppError(404, 'SIGNATURE_IMAGE_NOT_FOUND', '서명 이미지를 찾을 수 없어요.');
        // S1a supplies all active signatures plus the actual legacy mirror. Backups are excluded.
        if (typeof getReferences !== 'function') throw new AppError(503, 'SIGNATURE_REFERENCES_UNAVAILABLE', '서명 참조를 확인할 수 없어요.');
        const references = await getReferences({ session, client });
        if (!Array.isArray(references) || references.some(ref => !object(ref) || !Array.isArray(ref.assetIds))) throw new AppError(503, 'SIGNATURE_REFERENCES_UNAVAILABLE', '서명 참조를 확인할 수 없어요.');
        const inUse = references.filter(ref => ref.assetIds.includes(id));
        if (inUse.length) throw new AppError(409, 'SIGNATURE_IMAGE_IN_USE', `서명 이미지가 사용 중이에요: ${inUse.map(ref => ref.name).join(', ')}`);
        delete doc.images[id];
        doc.revision = newRevision();
        await write(client, doc);
        return { revision: doc.revision, usedBytes: usedBytes(doc) };
      });
    },
  };
}
