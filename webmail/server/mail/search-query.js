import { AppError } from '../errors.js';
import { validateText } from '../sieve/model.js';

const invalid = () => new AppError(400, 'SEARCH_QUERY_INVALID', '검색어 형식을 확인해 주세요.');
const fields = { from: 'from', '보낸사람': 'from', to: 'to', '받는사람': 'to', subject: 'subject', '제목': 'subject', in: 'folder', '폴더': 'folder' };
function tokens(query) {
  const result = [];
  let value = '', quoted = false, escaped = false;
  for (const char of query) {
    if (escaped) { if (char !== '\\' && char !== '"') value += '\\'; value += char; escaped = false; }
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (/\s/u.test(char) && !quoted) { if (value) result.push(value); value = ''; }
    else value += char;
  }
  if (quoted || escaped) throw invalid();
  if (value) result.push(value);
  return result;
}

export function parseSearchQuery(query = '') {
  if (typeof query !== 'string' || !query.isWellFormed() || /[\x00-\x1f\x7f-\x9f]/.test(query)) throw invalid();
  const imap = [], ruleConditions = [], folderFilters = [], textTerms = [];
  for (const token of tokens(query)) {
    const colon = token.indexOf(':');
    const key = colon < 0 ? '' : token.slice(0, colon).toLowerCase();
    const value = colon < 0 ? token : token.slice(colon + 1);
    const field = fields[key];
    if (field) {
      if (!value) throw invalid();
      if (field === 'folder') { folderFilters.push(value); continue; }
      try { validateText(value, '$.search', { min: 1, max: 200 }); } catch { throw invalid(); }
      imap.push(field === 'to' ? { or: [{ to: value }, { cc: value }] } : { [field]: value });
      ruleConditions.push({ field, op: 'has', value });
    } else if ((key === 'has' && value === 'attachment') || (key === '첨부' && value === '있음')) {
      imap.push({ header: { 'Content-Type': 'multipart/mixed' } });
      ruleConditions.push({ field: 'attachment', op: 'has', value: '' });
    } else {
      imap.push({ text: token });
      textTerms.push(token);
    }
  }
  return { imap, ruleConditions, folderFilters, textTerms };
}
