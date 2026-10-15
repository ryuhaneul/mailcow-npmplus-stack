import libmime from 'libmime';
import addressparser from 'nodemailer/lib/addressparser';
import { searchCompiler } from 'imapflow/lib/search-compiler.js';
import { AppError } from '../errors.js';
import { item as listItem } from '../mail/list.js';
import { encodeRef } from '../mail/ref.js';
import { asciiLower } from './model.js';

const sessions = new WeakMap();
export function invalidateInboxHeaders(session) { sessions.delete(session); }
const ttl = 5 * 60_000;
const limit = 20_000;
const batchSize = 1000;
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
  for (const [key, values] of Object.entries(raw ?? {})) {
    const field = asciiLower(key);
    if (!fields.includes(field)) continue;
    for (const value of Array.isArray(values) ? values : [values]) {
      result[field].push(decodeWords(value));
      if (Object.hasOwn(result.addresses, field)) {
        result.addresses[field].push(...addressparser(value, { flatten: true }).filter(item => item.address).map(item => item.address));
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

/** Snapshot: {items:[{uid,ref,date,headers,item}], scanned, limited}.
 * headers contains decoded string arrays plus address-only arrays in addresses.
 * item is the existing mail list row. All FETCHes use UIDs and BODY.PEEK via
 * imapflow; the pool owns INBOX locking, command deadlines and authentication.
 */
export async function loadInboxHeaders(imap, session, { now = Date.now } = {}) {
  return imap.withMailbox(session, 'INBOX', async client => {
    const validity = Number(client.mailbox.uidValidity);
    const cached = sessions.get(session);
    if (cached && now() - cached.at < ttl && cached.validity === validity) return cached.value;
    sessions.delete(session);
    const boundary = yearBefore(now());
    const candidates = await sortedCandidates(client, boundary);
    const eligible = [];
    // SINCE is only a day-granularity prefilter. INTERNALDATE decides the exact
    // inclusive UTC boundary; one extra eligible UID detects truncation.
    for (let start = 0; start < candidates.length && eligible.length <= limit; start += batchSize) {
      const batch = candidates.slice(start, start + batchSize);
      const dates = new Map();
      for await (const row of client.fetch(batch.join(','), { uid: true, internalDate: true }, { uid: true })) {
        const time = new Date(row.internalDate).getTime();
        if (!Number.isFinite(time)) throw unavailable();
        dates.set(row.uid, time);
      }
      for (const uid of batch) {
        if (dates.has(uid) && dates.get(uid) >= boundary) eligible.push(uid);
        if (eligible.length > limit) break;
      }
    }
    const selected = eligible.slice(0, limit);
    const fetched = new Map();
    for (let start = 0; start < selected.length; start += batchSize) {
      const batch = selected.slice(start, start + batchSize);
      for await (const row of client.fetch(batch.join(','), {
        uid: true, internalDate: true, envelope: true, flags: true, size: true, headers: fields,
      }, { uid: true })) {
        const ref = encodeRef('INBOX', validity, row.uid);
        fetched.set(row.uid, {
          uid: row.uid, ref, date: new Date(row.internalDate).toISOString(),
          headers: decodedHeaders(row.headers), item: listItem(row, { path: 'INBOX', ref }),
        });
      }
    }
    // A message can disappear between the two FETCH passes.
    const items = selected.filter(uid => fetched.has(uid)).map(uid => fetched.get(uid));
    const value = { items, scanned: items.length, limited: eligible.length > limit };
    sessions.set(session, { at: now(), validity, value });
    return value;
  });
}

/** Recalculate entirely in memory when the rule changes. */
export function preview(rule, headers) {
  const found = headers.items.filter(record => matches(rule, record.headers));
  found.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.uid - a.uid);
  return { count: found.length, items: found.slice(0, 20).map(record => record.item), scanned: headers.scanned, limited: headers.limited };
}
