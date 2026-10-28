import { createPool } from 'mysql2/promise';
import { JSDOM } from 'jsdom';
import { AppError } from '../errors.js';

const schema = 'mailstack_webmail';
export const publicTemplateAttachmentLimit = 10 * 1024 * 1024;
const unavailable = () => new AppError(503, 'PUBLIC_TEMPLATES_UNAVAILABLE', '회사 공용 템플릿 저장소가 준비되지 않았어요.');
const missing = () => new AppError(404, 'NOT_FOUND', '템플릿을 찾을 수 없어요.');
const invalid = () => new AppError(422, 'INVALID_INPUT', '템플릿 내용과 첨부를 확인해 주세요.');
const conflict = () => new AppError(409, 'CONFLICT', '다른 곳에서 바뀌었어요. 템플릿을 다시 불러와 주세요.');
const storageErrors = new Set(['ER_BAD_DB_ERROR', 'ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_ERROR', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST']);
const versionTimestamp = value => {
  const text = value instanceof Date ? value.toISOString() : String(value).replace(' ', 'T').replace(/Z?$/, 'Z');
  return text.replace(/(?:\.(\d{1,6}))?Z$/, (_, fraction = '') => `.${fraction.padEnd(6, '0')}Z`);
};
export function hasPublicTemplateCidReference(html) {
  const urls = new Set(['src', 'href', 'xlink:href', 'poster', 'background', 'action', 'formaction', 'data', 'srcset']);
  function inspect(root) {
    for (const node of root.querySelectorAll('*')) {
      for (const attribute of node.attributes) {
        if (!urls.has(attribute.name)) continue;
        let value = attribute.value.replace(/[\x00-\x20\x7f]/g, '');
        try { value = decodeURIComponent(value); } catch { /* inspect the undecoded value */ }
        value = value.replace(/[\x00-\x20\x7f]/g, '');
        if (/^cid:/i.test(value) || attribute.name === 'srcset' && /,cid:/i.test(value)) return true;
      }
      if (node.tagName === 'TEMPLATE' && inspect(node.content)) return true;
    }
    return false;
  }
  return inspect(JSDOM.fragment(html));
}
const visible = '(t.audience_all = 1 OR EXISTS (SELECT 1 FROM mailstack_webmail.public_template_domains d WHERE d.template_id = t.id AND d.domain = ?))';
const fileMetadata = row => ({ id: Number(row.id), name: row.name, type: row.type, size: Number(row.size) });
const metadata = (row, domains) => ({ id: Number(row.id), name: row.name, subject: row.subject,
  audienceAll: Boolean(Number(row.audience_all)), domains, updatedAt: versionTimestamp(row.updated_at),
  hasAttachments: Number(row.file_count) > 0, size: Number(row.size) });
const columns = `t.id,t.name,t.subject,t.audience_all,t.updated_at,
  (SELECT COUNT(*) FROM ${schema}.public_template_files f WHERE f.template_id = t.id) AS file_count,
  (SELECT COALESCE(SUM(OCTET_LENGTH(f.data)),0) FROM ${schema}.public_template_files f WHERE f.template_id = t.id) AS size`;

export function createPublicTemplatesStore({ config = {}, db, mode = 'webmail' } = {}) {
  if (!['admin', 'webmail'].includes(mode)) throw new TypeError('Invalid public templates store mode');
  db ??= config.dbHost && config.dbUser && config.dbPassword ? createPool({
    host: config.dbHost, database: config.dbName, user: config.dbUser, password: config.dbPassword,
    connectionLimit: 2, connectTimeout: 10000, timezone: 'Z', dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true,
  }) : null;
  const assertAdmin = () => { if (mode !== 'admin') throw new AppError(403, 'FORBIDDEN', '접근할 수 없어요.'); };
  function domainFor(email) {
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new AppError(403, 'FORBIDDEN', '접근할 수 없어요.');
    return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  }
  async function run(operation) {
    if (!db) throw unavailable();
    try { return await operation(); }
    catch (error) { if (storageErrors.has(error.code)) throw unavailable(); throw error; }
  }
  async function transaction(operation) {
    return run(async () => {
      const connection = await db.getConnection();
      try {
        await connection.query("SET time_zone = '+00:00'");
        await connection.beginTransaction();
        const result = await operation(connection);
        await connection.commit();
        return result;
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    });
  }
  async function ready() {
    if (!db) return false;
    try {
      await run(async () => {
        await db.execute(`SELECT id,name,subject,body_html,audience_all,updated_at,updated_by FROM ${schema}.public_templates LIMIT 0`);
        await db.execute(`SELECT template_id,domain FROM ${schema}.public_template_domains LIMIT 0`);
        await db.execute(`SELECT id,template_id,name,type,data FROM ${schema}.public_template_files LIMIT 0`);
        // Authentication material from SHOW GRANTS must never leave this function.
        const [grants] = await db.query('SHOW GRANTS FOR CURRENT_USER()');
        const lines = grants.flatMap(row => Object.values(row)).join('\n').replace(/`/g, '').split('\n');
        for (const table of ['public_templates', 'public_template_domains', 'public_template_files']) {
          const held = new Set();
          for (const line of lines) {
            const match = /^GRANT (.*?) ON (.*?) TO /.exec(line);
            if (match && [schema + '.' + table, schema + '.*', '*.*'].includes(match[2])) {
              for (const privilege of match[1].split(',').map(value => value.trim())) held.add(privilege);
            }
          }
          const required = mode === 'admin' ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : ['SELECT'];
          if (!held.has('ALL PRIVILEGES') && required.some(value => !held.has(value))) throw unavailable();
        }
      });
      return true;
    } catch (error) { if (error.code === 'PUBLIC_TEMPLATES_UNAVAILABLE') return false; throw error; }
  }
  async function domainsFor(connection, id) {
    const [rows] = await connection.execute(`SELECT domain FROM ${schema}.public_template_domains WHERE template_id = ? ORDER BY domain`, [id]);
    return rows.map(row => row.domain);
  }
  async function filesFor(connection, id) {
    const [rows] = await connection.execute(`SELECT id,name,type,OCTET_LENGTH(data) AS size FROM ${schema}.public_template_files WHERE template_id = ? ORDER BY id`, [id]);
    return rows.map(fileMetadata);
  }
  async function read(connection, id, domain) {
    const [[row]] = await connection.execute(`SELECT ${columns},t.body_html FROM ${schema}.public_templates t WHERE t.id = ?${domain === undefined ? '' : ` AND ${visible}`}`, domain === undefined ? [id] : [id, domain]);
    if (!row) throw missing();
    return { ...metadata(row, await domainsFor(connection, id)), html: row.body_html, attachments: await filesFor(connection, id) };
  }
  async function listRows(domain) {
    if (!await ready()) throw unavailable();
    return transaction(async connection => {
      const [rows] = await connection.execute(`SELECT ${columns} FROM ${schema}.public_templates t${domain === undefined ? '' : ` WHERE ${visible}`} ORDER BY t.id DESC`, domain === undefined ? [] : [domain]);
      const items = [];
      for (const row of rows) items.push(metadata(row, await domainsFor(connection, row.id)));
      return { items };
    });
  }
  async function adminList() { assertAdmin(); return listRows(); }
  async function adminGet(id) { assertAdmin(); if (!await ready()) throw unavailable(); return transaction(connection => read(connection, id)); }
  async function list(email) { return listRows(domainFor(email)); }
  async function get(email, id) {
    const domain = domainFor(email);
    if (!await ready()) throw unavailable();
    return transaction(connection => read(connection, id, domain));
  }
  async function file(email, id, fileId) {
    const domain = domainFor(email);
    if (!await ready()) throw unavailable();
    return transaction(async connection => {
      const [[row]] = await connection.execute(`SELECT f.id,f.name,f.type,f.data,OCTET_LENGTH(f.data) AS size FROM ${schema}.public_template_files f JOIN ${schema}.public_templates t ON t.id = f.template_id WHERE t.id = ? AND f.id = ? AND ${visible}`, [id, fileId, domain]);
      if (!row) throw missing();
      return { ...fileMetadata(row), data: row.data };
    });
  }
  async function change({ id, data, action = 'save', updatedAt, actor }) {
    assertAdmin();
    if (!['save', 'delete'].includes(action) || action === 'delete' && id === undefined) throw invalid();
    if (action === 'save') {
      if (!data || typeof data.name !== 'string' || !data.name.trim() || Array.from(data.name).length > 100 || typeof data.subject !== 'string' || typeof data.html !== 'string' || hasPublicTemplateCidReference(data.html) || typeof data.audienceAll !== 'boolean' || !Array.isArray(data.domains) || !Array.isArray(data.keepFileIds) || !Array.isArray(data.newFiles)) throw invalid();
      if (data.newFiles.some(file => !file || typeof file.name !== 'string' || !file.name || file.name.length > 255 || typeof file.type !== 'string' || !file.type || file.type.length > 255 || !Buffer.isBuffer(file.data))) throw invalid();
      if (data.keepFileIds.some(value => !Number.isSafeInteger(value) || value <= 0) || new Set(data.keepFileIds).size !== data.keepFileIds.length) throw invalid();
    }
    if (!await ready()) throw unavailable();
    return transaction(async connection => {
      let current;
      if (id !== undefined) {
        [[current]] = await connection.execute(`SELECT id,updated_at FROM ${schema}.public_templates WHERE id = ? FOR UPDATE`, [id]);
        if (!current) throw missing();
        if (versionTimestamp(current.updated_at) !== updatedAt) throw conflict();
      }
      if (action === 'delete') {
        await connection.execute(`DELETE FROM ${schema}.public_templates WHERE id = ?`, [id]);
        return { ok: true };
      }
      const oldFiles = current ? await filesFor(connection, id) : [];
      const retained = new Set(data.keepFileIds);
      if (data.keepFileIds.some(key => !oldFiles.some(file => file.id === key))) throw invalid();
      const size = oldFiles.filter(file => retained.has(file.id)).reduce((sum, file) => sum + file.size, 0) + data.newFiles.reduce((sum, file) => sum + file.data.length, 0);
      if (size > publicTemplateAttachmentLimit) throw new AppError(422, 'ATTACH_TOO_LARGE', '템플릿 첨부 합계는 10MB까지 저장할 수 있어요.');
      if (!current) {
        const [insert] = await connection.execute(`INSERT INTO ${schema}.public_templates (name,subject,body_html,audience_all,updated_by) VALUES (?,?,?,?,?)`, [data.name, data.subject, data.html, Number(data.audienceAll), actor]);
        id = Number(insert.insertId);
      } else {
        await connection.execute(`UPDATE ${schema}.public_templates SET name = ?, subject = ?, body_html = ?, audience_all = ?, updated_by = ?, updated_at = GREATEST(CURRENT_TIMESTAMP(6), updated_at + INTERVAL 1 MICROSECOND) WHERE id = ?`, [data.name, data.subject, data.html, Number(data.audienceAll), actor, id]);
      }
      await connection.execute(`DELETE FROM ${schema}.public_template_domains WHERE template_id = ?`, [id]);
      if (!data.audienceAll) for (const domain of [...new Set(data.domains)]) await connection.execute(`INSERT INTO ${schema}.public_template_domains (template_id,domain) VALUES (?,?)`, [id, domain]);
      for (const file of oldFiles) if (!retained.has(file.id)) await connection.execute(`DELETE FROM ${schema}.public_template_files WHERE template_id = ? AND id = ?`, [id, file.id]);
      for (const file of data.newFiles) await connection.execute(`INSERT INTO ${schema}.public_template_files (template_id,name,type,data) VALUES (?,?,?,?)`, [id, file.name, file.type, file.data]);
      return read(connection, id);
    });
  }
  return { ready, adminList, adminGet, change, list, get, file, close: async () => { await db?.end?.(); } };
}
