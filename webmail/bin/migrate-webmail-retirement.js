#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '../server/errors.js';
import { createAudit } from '../server/admin/audit.js';
import { loadAdminConfig } from '../server/admin/config.js';
import { createMailcowClient } from '../server/admin/mailcow-client.js';
import { createRetirementStore, retirementAddress } from '../server/security/retirement-store.js';

const policy = 'Creation timestamps without a timezone use a conservative 24-hour margin; missing, ambiguous or newer generations are held. Imported accounts always keep receive blocking OFF.';
const invalid = () => new AppError(422, 'MIGRATION_INPUT', '이관 옵션과 승인 파일을 확인해 주세요.');
const changed = () => new AppError(409, 'MIGRATION_CHANGED', '이관 후보가 바뀌었어요. 새 보고서를 확인해 주세요.');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actor = 'retirement-migration';

export function migrationOptions(args) {
  const modes = args.filter(arg => ['--dry-run', '--apply', '--rollback'].includes(arg));
  if (modes.length > 1) throw invalid();
  const mode = modes[0] ?? '--dry-run', options = { mode };
  const rest = args.filter(arg => arg !== mode);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!['--output', '--manifest', '--approved'].includes(key) || options[key] || !value || value.startsWith('-')) throw invalid();
    options[key] = value;
  }
  if (!options['--output'] || mode === '--dry-run' && (options['--manifest'] || options['--approved']) ||
    mode !== '--dry-run' && (!options['--manifest'] || !options['--approved'])) throw invalid();
  if (new Set(['--output', '--manifest', '--approved'].filter(key => options[key]).map(key => resolve(options[key]))).size !== Object.keys(options).length - 1) throw invalid();
  return options;
}

function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  // The UTC-like anchor is used only with the explicit +/-24h uncertainty band.
  const local = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value);
  if (!local && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const text = local ? value.replace(' ', 'T') + 'Z' : value;
  return Date.parse(text);
}
function snapshot(row) {
  if (!row || ![0, 1, 2, '0', '1', '2'].includes(row.active)) throw changed();
  return { email: retirementAddress(row.username), active: Number(row.active), created: row.created ?? null, modified: row.modified ?? null };
}

export async function collectRetirementCandidates({ mailcow, session, audit, store, now = Date.now }) {
  const [mailboxes, evidence] = await Promise.all([mailcow.call(session, 'GET', '/api/v1/get/mailbox/all'), audit.read()]);
  if (!Array.isArray(mailboxes) || evidence.damaged?.count) throw changed();
  const intents = new Map(), results = new Map(), seen = new Set();
  for (const row of evidence.rows) {
    if (!/^[a-f0-9]{32}$/.test(row.id ?? '') || !['intent', 'result'].includes(row.phase) || !Number.isFinite(timestamp(row.ts))) throw changed();
    const key = row.id + ':' + row.phase;
    if (seen.has(key)) throw changed();
    seen.add(key); (row.phase === 'intent' ? intents : results).set(row.id, row);
  }
  const candidates = [], held = [], addresses = new Set();
  for (const row of mailboxes) {
    const current = snapshot(row), email = current.email;
    if (addresses.has(email) || ![0, 1, 2].includes(current.active)) throw changed();
    addresses.add(email);
    if (current.active !== 2) continue;
    const account = await store.read(email);
    if (account.version !== null) { held.push({ email, reason: 'ALREADY_RECORDED' }); continue; }
    const leaves = [...intents.values()].filter(entry => entry.action === 'mailbox.leave' && entry.target?.toLowerCase() === email)
      .sort((a, b) => timestamp(b.ts) - timestamp(a.ts));
    const leave = leaves[0], result = leave && results.get(leave.id);
    if (!leave || result?.result !== 'ok' || leave.after?.active !== 2 || timestamp(result.ts) < timestamp(leave.ts) ||
      leaves.length > 1 && timestamp(leaves[1].ts) === timestamp(leave.ts)) { held.push({ email, reason: 'LEAVE_NOT_CONFIRMED' }); continue; }
    const created = timestamp(current.created), left = timestamp(leave.ts);
    if (!Number.isFinite(created) || created >= left - 24 * 60 * 60 * 1000) { held.push({ email, reason: 'GENERATION_UNVERIFIED' }); continue; }
    const later = [...intents.values()].some(entry => timestamp(entry.ts) > left &&
      /^(?:mailbox\.(?:create|delete|rename|convert)|convert\.)/.test(entry.action ?? '') &&
      (entry.target?.toLowerCase() === email || JSON.stringify([entry.before, entry.after]).toLowerCase().includes(email)));
    if (later) { held.push({ email, reason: 'LATER_LIFECYCLE' }); continue; }
    candidates.push({ email, auditId: leave.id, recordedAt: new Date(left).toISOString(), stateHash: hash(current), version: null });
  }
  return { v: 1, kind: 'retirement-candidates', generatedAt: new Date(now()).toISOString(), generationPolicy: policy,
    candidates: candidates.sort((a, b) => a.email.localeCompare(b.email)), held: held.sort((a, b) => a.email.localeCompare(b.email)) };
}

async function jsonFile(path) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))); }
async function approvedFile(path) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
  const values = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(retirementAddress);
  if (!values.length || new Set(values).size !== values.length) throw invalid();
  return values.sort();
}
export async function runRetirementMigration(options, deps) {
  let manifest, approved;
  if (options.mode !== '--dry-run') {
    [manifest, approved] = await Promise.all([jsonFile(options['--manifest']), approvedFile(options['--approved'])]);
    if (manifest.v !== 1 || manifest.generationPolicy !== policy ||
      manifest.kind !== (options.mode === '--apply' ? 'retirement-candidates' : 'retirement-import-receipt')) throw invalid();
  }
  // wx avoids overwriting reviewed evidence or following a pre-existing symlink.
  const output = await open(options['--output'], 'wx', 0o600);
  let report = { v: 1, kind: 'retirement-import-receipt', generationPolicy: policy, generatedAt: new Date().toISOString(), result: 'failed', applied: [], attempted: [] };
  try {
    if (options.mode === '--dry-run') {
      report = await collectRetirementCandidates(deps);
    } else if (options.mode === '--apply') {
      await deps.store.withRoutingLock(async () => {
        const fresh = await collectRetirementCandidates(deps);
        if (!Array.isArray(manifest.candidates) || new Set(manifest.candidates.map(item => item.email)).size !== manifest.candidates.length) throw invalid();
        const selected = approved.map(email => {
          const reviewed = manifest.candidates.find(item => item.email === email), current = fresh.candidates.find(item => item.email === email);
          if (!reviewed || !current || hash(reviewed) !== hash(current)) throw changed();
          return current;
        });
        // Validate every approved candidate before the first insert.
        for (const item of selected) {
          await deps.audit.run({ actor, ip: null, action: 'mailbox.retirement.import', target: item.email, kind: 'config', revertible: false,
            before: {}, after: { retired: true, receiveBlocked: false, sourceAuditId: item.auditId } }, async () => {
            const attempt = { email: item.email, auditId: item.auditId, status: 'unverified' };
            report.attempted.push(attempt);
            const saved = await deps.store.write({ email: item.email, retired: true, receiveBlocked: false, recordedAt: item.recordedAt,
              source: 'legacy_import', sourceAuditId: item.auditId, updatedBy: actor, expected: { version: null }, keys: [] });
            report.applied.push({ ...item, version: saved.version });
            const actual = await deps.store.read(item.email);
            if (actual.version !== saved.version || !actual.retired || actual.receiveBlocked || (await deps.store.keysForOwner(item.email)).length) throw changed();
            attempt.status = 'confirmed';
            return { result: 'ok' };
          });
        }
      });
      report.result = 'ok';
    } else {
      report.kind = 'retirement-rollback-receipt';
      await deps.store.withRoutingLock(async () => {
        if (!Array.isArray(manifest.applied) || new Set(manifest.applied.map(item => item.email)).size !== manifest.applied.length) throw invalid();
        const boxes = await deps.mailcow.call(deps.session, 'GET', '/api/v1/get/mailbox/all');
        if (!Array.isArray(boxes)) throw changed();
        const selected = [];
        for (const email of approved) {
          const item = manifest.applied.find(row => row.email === email), current = boxes.find(row => row.username?.toLowerCase() === email), state = await deps.store.read(email);
          if (!item || !current || hash(snapshot(current)) !== item.stateHash || state.version !== item.version || state.source !== 'legacy_import' || state.sourceAuditId !== item.auditId ||
            !state.retired || state.receiveBlocked || state.pendingOperation !== null || (await deps.store.keysForOwner(email)).length) throw changed();
          selected.push(item);
        }
        for (const item of selected) {
          await deps.audit.run({ actor, ip: null, action: 'mailbox.retirement.import-rollback', target: item.email, kind: 'config', revertible: false,
            before: { retired: true }, after: {} }, async () => {
            const attempt = { email: item.email, version: item.version, status: 'unverified' };
            report.attempted.push(attempt);
            await deps.store.remove({ email: item.email, expected: { version: item.version } });
            report.applied.push({ email: item.email, version: item.version });
            attempt.status = 'confirmed';
            return { result: 'ok' };
          });
        }
      });
      report.result = 'ok';
    }
    return report;
  } catch (error) { report.result = report.attempted?.length ? 'partial' : 'failed'; throw error; }
  finally { try { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); } finally { await output.close(); } }
}

async function main() {
  if (process.argv.slice(2).some(value => ['--help', '-h'].includes(value))) {
    console.log('Usage: node bin/migrate-webmail-retirement.js [--dry-run|--apply|--rollback] --output /data/private/report.json [--manifest /data/private/candidates.json --approved /data/private/approved.txt]');
    return;
  }
  const options = migrationOptions(process.argv.slice(2)), config = loadAdminConfig();
  if (!config.mailcowApiKey) throw new AppError(503, 'MAILCOW_API_KEY_REQUIRED', '기존 mailcow API 키가 없어 최신 상태를 확인할 수 없어요.');
  const mailcow = createMailcowClient({ config }), session = mailcow.createApiContext({ permission: 'read' });
  const store = createRetirementStore({ config }), audit = createAudit({ dir: config.auditDir });
  try {
    const result = await runRetirementMigration(options, { mailcow, session, store, audit });
    console.log(JSON.stringify({ result: result.result ?? 'dry-run', candidates: result.candidates?.length ?? 0, held: result.held?.length ?? 0, applied: result.applied?.length ?? 0, generationPolicy: policy }));
  } finally { await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify({ error: { code: error instanceof AppError ? error.code : 'MIGRATION_FAILED', message: error instanceof AppError ? error.message : '이관 파일과 연결 설정을 확인해 주세요.' } }));
    process.exitCode = 2;
  });
}
