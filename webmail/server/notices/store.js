import { createPool } from 'mysql2/promise';
import { AppError } from '../errors.js';
import { sanitizeNotice } from './sanitize.js';

const schema = 'mailstack_webmail';
const unavailable = () => new AppError(503, 'NOTICES_UNAVAILABLE', '공지 저장소 준비 안 됨');
const missing = () => new AppError(404, 'NOT_FOUND', '공지를 찾을 수 없어요.');
const conflict = () => new AppError(409, 'CONFLICT', '다른 변경이 있어요. 공지를 다시 불러와 주세요.');
const storageErrors = new Set(['ER_BAD_DB_ERROR', 'ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_ERROR', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST']);
const timestamp = value => value == null ? null : value instanceof Date ? value.toISOString() : String(value).replace(' ', 'T').replace(/Z?$/, 'Z');
const number = value => Number(value);
const userNotice = (row, watermark) => ({ id: number(row.id), seq: number(row.publish_seq), title: row.title, category: row.category,
  pinned: Boolean(number(row.pinned)), publishedAt: timestamp(row.published_at), bodyHtml: sanitizeNotice(row.body_html).bodyHtml,
  unread: number(row.publish_seq) > watermark });
const adminNotice = (row, domains, detail = true) => ({ id: number(row.id), title: row.title, category: row.category,
  pinned: Boolean(number(row.pinned)), state: row.state, audienceAll: Boolean(number(row.audience_all)), domains,
  publishedAt: timestamp(row.published_at), updatedAt: timestamp(row.updated_at),
  ...(detail ? { bodyHtml: sanitizeNotice(row.body_html).bodyHtml, seq: row.publish_seq == null ? null : number(row.publish_seq) } : {}) });
const visible = "n.state = 'published' AND (n.audience_all = 1 OR EXISTS (SELECT 1 FROM mailstack_webmail.notice_domains d WHERE d.notice_id = n.id AND d.domain = ?))";

export function createNoticesStore({ config = {}, db, mode = 'webmail' } = {}) {
  db ??= config.dbHost && config.dbUser && config.dbPassword ? createPool({
    host: config.dbHost, database: config.dbName, user: config.dbUser, password: config.dbPassword,
    connectionLimit: 2, connectTimeout: 10000, timezone: 'Z', dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true,
  }) : null;
  async function run(operation) {
    if (!db) throw unavailable();
    try { return await operation(); }
    catch (error) { if (storageErrors.has(error.code)) throw unavailable(); throw error; }
  }
  async function transaction(operation) {
    return run(async () => {
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const value = await operation(connection);
        await connection.commit();
        return value;
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    });
  }
  async function ready() {
    if (!db) return false;
    try {
      await run(async () => {
        await db.execute(`SELECT id,title,body_html,category,audience_all,pinned,state,publish_seq,published_at,created_at,updated_at,updated_by FROM ${schema}.notices LIMIT 0`);
        await db.execute(`SELECT notice_id,domain FROM ${schema}.notice_domains LIMIT 0`);
        if (mode === 'admin') {
          const [counter] = await db.execute(`SELECT id,next_seq FROM ${schema}.notice_counter WHERE id = 1`);
          if (counter.length !== 1 || number(counter[0].next_seq) < 0) throw unavailable();
        } else await db.execute(`SELECT email,last_seen_seq,updated_at FROM ${schema}.notice_reads LIMIT 0`);
        // SHOW GRANTS contains authentication material; inspect it locally only.
        const [grants] = await db.query('SHOW GRANTS FOR CURRENT_USER()');
        const text = grants.flatMap(row => Object.values(row)).join('\n').replace(/`/g, '');
        const required = mode === 'admin'
          ? { notices: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], notice_domains: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], notice_counter: ['SELECT', 'UPDATE'] }
          : { notices: ['SELECT'], notice_domains: ['SELECT'], notice_reads: ['SELECT', 'INSERT', 'UPDATE'] };
        for (const [table, permissions] of Object.entries(required)) {
          const held = new Set();
          for (const line of text.split('\n')) {
            const match = /^GRANT (.*?) ON (.*?) TO /.exec(line);
            if (match && [schema + '.' + table, schema + '.*', '*.*'].includes(match[2])) {
              for (const privilege of match[1].split(',').map(item => item.trim())) held.add(privilege);
            }
          }
          if (!held.has('ALL PRIVILEGES') && permissions.some(permission => !held.has(permission))) throw unavailable();
        }
      });
      return true;
    } catch (error) { if (error.code === 'NOTICES_UNAVAILABLE') return false; throw error; }
  }
  async function userContext(connection, email) {
    const normalized = email.toLowerCase(), domain = normalized.slice(normalized.lastIndexOf('@') + 1);
    const [[read]] = await connection.execute(`SELECT last_seen_seq FROM ${schema}.notice_reads WHERE email = ?`, [normalized]);
    const watermark = number(read?.last_seen_seq ?? 0);
    const [[counts]] = await connection.execute(`SELECT COUNT(*) AS unread_count FROM ${schema}.notices n WHERE ${visible} AND n.publish_seq > ?`, [domain, watermark]);
    return { email: normalized, domain, watermark, unreadCount: number(counts.unread_count) };
  }
  async function unread(email) {
    if (!await ready()) return { enabled: false, unreadCount: 0 };
    return transaction(async connection => ({ enabled: true, unreadCount: (await userContext(connection, email)).unreadCount }));
  }
  async function list(email, { scope = 'recent', before } = {}) {
    if (!await ready()) return scope === 'all' ? { items: [], nextBefore: null } : { enabled: false, unreadCount: 0, maxSeq: 0, pinned: [], items: [] };
    return transaction(async connection => {
      const context = await userContext(connection, email);
      if (scope === 'all') {
        const [rows] = await connection.execute(`SELECT n.* FROM ${schema}.notices n WHERE ${visible}${before === undefined ? '' : ' AND n.publish_seq < ?'} ORDER BY n.publish_seq DESC LIMIT 51`, before === undefined ? [context.domain] : [context.domain, before]);
        const items = rows.slice(0, 50).map(row => userNotice(row, context.watermark));
        return { items, nextBefore: rows.length > 50 ? items.at(-1).seq : null };
      }
      const [pinned] = await connection.execute(`SELECT n.* FROM ${schema}.notices n WHERE ${visible} AND n.pinned = 1 ORDER BY n.publish_seq DESC`, [context.domain]);
      const [rows] = await connection.execute(`SELECT n.* FROM ${schema}.notices n WHERE ${visible} AND n.pinned = 0 ORDER BY n.publish_seq DESC LIMIT 5`, [context.domain]);
      const map = row => userNotice(row, context.watermark);
      return { enabled: true, unreadCount: context.unreadCount, maxSeq: Math.max(0, ...pinned.map(row => number(row.publish_seq)), ...rows.map(row => number(row.publish_seq))), pinned: pinned.map(map), items: rows.map(map) };
    });
  }
  async function seen(email, upTo) {
    if (!await ready()) throw unavailable();
    return transaction(async connection => {
      const normalized = email.toLowerCase(), domain = normalized.slice(normalized.lastIndexOf('@') + 1);
      const [[row]] = await connection.execute(`SELECT COALESCE(MAX(n.publish_seq), 0) AS max_seq FROM ${schema}.notices n WHERE ${visible}`, [domain]);
      const capped = Math.min(upTo, number(row.max_seq));
      await connection.execute(`INSERT INTO ${schema}.notice_reads (email,last_seen_seq) VALUES (?,?) ON DUPLICATE KEY UPDATE last_seen_seq = GREATEST(last_seen_seq, VALUES(last_seen_seq)), updated_at = CURRENT_TIMESTAMP`, [normalized, capped]);
      // A locking read sees a concurrent committed watermark even with a prior snapshot.
      const [[read]] = await connection.execute(`SELECT last_seen_seq FROM ${schema}.notice_reads WHERE email = ? FOR UPDATE`, [normalized]);
      const [[counts]] = await connection.execute(`SELECT COUNT(*) AS unread_count FROM ${schema}.notices n WHERE ${visible} AND n.publish_seq > ?`, [domain, number(read.last_seen_seq)]);
      return { unreadCount: number(counts.unread_count) };
    });
  }
  async function domainsFor(connection, id) {
    const [rows] = await connection.execute(`SELECT domain FROM ${schema}.notice_domains WHERE notice_id = ? ORDER BY domain`, [id]);
    return rows.map(row => row.domain);
  }
  async function adminList(state = 'all') {
    if (!await ready()) return { enabled: false, items: [] };
    return transaction(async connection => {
      const [rows] = await connection.execute(`SELECT * FROM ${schema}.notices${state === 'all' ? '' : ' WHERE state = ?'} ORDER BY id DESC`, state === 'all' ? [] : [state]);
      const items = [];
      for (const row of rows) items.push(adminNotice(row, await domainsFor(connection, row.id), false));
      return { enabled: true, items };
    });
  }
  async function adminGet(id) {
    if (!await ready()) throw unavailable();
    return transaction(async connection => {
      const [[row]] = await connection.execute(`SELECT * FROM ${schema}.notices WHERE id = ?`, [id]);
      if (!row) throw missing();
      const value = adminNotice(row, await domainsFor(connection, id));
      delete value.seq;
      return value;
    });
  }
  async function change({ id, data, action = 'save', updatedAt, actor }) {
    if (!await ready()) throw unavailable();
    return transaction(async connection => {
      let current;
      if (id !== undefined) {
        [[current]] = await connection.execute(`SELECT * FROM ${schema}.notices WHERE id = ? FOR UPDATE`, [id]);
        if (!current) throw missing();
        if (timestamp(current.updated_at) !== updatedAt) throw conflict();
      }
      if (action === 'delete') {
        await connection.execute(`DELETE FROM ${schema}.notices WHERE id = ?`, [id]);
        return { ok: true };
      }
      if (!current) {
        const [insert] = await connection.execute(`INSERT INTO ${schema}.notices (title,body_html,category,audience_all,pinned,state,updated_by) VALUES (?,?,?,?,?,'draft',?)`, [data.title, data.bodyHtml, data.category, Number(data.audienceAll), Number(data.pinned), actor]);
        id = number(insert.insertId);
      } else if (action === 'save') {
        await connection.execute(`UPDATE ${schema}.notices SET title = ?, body_html = ?, category = ?, audience_all = ?, pinned = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP(6) WHERE id = ?`, [data.title, data.bodyHtml, data.category, Number(data.audienceAll), Number(data.pinned), actor, id]);
      }
      if (action === 'save') {
        await connection.execute(`DELETE FROM ${schema}.notice_domains WHERE notice_id = ?`, [id]);
        for (const domain of data.domains) await connection.execute(`INSERT INTO ${schema}.notice_domains (notice_id,domain) VALUES (?,?)`, [id, domain]);
      }
      const publishing = action === 'publish' || action === 'save' && data.publish;
      if (publishing && current?.publish_seq == null) {
        const [counter] = await connection.execute(`UPDATE ${schema}.notice_counter SET next_seq = LAST_INSERT_ID(next_seq + 1) WHERE id = 1`);
        if (counter.affectedRows !== 1) throw unavailable();
        const [[sequence]] = await connection.execute('SELECT LAST_INSERT_ID() AS seq');
        await connection.execute(`UPDATE ${schema}.notices SET publish_seq = ?, published_at = CURRENT_TIMESTAMP WHERE id = ?`, [sequence.seq, id]);
      }
      if (publishing || ['hide', 'pin', 'unpin'].includes(action)) {
        const assignment = publishing ? "state = 'published'" : action === 'hide' ? "state = 'hidden'" : `pinned = ${action === 'pin' ? 1 : 0}`;
        await connection.execute(`UPDATE ${schema}.notices SET ${assignment}, updated_by = ?, updated_at = CURRENT_TIMESTAMP(6) WHERE id = ?`, [actor, id]);
      }
      const [[row]] = await connection.execute(`SELECT * FROM ${schema}.notices WHERE id = ?`, [id]);
      return adminNotice(row, await domainsFor(connection, id));
    });
  }
  return { ready, unread, list, seen, adminList, adminGet, change, close: async () => { await db?.end?.(); } };
}
