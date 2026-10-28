import { randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Readable, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import libmime from 'libmime';
import libbase64 from 'libbase64';
import libqp from 'libqp';
import { JSDOM } from 'jsdom';
import MailComposer from 'nodemailer/lib/mail-composer';
import { AppError } from '../errors.js';
import { encodeRef, decodeRef } from './ref.js';
import { bodyParts, attachmentHeaders, decodeCharset, decodeWords } from './read.js';
import { sanitizeComposeHtml } from './sanitize.js';
import { prepareSignatureInline } from './signature-inline.js';
import { createSignatureImagesService } from '../signature-images.js';
import { withSignatureStoreLock } from '../signature-store-lock.js';
import { decodeTemplateRef } from '../templates/store.js';
import { decodeSharedTemplateRef } from '../templates/share.js';
import { templateIdPattern } from '../templates/mime.js';

const invalid = () => new AppError(422, 'BAD_REQUEST', '작성 내용을 확인해 주세요.');
const tooLarge = () => new AppError(413, 'ATTACH_TOO_LARGE', '첨부 파일 합계가 허용 크기를 넘었어요.');
const notFound = () => new AppError(404, 'ATTACHMENT_NOT_FOUND', '첨부 파일을 찾을 수 없어요.');
const unavailable = () => new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
const badAddress = () => new AppError(422, 'BAD_ADDRESS', '메일 주소를 확인해 주세요.');
const id = () => randomBytes(24).toString('base64url');
const header = value => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value);
function address(value) {
  const item = typeof value === 'string' ? { address: value, name: '' } : value;
  if (!item || typeof item.address !== 'string' || !/^[^\s<>@,;:"()[\]\\\x00-\x1f\x7f]+@[^\s<>@,;:"()[\]\\\x00-\x1f\x7f]+$/.test(item.address) || !header(item.name ?? '')) throw badAddress();
  return { address: item.address.toLowerCase(), name: item.name || '' };
}
function validate(body, sending) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  const from = address(body.from).address;
  const result = { from };
  for (const key of ['to', 'cc', 'bcc']) {
    if (body[key] !== undefined && !Array.isArray(body[key])) throw badAddress();
    result[key] = (body[key] || []).map(address);
  }
  const count = result.to.length + result.cc.length + result.bcc.length;
  if (sending && !count) throw new AppError(422, 'NO_RECIPIENT', '받는 사람을 입력해 주세요.');
  if (count > 100) throw new AppError(422, 'TOO_MANY_RECIPIENTS', '받는 사람은 100명까지 입력할 수 있어요.');
  if (!header(body.subject ?? '') || typeof (body.html ?? '') !== 'string') throw invalid();
  for (const key of ['inReplyTo', 'references']) if (body[key] !== undefined && !header(body[key])) throw invalid();
  if (body.signatureImages !== undefined && !Array.isArray(body.signatureImages)) throw new AppError(422, 'SIGNATURE_INVALID', '서명 형식을 확인해 주세요.');
  if (body.attachmentIds !== undefined && (!Array.isArray(body.attachmentIds) || body.attachmentIds.some(value => typeof value !== 'string'))) throw invalid();
  if (body.forwardParts !== undefined && (!Array.isArray(body.forwardParts) || body.forwardParts.some(part => !part || typeof part.partId !== 'string' || !/^\d+(?:\.\d+)*$/.test(part.partId)))) throw invalid();
  for (const part of body.forwardParts || []) decodeRef(part.ref);
  for (const key of ['draftRef', 'replyToRef']) if (body[key] !== undefined) decodeRef(body[key]);
  return { ...result, subject: body.subject ?? '', html: body.html ?? '', inReplyTo: body.inReplyTo, references: body.references };
}

const unsupportedDraft = () => new AppError(422, 'DRAFT_UNSUPPORTED', '다른 프로그램에서 만든 임시 메일이라 웹메일에서 이어 쓸 수 없어요');
function draftParts(structure) {
  const bodies = [], attachments = [];
  // One editable body, or the standard plain+HTML alternative (also allowing
  // related HTML+CID images). Every other leaf must have an attachment name or
  // disposition, or be a supported CID image. Never discard independent bodies,
  // unnamed inline text CIDs, nested messages, signed/encrypted containers.
  function walk(node, alternative = null) {
    if (!node || /^message\//.test(node.type)) throw unsupportedDraft();
    const named = Boolean(node.dispositionParameters?.filename || node.parameters?.name), attached = node.disposition === 'attachment' || named;
    if (node.childNodes?.length) {
      if (attached || !['multipart/mixed','multipart/related','multipart/alternative'].includes(node.type) || (alternative && node.type !== 'multipart/related')) throw unsupportedDraft();
      const group = node.type === 'multipart/alternative' ? node : alternative;
      for (const child of node.childNodes) walk(child, group);
      return;
    }
    if (!['7bit','8bit','binary','base64','quoted-printable'].includes((node.encoding || '7bit').toLowerCase())) throw unsupportedDraft();
    const part = { ...node, part: node.part || '1', attachment: attached };
    if (!attached && !node.id && ['text/plain','text/html'].includes(node.type)) bodies.push({ part, alternative });
    else if (attached || (node.id && /^image\/(png|jpeg|gif|webp)$/.test(node.type))) attachments.push(part);
    else throw unsupportedDraft();
  }
  walk(structure);
  if (bodies.length === 1) return { body: bodies[0].part, attachments, alternative: false };
  if (bodies.length === 2 && bodies[0].alternative && bodies[0].alternative === bodies[1].alternative && new Set(bodies.map(item=>item.part.type)).size === 2) {
    return { body: bodies.find(item=>item.part.type==='text/html').part, attachments, alternative: true };
  }
  throw unsupportedDraft();
}
function mimeIdentity(part) {
  const ordered = parameters => Object.fromEntries(Object.entries(parameters || {}).sort(([a],[b])=>a.localeCompare(b)));
  return JSON.stringify({ type: part.type, parameters: ordered(part.parameters), disposition: part.disposition || '', dispositionParameters: ordered(part.dispositionParameters), id: part.id || '' });
}
function rewriteTemplateCids(html, urls) {
  if (!urls.size) return html;
  const fragment = JSDOM.fragment(html);
  for (const image of fragment.querySelectorAll('img[src]')) {
    const cid = urls.get(image.getAttribute('src'));
    if (cid) image.setAttribute('src', `cid:${cid}`);
  }
  const container = fragment.ownerDocument.createElement('div'); container.append(fragment);
  return container.innerHTML;
}
function alternativeText(html) {
  const fragment = JSDOM.fragment(html);
  for (const node of fragment.querySelectorAll('style')) node.remove();
  for (const node of fragment.querySelectorAll('br')) node.replaceWith('\n');
  for (const node of fragment.querySelectorAll('p,div,blockquote,pre,li,h1,h2,h3,h4,h5,h6,tr')) node.append('\n');
  return fragment.textContent;
}

export function createComposeService({ config, imap, directory, smtp, logger, images = createSignatureImagesService({ imap }), tempRoot = '/tmp/webmail', now = Date.now }) {
  const states = new WeakMap();
  const maxBytes = config.attachMaxMb * 1024 * 1024;
  const sessionMaxBytes = maxBytes * 2, sessionMaxFiles = 200;
  const uploadTtl = 24 * 60 * 60 * 1000;
  async function prune(session, state) {
    for (const [attachmentId, file] of state.attachments) {
      if (now() - file.lastUsedAt < uploadTtl) continue;
      await rm(join(sessionDir(session), attachmentId), { force: true });
      state.attachments.delete(attachmentId);
    }
  }
  function stateFor(session) {
    let state = states.get(session);
    if (!state) {
      // Receipts live for this entire session, never expire independently: an
      // evicted successful key could otherwise deliver the same mail twice.
      state = { attachments: new Map(), sends: new Map(), tail: Promise.resolve() }; states.set(session, state);
      session.sweepAttachments = () => serial(session, () => {});
      session.scanAbort?.signal.addEventListener('abort', () => {
        state.attachments.clear(); state.sends.clear(); states.delete(session); delete session.sweepAttachments;
      }, { once: true });
    }
    return state;
  }
  function active(session) {
    if (!session.connection) throw new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
  }
  function serial(session, operation) {
    const state = stateFor(session);
    const task = state.tail.then(async () => { active(session); await prune(session, state); return operation(state); });
    state.tail = task.catch(() => {});
    return task;
  }
  const sessionDir = session => join(tempRoot, session.id);
  async function directoryFor(session) {
    active(session);
    const path = sessionDir(session);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!session.connection) { await rm(path, { recursive: true, force: true }); active(session); }
    return path;
  }
  function limiter(onBytes) {
    return new Transform({ transform(chunk, encoding, callback) {
      try { onBytes(chunk.length); callback(null, chunk); } catch (error) { callback(error); }
    } });
  }
  async function uploadToState(session, state, parts, metadata = {}) {
      if (Object.keys(metadata).some(key => !['cid', 'contentDisposition'].includes(key)) || (metadata.cid !== undefined && (typeof metadata.cid !== 'string' || !/^[A-Za-z0-9._@-]{1,200}$/.test(metadata.cid))) || (metadata.contentDisposition !== undefined && !['inline', 'attachment'].includes(metadata.contentDisposition))) throw invalid();
      let file, path, composeId;
      try {
        const dir = await directoryFor(session);
        const sessionBytes = [...state.attachments.values()].reduce((sum, item) => sum + item.size, 0);
        if (state.attachments.size >= sessionMaxFiles) throw new AppError(413, 'ATTACH_TOO_LARGE', '임시 첨부 파일은 로그인 세션당 200개까지 올릴 수 있어요.');
        for await (const part of parts) {
          if (part.type === 'field') {
            if (part.fieldname !== 'composeId' || composeId !== undefined || part.valueTruncated || typeof part.value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(part.value)) throw invalid();
            composeId = part.value;
            continue;
          }
          if (file || part.type !== 'file' || part.fieldname !== 'file') throw invalid();
          file = { id: id(), filename: String(part.filename || 'attachment').replace(/[\x00-\x1f\x7f\\/]/g, '_'), size: 0, contentType: part.mimetype || 'application/octet-stream', ...metadata };
          path = join(dir, file.id);
          await pipeline(part.file, limiter(bytes => { file.size += bytes; if (file.size > maxBytes || sessionBytes + file.size > sessionMaxBytes) throw tooLarge(); }), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
          if (part.file.truncated) throw tooLarge();
        }
        if (!file) throw invalid();
        const existing = [...state.attachments.values()].filter(item => composeId === undefined || item.composeId === composeId).reduce((sum, item) => sum + item.size, 0);
        if (existing + file.size > maxBytes) throw tooLarge();
        active(session);
        state.attachments.set(file.id, { ...file, composeId, lastUsedAt: now() });
        return file;
      } catch (error) {
        if (path) await rm(path, { force: true });
        if (!session.connection) await rm(sessionDir(session), { force: true, recursive: true });
        if (error.code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
        throw error;
      }
  }
  async function upload(session, parts, metadata) {
    return serial(session, state => uploadToState(session, state, parts, metadata));
  }
  async function remove(session, attachmentId) {
    return serial(session, async state => {
      if (!state.attachments.has(attachmentId)) throw notFound();
      await rm(join(sessionDir(session), attachmentId), { force: true });
      state.attachments.delete(attachmentId);
    });
  }
  async function specialFolder(session, name) {
    return imap.withMailbox(session, 'INBOX', async client => {
      const folders = await client.list();
      return folders.find(folder => folder.specialUse === `\\${name}` && !/^(Shared|WebmailVirtual)(\/|$)/.test(folder.path))?.path || name;
    });
  }
  async function checkMessage(session, token, expectedPath) {
    if (expectedPath && decodeRef(token).path !== expectedPath) throw invalid();
    return imap.withRef(session, token, async (client, ref) => {
      const row = await client.fetchOne(ref.uid, { uid: true, ...(expectedPath ? { bodyStructure: true } : {}) }, { uid: true });
      if (!row) throw new AppError(404, 'MESSAGE_NOT_FOUND', '메일을 찾을 수 없어요.');
      return row;
    });
  }
  async function deleteDraft(session, token) {
    if (!token) return;
    return imap.withRef(session, token, async (client, ref) => {
      if (!await client.messageDelete(ref.uid, { uid: true })) throw unavailable();
    });
  }
  async function rawPart(client, uid, node, path) {
    const mimeKey = `${node.part}.mime`;
    const headers = await client.fetchOne(uid, { bodyParts: [mimeKey] }, { uid: true, binary: false });
    const mime = headers?.bodyParts?.get(mimeKey);
    if (Number(headers?.uid) !== uid || !Buffer.isBuffer(mime) || !mime.subarray(-4).equals(Buffer.from('\r\n\r\n'))) throw unavailable();
    const file = path ? await open(path, 'wx', 0o600) : null;
    const hash = createHash('sha256'); let size = 0;
    try {
      if (file) await file.writeFile(mime);
      async function* chunks() {
        const chunkSize = 64 * 1024; let offset = 0;
        while (true) {
          const row = await client.fetchOne(uid, { bodyParts: [{ key: node.part, start: offset, maxLength: chunkSize }] }, { uid: true, binary: false });
          const chunk = row?.bodyParts?.get(node.part), origin = row?.partialOrigins?.get(node.part);
          if (Number(row?.uid) !== uid || !Buffer.isBuffer(chunk) || chunk.length > chunkSize || (origin !== offset && !(origin === undefined && offset === 0 && chunk.length === node.size && chunk.length < chunkSize))) throw unavailable();
          if (file) await file.writeFile(chunk);
          offset += chunk.length; yield chunk;
          if (chunk.length < chunkSize) { if (offset !== node.size) throw unavailable(); break; }
          if (offset > node.size) throw unavailable();
        }
      }
      const encoding = (node.encoding || '7bit').toLowerCase();
      const decoder = encoding === 'base64' ? new libbase64.Decoder() : encoding === 'quoted-printable' ? new libqp.Decoder() : new PassThrough();
      // Only transfer decoding: never interpret format=flowed or transcode charset.
      await pipeline(Readable.from(chunks()), decoder, async source => {
        for await (const chunk of source) { size += chunk.length; if (size > maxBytes) throw tooLarge(); hash.update(chunk); }
      });
      return { size, sha256: hash.digest('hex') };
    } finally { await file?.close(); }
  }
  async function decodedPartSize(client, uid, partId) {
    if (client.capabilities?.has('BINARY') || client.capabilities?.has('IMAP4rev2')) {
      try {
        const rows = [];
        if (typeof client.preCheck === 'function') await client.preCheck();
        const response = await client.exec('UID FETCH', [{ type: 'SEQUENCE', value: String(uid) }, [{ type: 'ATOM', value: 'UID' }, { type: 'ATOM', value: 'BINARY.SIZE', section: [{ type: 'ATOM', value: partId }] }]], { untagged: { FETCH: row => { rows.push(row); } } });
        response.next();
        for (const row of rows) {
          const fields = row.attributes?.[1];
          if (!Array.isArray(fields) || fields.length % 2) continue;
          let rowUid, size;
          for (let index = 0; index < fields.length; index += 2) {
            const key = String(fields[index]?.value).toUpperCase(), value = String(fields[index + 1]?.value);
            if (key === 'UID') rowUid = Number(value);
            if (key === `BINARY.SIZE[${partId}]` && /^\d+$/.test(value)) size = Number(value);
          }
          if (rowUid === uid && Number.isSafeInteger(size) && size >= 0) return size;
        }
      } catch { /* Unsupported or rejected BINARY.SIZE falls back to decoded streaming. */ }
    }
    // The caller's withRef applies the same 60s mailbox deadline as other downloads.
    const row = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
    const node = bodyParts(row?.bodyStructure).find(part => part.part === partId);
    if (!node) throw notFound();
    return (await rawPart(client, uid, node)).size;
  }
  async function loadDraft(session, token) {
    active(session);
    const path = decodeRef(token).path;
    if (/^(Shared|WebmailVirtual)(\/|$)/.test(path) || path !== await specialFolder(session, 'Drafts')) {
      throw new AppError(403, 'DRAFT_NOT_ALLOWED', '내 임시보관함의 메일만 이어 쓸 수 있어요.');
    }
    const result = await imap.withRef(session, token, async (client, ref) => {
      const row = await client.fetchOne(ref.uid, { envelope: true, bodyStructure: true, headers: ['REFERENCES', 'IN-REPLY-TO'] }, { uid: true });
      if (!row) throw new AppError(404, 'MESSAGE_NOT_FOUND', '임시 메일을 찾을 수 없어요. 임시보관함에서 다시 열어 주세요.');
      const representation = draftParts(row.bodyStructure), envelope = row.envelope || {};
      const body = representation.body;
      const maxBodyBytes = (config.bodyMaxMb ?? 5) * 1024 * 1024;
      let html = '';
      if (body) {
        const oversized = () => new AppError(413, 'BODY_TOO_LARGE', '본문이 너무 커서 이어 쓸 수 없어요.');
        if (body.size > maxBodyBytes) throw oversized();
        const download = await client.download(ref.uid, body.part, { uid: true, binary: true, maxBytes: maxBodyBytes + 1 });
        if (!download.content) throw unavailable();
        const chunks = []; let size = 0;
        for await (const chunk of download.content) {
          size += Buffer.byteLength(chunk);
          if (size > maxBodyBytes) { download.content.destroy(); throw oversized(); }
          chunks.push(Buffer.from(chunk));
        }
        const text = decodeCharset(Buffer.concat(chunks), download.meta?.charset || body.parameters?.charset || 'utf-8');
        html = body.type === 'text/html' ? text : `<pre style="font-family:inherit">${text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))}</pre>`;
      }
      const addresses = items => (items || []).filter(item => item.address).map(item => ({ address: item.address, name: decodeWords(item.name) }));
      const headers = libmime.decodeHeaders(row.headers?.toString('latin1') || '');
      let composeFrom = envelope.from?.[0]?.address?.toLowerCase() || '', fromChanged = false;
      try { await directory.assertFrom(session, composeFrom); } catch (error) {
        if (error.code !== 'FROM_NOT_ALLOWED') throw error;
        const identities = await directory.identities(session);
        composeFrom = identities.defaultFrom || identities.identities[0]?.address || session.email;
        fromChanged = true;
      }
      const attachments = representation.attachments.map(part => ({
        ref: token, partId: part.part, filename: decodeWords(part.dispositionParameters?.filename || part.parameters?.name || `attachment-${part.part}`), size: part.size || 0, contentType: part.type,
        ...(part.id ? { cid: part.id.trim().replace(/^<|>$/g, '') } : {}), inline: part.disposition === 'inline',
      }));
      return { draftRef: token, composeFrom, fromChanged, from: addresses(envelope.from), to: addresses(envelope.to), cc: addresses(envelope.cc), bcc: addresses(envelope.bcc), subject: decodeWords(envelope.subject), html: sanitizeComposeHtml(html, { publicHostnames: config.publicHostnames }), attachments, inReplyTo: envelope.inReplyTo || headers['in-reply-to']?.[0] || '', references: headers.references?.join(' ') || '' };
    });
    for (const attachment of result.attachments) {
      try {
        attachment.size = await imap.withRef(session, token, (client, ref) => decodedPartSize(client, ref.uid, attachment.partId));
      } catch (error) {
        if (['NO_SESSION', 'SESSION_EXPIRED'].includes(error.code)) throw error;
        // Keep encoded size only for conservative limit checks, never as a displayed byte count.
        attachment.sizeKnown = false;
      }
    }
    return result;
  }
  async function build(session, state, body, mail, alternative = false, templateParts = false) {
    const temporary = [], streams = [];
    try {
      let total = 0;
      const attachments = [], existingCids = [], resumedParts = [], templateCids = new Map();
      for (const attachmentId of new Set(body.attachmentIds || [])) {
        const file = state.attachments.get(attachmentId);
        if (!file) throw notFound();
        const path = join(sessionDir(session), attachmentId);
        try { total += (await stat(path)).size; } catch (error) { if (error.code === 'ENOENT') throw notFound(); throw error; }
        if (total > maxBytes) throw tooLarge();
        if (file.cid) existingCids.push(file.cid);
        attachments.push({ filename: file.filename, contentType: file.contentType, ...(file.cid ? { cid: file.cid } : {}), ...(file.contentDisposition ? { contentDisposition: file.contentDisposition } : {}), path });
      }
      for (const part of body.forwardParts || []) {
        if (templateParts) templateRef(session, part.ref);
        const dir = await directoryFor(session);
        const path = join(dir, id()); temporary.push(path);
        const metadata = await imap.withRef(session, part.ref, async (client, ref) => {
          const row = await client.fetchOne(ref.uid, { bodyStructure: true, ...(templateParts ? { uid: true, headers: ['X-WEBMAIL-TEMPLATE-ID'] } : {}) }, { uid: true });
          if (templateParts) assertTemplate(row, ref);
          const node = bodyParts(row?.bodyStructure).find(node => node.part === part.partId);
          if (!node || (templateParts && !node.attachment && !node.id)) throw notFound();
          if (typeof node.id === 'string') {
            existingCids.push(node.id);
            if (templateParts) templateCids.set(`/api/messages/${encodeURIComponent(part.ref)}/parts/${encodeURIComponent(part.partId)}?inline=1`, node.id.trim().replace(/^<|>$/g, ''));
          }
          if (body.draftRef === part.ref || templateParts) {
            const verified = await rawPart(client, ref.uid, node, path);
            total += verified.size; if (total > maxBytes) throw tooLarge();
            const headers = attachmentHeaders(node, false), encoded = /filename\*=UTF-8''([^;]*)/.exec(headers['content-disposition']);
            const metadata = { filename: decodeURIComponent(encoded[1]), contentType: headers['content-type'], raw: true, ...(node.id ? { cid: node.id.trim().replace(/^<|>$/g, '') } : {}), contentDisposition: node.disposition || 'attachment' };
            resumedParts.push({ ...part, ...metadata, ...verified, mime: mimeIdentity(node) });
            return metadata;
          }
          const download = await client.download(ref.uid, part.partId, { uid: true, binary: true });
          if (!download.content) throw notFound();
          await pipeline(download.content, limiter(bytes => { total += bytes; if (total > maxBytes) throw tooLarge(); }), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
          const headers = attachmentHeaders(node, false);
          const encoded = /filename\*=UTF-8''([^;]*)/.exec(headers['content-disposition']);
          const metadata = { filename: decodeURIComponent(encoded[1]), contentType: headers['content-type'] };
          return metadata;
        });
        attachments.push({ ...metadata, path });
      }
      mail.html = rewriteTemplateCids(mail.html, templateCids);
      const prepare = stored => prepareSignatureInline({ html: mail.html, signatureImages: body.signatureImages, images: stored, existingCids, nonce: id() });
      // Take owned bytes while holding the account queue, before any deletion can win.
      const inline = body.signatureImages === undefined || (Array.isArray(body.signatureImages) && body.signatureImages.length === 0)
        ? prepare({})
        : await withSignatureStoreLock(session.email, () => imap.withMailbox(session, 'INBOX', async client => prepare((await images.read(client)).images)));
      total += inline.totalBytes;
      if (total > maxBytes) throw tooLarge();
      mail.html = sanitizeComposeHtml(inline.html, { publicHostnames: config.publicHostnames });
      active(session);
      // Explicit streams prevent nodemailer from treating user content as a URL/path.
      const compiled = new MailComposer({ ...mail, ...(alternative ? { text: alternativeText(mail.html) } : {}), attachments: attachments.map(file => {
        const content = createReadStream(file.path); streams.push(content);
        return { filename: file.filename, contentType: file.contentType, ...(file.cid ? { cid: file.cid } : {}), ...(file.contentDisposition ? { contentDisposition: file.contentDisposition } : {}), ...(file.raw ? { raw: content } : { content }) };
      }).concat(inline.parts), disableFileAccess: true, disableUrlAccess: true }).compile();
      compiled.keepBcc = true;
      return { raw: await compiled.build(), resumedParts };
    } finally {
      for (const stream of streams) stream.destroy();
      await Promise.all(temporary.map(path => rm(path, { force: true })));
      if (!session.connection) await rm(sessionDir(session), { recursive: true, force: true });
    }
  }
  async function write(session, body, sending, receipt) {
    // A queued save owns its HTML and manifest, even if the caller edits the model.
    body = structuredClone(body);
    return serial(session, async state => {
      const mail = validate(body, sending);
      await directory.assertFrom(session, mail.from);
      const { identities } = await directory.identities(session);
      const identity = identities.find(item => item.address === mail.from);
      const fallback = identity ? identities : (await directory.identities({ ...session, prefs: { ...session.prefs, fromNames: {} } })).identities;
      const name = identity?.name ?? fallback.find(item => item.kind === 'self')?.name ?? '';
      mail.from = { address: mail.from, name };
      const draftsPath = body.draftRef ? await specialFolder(session, 'Drafts') : null;
      const draftMessage = body.draftRef ? await checkMessage(session, body.draftRef, draftsPath) : null;
      if (sending && body.replyToRef) await checkMessage(session, body.replyToRef);
      const { raw, resumedParts } = await build(session, state, body, mail, Boolean(draftMessage && bodyParts(draftMessage.bodyStructure).filter(part=>!part.attachment&&['text/html','text/plain'].includes(part.type)).length === 2));
      for (const attachmentId of new Set(body.attachmentIds || [])) state.attachments.get(attachmentId).lastUsedAt = now();
      async function cleanup() {
        for (const attachmentId of new Set(body.attachmentIds || [])) {
          try {
            await rm(join(sessionDir(session), attachmentId), { force: true });
            state.attachments.delete(attachmentId);
          } catch {
            logger?.error({ code: 'ATTACHMENT_CLEANUP_FAILED', email: session.email }, '임시 첨부 정리에 실패했습니다.');
          }
        }
      }
      if (sending) {
        active(session);
        const end = raw.indexOf('\r\n\r\n');
        const headers = raw.subarray(0, end).toString('utf8').replace(/^Bcc:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*(?:\r\n|$)/gim, '');
        const delivery = Buffer.concat([Buffer.from(headers), raw.subarray(end)]);
        const result = await smtp.send(session, delivery, { from: mail.from.address, to: [...mail.to, ...mail.cc, ...mail.bcc].map(item => item.address) });
        // Publish SMTP acceptance before IMAP work. A lost HTTP response or a
        // slow/failed copy must never turn accepted delivery into a send failure.
        receipt.value = { status: 'sent', ok: true, copyPending: true, ...(result?.rejected?.length ? { rejected: result.rejected } : {}) };
        receipt.updatedAt = now();
        const warnings = [];
        async function afterSend(code, operation) {
          try { await operation(); return true; } catch {
            warnings.push(code);
            logger?.error({ code, email: session.email }, '발송된 메일의 후처리에 실패했습니다.');
          }
        }
        let copySaved = false, sentCopySavedTo = null, sentCopyRef;
        try {
          for (let attempt = 0; attempt < 2 && !copySaved; attempt++) {
            try {
              const path = await specialFolder(session, 'Sent');
              const appended = await imap.withMailbox(session, path, client => client.append(path, raw, ['\\Seen']));
              if (!appended) throw unavailable();
              copySaved = true;
              sentCopySavedTo = 'sent';
              if (appended.uid && appended.uidValidity) sentCopyRef = encodeRef(path, appended.uidValidity, appended.uid);
            } catch {
              logger?.error({ code: 'SENT_COPY_FAILED', email: session.email }, '발송된 메일의 사본 저장에 실패했습니다.');
            }
          }
          if (!copySaved) {
            warnings.push('SENT_COPY_FAILED');
            sentCopySavedTo = null;
            try {
              const path = await specialFolder(session, 'Drafts');
              // Preserve the exact completed message, including Bcc and newly uploaded parts.
              const appended = await imap.withMailbox(session, path, client => client.append(path, raw, ['\\Draft', '\\Seen']));
              if (!appended) throw unavailable();
              copySaved = true;
              sentCopySavedTo = 'drafts';
              if (appended.uid && appended.uidValidity) sentCopyRef = encodeRef(path, appended.uidValidity, appended.uid);
            } catch {
              logger?.error({ code: 'SENT_COPY_FAILED', email: session.email }, '발송된 메일의 대체 사본 저장에 실패했습니다.');
            }
          }
          if (body.draftRef && copySaved) await afterSend('DRAFT_DELETE_FAILED', () => deleteDraft(session, body.draftRef));
          if (body.replyToRef) await afterSend('ANSWERED_FAILED', () => imap.withRef(session, body.replyToRef, async (client, ref) => {
            if (!await client.messageFlagsAdd(ref.uid, ['\\Answered'], { uid: true })) throw unavailable();
          }));
        } finally { if (copySaved) await cleanup(); }
        return { status: 'sent', ok: true, ...(result?.rejected?.length ? { rejected: result.rejected } : {}), ...(warnings.length ? { warnings } : {}), sentCopySavedTo, ...(sentCopyRef ? { sentCopyRef } : {}) };
      }
      const path = await specialFolder(session, 'Drafts');
      const appended = await imap.withMailbox(session, path, client => client.append(path, raw, ['\\Draft', '\\Seen']));
      if (!appended?.uid || !appended.uidValidity) throw unavailable();
      const draftRef = encodeRef(path, appended.uidValidity, appended.uid);
      const forwardParts = [];
      if (resumedParts.length) {
        try {
          await imap.withRef(session, draftRef, async (client, ref) => {
            const row = await client.fetchOne(ref.uid, { bodyStructure: true }, { uid: true });
            const parts = bodyParts(row?.bodyStructure).filter(part => part.attachment || !['text/html', 'text/plain'].includes(part.type));
            const used = new Set();
            // MailComposer keeps regular attachments in input order; inline parts move into multipart/related.
            let regularIndex = new Set(body.attachmentIds || []).size;
            const regular = parts.filter(part => !part.id);
            for (const previous of resumedParts) {
              const part = previous.cid ? parts.find(part => !used.has(part.part) && part.id?.trim().replace(/^<|>$/g, '') === previous.cid) : regular[regularIndex++];
              if (!part || used.has(part.part)) throw unavailable();
              if (mimeIdentity(part) !== previous.mime) throw unavailable();
              const verified = await rawPart(client, ref.uid, part);
              if (verified.sha256 !== previous.sha256 || verified.size !== previous.size) throw unavailable();
              const size = verified.size;
              used.add(part.part);
              forwardParts.push({ previousRef: previous.ref, previousPartId: previous.partId, ref: draftRef, partId: part.part, size });
            }
          });
        } catch {
          await deleteDraft(session, draftRef);
          throw new AppError(503, 'DRAFT_ATTACHMENTS_UNVERIFIED', '첨부를 다시 확인하지 못해 저장하지 않았어요. 다시 시도해 주세요.');
        }
      }
      await deleteDraft(session, body.draftRef);
      return { draftRef, ...(forwardParts.length ? { forwardParts } : {}) };
    }).catch(error => { if (error instanceof AppError) throw error; throw unavailable(); });
  }
  function sendKey(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw invalid();
    return value;
  }
  function sendStatus(session, composeId) {
    active(session);
    const receipt = stateFor(session).sends.get(sendKey(composeId));
    if (!receipt) return { status: 'unknown', reason: 'NOT_FOUND' };
    return { ...receipt.value, startedAt: receipt.startedAt, updatedAt: receipt.updatedAt };
  }
  async function send(session, body) {
    active(session);
    const key = sendKey(body?.composeId), sends = stateFor(session).sends, previous = sends.get(key);
    if (previous && previous.value.status !== 'not_sent') return previous.value;
    const receipt = { startedAt: now(), updatedAt: now(), value: { status: 'checking' } };
    // Claim the key synchronously, before the session queue or any await.
    sends.set(key, receipt);
    try {
      receipt.value = await write(session, body, true, receipt);
      receipt.updatedAt = now();
      return receipt.value;
    } catch (error) {
      receipt.updatedAt = now();
      if (receipt.value.status === 'sent') return receipt.value;
      if (error.code === 'SMTP_OUTCOME_UNKNOWN') {
        receipt.value = { status: 'unknown', reason: error.code };
        return receipt.value;
      }
      receipt.value = { status: 'not_sent', error: { code: error.code, message: error.message, ...(error.smtpMessage ? { smtpMessage: error.smtpMessage } : {}) } };
      throw error;
    }
  }
  async function draft(session, body) {
    const key = body?.composeId === undefined ? null : sendKey(body.composeId);
    const result = await write(session, body, false);
    const receipt = key && states.get(session)?.sends.get(key);
    if (receipt?.value.status === 'sent' && (receipt.value.sentCopySavedTo === null || receipt.value.manualRecovery)) {
      receipt.value = { ...receipt.value, sentCopySavedTo: 'drafts', sentCopyRef: result.draftRef, manualRecovery: true };
      receipt.updatedAt = now();
    }
    return result;
  }
  function templateRef(session, token) {
    return decodeRef(token).path.startsWith('Shared/') ? decodeSharedTemplateRef(token, session) : decodeTemplateRef(token);
  }
  function assertTemplate(row, ref) {
    const headers = libmime.decodeHeaders(row?.headers?.toString('latin1') || '');
    if (row?.uid !== ref.uid || !templateIdPattern.test(headers['x-webmail-template-id']?.[0]?.trim() ?? '')) throw new AppError(404, 'TEMPLATE_NOT_FOUND', '템플릿을 찾을 수 없어요.');
  }
  async function buildTemplateMime(session, input) {
    const data = structuredClone(input);
    return serial(session, async state => {
      if (typeof data?.html !== 'string' || !header(data?.subject ?? '') || !Array.isArray(data.attachments ?? [])) throw invalid();
      const body = { attachmentIds: [], forwardParts: [] };
      for (const part of data.attachments ?? []) {
        if (typeof part?.uploadId === 'string') body.attachmentIds.push(part.uploadId);
        else {
          templateRef(session, part?.templateRef);
          if (typeof part?.part !== 'string' || !/^\d+(?:\.\d+)*$/.test(part.part)) throw invalid();
          body.forwardParts.push({ ref: part.templateRef, partId: part.part });
        }
      }
      return (await build(session, state, body, { subject: data.subject ?? '', html: data.html }, true, true)).raw;
    }).catch(error => { if (error instanceof AppError) throw error; throw unavailable(); });
  }
  async function templateAttachments(session, token, input, html) {
    templateRef(session, token);
    if (!input || Object.keys(input).length !== 1 || typeof input.composeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.composeId) || typeof html !== 'string') throw invalid();
    const composeId = input.composeId;
    return serial(session, async state => {
      const created = [], byPart = new Map();
      const occupied = new Set([...state.attachments.values()].map(file => file.cid?.toLowerCase()).filter(Boolean));
      try {
        await imap.withRef(session, token, async (client, ref) => {
          const row = await client.fetchOne(ref.uid, { uid: true, bodyStructure: true, headers: ['X-WEBMAIL-TEMPLATE-ID'] }, { uid: true });
          assertTemplate(row, ref);
          for (const node of bodyParts(row.bodyStructure).filter(part => part.attachment || part.id)) {
            const headers = attachmentHeaders(node, false), encoded = /filename\*=UTF-8''([^;]*)/.exec(headers['content-disposition']);
            const filename = decodeURIComponent(encoded[1]);
            let cid;
            if (node.id) {
              do { cid = `wm-template-v1.${id()}@template.invalid`; } while (occupied.has(cid.toLowerCase()));
              occupied.add(cid.toLowerCase());
            }
            const download = await client.download(ref.uid, node.part, { uid: true, binary: true, maxBytes: maxBytes + 1 });
            if (!download.content) throw notFound();
            async function* parts() {
              yield { type: 'field', fieldname: 'composeId', value: composeId };
              yield { type: 'file', fieldname: 'file', filename, mimetype: headers['content-type'], file: download.content };
            }
            let uploaded;
            try { uploaded = await uploadToState(session, state, parts(), { ...(cid ? { cid, contentDisposition: 'inline' } : { contentDisposition: 'attachment' }) }); }
            finally { download.content.destroy(); }
            created.push(uploaded);
            if (cid) byPart.set(node.part, cid);
          }
        });
        const urls = new Map([...byPart].map(([part, cid]) => [`/api/messages/${encodeURIComponent(token)}/parts/${encodeURIComponent(part)}?inline=1`, cid]));
        const rewritten = rewriteTemplateCids(html, urls);
        return { uploads: created.map(file => ({ id: file.id, name: file.filename, size: file.size })), html: rewritten };
      } catch (error) {
        for (const file of created) state.attachments.delete(file.id);
        const removed = await Promise.allSettled(created.map(file => rm(join(sessionDir(session), file.id), { force: true })));
        if (removed.some(result => result.status === 'rejected')) logger?.error({ code: 'TEMPLATE_ATTACHMENTS_ROLLBACK_FAILED' }, '템플릿 임시 첨부 정리에 실패했습니다.');
        if (error instanceof AppError) throw error;
        throw unavailable();
      }
    });
  }
  async function publicTemplateAttachments(session, input, template, loadFile) {
    if (!input || Object.keys(input).length !== 1 || typeof input.composeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.composeId) || typeof template?.html !== 'string' || !Array.isArray(template.attachments)) throw invalid();
    return serial(session, async state => {
      const created = [];
      try {
        for (const metadata of template.attachments) {
          const file = await loadFile(metadata.part);
          if (!Buffer.isBuffer(file.data)) throw notFound();
          const stream = Readable.from([file.data]);
          async function* parts() {
            yield { type: 'field', fieldname: 'composeId', value: input.composeId };
            yield { type: 'file', fieldname: 'file', filename: file.name, mimetype: file.type, file: stream };
          }
          try { created.push(await uploadToState(session, state, parts(), { contentDisposition: 'attachment' })); }
          finally { stream.destroy(); }
        }
        return { uploads: created.map(file => ({ id: file.id, name: file.filename, size: file.size })), html: template.html };
      } catch (error) {
        for (const file of created) state.attachments.delete(file.id);
        const results = await Promise.allSettled(created.map(file => rm(join(sessionDir(session), file.id), { force: true })));
        if (results.some(result => result.status === 'rejected')) logger?.error({ code: 'PUBLIC_TEMPLATE_ATTACHMENTS_ROLLBACK_FAILED' }, '공용 템플릿 임시 첨부 정리에 실패했습니다.');
        if (error instanceof AppError) throw error;
        throw unavailable();
      }
    });
  }
  return { upload, remove, loadDraft, sendStatus, draft, send, buildTemplateMime, templateAttachments, publicTemplateAttachments };
}
