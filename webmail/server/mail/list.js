import { AppError } from '../errors.js';
import { decodeRef, assertUidValidity } from './ref.js';
import { allmail, listOptions, resolveListScope, sortUids, resolveCandidateSources, matchesFolderFilters, checkBudget } from './list-query.js';
export { listOptions } from './list-query.js';

const unavailable = () => new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
function attachment(headers) {
  const text = Buffer.isBuffer(headers) ? headers.toString('utf8') : headers ?? '';
  return /^content-type:\s*multipart\/mixed(?:\s*;|\s*$)/im.test(text.replace(/\r?\n[ \t]+/g, ' '));
}
function address(value) { return { name: value?.name ?? '', address: value?.address ?? '' }; }
export function item(message, source) {
  const date = new Date(message.internalDate);
  if (!Number.isFinite(date.getTime())) throw unavailable();
  const envelope = message.envelope ?? {};
  return {
    ref: source.ref, folder: source.path, folderName: source.path.split('/').at(-1),
    from: address(envelope.from?.[0]), to: (envelope.to ?? []).map(address), subject: envelope.subject ?? '',
    date: date.toISOString(), size: message.size, seen: message.flags?.has('\\Seen') ?? false,
    flagged: message.flags?.has('\\Flagged') ?? false, answered: message.flags?.has('\\Answered') ?? false,
    hasAttachment: attachment(message.headers),
  };
}

async function fetchMetadata(client, uids, { budget } = {}) {
  const fetched = new Map();
  if (!uids.length) return fetched;
  checkBudget(budget);
  for await (const message of client.fetch(uids.join(','), { envelope: true, flags: true, internalDate: true, size: true, headers: ['CONTENT-TYPE'] }, { uid: true })) fetched.set(message.uid, message);
  return fetched;
}

export function createListService({ imap, now = Date.now }) {
  const sessions = new WeakMap();
  const invalidate = session => sessions.delete(session);
  async function messages(session, query = {}) {
    const { page, pageSize } = listOptions(query);
    let mailbox;
    try {
      const options = await resolveListScope(session, query, { imap });
      mailbox = options.mailbox;
      return await imap.withMailbox(session, mailbox, async client => {
        const key = JSON.stringify([mailbox, options.imap, options.filters]);
        let cache = sessions.get(session);
        if (!cache) { cache = new Map(); sessions.set(session, cache); }
        let result = cache.get(key);
        const validity = Number(client.mailbox.uidValidity);
        if (!result || now() - result.at >= 60000 || result.validity !== validity) {
          let uids = await sortUids(client, options.imap, options.searching);
          const originals = new Map();
          if (options.filters.length && mailbox === allmail) {
            for (let start = 0; start < uids.length; start += 1000) {
              const rows = await resolveCandidateSources(client, session, uids.slice(start, start + 1000), options, { now });
              for (const row of rows) originals.set(row.virtualUid, row);
            }
            uids = uids.filter(uid => originals.has(uid));
          } else if (!matchesFolderFilters(mailbox, options.filters)) uids = [];
          result = { at: now(), validity, uids, originals };
          for (const [oldKey, old] of cache) if (now() - old.at >= 60000) cache.delete(oldKey);
          cache.set(key, result);
        }
        const selected = result.uids.slice((page - 1) * pageSize, page * pageSize);
        if (!selected.length) return { total: result.uids.length, page, pageSize, items: [] };
        if (mailbox === allmail) {
          const missing = selected.filter(uid => !result.originals.has(uid));
          if (missing.length) for (const row of await resolveCandidateSources(client, session, missing, options, { now })) result.originals.set(row.virtualUid, row);
        }
        const fetched = await fetchMetadata(client, selected);
        const direct = mailbox === allmail ? null : new Map((await resolveCandidateSources(client, session, selected, options)).map(source => [source.uid, source]));
        const items = [];
        for (const uid of selected) {
          const message = fetched.get(uid);
          if (!message) continue; // 다른 IMAP 클라이언트가 그 사이 지운 메시지.
          const source = mailbox === allmail ? result.originals.get(uid) : direct.get(uid);
          if (!source) throw unavailable();
          items.push(item(message, source));
        }
        return { total: result.uids.length, page, pageSize, items };
      });
    } catch (error) {
      if (mailbox === allmail && (error.code === 'NotFound' || error.serverResponseCode === 'NONEXISTENT')) throw new AppError(503, 'ALLMAIL_UNAVAILABLE', '전체편지함을 사용할 수 없어요. 관리자에게 문의해 주세요.');
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  }
  async function metadata(session, refs, { budget } = {}) {
    const groups = new Map(), items = new Map();
    for (const token of refs) {
      const source = { ...decodeRef(token), ref: token };
      if (!groups.has(source.path)) groups.set(source.path, []);
      groups.get(source.path).push(source);
    }
    for (const [path, sources] of groups) {
      checkBudget(budget);
      try {
        await imap.withMailbox(session, path, async client => {
          for (const source of sources) assertUidValidity(client, source);
          const fetched = await fetchMetadata(client, sources.map(source => source.uid), { budget });
          for (const source of sources) {
            const message = fetched.get(source.uid);
            if (message) items.set(source.ref, item(message, source));
          }
        }, { budget });
      } catch (error) {
        if (error.code === 'NotFound' || error.serverResponseCode === 'NONEXISTENT') throw new AppError(409, 'STALE_REF', '메일함이 바뀌었어요. 화면을 새로 고쳐 주세요.');
        throw error;
      }
    }
    return refs.filter(ref => items.has(ref)).map(ref => items.get(ref));
  }
  return { messages, metadata, invalidate };
}
