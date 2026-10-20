import { createHash, randomBytes } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { AppError } from './errors.js';
import { MAX_PREFS_BYTES, PREFS_ENTRY } from './prefs.js';
import { getMetadata, setMetadataEntries } from './mail/imap-raw.js';
import { withSignatureStoreLock } from './signature-store-lock.js';

export const SIGNATURES_ENTRY = '/private/vendor/mailstack-webmail/signatures-v1';
export const MAX_SIGNATURES_BYTES = 262144;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const revision = () => randomBytes(24).toString('base64url');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new AppError(422, 'SIGNATURE_INVALID', '서명 이름과 기본 서명 설정을 확인해 주세요.');
const corrupt = () => new AppError(503, 'SIGNATURES_INVALID', '저장된 서명을 읽을 수 없어요. 원본은 보존돼 있어요.');
const tooLarge = (code = 'SIGNATURES_TOO_LARGE') => new AppError(413, code, '서명 저장 용량을 넘었어요. 서명 크기나 새 메일 기본 서명을 줄여 주세요.');
const syncError = () => new AppError(503, 'SIGNATURE_SYNC_FAILED', '서명 저장 상태를 확인하지 못했어요. 관리자에게 알려 주세요.');
function address(value) {
  if (typeof value !== 'string') throw invalid();
  const normalized = value.trim().toLowerCase();
  const parts = normalized.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) || /^\.|\.$|\.\./.test(parts[0]) || !parts[1] || parts[1].length > 253 || !parts[1].split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw invalid();
  return normalized;
}
function name(value, preserved = false) {
  if (typeof value !== 'string' || !value.trim() || (!preserved && Buffer.byteLength(value.trim()) > 200) || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw invalid();
  return value.trim();
}
function preservedName(item) {
  if (typeof item.name !== 'string' || Buffer.byteLength(item.name) <= 200) return false;
  return (item.id?.startsWith('legacy-v1-') && address(item.name) === item.name && item.id === `legacy-v1-${sha256(item.name)}`) || (item.id?.startsWith('import-v1-') && item.importSource && item.name === `예전 판에서 고친 서명 — ${item.importSource.address}`);
}
const storedId = value => typeof value === 'string' && /^(?:[A-Za-z0-9_-]{32}|legacy-v1-[a-f0-9]{64}|import-v1-[a-f0-9]{64})$/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
function checkSize(doc, code) {
  if (Buffer.byteLength(JSON.stringify(doc) ?? '') > MAX_SIGNATURES_BYTES) throw tooLarge(code);
}
function mirrorEntries(prefs) {
  const values = Object.hasOwn(prefs, 'signatures') ? prefs.signatures : {};
  if (!object(values)) throw corrupt();
  const entries = {};
  for (const [key, item] of Object.entries(values)) {
    const normalized = address(key);
    if (Object.hasOwn(entries, normalized) || !exact(item, ['html', 'auto']) || typeof item.html !== 'string' || typeof item.auto !== 'boolean') throw corrupt();
    Object.defineProperty(entries, normalized, { value: { html: item.html, auto: item.auto }, enumerable: true });
  }
  return entries;
}
function parsePrefs(raw) {
  try {
    if (raw === null) return {};
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_PREFS_BYTES) throw corrupt();
    const prefs = JSON.parse(raw);
    if (!object(prefs)) throw corrupt();
    mirrorEntries(prefs);
    return prefs;
  } catch { throw corrupt(); }
}
const source = (entries, key) => Object.hasOwn(entries, key) ? [true, entries[key].html, entries[key].auto] : [false, null, null];
const addressHash = (entries, key) => sha256(JSON.stringify(source(entries, key)));
export function signatureMirrorHash(prefs) {
  const entries = mirrorEntries(prefs);
  return sha256(JSON.stringify(Object.keys(entries).sort().map(key => [key, ...source(entries, key)])));
}
export function buildSignatureMirror(doc) {
  const items = new Map(doc.items.map(item => [item.id, item]));
  return Object.fromEntries(Object.entries(doc.defaults).map(([key, defaults]) => {
    const item = defaults.newDefault === null ? null : items.get(defaults.newDefault);
    if (defaults.newDefault !== null && !item) throw invalid();
    return [key, { html: item?.html ?? '', auto: Boolean(item) }];
  }));
}
export function parseSignatures(raw) {
  if (raw === null) return null;
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_SIGNATURES_BYTES) throw corrupt();
    const doc = JSON.parse(raw);
    if (!exact(doc, ['version', 'revision', 'items', 'defaults', 'mirror', 'migration']) || doc.version !== 1 || typeof doc.revision !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(doc.revision) || !Array.isArray(doc.items) || !object(doc.defaults)) throw corrupt();
    const ids = new Set();
    for (const item of doc.items) {
      const keys = ['id', 'name', 'html', 'createdAt', 'updatedAt'];
      if (Object.hasOwn(item, 'importSource')) keys.push('importSource');
      if (!exact(item, keys) || !storedId(item.id) || ids.has(item.id) || name(item.name, preservedName(item)) !== item.name || typeof item.html !== 'string' || !timestamp(item.createdAt) || !timestamp(item.updatedAt)) throw corrupt();
      ids.add(item.id);
      if (Object.hasOwn(item, 'importSource') && (!exact(item.importSource, ['address', 'hash', 'present', 'auto']) || address(item.importSource.address) !== item.importSource.address || !hex(item.importSource.hash) || item.importSource.present !== true || typeof item.importSource.auto !== 'boolean' || item.id !== `import-v1-${sha256(JSON.stringify([item.importSource.address, item.importSource.hash]))}`)) throw corrupt();
    }
    for (const [key, value] of Object.entries(doc.defaults)) {
      if (address(key) !== key || !exact(value, ['newDefault', 'replyDefault']) || Object.values(value).some(id => id !== null && !ids.has(id))) throw corrupt();
    }
    if (!exact(doc.mirror, ['lastWrittenHash', 'lastObservedHash', 'addresses']) || !object(doc.mirror.addresses)) throw corrupt();
    for (const state of [doc.mirror, ...Object.values(doc.mirror.addresses)]) {
      if ((state.lastWrittenHash !== null && !hex(state.lastWrittenHash)) || !hex(state.lastObservedHash)) throw corrupt();
    }
    for (const [key, state] of Object.entries(doc.mirror.addresses)) {
      const keys = ['lastWrittenHash', 'lastObservedHash'];
      if (Object.hasOwn(state, 'present')) keys.push('present');
      if (address(key) !== key || !exact(state, keys) || (Object.hasOwn(state, 'present') && typeof state.present !== 'boolean')) throw corrupt();
    }
    const migration = doc.migration;
    if (!exact(migration, ['version', 'at', 'originalPrefsSha256', 'originalPrefsBase64']) || migration.version !== 1 || !timestamp(migration.at) || !hex(migration.originalPrefsSha256) || typeof migration.originalPrefsBase64 !== 'string') throw corrupt();
    const original = Buffer.from(migration.originalPrefsBase64, 'base64');
    if (original.toString('base64') !== migration.originalPrefsBase64 || original.length > MAX_PREFS_BYTES || sha256(original) !== migration.originalPrefsSha256) throw corrupt();
    return doc;
  } catch { throw corrupt(); }
}
function observe(entries, previous = {}, written = false, initial = false) {
  return Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(entries)])].sort().map(key => {
    const hash = addressHash(entries, key);
    return [key, { lastWrittenHash: written ? hash : previous[key]?.lastWrittenHash ?? null, lastObservedHash: hash, present: initial ? Object.hasOwn(entries, key) : previous[key]?.lastObservedHash === hash ? previous[key].present ?? Object.hasOwn(entries, key) : Object.hasOwn(entries, key) && entries[key].html !== '' }];
  }));
}
function noticesFor(doc) {
  return Object.entries(doc.mirror.addresses).filter(([, state]) => state.present === false && state.lastWrittenHash !== state.lastObservedHash).map(([key]) => ({ code: 'SIGNATURE_LEGACY_DELETED', address: key, message: `예전 판에서 지운 서명이 있어요(${key}). 목록과 기본 서명은 그대로예요.` }));
}
function publicDocument(doc, notices, idMap) {
  return { revision: doc.revision, items: doc.items.map(({ id, name, html, createdAt, updatedAt }) => ({ id, name, html, createdAt, updatedAt })), defaults: doc.defaults, usedBytes: Buffer.byteLength(JSON.stringify(doc)), maxBytes: MAX_SIGNATURES_BYTES, notices, ...(idMap ? { idMap } : {}) };
}

export function createSignaturesService({ imap, normalizeHtml, getIdentities }) {
  const blocked = new Set();
  const readRaw = (client, key) => getMetadata(client, '', key, { maxSize: key === PREFS_ENTRY ? MAX_PREFS_BYTES : MAX_SIGNATURES_BYTES });
  async function write(session, client, entries, previous) {
    try { await setMetadataEntries(client, entries); } catch {
      // An ACK may be lost after a successful atomic write. Never blindly retry or roll back.
      let actual;
      try {
        actual = [];
        for (const [key] of entries) actual.push(await readRaw(client, key));
      } catch { throw syncError(); }
      if (entries.every(([, value], index) => value === actual[index])) return;
      if (previous.every((value, index) => value === actual[index])) throw new AppError(503, 'SIGNATURE_SAVE_RETRY', '서명을 저장하지 못했어요. 다시 시도해 주세요.');
      blocked.add(session.email);
      console.error(JSON.stringify({ code: 'SIGNATURE_SYNC_FAILED', email: session.email, keys: entries.map(([key, value], index) => ({ key, expectedHash: value === null ? null : sha256(value), previousHash: previous[index] === null ? null : sha256(previous[index]), observedHash: actual[index] === null ? null : sha256(actual[index]) })) }));
      throw syncError();
    }
  }
  async function read({ session, client }) {
    if (blocked.has(session.email)) throw syncError();
    const raw = await readRaw(client, SIGNATURES_ENTRY), rawPrefs = await readRaw(client, PREFS_ENTRY);
    const prefs = parsePrefs(rawPrefs), entries = mirrorEntries(prefs), currentHash = signatureMirrorHash(prefs);
    let doc = parseSignatures(raw);
    if (doc === null) {
      const at = new Date().toISOString();
      const items = Object.entries(entries).map(([key, item]) => ({ id: `legacy-v1-${sha256(key)}`, name: key, html: item.html, createdAt: at, updatedAt: at }));
      doc = { version: 1, revision: revision(), items, defaults: Object.fromEntries(items.map(item => [item.name, { newDefault: entries[item.name].auto ? item.id : null, replyDefault: entries[item.name].auto ? item.id : null }])), mirror: { lastWrittenHash: null, lastObservedHash: currentHash, addresses: observe(entries, {}, false, true) }, migration: { version: 1, at, originalPrefsSha256: sha256(rawPrefs ?? ''), originalPrefsBase64: Buffer.from(rawPrefs ?? '', 'utf8').toString('base64') } };
      checkSize(doc, 'SIGNATURE_MIGRATION_TOO_LARGE');
      await write(session, client, [[SIGNATURES_ENTRY, JSON.stringify(doc)]], [raw]);
      return { doc, prefs, notices: [] };
    }
    const notices = noticesFor(doc);
    if (currentHash === doc.mirror.lastWrittenHash || currentHash === doc.mirror.lastObservedHash) return { doc, prefs, notices };
    const at = new Date().toISOString();
    for (const key of [...new Set([...Object.keys(doc.mirror.addresses), ...Object.keys(entries)])].sort()) {
      const hash = addressHash(entries, key), state = doc.mirror.addresses[key];
      if (hash === state?.lastObservedHash || hash === state?.lastWrittenHash) continue;
      const item = entries[key];
      if (!item || item.html === '') continue;
      const id = `import-v1-${sha256(JSON.stringify([key, hash]))}`;
      if (!doc.items.some(item => item.id === id)) {
        doc.items.push({ id, name: `예전 판에서 고친 서명 — ${key}`, html: item.html, createdAt: at, updatedAt: at, importSource: { address: key, hash, present: true, auto: item.auto } });
        notices.push({ code: 'SIGNATURE_LEGACY_IMPORTED', address: key, message: '예전 판에서 고친 서명을 추가했어요. 기본 서명은 바꾸지 않았어요.' });
      }
    }
    doc.mirror.lastObservedHash = currentHash;
    doc.mirror.addresses = observe(entries, doc.mirror.addresses);
    doc.revision = revision();
    checkSize(doc, 'SIGNATURE_MIGRATION_TOO_LARGE');
    await write(session, client, [[SIGNATURES_ENTRY, JSON.stringify(doc)]], [raw]);
    return { doc, prefs, notices: [...notices.filter(notice => notice.code !== 'SIGNATURE_LEGACY_DELETED'), ...noticesFor(doc)] };
  }
  async function run(session, operation) {
    return withSignatureStoreLock(session.email, async () => {
      try { return await imap.withMailbox(session, 'INBOX', operation); } catch (error) {
        if (error instanceof AppError && error.statusCode !== 502) throw error;
        throw new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
      }
    });
  }
  async function readForMirror({ session, client }) {
    if (blocked.has(session.email)) throw syncError();
    // Ordinary prefs writes and image deletion must not initiate the first migration.
    if (await readRaw(client, SIGNATURES_ENTRY) === null) return { doc: null, prefs: parsePrefs(await readRaw(client, PREFS_ENTRY)) };
    return read({ session, client });
  }
  async function getReferences({ session, client }) {
    const { doc, prefs } = await readForMirror({ session, client });
    const references = [];
    function add(id, name, html) {
      // Inert HTML parsing handles entity-encoded attributes without resolving network resources.
      const fragment = JSDOM.fragment(html), assetIds = new Set();
      for (const image of fragment.querySelectorAll('img[src]')) {
        const src = image.getAttribute('src').trim();
        let decoded = src;
        try { decoded = decodeURIComponent(src); } catch { /* reserved malformed references are blocked below */ }
        if (/^cid:wm-sig-v1[.%]/i.test(decoded) || /^cid:wm-sig-v1[.%]/i.test(src)) {
          const match = /^cid:wm-sig-v1\.([A-Za-z0-9_-]{32})@signature\.invalid$/.exec(src);
          if (!match) throw corrupt();
          assetIds.add(match[1]);
        }
      }
      references.push({ id, name, assetIds: [...assetIds] });
    }
    for (const item of doc?.items ?? []) add(item.id, item.name, item.html);
    for (const [key, item] of Object.entries(mirrorEntries(prefs))) add(null, `${key} (예전 판 서명)`, item.html);
    return references;
  }
  async function preparePrefs({ session, client, prefs }) {
    const state = await readForMirror({ session, client });
    const mirrorSync = state.doc !== null && signatureMirrorHash(state.prefs) === state.doc.mirror.lastWrittenHash;
    return { prefs: { ...prefs, signatures: mirrorSync ? buildSignatureMirror(state.doc) : state.prefs.signatures ?? {} }, mirrorSync };
  }
  return {
    read, getReferences, preparePrefs,
    get(session) { return run(session, async client => { const { doc, notices } = await read({ session, client }); return publicDocument(doc, notices); }); },
    put(session, body, expectedRevision) {
      return run(session, async client => {
        checkSize(body);
        const { doc: current, prefs } = await read({ session, client });
        if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') throw new AppError(428, 'SIGNATURE_REVISION_REQUIRED', '최신 서명을 먼저 불러와 주세요.');
        if (expectedRevision !== current.revision) throw new AppError(409, 'SIGNATURE_CONFLICT', '서명이 바뀌었어요. 다시 불러와 주세요.');
        if (!exact(body, ['items', 'defaults']) || !Array.isArray(body.items) || !object(body.defaults)) throw invalid();
        if (typeof normalizeHtml !== 'function' || typeof getIdentities !== 'function') throw new AppError(503, 'SIGNATURE_SERVICE_UNAVAILABLE', '서명 저장을 준비하지 못했어요.');
        const identities = new Set(await getIdentities(session)), oldItems = new Map(current.items.map(item => [item.id, item])), seen = new Set(), idMap = {}, items = [], at = new Date().toISOString();
        for (const item of body.items) {
          if (!exact(item, ['id', 'name', 'html']) || typeof item.id !== 'string' || seen.has(item.id) || typeof item.html !== 'string') throw invalid();
          seen.add(item.id);
          const old = oldItems.get(item.id);
          if (!old && !/^client-.+$/s.test(item.id)) throw new AppError(404, 'SIGNATURE_NOT_FOUND', '서명을 찾을 수 없어요.');
          const id = old?.id ?? revision(), itemName = name(item.name, Boolean(old && old.name === item.name && preservedName(old))), html = await normalizeHtml({ session, client, html: item.html });
          if (typeof html !== 'string') throw syncError();
          if (!old) Object.defineProperty(idMap, item.id, { value: id, enumerable: true });
          items.push({ ...old, id, name: itemName, html, createdAt: old?.createdAt ?? at, updatedAt: old && old.name === itemName && old.html === html ? old.updatedAt : at });
        }
        const kept = new Set(items.map(item => item.id));
        const remap = id => Object.hasOwn(idMap, id) ? idMap[id] : id;
        const defaults = structuredClone(current.defaults);
        for (const [key, value] of Object.entries(body.defaults)) {
          if (address(key) !== key || !exact(value, ['newDefault', 'replyDefault'])) throw invalid();
          const normalized = Object.fromEntries(Object.entries(value).map(([kind, id]) => {
            if (id !== null && typeof id !== 'string') throw invalid();
            const mapped = remap(id);
            if (mapped !== null && !kept.has(mapped) && (!oldItems.has(mapped) || current.defaults[key]?.[kind] !== mapped)) throw invalid();
            return [kind, mapped === null || kept.has(mapped) ? mapped : null];
          }));
          if (!identities.has(key)) {
            const previous = current.defaults[key];
            if (!previous || Object.keys(normalized).some(kind => normalized[kind] !== previous[kind] && !(normalized[kind] === null && previous[kind] !== null && !kept.has(previous[kind])))) throw invalid();
          }
          defaults[key] = normalized;
        }
        for (const key of identities) if (!Object.hasOwn(defaults, key)) defaults[key] = { newDefault: null, replyDefault: null };
        for (const value of Object.values(defaults)) for (const kind of ['newDefault', 'replyDefault']) if (value[kind] !== null && !kept.has(value[kind])) value[kind] = null;
        const doc = { ...current, revision: revision(), items, defaults };
        const nextPrefs = { ...prefs, signatures: buildSignatureMirror(doc) }, entries = mirrorEntries(nextPrefs), hash = signatureMirrorHash(nextPrefs);
        doc.mirror = { lastWrittenHash: hash, lastObservedHash: hash, addresses: observe(entries, current.mirror.addresses, true) };
        checkSize(doc);
        const jsonPrefs = JSON.stringify(nextPrefs);
        if (Buffer.byteLength(jsonPrefs) > MAX_PREFS_BYTES) throw tooLarge('SIGNATURE_MIRROR_TOO_LARGE');
        // A single command is the atomic boundary; never split these entries into two SETs.
        await write(session, client, [[SIGNATURES_ENTRY, JSON.stringify(doc)], [PREFS_ENTRY, jsonPrefs]], [await readRaw(client, SIGNATURES_ENTRY), await readRaw(client, PREFS_ENTRY)]);
        return publicDocument(doc, [], idMap);
      });
    },
  };
}
