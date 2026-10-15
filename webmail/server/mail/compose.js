import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import MailComposer from 'nodemailer/lib/mail-composer';
import { AppError } from '../errors.js';
import { encodeRef, decodeRef } from './ref.js';
import { bodyParts, attachmentHeaders } from './read.js';
import { sanitizeComposeHtml } from './sanitize.js';

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
function validate(body, sending, publicHostnames) {
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
  if (body.attachmentIds !== undefined && (!Array.isArray(body.attachmentIds) || body.attachmentIds.some(value => typeof value !== 'string'))) throw invalid();
  if (body.forwardParts !== undefined && (!Array.isArray(body.forwardParts) || body.forwardParts.some(part => !part || typeof part.partId !== 'string' || !/^\d+(?:\.\d+)*$/.test(part.partId)))) throw invalid();
  for (const part of body.forwardParts || []) decodeRef(part.ref);
  for (const key of ['draftRef', 'replyToRef']) if (body[key] !== undefined) decodeRef(body[key]);
  return { ...result, subject: body.subject ?? '', html: sanitizeComposeHtml(body.html ?? '', { publicHostnames }), inReplyTo: body.inReplyTo, references: body.references };
}

export function createComposeService({ config, imap, directory, smtp, logger, tempRoot = '/tmp/webmail' }) {
  const states = new WeakMap();
  const maxBytes = config.attachMaxMb * 1024 * 1024;
  function stateFor(session) {
    let state = states.get(session);
    if (!state) { state = { attachments: new Map(), tail: Promise.resolve() }; states.set(session, state); }
    return state;
  }
  function active(session) {
    if (!session.connection) throw new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
  }
  function serial(session, operation) {
    const state = stateFor(session);
    const task = state.tail.then(() => { active(session); return operation(state); });
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
  async function upload(session, parts) {
    return serial(session, async state => {
      let file, path;
      try {
        const dir = await directoryFor(session);
        const existing = [...state.attachments.values()].reduce((sum, item) => sum + item.size, 0);
        for await (const part of parts) {
          if (file || part.type !== 'file' || part.fieldname !== 'file') throw invalid();
          file = { id: id(), filename: String(part.filename || 'attachment').replace(/[\x00-\x1f\x7f\\/]/g, '_'), size: 0, contentType: part.mimetype || 'application/octet-stream' };
          path = join(dir, file.id);
          await pipeline(part.file, limiter(bytes => { file.size += bytes; if (existing + file.size > maxBytes) throw tooLarge(); }), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
          if (part.file.truncated) throw tooLarge();
        }
        if (!file) throw invalid();
        active(session);
        state.attachments.set(file.id, file);
        return file;
      } catch (error) {
        if (path) await rm(path, { force: true });
        if (!session.connection) await rm(sessionDir(session), { force: true, recursive: true });
        if (error.code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
        throw error;
      }
    });
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
    await imap.withRef(session, token, async (client, ref) => {
      if (!await client.fetchOne(ref.uid, { uid: true }, { uid: true })) throw new AppError(404, 'MESSAGE_NOT_FOUND', '메일을 찾을 수 없어요.');
    });
  }
  async function deleteDraft(session, token) {
    if (!token) return;
    return imap.withRef(session, token, async (client, ref) => {
      if (!await client.messageDelete(ref.uid, { uid: true })) throw unavailable();
    });
  }
  async function build(session, state, body, mail) {
    const temporary = [], streams = [];
    try {
      let total = 0;
      const attachments = [];
      for (const attachmentId of new Set(body.attachmentIds || [])) {
        const file = state.attachments.get(attachmentId);
        if (!file) throw notFound();
        const path = join(sessionDir(session), attachmentId);
        try { total += (await stat(path)).size; } catch (error) { if (error.code === 'ENOENT') throw notFound(); throw error; }
        if (total > maxBytes) throw tooLarge();
        attachments.push({ filename: file.filename, contentType: file.contentType, path });
      }
      for (const part of body.forwardParts || []) {
        const dir = await directoryFor(session);
        const path = join(dir, id()); temporary.push(path);
        const metadata = await imap.withRef(session, part.ref, async (client, ref) => {
          const row = await client.fetchOne(ref.uid, { bodyStructure: true }, { uid: true });
          const node = bodyParts(row?.bodyStructure).find(node => node.part === part.partId);
          if (!node) throw notFound();
          const download = await client.download(ref.uid, part.partId, { uid: true, binary: true });
          if (!download.content) throw notFound();
          await pipeline(download.content, limiter(bytes => { total += bytes; if (total > maxBytes) throw tooLarge(); }), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
          const headers = attachmentHeaders(node, false);
          const encoded = /filename\*=UTF-8''([^;]*)/.exec(headers['content-disposition']);
          return { filename: decodeURIComponent(encoded[1]), contentType: headers['content-type'] };
        });
        attachments.push({ ...metadata, path });
      }
      active(session);
      // Explicit streams prevent nodemailer from treating user content as a URL/path.
      const compiled = new MailComposer({ ...mail, attachments: attachments.map(file => {
        const content = createReadStream(file.path); streams.push(content);
        return { filename: file.filename, contentType: file.contentType, content };
      }), disableFileAccess: true, disableUrlAccess: true }).compile();
      compiled.keepBcc = true;
      return await compiled.build();
    } finally {
      for (const stream of streams) stream.destroy();
      await Promise.all(temporary.map(path => rm(path, { force: true })));
      if (!session.connection) await rm(sessionDir(session), { recursive: true, force: true });
    }
  }
  async function write(session, body, sending) {
    return serial(session, async state => {
      const mail = validate(body, sending, config.publicHostnames);
      await directory.assertFrom(session, mail.from);
      const { identities } = await directory.identities(session);
      const name = identities.find(item => item.address === mail.from)?.name || identities.find(item => item.kind === 'self')?.name || '';
      mail.from = { address: mail.from, name };
      const draftsPath = body.draftRef ? await specialFolder(session, 'Drafts') : null;
      if (body.draftRef) await checkMessage(session, body.draftRef, draftsPath);
      if (sending && body.replyToRef) await checkMessage(session, body.replyToRef);
      const raw = await build(session, state, body, mail);
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
        const warnings = [];
        async function afterSend(code, operation) {
          try { await operation(); } catch {
            warnings.push(code);
            logger?.error({ code, email: session.email }, '발송된 메일의 후처리에 실패했습니다.');
          }
        }
        try {
          await afterSend('SENT_COPY_FAILED', async () => {
            const path = await specialFolder(session, 'Sent');
            if (!await imap.withMailbox(session, path, client => client.append(path, raw, ['\\Seen']))) throw unavailable();
          });
          if (body.draftRef) await afterSend('DRAFT_DELETE_FAILED', () => deleteDraft(session, body.draftRef));
          if (body.replyToRef) await afterSend('ANSWERED_FAILED', () => imap.withRef(session, body.replyToRef, async (client, ref) => {
            if (!await client.messageFlagsAdd(ref.uid, ['\\Answered'], { uid: true })) throw unavailable();
          }));
        } finally { await cleanup(); }
        return { ok: true, ...(result?.rejected?.length ? { rejected: result.rejected } : {}), ...(warnings.length ? { warnings } : {}) };
      }
      const path = await specialFolder(session, 'Drafts');
      const appended = await imap.withMailbox(session, path, client => client.append(path, raw, ['\\Draft', '\\Seen']));
      if (!appended?.uid || !appended.uidValidity) throw unavailable();
      await deleteDraft(session, body.draftRef);
      await cleanup();
      return { draftRef: encodeRef(path, appended.uidValidity, appended.uid) };
    }).catch(error => { if (error instanceof AppError) throw error; throw unavailable(); });
  }
  return { upload, remove, draft: (session, body) => write(session, body, false), send: (session, body) => write(session, body, true) };
}
