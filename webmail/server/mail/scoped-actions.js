import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError } from '../errors.js';
import { allmail, scopeOptions, resolveListScope, sortUids, resolveCandidateSources, checkBudget } from './list-query.js';
import { mailboxRights } from './folders.js';
import { createActionService } from './actions.js';
import { createListService } from './list.js';
import { listOptions } from './list-query.js';
import { encodeRef, decodeRef } from './ref.js';

const ttlMs = 30 * 60_000, memoryLimit = 32 * 1024 * 1024;
const actions = new Set(['seen', 'unseen', 'flag', 'unflag', 'move', 'archive', 'trash', 'spam', 'notspam', 'delete-forever']);
const token = () => randomBytes(32).toString('base64url');
const special = path => /^(Shared|WebmailVirtual)(\/|$)/.test(path);
const fail = (status, code, message) => new AppError(status, code, message);
const stale = () => fail(409, 'STALE_SCOPE', '메일함이 바뀌었어요. 다시 선택해 주세요.');
const mismatch = () => fail(409, 'SCOPE_CURSOR_MISMATCH', '선택 조건이 바뀌었어요. 다시 선택해 주세요.');
const expired = () => fail(409, 'SCOPE_EXPIRED', '선택이 만료됐어요. 다시 선택해 주세요.');
const limit = () => fail(429, 'SCOPE_LIMIT', '선택 보관 한도에 도달했어요. 잠시 뒤 다시 시도해 주세요.');
const invalid = () => fail(400, 'SCOPE_CURSOR_INVALID', '선택 요청을 확인해 주세요.');
const requestBudget = () => { const start = performance.now(); return { remainingMs: () => 50000 - (performance.now() - start) }; };
function canonicalScope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['view', 'folder', 'quick', 'q', 'in'].includes(key))) throw invalid();
  scopeOptions(input);
  return { view: input.view ?? 'inbox', folder: input.folder ?? '', quick: input.quick ?? 'all', q: input.q ?? '', in: input.in ?? '' };
}
function validateAction(action, target) {
  if (!actions.has(action)) throw fail(422, 'INVALID_ACTION', '메일 동작을 확인해 주세요.');
  if (action === 'move' && (typeof target !== 'string' || !target || /[\0\r\n]/.test(target) || special(target))) throw fail(422, 'FOLDER_NOT_ALLOWED', '이동할 폴더를 확인해 주세요.');
  if (action !== 'move' && target !== undefined) throw invalid();
}
function fence(client, path) {
  const uidValidity = Number(client.mailbox?.uidValidity), next = Number(client.mailbox?.uidNext);
  if (client.mailbox?.path !== path || !Number.isInteger(uidValidity) || uidValidity < 1 || uidValidity > 0xffffffff || !Number.isInteger(next) || next < 1 || next > 0x100000000) throw stale();
  return { path, uidValidity, upper: next - 1 };
}
function assertFence(client, boundary) {
  if (client.mailbox?.path !== boundary.path || Number(client.mailbox?.uidValidity) !== boundary.uidValidity) throw stale();
}
function scrub(record) {
  for (const key of Object.keys(record)) delete record[key];
  record.disposed = true;
  record.manifest = []; record.pendingUids = []; record.sources = {}; record.receipts = {};
  record.resolvedScope = null;
  // S2 can keep its own receipts/failure records here; clear those on logout too.
  record.runReceipts = {}; record.failures = [];
}

export function createScopedActionService({ imap, now = Date.now }) {
  const stores = new WeakMap();
  function runCursor(store) {
    const nonce = randomBytes(16);
    return Buffer.concat([nonce, createHmac('sha256', store.cursorKey).update(nonce).digest().subarray(0, 16)]).toString('base64url');
  }
  function ownsCursor(store, cursor) {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== cursor) return false;
    const signature = createHmac('sha256', store.cursorKey).update(bytes.subarray(0, 16)).digest().subarray(0, 16);
    return timingSafeEqual(signature, bytes.subarray(16));
  }
  const actionService = createActionService({ imap }), listService = createListService({ imap, now });
  function sweep(store) {
    for (const [id, record] of store.records) if (now() - record.lastSeen >= ttlMs) {
      store.records.delete(id); store.keys.delete(record.selectionKey); scrub(record);
    }
  }
  function schedule(store) {
    clearTimeout(store.timer);
    if (!store.records.size || store.closed) return;
    const delay = Math.max(1, Math.min(...[...store.records.values()].map(record => record.lastSeen + ttlMs - now())));
    store.timer = setTimeout(() => { sweep(store); schedule(store); }, delay);
    store.timer.unref?.();
  }
  function storeFor(session) {
    if (session.scanAbort?.signal.aborted) throw fail(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
    let store = stores.get(session);
    if (!store) {
      store = { records: new Map(), keys: new Map(), timer: null, closed: false, cursorKey: randomBytes(32) };
      stores.set(session, store);
      session.scanAbort?.signal.addEventListener('abort', () => {
        store.closed = true; clearTimeout(store.timer); store.cursorKey.fill(0);
        for (const record of store.records.values()) scrub(record);
        store.records.clear(); store.keys.clear(); stores.delete(session);
      }, { once: true });
    }
    sweep(store); schedule(store); return store;
  }
  function live(store, record) {
    if (store.closed) throw fail(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.');
    if (record.disposed || !store.records.has(record.selectionId)) throw expired();
  }
  function touch(store, record) {
    live(store, record); record.lastSeen = now(); record.expiresAt = new Date(record.lastSeen + ttlMs).toISOString(); schedule(store);
  }
  // S2 must call this after adding run receipts/failures and before returning a cursor.
  function checkStorage(session) {
    const store = storeFor(session);
    const bytes = [...store.records.values()].reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)) + 1024 + (record.reserveBytes ?? 0), 0);
    if (bytes > memoryLimit) throw limit();
    return bytes;
  }
  function getSelection(session, id) {
    const store = storeFor(session), record = store.records.get(id);
    if (!record) throw expired();
    touch(store, record); return record;
  }
  async function mailbox(session, store, record, path, budget, operation) {
    live(store, record); checkBudget(budget);
    let result;
    try {
      result = await imap.withMailbox(session, path, async client => {
        live(store, record); checkBudget(budget);
        return operation(client);
      }, { budget });
    } catch (error) {
      if (error.code === 'NotFound' || error.serverResponseCode === 'NONEXISTENT') {
        if (path === allmail) throw fail(503, 'ALLMAIL_UNAVAILABLE', '전체편지함을 사용할 수 없어요. 관리자에게 문의해 주세요.');
        if (record.stage === 'fences' || record.stage === 'preflight') throw stale();
      }
      throw error;
    }
    live(store, record); return result;
  }
  async function bindAction(session, store, record, budget) {
    if (record.action === 'delete-forever' && record.manifest.some(group => !['Trash', 'Junk'].includes(group.path))) throw fail(422, 'DELETE_NOT_ALLOWED', '영구 삭제는 휴지통이나 스팸함에서만 할 수 있어요.');
    // Each step is persisted only after its mailbox operation has completed.
    while (record.preflightIndex < record.manifest.length) {
      const group = record.manifest[record.preflightIndex];
      const allowed = await mailbox(session, store, record, group.path, budget, async client => {
        assertFence(client, group);
        if (special(group.path)) return false;
        const rights = await mailboxRights(client, group.path);
        live(store, record); checkBudget(budget);
        return ['seen', 'unseen'].includes(record.action) ? rights.seen : ['flag', 'unflag'].includes(record.action) ? rights.write : rights.delete;
      });
      record.writable ||= allowed; record.preflightIndex++;
    }
    if (record.initialTotal && !record.writable) throw fail(403, 'FOLDER_READONLY', '이 폴더는 변경할 수 없어요.');
    if (record.action === 'archive' && !record.resolvedTarget) {
      const destination = await mailbox(session, store, record, 'INBOX', budget, async client => {
        const folders = await client.list();
        live(store, record); checkBudget(budget);
        const path = folders.find(folder => folder.specialUse === '\\Archive' && !special(folder.path))?.path ?? 'Archive';
        return { path, create: !folders.some(folder => folder.path === path) };
      });
      record.resolvedTarget = destination.path; record.targetNeedsCreate = destination.create;
    }
    initializeRun(record);
    record.phase = 'ready'; record.cursor = runCursor(store); record.stage = 'done';
    checkStorage(session);
  }
  async function advance(session, store, record, budget) {
    if (!record.resolvedScope) {
      const resolved = await resolveListScope(session, record.scope, { imap, budget });
      live(store, record); record.resolvedScope = resolved;
    }
    live(store, record);
    if (record.stage === 'search') {
      const snapshot = await mailbox(session, store, record, record.resolvedScope.mailbox, budget, async client => {
        const boundary = fence(client, record.resolvedScope.mailbox), capturedAt = new Date(now()).toISOString();
        const uids = boundary.upper === 0 ? [] : await sortUids(client, record.resolvedScope.imap, record.resolvedScope.searching, { budget });
        live(store, record); assertFence(client, boundary);
        return { boundary, capturedAt, uids: [...new Set(uids.filter(uid => uid <= boundary.upper))].sort((a, b) => a - b) };
      });
      record.boundary = snapshot.boundary; record.pendingUids = snapshot.uids;
      record.cutoff = { kind: 'uid-fences', capturedAt: snapshot.capturedAt };
      record.totalEstimate = snapshot.uids.length; record.stage = 'mapping'; checkStorage(session);
    }
    while (record.stage === 'mapping' && record.mappingIndex < record.pendingUids.length) {
      const uids = record.pendingUids.slice(record.mappingIndex, record.mappingIndex + 50);
      const sources = await mailbox(session, store, record, record.boundary.path, budget, async client => {
        assertFence(client, record.boundary);
        const rows = await resolveCandidateSources(client, session, uids, record.resolvedScope, { freshValidity: true, budget, now });
        live(store, record); assertFence(client, record.boundary); return rows;
      });
      for (const source of sources) {
        let group = record.sources[source.path];
        if (!group) group = record.sources[source.path] = { path: source.path, uidValidity: source.uidValidity, uids: [] };
        if (group.uidValidity !== source.uidValidity) throw stale();
        group.uids.push(source.uid);
      }
      record.mappingIndex += uids.length; checkStorage(session);
    }
    if (record.stage === 'mapping') {
      record.manifest = Object.values(record.sources).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(group => ({ ...group, uids: [...new Set(group.uids)].sort((a, b) => a - b) }));
      record.sources = {}; record.pendingUids = []; record.stage = 'fences';
    }
    while (record.stage === 'fences' && record.fenceIndex < record.manifest.length) {
      const group = record.manifest[record.fenceIndex];
      const boundary = await mailbox(session, store, record, group.path, budget, client => {
        assertFence(client, group);
        return record.boundary.path === group.path ? record.boundary : fence(client, group.path);
      });
      if (group.uids.some(uid => uid > boundary.upper)) throw stale();
      group.upper = boundary.upper; record.fenceIndex++;
    }
    if (record.stage === 'fences') {
      record.initialTotal = record.manifest.reduce((sum, group) => sum + group.uids.length, 0);
      record.stage = 'preflight';
    }
    if (record.stage === 'preflight') await bindAction(session, store, record, budget);
  }
  function response(record) {
    return { selectionId: record.selectionId, phase: record.phase, cursor: record.cursor, totalEstimate: record.totalEstimate, initialTotal: record.initialTotal, expiresAt: record.expiresAt, ...(record.phase === 'ready' ? { cutoff: record.cutoff } : {}) };
  }
  async function prepare(session, body, { budget = requestBudget() } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['selectionKey', 'scope', 'action', 'target', 'cursor', 'selectionId', 'retry'].includes(key)) || typeof body.selectionKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.selectionKey) || (body.cursor != null && (typeof body.cursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.cursor)))) throw invalid();
    if (typeof budget?.remainingMs !== 'function' || (body.retry !== undefined && body.retry !== 'failed') || ((body.retry === 'failed') !== (typeof body.selectionId === 'string')) || (body.selectionId !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(body.selectionId))) throw invalid();
    const scope = canonicalScope(body.scope), scopeKey = JSON.stringify(scope);
    validateAction(body.action, body.target);
    const store = storeFor(session);
    let record = store.records.get(store.keys.get(body.selectionKey));
    if (record && (record.scopeKey !== scopeKey || record.action !== body.action || record.target !== body.target || record.retryFrom !== body.selectionId)) throw mismatch();
    if (!record) {
      if (body.cursor != null) throw mismatch();
      const closed = item => ['completed', 'error', 'stopped'].includes(item.phase);
      if ([...store.records.values()].some(item => !closed(item) && (item.busy || item.readers))) throw fail(409, 'SCOPE_BUSY', '선택을 처리 중이에요. 잠시 뒤 다시 시도해 주세요.');
      record = { selectionId: token(), selectionKey: body.selectionKey, scope, scopeKey, action: body.action, target: body.target,
        resolvedTarget: { move: body.target, trash: 'Trash', spam: 'Junk', notspam: 'INBOX' }[body.action] ?? null,
        targetNeedsCreate: false, targetCreateAttempted: false, targetReady: false,
        phase: 'preparing', stage: 'search', resolvedScope: null, boundary: null, manifest: [], sources: Object.create(null), pendingUids: [],
        mappingIndex: 0, fenceIndex: 0, preflightIndex: 0, writable: false, totalEstimate: 0, initialTotal: null,
        receipts: {}, cursor: null, busy: false, lastSeen: now(), expiresAt: null, retryFrom: body.selectionId };
      if (body.retry === 'failed') {
        const source = getSelection(session, body.selectionId);
        if (source.scopeKey !== scopeKey || source.action !== body.action || source.target !== body.target) throw mismatch();
        const groups = new Map();
        for (const item of source.failures ?? []) if (item.retryable) {
          const ref = decodeRef(item.ref);
          let group = groups.get(ref.path);
          if (!group) { group = { path: ref.path, uidValidity: ref.uidValidity, uids: [] }; groups.set(ref.path, group); }
          if (group.uidValidity !== ref.uidValidity) throw stale();
          group.uids.push(ref.uid);
        }
        record.manifest = [...groups.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(group => ({ ...group, uids: [...new Set(group.uids)].sort((a, b) => a - b) }));
        record.stage = 'fences'; record.resolvedScope = structuredClone(source.resolvedScope); record.boundary = structuredClone(source.boundary);
        record.cutoff = structuredClone(source.cutoff); record.totalEstimate = record.manifest.reduce((sum, group) => sum + group.uids.length, 0);
        record.resolvedTarget = source.resolvedTarget; record.targetNeedsCreate = source.targetNeedsCreate && !source.targetReady;
      }
      for (const item of store.records.values()) if (!closed(item)) {
        item.phase = 'stopped'; item.reserveBytes = 0;
      }
      while (store.records.size >= 3) {
        // Map insertion order is the immutable creation order, independent of reads.
        const oldest = [...store.records.values()].find(item => closed(item) && !item.busy && !item.readers);
        if (!oldest) throw limit();
        store.records.delete(oldest.selectionId); store.keys.delete(oldest.selectionKey); scrub(oldest);
      }
      if (checkStorage(session) + Buffer.byteLength(JSON.stringify(record)) + 1024 > memoryLimit) throw limit();
      store.records.set(record.selectionId, record); store.keys.set(record.selectionKey, record.selectionId);
    }
    touch(store, record);
    if (record.busy) throw fail(409, 'SCOPE_BUSY', '선택을 준비 중이에요. 잠시 뒤 다시 시도해 주세요.');
    if (record.phase === 'stopped') throw expired();
    const key = body.cursor ?? 'initial';
    if (record.receipts[key]) return structuredClone(record.receipts[key]);
    if (record.error) throw fail(record.error.statusCode, record.error.code, record.error.message);
    if (record.phase !== 'preparing') throw invalid();
    if (body.cursor !== record.cursor && !(body.cursor == null && record.cursor === null)) throw mismatch();
    record.busy = true;
    try {
      try { await advance(session, store, record, budget); }
      catch (error) {
        if (!error.budgetExhausted) throw error;
        live(store, record);
        // An initial SEARCH that cannot finish must not be retried forever.
        if (record.stage === 'search') throw fail(503, record.resolvedScope?.searching ? 'SEARCH_SLOW' : 'MAIL_UNAVAILABLE', '메일함 조회 시간이 다 됐어요. 잠시 뒤 다시 선택해 주세요.');
      }
      live(store, record);
      if (record.phase === 'preparing') record.cursor = token();
      touch(store, record);
      const result = response(record); record.receipts[key] = structuredClone(result);
      checkStorage(session); return result;
    } catch (error) {
      if (!record.disposed) {
        record.phase = 'error'; record.error = { statusCode: error instanceof AppError ? error.statusCode : 503, code: error instanceof AppError ? error.code : 'MAIL_UNAVAILABLE', message: error instanceof AppError ? error.message : '메일 서버에 연결할 수 없어요.' };
        record.manifest = []; record.pendingUids = []; record.sources = {}; record.reserveBytes = 0; delete record.receipts[key];
      }
      if (error instanceof AppError) throw error;
      throw fail(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요.');
    } finally { record.busy = false; }
  }
  // Call under S2's record.busy guard immediately before its first mutation.
  async function ensureTarget(session, id, { budget = requestBudget() } = {}) {
    const store = storeFor(session), record = getSelection(session, id);
    if (record.phase !== 'ready' && record.phase !== 'running') throw fail(409, 'SELECTION_NOT_READY', '전체 선택 준비를 마쳐 주세요.');
    if (record.targetReady || record.initialTotal === 0) return record.resolvedTarget;
    if (record.targetNeedsCreate) {
      if (record.targetCreateAttempted) throw fail(502, 'MAIL_REJECTED', '보관함 생성 결과를 확인해 주세요.');
      await mailbox(session, store, record, 'INBOX', budget, async client => {
        checkBudget(budget);
        if (budget.remainingMs() < 10000) throw Object.assign(fail(503, 'MAIL_UNAVAILABLE', '메일 처리 시간이 다 됐어요.'), { budgetExhausted: true });
        record.targetCreateAttempted = true;
        if (!await client.mailboxCreate(record.resolvedTarget)) throw fail(502, 'MAIL_REJECTED', '보관함을 만들지 못했어요.');
      });
    }
    live(store, record); record.targetReady = true; return record.resolvedTarget;
  }

  // Reserve the largest per-candidate failure, cursor and receipt representation.
  // Request overhead is admitted separately, including requests that settle nothing.
  const candidateBytes = ref => 1024 + 4 * Buffer.byteLength(JSON.stringify(ref));
  function initializeRun(record) {
    record.outcomes = record.manifest.map(group => group.uids.map(() => 0));
    record.totals = { processed: 0, skipped: 0, failed: 0 };
    record.failures = []; record.runReceipts = {}; record.sequence = 0;
    record.errorCounts = {}; record.reserveBytes = 8192;
    for (const group of record.manifest) for (const uid of group.uids) record.reserveBytes += candidateBytes(encodeRef(group.path, group.uidValidity, uid));
  }
  function remaining(record) {
    return record.initialTotal - record.totals.processed - record.totals.skipped - record.totals.failed;
  }
  function replay(entry) {
    if (entry.statusCode !== 200) {
      const error = fail(entry.statusCode, entry.receipt.error.code, '전체 선택 처리가 중단됐어요. 결과를 확인해 주세요.');
      error.detail = structuredClone(entry.receipt); throw error;
    }
    return structuredClone(entry.receipt);
  }
  function findCursor(store, cursor) {
    for (const record of store.records.values()) {
      if (record.cursor === cursor || record.runReceipts?.[cursor] || Object.values(record.receipts).some(receipt => receipt.cursor === cursor)) return record;
    }
    if (ownsCursor(store, cursor)) throw expired();
    throw mismatch();
  }
  function plannedGroups(record) {
    const groups = []; let count = 0;
    for (let g = 0; g < record.manifest.length && count < 1000; g++) {
      const group = record.manifest[g]; let indices = [];
      for (let index = 0; index < group.uids.length && count < 1000; index++) {
        if (record.outcomes[g][index]) continue;
        indices.push(index); count++;
        if (indices.length === 50) { groups.push({ g, indices }); indices = []; }
      }
      if (indices.length) groups.push({ g, indices });
    }
    return groups;
  }
  async function execute(session, body, { budget = requestBudget() } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['scope', 'cursor', 'action', 'target'].includes(key)) || typeof body.cursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.cursor) || typeof budget?.remainingMs !== 'function') throw invalid();
    const scopeKey = JSON.stringify(canonicalScope(body.scope));
    const store = storeFor(session), record = findCursor(store, body.cursor);
    if (record.scopeKey !== scopeKey || record.action !== body.action || record.target !== body.target) throw mismatch();
    touch(store, record);
    if (record.busy) throw fail(409, 'SCOPE_BUSY', '메일을 처리 중이에요. 잠시 뒤 다시 시도해 주세요.');
    if (record.phase === 'stopped') throw expired();
    if (record.runReceipts?.[body.cursor]) return replay(record.runReceipts[body.cursor]);
    if (record.phase === 'preparing') throw fail(409, 'SELECTION_NOT_READY', '전체 선택 준비를 마쳐 주세요.');
    if (!['ready', 'running'].includes(record.phase) || record.cursor !== body.cursor) throw invalid();
    // This overhead admission precedes CREATE and every mail mutation.
    record.reserveBytes += 2048;
    try { checkStorage(session); } catch (error) { record.reserveBytes -= 2048; throw error; }
    record.busy = true;
    const started = performance.now(), sequence = record.sequence;
    const before = { ...record.totals }, newFailures = [];
    let reservedUsed = 0, reason = 'batch', terminal, active = true;
    const settle = (g, indices, refs) => {
      const positions = new Map(refs.map((ref, index) => [ref, indices[index]]));
      return outcome => {
        if (!active || store.closed || record.disposed) return;
        const index = positions.get(outcome.ref);
        if (index === undefined || record.outcomes[g][index]) return;
        record.outcomes[g][index] = { processed: 1, skipped: 2, failed: 3, unknown: 4 }[outcome.status];
        if (outcome.status === 'processed' || outcome.status === 'skipped') record.totals[outcome.status]++;
        else {
          record.totals.failed++;
          const failure = { ref: outcome.ref, code: outcome.code, retryable: outcome.status !== 'unknown' && outcome.retryable === true };
          record.failures.push(failure); newFailures.push(failure);
          record.errorCounts[failure.code] = (record.errorCounts[failure.code] ?? 0) + 1;
        }
        reservedUsed += candidateBytes(outcome.ref);
      };
    };
    try {
      for (const { g, indices } of plannedGroups(record)) {
        live(store, record);
        if (budget.remainingMs() < 10000) { reason = 'budget'; break; }
        const group = record.manifest[g], refs = indices.map(index => encodeRef(group.path, group.uidValidity, group.uids[index]));
        if (record.targetNeedsCreate && !record.targetReady) {
          // Reject a replaced source before creating the deferred archive folder.
          await mailbox(session, store, record, group.path, budget, client => assertFence(client, group));
        }
        await ensureTarget(session, record.selectionId, { budget });
        live(store, record); record.phase = 'running';
        const onOutcome = settle(g, indices, refs);
        const result = await actionService.runScopedGroup(session, {
          refs, action: record.action, resolvedTarget: record.resolvedTarget,
          resolvedScope: record.resolvedScope, budget, minStartRemainingMs: 10000, onOutcome,
        });
        live(store, record);
        if (result.reason === 'budget' || result.remaining.length) { reason = 'budget'; break; }
      }
    } catch (error) {
      if (record.disposed || store.closed || ['NO_SESSION', 'SESSION_EXPIRED'].includes(error.code)) throw error;
      if (error.budgetExhausted && !record.targetCreateAttempted) reason = 'budget';
      else terminal = { statusCode: error instanceof AppError ? error.statusCode : 503, code: error instanceof AppError ? error.code : 'MAIL_UNAVAILABLE' };
    } finally { active = false; record.busy = false; }
    live(store, record);
    const left = remaining(record), completed = left === 0 && !terminal;
    const nextCursor = terminal || completed ? null : runCursor(store);
    record.phase = terminal ? 'error' : completed ? 'completed' : 'running';
    record.cursor = nextCursor; record.sequence++;
    const receipt = {
      selectionId: record.selectionId, batchId: `${record.selectionId}:${sequence}`, sequence,
      state: terminal ? 'stopped' : completed ? 'completed' : 'running',
      reason: terminal ? terminal.code === 'STALE_SCOPE' ? 'stale_scope' : 'error' : completed ? 'complete' : reason,
      initialTotal: record.initialTotal,
      delta: Object.fromEntries(Object.keys(before).map(key => [key, record.totals[key] - before[key]])),
      totals: { ...record.totals }, failed: newFailures,
      nextCursor, remainingEstimate: left, elapsedMs: Math.round(performance.now() - started),
      ...(terminal ? { error: { code: terminal.code } } : {}),
    };
    record.runReceipts[body.cursor] = { statusCode: terminal?.statusCode ?? 200, receipt: structuredClone(receipt) };
    record.reserveBytes = terminal || completed ? 0 : record.reserveBytes - reservedUsed - 2048;
    touch(store, record);
    // The admitted reserve includes all outcomes and this immutable receipt.
    checkStorage(session);
    return replay(record.runReceipts[body.cursor]);
  }
  async function failures(session, id, query = {}, { budget = requestBudget() } = {}) {
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['page', 'pageSize'].includes(key)) || typeof budget?.remainingMs !== 'function') throw invalid();
    const pagination = Object.fromEntries(Object.entries(query).map(([key, value]) => [key, typeof value === 'number' ? String(value) : value]));
    const { page, pageSize } = listOptions(pagination);
    const record = getSelection(session, id), store = storeFor(session);
    record.readers = (record.readers ?? 0) + 1;
    try {
      const source = (record.failures ?? []).slice((page - 1) * pageSize, page * pageSize);
      const groups = new Map(), metadata = new Map();
      for (const failure of source) {
        const ref = decodeRef(failure.ref), key = JSON.stringify([ref.path, ref.uidValidity]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(failure.ref);
      }
      for (const refs of groups.values()) {
        live(store, record); checkBudget(budget);
        try {
          for (const item of await listService.metadata(session, refs, { budget })) metadata.set(item.ref, item);
        } catch (error) {
          if (!['STALE_REF', 'MESSAGE_NOT_FOUND'].includes(error.code)) {
            if (error instanceof AppError) throw error;
            throw fail(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요.');
          }
        }
        live(store, record);
      }
      return { total: record.failures?.length ?? 0, page, pageSize, items: source.map(failure => ({ ...(metadata.get(failure.ref) ?? { ref: failure.ref, unavailable: true }), ...failure })) };
    } finally { if (!record.disposed) record.readers--; }
  }
  return { prepare, execute, failures, getSelection, ensureTarget, checkStorage };
}
