import { AppError } from '../errors.js';

export const MAX_SCRIPT_BYTES = 1024 * 1024;
export const SCRIPT_NAME = 'webmail-rules';
export const asciiLower = value => value.replace(/[A-Z]/g, c => c.toLowerCase());

function invalid(path, reason, code = 'RULES_INVALID') {
  const error = new AppError(422, code, '필터 규칙을 확인해 주세요.');
  error.path = path;
  error.reason = reason;
  throw error;
}
function object(value, path, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'object_required');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${path}.${key}`, 'unknown_field');
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, 'required');
}
function text(value, path, { min = 0, max = Infinity } = {}) {
  if (typeof value !== 'string') invalid(path, 'string_required');
  if (!value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || value.includes('${')) invalid(path, 'unsafe_text');
  const length = [...value].length;
  if (length < min || length > max) invalid(path, 'length');
}
export { text as validateText };
function bool(value, path) {
  if (typeof value !== 'boolean') invalid(path, 'boolean_required');
}
function list(value, path, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(path, 'array_length');
}
function date(value, path) {
  if (value === null) return;
  text(value, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid(path, 'date');
}
function domain(value, path) {
  if (value.length > 253 || !value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) invalid(path, 'domain');
}
function address(value, path) {
  text(value, path, { min: 3 });
  const parts = value.split('@');
  if (parts.length !== 2 || parts[0].length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(parts[0]) || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) invalid(path, 'address');
  domain(parts[1], path);
  return asciiLower(parts[1]);
}

export function allowedMoveFolder(folder) {
  const path = folder.path;
  return typeof path === 'string' && !/^(?:INBOX|Trash|Junk|Drafts)$/i.test(path)
    && !/^(?:Shared|WebmailVirtual)(?:\/|$)/i.test(path)
    && !folder.shared && !folder.virtual && folder.personal !== false
    && !['\\Inbox', '\\Trash', '\\Junk', '\\Drafts'].includes(folder.specialUse);
}

/** Policy context: folders are {path, specialUse?, shared?, virtual?, personal?}.
 * checkPolicy:false is for decoding stored data, whose folders/domains may since have changed.
 */
export function validateDocument(doc, { internalDomains = [], folders = [], maxRedirects = 100, checkPolicy = true } = {}) {
  object(doc, '$', ['v', 'rev', 'rules', 'blocked', 'vacation', 'importedFrom'], ['v', 'rev', 'rules', 'blocked', 'vacation']);
  if (doc.v !== 1) invalid('$.v', 'version');
  if (!Number.isSafeInteger(doc.rev) || doc.rev < 0) invalid('$.rev', 'revision');
  list(doc.rules, '$.rules', 0, 100);
  const ids = new Set();
  const forwards = new Set();
  const domains = new Set(internalDomains.map(asciiLower));
  for (const [i, rule] of doc.rules.entries()) {
    const p = `$.rules[${i}]`;
    object(rule, p, ['id', 'enabled', 'match', 'conditions', 'actions', 'stop']);
    text(rule.id, `${p}.id`, { min: 8, max: 8 });
    if (ids.has(rule.id)) invalid(`${p}.id`, 'duplicate');
    ids.add(rule.id);
    bool(rule.enabled, `${p}.enabled`);
    bool(rule.stop, `${p}.stop`);
    if (!['all', 'any'].includes(rule.match)) invalid(`${p}.match`, 'match');
    list(rule.conditions, `${p}.conditions`, 1, 10);
    for (const [j, condition] of rule.conditions.entries()) {
      const c = `${p}.conditions[${j}]`;
      object(condition, c, ['field', 'op', 'value']);
      if (!['from', 'to', 'subject', 'attachment'].includes(condition.field)) invalid(`${c}.field`, 'field');
      if (!['has', 'not', 'eq', 'start'].includes(condition.op)) invalid(`${c}.op`, 'operator');
      if (condition.field === 'attachment') {
        if (condition.op !== 'has' || condition.value !== '') invalid(c, 'attachment');
      } else text(condition.value, `${c}.value`, { min: 1, max: 200 });
    }
    const a = `${p}.actions`;
    object(rule.actions, a, ['move', 'trash', 'read', 'star', 'forward'], []);
    const actions = rule.actions;
    for (const key of ['trash', 'read', 'star']) if (Object.hasOwn(actions, key)) bool(actions[key], `${a}.${key}`);
    if (Object.hasOwn(actions, 'move')) {
      text(actions.move, `${a}.move`, { min: 1 });
      if (actions.trash) invalid(a, 'move_and_trash');
      if (checkPolicy && !folders.some(folder => folder.path === actions.move && allowedMoveFolder(folder))) invalid(`${a}.move`, 'folder_not_allowed');
    }
    if (Object.hasOwn(actions, 'forward')) {
      list(actions.forward, `${a}.forward`, 1, 3);
      for (const [j, target] of actions.forward.entries()) {
        const targetDomain = address(target, `${a}.forward[${j}]`);
        if (checkPolicy && !domains.has(targetDomain)) invalid(`${a}.forward[${j}]`, 'external_domain', 'FORWARD_EXTERNAL');
        forwards.add(asciiLower(target));
      }
    }
    if (!actions.move && !actions.trash && !actions.read && !actions.star && !actions.forward) invalid(a, 'action_required');
  }
  if (forwards.size > maxRedirects) invalid('$.rules', 'redirect_limit', 'TOO_MANY_FORWARDS');
  list(doc.blocked, '$.blocked', 0, 500);
  for (const [i, item] of doc.blocked.entries()) {
    const p = `$.blocked[${i}]`;
    text(item, p, { min: 1 });
    if (item.startsWith('@')) domain(item.slice(1), p);
    else address(item, p);
  }
  object(doc.vacation, '$.vacation', ['enabled', 'start', 'end', 'subject', 'body']);
  bool(doc.vacation.enabled, '$.vacation.enabled');
  date(doc.vacation.start, '$.vacation.start');
  date(doc.vacation.end, '$.vacation.end');
  if (doc.vacation.start && doc.vacation.end && doc.vacation.start > doc.vacation.end) invalid('$.vacation.end', 'date_order');
  text(doc.vacation.subject, '$.vacation.subject');
  text(doc.vacation.body, '$.vacation.body', { max: 4000 });
  if (Object.hasOwn(doc, 'importedFrom')) {
    object(doc.importedFrom, '$.importedFrom', ['name', 'sha256', 'at']);
    text(doc.importedFrom.name, '$.importedFrom.name', { min: 1 });
    if (typeof doc.importedFrom.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(doc.importedFrom.sha256)) invalid('$.importedFrom.sha256', 'sha256');
    text(doc.importedFrom.at, '$.importedFrom.at', { min: 1 });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(doc.importedFrom.at) || !Number.isFinite(Date.parse(doc.importedFrom.at))) invalid('$.importedFrom.at', 'timestamp');
  }
  return doc;
}

export function validateAddress(value, path = '$') {
  return address(value, path);
}

/** Sort object keys only; rule, condition and action address order stays intact. */
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
