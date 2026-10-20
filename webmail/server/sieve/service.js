import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { connectManageSieve } from './managesieve.js';
import { SCRIPT_NAME, canonicalJSON, allowedMoveFolder, validateText, validateDocument } from './model.js';
import { generateScript } from './generate.js';
import { parseScript } from './parse.js';
import { readGmailXml as readXml } from './gmail-xml.js';
import { convertGmailEntries as convertEntries } from './import-xml.js';
import { classifyState } from './state.js';
import { importScript, rulesDocument } from './import.js';
import { invalidateInboxHeaders, loadInboxHeaders, matches, preview as previewMatches } from './match.js';
import { assertUidValidity, decodeRef } from '../mail/ref.js';
import { createActionService } from '../mail/actions.js';
import { createFolderService } from '../mail/folders.js';
import { importName, undoWebmailName, undoActiveName, importRecord, encodeImportRecord, readImportRecord, importInfo, droppedItems } from './import-store.js';

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

export function createRulesService({ config, imap, directory, connect = connectManageSieve, now = Date.now, readGmailXml = readXml, convertGmailEntries = convertEntries, folderService = createFolderService({ imap }), mailActions = createActionService({ imap }) }) {
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
      const selected = [];
      let nextRule = 0, limit = false;
      for (const item of report.items) {
        if (!['same', 'changed'].includes(item.status)) continue;
        const rule = report.rules[nextRule++];
        const doc = importDocument({ script: null, rev: null }, [...selected, rule], 'new', { name: activeName, sha256: sha256(source) });
        if (!limit) {
          try { generateScript(doc, policy); selected.push(rule); continue; }
          catch (error) { if (error.reason !== 'script_too_large') throw error; limit = true; }
        }
        item.status = 'unconvertible'; item.reason = '반영 안 됨 — 한도 초과';
      }
      report.rules = selected;
      report.planSha256 = planHash(report.rules, report.items, [], 'new');
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
      const prevAvailable = current.state !== 'newer_version' && current.scripts.some(script => script.name === previousName)
        && parseScript(await client.getScript(previousName)).state === 'ok';
      const info = await importInfo(client, current);
      return { state, rev, doc, activeName, activeScript: activeName, missingFolders, prevAvailable, internalDomains: policy.internalDomains, ...(importReport ? { importReport } : {}), ...(info ? { importInfo: info } : {}) };
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
  const previewChanged = () => new AppError(409, 'IMPORT_PREVIEW_CHANGED', '가져올 필터나 폴더가 바뀌었어요. 다시 확인해 주세요.');
  const nothing = () => new AppError(409, 'IMPORT_NOTHING', '반영할 수 있는 필터가 없어요.');
  const undoError = code => new AppError(409, code, code === 'UNDO_EDITED' ? '가져온 뒤 고친 규칙·차단 주소·부재중도 함께 돌아가요. 확인해 주세요.' : '가져오기 보관본이나 원래 필터가 바뀌었어요. 다시 확인해 주세요.');
  function planHash(rules, items, newFolders, mode) {
    return sha256(canonicalJSON({ rules: rules.map(({ id, ...rule }) => rule),
      dropped: droppedItems(items), newFolders, mode }));
  }
  function xmlInput(body, apply) {
    object(body, apply ? ['xml', 'fileName', 'mode', 'confirm', 'expect'] : ['xml', 'fileName', 'mode']);
    if (typeof body.xml !== 'string') invalid('xml', 'string_required');
    validateText(body.fileName, 'fileName', { min: 1, max: 255 });
    if (Object.hasOwn(body, 'mode') && !['append', 'replace'].includes(body.mode)) invalid('mode', 'mode');
    if (apply && body.confirm !== true) invalid('confirm', 'confirmation_required');
    if (apply) {
      object(body.expect, ['xmlSha256', 'mode', 'rev', 'activeName', 'activeSha256', 'planSha256']);
      for (const field of ['xmlSha256', 'planSha256']) if (typeof body.expect[field] !== 'string' || !/^[a-f0-9]{64}$/.test(body.expect[field])) invalid(`expect.${field}`, 'sha256');
      if (!['new', 'append', 'replace'].includes(body.expect.mode)) invalid('expect.mode', 'mode');
      if (Object.hasOwn(body.expect, 'rev') && (!Number.isSafeInteger(body.expect.rev) || body.expect.rev < 0)) invalid('expect.rev', 'revision');
      if (Object.hasOwn(body.expect, 'activeName') && typeof body.expect.activeName !== 'string') invalid('expect.activeName', 'string_required');
      if (Object.hasOwn(body.expect, 'activeSha256') && (typeof body.expect.activeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.expect.activeSha256))) invalid('expect.activeSha256', 'sha256');
    }
  }
  function importRuleIds(rules, existing) {
    const ids = new Set(existing.map(rule => rule.id));
    return structuredClone(rules).map(rule => {
      do { rule.id = randomBytes(4).toString('hex'); } while (ids.has(rule.id));
      ids.add(rule.id); return rule;
    });
  }
  // Preview and apply budget the same final envelope, including preserved fields
  // and provenance. Imported ids always occupy eight bytes in both calculations.
  function importDocument(current, rules, mode, source, at = new Date(now()).toISOString()) {
    const doc = current.script === null ? rulesDocument([]) : structuredClone(current.doc);
    const incoming = importRuleIds(rules, mode === 'append' ? doc.rules : []);
    doc.rules = mode === 'append' ? [...doc.rules, ...incoming] : incoming;
    doc.v = rulesDocument(doc.rules).v;
    doc.rev = (current.rev ?? 0) + 1;
    doc.importedFrom = { name: source.name, sha256: source.sha256, at };
    return doc;
  }
  async function xmlPlan(client, current, policy, body, entries, plannedFolders = []) {
    allowed(current, ['none', 'ok', 'import_pending', 'import_blocked', 'inactive_other']);
    const existing = current.script === null ? [] : current.doc.rules;
    if (existing.length && !body.mode) invalid('mode', 'required');
    const mode = existing.length ? body.mode : 'new';
    // Keep the preview's missing-folder view during the second plan calculation;
    // folders created by this request must not change its own approved hash.
    const conversionFolders = policy.folders.filter(folder => !plannedFolders.includes(folder.path));
    const converted = convertGmailEntries(entries, { policy: { ...policy, folders: conversionFolders }, folders: conversionFolders, existingRules: existing, mode, stage: 2 });
    const newFolders = [], rules = [], items = [];
    const source = { name: body.fileName, sha256: sha256(body.xml) };
    let nextRule = 0, folderLimit = false, documentLimit = false;
    for (const original of converted.items) {
      const item = structuredClone(original);
      if (!['same', 'changed'].includes(item.status)) { items.push(item); continue; }
      const rule = converted.rules[nextRule++];
      const missing = [];
      if (rule.actions.move) {
        const parts = rule.actions.move.split('/');
        for (let depth = 1; depth <= parts.length; depth++) {
          const path = parts.slice(0, depth).join('/');
          if (!conversionFolders.some(folder => folder.path === path) && !newFolders.includes(path)) missing.push(path);
        }
      }
      if (folderLimit || newFolders.length + missing.length > 100) {
        folderLimit = true; item.status = 'no'; item.reason = '새 폴더 100개 한도'; delete item.rule; delete item.newFolder;
      } else {
        try {
          if (documentLimit) throw new Error('Document limit reached');
          generateScript(importDocument(current, [...rules, rule], mode, source), { ...policy, folders: [...conversionFolders, ...newFolders.map(path => ({ path })), ...missing.map(path => ({ path }))] });
          newFolders.push(...missing); rules.push(rule);
        } catch (error) {
          if (!documentLimit && error.reason !== 'script_too_large' && error.reason !== 'array_length' && error.code !== 'TOO_MANY_FORWARDS') throw error;
          documentLimit = true; item.status = 'no'; item.reason = '반영 안 됨 — 한도 초과'; delete item.rule; delete item.newFolder;
        }
      }
      items.push(item);
    }
    for (const path of newFolders) {
      validateText(path, 'newFolders', { min: 1 });
      if (!allowedMoveFolder({ path })) invalid('newFolders', 'folder_not_allowed');
    }
    const activeScript = current.activeName === SCRIPT_NAME ? current.script : current.activeName ? await client.getScript(current.activeName) : null;
    const expect = { xmlSha256: sha256(body.xml), mode, ...(current.script !== null ? { rev: current.rev } : {}),
      ...(current.activeName ? { activeName: current.activeName, activeSha256: sha256(activeScript) } : {}),
      planSha256: planHash(rules, items, newFolders, mode) };
    return { rules, items, newFolders, mode, activeScript, expect, existing: existing.length };
  }
  async function previewXml(session, body) {
    xmlInput(body, false);
    const { entries } = readGmailXml(body.xml);
    return perform(session, null, async (client, current, policy) => {
      const plan = await xmlPlan(client, current, policy, body, entries);
      const counts = { same: 0, changed: 0, no: 0 };
      for (const item of plan.items) counts[['same', 'changed'].includes(item.status) ? item.status : 'no']++;
      return { items: plan.items, counts,
        plan: { mode: plan.mode, existing: plan.existing, applied: plan.rules.length,
          total: (plan.mode === 'append' ? plan.existing : 0) + plan.rules.length, newFolders: plan.newFolders,
          ...(current.activeName && current.activeName !== SCRIPT_NAME ? { deactivates: current.activeName } : {}),
          replacesUndo: current.scripts.some(script => script.name === importName) }, expect: plan.expect };
    });
  }
  async function createImportFolders(session, paths) {
    const created = [];
    for (const path of paths) {
      const index = path.lastIndexOf('/');
      try {
        await folderService.create(session, { name: path.slice(index + 1), ...(index >= 0 ? { parent: path.slice(0, index) } : {}) });
        created.push(path);
      } catch (cause) {
        if (cause.code === 'EXISTS') continue;
        const error = new AppError(502, 'FOLDER_CREATE_FAILED', '폴더를 만들지 못했어요. 필터는 적용하지 않았어요.');
        error.detail = { folder: path, created }; throw error;
      }
    }
    return created;
  }
  async function removeScript(client, name) {
    if ((await client.listScripts()).some(script => script.name === name)) await client.deleteScript(name);
  }
  async function applyImport(session, client, current, policy, { rules, items, mode, source, createdFolders = [] }) {
    if (!rules.length) throw nothing();
    const previousImport = await readImportRecord(client, current.scripts);
    const at = new Date(Math.max(now(), previousImport ? Date.parse(previousImport.at) + 1 : 0)).toISOString();
    const doc = importDocument(current, rules, mode, source, at);
    const script = generateScript(doc, policy);
    const activeScript = current.activeName === SCRIPT_NAME ? current.script : current.activeName ? await client.getScript(current.activeName) : null;
    const record = importRecord({ at, source, mode, items, webmailScript: current.script, activeName: current.activeName, activeScript, afterScript: script });
    let archived = false;
    try {
      if (current.script !== null) await client.putScript(undoWebmailName, current.script);
      else await removeScript(client, undoWebmailName);
      if (current.activeName && current.activeName !== SCRIPT_NAME) await client.putScript(undoActiveName, activeScript);
      else await removeScript(client, undoActiveName);
      await client.putScript(importName, encodeImportRecord(record));
      archived = true;
      await client.checkScript(script);
      if (current.script !== null) await client.putScript(previousName, current.script);
      await client.putScript(SCRIPT_NAME, script);
      await client.setActive(SCRIPT_NAME);
    } catch {
      let restored = false;
      // A timed-out connection may already have stored bytes. Verify on a fresh
      // connection, and never infer success just from a command rejection.
      if (archived) {
        try {
          restored = await withClient(session, async recovery => {
            const rows = await recovery.listScripts();
            const stored = rows.some(row => row.name === SCRIPT_NAME) ? await recovery.getScript(SCRIPT_NAME) : null;
            if (current.script !== null && stored !== current.script) await recovery.putScript(SCRIPT_NAME, current.script);
            if ((rows.find(row => row.active)?.name ?? null) !== current.activeName) await recovery.setActive(current.activeName ?? '');
            if (current.script === null) await removeScript(recovery, SCRIPT_NAME);
            const actual = await recovery.listScripts();
            const bytes = actual.some(row => row.name === SCRIPT_NAME) ? await recovery.getScript(SCRIPT_NAME) : null;
            if (bytes !== current.script || (actual.find(row => row.active)?.name ?? null) !== current.activeName) return false;
            if (current.activeName && current.activeName !== SCRIPT_NAME
              && (!actual.some(row => row.name === current.activeName) || await recovery.getScript(current.activeName) !== activeScript)) return false;
            if (await recovery.getScript(importName) !== encodeImportRecord(record)) return false;
            if (current.script !== null && await recovery.getScript(undoWebmailName) !== current.script) return false;
            if (current.activeName && current.activeName !== SCRIPT_NAME && await recovery.getScript(undoActiveName) !== activeScript) return false;
            return true;
          });
        } catch { /* Report uncertainty; the archive remains available for recovery. */ }
      }
      const error = new AppError(502, 'IMPORT_WRITE_FAILED', restored ? '적용하지 못했어요. 필터는 그대로예요.' : '적용을 마치지 못했어요. 현재 필터 상태를 다시 확인해 주세요.');
      error.detail = { restored }; throw error;
    }
    return { rev: doc.rev, applied: rules.length, dropped: record.dropped.length + (record.droppedTruncated ?? 0), createdFolders,
      ...(current.activeName && current.activeName !== SCRIPT_NAME ? { deactivated: current.activeName } : {}) };
  }
  async function importXml(session, body) {
    xmlInput(body, true);
    const { entries } = readGmailXml(body.xml);
    const initial = await perform(session, null, async (client, current, policy) => {
      const plan = await xmlPlan(client, current, policy, body, entries);
      if (canonicalJSON(plan.expect) !== canonicalJSON(body.expect)) throw previewChanged();
      if (!plan.rules.length) throw nothing();
      return plan;
    });
    // This IMAP operation is deliberately outside the Sieve lock.
    const createdFolders = await createImportFolders(session, initial.newFolders);
    return perform(session, null, async (client, current, policy) => {
      const plan = await xmlPlan(client, current, policy, body, entries, initial.newFolders);
      if (canonicalJSON(plan.expect) !== canonicalJSON(body.expect) || initial.newFolders.some(path => !policy.folders.some(folder => folder.path === path && allowedMoveFolder(folder)))) throw previewChanged();
      return applyImport(session, client, current, policy, { ...plan, source: { kind: 'gmail-xml', name: body.fileName, sha256: sha256(body.xml) }, createdFolders });
    });
  }
  async function importRules(session, body) {
    object(body, ['confirm', 'sourceName', 'sourceSha256', 'planSha256']);
    if (body.confirm !== true) invalid('confirm', 'confirmation_required');
    if (typeof body.sourceName !== 'string' || typeof body.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sourceSha256) || typeof body.planSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.planSha256)) invalid('sourceSha256', 'source');
    return perform(session, null, async (client, current, policy) => {
      allowed(current, ['import_pending', 'import_blocked']);
      if (body.sourceName !== current.activeName || body.sourceSha256 !== sha256(current.source)
        || body.planSha256 !== current.importReport.planSha256) throw previewChanged();
      return applyImport(session, client, current, policy, { rules: current.importReport.rules, items: current.importReport.items, mode: 'new', source: { kind: 'active-script', name: current.activeName, sha256: sha256(current.source) } });
    });
  }
  async function undoImport(session, body) {
    object(body, ['at', 'acceptEdits']);
    if (typeof body.at !== 'string' || !Number.isFinite(Date.parse(body.at))) invalid('at', 'timestamp');
    if (Object.hasOwn(body, 'acceptEdits') && body.acceptEdits !== true) invalid('acceptEdits', 'confirmation_required');
    return perform(session, null, async (client, current) => {
      if (current.state === 'newer_version') throw stateError();
      const record = await readImportRecord(client, current.scripts);
      if (!record || record.at !== body.at) throw undoError('UNDO_UNAVAILABLE');
      const before = record.undo.webmail;
      const alreadyRestored = (current.script === null ? null : sha256(current.script)) === (before.present ? before.sha256 : null);
      if (!alreadyRestored && (current.script === null || sha256(current.script) !== record.undo.afterSha256) && body.acceptEdits !== true) throw undoError('UNDO_EDITED');
      const active = record.undo.active;
      let webmailCopy, activeCopy;
      if (before.present && !alreadyRestored) {
        if (!current.scripts.some(script => script.name === undoWebmailName)) throw undoError('UNDO_UNAVAILABLE');
        webmailCopy = await client.getScript(undoWebmailName);
        if (sha256(webmailCopy) !== before.sha256) throw undoError('UNDO_UNAVAILABLE');
      }
      if (active.name && active.name !== SCRIPT_NAME) {
        if (current.scripts.some(script => script.name === active.name)) {
          if (sha256(await client.getScript(active.name)) !== active.sha256) throw undoError('UNDO_SOURCE_CHANGED');
        } else {
          if (!current.scripts.some(script => script.name === undoActiveName)) throw undoError('UNDO_UNAVAILABLE');
          activeCopy = await client.getScript(undoActiveName);
          if (sha256(activeCopy) !== active.sha256) throw undoError('UNDO_UNAVAILABLE');
        }
      }
      try {
        if (activeCopy !== undefined) await client.putScript(active.name, activeCopy);
        if (webmailCopy !== undefined) await client.putScript(SCRIPT_NAME, webmailCopy);
        if (!before.present) {
          // An active script cannot be deleted; restore the former selection first.
          await client.setActive(active.name ?? '');
          await removeScript(client, SCRIPT_NAME);
        } else await client.setActive(active.name ?? '');
        await removeScript(client, undoWebmailName);
        await removeScript(client, undoActiveName);
        await removeScript(client, importName);
      } catch {
        const error = new AppError(502, 'IMPORT_WRITE_FAILED', '되돌리기를 마치지 못했어요. 다시 시도해 주세요.');
        error.detail = { restored: false }; throw error;
      }
      const parsed = before.present ? parseScript(webmailCopy ?? current.script) : null;
      return { ...(parsed?.rev !== null && parsed?.rev !== undefined ? { rev: parsed.rev } : {}), restored: before.present ? 'webmail' : 'none', ...(active.name ? { activeName: active.name } : {}) };
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
  return { get, save, reactivate, restore, importRules, previewXml, importXml, undoImport, getState, renameFolderRefs, folderInUse, preview: previewRule, applyExisting };
}
