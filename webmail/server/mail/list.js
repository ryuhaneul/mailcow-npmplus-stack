import { searchCompiler } from 'imapflow/lib/search-compiler.js';
import { AppError } from '../errors.js';
import { parseSearchQuery } from './search-query.js';
import { encodeRef, originalRefs } from './ref.js';

const allmail = 'WebmailVirtual/AllMail';
const atom = value => ({ type: 'ATOM', value });
const invalid = () => new AppError(400, 'LIST_QUERY_INVALID', '메일 목록 조회 조건을 확인해 주세요.');
const unavailable = () => new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
function number(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
  return Number(value);
}
export function listOptions(query = {}) {
  for (const key of ['view', 'folder', 'quick', 'q', 'in']) if (query[key] !== undefined && (typeof query[key] !== 'string' || !query[key].isWellFormed() || /[\x00-\x1f\x7f]/.test(query[key]))) throw invalid();
  const view = query.view ?? 'inbox', quick = query.quick ?? 'all';
  if (!['inbox', 'allmail', 'folder', 'spam'].includes(view) || !['all', 'unread', 'starred', 'attach'].includes(quick)) throw invalid();
  if (view === 'folder' && !query.folder) throw invalid();
  const parsed = parseSearchQuery(query.q ?? '');
  const page = number(query.page, 1), pageSize = number(query.pageSize, 50);
  if (!Number.isSafeInteger((page - 1) * pageSize)) throw invalid();
  const selected = view === 'spam' ? 'Junk' : view === 'folder' ? query.folder : 'INBOX';
  // K13: 스팸·휴지통에서의 검색은 그 폴더 안에 머문다.
  const scoped = ['Junk', 'Trash'].includes(selected) && (view === 'spam' || view === 'folder');
  const mailbox = !scoped && (view === 'allmail' || query.q?.trim()) ? allmail : selected;
  const filters = [...parsed.folderFilters, ...(query.in ? [query.in] : [])];
  const imap = [...parsed.imap];
  if (quick === 'unread') imap.push({ seen: false });
  if (quick === 'starred') imap.push({ flagged: true });
  if (quick === 'attach') imap.push({ header: { 'Content-Type': 'multipart/mixed' } });
  return { mailbox, page, pageSize, filters, imap };
}
async function sortUids(client, conditions) {
  const search = conditions.flatMap(condition => {
    const compiled = searchCompiler(client, condition);
    return compiled[0]?.value === 'CHARSET' ? compiled.slice(2) : compiled;
  });
  if (!search.length) search.push(atom('ALL'));
  const uids = [];
  const response = await client.exec('UID SORT', [[atom('REVERSE'), atom('ARRIVAL')], atom('UTF-8'), ...search], {
    untagged: { SORT: row => { for (const token of row.attributes ?? []) uids.push(Number(token.value)); } },
  });
  response.next();
  if (uids.some(uid => !Number.isInteger(uid) || uid < 1 || uid > 0xffffffff)) throw unavailable();
  return uids;
}
async function resolveFilters(client, filters) {
  if (!filters.length) return [];
  const folders = await client.list({ listOnly: true });
  return filters.map(value => {
    const exact = folders.find(folder => folder.path === value);
    if (exact) return exact.path;
    const found = folders.filter(folder => folder.name === value);
    if (found.length > 1) throw new AppError(400, 'SEARCH_FOLDER_AMBIGUOUS', '같은 이름의 폴더가 있어요. 폴더 전체 경로를 입력해 주세요.');
    return found[0]?.path ?? value;
  });
}
function attachment(headers) {
  const text = Buffer.isBuffer(headers) ? headers.toString('utf8') : headers ?? '';
  return /^content-type:\s*multipart\/mixed(?:\s*;|\s*$)/im.test(text.replace(/\r?\n[ \t]+/g, ' '));
}
function address(value) { return { name: value?.name ?? '', address: value?.address ?? '' }; }
function item(message, source) {
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

export function createListService({ imap, now = Date.now }) {
  const sessions = new WeakMap();
  async function messages(session, query) {
    const options = listOptions(query);
    const { mailbox, page, pageSize } = options;
    try {
      return await imap.withMailbox(session, mailbox, async client => {
        const key = JSON.stringify([mailbox, options.imap, options.filters]);
        let cache = sessions.get(session);
        if (!cache) { cache = new Map(); sessions.set(session, cache); }
        let result = cache.get(key);
        const validity = Number(client.mailbox.uidValidity);
        if (!result || now() - result.at >= 60000 || result.validity !== validity) {
          const filters = await resolveFilters(client, options.filters);
          let uids = await sortUids(client, options.imap);
          const originals = new Map();
          if (filters.length && mailbox === allmail) {
            for (let start = 0; start < uids.length; start += 1000) {
              const rows = await originalRefs(client, session, uids.slice(start, start + 1000).join(','), { now });
              for (const row of rows) originals.set(row.virtualUid, row);
            }
            uids = uids.filter(uid => filters.every(path => originals.get(uid)?.path === path));
          } else if (filters.some(path => path !== mailbox)) uids = [];
          result = { at: now(), validity, uids, originals };
          for (const [oldKey, old] of cache) if (now() - old.at >= 60000) cache.delete(oldKey);
          cache.set(key, result);
        }
        const selected = result.uids.slice((page - 1) * pageSize, page * pageSize);
        if (!selected.length) return { total: result.uids.length, page, pageSize, items: [] };
        if (mailbox === allmail) {
          const missing = selected.filter(uid => !result.originals.has(uid));
          if (missing.length) for (const row of await originalRefs(client, session, missing.join(','), { now })) result.originals.set(row.virtualUid, row);
        }
        const fetched = new Map();
        for await (const message of client.fetch(selected.join(','), { envelope: true, flags: true, internalDate: true, size: true, headers: ['CONTENT-TYPE'] }, { uid: true })) fetched.set(message.uid, message);
        const items = [];
        for (const uid of selected) {
          const message = fetched.get(uid);
          if (!message) continue; // 다른 IMAP 클라이언트가 그 사이 지운 메시지.
          const source = mailbox === allmail ? result.originals.get(uid) : { path: mailbox, ref: encodeRef(mailbox, validity, uid) };
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
  return { messages };
}
