import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationOptions, collectRetirementCandidates, runRetirementMigration } from '../../bin/migrate-webmail-retirement.js';

const id = '1'.repeat(32), otherId = '2'.repeat(32), email = 'retired@example.test';
const intent = { id, phase: 'intent', action: 'mailbox.leave', target: email, after: { active: 2 }, ts: '2026-02-05T12:00:00+09:00' };
const result = { id, phase: 'result', result: 'ok', ts: '2026-02-05T12:01:00+09:00' };
function fixture() {
  const boxes = [{ username: email, active: 2, created: '2026-01-01 00:00:00', modified: '2026-02-05 12:00:00' }], records = [intent, result], states = new Map(), writes = [], calls = [];
  const deps = { now: () => Date.parse('2026-02-06T00:00:00Z'), session: {}, mailcow: { async call(session, method, path) { calls.push({ method, path }); return structuredClone(boxes); } },
    audit: { async read() { return { rows: structuredClone(records), damaged: { count: 0 } }; }, async run(entry, operation) { writes.push({ audit: entry }); return operation(); } },
    store: { async read(address) { return states.get(address) ?? { version: null }; }, async keysForOwner() { return []; }, async withRoutingLock(operation) { return operation(); },
      async write(data) { assert.equal(data.expected.version, null); assert.ok(!states.has(data.email)); writes.push({ db: data }); const saved = { ...data, version: otherId, pendingOperation: null }; states.set(data.email, saved); return saved; },
      async remove(data) { assert.equal(states.get(data.email).version, data.expected.version); writes.push({ remove: data }); states.delete(data.email); } } };
  return { deps, boxes, records, states, writes, calls };
}
async function files(operation) { const dir = await mkdtemp(join(tmpdir(), 'retirement-migration-')); try { return await operation(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
test('migration: defaults to dry-run; rejects contradictory modes, aliases of files and missing options', () => {
  assert.equal(migrationOptions(['--output', '/data/private/report.json']).mode, '--dry-run');
  for (const args of [[], ['--apply','--output','out'], ['--dry-run','--apply','--output','out'], ['--output','out','--unknown','value'], ['--apply','--output','same','--manifest','same','--approved','approved']]) assert.throws(() => migrationOptions(args), { statusCode: 422 });
});
test('migration: dry-run reads live API and audit, writes only a private report, always leaves blocking OFF', async () => files(async dir => {
  const f = fixture(), out = join(dir, 'candidates.json');
  const report = await runRetirementMigration(migrationOptions(['--output', out]), f.deps);
  assert.equal(report.candidates.length, 1); assert.equal(report.candidates[0].auditId, id);
  assert.match(report.generationPolicy, /24-hour/); assert.match(report.generationPolicy, /OFF/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.calls, [{ method: 'GET', path: '/api/v1/get/mailbox/all' }]);
  assert.equal((await stat(out)).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), report);
  await assert.rejects(runRetirementMigration(migrationOptions(['--output', out]), f.deps), { code: 'EEXIST' });
}));
test('migration: intent-only, partial, existing record, ambiguous or missing generation and later lifecycle are held', async () => {
  const cases = [
    [f => f.records.pop(), 'LEAVE_NOT_CONFIRMED'],
    [f => { f.records[1] = { ...result, result: 'partial' }; }, 'LEAVE_NOT_CONFIRMED'],
    [f => f.states.set(email, { version: otherId }), 'ALREADY_RECORDED'],
    [f => { delete f.boxes[0].created; }, 'GENERATION_UNVERIFIED'],
    [f => { f.boxes[0].created = 'invalid'; }, 'GENERATION_UNVERIFIED'],
    [f => { f.boxes[0].created = '2026-02-05 00:00:00'; }, 'GENERATION_UNVERIFIED'],
    [f => { f.boxes[0].created = '2026-02-08 00:00:00'; }, 'GENERATION_UNVERIFIED'],
    [f => f.records.push({ ...intent, id: otherId, action: 'mailbox.delete', ts: '2026-02-06T00:00:00Z' }), 'LATER_LIFECYCLE'],
  ];
  for (const [prepare, reason] of cases) { const f = fixture(); prepare(f); const report = await collectRetirementCandidates(f.deps); assert.equal(report.candidates.length, 0); assert.equal(report.held[0].reason, reason); assert.deepEqual(f.writes, []); }
});
test('migration: missing audit result association and duplicate evidence fail closed', async () => {
  const f = fixture(); f.records[1] = { ...result, id: otherId };
  assert.equal((await collectRetirementCandidates(f.deps)).held[0].reason, 'LEAVE_NOT_CONFIRMED');
  f.records.push(intent); await assert.rejects(collectRetirementCandidates(f.deps), { statusCode: 409 });
});
test('migration: 24-hour generation boundary and same-second leave ambiguity are conservative', async () => {
  for (const [created, count] of [['2026-02-04 03:00:00',0],['2026-02-04 02:59:59',1],['2026-02-06 03:00:01',0]]) {
    const f = fixture(); f.boxes[0].created = created;
    assert.equal((await collectRetirementCandidates(f.deps)).candidates.length,count);
  }
  const f = fixture(); f.records.push({ ...intent,id:otherId },{ ...result,id:otherId,result:'partial' });
  assert.equal((await collectRetirementCandidates(f.deps)).held[0].reason,'LEAVE_NOT_CONFIRMED');
});
test('migration: approved apply rereads live state, CAS inserts only approved OFF accounts, receipt permits exact-version rollback', async () => files(async dir => {
  const f = fixture(), manifest = join(dir, 'manifest.json'), approved = join(dir, 'approved.txt'), receipt = join(dir, 'receipt.json');
  await runRetirementMigration(migrationOptions(['--output', manifest]), f.deps);
  await writeFile(approved, email + '\n');
  const applied = await runRetirementMigration(migrationOptions(['--apply','--manifest',manifest,'--approved',approved,'--output',receipt]), f.deps);
  assert.equal(f.calls.length, 2); assert.equal(applied.result, 'ok'); assert.equal(applied.applied.length, 1);
  const row = f.writes.find(value => value.db).db; assert.equal(row.retired, true); assert.equal(row.receiveBlocked, false); assert.deepEqual(row.keys, []); assert.equal(row.source, 'legacy_import');
  await runRetirementMigration(migrationOptions(['--rollback','--manifest',receipt,'--approved',approved,'--output',join(dir,'rollback.json')]), f.deps);
  assert.equal(f.states.size, 0); assert.equal(f.writes.filter(value => value.remove).length, 1);
}));
test('migration: stale manifest or unknown/duplicate approval cannot partially insert', async () => files(async dir => {
  for (const [name, prepare, approval] of [
    ['stale', f => { f.boxes[0].modified = '2026-02-06 14:00:00'; }, email],
    ['unknown', () => {}, email + '\nunknown@example.test'],
    ['duplicate', () => {}, email + '\n' + email],
  ]) {
    const f = fixture(), manifest = join(dir, name + '.json'), approved = join(dir, name + '.txt');
    await runRetirementMigration(migrationOptions(['--output',manifest]), f.deps); prepare(f); await writeFile(approved, approval);
    await assert.rejects(runRetirementMigration(migrationOptions(['--apply','--manifest',manifest,'--approved',approved,'--output',join(dir,name+'.out')]), f.deps));
    assert.deepEqual(f.writes, []);
  }
}));
test('migration: rollback refuses modified imported state without removing any row', async () => files(async dir => {
  const f = fixture(), manifest = join(dir, 'm.json'), approved = join(dir, 'a.txt'), receipt = join(dir, 'r.json');
  await runRetirementMigration(migrationOptions(['--output',manifest]), f.deps); await writeFile(approved,email);
  await runRetirementMigration(migrationOptions(['--apply','--manifest',manifest,'--approved',approved,'--output',receipt]), f.deps);
  f.states.set(email, { ...f.states.get(email), version: '3'.repeat(32) });
  await assert.rejects(runRetirementMigration(migrationOptions(['--rollback','--manifest',receipt,'--approved',approved,'--output',join(dir,'rb.json')]), f.deps), { statusCode: 409 });
  assert.equal(f.writes.filter(value => value.remove).length,0); assert.equal(f.states.size,1);
}));
test('migration: an indeterminate commit is reported as partial with an unverified attempt, never zero-change success', async () => files(async dir => {
  const f = fixture(), manifest=join(dir,'m.json'),approved=join(dir,'a.txt'),output=join(dir,'r.json');
  await runRetirementMigration(migrationOptions(['--output',manifest]),f.deps);await writeFile(approved,email);
  f.deps.store.write=async data=>{f.states.set(data.email,{...data,version:otherId});throw Error('synthetic lost commit acknowledgement');};
  await assert.rejects(runRetirementMigration(migrationOptions(['--apply','--manifest',manifest,'--approved',approved,'--output',output]),f.deps));
  const receipt=JSON.parse(await readFile(output,'utf8'));assert.equal(receipt.result,'partial');assert.equal(receipt.applied.length,0);assert.equal(receipt.attempted[0].status,'unverified');
  assert.equal(f.states.size,1);
}));
