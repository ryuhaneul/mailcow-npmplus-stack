import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../errors.js';
import { createResourceLock } from './lock.js';

const unavailable = () => new AppError(500, 'AUDIT_UNAVAILABLE', '변경 기록을 남길 수 없어요. 잠시 뒤 다시 시도해 주세요.');
const resultUnavailable = () => new AppError(500, 'AUDIT_RESULT_UNAVAILABLE', '변경은 적용됐지만 결과 기록을 남기지 못했어요. 변경 기록을 확인해 주세요');
const secret = /password|passwd|secret|code|script|key|token|csrf|cookie|session|^(?:body|html|text|subject|messageid)$/i;
export function sanitizeAudit(value) {
  if (Array.isArray(value)) return value.map(sanitizeAudit);
  if (!value || typeof value !== 'object') return value;
  const entries = [];
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '');
    if (['scriptSha256Before', 'scriptSha256After'].includes(key)) {
      if (typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)) entries.push([key, item]);
    } else if (normalized.toLowerCase() === 'password' && ['changed', 'set'].includes(item)) entries.push([key, item]);
    else if (!secret.test(normalized)) entries.push([key, sanitizeAudit(item)]);
  }
  return Object.fromEntries(entries);
}
export function kstTimestamp(time) { return new Date(time + 9 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, '+09:00'); }
const safeCode = error => error instanceof AppError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';

export function createAudit({ dir, now = Date.now, logger, fs = { mkdir, open, readdir, readFile } }) {
  const files = createResourceLock();
  async function append(filename, row) {
    await files.run(filename, async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const handle = await fs.open(join(dir, filename), 'a+', 0o600);
      try {
        await handle.chmod(0o600);
        const { size } = await handle.stat();
        if (size) {
          const last = Buffer.alloc(1);
          await handle.read(last, 0, 1, size - 1);
          if (last[0] !== 10) await handle.writeFile('\n');
        }
        await handle.writeFile(`${JSON.stringify(row)}\n`);
        await handle.sync();
      } finally { await handle.close(); }
    });
  }
  async function run(entry, operation, { prepare } = {}) {
    const ts = kstTimestamp(now());
    const filename = `${ts.slice(0, 7)}.jsonl`;
    const id = randomBytes(16).toString('hex');
    const intent = { v: 1, id, phase: 'intent', ts, actor: entry.actor, ip: entry.ip,
      action: entry.action, target: entry.target, kind: entry.kind,
      revertible: entry.kind === 'config' && entry.revertible === true,
      before: sanitizeAudit(entry.before ?? {}), after: sanitizeAudit(entry.after ?? {}),
      ...(entry.revertOf ? { revertOf: entry.revertOf } : {}),
      ...sanitizeAudit({ scriptSha256Before: entry.scriptSha256Before, scriptSha256After: entry.scriptSha256After }),
      ...(Number.isSafeInteger(entry.bytesBefore) && entry.bytesBefore >= 0 ? { bytesBefore: entry.bytesBefore } : {}),
      ...(Number.isSafeInteger(entry.bytesAfter) && entry.bytesAfter >= 0 ? { bytesAfter: entry.bytesAfter } : {}) };
    try { await prepare?.(intent); await append(filename, intent); }
    catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
    let value, failure, failed = false;
    try { value = await operation(intent); } catch (error) { failed = true; failure = error; }
    const result = failed ? 'failed' : value?.result === 'partial' ? 'partial' : 'ok';
    const row = { v: 1, id, phase: 'result', ts: kstTimestamp(now()), result,
      ...(failed ? { code: safeCode(failure) } : {}), detail: sanitizeAudit(value?.detail ?? {}) };
    try { await append(filename, row); } catch { throw resultUnavailable(); }
    logger?.info({ id, action: intent.action, code: failed ? row.code : result }, '관리 변경 기록을 남겼습니다.');
    if (failed) throw failure;
    return value;
  }
  async function read() {
    try {
      let names;
      try { names = await fs.readdir(dir); }
      catch (error) { if (error.code === 'ENOENT') return { rows: [], damaged: { count: 0, lines: [] } }; throw error; }
      const rows = [];
      const lines = [];
      for (const filename of names.filter(name => /^\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/.test(name)).sort()) {
        await files.run(filename, async () => {
          const source = await fs.readFile(join(dir, filename), 'utf8');
          for (const [index, line] of source.split('\n').entries()) {
            if (!line.trim()) continue;
            try {
              const row = JSON.parse(line);
              if (row?.v !== 1 || !/^[a-f0-9]{32}$/.test(row.id) || !['intent', 'result'].includes(row.phase) || typeof row.ts !== 'string') throw new Error();
              rows.push(row);
            } catch {
              const location = { file: filename, line: index + 1 };
              lines.push(location);
              logger?.warn(location, '변경 기록 한 줄을 읽지 못했습니다.');
            }
          }
        });
      }
      return { rows, damaged: { count: lines.length, lines } };
    } catch { throw unavailable(); }
  }
  return { run, read };
}
