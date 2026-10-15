import { encodePath, decodePath } from 'imapflow/lib/tools.js';
import { AppError } from '../errors.js';

const badResponse = () => new AppError(502, 'MAIL_REJECTED', '메일 서버 응답을 확인할 수 없어요.');
const text = token => Buffer.isBuffer(token?.value) ? token.value.toString('utf8') : token?.value;
const atom = value => ({ type: 'ATOM', value });
const string = value => ({ type: 'STRING', value });
function validPath(path) {
  if (typeof path !== 'string' || /[\0\r\n]/.test(path)) throw new AppError(400, 'INVALID_MAILBOX', '메일함 경로를 확인해 주세요.');
}
async function command(client, name, attributes, responseType) {
  const rows = [];
  if (typeof client.preCheck === 'function') await client.preCheck();
  try {
    const response = await client.exec(name, attributes, {
      untagged: responseType ? { [responseType]: row => { rows.push(row); } } : {},
    });
    response.next();
  } catch (error) {
    if (['NO', 'BAD'].includes(error.responseStatus)) throw badResponse();
    throw error;
  }
  return rows;
}
function pairs(list) {
  if (!Array.isArray(list) || list.length % 2) throw badResponse();
  const values = new Map();
  for (let i = 0; i < list.length; i += 2) {
    const key = text(list[i]);
    if (typeof key !== 'string') throw badResponse();
    values.set(key.toUpperCase(), text(list[i + 1]));
  }
  return values;
}
function uint(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw badResponse();
  return Number(value);
}

export async function fetchOriginals(client, set) {
  const range = String(set);
  if (!/^(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?(?:,(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?)*$/.test(range)) throw new AppError(400, 'INVALID_UID_SET', '메일 번호를 확인해 주세요.');
  const rows = await command(client, 'UID FETCH', [{ type: 'SEQUENCE', value: range }, [atom('X-MAILBOX'), atom('X-REAL-UID')]], 'FETCH');
  return rows.map(row => {
    const values = pairs(row.attributes?.[1]);
    const path = values.get('X-MAILBOX');
    const uid = uint(values.get('X-REAL-UID'));
    const virtualUid = uint(values.get('UID'));
    if (typeof path !== 'string' || !path || !uid || !virtualUid) throw badResponse();
    return { virtualUid, path: decodePath(client, path), uid };
  });
}

export async function mailboxStatus(client, path, fields = ['MESSAGES', 'SIZE']) {
  validPath(path);
  if (!fields.length || fields.some(field => !['MESSAGES', 'SIZE', 'UIDVALIDITY'].includes(field))) throw new AppError(400, 'INVALID_STATUS', '메일함 조회 항목을 확인해 주세요.');
  const rows = await command(client, 'STATUS', [string(encodePath(client, path)), fields.map(atom)], 'STATUS');
  const row = rows.find(row => decodePath(client, text(row.attributes?.[0])) === path);
  if (!row) throw badResponse();
  const values = pairs(row.attributes?.[1]);
  return Object.fromEntries(fields.map(field => [field.toLowerCase(), uint(values.get(field))]));
}

export async function getMetadata(client, path, entry) {
  validPath(path);
  validPath(entry);
  const rows = await command(client, 'GETMETADATA', [string(encodePath(client, path)), string(entry)], 'METADATA');
  for (const row of rows) {
    if (decodePath(client, text(row.attributes?.[0])) !== path) continue;
    const list = row.attributes?.[1];
    if (!Array.isArray(list) || list.length % 2) throw badResponse();
    for (let i = 0; i < list.length; i += 2) if (text(list[i]) === entry) return text(list[i + 1]) ?? null;
  }
  return null;
}
export async function setMetadata(client, path, entry, value) {
  validPath(path);
  validPath(entry);
  if (value !== null && typeof value !== 'string') throw new AppError(400, 'INVALID_METADATA', '설정 값을 확인해 주세요.');
  await command(client, 'SETMETADATA', [string(encodePath(client, path)), [string(entry), value === null ? null : { type: 'LITERAL', value: Buffer.from(value, 'utf8') }]]);
}
