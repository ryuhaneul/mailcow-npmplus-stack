import * as nativeFs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { AppError } from '../errors.js';
import { createResourceLock } from './lock.js';

const MAX_BYTES = 4 * 1024 * 1024;
const statuses = ['running', 'done', 'cutoff', 'failed', 'unknown'];
const fail = (code, message) => new AppError(409, code, message);
const dayOf = time => new Date(time + 9 * 3_600_000).toISOString().slice(0, 10);
const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
  !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
const text = value => typeof value === 'string' && value.trim().length > 0;
const folder = value => value && text(value.user) && text(value.mailbox);
const unlisted = value => value && text(value.user) && value.mailbox === null && value.guid === null &&
  value.result === 'unmeasured' && value.before?.status === 'unmeasured' &&
  value.before?.user === value.user && value.before?.mailbox === null && value.before?.guid === null &&
  value.before?.reason === 'measurement-failed' && value.after === null;
const evidenceValid = value => value && ['by', 'at', 'reason'].every(key => text(value[key])) &&
  Number.isFinite(Date.parse(value.at)) && value.remoteStopped === true;
function validState(value) {
  return value?.v === 1 && value.runIds && typeof value.runIds === 'object' && !Array.isArray(value.runIds) &&
    Object.entries(value.runIds).every(([day, id]) => validDay(day) && text(id)) &&
    Array.isArray(value.unlockHistory) && value.unlockHistory.every(evidenceValid) &&
    (value.runId === null ? value.day === null && value.status === null :
      text(value.runId) && validDay(value.day) && value.runIds[value.day] === value.runId && statuses.includes(value.status) && text(value.startedAt)) &&
    (value.finishedAt === null || text(value.finishedAt)) &&
    (value.current === null || folder(value.current) && text(value.current.guid)) && Array.isArray(value.folders) &&
    value.folders.every(item => (folder(item) || unlisted(item)) && (item.guid === null || text(item.guid)) && ['before', 'after', 'result', 'error'].every(key => Object.hasOwn(item, key))) &&
    (value.remoteUnknown === null || (folder(value.remoteUnknown) || value.remoteUnknown?.reason === 'restart' &&
      value.remoteUnknown.user === null && value.remoteUnknown.mailbox === null) && text(value.remoteUnknown.at)) &&
    typeof value.indexBlocked === 'boolean' && (!value.remoteUnknown || value.indexBlocked === true);
}
const emptyState = () => ({ v: 1, runId: null, day: null, status: null, startedAt: null, finishedAt: null,
  current: null, folders: [], remoteUnknown: null, indexBlocked: false, runIds: {}, unlockHistory: [] });

// All instances must share this directory on the same host/volume. A leftover
// lock, including an incomplete owner record, is never reclaimed automatically.
// acquire(): token or null (busy); read(): {state, damaged, code?}.
// startRun()/save()/markRemoteUnknown() return the saved state and require this
// instance's ownership. Callers must check indexBlocked before every index.
// Disable scheduling and verify remote completion before manualUnlock().
export function createFtsState({ dir = '/data/fts-nightly', now = Date.now, fs = nativeFs } = {}) {
  const lockDir = join(dir, 'lock');
  const statePath = join(dir, 'state.json');
  const serial = createResourceLock();
  let owned = null;
  const timestamp = () => new Date(now()).toISOString();
  async function syncDir(path) {
    const handle = await fs.open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function init() {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    await syncDir(dirname(dir));
  }
  async function readJson(path) {
    const handle = await fs.open(path, 'r');
    try {
      const { size } = await handle.stat();
      if (size > MAX_BYTES) throw fail('FTS_STATE_CORRUPT', '색인 상태 파일이 너무 커요.');
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let sizeRead = 0;
      while (sizeRead < bytes.length) {
        const { bytesRead } = await handle.read(bytes, sizeRead, bytes.length - sizeRead, sizeRead);
        if (!bytesRead) break;
        sizeRead += bytesRead;
      }
      if (sizeRead > MAX_BYTES) throw fail('FTS_STATE_CORRUPT', '색인 상태 파일이 너무 커요.');
      return JSON.parse(bytes.subarray(0, sizeRead).toString('utf8'));
    } finally { await handle.close(); }
  }
  async function read() {
    try {
      const state = await readJson(statePath);
      if (!validState(state)) throw fail('FTS_STATE_CORRUPT', '색인 상태 파일을 확인해 주세요.');
      return { state, damaged: false };
    } catch (error) {
      if (error.code === 'ENOENT') return { state: null, damaged: false };
      if (error instanceof SyntaxError || error.code === 'FTS_STATE_CORRUPT')
        return { state: null, damaged: true, code: 'FTS_STATE_CORRUPT' };
      throw error;
    }
  }
  async function load() {
    const result = await read();
    if (result.damaged) throw fail('FTS_STATE_CORRUPT', '색인 상태 파일이 손상됐어요. 복구가 필요해요.');
    return result.state ?? emptyState();
  }
  async function write(state) {
    if (!validState(state)) throw fail('FTS_STATE_INVALID', '색인 상태 형식을 확인해 주세요.');
    const bytes = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw fail('FTS_STATE_INVALID', '색인 상태 파일이 너무 커요.');
    const temp = join(dir, `.state-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, statePath);
      await syncDir(dir);
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function assertOwner(token = owned) {
    if (!token || token !== owned) throw fail('FTS_LOCK_OWNER', '색인 잠금 소유자가 아니에요.');
    try {
      const owner = await readJson(join(lockDir, `${token}.json`));
      if (owner.token !== token) throw new Error();
    } catch { throw fail('FTS_LOCK_OWNER', '색인 잠금 소유자를 확인할 수 없어요.'); }
  }
  async function acquire() {
    return serial.run('state', async () => {
      await init();
      try { await fs.mkdir(lockDir, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') return null; throw error; }
      const token = randomUUID();
      // On any failure leave the lock in place; never guess whether work ended.
      const handle = await fs.open(join(lockDir, `${token}.json`), 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ v: 1, token, pid: process.pid, acquiredAt: timestamp() })); await handle.sync(); }
      finally { await handle.close(); }
      await syncDir(lockDir);
      await syncDir(dir);
      owned = token;
      return token;
    });
  }
  async function removeLock(token) {
    // Unique filenames ensure an old owner cannot unlink a successor's record.
    await fs.unlink(join(lockDir, `${token}.json`));
    await fs.rmdir(lockDir);
    await syncDir(dir);
    if (owned === token) owned = null;
  }
  async function release(token = owned) {
    return serial.run('state', async () => {
      await assertOwner(token);
      const state = await load();
      if (state.indexBlocked || state.remoteUnknown || state.current)
        throw fail('FTS_REMOTE_UNKNOWN', '원격 작업 종료 확인 전에는 잠금을 해제할 수 없어요.');
      await removeLock(token);
    });
  }
  async function startRun(kstDay = dayOf(now())) {
    return serial.run('state', async () => {
      await assertOwner();
      if (!validDay(kstDay)) throw fail('FTS_DAY_INVALID', 'KST 실행 날짜를 확인해 주세요.');
      const previous = await load();
      if (previous.indexBlocked || previous.remoteUnknown) throw fail('FTS_REMOTE_UNKNOWN', '원격 작업 종료 확인이 필요해요.');
      if (previous.runIds[kstDay]) throw fail('FTS_ALREADY_RUN', '이 날짜의 색인 실행이 이미 있어요.');
      const runId = `${kstDay}-${randomUUID()}`;
      const state = { ...emptyState(), runId, day: kstDay, status: 'running', startedAt: timestamp(),
        runIds: { ...previous.runIds, [kstDay]: runId }, unlockHistory: previous.unlockHistory };
      await write(state);
      return state;
    });
  }
  async function save(state, token = owned) {
    return serial.run('state', async () => {
      await assertOwner(token);
      const previous = await load();
      if (state.runId !== previous.runId || state.day !== previous.day) throw fail('FTS_STATE_INVALID', '실행 식별자를 바꿀 수 없어요.');
      if ((previous.indexBlocked && !state.indexBlocked) || previous.remoteUnknown &&
        JSON.stringify(previous.remoteUnknown) !== JSON.stringify(state.remoteUnknown))
        throw fail('FTS_REMOTE_UNKNOWN', '원격 작업 종료 확인이 필요해요.');
      const next = { ...state, v: 1, runIds: previous.runIds, unlockHistory: previous.unlockHistory };
      await write(next);
      return next;
    });
  }
  async function markRemoteUnknown(value) {
    return serial.run('state', async () => {
      if (value?.reason === 'restart') {
        const state = await load();
        if (owned || state.remoteUnknown) return state;
        try { await fs.stat(lockDir); }
        catch (error) { if (error.code === 'ENOENT') return state; throw error; }
        if (!state.runId) throw fail('FTS_STATE_INVALID', '시작된 실행이 없어요.');
        state.remoteUnknown = { user: state.current?.user ?? null, mailbox: state.current?.mailbox ?? null,
          at: timestamp(), reason: 'restart' };
        state.indexBlocked = true;
        state.status = 'unknown';
        await write(state);
        return state;
      }
      await assertOwner();
      if (!folder(value)) throw fail('FTS_STATE_INVALID', '원격 작업 폴더를 확인해 주세요.');
      const state = await load();
      if (!state.runId) throw fail('FTS_STATE_INVALID', '시작된 실행이 없어요.');
      state.remoteUnknown = { user: value.user, mailbox: value.mailbox, at: timestamp() };
      state.indexBlocked = true;
      state.status = 'unknown';
      await write(state);
      return state;
    });
  }
  async function manualUnlock(evidence) {
    return serial.run('state', async () => {
      if (!evidenceValid(evidence)) throw fail('FTS_UNLOCK_EVIDENCE', '원격 작업 종료 확인과 해제 증거가 필요해요.');
      const names = await fs.readdir(lockDir);
      const state = await load();
      const records = names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
      if (names.length !== records.length || records.length > 1) throw fail('FTS_LOCK_CORRUPT', '잠금 파일을 확인해 주세요.');
      const record = { by: evidence.by, at: evidence.at, reason: evidence.reason, remoteStopped: true,
        ...(evidence.remeasured !== undefined ? { remeasured: evidence.remeasured } : {}),
        ...(evidence.note !== undefined ? { note: evidence.note } : {}),
        recordedAt: timestamp(), previousRunId: state.runId, previousRemoteUnknown: state.remoteUnknown,
        lockToken: records[0]?.slice(0, -5) ?? null };
      state.unlockHistory.push(record);
      state.remoteUnknown = null;
      state.indexBlocked = false;
      state.current = null;
      if (state.status === 'running' || state.status === 'unknown') { state.status = 'failed'; state.finishedAt = timestamp(); }
      // Evidence must be durable before unlocking. A failure preserves the lock.
      await write(state);
      if (record.lockToken) await removeLock(record.lockToken);
      else { await fs.rmdir(lockDir); await syncDir(dir); owned = null; }
      return state;
    });
  }
  return { acquire, release, startRun, save, read, markRemoteUnknown, manualUnlock };
}
