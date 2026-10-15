import { AppError } from './errors.js';
import { themes, modes } from './config.js';
import { getMetadata, setMetadata } from './mail/imap-raw.js';
import { sanitizeComposeHtml } from './mail/sanitize.js';

export const MAX_PREFS_BYTES = 64 * 1024;
export const PREFS_ENTRY = '/private/vendor/mailstack-webmail/prefs';
// Keep in sync with web/src/theme/themes.js swatches (zero-based indices).
const SWATCH_COUNT = 7;
const invalid = () => new AppError(422, 'PREFS_INVALID', '설정 형식을 확인해 주세요.');
const tooLarge = () => new AppError(413, 'PREFS_TOO_LARGE', '설정은 64KB까지 저장할 수 있어요.');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function exact(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw invalid();
}
function choice(value, choices) {
  if (!choices.includes(value)) throw invalid();
  return value;
}
function address(value) {
  if (typeof value !== 'string') throw invalid();
  const normalized = value.trim().toLowerCase();
  const parts = normalized.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) || /^\.|\.$|\.\./.test(parts[0]) || !parts[1] || parts[1].length > 253 || !parts[1].split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw invalid();
  return normalized;
}
function map(value, normalize) {
  if (!object(value)) throw invalid();
  return Object.fromEntries(Object.entries(value).map(([key, item]) => normalize(key, item)));
}
const fields = {
  theme: value => choice(value, themes),
  mode: value => choice(value, modes),
  accent: value => map(value, (key, item) => {
    choice(key, themes);
    if (!(Number.isInteger(item) && item >= 0 && item < SWATCH_COUNT) && !(typeof item === 'string' && /^#[a-f0-9]{6}$/i.test(item))) throw invalid();
    return [key, item];
  }),
  layout: value => {
    if (value === null) return null;
    exact(value, ['pane', 'density', 'compose']);
    return { pane: choice(value.pane, ['none', 'right']), density: choice(value.density, ['normal', 'compact']), compose: choice(value.compose, ['float', 'drawer', 'full']) };
  },
  folderColors: value => map(value, (key, item) => {
    if (!key || /[\0\r\n]/.test(key) || !Number.isInteger(item) || item < 0 || item > 7) throw invalid();
    return [key, item];
  }),
  imageAllow: value => {
    if (!Array.isArray(value) || value.length > 500) throw invalid();
    return [...new Set(value.map(address))];
  },
  signatures: (value, config) => map(value, (key, item) => {
    exact(item, ['html', 'auto']);
    if (typeof item.html !== 'string' || typeof item.auto !== 'boolean') throw invalid();
    return [address(key), { html: sanitizeComposeHtml(item.html, { publicHostnames: config.publicHostnames }), auto: item.auto }];
  }),
  defaultFrom: value => value === null ? null : address(value),
};
function defaults(config) {
  return { theme: config.defaultTheme, mode: config.defaultMode, accent: {}, layout: null, folderColors: {}, imageAllow: [], signatures: {}, defaultFrom: null };
}
function normalize(doc, config) {
  exact(doc, Object.keys(fields));
  return Object.fromEntries(Object.entries(fields).map(([key, parse]) => [key, parse(doc[key], config)]));
}
function readDocument(raw, config, logger) {
  const result = defaults(config);
  if (raw === null) return result;
  let discarded = false, doc;
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_PREFS_BYTES) throw invalid();
    doc = JSON.parse(raw);
    if (!object(doc)) throw invalid();
  } catch {
    discarded = true;
  }
  if (object(doc)) {
    discarded ||= Object.keys(doc).some(key => !Object.hasOwn(fields, key));
    for (const [key, parse] of Object.entries(fields)) {
      if (!Object.hasOwn(doc, key)) continue;
      try { result[key] = parse(doc[key], config); } catch { discarded = true; }
    }
  }
  if (discarded) logger?.warn({ code: 'PREFS_DISCARDED' }, '저장된 설정에서 사용할 수 없는 항목을 제외했습니다.');
  return result;
}
export function createPrefsService({ config, imap, logger }) {
  async function mailCall(session, operation) {
    try { return await imap.withMailbox(session, 'INBOX', operation); } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
    }
  }
  return {
    async get(session) {
      const raw = await mailCall(session, client => getMetadata(client, '', PREFS_ENTRY));
      const doc = readDocument(raw, config, logger);
      session.prefs = doc;
      return doc;
    },
    async put(session, body) {
      if (Buffer.byteLength(JSON.stringify(body) ?? '') > MAX_PREFS_BYTES) throw tooLarge();
      const doc = normalize(body, config);
      const json = JSON.stringify(doc);
      if (Buffer.byteLength(json) > MAX_PREFS_BYTES) throw tooLarge();
      await mailCall(session, client => setMetadata(client, '', PREFS_ENTRY, json));
      session.prefs = doc;
    },
  };
}
