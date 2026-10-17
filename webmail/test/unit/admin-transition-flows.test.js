import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSyncCsv, writeSyncCsv, retrySyncLines } from '../../web/src/admin/flows/sync-csv.js';
import { parseCsv } from '../../server/admin/services/batch.js';
import { renameRows, conversionRows, transitionResults } from '../../web/src/admin/flows/account-transitions.js';

test('sync paste handles headers, quotes and multiline fields and serializes to the server CSV contract', () => {
  const rows = readSyncCsv('\uFEFFsource,password,target,host\r\nold@example.com,"synth,""quoted""\nsecret",new@example.com,imap.example.com\r\nother@example.com,synthetic,new@example.com,');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].password, 'synth,"quoted"\nsecret');
  assert.equal(rows[1].target, rows[0].target);
  const records = parseCsv(writeSyncCsv(rows));
  assert.deepEqual(records.map(row => row.fields), [['source', 'password', 'target', 'host'], ...rows.map(row => [row.source, row.password, row.target, row.host])]);
  assert.deepEqual(records.map(row => row.line), [1, 2, 4]);
  assert.equal(readSyncCsv('원본 주소,원본 암호,대상 주소\nold@example.com,synthetic,new@example.com')[0].host, '');
});

test('sync paste rejects broken quoting and wrong column counts without repeating input secrets', () => {
  for (const csv of ['a,"synthetic-secret,b', 'a,synthetic-secret', 'a,synthetic-secret,b,c,d', 'a,"synthetic-secret"x,b']) {
    assert.throws(() => readSyncCsv(csv), error => !error.message.includes('synthetic-secret'));
  }
});

test('sync retry selects failed jobs and mailbox-created partial failures, preserving successful jobs', () => {
  assert.deepEqual(retrySyncLines(['ok', 'failed', 'partial', 'unknown', 'not_run'].map((result, line) => ({ result, line: line + 2 }))), [3, 4]);
});

test('rename preview covers all eight server change groups and retains address and permission lists', () => {
  const plan = { changes: { mailbox: [{ address: 'old@example.com', newAddress: 'new@example.com', messages: 3, appPasswordCount: 2 }], teamFilters: [{ mailbox: 'team@example.com', newMailbox: 'team@example.com', filterId: 7 }], aliases: [{ address: 'alias@example.com', before: ['old@example.com'], after: ['new@example.com'] }], senderAs: [{ mailbox: 'old@example.com', newMailbox: 'new@example.com', before: ['keep@example.com'], after: ['keep@example.com'] }], senderGrants: [{ mailbox: 'other@example.com', before: ['old@example.com', 'keep@example.com'], after: ['new@example.com', 'keep@example.com'] }], shares: [{ mailbox: 'INBOX', owner: 'old@example.com', grantee: 'other@example.com', newOwner: 'new@example.com', newGrantee: 'other@example.com' }], syncjobs: [{ id: 3, before: 'old@example.com', after: 'new@example.com' }], oldAlias: [{ address: 'old@example.com', targets: ['new@example.com'] }] } };
  const rows = renameRows(plan);
  assert.equal(rows.length, 8);
  assert.equal(rows[4][2], 'new@example.com, keep@example.com');
  assert.equal(rows[7][2], '받기 전용 별칭 → new@example.com');
});

test('conversion partial result distinguishes failed stage from all stages not executed', () => {
  const plan = { address: 'alias@example.com', direction: 'alias-to-mailbox', changes: { alias: { address: 'alias@example.com', goto: 'team@example.com' }, mailbox: { address: 'alias@example.com', kind: 'team', quotaGb: 50 }, copyTo: 'team@example.com', sendGrantTo: 'person@example.com', senderRestore: [{ mailbox: 'other@example.com', senderAcl: ['alias@example.com'] }] } };
  const result = { steps: [{ stage: 'alias', target: plan.address, status: 'ok' }, { stage: 'mailbox', status: 'failed', code: 'MAILCOW_REJECTED' }] };
  assert.deepEqual(transitionResults('toMailbox', plan, result).map(row => [row.stage, row.status]), [['alias', 'ok'], ['mailbox', 'failed'], ['copy', 'not_run'], ['senders', 'not_run'], ['grant', 'not_run']]);
  assert.equal(conversionRows(plan)[2][2], 'team@example.com에 :copy 복사');
});

test('sync passwords retain quoted and unquoted whitespace, quotes, commas and newlines', () => {
 const rows = readSyncCsv('source,password,target,host\n old@example.com ,"  synthetic,""key""\n line  "  , new@example.com , imap.example.com \nother@example.com,  synthetic  ,new@example.com,');
 assert.deepEqual(rows[0],{source:'old@example.com',password:'  synthetic,"key"\n line  ',target:'new@example.com',host:'imap.example.com'});
 assert.equal(rows[1].password,'  synthetic  ');
 assert.equal(readSyncCsv('old@example.com,"  synthetic\r\nsecret  ",new@example.com\r\n')[0].password,'  synthetic\r\nsecret  ');
 assert.deepEqual(readSyncCsv(writeSyncCsv(rows)),rows);
 assert.equal(readSyncCsv('old@example.com,"   ",new@example.com')[0].password,'   ');
});
