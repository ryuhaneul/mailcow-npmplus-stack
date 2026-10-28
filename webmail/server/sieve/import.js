import { MAX_RULES } from './limits.js';
import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { validateAddress, validateDocument, validateText, MAX_SCRIPT_BYTES, minimumDocumentVersion } from './model.js';
import { GMAIL_HEADER, gmailBlocks } from './import-gmail.js';
import { rainloopBlocks } from './import-rainloop.js';
import { unknownItems } from './import-syntax.js';
import { generateScript } from './generate.js';

export const rulesDocument = rules => ({
  v: minimumDocumentVersion(rules),
  rev: 0, rules, blocked: [], vacation: { enabled: false, start: null, end: null, subject: '', body: '' }
});

/** Only explicit administrator/server policy is accepted; never infer permissions from imported data. */
export function importPolicy(input) {
  function bad(reason) {
    const error = new AppError(422, 'POLICY_INVALID', reason);
    throw error;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.internalDomains)) bad('--policy 파일에 internalDomains 배열이 필요해요. 외부 전달 검사를 못 하므로 생성을 거부해요.');
  if (Object.keys(input).some(key => !['internalDomains', 'folders', 'addresses'].includes(key))) bad('지원하지 않는 정책 필드가 있어요.');
  for (const domain of input.internalDomains) {
    if (typeof domain !== 'string') bad('internalDomains는 도메인 문자열 배열이어야 해요.');
    try { validateAddress(`policy@${domain}`); } catch { bad('internalDomains의 도메인 형식을 확인해 주세요.'); }
  }
  if (Object.hasOwn(input, 'folders')) {
    if (!Array.isArray(input.folders)) bad('folders는 개인 폴더 정보 배열이어야 해요.');
    for (const folder of input.folders) {
      if (!folder || typeof folder !== 'object' || Array.isArray(folder) || typeof folder.path !== 'string') bad('폴더 항목에 path가 필요해요.');
      validateText(folder.path, 'policy.folders.path', { min: 1 });
      if (Object.keys(folder).some(key => !['path', 'specialUse', 'shared', 'virtual', 'personal'].includes(key))) bad('지원하지 않는 폴더 정보가 있어요.');
      for (const key of ['shared', 'virtual', 'personal']) if (Object.hasOwn(folder, key) && typeof folder[key] !== 'boolean') bad('폴더 권한 정보는 참·거짓이어야 해요.');
      if (Object.hasOwn(folder, 'specialUse') && typeof folder.specialUse !== 'string') bad('specialUse는 문자열이어야 해요.');
    }
  }
  if (Object.hasOwn(input, 'addresses')) {
    if (!Array.isArray(input.addresses)) bad('addresses는 보낼 수 있는 주소 배열이어야 해요.');
    for (const address of input.addresses) validateAddress(address, 'policy.addresses');
  }
  return { ...input, checkFolders: Object.hasOwn(input, 'folders') };
}

export function folderWarnings(rules, checkFolders) {
  return rules.map((rule, i) => ({ n: i + 1, warnings: !checkFolders && rule.actions.move ? ['폴더 존재 미확인'] : [] }));
}

/** Returns all source items, including failed/previously excluded blocks. No server calls. */
export function importScript(source, { name = '', policy } = {}) {
  const context = importPolicy(policy);
  if (typeof source !== 'string' || !source.isWellFormed() || Buffer.byteLength(source) > MAX_SCRIPT_BYTES) throw new AppError(422, 'RULES_INVALID', '가져올 스크립트는 UTF-8, 1MB 이하여야 해요.');
  source = source.replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const firstLine = lines.findIndex(line => line === GMAIL_HEADER || (line.trim() && !line.trimStart().startsWith('#')));
  const format = lines[firstLine] === GMAIL_HEADER ? 'gmail2sieve'
    : name === 'rainloop.user' && /^# RAINLOOP:SIEVE$/m.test(source) ? 'rainloop' : 'unknown';
  if (format === 'unknown') return { format, rules: [], items: unknownItems(source), uncheckedFolders: 0 };
  const entries = format === 'gmail2sieve' ? gmailBlocks(lines.slice(firstLine).join('\n')) : rainloopBlocks(source);
  const moves = new Set(entries.map(entry => entry.rule?.actions.move).filter(Boolean));
  for (const [index, entry] of entries.entries()) {
    entry.item.n = index + 1;
    if (!entry.rule) {
      if (['same', 'changed'].includes(entry.item.status)) {
        entry.item.status = 'unconvertible'; entry.item.reason = '동작이 없어 반영 안 됨';
      }
      continue;
    }
    if (moves.size > 1 && entry.rule.actions.move) {
      entry.item.changes.push('여러 라벨이 맞으면 첫 폴더 하나에만 들어가요'); entry.item.status = 'changed';
    }
    entry.rule.id = randomBytes(4).toString('hex');
    try {
      validateDocument(rulesDocument([entry.rule]), context);
      if (!context.checkFolders && entry.rule.actions.move) entry.item.warnings = ['폴더 존재 미확인'];
    } catch (error) {
      entry.item.status = 'unconvertible';
      entry.item.reason = '규칙의 값이나 형식을 옮길 수 없어요.';
      delete entry.rule;
    }
  }
  const rules = [];
  let limitReason;
  for (const entry of entries) {
    if (!entry.rule) continue;
    if (!limitReason) {
      try {
        generateScript(rulesDocument([...rules, entry.rule]), context);
        rules.push(entry.rule); continue;
      } catch (error) {
        limitReason = rules.length >= MAX_RULES ? `규칙 ${MAX_RULES}개 한도` : error.reason === 'script_too_large' ? '생성 스크립트 1MB 한도' : error.code === 'TOO_MANY_FORWARDS' ? '전달 주소 수 한도' : '전체 규칙 제한을 넘었어요.';
      }
    }
    entry.item.status = 'unconvertible'; entry.item.reason = limitReason;
    delete entry.rule;
  }
  return { format, rules, items: entries.map(entry => entry.item), uncheckedFolders: entries.filter(entry => entry.item.warnings?.includes('폴더 존재 미확인')).length };
}
