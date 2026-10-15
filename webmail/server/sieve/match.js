import libmime from 'libmime';
import addressparser from 'nodemailer/lib/addressparser';
import { searchCompiler } from 'imapflow/lib/search-compiler.js';
import { AppError } from '../errors.js';
import { item as listItem } from '../mail/list.js';
import { encodeRef } from '../mail/ref.js';
import { asciiLower } from './model.js';

const sessions = new WeakMap();
export function invalidateInboxHeaders(session) {
  const entry = sessions.get(session);
  if (!entry) return;
  sessions.delete(session);
  entry.controller.abort();
  session.scanAbort?.signal.removeEventListener('abort', entry.stop);
}
const ttl = 5 * 60_000;
const limit = 20_000;
const batchSize = 2000;
const fields = ['from', 'to', 'cc', 'subject', 'content-type'];
const unavailable = () => new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
const atom = value => ({ type: 'ATOM', value });
function decodeWords(value) {
  try { return libmime.decodeWords(value); } catch { return value; }
}

// Keep each header occurrence separate. Parse addresses before decoding display
// names, whose encoded commas/angle brackets must never become address syntax.
function decodedHeaders(headers) {
  if (headers?.addresses) return headers;
  const raw = typeof headers === 'string' || Buffer.isBuffer(headers)
    ? libmime.decodeHeaders(headers.toString('utf8')) : headers;
  const result = Object.fromEntries(fields.map(field => [field, []]));
  result.addresses = { from: [], to: [], cc: [] };
  result.envelope = { from: [], to: [], cc: [] };
  for (const [key, values] of Object.entries(raw ?? {})) {
    const field = asciiLower(key);
    if (!fields.includes(field)) continue;
    for (const value of Array.isArray(values) ? values : [values]) {
      result[field].push(decodeWords(value));
      if (Object.hasOwn(result.addresses, field)) {
        const people = addressparser(value, { flatten: true }).filter(item => item.address);
        result.addresses[field].push(...people.map(item => item.address));
        result.envelope[field].push(...people.map(item => ({ ...item, name: decodeWords(item.name) })));
      }
    }
  }
  return result;
}

/** Evaluate the conditions of one validated rule (enabled/actions/stop are not
 * conditions). headers may be a raw header block, a name -> string[] map, or
 * the decoded headers bundle returned by loadInboxHeaders.
 */
export function matches(rule, headers) {
  const decoded = decodedHeaders(headers);
  const test = ({ field, op, value }) => {
    if (field === 'attachment') return decoded['content-type'].some(text => asciiLower(text).includes('multipart/mixed'));
    const names = field === 'to' ? ['to', 'cc'] : [field];
    const address = field !== 'subject' && ['eq', 'start'].includes(op);
    const values = names.flatMap(name => address ? decoded.addresses[name] : decoded[name]);
    const key = asciiLower(value);
    const found = values.some(text => {
      text = asciiLower(text);
      if (op === 'eq') return text === key;
      if (op === 'start') return text.startsWith(key);
      return text.includes(key);
    });
    return op === 'not' ? !found : found;
  };
  return rule.match === 'all' ? rule.conditions.every(test) : rule.conditions.some(test);
}

function yearBefore(time) {
  const date = new Date(time);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  if (date.getUTCMonth() !== month) date.setUTCDate(0); // Feb 29 -> Feb 28
  return date.getTime();
}
async function sortedCandidates(client, boundary) {
  const since = new Date(boundary - 86_400_000);
  const uids = [];
  const response = await client.exec('UID SORT', [
    [atom('REVERSE'), atom('ARRIVAL')], atom('UTF-8'), ...searchCompiler(client, { since }),
  ], { untagged: { SORT: row => {
    for (const token of row.attributes ?? []) uids.push(Number(token.value));
  } } });
  response.next();
  if (uids.some(uid => !Number.isInteger(uid) || uid < 1 || uid > 0xffffffff)) throw unavailable();
  return uids;
}

// One producer per session. Each command gets its own pool deadline/lock, so
// a cold mailbox taking over 60s in total does not lose all accumulated work.
function startScan(imap, session, now) {
  const entry = { controller: new AbortController(), value: { items: [], scanned: 0, limited: false, partial: true }, at: now() };
  entry.stop = () => invalidateInboxHeaders(session);
  sessions.set(session, entry);
  session.scanAbort?.signal.addEventListener('abort', entry.stop, { once: true });
  const check = () => {
    if (entry.controller.signal.aborted || session.scanAbort?.signal.aborted) throw new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
  };
  entry.controller.signal.addEventListener('abort', () => {
    entry.client?.close();
    entry.value.items.length = 0;
    entry.value.scanned = 0;
  }, { once: true });
  const command = operation => imap.withMailbox(session, 'INBOX', async client => {
    check();
    const validity = Number(client.mailbox.uidValidity);
    if (entry.validity !== undefined && entry.validity !== validity) throw new AppError(409, 'STALE_REF', '메일함이 바뀌었어요. 다시 확인해 주세요.');
    entry.validity = validity;
    entry.client = client;
    try { return await operation(client); }
    finally { entry.client = null; }
  });
  entry.done = (async () => {
    try {
      const boundary = yearBefore(now());
      const candidates = await command(client => sortedCandidates(client, boundary));
      const eligible = [];
      for (let start = 0; start < candidates.length && eligible.length <= limit; start += batchSize) {
        const batch = candidates.slice(start, start + batchSize);
        const dates = await command(async client => {
          const result = new Map();
          for await (const row of client.fetch(batch.join(','), { uid: true, internalDate: true }, { uid: true })) {
            check();
            const time = new Date(row.internalDate).getTime();
            if (!Number.isFinite(time)) throw unavailable();
            result.set(row.uid, time);
          }
          return result;
        });
        for (const uid of batch) {
          if (dates.has(uid) && dates.get(uid) >= boundary) eligible.push(uid);
          if (eligible.length > limit) break;
        }
      }
      entry.value.limited = eligible.length > limit;
      const selected = eligible.slice(0, limit);
      for (let start = 0; start < selected.length; start += batchSize) {
        const batch = selected.slice(start, start + batchSize);
        await command(async client => {
          for await (const row of client.fetch(batch.join(','), {
            uid: true, internalDate: true, flags: true, size: true, headers: fields,
          }, { uid: true })) {
            check();
            const headers = decodedHeaders(row.headers);
            // ENVELOPE repeats From/To/Subject already present in HEADER.FIELDS.
            // Derive the list row from those same decoded headers instead.
            const envelope = { ...headers.envelope, subject: headers.subject[0] ?? '' };
            const ref = encodeRef('INBOX', entry.validity, row.uid);
            entry.value.items.push({ uid: row.uid, ref, date: new Date(row.internalDate).toISOString(), headers,
              item: listItem({ ...row, envelope }, { path: 'INBOX', ref }) });
            entry.value.scanned++;
          }
        });
      }
      check();
      entry.value.items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.uid - a.uid);
      entry.value.partial = false;
      entry.at = now();
      return entry.value;
    } catch (error) {
      if (sessions.get(session) === entry) invalidateInboxHeaders(session);
      throw error;
    }
  })();
  // The initiating HTTP request may already have returned a partial result.
  // Keep the failure observed; a later request can start a fresh scan.
  entry.done.catch(() => {});
  return entry;
}

/** budgetMs bounds HTTP waiting, not the session's producer. Default callers
 * wait for completion; previews use 3500ms and apply uses 0ms. */
export async function loadInboxHeaders(imap, session, { now = Date.now, budgetMs = Infinity } = {}) {
  let entry = sessions.get(session);
  if (entry && !entry.value.partial && now() - entry.at >= ttl) { invalidateInboxHeaders(session); entry = null; }
  if (entry?.value.partial) return budgetMs === Infinity ? entry.done : entry.value;
  // Apply checks current UIDVALIDITY and existence under its own mailbox lock.
  if (entry && budgetMs === 0) return entry.value;
  let result;
  if (entry) {
    const cached = entry;
    result = imap.withMailbox(session, 'INBOX', client => {
      if (sessions.get(session) !== cached) {
        entry = sessions.get(session) ?? startScan(imap, session, now);
        return entry.value.partial ? null : entry.value;
      }
      if (Number(client.mailbox.uidValidity) === cached.validity) return cached.value;
      invalidateInboxHeaders(session);
      entry = startScan(imap, session, now);
      return null;
    }).then(value => value ?? entry.done);
  } else {
    entry = startScan(imap, session, now);
    result = entry.done;
  }
  if (budgetMs === Infinity) return result;
  let timer;
  try {
    return await Promise.race([result, new Promise(resolve => {
      timer = setTimeout(() => resolve({ ...entry.value, partial: true }), Math.max(0, budgetMs));
    })]);
  } finally { clearTimeout(timer); }
}

/** Recalculate entirely in memory when the rule changes. */
export function preview(rule, headers) {
  const found = headers.items.filter(record => matches(rule, record.headers));
  found.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.uid - a.uid);
  return { count: found.length, items: found.slice(0, 20).map(record => record.item), scanned: headers.scanned, limited: headers.limited, partial: headers.partial ?? false };
}
