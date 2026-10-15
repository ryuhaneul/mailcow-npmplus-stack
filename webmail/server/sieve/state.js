import { allowedMoveFolder, SCRIPT_NAME } from './model.js';
import { parseScript } from './parse.js';

/** Pure classification; source conversion is supplied later by the import library.
 * webmailScript:null means absent; an empty string means present but damaged.
 * Integrity failures take precedence over inactive status.
 */
export function classifyState({ activeName = null, webmailScript = null, folders = [], importReport } = {}) {
  if (webmailScript === null) {
    const canImport = ['gmail2sieve', 'rainloop'].includes(importReport?.format)
      && Array.isArray(importReport.items) && importReport.items.every(item => ['same', 'changed'].includes(item.status));
    const state = activeName === null ? 'none' : canImport ? 'import_pending' : 'import_blocked';
    return { state, activeName, doc: null, rev: null, missingFolders: [], ...(importReport === undefined ? {} : { importReport }) };
  }
  const parsed = parseScript(webmailScript);
  const missingFolders = [...new Set((parsed.doc?.rules ?? []).map(rule => rule.actions.move).filter(path => path && !folders.some(folder => folder.path === path && allowedMoveFolder(folder))))];
  return { ...parsed, state: parsed.state === 'ok' && activeName !== SCRIPT_NAME ? 'inactive_other' : parsed.state, activeName, missingFolders };
}
