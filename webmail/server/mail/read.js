import iconv from 'iconv-lite';
import libmime from 'libmime';
import { AppError } from '../errors.js';
import { mailboxRights } from './folders.js';
import { sanitizeHtml } from './sanitize.js';

// RFC 1557: designated KS X 1001 pairs in SO/SI runs become EUC-KR pairs.
export function decodeIso2022Kr(bytes) {
  let designated = false, shifted = false, pending = null, text = '';
  const invalid = () => { text += '\ufffd'; pending = null; };
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x1b) {
      if (pending !== null) invalid();
      if (bytes[i + 1] === 0x24 && bytes[i + 2] === 0x29 && bytes[i + 3] === 0x43) { designated = true; i += 3; }
      else { invalid(); shifted = false; }
    } else if (byte === 0x0e || byte === 0x0f) {
      if (pending !== null) invalid();
      shifted = byte === 0x0e && designated;
      if (byte === 0x0e && !designated) invalid();
    } else if (byte === 0x0a || byte === 0x0d) {
      if (pending !== null) invalid(); shifted = false; text += String.fromCharCode(byte);
    } else if (shifted) {
      if (byte < 0x21 || byte > 0x7e) { invalid(); continue; }
      if (pending === null) pending = byte;
      else { text += iconv.decode(Buffer.from([pending + 0x80, byte + 0x80]), 'euc-kr'); pending = null; }
    } else if (byte < 0x80) text += String.fromCharCode(byte);
    else invalid();
  }
  if (pending !== null) invalid();
  return text;
}
export function decodeCharset(bytes, charset = 'utf-8') {
  charset = charset.toLowerCase().trim();
  if (/^iso-?2022-?kr$/.test(charset)) return decodeIso2022Kr(bytes);
  if (['euc-kr', 'ks_c_5601-1987', 'ks_c_5601-1989', 'windows-949'].includes(charset)) charset = 'cp949';
  return iconv.decode(bytes, iconv.encodingExists(charset) ? charset : 'utf-8');
}
export function decodeWords(value = '') {
  // libmime handles the other charsets; its ISO-2022-KR decoder is unavailable.
  value = String(value).replace(/(=\?iso-?2022-?kr\?[bq]\?[^?]*\?=)\s+(?==\?iso-?2022-?kr\?)/gi, '$1');
  value = value.replace(/=\?(iso-?2022-?kr)\?([bq])\?([^?]*)\?=/gi, (_, charset, mode, content) => {
    const bytes = mode.toLowerCase() === 'b' ? Buffer.from(content, 'base64') : Buffer.from(content.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
    return decodeCharset(bytes, charset);
  });
  try { return libmime.decodeWords(value); } catch { return value; }
}
export function bodyParts(structure) {
  const result = [];
  function walk(node, nestedAttachment = false) {
    if (!node) return;
    const attachment = nestedAttachment || node.disposition === 'attachment' || Boolean(node.dispositionParameters?.filename || node.parameters?.name);
    if (node.childNodes?.length && !attachment && node.type !== 'message/rfc822') for (const child of node.childNodes) walk(child);
    else result.push({ ...node, part: node.part || '1', attachment });
  }
  walk(structure); return result;
}
const missing = () => new AppError(404, 'MESSAGE_NOT_FOUND', '메일을 찾을 수 없어요.');
const badQuery = () => new AppError(400, 'BAD_REQUEST', '요청을 확인해 주세요.');
function toggle(value) { if (value !== undefined && value !== '0' && value !== '1') throw badQuery(); return value === '1'; }
async function message(client, uid) {
  const row = await client.fetchOne(uid, { envelope: true, bodyStructure: true, flags: true, headers: ['REFERENCES', 'IN-REPLY-TO'] }, { uid: true });
  if (!row) throw missing(); return row;
}
const inlineTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
export function attachmentHeaders(part, inline) {
  const contentType = String(part.type || 'application/octet-stream').toLowerCase();
  const filename = decodeWords(part.dispositionParameters?.filename || part.parameters?.name || `attachment-${part.part}`).replace(/[\x00-\x1f\x7f\\/]/g, '_');
  const fallback = filename.replace(/[^\x20-\x7e]|["\\;]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const disposition = inline && inlineTypes.has(contentType) ? 'inline' : 'attachment';
  return { 'content-type': /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType) ? contentType : 'application/octet-stream', 'content-disposition': `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`, 'x-content-type-options': 'nosniff', ...(disposition === 'inline' && contentType === 'application/pdf' ? { 'content-security-policy': 'sandbox' } : {}) };
}
export function createReadService({ imap, config = {} }) {
  const maxBodyBytes = (config.bodyMaxMb ?? 5) * 1024 * 1024;
  const oversizedBody = '본문이 너무 커서 표시하지 않았어요';
  async function read(session, token, query = {}) {
    const images = toggle(query.images);
    return imap.withRef(session, token, async (client, ref) => {
      const row = await message(client, ref.uid); const parts = bodyParts(row.bodyStructure);
      const body = parts.find(part => !part.attachment && part.type === 'text/html') || parts.find(part => !part.attachment && part.type === 'text/plain');
      const envelope = row.envelope || {};
      const addresses = list => (list || []).map(item => ({ ...item, name: decodeWords(item.name) }));
      const sender = envelope.from?.[0]?.address?.toLowerCase();
      const senderAlwaysShow = Boolean(sender && session.prefs?.imageAllow?.some(address => address.toLowerCase() === sender));
      const cidParts = new Map(parts.filter(part => part.id && inlineTypes.has(part.type)).map(part => [part.id.trim().replace(/^<|>$/g, ''), part.part]));
      const attachments = parts.filter(part => part !== body && (part.attachment || !['text/html', 'text/plain'].includes(part.type))).map(part => ({ partId: part.part, filename: decodeWords(part.dispositionParameters?.filename || part.parameters?.name || `attachment-${part.part}`), size: part.size || 0, contentType: part.type, inline: part.disposition === 'inline' && inlineTypes.has(part.type) }));
      const headers = libmime.decodeHeaders(row.headers?.toString('latin1') || '');
      const result = { ref: token, folder: ref.path, subject: decodeWords(envelope.subject), from: addresses(envelope.from), to: addresses(envelope.to), cc: addresses(envelope.cc), replyTo: addresses(envelope.replyTo), date: envelope.date ? new Date(envelope.date).toISOString() : null, messageId: envelope.messageId || null, inReplyTo: envelope.inReplyTo || headers['in-reply-to']?.[0] || null, references: headers.references?.join(' ') || '', attachments, blockedImages: 0, senderAlwaysShow, seen: row.flags?.has('\\Seen') || false, flagged: row.flags?.has('\\Flagged') || false, spam: ref.path === 'Junk' };
      if (body && body.size > maxBodyBytes) result.text = oversizedBody;
      else if (body) {
        // Bound the decoder too: some charset/flowed decoders buffer before emitting.
        const download = await client.download(ref.uid, body.part, { uid: true, binary: true, maxBytes: maxBodyBytes + 1 });
        if (!download.content) throw missing();
        const chunks = []; let bytes = 0, oversized = false;
        for await (const chunk of download.content) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxBodyBytes) { oversized = true; download.content.destroy(); break; }
          chunks.push(Buffer.from(chunk));
        }
        if (oversized) result.text = oversizedBody;
        else {
          const text = decodeCharset(Buffer.concat(chunks), download.meta?.charset || body.parameters?.charset || 'utf-8');
          if (body.type === 'text/html') Object.assign(result, sanitizeHtml(text, { ref: token, cidParts, images: images || senderAlwaysShow }));
          else result.text = text;
        }
      } else result.text = '';
      if (!result.seen && (await mailboxRights(client, ref.path)).seen) {
        await client.messageFlagsAdd(ref.uid, ['\\Seen'], { uid: true }); result.seen = true;
      }
      return result;
    });
  }
  async function part(session, token, partId, query, consume) {
    const inline = toggle(query?.inline);
    if (typeof partId !== 'string' || !/^\d+(?:\.\d+)*$/.test(partId)) throw badQuery();
    return imap.withRef(session, token, async (client, ref) => {
      const row = await message(client, ref.uid);
      const part = bodyParts(row.bodyStructure).find(part => part.part === partId);
      if (!part) throw missing();
      const download = await client.download(ref.uid, partId, { uid: true, binary: true });
      if (!download.content) throw missing();
      // The consumer resolves only after HTTP consumption, keeping the mailbox lock held.
      return consume(download.content, attachmentHeaders(part, inline));
    });
  }
  return { read, part };
}
