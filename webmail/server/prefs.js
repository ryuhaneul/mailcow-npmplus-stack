import { AppError } from './errors.js';
import { themes, modes } from './config.js';
import { getMetadata, setMetadataEntries } from './mail/imap-raw.js';
import { sanitizeComposeHtml } from './mail/sanitize.js';
import { withSignatureStoreLock } from './signature-store-lock.js';
import { signatureMirrorHash } from './signatures.js';
import { publicTemplateId } from './templates/public.js';
import { templateIdPattern } from './templates/mime.js';

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
  pinnedFolders: value => {
    if (!Array.isArray(value) || value.length > 50 || new Set(value).size !== value.length || value.some(path => typeof path !== 'string' || !path.trim() || /[\0\r\n]/.test(path))) throw invalid();
    return [...value];
  },
  templatePins: value => {
    try {
      if (!Array.isArray(value) || value.length > 20) throw invalid();
      const pins = value.map(item => {
        exact(item, ['owner', 'id']);
        if (item.owner === 'public') { publicTemplateId(item.id); return { owner: 'public', id: item.id }; }
        if (typeof item.id !== 'string' || !templateIdPattern.test(item.id)) throw invalid();
        return { owner: address(item.owner), id: item.id.toLowerCase() };
      });
      if (new Set(pins.map(item => JSON.stringify(item))).size !== pins.length) throw invalid();
      return pins;
    } catch { throw new AppError(400, 'TEMPLATE_PINS_INVALID', '템플릿 고정은 중복 없이 20개까지 설정할 수 있어요.'); }
  },
  pinPosition: value => choice(value, ['mine', 'inbox']),
  sharedView: value => {
    if (!object(value) || Object.keys(value).length > 100) throw invalid();
    return map(value, (key, item) => {
      const owner = address(key);
      exact(item, ['mode', 'folders', 'hidden']);
      if (typeof item.hidden !== 'boolean' || !Array.isArray(item.folders) || item.folders.length > 500) throw invalid();
      const folders = item.folders.map(path => {
        if (typeof path !== 'string' || path.length > 1024 || !path.startsWith(`Shared/${owner}/`) || path.length === `Shared/${owner}/`.length || /[\x00-\x1f\x7f]/.test(path)) throw invalid();
        return path;
      });
      return [owner, { mode: choice(item.mode, ['inbox', 'all', 'custom']), folders: [...new Set(folders)], hidden: item.hidden }];
    });
  },
  imageAllow: value => {
    if (!Array.isArray(value) || value.length > 500) throw invalid();
    return [...new Set(value.map(address))];
  },
  signatures: (value, config) => map(value, (key, item) => {
    exact(item, ['html', 'auto']);
    if (typeof item.html !== 'string' || typeof item.auto !== 'boolean') throw invalid();
    return [address(key), { html: sanitizeComposeHtml(item.html, { publicHostnames: config.publicHostnames }), auto: item.auto }];
  }),
  fromNames: value => map(value, (key, item) => {
    if (typeof item !== 'string' || !item.isWellFormed() || [...item].length > 64 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(item)) throw invalid();
    return [address(key), item.trim()];
  }),
  defaultFrom: value => value === null ? null : address(value),
};
function defaults(config) {
  return { theme: config.defaultTheme, mode: config.defaultMode, accent: {}, layout: null, folderColors: {}, pinnedFolders: [], templatePins: [], pinPosition: 'mine', sharedView: {}, imageAllow: [], signatures: {}, fromNames: {}, defaultFrom: null };
}
function normalize(doc, config) {
  if (!object(doc) || !Object.keys(doc).length || Object.keys(doc).some(key => !Object.hasOwn(fields, key) && key !== 'imageAllowAdd')) throw invalid();
  return Object.fromEntries(Object.entries(doc).map(([key, value]) => [key, (key === 'imageAllowAdd' ? fields.imageAllow : fields[key])(value, config)]));
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
export function createPrefsService({ config, imap, logger, signatures, directory }) {
  async function mailCall(session, operation) {
    try { return await imap.withMailbox(session, 'INBOX', operation); } catch (error) {
      if (error instanceof AppError && error.statusCode !== 502) throw error;
      throw new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
    }
  }
  async function allowedNames(session, names) {
    if (!Object.keys(names).length) return {};
    const { identities } = await directory.identities(session);
    const allowed = new Set(identities.map(item => item.address));
    return Object.fromEntries(Object.entries(names).filter(([key, value]) => allowed.has(key) && value));
  }
  return {
    async get(session) {
      const raw = await mailCall(session, client => getMetadata(client, '', PREFS_ENTRY));
      const doc = readDocument(raw, config, logger);
      doc.fromNames = await allowedNames(session, doc.fromNames);
      session.prefs = doc;
      return doc;
    },
    async put(session, body) {
      if (Buffer.byteLength(JSON.stringify(body) ?? '') > MAX_PREFS_BYTES) throw tooLarge();
      // Every request updates only its supplied fields, including legacy full PUTs.
      const input = normalize(body, config);
      if (Object.values(input.fromNames ?? {}).some(name => name.includes('=?'))) throw new AppError(422, 'PREFS_FROM_NAME_INVALID', '이름에 =? 문자 조합은 쓸 수 없어요');
      await withSignatureStoreLock(session.email, () => mailCall(session, async client => {
        const raw = await getMetadata(client, '', PREFS_ENTRY, { maxSize: MAX_PREFS_BYTES });
        const stored = readDocument(raw, config, logger);
        const { imageAllowAdd, ...patch } = input;
        let doc = { ...stored, ...patch, fromNames: await allowedNames(session, { ...stored.fromNames, ...patch.fromNames }) };
        if (imageAllowAdd) doc.imageAllow = fields.imageAllow([...new Set([...doc.imageAllow, ...imageAllowAdd])]);
        if (signatures) {
          const prepared = await signatures.preparePrefs({ session, client, prefs: doc });
          // The list API alone owns the legacy mirror. Even a pending mirror sync
          // must not replace an unprocessed or preserved legacy edit here.
          const actual = raw === null ? {} : JSON.parse(raw);
          const mirror = actual.signatures ?? {};
          const actualHash = signatureMirrorHash({ signatures: mirror });
          const preparedHash = signatureMirrorHash(prepared.prefs);
          if (actualHash !== preparedHash) logger?.info({ email: session.email, actualHash, preparedHash }, '서명 거울 동기화는 목록 저장 때 적용합니다.');
          doc = { ...prepared.prefs, signatures: mirror };
        }
        const json = JSON.stringify(doc);
        if (Buffer.byteLength(json) > MAX_PREFS_BYTES) throw tooLarge();
        await setMetadataEntries(client, [[PREFS_ENTRY, json]]);
        session.prefs = doc;
      }));
    },
  };
}
