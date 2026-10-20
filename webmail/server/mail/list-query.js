import { searchCompiler } from 'imapflow/lib/search-compiler.js';
import { AppError } from '../errors.js';
import { parseSearchQuery } from './search-query.js';
import { encodeRef, originalRefs, uidSet } from './ref.js';

export const allmail = 'WebmailVirtual/AllMail';
// Leave 10 seconds before the measured 60-second proxy limit.
const searchTimeout = 50000;
const slowSearch = () => new AppError(503, 'SEARCH_SLOW', '메일함 검색 색인을 만드는 중이에요. 잠시 뒤 다시 검색해 주세요.');
const atom = value => ({ type: 'ATOM', value });
const invalid = () => new AppError(400, 'LIST_QUERY_INVALID', '메일 목록 조회 조건을 확인해 주세요.');
const unavailable = () => new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
function number(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
  return Number(value);
}
export function scopeOptions(query = {}, folders = []) {
  for (const key of ['view', 'folder', 'quick', 'q', 'in']) if (query[key] !== undefined && (typeof query[key] !== 'string' || !query[key].isWellFormed() || /[\x00-\x1f\x7f]/.test(query[key]))) throw invalid();
  const view = query.view ?? 'inbox', quick = query.quick ?? 'all';
  if (!['inbox', 'allmail', 'folder', 'spam'].includes(view) || !['all', 'unread', 'starred', 'attach'].includes(quick)) throw invalid();
  if (view === 'folder' && !query.folder) throw invalid();
  const parsed = parseSearchQuery(query.q ?? '');
  const junk = folders.find(folder => folder.specialUse === '\\Junk')?.path ?? 'Junk';
  const trash = folders.find(folder => folder.specialUse === '\\Trash')?.path ?? 'Trash';
  const selected = view === 'spam' ? junk : view === 'folder' ? query.folder : 'INBOX';
  // K13: 스팸·휴지통에서의 검색은 그 폴더 안에 머문다.
  const scoped = [junk, trash].includes(selected) && (view === 'spam' || view === 'folder');
  const mailbox = !scoped && (view === 'allmail' || query.q?.trim()) ? allmail : selected;
  const filters = [...parsed.folderFilters, ...(query.in ? [query.in] : [])];
  const imap = [...parsed.imap];
  if (quick === 'unread') imap.push({ seen: false });
  if (quick === 'starred') imap.push({ flagged: true });
  if (quick === 'attach') imap.push({ header: { 'Content-Type': 'multipart/mixed' } });
  return { mailbox, filters, imap, searching: Boolean(query.q?.trim()) };
}
export function listOptions(query = {}, folders = []) {
  const { mailbox, filters, imap } = scopeOptions(query, folders);
  const page = number(query.page, 1), pageSize = number(query.pageSize, 50);
  if (!Number.isSafeInteger((page - 1) * pageSize)) throw invalid();
  return { mailbox, page, pageSize, filters, imap };
}
export function checkBudget(budget) {
  if (budget && budget.remainingMs() <= 0) {
    const error = unavailable();
    error.budgetExhausted = true;
    throw error;
  }
}
export async function resolveListScope(session, scope = {}, { imap, budget } = {}) {
  let options = scopeOptions(scope);
  checkBudget(budget);
  if (!options.filters.length && scope.view !== 'spam' && !(scope.view === 'folder' && scope.q?.trim())) return options;
  return imap.withMailbox(session, 'INBOX', async client => {
    if (scope.view === 'spam' || (scope.view === 'folder' && scope.q?.trim())) {
      checkBudget(budget);
      options = scopeOptions(scope, await client.list({ listOnly: true }));
    }
    return { ...options, filters: await resolveFilters(client, options.filters, { budget }) };
  }, { budget });
}
export const sortUids = (client, conditions, searching = false, options = {}) => queryUids(client, conditions, searching, options, true);
export const searchUids = (client, conditions, searching = false, options = {}) => queryUids(client, conditions, searching, options, false);
async function queryUids(client, conditions, searching, { budget }, sorted) {
  checkBudget(budget);
  let charset = false;
  const search = conditions.flatMap(condition => {
    const compiled = searchCompiler(client, condition);
    if (compiled[0]?.value === 'CHARSET') { charset = true; return compiled.slice(2); }
    return compiled;
  });
  if (!search.length) search.push(atom('ALL'));
  const uids = [];
  checkBudget(budget);
  const remaining = budget?.remainingMs() ?? Infinity;
  const timeout = Math.min(searching ? searchTimeout : Infinity, remaining);
  const responseType = sorted ? 'SORT' : 'SEARCH';
  const attributes = sorted ? [[atom('REVERSE'), atom('ARRIVAL')], atom('UTF-8'), ...search] : [...(charset ? [atom('CHARSET'), atom('UTF-8')] : []), ...search];
  const request = client.exec(`UID ${responseType}`, attributes, {
    untagged: { [responseType]: row => { for (const token of row.attributes ?? []) uids.push(Number(token.value)); } },
  });
  let timer;
  try {
    const response = await (Number.isFinite(timeout) ? Promise.race([request, new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        if (budget && timeout === remaining) {
          const error = unavailable(); error.budgetExhausted = true; reject(error);
        } else reject(slowSearch());
        // Drop this command connection; Dovecot's separate indexer can keep indexing.
        client.close();
      }, timeout);
    })]) : request);
    response.next();
  } finally { clearTimeout(timer); }
  if (uids.some(uid => !Number.isInteger(uid) || uid < 1 || uid > 0xffffffff)) throw unavailable();
  return uids;
}
export async function resolveFilters(client, filters, { budget } = {}) {
  if (!filters.length) return [];
  checkBudget(budget);
  const folders = await client.list({ listOnly: true });
  return filters.map(value => {
    const exact = folders.find(folder => folder.path === value);
    if (exact) return exact.path;
    const found = folders.filter(folder => folder.name === value);
    if (found.length > 1) throw new AppError(400, 'SEARCH_FOLDER_AMBIGUOUS', '같은 이름의 폴더가 있어요. 폴더 전체 경로를 입력해 주세요.');
    return found[0]?.path ?? value;
  });
}

export function matchesFolderFilters(path, filters) {
  return filters.every(filter => path === filter);
}
// The caller holds scope.mailbox's lock; this helper never nests a mailbox lock.
export async function resolveCandidateSources(client, session, uids, scope, { freshValidity = false, budget, now = Date.now } = {}) {
  if (!uids.length) return [];
  checkBudget(budget);
  let sources;
  if (scope.mailbox === allmail) {
    sources = await originalRefs(client, session, uidSet(uids), { freshValidity, budget, now });
    const candidates = new Set(uids);
    if (freshValidity && (sources.length !== uids.length || new Set(sources.map(source => source.virtualUid)).size !== uids.length || sources.some(source => !candidates.has(source.virtualUid)))) {
      throw new AppError(409, 'STALE_SCOPE', '메일함이 바뀌었어요. 다시 선택해 주세요.');
    }
  } else {
    const uidValidity = Number(client.mailbox.uidValidity);
    sources = uids.map(uid => ({ path: scope.mailbox, uid, uidValidity, ref: encodeRef(scope.mailbox, uidValidity, uid) }));
  }
  return sources.filter(source => matchesFolderFilters(source.path, scope.filters));
}
