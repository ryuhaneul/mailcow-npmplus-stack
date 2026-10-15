import { AppError } from '../errors.js';
import { senderAddress, senderKind, senderIdentities } from './sender.js';
import { recentRecipients as loadRecent } from './recent.js';

// These are exactly the columns granted to webmail_ro in plan 2-8.
export const directoryQueries = {
  mailbox: 'SELECT username, name, domain, active FROM mailbox',
  alias: 'SELECT address, goto, domain, sender_allowed, active FROM alias',
  alias_domain: 'SELECT alias_domain, target_domain, active FROM alias_domain',
  domain: 'SELECT domain, active FROM domain',
  sender_acl: 'SELECT logged_in_as, send_as FROM sender_acl',
};
const ttl = 10 * 60 * 1000;
const unavailable = () => new AppError(503, 'DIRECTORY_UNAVAILABLE', '주소 정보를 조회할 수 없어요.');
const active = value => ['1', '2'].includes(String(value));
const lower = value => String(value ?? '').toLowerCase();

export function contactOptions(query = {}) {
  const q = query.q;
  const limit = query.limit ?? '8';
  if (typeof q !== 'string' || !q.trim() || !q.isWellFormed() || /[\x00-\x1f\x7f]/.test(q)
    || typeof limit !== 'string' || !/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit))) throw new AppError(400, 'CONTACTS_QUERY_INVALID', '자동완성 검색어와 개수를 확인해 주세요.');
  return { q: lower(q.trim()), limit: Number(limit) };
}

export function createDirectoryService({ config, db, imap, now = Date.now, recentRecipients = session => loadRecent(imap, session) }) {
  let snapshot; let pending;
  const recent = new WeakMap();
  async function data() {
    if (snapshot && now() - snapshot.at < ttl) return snapshot.value;
    if (!pending) pending = (async () => {
      try {
        const rows = await Promise.all(Object.entries(directoryQueries).map(async ([table, sql]) => {
          const [values] = await db.execute(sql);
          if (!Array.isArray(values)) throw unavailable();
          return [table, values];
        }));
        snapshot = { at: now(), value: Object.fromEntries(rows) };
        return snapshot.value;
      } catch { throw unavailable(); }
      finally { pending = null; }
    })();
    return pending;
  }
  async function recentFor(session) {
    let entry = recent.get(session);
    if (!entry || now() - entry.at >= ttl) {
      entry = { at: now(), pending: Promise.resolve().then(() => recentRecipients(session)) };
      recent.set(session, entry);
      entry.pending.catch(() => { if (recent.get(session) === entry) recent.delete(session); });
    }
    return entry.pending;
  }
  async function identities(session) { return senderIdentities(await data(), session); }
  async function assertFrom(session, from) {
    if (!senderKind(await data(), session.email, from)) throw new AppError(403, 'FROM_NOT_ALLOWED', '이 주소로는 메일을 보낼 수 없어요.');
  }
  async function internalDomains() {
    if (config.internalDomains?.length) return [...new Set(config.internalDomains.map(lower))].sort();
    const rows = await data();
    return [...new Set([...rows.domain.filter(row => String(row.active) === '1').map(row => lower(row.domain)),
      ...rows.alias_domain.filter(row => String(row.active) === '1').map(row => lower(row.alias_domain))])].sort();
  }
  async function contacts(session, query) {
    if (config.contactsEnabled === false) return { items: [] };
    const { q, limit } = contactOptions(query);
    const domains = new Set([lower(session.email).split('@').at(-1), ...(config.internalDomains || []).map(lower)]);
    const inScope = address => domains.has(lower(address).split('@').at(-1));
    const [rows, history] = await Promise.all([data(), recentFor(session)]);
    const people = rows.mailbox.filter(row => active(row.active) && inScope(row.username)).map(row => ({ name: row.name || '', address: row.username, kind: 'person' }));
    const teams = rows.alias.filter(row => active(row.active) && !row.address.startsWith('@') && inScope(row.address)).map(row => ({ name: '', address: row.address, kind: 'team' }));
    const order = (a, b) => (a.name || a.address).localeCompare(b.name || b.address, 'ko') || a.address.localeCompare(b.address, 'en');
    const candidates = [...history.map(item => ({ name: item.name || '', address: item.address, kind: 'recent' })), ...people.sort(order), ...teams.sort(order)];
    const unique = new Map();
    for (const item of candidates) {
      const address = senderAddress(item.address);
      if (!address || unique.has(address)) continue;
      unique.set(address, { ...item, address });
    }
    return { items: [...unique.values()].filter(item => lower(item.name).includes(q) || item.address.includes(q)).slice(0, limit) };
  }
  return { identities, assertFrom, internalDomains, contacts, close: () => db.end() };
}
