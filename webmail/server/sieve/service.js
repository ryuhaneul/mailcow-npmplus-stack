import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';
import { connectManageSieve } from './managesieve.js';
import { SCRIPT_NAME, validateDocument } from './model.js';
import { generateScript } from './generate.js';
import { parseScript } from './parse.js';
import { classifyState } from './state.js';
import { importScript, rulesDocument } from './import.js';
import { invalidateInboxHeaders, loadInboxHeaders, matches, preview as previewMatches } from './match.js';
import { assertUidValidity, decodeRef } from '../mail/ref.js';
import { createActionService } from '../mail/actions.js';

const previousName = `${SCRIPT_NAME}.prev`;
const stateError = () => new AppError(409, 'RULES_STATE', '현재 필터 상태에서는 이 작업을 할 수 없어요.');
const conflict = () => new AppError(409, 'RULES_CONFLICT', '필터가 바뀌었어요. 다시 불러온 뒤 저장해 주세요.');
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const emptyDocument = () => ({ ...rulesDocument([]), vacation: { enabled: false, start: null, end: null, subject: '부재중입니다', body: '' } });
function invalid(path, reason) {
  const error = new AppError(422, 'RULES_INVALID', '필터 요청을 확인해 주세요.');
  error.path = path; error.reason = reason; throw error;
}
function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid('$', 'request');
}

export function createRulesService({ config, imap, directory, connect = connectManageSieve, now = Date.now, mailActions = createActionService({ imap }) }) {
  const locks = new Map();
  function serial(session, operation) {
    const key = session.email.toLowerCase();
    const previous = locks.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => {}, () => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return result;
  }
  async function context(session, currentClient) {
    async function folders(client) {
      let rows;
      try { rows = await client.list({ statusQuery: { messages: true, unseen: true } }); }
      catch (error) { if (error instanceof AppError) throw error; throw new AppError(503, 'MAIL_UNAVAILABLE', '폴더 정보를 조회할 수 없어요.'); }
      return rows.map(row => ({ path: row.path, ...(typeof row.specialUse === 'string' ? { specialUse: row.specialUse } : {}),
        personal: !row.flags?.has('\\Noselect'), shared: /^(?:Shared)(?:\/|$)/.test(row.path), virtual: /^(?:WebmailVirtual)(?:\/|$)/.test(row.path) }));
    }
    const [rows, internalDomains, identities] = await Promise.all([
      currentClient ? folders(currentClient) : imap.withMailbox(session, 'INBOX', folders),
      directory.internalDomains(), directory.identities(session),
    ]);
    return { folders: rows, internalDomains, addresses: identities.identities.map(identity => identity.address),
      trashPath: rows.find(row => !row.shared && !row.virtual && row.specialUse === '\\Trash')?.path ?? 'Trash' };
  }
  async function withClient(session, operation) {
    const client = await connect(config, { email: session.email, password: session.password });
    try { return await operation(client); }
    finally { try { await client.logout(); } catch { client.close(); } }
  }
  async function read(client, policy) {
    const scripts = await client.listScripts();
    const activeName = scripts.find(script => script.active)?.name ?? null;
    const exists = scripts.some(script => script.name === SCRIPT_NAME);
    const script = exists ? await client.getScript(SCRIPT_NAME) : null;
    let source = null, report;
    if (!exists && activeName !== null) {
      source = await client.getScript(activeName);
      report = { ...importScript(source, { name: activeName, policy: { internalDomains: policy.internalDomains, folders: policy.folders, addresses: policy.addresses } }), sourceName: activeName, sourceSha256: sha256(source) };
    }
    const classified = classifyState({ activeName, webmailScript: script, folders: policy.folders, importReport: report });
    if (classified.state === 'none') { classified.rev = 0; classified.doc = emptyDocument(); }
    return { ...classified, script, scripts, source };
  }
  function allowed(value, states) { if (!states.includes(value.state)) throw stateError(); }
  async function write(client, current, doc, policy, { activate = false, preservePrevious = false } = {}) {
    const script = generateScript(doc, policy);
    await client.checkScript(script);
    if (current.script !== null && !preservePrevious) await client.putScript(previousName, current.script);
    await client.putScript(SCRIPT_NAME, script);
    if (activate) await client.setActive(SCRIPT_NAME);
    return { rev: doc.rev };
  }
  async function perform(session, currentClient, operation) {
    // Never acquire an IMAP lock while holding the per-account Sieve lock.
    const policy = await context(session, currentClient);
    try {
      return await serial(session, () => withClient(session, async client => operation(client, await read(client, policy), policy)));
    } catch (error) {
      if (error.authenticationFailed !== true) throw error;
      // Recheck credentials on a fresh connection after releasing the Sieve lock.
      await imap.verifySessionLogin(session);
      throw new AppError(409, 'SIEVE_DISABLED', '이 계정은 메일 필터 기능이 꺼져 있어요. 관리자에게 켜 달라고 요청해 주세요.');
    }
  }
  async function get(session) {
    return perform(session, null, async (client, current, policy) => {
      const { state, rev, doc, activeName, missingFolders, importReport } = current;
      const prevAvailable = state !== 'newer_version' && current.scripts.some(script => script.name === previousName)
        && parseScript(await client.getScript(previousName)).state === 'ok';
      return { state, rev, doc, activeName, activeScript: activeName, missingFolders, prevAvailable, internalDomains: policy.internalDomains, ...(importReport ? { importReport } : {}) };
    });
  }
  async function save(session, body) {
    object(body, ['baseRev', 'doc']);
    if (!Number.isSafeInteger(body.baseRev) || body.baseRev < 0) invalid('baseRev', 'revision');
    return perform(session, null, async (client, current, policy) => {
      allowed(current, ['ok', 'none']);
      if (body.baseRev !== current.rev) throw conflict();
      validateDocument(body.doc, policy);
      const doc = structuredClone(body.doc); doc.rev = current.rev + 1;
      return write(client, current, doc, policy, { activate: current.state === 'none' });
    });
  }
  async function reactivate(session) {
    return perform(session, null, async (client, current) => {
      allowed(current, ['inactive_other']);
      await client.setActive(SCRIPT_NAME);
      return { previousActive: current.activeName };
    });
  }
  async function restore(session, body) {
    object(body, ['source']);
    if (!['data', 'prev'].includes(body.source)) invalid('source', 'source');
    return perform(session, null, async (client, current, policy) => {
      allowed(current, body.source === 'data' ? ['modified_externally'] : ['damaged']);
      let doc = current.doc;
      if (body.source === 'prev') {
        if (!current.scripts.some(script => script.name === previousName)) throw stateError();
        const previous = parseScript(await client.getScript(previousName));
        if (previous.state !== 'ok') throw stateError();
        doc = previous.doc;
      }
      doc = structuredClone(doc); doc.rev = (current.rev ?? doc.rev) + 1;
      return write(client, current, doc, policy, { preservePrevious: body.source === 'prev' });
    });
  }
  async function importRules(session, body) {
    object(body, ['confirm', 'sourceName', 'sourceSha256']);
    if (body.confirm !== true) invalid('confirm', 'confirmation_required');
    if (typeof body.sourceName !== 'string' || typeof body.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sourceSha256)) invalid('sourceSha256', 'source');
    return perform(session, null, async (client, current, policy) => {
      allowed(current, ['import_pending']);
      if (body.sourceName !== current.activeName || body.sourceSha256 !== sha256(current.source)) throw new AppError(409, 'IMPORT_SOURCE_CHANGED', '가져올 필터가 바뀌었어요. 다시 확인해 주세요.');
      const doc = rulesDocument(current.importReport.rules);
      doc.rev = 1; doc.importedFrom = { name: current.activeName, sha256: sha256(current.source), at: new Date(now()).toISOString() };
      return write(client, current, doc, policy, { activate: true });
    });
  }
  async function getState(session, currentClient) {
    return perform(session, currentClient, async (_client, current) => current.state);
  }
  async function folderInUse(session, path, currentClient) {
    return perform(session, currentClient, async (_client, current) => {
      if (['none', 'import_pending', 'import_blocked'].includes(current.state)) return false;
      allowed(current, ['ok', 'inactive_other', 'modified_externally']);
      const rules = current.doc.rules.filter(rule => rule.actions.move === path || rule.actions.move?.startsWith(`${path}/`)).map(rule => rule.id);
      if (rules.length) { const error = new AppError(409, 'FOLDER_IN_RULES', '필터에서 쓰는 폴더예요. 필터를 먼저 바꿔 주세요.'); error.rules = rules; throw error; }
      return false;
    });
  }
  async function renameFolderRefs(session, from, to, currentClient) {
    return perform(session, currentClient, async (client, current, policy) => {
      if (current.state === 'none') return;
      allowed(current, ['ok']);
      const doc = structuredClone(current.doc); let changed = false;
      for (const rule of doc.rules) if (rule.actions.move === from || rule.actions.move?.startsWith(`${from}/`)) {
        rule.actions.move = to + rule.actions.move.slice(from.length); changed = true;
      }
      if (changed) { doc.rev++; await write(client, current, doc, policy); }
    });
  }
  async function validateRule(session, body, ignoreExternalForward = false, previewOnly = false) {
    object(body, ['rule']);
    const doc = rulesDocument([body.rule]);
    // Validate every address before selectively ignoring the forwarding policy.
    // A first external recipient must not hide a malformed later recipient.
    validateDocument(doc, { checkPolicy: false });
    const policy = previewOnly ? { internalDomains: await directory.internalDomains(), checkFolders: false } : await context(session);
    try { validateDocument(doc, policy); }
    catch (error) { if (!ignoreExternalForward || error.code !== 'FORWARD_EXTERNAL') throw error; }
    return body.rule;
  }
  async function previewRule(session, body) {
    const started = performance.now();
    const rule = await validateRule(session, body, false, true);
    return previewMatches(rule, await loadInboxHeaders(imap, session, { now, budgetMs: Math.max(0, 3500 - (performance.now() - started)) }));
  }
  async function applyExisting(session, body) {
    // Do not queue folder validation behind an unfinished scan.
    await validateRule(session, body, true, true);
    const snapshot = await loadInboxHeaders(imap, session, { now, budgetMs: 0 });
    if (snapshot.partial) throw new AppError(409, 'PREVIEW_NOT_READY', '받은 메일 확인이 끝난 뒤 적용해 주세요.');
    const rule = await validateRule(session, body, true);
    try {
      const candidates = snapshot.items.filter(record => matches(rule, record.headers));
      const found = [];
      // The snapshot can contain mail moved/deleted by another client since
      // preview. Check live UIDs before counting targets; no content rescan.
      await imap.withMailbox(session, 'INBOX', async client => {
        for (let start = 0; start < candidates.length; start += 1000) {
          const batch = candidates.slice(start, start + 1000);
          for (const record of batch) assertUidValidity(client, decodeRef(record.ref));
          const existing = new Set();
          for await (const row of client.fetch(batch.map(record => record.uid).join(','), { uid: true }, { uid: true })) existing.add(row.uid);
          found.push(...batch.filter(record => existing.has(record.uid)));
        }
      });
      const result = { matched: found.length, moved: 0, trashed: 0, flagged: 0, failed: [] };
      const actions = [];
      if (rule.actions.read) actions.push(['seen', 'flagged']);
      if (rule.actions.star) actions.push(['flag', 'flagged']);
      if (rule.actions.trash) actions.push(['trash', 'trashed']);
      else if (rule.actions.move) actions.push(['move', 'moved']);
      // Forwarding is deliberately absent for mail already received.
      let pending = found.map(record => record.ref);
      const flagged = new Set();
      for (const [action, counter] of actions) {
        const next = [];
        for (let start = 0; start < pending.length; start += 1000) {
          const refs = pending.slice(start, start + 1000);
          try {
            const outcome = await mailActions.run(session, { refs, action, ...(action === 'move' ? { target: rule.actions.move } : {}) });
            const vanished = outcome.failed.filter(item => item.code === 'MESSAGE_NOT_FOUND');
            result.matched -= vanished.length;
            result.failed.push(...outcome.failed.filter(item => item.code !== 'MESSAGE_NOT_FOUND'));
            const rejected = new Set(outcome.failed.map(item => item.ref));
            const succeeded = refs.filter(ref => !rejected.has(ref));
            next.push(...succeeded);
            if (counter === 'flagged') for (const ref of succeeded) flagged.add(ref);
            else result[counter] += outcome.done;
          } catch (error) {
            if (['SESSION_EXPIRED', 'NO_SESSION'].includes(error.code)) throw error;
            result.failed.push(...refs.map(ref => ({ ref, code: error instanceof AppError ? error.code : 'MAIL_UNAVAILABLE' })));
          }
        }
        pending = next;
      }
      result.flagged = flagged.size;
      return result;
    } finally { invalidateInboxHeaders(session); }
  }
  return { get, save, reactivate, restore, importRules, getState, renameFolderRefs, folderInUse, preview: previewRule, applyExisting };
}
